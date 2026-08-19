import http from "node:http";
import { existsSync } from "node:fs";
import type { IncomingMessage, Server } from "node:http";
import { toAnthropicErrorBody } from "./errors.js";
import { type Result, ok, err } from "./result.js";
import type { ProxyError } from "./errors.js";
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
      headerTimeoutMs: config.anthropic.headerTimeoutMs,
      streamIdleTimeoutMs: config.anthropic.streamIdleTimeoutMs,
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

/**
 * Base headers for every response the relay generates itself (as opposed to
 * responses proxied verbatim from an upstream).  The `x-subswitch-synthesized`
 * marker is included here so callers cannot forget it and future synthesized
 * response sites are correct by default.
 *
 * Pass extra headers (e.g. `{ connection: "close" }`) as `extra`.
 */
const synthesizedHeaders = (extra: Record<string, string> = {}): Record<string, string> => ({
  "content-type": "application/json",
  "x-subswitch-synthesized": "1",
  ...extra,
});

/** Discriminated error kind returned by acquireSlot when the slot cannot be granted. */
type SlotError = { readonly kind: "queue_full" | "queue_timeout" | "disconnected" };

/**
 * One entry in the byte-based admission queue.
 *
 * `resolve` is called to admit the request (inFlightBytes already incremented by drainQueue).
 * `timer` is the queue-wait timeout handle — cleared on admission or removal.
 */
