import http from "node:http";
import https from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { toAnthropicErrorBody, SYNTHESIZED_HEADER, SYNTHESIZED_MARKER } from "./errors.js";
import { drainRejectedUpload } from "./provider-transport.js";
import type { Logger } from "./logger.js";

/**
 * Hop-by-hop headers per RFC 7230 §6.1 — stripped in BOTH the request and response
 * directions. These are connection-specific and must not be forwarded end-to-end.
 *
 * `host` is included: Node sets it on the outbound connection so the client-supplied
 * value must not be forwarded. `proxy-connection` is a de-facto same-class extension.
 * `connection` is managed by the keep-alive agent.
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
 * Additional headers stripped from the response direction (upstream → client) only.
 *
 * The synthesized marker is removed from proxied responses so it stays
 * authoritative: only the relay itself can assert it.  The name is imported from
 * errors.ts rather than restated, so a rename cannot reach the emitters while
 * leaving this stripper matching the old name (ADR-008 chokepoint).  It is NOT
 * stripped from the request direction because:
 *   - The relay never reads the request-side value anywhere.
 *   - The header is not hop-by-hop.
 *   - With subswitch turned off, the header would reach the origin untouched.
 * Stripping it from client requests is relay-invented behaviour — the kind
 * ADR-010 prohibits.
 */
const RESPONSE_STRIP = new Set([...HOP_BY_HOP, SYNTHESIZED_HEADER]);

/**
 * Build a filtered flat [name, value, ...] array from a rawHeaders array,
 * skipping headers listed in `strip` case-insensitively while preserving the
 * original casing, order, and duplicates of every non-stripped header.
 *
 * The `strip` parameter is REQUIRED so every call site must declare its direction:
 * - Response direction (upstream → client): pass RESPONSE_STRIP
 * - Request direction (client → upstream): pass HOP_BY_HOP
 *
 * Node's http.ServerResponse.writeHead() accepts the flat-array form directly
 * (via _storeHeader's Array branch).  For the request direction we use setHeader
 * calls instead (http.request options.headers uses Object.keys, not flat pairs).
 */
