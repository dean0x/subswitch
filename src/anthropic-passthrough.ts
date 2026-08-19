import http from "node:http";
import https from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { toAnthropicErrorBody } from "./errors.js";
import type { Logger } from "./logger.js";

/**
 * Hop-by-hop headers are the only ones we own; everything else — notably
 * `authorization` and every `anthropic-*` header — is forwarded verbatim.
 * A raw node client (not fetch) is required: fetch normalizes and injects
 * headers, which breaks subscription OAuth upstream.
 *
 * Per RFC 7230 §6.1. `host` is also excluded: Node sets it on the outbound
 * connection. `connection` is managed by the keep-alive agent.
 */
const HOP_BY_HOP = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * Build a filtered flat [name, value, ...] array from a rawHeaders array,
 * skipping hop-by-hop headers case-insensitively while preserving the
 * original casing, order, and duplicates of every non-hop-by-hop header.
 *
 * Used for both directions:
 * - Request: source is req.rawHeaders (client → upstream)
 * - Response: source is upstreamRes.rawHeaders (upstream → client)
 *
 * Node's http.ServerResponse.writeHead() accepts the flat-array form directly
 * (via _storeHeader's Array branch).  For the request direction we use setHeader
 * calls instead (http.request options.headers uses Object.keys, not flat pairs).
 */
const filterRawHeaders = (rawHeaders: readonly string[]): string[] => {
  const filtered: string[] = [];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const name = rawHeaders[i]!;
    const value = rawHeaders[i + 1]!;
    if (!HOP_BY_HOP.has(name.toLowerCase())) {
      filtered.push(name, value);
    }
  }
  return filtered;
};

export interface PassthroughOptions {
  readonly baseUrl: string;
  /**
   * Bounds TCP connection establishment only (milliseconds).
   * The timer is armed directly on the socket (not via `ClientRequest.setTimeout`,
   * which defers internally and cannot bound the connect phase).  Once TCP connects,
   * the timer is re-armed to `headerTimeoutMs`.
   *
   * On HTTPS connections, `'connect'` fires after TCP establishment but before the
   * TLS handshake, so TLS negotiation falls under `headerTimeoutMs`, not this budget.
   *
   * For pooled/keep-alive sockets (no connect phase), `headerTimeoutMs` is armed
   * immediately and this budget has no effect.
   */
  readonly connectTimeoutMs: number;
  /**
   * Bounds the connect→response-headers phase (time to first byte), in milliseconds.
   * Armed on socket connect (or immediately for pooled sockets).
   * Re-armed to `streamIdleTimeoutMs` once headers arrive.
   */
  readonly headerTimeoutMs: number;
  /**
   * Bounds the headers→stream-end phase, in milliseconds.
   * Reset by every received chunk.
   */
  readonly streamIdleTimeoutMs: number;
  readonly logger: Logger;
  /** Maximum sockets in the keep-alive pool. Config key: limits.maxUpstreamSockets. */
  readonly maxUpstreamSockets: number;
  /**
   * Test seam — provide a pre-built Agent to override the auto-created one.
   * Production code omits this; the forwarder creates a keep-alive agent
   * matching the base URL protocol.
   */
  readonly agent?: http.Agent;
}

export type AnthropicForwarder = (req: IncomingMessage, res: ServerResponse, body?: Buffer) => void;

