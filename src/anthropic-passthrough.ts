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

const filterHeaders = (headers: Record<string, string | string[] | undefined>): Record<string, string | string[]> => {
  const filtered: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(key.toLowerCase())) continue;
    filtered[key] = value;
  }
  return filtered;
};

export interface PassthroughOptions {
  readonly baseUrl: string;
  readonly connectTimeoutMs: number;
  readonly streamIdleTimeoutMs: number;
  readonly logger: Logger;
}

export type AnthropicForwarder = (req: IncomingMessage, res: ServerResponse, body?: Buffer) => void;

export const createAnthropicForwarder = (options: PassthroughOptions): AnthropicForwarder => {
  const target = new URL(options.baseUrl);
  const client = target.protocol === "https:" ? https : http;
  const basePath = target.pathname === "/" ? "" : target.pathname.replace(/\/$/, "");

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
        headers: filterHeaders(req.headers),
      },
      (upstreamRes) => {
        responded = true;
        upstream.setTimeout(options.streamIdleTimeoutMs);
        res.writeHead(upstreamRes.statusCode ?? 502, filterHeaders(upstreamRes.headers));
        res.socket?.setNoDelay(true);
        upstreamRes.pipe(res);
        upstreamRes.on("error", () => res.destroy());
      },
    );

    upstream.setTimeout(options.connectTimeoutMs);
    upstream.on("socket", (socket) => socket.setNoDelay(true));

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
