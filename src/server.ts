import { vetCredentialUrl } from "./upstream-policy.js";
import { ClaudeAuthManager, createClaudeCredentialStore } from "./claude-auth.js";
import { openaiErrorBody } from "./errors.js";
import http from "node:http";
import { existsSync } from "node:fs";
import type { IncomingMessage, Server } from "node:http";
import { toAnthropicErrorBody, SYNTHESIZED_HEADER, SYNTHESIZED_MARKER } from "./errors.js";
import { applyInboundPolicy, hostGateVerdict, SERVER_TUNING } from "./inbound-policy.js";
import { type Result, ok, err } from "./result.js";
import { aliasesByProvider, enumerateDestinations, providerConfigFor, type Config } from "./config.js";
import { createConsoleLogger, type Logger } from "./logger.js";
import { CLAUDE_EVENTS, OPENAI_EVENTS, ANTHROPIC_EVENTS, providerEvents } from "./provider-events.js";
import { decideRoute } from "./router.js";
import { createAnthropicForwarder, type AnthropicForwarder, type ForwardedBody } from "./anthropic-passthrough.js";
import { sniffLeadingModel, MODEL_SNIFF_BYTES } from "./anthropic-parse.js";
import { CodexAuthManager, createFsAuthFileStore } from "./codex-auth.js";
import type { ProviderAuth } from "./provider-auth.js";
import { ReasoningCache } from "./reasoning-cache.js";
import { createCodexHandler } from "./codex-handler.js";
import { ModelPeekSchema } from "./anthropic-wire-types.js";
import { drainRejectedUpload } from "./provider-transport.js";
import {
  buildRoutingTable,
  resolveModel as resolveModelFromTable,
  MODEL_REGISTRY,
  PROVIDER_IDS,
  routableModelCount,
  type ModelResolution,
  type ProviderId,
} from "./models.js";
import { SUBSWITCH_NAME, SUBSWITCH_VERSION } from "./version.js";
import type { ProviderHandler } from "./provider-handler.js";
import { codexIngressRoute } from "./codex-ingress.js";
import { rejectCodexUpgrade, type CodexIngressEntry } from "./openai-passthrough.js";
import { CodexGateway } from "./codex-gateway.js";
import { hasNativeDecoders } from "./content-encoding.js";
import { claudeResolver } from "./claude-models.js";
import { codexIngressHealth } from "./codex-health.js";

export interface ServerDeps {
  readonly config: Config;
  readonly logger: Logger;
  /** Privileged default leg — handles everything that is not POST /v1/messages*. */
  readonly forwardAnthropic: AnthropicForwarder;
  readonly forwardOpenai: CodexIngressEntry | undefined;
  /**
   * Provider dispatch table. `Record<ProviderId, …>` — NOT `Partial`, NOT `Map`.
   * Adding a `ProviderId` without a handler is a compile error: the whole point of
   * `ProviderId` being a closed union is that the completeness check is structural.
   */
  readonly providers: Readonly<Record<ProviderId, ProviderHandler>>;
  /**
   * Model resolver built once at startup (applies ADR-005).
   * "Built once" is structural: the table is closed over in this closure and
   * cannot be replaced at request time. `buildDeps` calls `buildRoutingTable` once
   * and closes `resolveModelFromTable` over the result.
   */
  readonly resolve: (name: string) => ModelResolution;
}

/**
 * Create and wire the Codex provider handler.
 *
 * Moving ReasoningCache and CodexAuthManager construction here ensures they are
 * only allocated when a Codex provider is actually wired — not unconditionally
 * for every process. (applies ADR-002)
 */
const createCodexAuth = (config: Config, logger: Logger): ProviderAuth<"codex"> => new CodexAuthManager({
  store: createFsAuthFileStore(config.providers.codex.authFile),
  oauthTokenUrl: config.providers.codex.oauthTokenUrl, logger, events: providerEvents("codex"),
});

const createCodexProvider = (config: Config, logger: Logger, auth: ProviderAuth<"codex">): ProviderHandler => {
  const provider = config.providers.codex;
  return createCodexHandler({
    providerId: "codex",
    provider,
    pingIntervalMs: config.limits.pingIntervalMs,
    loginCommand: providerConfigFor(config, "codex").loginCommand,
    logger,
    auth,
    cache: new ReasoningCache(provider.reasoningCache.maxEntries, provider.reasoningCache.maxBytes),
  });
};

