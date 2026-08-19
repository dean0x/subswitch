import http from "node:http";
import { existsSync } from "node:fs";
import type { IncomingMessage, Server } from "node:http";
import { toAnthropicErrorBody, SYNTHESIZED_HEADER, SYNTHESIZED_MARKER } from "./errors.js";
import { applyInboundPolicy, SERVER_TUNING } from "./inbound-policy.js";
import { type Result, ok, err } from "./result.js";
import { aliasesByProvider, enumerateDestinations, isLoopbackHost, providerConfigFor, type Config } from "./config.js";
import { createConsoleLogger, type Logger } from "./logger.js";
import { providerEvents } from "./provider-events.js";
import { decideRoute } from "./router.js";
import { createAnthropicForwarder, type AnthropicForwarder } from "./anthropic-passthrough.js";
import { CodexAuthManager, createFsAuthFileStore } from "./codex-auth.js";
import type { ProviderAuth } from "./provider-auth.js";
import { ReasoningCache } from "./reasoning-cache.js";
import { createCodexHandler } from "./codex-handler.js";
import { ModelPeekSchema } from "./anthropic-wire-types.js";
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
const createCodexProvider = (config: Config, logger: Logger): ProviderHandler => {
  const provider = config.providers.codex;
  // Annotated rather than inferred: conformance is then checked here as well as at
  // `implements ProviderAuth<"codex">`, so an edit to CodexAuthManager that broke the
  // brand fails at the wiring site too — the place a mismatched credential enters.
  const auth: ProviderAuth<"codex"> = new CodexAuthManager({
    store: createFsAuthFileStore(provider.authFile),
    oauthTokenUrl: provider.oauthTokenUrl,
    logger,
    events: providerEvents("codex"),
  });
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

  // Vet each provider's credential-carrying URLs at startup.
  //
  // Two controls, both per-provider by construction (one provider's defaultHost cannot
  // accidentally vet another's baseUrl):
  //   1. SCHEME: http:// to a non-loopback host sends credentials in cleartext — warn.
  //      Loopback (127.*/localhost/::1) is exempt; the e2e dev workflow uses
  //      http://127.0.0.1:4142 intentionally.
  //   2. HOST: a URL on a different hostname than this provider's expected default
  //      sends credentials to a third-party host — FATAL unless allowInsecureBaseUrl.
  //      Loopback hosts are always exempt.
  //
  // Both baseUrl (short-lived access token) and oauthTokenUrl (long-lived refresh
  // token) are swept. oauthTokenUrl carries the more damaging credential.
  //
  // Anthropic baseUrl is checked separately below (not a ProviderId, so it is outside
  // this loop, but the threat model is the same: a sk-ant-* key forwarded to a
  // non-default host).
  //
  // z.url() in the config schema validates URL format; z.refine(requireHttpsOrLoopback)
  // rejects http:// non-loopback at parse time — this loop is defence in depth and also
  // catches programmatically-constructed Config objects that bypass Zod.
  for (const id of PROVIDER_IDS) {
    const { baseUrl, defaultHost, oauthTokenUrl, defaultOauthHost, allowInsecureBaseUrl } = providerConfigFor(config, id);
    const events = providerEvents(id);

    // Check baseUrl scheme and hostname.
    // new URL() is safe: z.url() already validated the URL at config-parse time.
    const parsedBase = new URL(baseUrl);
    if (!isLoopbackHost(parsedBase.hostname)) {
      if (parsedBase.protocol !== "https:") {
        logger.log("warn", events.insecureBaseUrlScheme);
      }
      if (parsedBase.hostname !== defaultHost) {
        if (!allowInsecureBaseUrl) {
          logger.log("error", events.baseUrlHostRejected, { path: `providers.${id}.baseUrl` });
          return err(
            `providers.${id}.baseUrl points at '${parsedBase.hostname}' (expected '${defaultHost}'). ` +
            `Credentials would be sent to an untrusted host. ` +
            `Set "providers.${id}.allowInsecureBaseUrl": true in subswitch.config.json to opt in.`,
          );
        }
        logger.log("warn", events.baseUrlOverrideDetected);
      }
    }

    // Check oauthTokenUrl scheme and hostname (present only for OAuth providers).
    // oauthTokenUrl carries the long-lived refresh token — more damaging to expose than
    // the short-lived access token in baseUrl.
    if (oauthTokenUrl !== undefined && defaultOauthHost !== undefined) {
      const parsedOauth = new URL(oauthTokenUrl);
      if (!isLoopbackHost(parsedOauth.hostname)) {
        if (parsedOauth.protocol !== "https:") {
          logger.log("warn", events.insecureBaseUrlScheme);
        }
        if (parsedOauth.hostname !== defaultOauthHost) {
          if (!allowInsecureBaseUrl) {
            logger.log("error", events.baseUrlHostRejected, { path: `providers.${id}.oauthTokenUrl` });
            return err(
              `providers.${id}.oauthTokenUrl points at '${parsedOauth.hostname}' (expected '${defaultOauthHost}'). ` +
              `Your long-lived refresh token would be sent to an untrusted host. ` +
              `Set "providers.${id}.allowInsecureBaseUrl": true in subswitch.config.json to opt in.`,
            );
          }
          logger.log("warn", events.baseUrlOverrideDetected);
        }
      }
    }
  }

  // Anthropic leg: same threat model — a sk-ant-* key forwarded verbatim to a
  // non-default host. `anthropic` is not a ProviderId, so the check is separate and
  // uses hardcoded event-name literals, following the existing pattern for
  // "anthropic_insecure_base_url_scheme".
  {
    const ANTHROPIC_DEFAULT_HOST = "api.anthropic.com";
    const parsedAnthropic = new URL(config.anthropic.baseUrl);
    if (!isLoopbackHost(parsedAnthropic.hostname)) {
      if (parsedAnthropic.protocol !== "https:") {
        logger.log("warn", "anthropic_insecure_base_url_scheme");
      }
      if (parsedAnthropic.hostname !== ANTHROPIC_DEFAULT_HOST) {
        if (!config.anthropic.allowInsecureBaseUrl) {
          logger.log("error", "anthropic_base_url_host_rejected", { path: "anthropic.baseUrl" });
          return err(
            `anthropic.baseUrl points at '${parsedAnthropic.hostname}' (expected '${ANTHROPIC_DEFAULT_HOST}'). ` +
            `Credentials would be sent to an untrusted host. ` +
            `Set "anthropic.allowInsecureBaseUrl": true in subswitch.config.json to opt in.`,
          );
        }
        logger.log("warn", "anthropic_base_url_override_detected");
      }
    }
  }

  // Build the routing table once. The resolver is a pure closure over this table;
  // "built once at startup" is a structural guarantee, not a comment. (applies ADR-005)
  const { table, rejectedAliases, danglingAliases, ambiguousFamilies, reservedNameEntries } = buildRoutingTable(
    MODEL_REGISTRY,
    aliasesByProvider(config),
  );

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

  return ok({
    config,
    logger,
    forwardAnthropic: createAnthropicForwarder({
      baseUrl: config.anthropic.baseUrl,
      connectTimeoutMs: config.anthropic.connectTimeoutMs,
      maxUpstreamSockets: config.anthropic.maxUpstreamSockets,
      logger,
    }),
    providers: {
      codex: createCodexProvider(config, logger),
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
 * Local error type for bufferBody. These errors are handled entirely within server.ts:
 *   - body_too_large: synthetic 413 is sent, then drainRejectedUpload() lets TCP close cleanly.
 *   - client_disconnected: client is gone — no HTTP response is possible.
 *
 * Both variants are deliberately excluded from ProxyError so proxyErrorToAnthropic
 * can never accidentally be called with them. The compiler enforces this: any future
 * code path that tries to pass a BufferBodyError into proxyErrorToAnthropic will fail
 * to type-check.
 */
type BufferBodyError =
  | { readonly kind: "body_too_large"; readonly message: string }
  | { readonly kind: "client_disconnected"; readonly message: string };

/**
 * Safety timeout for drainRejectedUpload: destroy the socket if draining stalls.
 *
 * Colocated with the helper because a later batch will move drainRejectedUpload
 * to provider-transport.ts and this constant must travel with it.
 *
 * The B7 integration test asserts closure between 1.5 s and 3 s, which remains
 * valid against this bound.
 */
const REJECTED_UPLOAD_DRAIN_MS = 2_000;

/**
 * Drain remaining upload data after a 413 so TCP can close with FIN rather than RST.
 *
 * When the server sends a 413 before the client finishes uploading, the socket still
 * has unread inbound bytes.  Calling req.socket.destroy() (or req.destroy()) with
 * unread data causes the kernel to send RST — the client may discard the response
 * before reading it.  Calling req.resume() drains the inbound data, allowing the
 * connection to close naturally with FIN, giving the client time to read the 413.
 *
 * REJECTED_UPLOAD_DRAIN_MS destroys the socket if draining stalls — e.g. when the
 * client is sending a pathologically large body and does not honour the 413.
 * unref() ensures this timer never prevents the process from exiting.
 *
 * The latch (`done`) prevents the timer from firing after a clean drain.
 *
 * Every disarm signal is taken from `req`, never from `res`.  The 413 has already
 * been written by the time this runs, so `res` emits "close" within a tick or two —
 * disarming on it cancelled the timer ~2 ms after arming it and left the bound dead
 * in exactly the case it exists for (measured: a client that keeps uploading after
 * the 413 was never cut off).  `req`'s "end"/"close"/"error" are the signals that
 * actually mean "the upload is finished or gone".
 */
const drainRejectedUpload = (req: IncomingMessage): void => {
  let done = false;
  const finish = (): void => {
    if (done) return;
    done = true;
    clearTimeout(timer);
  };
  const timer = setTimeout(() => {
    if (!done) req.socket?.destroy();
  }, REJECTED_UPLOAD_DRAIN_MS).unref();
  req.on("end", finish);
  req.on("close", finish);
  req.on("error", finish);
  req.resume();
};

const bufferBody = (req: IncomingMessage, maxBytes: number): Promise<Result<Buffer, BufferBodyError>> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const settle = (result: Result<Buffer, BufferBodyError>): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        // Release the accumulated prefix now rather than holding up to maxBodyBytes
        // alive until the request object is collected — drainRejectedUpload keeps
        // reading from this socket for up to 2 s after the 413.
        chunks.length = 0;
        settle(err({ kind: "body_too_large", message: `request body exceeds ${maxBytes} bytes` }));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      // Already rejected (body_too_large): drainRejectedUpload is draining the rest of
      // the upload, so 'end' still fires here with nothing left to assemble.
      if (settled) return;
      const result = Buffer.concat(chunks);
      chunks.length = 0; // release chunk array while concatenated buffer is still in scope
      settle(ok(result));
    });
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

export const createProxyServer = (deps: ServerDeps): Server => {
  const { config, logger } = deps;

  const server = http.createServer({ maxHeaderSize: SERVER_TUNING.maxHeaderSize }, (req, res) => {
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

      // Only /v1/messages* bodies are buffered, and only to peek the model for
      // routing; the raw bytes are forwarded untouched so Content-Length holds.
      if (req.method !== "POST" || !pathname.startsWith("/v1/messages")) {
        deps.forwardAnthropic(req, res);
        return;
      }

      const body = await bufferBody(req, config.limits.maxBodyBytes);
      if (!body.ok) {
        if (body.error.kind === "body_too_large") {
          // Use `request_too_large` — the error type Anthropic's own API returns for this
          // condition. `invalid_request_error` was incorrect; clients that key on the real API's
          // error taxonomy would not recognize the old type for a 413.
          //
          // drainRejectedUpload() lets remaining upload data drain before TCP teardown so the
          // kernel closes with FIN rather than RST — giving the client a chance to read this
          // 413 before the connection closes. req.destroy() was removed because calling destroy()
          // with unread inbound bytes causes RST, which may cause the client to discard the
          // response (delivering a 413 the client never sees is no better than a raw RST).
          // connection:close was also removed: it is a hop-by-hop header; Node's keep-alive
          // agent manages connection lifecycle and does not need the relay to hint it.
          res.writeHead(413, synthesizedHeaders());
          res.end(toAnthropicErrorBody("request_too_large", body.error.message));
          drainRejectedUpload(req);
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
      model = peekModel(parsedBody);

      // Resolve the model name once before routing (ADR-005: resolution strictly before dispatch).
      // deps.resolve was built once at startup by buildDeps — structural guarantee.
      const resolution = model !== undefined ? deps.resolve(model) : { kind: "unresolved" as const };
      const decision = decideRoute(req.method ?? "POST", path, resolution);

      switch (decision.kind) {
        case "anthropic":
          deps.forwardAnthropic(req, res, body.value);
          return;

        case "provider": {
          // Fold canonical id into route log field: "codex:messages:gpt-5.6-sol"
          route = `${decision.provider}:${decision.endpoint}:${decision.model}`;
          if (decision.endpoint === "count_tokens") {
            deps.providers[decision.provider].handleCountTokens(req, res, body.value);
            return;
          }
          await deps.providers[decision.provider].handleMessages(
            req,
            res,
            body.value,
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
          route = "anthropic";
          deps.forwardAnthropic(req, res, body.value);
          return;
        }

        case "unknown_provider": {
          // "claude-sonnet-9:preview" or "kimee:k2" — colon prefix is not a known provider id.
          // Fail open: forward to Anthropic and log a diagnostic warning. The origin may
          // support the name (future namespaced/variant ids); a relay-invented 400 that names
          // OUR provider registry in the error message is confusing and incorrect.
          // The log preserves diagnostic value for operators without breaking the client.
          logger.log("warn", "unknown_provider_qualifier", { model: decision.qualifier });
          route = "anthropic";
          deps.forwardAnthropic(req, res, body.value);
          return;
        }

        default: {
          // Exhaustive check — compiler enforces that all Route arms are handled.
          const _exhaustive: never = decision;
          void _exhaustive;
          deps.forwardAnthropic(req, res, body.value);
        }
      }
    };

    dispatch().catch((cause: unknown) => {
      route = "internal_error";
      logger.log("error", "request_failed", { path: pathname, errorCode: cause instanceof Error ? cause.name : "unknown" });
      if (!res.headersSent) {
        res.writeHead(500, synthesizedHeaders());
        res.end(toAnthropicErrorBody("api_error", "subswitch internal error — this is a proxy fault, not an upstream failure"));
      } else if (!res.writableEnded) {
        res.destroy();
      }
    });
  });

  // Inbound transport policy: the post-construction tuning knobs and the
  // clientError handler that owns the responses those knobs produce.  One call —
  // the two halves are not separately applicable by design (PF-021).
  // `maxHeaderSize` is the exception: it is constructor-only and was passed into
  // http.createServer above.
  applyInboundPolicy(server, logger);

  return server;
};
