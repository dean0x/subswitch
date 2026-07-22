import http from "node:http";
import type { IncomingMessage, Server } from "node:http";
import { toAnthropicErrorBody } from "./errors.js";
import { type Result, ok, err } from "./result.js";
import type { ProxyError } from "./errors.js";
import type { Config } from "./config.js";
import { createConsoleLogger, type Logger } from "./logger.js";
import { decideRoute } from "./router.js";
import { createAnthropicForwarder, type AnthropicForwarder } from "./anthropic-passthrough.js";
import { CodexAuthManager, createFsAuthFileStore } from "./codex-auth.js";
import { ReasoningCache } from "./reasoning-cache.js";
import { createCodexHandler, type CodexHandler } from "./codex-handler.js";
import { ModelPeekSchema } from "./wire-types.js";
import { SUBROUTE_NAME, SUBROUTE_VERSION } from "./version.js";

export interface ServerDeps {
  readonly config: Config;
  readonly logger: Logger;
  readonly forwardAnthropic: AnthropicForwarder;
  readonly codex: CodexHandler;
}

/** The only wiring site: every production dependency is constructed here. */
export const buildDeps = (config: Config): ServerDeps => {
  const logger = createConsoleLogger(config.logLevel);
  const cache = new ReasoningCache(config.reasoningCache.maxEntries, config.reasoningCache.maxBytes);
  const auth = new CodexAuthManager({
    store: createFsAuthFileStore(config.codex.authFile),
    oauthTokenUrl: config.codex.oauthTokenUrl,
    logger,
  });
  return {
    config,
    logger,
    forwardAnthropic: createAnthropicForwarder({
      baseUrl: config.anthropic.baseUrl,
      connectTimeoutMs: config.limits.connectTimeoutMs,
      streamIdleTimeoutMs: config.limits.streamIdleTimeoutMs,
      maxUpstreamSockets: config.limits.maxUpstreamSockets,
      logger,
    }),
    codex: createCodexHandler({ config, logger, auth, cache }),
  };
};

/**
 * Listen on `port`/`host` and return a Result rather than throwing.
 * Attaches the error listener before calling listen() so EADDRINUSE is captured cleanly.
 */
export const listenServer = (
  server: Server,
  port: number,
  host: string,
): Promise<Result<void, { code: string; message: string }>> =>
  new Promise((resolve) => {
    const onErr = (e: NodeJS.ErrnoException): void => {
      server.removeListener("listening", onListen);
      resolve(err({ code: e.code ?? "UNKNOWN", message: e.message }));
    };
    const onListen = (): void => {
      server.removeListener("error", onErr);
      resolve(ok(undefined));
    };
    server.once("error", onErr);
    server.once("listening", onListen);
    server.listen(port, host);
  });

const HEALTH_BODY = JSON.stringify({ name: SUBROUTE_NAME, version: SUBROUTE_VERSION });

const bufferBody = (req: IncomingMessage, maxBytes: number): Promise<Result<Buffer, ProxyError>> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const settle = (result: Result<Buffer, ProxyError>): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        settle(err({ kind: "body_too_large", message: `request body exceeds ${maxBytes} bytes` }));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => settle(ok(Buffer.concat(chunks))));
    req.on("error", () => settle(err({ kind: "client_disconnected", message: "client aborted while sending body" })));
  });

const peekModel = (body: Buffer): string | undefined => {
  try {
    const parsed = ModelPeekSchema.safeParse(JSON.parse(body.toString("utf8")));
    return parsed.success ? parsed.data.model : undefined;
  } catch {
    return undefined;
  }
};

export const createProxyServer = (deps: ServerDeps): Server => {
  const { config, logger } = deps;

  return http.createServer((req, res) => {
    const startedAt = Date.now();
    const path = req.url ?? "/";
    const pathname = path.split("?")[0] ?? path;
    let model: string | undefined;
    let route = "anthropic";

    res.on("close", () => {
      logger.log("info", "request_complete", {
        path: pathname,
        route,
        ...(model !== undefined ? { model } : {}),
        status: res.statusCode,
        latencyMs: Date.now() - startedAt,
      });
    });

    const dispatch = async (): Promise<void> => {
      // /__subroute/* namespace: handled locally, never forwarded upstream.
      if (pathname.startsWith("/__subroute/")) {
        if (req.method === "GET" && pathname === "/__subroute/health") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(HEALTH_BODY);
          return;
        }
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }

      // Only /v1/messages* bodies are buffered, and only to peek the model for
      // routing; the raw bytes are forwarded untouched so Content-Length holds.
      if (req.method !== "POST" || !pathname.startsWith("/v1/messages")) {
        deps.forwardAnthropic(req, res);
        return;
      }

      const body = await bufferBody(req, config.limits.maxBodyBytes);
      if (!body.ok) {
        if (body.error.kind === "body_too_large") {
          res.writeHead(413, { "content-type": "application/json", connection: "close" });
          res.end(toAnthropicErrorBody("invalid_request_error", body.error.message));
          req.destroy();
        }
        return;
      }

      model = peekModel(body.value);
      const decision = decideRoute(req.method ?? "POST", path, model, config.codex.models);
      route = decision.kind === "codex" ? `codex:${decision.endpoint}` : "anthropic";

      if (decision.kind === "anthropic") {
        deps.forwardAnthropic(req, res, body.value);
        return;
      }
      if (decision.endpoint === "count_tokens") {
        deps.codex.handleCountTokens(req, res, body.value);
        return;
      }
      await deps.codex.handleMessages(req, res, body.value);
    };

    dispatch().catch((cause: unknown) => {
      logger.log("error", "request_failed", { path: pathname, errorCode: cause instanceof Error ? cause.name : "unknown" });
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(toAnthropicErrorBody("api_error", "internal proxy error"));
      } else if (!res.writableEnded) {
        res.destroy();
      }
    });
  });
};
