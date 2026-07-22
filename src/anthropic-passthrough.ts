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
  readonly connectTimeoutMs: number;
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
  const agent =
    options.agent ??
    (target.protocol === "https:"
      ? new https.Agent({
          keepAlive: true,
          maxSockets: options.maxUpstreamSockets,
          scheduling: "lifo",
        })
      : new http.Agent({
          keepAlive: true,
          maxSockets: options.maxUpstreamSockets,
          scheduling: "lifo",
        }));

  return (req, res, body) => {
    const path = `${basePath}${req.url ?? "/"}`;
    let responded = false;

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
        // setHeader calls below to preserve original casing, order, and duplicates.
      },
      (upstreamRes) => {
        responded = true;
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

    upstream.setTimeout(options.connectTimeoutMs);
    upstream.on("socket", (socket) => socket.setNoDelay(true));

    // Request direction: build a Map from the filtered rawHeaders so that
    // duplicates (same lowercase key, different values) are preserved as array
    // values, and setHeader sends them with original name casing.
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
      upstream.destroy();
      options.logger.log("warn", "anthropic_upstream_timeout", { path: req.url ?? "/" });
      if (!res.headersSent) {
        res.writeHead(504, { "content-type": "application/json" });
        res.end(toAnthropicErrorBody("api_error", "upstream timed out"));
      } else {
        res.destroy();
      }
    });

    upstream.on("error", () => {
      if (responded) return;
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