interface QueueEntry {
  readonly reservationBytes: number;
  readonly resolve: () => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export const createProxyServer = (deps: ServerDeps): Server => {
  const { config, logger } = deps;

  // ---------------------------------------------------------------------------
  // Byte-based admission gate
  //
  // Replace the count-based 503 gate with a byte-budget gate that queues instead
  // of rejecting.  Rationale: measured RSS amplification is ~3.3× raw body bytes
  // (~10 MB RSS per 3.01 MB request body), so body bytes is the real resource.
  // Count-based rejection at 32 was ~3× below realistic peak (100 concurrent),
  // causing ordinary traffic to receive errors the origin would not produce.
  //
  // Single-request progress: if a request alone exceeds the budget and the server
  // is otherwise idle (inFlightBytes === 0), it is still admitted — it will be
  // caught by maxBodyBytes if genuinely oversized.
  //
  // Invariant: inFlightBytes ≥ 0 at all times; returns to 0 when all requests
  // complete.  Violated inFlightBytes is corrected defensively (never negative).
  // ---------------------------------------------------------------------------
  let inFlightBytes = 0;
  const queue: QueueEntry[] = [];

  /**
   * Drain queued requests into available budget slots.
   *
   * Called after each reservation is released. Walk the queue front-to-back and
   * admit entries that fit. Stop at the first entry that does not fit — FIFO order
   * is preserved to prevent starvation.
   */
  const drainQueue = (): void => {
    while (queue.length > 0) {
      const next = queue[0]!;
      // Admit if budget is available, or if the server is idle (single-request progress).
      if (inFlightBytes > 0 && inFlightBytes + next.reservationBytes > config.limits.maxInFlightBytes) {
        break;
      }
      queue.shift();
      clearTimeout(next.timer);
      inFlightBytes += next.reservationBytes;
      next.resolve();
    }
  };

  /**
   * Estimate the byte reservation for a request before the body is read.
   *
   * Uses `content-length` when present (capped at maxBodyBytes to prevent
   * inflation from malicious headers).  For POST /v1/messages without
   * content-length (chunked encoding), falls back to maxBodyBytes — the only
   * path that actually buffers the body, so this is a conservative-but-honest
   * estimate that prevents absent content-length from becoming a bypass.
   * Non-buffered requests (non-POST, non-/v1/messages) contribute 0 bytes:
   * they stream through the http.Agent without accumulating in Node.js heap.
   *
   * Chunked-request ceiling (before reconciliation): with the default 32 MiB
   * maxBodyBytes and 2 GiB budget, the flat reservation allows ~64 concurrent
   * chunked /v1/messages requests before the gate starts queueing.  The
   * reconciliation block in dispatch() corrects each reservation to the actual
   * buffered size once bufferBody() returns, so the ceiling only applies during
   * the brief buffering window — not for the full request lifetime.
   */
  const getReservationBytes = (incomingReq: IncomingMessage, pathname: string): number => {
    const contentLength = incomingReq.headers["content-length"];
    if (contentLength !== undefined) {
      const parsed = parseInt(contentLength, 10);
      if (!isNaN(parsed) && parsed >= 0) {
        return Math.min(parsed, config.limits.maxBodyBytes);
      }
    }
    if (incomingReq.method === "POST" && pathname.startsWith("/v1/messages")) {
      return config.limits.maxBodyBytes;
    }
    return 0;
  };

  /**
   * Acquire a byte slot from the budget.
   *
   * Returns `ok(undefined)` immediately when the budget has room and the queue is
   * empty (FIFO: new arrivals do not jump over waiting requests).  Queues the
   * request when the budget is full — the Result resolves ok when the slot opens.
   * Returns err when the queue is full (caller returns 529) or when the client
   * disconnects while queued (kind "disconnected" — caller should silently return).
   *
   * FIFO guarantee: immediate admission is only granted when queue.length === 0.
   * A stream of small requests cannot barge past a large queued request (no
   * starvation-to-529 path).
   */
  const acquireSlot = (req: IncomingMessage, reservationBytes: number): Promise<Result<void, SlotError>> => {
    // Immediate admission: queue empty AND (budget available OR server idle for single-request progress).
    // Checking queue.length === 0 preserves FIFO: new arrivals must join the queue when
    // waiters are already present, preventing starvation of large queued requests.
    if (queue.length === 0 && (inFlightBytes === 0 || inFlightBytes + reservationBytes <= config.limits.maxInFlightBytes)) {
      inFlightBytes += reservationBytes;
      return Promise.resolve(ok(undefined));
    }

    // Queue full — last resort 529.
    if (queue.length >= config.limits.maxQueueDepth) {
      return Promise.resolve(err({ kind: "queue_full" as const }));
    }

    // Queue the request.
    return new Promise<Result<void, SlotError>>((resolve) => {
      // Use a mutable slot reference so both closures can find the entry by identity
      // without a temporal-dead-zone problem.  The slot is filled synchronously before
      // either callback can fire (setTimeout with positive delay, event loop).
      let entrySlot: QueueEntry | undefined;

      const onDisconnect = (): void => {
        if (entrySlot === undefined) return;
        const idx = queue.indexOf(entrySlot);
        if (idx !== -1) {
          queue.splice(idx, 1);
          clearTimeout(entrySlot.timer);
          entrySlot = undefined;
          drainQueue(); // a slot opened — try admitting the next waiter
          resolve(err({ kind: "disconnected" as const }));
        }
      };

      const timer = setTimeout(() => {
        if (entrySlot === undefined) return;
        const idx = queue.indexOf(entrySlot);
        if (idx !== -1) {
          queue.splice(idx, 1);
          req.removeListener("close", onDisconnect);
          entrySlot = undefined;
          resolve(err({ kind: "queue_timeout" as const }));
        }
      }, config.limits.maxQueueWaitMs);

      const entry: QueueEntry = {
        reservationBytes,
        resolve: () => {
          req.removeListener("close", onDisconnect);
          entrySlot = undefined;
          resolve(ok(undefined));
        },
        timer,
      };

      entrySlot = entry;
      req.once("close", onDisconnect);
      queue.push(entry);
    });
  };

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
          res.writeHead(200, synthesizedHeaders());
          res.end(buildHealthBody(config));
          return;
        }
        res.writeHead(404, synthesizedHeaders());
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }

      // Byte-based admission gate.
      // Checked here (after /__subswitch/* is handled above) so health checks are never gated.
      // Requests that exceed the in-flight budget are QUEUED, not rejected — a relay-invented
      // rejection that the origin would not have produced is a defect.
      // If the queue itself is full, HTTP 529 overloaded_error is the correct Anthropic status.
      //
      // `reservationBytes` is a `let` so chunked requests can be reconciled to their actual
      // size after bufferBody completes (see reconciliation block below).  The releaseSlot
      // closure captures the binding, so updating the variable updates what it decrements.
      let reservationBytes = getReservationBytes(req, pathname);
      const slotResult = await acquireSlot(req, reservationBytes);
      if (!slotResult.ok) {
        if (slotResult.error.kind === "disconnected") {
          // Client disconnected while waiting in queue — nothing to send, clean exit.
          // Set route to a sentinel value so request_complete does not log a spurious
          // "anthropic / status 200" for a request that was never served.
          route = "disconnected_while_queued";
          return;
        }
        // Queue full or queue timeout — 529 overloaded_error (not 503, per Anthropic taxonomy).
        route = "rate_limited";
        res.writeHead(529, synthesizedHeaders());
        res.end(toAnthropicErrorBody("overloaded_error", "server overloaded — too many concurrent requests, try again shortly"));
        return;
      }
      // Release reservation when the response is done.
      //
      // Use "finish" (data fully flushed to the OS) rather than "close" (socket dropped):
      // with HTTP/1.1 keep-alive the socket may stay open long after the response is sent,
      // so "close" would hold the reservation far longer than necessary. "finish" fires as
      // soon as res.end() flushes, which is when the buffered body is no longer needed.
      //
      // Also listen on "close" as a safety net: if the client drops before "finish" fires
      // (e.g. mid-stream abort), "close" ensures the reservation is still released.
      let released = false;
      const releaseSlot = (): void => {
        if (released) return;
        released = true;
        const delta = inFlightBytes - reservationBytes;
        if (delta < 0) {
          // A negative delta indicates a double-release or mismatched acquire/release pair.
          // We log rather than throw: crashing a running relay on an accounting slip is worse
          // than the slip itself; the clamp keeps the counter non-negative.  Operators should
          // treat this as a bug-level event requiring investigation.
          logger.log("error", "inFlightBytes_underflow", { inFlightBytes, reservationBytes });
        }
        inFlightBytes = Math.max(0, delta);
        drainQueue();
      };
      res.once("finish", releaseSlot);
      res.once("close", releaseSlot);

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
          res.writeHead(413, synthesizedHeaders({ connection: "close" }));
          res.end(toAnthropicErrorBody("request_too_large", body.error.message));
          req.destroy();
        }
        return;
      }

      // Chunked-reservation reconciliation (Required 5 / FIFO / starvation mitigation):
      //
      // For chunked POST /v1/messages (no content-length header), getReservationBytes
      // reserved config.limits.maxBodyBytes (e.g. 32 MiB) as a conservative estimate to
      // prevent absent content-length from becoming a bypass.  Now that bufferBody has
      // returned we know the actual size.
      //
      // Holding the full 32 MiB reservation until response completion limits the effective
      // concurrency for chunked requests: 2 GiB budget ÷ 32 MiB/slot = ~64 concurrent
      // chunked requests, below the ~100 peak stated in the budget rationale.  Reconciling
      // to the actual size frees the excess immediately so subsequent requests queue less
      // aggressively.
      //
      // Safety: `reservationBytes` is a `let` declared before releaseSlot (same dispatch()
      // scope).  releaseSlot captures the binding, so updating it here changes what it
      // decrements.  Correctness: inFlightBytes already holds the original flat reservation;
      // subtracting (reservationBytes - actual) keeps inFlightBytes = Σ actual reservations.
      // The reconciled actual can never underflow: inFlightBytes ≥ reservationBytes (we
      // reserved it) and actual ≥ 0, so inFlightBytes - (reservationBytes - actual) ≥ actual ≥ 0.
      if (req.headers["content-length"] === undefined) {
        const actual = body.value.length;
        if (actual < reservationBytes) {
          inFlightBytes -= reservationBytes - actual;
          reservationBytes = actual;
          drainQueue(); // reduced budget may now admit a waiting request
        }
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
          // Two providers claim the same family name. Reject with 400 naming both.
          route = "ambiguous";
          logger.log("warn", "ambiguous_model_name", { model: decision.name });
          res.writeHead(400, synthesizedHeaders());
          res.end(
            toAnthropicErrorBody(
              "invalid_request_error",
              `model '${decision.name}' is claimed by multiple providers: ${decision.providers.join(", ")} — qualify with provider:name (e.g. codex:${decision.name})`,
            ),
          );
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
      logger.log("error", "request_failed", { path: pathname, errorCode: cause instanceof Error ? cause.name : "unknown" });
      if (!res.headersSent) {
        res.writeHead(500, synthesizedHeaders());
        res.end(toAnthropicErrorBody("api_error", "internal proxy error"));
      } else if (!res.writableEnded) {
        res.destroy();
      }
    });
  });
};