const filterRawHeaders = (rawHeaders: readonly string[], strip: ReadonlySet<string>): string[] => {
  const filtered: string[] = [];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const name = rawHeaders[i]!;
    const value = rawHeaders[i + 1]!;
    if (!strip.has(name.toLowerCase())) {
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
   * the timer is disarmed entirely — the relay must never bound the headers or stream
   * phases on a connected client (ADR-010).
   *
   * On HTTPS connections, `'connect'` fires after TCP establishment but before the
   * TLS handshake, so TLS negotiation is NOT covered by this budget — neither the
   * headers phase nor the stream phase is bounded, consistent with ADR-010.
   *
   * For pooled/keep-alive sockets (no connect phase), this budget has no effect.
   */
  readonly connectTimeoutMs: number;
  readonly logger: Logger;
  /** Maximum sockets in the keep-alive pool. Config key: anthropic.maxUpstreamSockets. */
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
  const agentOpts: http.AgentOptions = { keepAlive: true, maxSockets: options.maxUpstreamSockets, scheduling: "lifo" };
  const agent = options.agent ?? (target.protocol === "https:" ? new https.Agent(agentOpts) : new http.Agent(agentOpts));

  return (req, res, body) => {
    const path = `${basePath}${req.url ?? "/"}`;
    // One-way latch: the first terminal outcome (response headers, timeout, error,
    // or client disconnect) claims the settlement. Subsequent events return early
    // so that a destroy() issued by the timeout handler cannot produce a duplicate
    // anthropic_upstream_error warn, and a client abort cannot attempt to write
    // into a response that has already been written or destroyed.
    let settled = false;
    const settle = (): boolean => {
      if (settled) return false;
      settled = true;
      return true;
    };

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
        if (!settle()) return;
        // Response direction: writeHead accepts a flat [name, value, ...] array
        // directly (Node's _storeHeader Array branch), preserving the upstream's
        // original header casing, order, and duplicates byte-for-byte.
        // filterRawHeaders strips x-subswitch-synthesized so an origin that sets
        // it cannot impersonate the relay's synthesized-response marker.
        res.writeHead(upstreamRes.statusCode ?? 502, filterRawHeaders(upstreamRes.rawHeaders, RESPONSE_STRIP));
        res.socket?.setNoDelay(true);
        upstreamRes.pipe(res);
        upstreamRes.on("error", () => res.destroy());
      },
    );

    // Timer arming — single-budget design (ADR-010):
    //
    // connectTimeoutMs — bounds TCP establishment ONLY, armed DIRECTLY on the
    // socket (not via upstream.setTimeout).  ClientRequest.setTimeout() defers
    // internally via its own 'connect' listener, so it would fire only after
    // connect and cannot bound the connect phase.
    //
    // Node v22's internal socket-timeout handler (onTimeout) skips
    // req.emit('timeout') when socket.connecting is true, so we propagate the
    // timeout manually via upstream.emit('timeout').
    //
    // On connect the timer is DISARMED entirely: the relay must never bound the
    // headers-phase or stream-phase on a connected client (ADR-010).
    //
    // For pooled/keep-alive sockets (no connect phase) this budget has no effect.
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
          socket.setTimeout(0); // disarm — no further timers (ADR-010)
        };
        socket.once("timeout", onConnectTimeout);
        socket.once("connect", onConnect);
      }
      // Pooled/keep-alive socket: connect phase already done, no timer to arm.
    });

    // Request direction: build a Map from the filtered rawHeaders so that
    // duplicates (same lowercase key, different values) are preserved as array
    // values, and setHeader sends them with original name casing.  Caveat:
    // interleaved duplicates of the same name (A,B,A) are regrouped adjacent
    // (A,A,B); per-name value order is preserved (RFC 7230 §3.2.2) and adjacent
    // duplicates are byte-exact.  Anthropic clients do not interleave duplicate
    // header names, so this is safe in practice.
    const filteredRaw = filterRawHeaders(req.rawHeaders, HOP_BY_HOP);
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

    // Terminal outcome 2 (connect timeout): only the connect-phase timeout can fire;
    // no other timer is ever armed.  settle() ensures the error handler does
    // not produce a duplicate warn after destroy() is called.
    //
    // On the unbuffered path the client is often still uploading when this fires, and
    // its bytes are piped into the upstream that is about to be destroyed.  The upload
    // is unpiped and handed to drainRejectedUpload, which reads it out under the same
    // time and byte bounds the 413 path uses.  Without that, the 504 is written but the
    // connection is dead weight: Node cannot parse the next request out of a body it
    // never consumed, so the socket is held until server.requestTimeout (600 s) with
    // the client still pushing into it (measured).  The buffered path needs none of
    // this — the request was fully consumed before the upstream was opened.
    upstream.on("timeout", () => {
      if (!settle()) return;
      options.logger.log("warn", "anthropic_upstream_timeout", { path: req.url ?? "/" });
      if (!res.headersSent) {
        res.writeHead(504, { "content-type": "application/json", [SYNTHESIZED_HEADER]: SYNTHESIZED_MARKER });
        res.end(toAnthropicErrorBody("api_error", "upstream timed out"));
      } else {
        res.destroy();
      }
      if (body === undefined) {
        req.unpipe(upstream);
        drainRejectedUpload(req);
      }
      upstream.destroy();
    });

    // Terminal outcome 3 (upstream error): settle() prevents a double-warn if
    // destroy() from the timeout handler produces an ECONNRESET on the next tick.
    upstream.on("error", () => {
      if (!settle()) return;
      options.logger.log("warn", "anthropic_upstream_error", { path: req.url ?? "/" });
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json", [SYNTHESIZED_HEADER]: SYNTHESIZED_MARKER });
        res.end(toAnthropicErrorBody("api_error", "upstream connection failed"));
      } else {
        res.destroy();
      }
    });

    // Terminal outcome 4 (client disconnect).
    //
    // The upstream MUST be destroyed on every abort, settled or not — settle()
    // arbitrates only who owns the client-visible outcome and the warn log, never
    // whether the upstream connection is reclaimed.  Gating the destroy on the
    // latch leaks a socket per mid-stream abort: once headers are relayed the
    // response callback has already claimed the settlement, and `pipe()` does not
    // propagate destination teardown to the source, so the upstream response stays
    // half-read and its socket never returns to the agent's free pool.  At
    // maxUpstreamSockets such sockets exhaust the pool and every later request
    // queues inside http.Agent indefinitely — a hang no origin can produce, and
    // exactly the leak ADR-010 warns the removed idle timer no longer covers.
    //
    // settle() is still claimed first when it is open, so the ECONNRESET that
    // destroy() raises on the next tick cannot emit a spurious
    // anthropic_upstream_error warn or write a 502 into a closed response.
    // A client abort is normal — no warn log, no synthetic HTTP response.
    res.on("close", () => {
      if (res.writableFinished) return;
      settle();
      upstream.destroy();
    });

    if (body !== undefined) {
      upstream.end(body);
    } else {
      req.pipe(upstream);
      // A failed client stream takes the upstream down with it, and claims the
      // settlement on the way out for the same reason the res "close" handler does:
      // the ECONNRESET that destroy() raises a tick later must not be reported as an
      // origin failure or answered with a 502 the origin never sent.  The return is
      // discarded — a client fault owns the outcome whether or not the latch was open.
      req.on("error", () => {
        void settle();
        upstream.destroy();
      });
    }
  };
};
