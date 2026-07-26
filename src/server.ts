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
import { createCodexHandler } from "./codex-handler.js";
import { ModelPeekSchema } from "./anthropic-wire-types.js";
import {
  makeModelResolver,
  buildRoutingTable,
  resolveModel as resolveModelFromTable,
  MODEL_REGISTRY,
  type ModelResolution,
  type ProviderId,
} from "./models.js";
import { SUBSWITCH_NAME, SUBSWITCH_VERSION } from "./version.js";
import type { ProviderHandler } from "./provider-handler.js";

export interface ServerDeps {
  readonly config: Config;
  readonly logger: Logger;
  /** Privileged default leg — handles everything that is not POST /v1/messages*. */
  readonly forwardAnthropic: AnthropicForwarder;
  /**
   * Provider dispatch table. `Record<ProviderId, …>` — NOT `Partial`, NOT `Map`.
   * Adding a `ProviderId` without a handler is a compile error: the whole point of
   * `ProviderId` being a closed union is that the completeness check is structural.
   */
  readonly providers: Readonly<Record<ProviderId, ProviderHandler>>;
  /**
   * Model resolver built once at startup (applies ADR-005).
   * "Built once" is structural: the table is closed over in this closure and
   * cannot be replaced at request time. Production currently routes via the
   * legacy `makeModelResolver` path inside createProxyServer; this field
   * exists for testability and is the resolver that Phase E will flip on.
   */
  readonly resolve: (name: string) => ModelResolution;
}

/** The default Codex API host. Used to emit a startup warning when overridden. */
const DEFAULT_CODEX_HOST = "chatgpt.com";

/**
 * Create and wire the Codex provider handler.
 *
 * Moving ReasoningCache and CodexAuthManager construction here ensures they are
 * only allocated when a Codex provider is actually wired — not unconditionally
 * for every process. (applies ADR-002)
 */
const createCodexProvider = (config: Config, logger: Logger): ProviderHandler =>
  createCodexHandler({
    config,
    logger,
    auth: new CodexAuthManager({
      store: createFsAuthFileStore(config.codex.authFile),
      oauthTokenUrl: config.codex.oauthTokenUrl,
      logger,
    }),
    cache: new ReasoningCache(config.reasoningCache.maxEntries, config.reasoningCache.maxBytes),
  });

/** The only wiring site: every production dependency is constructed here. */
export const buildDeps = (config: Config): ServerDeps => {
  const logger = createConsoleLogger(config.logLevel);

  // Warn when the configured base URL host differs from the expected default.
  // A refreshable subscription credential pointed at an arbitrary host sends the
  // OAuth token there — warn at startup so operators notice immediately.
  // z.url() in the config schema guarantees baseUrl is a valid URL here.
  try {
    const configHost = new URL(config.codex.baseUrl).hostname;
    if (configHost !== DEFAULT_CODEX_HOST) {
      logger.log("warn", "codex_base_url_override_detected");
    }
  } catch {
    // Unreachable: z.url() already validated the URL during config parsing.
  }

  // Build the routing table once. The resolver is a pure closure over this table;
  // "built once at startup" is a structural guarantee, not a comment. (applies ADR-005)
  const aliasesByProvider: Record<ProviderId, Record<string, string>> = {
    codex: config.codex.aliases,
  };
  const { table } = buildRoutingTable(MODEL_REGISTRY, aliasesByProvider);

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
    providers: {
      codex: createCodexProvider(config, logger),
    },
    resolve: (name) => resolveModelFromTable(table, name),
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

const HEALTH_BODY = JSON.stringify({ name: SUBSWITCH_NAME, version: SUBSWITCH_VERSION });

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

/**
 * Peek the model name from an already-parsed JSON value.
 *
 * Separated from the JSON.parse call so the body is parsed exactly once (P4).
 * Returns undefined when `parsed` is not an object with a string `model` field.
 */
const peekModel = (parsed: unknown): string | undefined => {
  const result = ModelPeekSchema.safeParse(parsed);
  return result.success ? result.data.model : undefined;
};

export const createProxyServer = (deps: ServerDeps): Server => {
  const { config, logger } = deps;

  // Build the legacy resolver that currently drives production routing.
  // This is the OLD makeModelResolver path — Phase E replaces it with deps.resolve.
  // Both live in the same process for this phase so the resolver is built exactly
  // once here (createProxyServer is called once at startup).
  const resolveModel = makeModelResolver(
    MODEL_REGISTRY,
    new Set(config.codex.models),
    config.codex.aliases,
  );

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
      // /__subswitch/* namespace: handled locally, never forwarded upstream.
      if (pathname.startsWith("/__subswitch/")) {
        if (req.method === "GET" && pathname === "/__subswitch/health") {
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

      // Parse the body JSON once. The parsed value is passed to the provider handler
      // so it never needs to call JSON.parse again (P4 contract).
      // On failure: parsedBody stays null, peekModel returns undefined, and the
      // request routes to Anthropic where the upstream will return its own error.
      let parsedBody: unknown = null;
      try {
        parsedBody = JSON.parse(body.value.toString("utf8"));
      } catch {
        // Invalid JSON: peekModel will return undefined → decideRoute routes to anthropic.
      }

      // `model` is the as-requested name — preserved for the request_complete log so
      // operators can grep for what the client typed (a typo like "sol" not "sool").
      // `canonical` is the resolved id passed to decideRoute and handleMessages so
      // both routing and upstream wire-format use the same stable string. (applies ADR-005)
      model = peekModel(parsedBody);
      const canonical = model === undefined ? undefined : (resolveModel(model) ?? model);
      const decision = decideRoute(req.method ?? "POST", path, canonical, config.codex.models);
      route = decision.kind === "codex" ? `codex:${decision.endpoint}` : "anthropic";

      if (decision.kind === "anthropic") {
        deps.forwardAnthropic(req, res, body.value);
        return;
      }
      if (decision.endpoint === "count_tokens") {
        deps.providers.codex.handleCountTokens(req, res, body.value);
        return;
      }
      // Defensive guard: decideRoute only returns codex:messages when `model` is a
      // member of config.codex.models (exact-membership check). When model is defined,
      // `canonical = resolveModel(model) ?? model` is always a string. The guard
      // documents this invariant and avoids a non-null assertion. (avoids PF-002-style trap)
      if (canonical === undefined) {
        deps.forwardAnthropic(req, res, body.value);
        return;
      }
      await deps.providers.codex.handleMessages(req, res, body.value, parsedBody, canonical);
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