/**
 * The only wiring site: every production dependency is constructed here.
 *
 * `logger` is a parameter rather than a local so that an injected logger reaches the
 * provider handlers too. It defaults to the real console logger, so production callers
 * are unchanged. Constructing it internally made `startSubswitch`'s `logger` option
 * silently partial — it replaced only the request-loop's logger, while every handler
 * kept the one built here, so a test that injected a logger to observe handler records
 * saw none of them and its assertions passed vacuously.
 *
 * Returns `err(message)` when a security gate rejects the config (e.g. a credential-
 * bearing URL points at a non-default host without `allowInsecureBaseUrl: true`).
 * The `serve` command exits non-zero on err; diagnostic commands (`doctor`, `models`)
 * do not call `buildDeps` and are unaffected.
 */
export const buildDeps = (config: Config, logger: Logger = createConsoleLogger(config.logLevel)): Result<ServerDeps, string> => {

  if (config.codexIngress.enabled && config.codexIngress.claude.enabled && !hasNativeDecoders())
    return err("Codex → Claude routing requires native zstd support. Use Node 22.15 or newer; forward routing remains available.");

  // All credential-bearing URL checks share the same opt-in vocabulary and diagnostics.
  for (const [key, expectedHost] of [["baseUrl", "api.anthropic.com"], ["oauthTokenUrl", "platform.claude.com"]] as const) {
    const result = vetCredentialUrl({ url: config.codexIngress.claude[key], path: `codexIngress.claude.${key}`,
      expectedHost, optInKey: "codexIngress.claude.allowInsecureBaseUrl", allowOverride: config.codexIngress.claude.allowInsecureBaseUrl,
      logger, events: CLAUDE_EVENTS, refreshToken: key === "oauthTokenUrl" });
    if (!result.ok) return result;
  }
  for (const [key, expectedHost] of [["subscriptionBaseUrl", "chatgpt.com"], ["apiBaseUrl", "api.openai.com"]] as const) {
    const result = vetCredentialUrl({ url: config.codexIngress[key], path: `codexIngress.${key}`,
      expectedHost, optInKey: "codexIngress.allowInsecureBaseUrl", allowOverride: config.codexIngress.allowInsecureBaseUrl,
      logger, events: OPENAI_EVENTS });
    if (!result.ok) return result;
  }
  for (const id of PROVIDER_IDS) {
    const provider = providerConfigFor(config, id);
    const urls = [
      { url: provider.baseUrl, expectedHost: provider.defaultHost, key: "baseUrl", refreshToken: false },
      ...(provider.oauthTokenUrl && provider.defaultOauthHost ? [{ url: provider.oauthTokenUrl,
        expectedHost: provider.defaultOauthHost, key: "oauthTokenUrl", refreshToken: true }] : []),
    ];
    for (const url of urls) {
      const result = vetCredentialUrl({ ...url, path: `providers.${id}.${url.key}`, optInKey: `providers.${id}.allowInsecureBaseUrl`,
        allowOverride: provider.allowInsecureBaseUrl, logger, events: providerEvents(id) });
      if (!result.ok) return result;
    }
  }
  const anthropic = vetCredentialUrl({ url: config.anthropic.baseUrl, path: "anthropic.baseUrl", expectedHost: "api.anthropic.com",
    optInKey: "anthropic.allowInsecureBaseUrl", allowOverride: config.anthropic.allowInsecureBaseUrl, logger, events: ANTHROPIC_EVENTS });
  if (!anthropic.ok) return anthropic;

  // Build the routing table once. The resolver is a pure closure over this table;
  // "built once at startup" is a structural guarantee, not a comment. (applies ADR-005)
  const {
    table, rejectedAliases, danglingAliases, ambiguousFamilies, reservedNameEntries, unknownReasoningEfforts,
  } = buildRoutingTable(MODEL_REGISTRY, aliasesByProvider(config));

  // buildRoutingTable is total and reports problems as data rather than throwing —
  // which only helps if someone reads them. Silence here would mean an alias the user
  // wrote simply does not work, with nothing anywhere saying why.
  for (const { alias, target } of rejectedAliases) {
    logger.log("warn", "alias_rejected", { model: `${alias} -> ${target}` });
  }
  for (const { alias, target } of danglingAliases) {
    logger.log("warn", "alias_dangling_target", { model: `${alias} -> ${target} (target not in registry; forward-compat routing active)` });
  }
  for (const { family, providers } of ambiguousFamilies) {
    logger.log("warn", "ambiguous_family", { model: `${family} (${providers.join(", ")})` });
  }
  for (const id of reservedNameEntries) {
    logger.log("warn", "registry_entry_uses_reserved_name", { model: id });
  }
  // Same reason as the loops above: a registry entry declaring an effort the backend never
  // accepts silently stops accepting an effort it should, and every request-level warning
  // names the request rather than the registry line that caused it.
  for (const { id, efforts } of unknownReasoningEfforts) {
    logger.log("warn", "registry_entry_unknown_effort", { model: `${id} (${efforts.join(", ")})` });
  }

  const resolveClaude = claudeResolver(config.codexIngress.claude.aliases);
  if (resolveClaude.rejectedAliases.length) return err(`Invalid Claude aliases: ${resolveClaude.rejectedAliases.join(", ")}`);
  const codexAuth = createCodexAuth(config, logger);

  return ok({
    config,
    logger,
    forwardOpenai: config.codexIngress.enabled ? new CodexGateway({ config, logger, parentAuth: codexAuth, resolveClaude,
      claudeAuth: new ClaudeAuthManager({ store: createClaudeCredentialStore(config.codexIngress.claude),
        oauthTokenUrl: config.codexIngress.claude.oauthTokenUrl, logger }),
    }) : undefined,
    forwardAnthropic: createAnthropicForwarder({
      baseUrl: config.anthropic.baseUrl,
      connectTimeoutMs: config.anthropic.connectTimeoutMs,
      maxUpstreamSockets: config.anthropic.maxUpstreamSockets,
      logger,
    }),
    providers: {
      codex: createCodexProvider(config, logger, codexAuth),
    },
    resolve: (name) => resolveModelFromTable(table, name),
  });
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

/**
 * Build the health response body for a given config.
 * Dynamic: includes per-destination status (configured + model count).
 * Never includes credentials, tokens, or secrets — only structural metadata. [compliance]
 *
 * Uses enumerateDestinations so the topology (Anthropic passthrough + registry
 * providers) is the single source of truth shared with models --json.  (ARCH-04)
 */
const buildHealthBody = (config: Config): string =>
  JSON.stringify({
    name: SUBSWITCH_NAME,
    version: SUBSWITCH_VERSION,
    codexIngress: codexIngressHealth(config),
    providers: enumerateDestinations(config).map((d) => {
      if (d.routing === "passthrough") {
        // Anthropic is always reachable — no auth file, no model list. (applies ADR-002)
        return { id: d.id, configured: true, modelCount: 0 };
      }
      // existsSync is sync and acceptable here (health endpoint, not hot path).
      return {
        id: d.id,
        configured: existsSync(d.authFile),
        modelCount: routableModelCount(MODEL_REGISTRY, d.id),
      };
    }),
  });

/**
 * Local error type for readBodyForRouting.  The only failure is `client_disconnected`.
 * An over-window body is a successful (ok) result: it is a routing outcome, not a
 * failure.  The 413 for translated-route over-window bodies is emitted in the dispatch
 * switch, not here, keeping readBodyForRouting protocol-agnostic.
 *
 * Deliberately excluded from ProxyError so proxyErrorToAnthropic can never
 * accidentally be called with it.  The compiler enforces this: any future code path
 * that tries to pass an IngestError into proxyErrorToAnthropic will fail to type-check.
 */
type IngestError = { readonly kind: "client_disconnected"; readonly message: string };

/**
 * What readBodyForRouting hands back on success.
 *
 * "complete"   — the full body fits within the routing window; `body` is the
 *                complete bytes.  Exactly today's path: JSON.parse → peekModel →
 *                resolve → decideRoute → dispatch.
 *
 * "over_window" — the body exceeded the window (or declared a Content-Length above
 *                 it); `prefix` holds the bytes that were read before the trip.
 *                 The rest is still on `req`.  The caller scans the prefix for the
 *                 model key and either streams to Anthropic or answers 413.
 *
 * Invariant: peak buffered bytes per request ≤ window + one socket read.
 */
type IngestedBody =
  | { readonly kind: "complete"; readonly body: Buffer }
  | { readonly kind: "over_window"; readonly prefix: Buffer };

/**
 * Read request bytes up to `windowBytes` for the routing decision.
 *
 * Three paths:
 *   1. Content-Length declared and > window → read up to min(MODEL_SNIFF_BYTES, window)
 *      then settle as over_window.  No point buffering more: outcome is already decided.
 *   2. Body fits within window → settle as complete.
 *   3. Body crosses the window mid-stream → keep all accumulated bytes (they will be
 *      forwarded), pause the stream, detach listeners in the same tick, settle as
 *      over_window.  Buffered bytes are retained across pause and delivered by pipe().
 *
 * Invariant: peak buffered bytes per request ≤ window + one socket read.
 */
const readBodyForRouting = (req: IncomingMessage, windowBytes: number): Promise<Result<IngestedBody, IngestError>> =>
  new Promise((resolve) => {
    // A declared Content-Length over the cap fixes the routing path before a byte
    // arrives.  Rather than reading the full window (wasted memory), read only enough
    // to sniff the model field (MODEL_SNIFF_BYTES) — an amount that is already
    // sufficient to decide between Anthropic streaming and a 413.
    //
    // Number.isInteger rejects both a missing header (NaN) and a malformed one; a
    // chunked or undeclared body has no length to check and is handled below.
    const declared = Number(req.headers["content-length"]);
    const limit =
      Number.isInteger(declared) && declared > windowBytes
        ? Math.min(MODEL_SNIFF_BYTES, windowBytes)
        : windowBytes;

    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const settle = (result: Result<IngestedBody, IngestError>): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const onData = (chunk: Buffer): void => {
      // Push the chunk FIRST — every byte must be kept for forwarding.
      chunks.push(chunk);
      total += chunk.length;
      if (total > limit) {
        // Detach all three listeners in the same tick before settling.  Leaving "data"
        // attached continues to fire and would re-enter this branch for every subsequent
        // chunk; leaving "end"/"error" attached leaves them active while drainRejectedUpload
        // or pipe() owns the stream.  Pause first so in-flight data events already
        // queued in the event loop run against the detached handlers (they are no-ops
        // once removed, so the chunks are not re-processed).
        req.pause();
        req.off("data", onData);
        req.off("end", onEnd);
        req.off("error", onError);
        settle(ok({ kind: "over_window", prefix: Buffer.concat(chunks) }));
        chunks.length = 0; // release chunk array; concatenated prefix is now the sole reference
        return;
      }
    };
    const onEnd = (): void => {
      if (settled) return;
      const result = Buffer.concat(chunks);
      chunks.length = 0; // release chunk array while concatenated buffer is still in scope
      settle(ok({ kind: "complete", body: result }));
    };
    const onError = (): void =>
      settle(err({ kind: "client_disconnected", message: "client aborted while sending body" }));
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
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

/**
 * Base headers for every response the relay generates itself (as opposed to
 * responses proxied verbatim from an upstream).  The synthesized marker is
 * included here so callers cannot forget it and future synthesized response
 * sites are correct by default.
 */
const synthesizedHeaders = (): Record<string, string> => ({
  "content-type": "application/json",
  [SYNTHESIZED_HEADER]: SYNTHESIZED_MARKER,
});

/** Own upgraded-connection shutdown before Node waits for listener connections to drain. */
class SubswitchServer extends http.Server {
  constructor(private readonly closeUpstreamConnections: () => void, handler: http.RequestListener) {
    super({ maxHeaderSize: SERVER_TUNING.maxHeaderSize }, handler);
  }

  override close(callback?: (error?: Error) => void): this {
    this.closeUpstreamConnections();
    return super.close(callback);
  }
}

export const createProxyServer = (deps: ServerDeps): Server => {
  const { config, logger } = deps;

  const server = new SubswitchServer(() => { deps.forwardOpenai?.close(); deps.forwardAnthropic.close?.(); }, (req, res) => {
    const startedAt = Date.now();
    const path = req.url ?? "/";
    const pathname = path.split("?")[0] ?? path;
    const ingress = codexIngressRoute(path);
    const logPath = ingress.kind === "other" ? pathname : "/codex";
    let model: string | undefined;
    let route = "anthropic";
    let bodyMode: "buffered" | "streamed" | undefined;

    res.on("close", () => {
      // One record per request, and only one of the two shapes.  When no response
      // ever reached the client there is no status to report: `res.statusCode` is
      // Node's 200 initialiser, so `request_complete status=200` would render a
      // client that vanished mid-upload identically to a served request.
      if (!res.headersSent) {
        logger.log("info", "client_disconnected", {
          path: logPath,
          route,
          ...(model !== undefined ? { model } : {}),
          latencyMs: Date.now() - startedAt,
        });
        return;
      }
      logger.log("info", "request_complete", {
        path: logPath,
        route,
        ...(model !== undefined ? { model } : {}),
        ...(bodyMode !== undefined ? { bodyMode } : {}),
        status: res.statusCode,
        latencyMs: Date.now() - startedAt,
      });
    });

    const dispatch = async (): Promise<void> => {
      // Loopback Host/Origin gate — first, for every path and every method.
      //
      // The relay binds 127.0.0.1 and requires no authentication, so reachability is
      // its only access control, and DNS rebinding defeats reachability: a page on
      // http://evil.test:4141 that resolves to 127.0.0.1 is same-origin with the relay
      // in the browser's eyes and can read the response — including Codex output paid
      // for with the operator's OAuth material.  The Host header is the one thing that
      // page cannot change, so it is what the gate reads (hostGateVerdict, inbound-policy.ts).
      //
      // Placed above the /__subswitch/* branch deliberately: those endpoints are
      // relay-owned, disclose its topology, and are exactly as reachable from a
      // rebound page as /v1/messages is.  Placed above readBodyForRouting so a rejected
      // upload is never accumulated.
      const gate = hostGateVerdict(req.headers);
      if (gate.kind === "reject") {
        route = "host_rejected";
        // The rejected value is sanitised and capped by hostGateVerdict; the body
        // carries a fixed message and never echoes it back to the caller.
        logger.log("warn", "host_rejected", { path: logPath, errorCode: `${gate.reason} ${gate.observed}`, status: 403 });
        // 403/permission_error: a status and type the origin itself emits (applies
        // ADR-010 — a Host naming a domain this relay does not serve is a request the
        // origin would never have received), rendered through the error chokepoint
        // (applies ADR-008).
        res.writeHead(403, synthesizedHeaders());
        res.end(ingress.kind === "other" ? toAnthropicErrorBody("permission_error", gate.message) :
          openaiErrorBody(gate.message, "subswitch_host_rejected"));
        // The upload may still be in flight.  Same reasoning as the 413 below:
        // destroying the socket here makes the kernel send RST and the client may
        // discard the 403 it was just sent.
        drainRejectedUpload(req);
        return;
      }

      // Reserve the whole Codex namespace before the Claude-facing fallback.
      if (ingress.kind !== "other") {
        route = ingress.kind === "codex" ? `codex_ingress:${ingress.mode}:passthrough` : "codex_ingress:unknown";
        if (ingress.kind === "reserved" || !deps.forwardOpenai) {
          res.writeHead(ingress.kind === "reserved" ? 404 : 503, synthesizedHeaders());
          res.end(openaiErrorBody(ingress.kind === "reserved" ? "unknown Codex ingress path" :
            "Codex passthrough is disabled; enable codexIngress.enabled to use this endpoint"));
          drainRejectedUpload(req);
          return;
        }
        deps.forwardOpenai.http(req, res, ingress.mode, ingress.path);
        return;
      }

      // /__subswitch/* namespace: handled locally, never forwarded upstream.
      if (pathname.startsWith("/__subswitch/")) {
        if (req.method === "GET" && pathname === "/__subswitch/health") {
          res.writeHead(200, synthesizedHeaders());
          res.end(buildHealthBody(config));
          return;
        }
        res.writeHead(404, synthesizedHeaders());
        // toAnthropicErrorBody shapes the 404 identically to every other synthesized error,
        // preventing path reflection and credential leakage (ADR-008, chokepoint pattern).
        // Do NOT echo the requested path: path reflection is a log-injection / reflection
        // surface — use a fixed message only.
        res.end(toAnthropicErrorBody("not_found_error", "not found"));
        return;
      }

      // Only /v1/messages* bodies are read for routing — to peek the model field.
      // Bodies that fit within the routing window are buffered and forwarded byte-for-byte.
      // Over-window bodies are streamed: only a prefix is read, then req is piped.
      if (req.method !== "POST" || !pathname.startsWith("/v1/messages")) {
        deps.forwardAnthropic(req, res);
        return;
      }

      const ingest = await readBodyForRouting(req, config.limits.maxBufferedBodyBytes);
      if (!ingest.ok) {
        switch (ingest.error.kind) {
          case "client_disconnected":
            // The client is gone before the upload finished, so no response can reach
            // it and nothing is written to `res`.  `res` has already emitted "close" by
            // the time this runs (measured on Node 22.22: `res` "close" precedes `req`
            // "error"), and the close handler above has recorded the disconnect.
            return;

          default: {
            // Exhaustive check — a new IngestError variant is a compile error here
            // rather than a request that returns nothing and is logged as a success.
            const _exhaustive: never = ingest.error.kind;
            void _exhaustive;
            return;
          }
        }
      }

      // Parse the body JSON once (complete path only). The parsed value is passed to
      // the provider handler so it never needs to call JSON.parse again (P4 contract).
      // On failure: parsedBody stays null, peekModel returns undefined, and the
      // request routes to Anthropic where the upstream will return its own error.
      let parsedBody: unknown = null;
      let forwardBody: ForwardedBody;

      if (ingest.value.kind === "complete") {
        try {
          parsedBody = JSON.parse(ingest.value.body.toString("utf8"));
        } catch {
          // Invalid JSON: peekModel will return undefined → decideRoute routes to anthropic.
        }
        // `model` is the as-requested name — preserved for the request_complete log so
        // operators can grep for what the client typed (a typo like "sol" not "sool").
        model = peekModel(parsedBody);
        forwardBody = { kind: "complete", bytes: ingest.value.body };
        bodyMode = "buffered";
      } else {
        // over_window: scan the prefix for the model key.
        // JSON.parse is not available — the body is not fully buffered.
        model = sniffLeadingModel(ingest.value.prefix);
        forwardBody = { kind: "prefix", bytes: ingest.value.prefix };
        bodyMode = "streamed";
      }

      // Resolve the model name once before routing (ADR-005: resolution strictly before dispatch).
      // deps.resolve was built once at startup by buildDeps — structural guarantee.
      const resolution = model !== undefined ? deps.resolve(model) : { kind: "unresolved" as const };
      const decision = decideRoute(req.method ?? "POST", path, resolution);

      switch (decision.kind) {
        case "anthropic": {
          // Over-window Anthropic-bound bodies are forwarded as a stream: the relay
          // buffers only a prefix, then pipes the rest.  This is the correct behavior
          // per ADR-010: a relay-synthesized 413 for a body the origin would have
          // accepted is a status the origin never emits.  Anthropic enforces its own
          // payload limits with authoritative errors; we must not invent one first.
          if (ingest.value.kind === "over_window") {
            // Distinguish sniff-resolved from fail-open for post-hoc log analysis.
            // "anthropic:streamed" means the prefix contained a recognized model key.
            // "anthropic:streamed:unsniffed" means the key was absent or beyond the sniff
            // window — the relay fails open to Anthropic per ADR-010.
            route = model !== undefined ? "anthropic:streamed" : "anthropic:streamed:unsniffed";
          }
          deps.forwardAnthropic(req, res, forwardBody);
          return;
        }

        case "provider": {
          // Fold canonical id into route log field: "codex:messages:gpt-5.6-sol"
          route = `${decision.provider}:${decision.endpoint}:${decision.model}`;
          if (ingest.value.kind === "over_window") {
            // The relay is the origin on the translated leg — it cannot translate a body
            // it cannot hold.  413 is authoritative here, not relay-invented (ADR-010):
            // the origin (subswitch) genuinely cannot process this request.
            res.writeHead(413, synthesizedHeaders());
            res.end(toAnthropicErrorBody("request_too_large", `request body exceeds ${config.limits.maxBufferedBodyBytes} bytes`));
            drainRejectedUpload(req);
            return;
          }
          if (decision.endpoint === "count_tokens") {
            deps.providers[decision.provider].handleCountTokens(req, res, ingest.value.body);
            return;
          }
          await deps.providers[decision.provider].handleMessages(
            req,
            res,
            ingest.value.body,
            parsedBody,
            decision.model,
          );
          return;
        }

        case "ambiguous": {
          // Fail open: forward to Anthropic and log a diagnostic warning.
          //
          // Rationale: the same as `unknown_provider`.  A relay-invented 400 that names OUR
          // provider registry in the error message is an ADR-010 violation — it produces a
          // status the origin never emits in this situation.  The origin may support the name
          // unambiguously; at minimum, forwarding lets it answer with its own error, which is
          // always preferable to the relay inventing one.
          //
          // PROVIDER_IDS only has "codex" today, so this branch is currently unreachable in
          // practice.  It becomes live the moment a second provider ships — the forward-safe
          // policy ensures correctness by default.
          //
          // The warn log preserves diagnostic value: `model` carries the ambiguous name
          // annotated with the provider list ("name (p1, p2)") so operators can identify and
          // disambiguate the alias.
          logger.log("warn", "ambiguous_model_name", { model: `${decision.name} (${decision.providers.join(", ")})` });
          // Distinct route label so request_complete is distinguishable from an intended
          // Anthropic route in post-hoc log analysis (applies ADR-010, avoids PF-023).
          route = "anthropic:ambiguous";
          deps.forwardAnthropic(req, res, forwardBody);
          return;
        }

        case "unknown_provider": {
          // "claude-sonnet-9:preview" or "kimee:k2" — colon prefix is not a known provider id.
          // Fail open: forward to Anthropic and log a diagnostic warning. The origin may
          // support the name (future namespaced/variant ids); a relay-invented 400 that names
          // OUR provider registry in the error message is confusing and incorrect.
          // Log the full as-requested model name (e.g. "kimee:k2") so operators see what the
          // client sent, not just the extracted qualifier — the qualifier alone loses the model
          // part of the name and is less actionable (I-051).
          logger.log("warn", "unknown_provider_qualifier", { model: model ?? decision.qualifier });
          // Distinct route label so request_complete is distinguishable from an intended
          // Anthropic route in post-hoc log analysis (applies ADR-010, avoids PF-023).
          route = "anthropic:fallback";
          deps.forwardAnthropic(req, res, forwardBody);
          return;
        }

        default: {
          // Exhaustive check — compiler enforces that all Route arms are handled.
          const _exhaustive: never = decision;
          void _exhaustive;
          deps.forwardAnthropic(req, res, forwardBody);
        }
      }
    };

    dispatch().catch((cause: unknown) => {
      route = "internal_error";
      logger.log("error", "request_failed", { path: logPath, errorCode: cause instanceof Error ? cause.name : "unknown" });
      if (!res.headersSent) {
        res.writeHead(500, synthesizedHeaders());
        const message = "subswitch internal error — this is a proxy fault, not an upstream failure";
        res.end(ingress.kind === "other" ? toAnthropicErrorBody("api_error", message) : openaiErrorBody(message));
      } else if (!res.writableEnded) {
        res.destroy();
      }
      // If the body was paused mid-upload (over_window path) when dispatch() threw,
      // resume and discard it so the socket is not left wedged.
      drainRejectedUpload(req);
    });
  });

  // Inbound transport policy: the post-construction tuning knobs and the
  // clientError handler that owns the responses those knobs produce.  One call —
  // the two halves are not separately applicable by design (PF-021).
  // `maxHeaderSize` is the exception: it is constructor-only and is passed into
  // SubswitchServer above.
  applyInboundPolicy(server, logger);

  server.on("upgrade", (req, socket, head) => {
    socket.on("error", () => socket.destroy());
    const gate = hostGateVerdict(req.headers);
    const ingress = codexIngressRoute(req.url ?? "/");
    const reject = (status: number, message: string) => rejectCodexUpgrade(req, socket, status, message,
      ingress.kind === "other" ? text => toAnthropicErrorBody(status === 403 ? "permission_error" : "not_found_error", text) : openaiErrorBody);
    if (gate.kind === "reject") { reject(403, gate.message); return; }
    if (ingress.kind !== "codex") { reject(404, "unknown upgrade path"); return; }
    if (!deps.forwardOpenai) { rejectCodexUpgrade(req, socket, 503, "Codex passthrough is disabled"); return; }
    deps.forwardOpenai.upgrade(req, socket, head, ingress.mode, ingress.path);
  });
  return server;
};