export const createAnthropicForwarder = (options: PassthroughOptions): AnthropicForwarder => {
  const target = new URL(options.baseUrl);
  const client = target.protocol === "https:" ? https : http;
  const basePath = target.pathname === "/" ? "" : target.pathname.replace(/\/$/, "");

  // Create a keep-alive agent for persistent connections to the upstream.
  // This matches Claude Code's own direct connection behaviour (parity).
  //
  // Residual risk: a stale pooled socket can ECONNRESET a POST; the existing
  // upstream.on("error") handler returns a clean 502 and Claude Code retries.
  // This is the same behaviour as any keep-alive HTTP client.
  const agentOpts: http.AgentOptions = { keepAlive: true, maxSockets: options.maxUpstreamSockets, scheduling: "lifo" };
  const agent = options.agent ?? (target.protocol === "https:" ? new https.Agent(agentOpts) : new http.Agent(agentOpts));

  return (req, res, body) => {
    const path = `${basePath}${req.url ?? "/"}`;
    // `settled` is set by whichever handler wins the race — the response
    // callback (headers received) or the timeout handler (504 written).
    // The error handler uses it as its early-return guard so that a
    // destroy() issued by the timeout handler does not produce a duplicate
    // `anthropic_upstream_error` warn after the 504 has already been sent.
    let settled = false;

    const upstream = client.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        ...(target.port !== "" ? { port: Number(target.port) } : {}),
        method: req.method ?? "GET",
        path,
        agent,
        // No headers here — http.request uses Object.keys on the headers option,
        // which would produce numeric indices for an array.  We apply headers via
        // setHeader calls below to preserve original casing and per-name value order
        // (cross-name position of interleaved duplicates is not guaranteed).
      },
      (upstreamRes) => {
        settled = true;
        upstream.setTimeout(options.streamIdleTimeoutMs);
        // Response direction: writeHead accepts a flat [name, value, ...] array
        // directly (Node's _storeHeader Array branch), preserving the upstream's
        // original header casing, order, and duplicates byte-for-byte.
        res.writeHead(upstreamRes.statusCode ?? 502, filterRawHeaders(upstreamRes.rawHeaders));
        res.socket?.setNoDelay(true);
        upstreamRes.pipe(res);
        upstreamRes.on("error", () => res.destroy());
      },
    );

    // Timer arming — three-budget design:
    //
    // 1. connectTimeoutMs — bounds TCP establishment, armed DIRECTLY on the
    //    socket (not via upstream.setTimeout).  ClientRequest.setTimeout()
    //    defers internally via its own 'connect' listener, so it would fire
    //    only after connect — in the same tick as the headerTimeoutMs rearm,
    //    leaving connectTimeoutMs never actually in force.
    //
    //    Node v22's internal socket-timeout handler (onTimeout) skips
    //    req.emit('timeout') when socket.connecting is true, so we must
    //    propagate the timeout manually via upstream.emit('timeout').
    //    On HTTPS, 'connect' fires after TCP but BEFORE the TLS handshake, so
    //    TLS negotiation falls under headerTimeoutMs, not connectTimeoutMs.
    //
    // 2. headerTimeoutMs — armed on 'connect' (or immediately for a pooled
    //    socket where no 'connect' event will ever fire).  Bounds the window
    //    from TCP-connected to first response byte.  upstream.setTimeout() in
    //    the connected state propagates normally via Node's internal handler.
    //
    // 3. streamIdleTimeoutMs — armed in the response callback once headers
    //    arrive; reset by every received chunk.
    upstream.on("socket", (socket) => {
      socket.setNoDelay(true);
      if (socket.connecting) {
        socket.setTimeout(options.connectTimeoutMs);
        const onConnectTimeout = () => {
          socket.removeListener("connect", onConnect);
          socket.setTimeout(0); // disarm before manual propagation
          upstream.emit("timeout"); // triggers our handler → 504
        };
        const onConnect = () => {
          socket.removeListener("timeout", onConnectTimeout);
          socket.setTimeout(0); // cancel connect budget
          upstream.setTimeout(options.headerTimeoutMs);
        };
        socket.once("timeout", onConnectTimeout);
        socket.once("connect", onConnect);
      } else {
        // Pooled/keep-alive socket — no connect phase; arm header budget immediately.
        upstream.setTimeout(options.headerTimeoutMs);
      }
    });

    // Request direction: build a Map from the filtered rawHeaders so that
    // duplicates (same lowercase key, different values) are preserved as array
    // values, and setHeader sends them with original name casing.  Caveat:
    // interleaved duplicates of the same name (A,B,A) are regrouped adjacent
    // (A,A,B); per-name value order is preserved (RFC 7230 §3.2.2) and adjacent
    // duplicates are byte-exact.  Anthropic clients do not interleave duplicate
    // header names, so this is safe in practice.
    const filteredRaw = filterRawHeaders(req.rawHeaders);
    const headerMap = new Map<string, { name: string; values: string[] }>();
    for (let i = 0; i + 1 < filteredRaw.length; i += 2) {
      const name = filteredRaw[i]!;
      const value = filteredRaw[i + 1]!;
      const key = name.toLowerCase();
      const entry = headerMap.get(key);
      if (entry === undefined) {
        headerMap.set(key, { name, values: [value] });
      } else {
        entry.values.push(value);
      }
    }
    for (const { name, values } of headerMap.values()) {
      upstream.setHeader(name, values.length === 1 ? values[0]! : values);
    }

    upstream.on("timeout", () => {
      // Log and write the 504 BEFORE destroy() to narrow the race window with
      // the 'error' handler.  destroy() on an in-flight ClientRequest emits
      // 'error' (ECONNRESET) on the next tick; setting `settled = true` here
      // prevents that error from producing a duplicate warn log.
      options.logger.log("warn", "anthropic_upstream_timeout", { path: req.url ?? "/" });
      if (!res.headersSent) {
        settled = true;
        res.writeHead(504, { "content-type": "application/json" });
        res.end(toAnthropicErrorBody("api_error", "upstream timed out"));
      } else {
        res.destroy();
      }
      upstream.destroy();
    });

    upstream.on("error", () => {
      if (settled) return;
      options.logger.log("warn", "anthropic_upstream_error", { path: req.url ?? "/" });
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(toAnthropicErrorBody("api_error", "upstream connection failed"));
      } else {
        res.destroy();
      }
    });

    res.on("close", () => {
      if (!res.writableFinished) upstream.destroy();
    });

    if (body !== undefined) {
      upstream.end(body);
    } else {
      req.pipe(upstream);
      req.on("error", () => upstream.destroy());
    }
  };
};
