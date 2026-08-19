import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { upstreamStatusToAnthropicError, toAnthropicErrorBody, toAnthropicErrorSse } from "./errors.js";
import { respondJson, respondProxyError, readBoundedText, createFrameWriter } from "./provider-transport.js";
import type { CodexProviderConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { providerEvents } from "./provider-events.js";
import type { ProviderId } from "./models.js";
import type { ProviderAuth, ProviderCredential } from "./provider-auth.js";
import type { ProviderHandler } from "./provider-handler.js";
import type { ReasoningCache } from "./reasoning-cache.js";
import { estimateTokens, translateRequest } from "./codex-request.js";
import { deriveConversationKey } from "./conversation-key.js";
import { aggregateFrames, createAnthropicSseTranslator, createSseParser } from "./codex-response.js";
import { AnthropicRequestSchema } from "./anthropic-wire-types.js";

const ERROR_BODY_PEEK_BYTES = 2048;

/**
 * `P` ties `providerId` to `auth`, and that is all it does.
 *
 * `providerId: P` fixes the type; `auth: ProviderAuth<P>` must match — a compile
 * error prevents wiring provider X's handler with provider Y's credential at the
 * wiring site. Without `P`, the two fields would be independently typed and the
 * compiler could not correlate them.
 *
 * `provider: CodexProviderConfig` is intentionally NOT parameterised by `P`.
 * Expressing it as `Config["providers"][P]` would compile today only because
 * `ProviderId` is a single-member union; it would break when a second provider lands,
 * because `Config["providers"]["kimi"]` is not `CodexProviderConfig`. The handler
 * works with the concrete Codex config slice — hardcoding the type is honest about
 * what the code does.
 *
 * Codex-specific notes on the `handleMessages` contract (see also `ProviderHandler`):
 * - `rawBody` is provided for interface completeness; Codex currently uses it only via
 *   `estimateTokens` in `handleCountTokens`, not in `handleMessages`.
 * - `canonicalModel` is the resolved canonical id (never an alias) so that
 *   `deriveConversationKey` and `translateRequest` both see the same stable id.
 *   Callers resolve once before routing (applies ADR-005).
 */
export interface CodexHandlerDeps<P extends ProviderId> {
  /**
   * This provider's identity. Required, and drawn from the closed `ProviderId` union
   * — deliberately NOT an optional `providerName?: string` carrying a `"codex"` default.
   *
   * An optional-with-a-default form parameterizes nothing: no caller has to think about
   * it, so every path resolves to the default and nothing downstream is ever exercised
   * with a real second value. Required means a second provider physically cannot forget
   * to pass one, and closed-union means the value is safe to derive log event names from
   * (see `provider-events.ts` — the event token is a log-injection surface).
   */
  readonly providerId: P;
  /**
   * This provider's own config slice — NOT the whole `Config`. The handler cannot
   * reach another provider's credentials, base URL, or aliases, and cannot read
   * global settings that were never meant to be per-provider.
   */
  readonly provider: CodexProviderConfig;
  /**
   * Shell command the user must run to obtain or refresh this provider's credential.
   * Read from `providerConfigFor(config, id).loginCommand` at the wiring site.
   *
   * Cannot be synthesised from `providerId`: a provider whose id is "kimi" may well
   * log in with "kimi auth login", not "kimi login". The field must carry the
   * hand-written value from the config accessor table (src/config.ts:PROVIDER_CONFIG_ACCESSORS).
   * It is not user-settable — it is absent from the Zod schema.
   */
  readonly loginCommand: string;
  /** The one cross-cutting limit this handler reads; everything else comes from `provider`. */
  readonly pingIntervalMs: number;
  readonly logger: Logger;
  /**
   * This provider's credential source, branded with this provider's id.
   *
   * `auth` and `providerId` share one type parameter, so `P` is inferred from the id
   * and the credential must agree with it: handing provider X's handler provider Y's
   * `ProviderAuth` is a compile error at the wiring site, which is where the mistake
   * gets made. Nothing downstream re-checks — the outbound request cannot be built from
   * a credential the type system has not already tied to this leg. (applies ADR-002)
   */
  readonly auth: ProviderAuth<P>;
  readonly cache: ReasoningCache;
  readonly fetchImpl?: typeof fetch;
  readonly newSessionId?: () => string;
}

/**
 * The set of non-credential, non-session transport headers appended on every Codex
 * /responses request. Values are compile-time constants except `user-agent`, which
 * comes from provider config so deployments can report a meaningful client identifier.
 *
 * All names are lowercase because `buildHeaders` passes them directly to `put()`,
 * which lowercases both sides of the owned-Set check; using lowercase literals here
 * keeps the intent explicit and avoids any ambiguity at the call site.
 */
export interface CodexTransportConstants {
  readonly "openai-beta": string;
  readonly originator: string;
  readonly accept: string;
  readonly "content-type": string;
  readonly "user-agent": string;
}

/**
 * Build the outgoing header record for a Codex /responses request.
 *
 * Pure: no side effects, no closure captures. Credential headers land first so auth
 * appears before transport constants on the wire, then protocol constants in the
 * live-verified order, then the provider user-agent.
 *
 * Owned-set guard: both sides of the collision check are lowercased so a credential
 * returning "User-Agent" (capital) and our put("user-agent", …) are correctly
 * identified as the same name — exactly one key is emitted, the credential wins, and
 * undici never comma-joins a duplicate pair into a malformed value. (avoids PF-005)
 *
 * Assumption at the spread site: `credential.authHeaders` contains no two keys that
 * differ only in case. If it did, the spread would carry both past the owned guard and
 * undici would comma-join them into one malformed value. (avoids PF-005, REGR-05)
 *
 * PF-005 scope: PF-005 forbids using the e2e/README.md wrong-transport capture table
 * to change header NAMES or VALUES. It does NOT govern ORDER.
 */
export const buildHeaders = <P extends ProviderId>(
  credential: ProviderCredential<P>,
  sessionId: string,
  transportConstants: CodexTransportConstants,
): Record<string, string> => {
  // Seed from credential so auth headers land first on the wire. Assumption: no two
  // keys in credential.authHeaders differ only in case — if they did, the spread
  // would carry both and the put() guard below would not catch them (it only guards
  // against collisions between credential names and transport constant names).
  const headers: Record<string, string> = { ...credential.authHeaders };
  const owned = new Set(Object.keys(credential.authHeaders).map((k) => k.toLowerCase()));
  // Both sides lowercased so the guard holds for any credential, including one that
  // returns mixed-case names (e.g. "User-Agent"). The put() call sites use lowercase
  // literals, but the lowercase here is what makes the guard semantically correct —
  // without it, owned.has("user-agent") would miss a credential-supplied "User-Agent".
  const put = (name: string, value: string): void => {
    if (!owned.has(name.toLowerCase())) headers[name] = value;
  };
  put("openai-beta", transportConstants["openai-beta"]);
  put("originator", transportConstants.originator);
  put("session_id", sessionId);
  put("accept", transportConstants.accept);
  put("content-type", transportConstants["content-type"]);
  put("user-agent", transportConstants["user-agent"]);
  return headers;
};

export const createCodexHandler = <P extends ProviderId>(deps: CodexHandlerDeps<P>): ProviderHandler => {
  const { providerId, provider, logger, auth, cache, pingIntervalMs, loginCommand } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const newSessionId = deps.newSessionId ?? randomUUID;
  // Event names resolved once here, not per request: the hot path does no string work,
  // and there is exactly one place to audit that every name comes from `providerId`.
  const events = providerEvents(providerId);
  const responsesUrl = `${provider.baseUrl.replace(/\/$/, "")}/responses`;
  // Built once per handler instance — values are fixed for the lifetime of this provider
  // slice, so there is no reason to rebuild on every request. (avoids PF-005)
  const transportConstants: CodexTransportConstants = {
    "openai-beta": "responses=experimental",
    originator: "codex_cli_rs",
    accept: "text/event-stream",
    "content-type": "application/json",
    "user-agent": provider.userAgent,
  };

  const handleMessages = async (_req: IncomingMessage, res: ServerResponse, _rawBody: Buffer, parsedBody: unknown, canonicalModel: string): Promise<void> => {
    // parsedBody is pre-parsed by the server (JSON.parse called once at the request level).
    // The handler must not call JSON.parse again — that would violate the P4 contract.
    const parsed = AnthropicRequestSchema.safeParse(parsedBody);
    if (!parsed.success) {
      respondJson(res, 400, toAnthropicErrorBody("invalid_request_error", "request body is not a valid messages request"));
      return;
    }
    // Keep the as-requested model name for log sites — users grep for what they typed.
    const model = parsed.data.model;

    // Substitute the canonical id so that deriveConversationKey and translateRequest
    // both see a stable, alias-free model string. When the inbound model is already
    // canonical this is a no-op spread that preserves Zod passthrough keys. (applies ADR-005)
    const request = canonicalModel === parsed.data.model
      ? parsed.data
      : { ...parsed.data, model: canonicalModel };

    // Derive the conversation key from the canonical request (not builder output,
    // which may be a translated developer-role message for subagents per PF-003).
    // The canonical model in `request` ensures alias and canonical produce the same key,
    // which is the critical Phase B invariant — same session_id and prompt_cache_key.
    const conversationKey = deriveConversationKey(request);
    // session_id is stable per conversation; falls back to a random UUID when no
    // user message is present. The same id is reused on the 401-refresh retry
    // below (sessionId is captured once before the loop). [applies ADR-003]
    const sessionId = conversationKey ?? newSessionId();

    const translated = translateRequest(request, cache, conversationKey);
    if (!translated.ok) {
      respondProxyError(res, translated.error);
      return;
    }
    for (const warning of translated.value.warnings) {
      logger.log("warn", events.translateWarning, { model, errorCode: warning });
    }
    if (translated.value.effort !== undefined) {
      logger.log("info", events.effortApplied, { model, effort: translated.value.effort });
    }

    // RELI-04: construct the controller, total-timer, and close-listener BEFORE calling
    // auth.getCredentials() so credential loading shares the request's lifetime. Without
    // this, a hung getCredentials() (e.g., from a single-flight refresh on a slow OAuth
    // endpoint) runs outside every bound the handler establishes: the client-close signal
    // is not wired up yet, the total timer has not started, and cleanup never runs if
    // getCredentials() returns an error.  With the controller set up here, getCredentials()
    // is covered by both the close listener and the requestTimeoutMs total timer, and the
    // finally{} block's cleanup() runs on every exit path including credential failure.
    //
    // Note: sessionId is still derived ABOVE this block (before the retry loop), so the
    // ADR-003 invariant is preserved — both the initial attempt and the 401-refresh retry
    // reuse the same sessionId value.
    const controller = new AbortController();
    const onClientClose = (): void => {
      if (!res.writableFinished) controller.abort();
    };
    res.on("close", onClientClose);
    const totalTimer = setTimeout(() => controller.abort(), provider.requestTimeoutMs);
    totalTimer.unref();

    let idleTimer: NodeJS.Timeout | undefined;
    const resetIdle = (): void => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(), provider.streamIdleTimeoutMs);
      idleTimer.unref();
    };
    const cleanup = (): void => {
      clearTimeout(totalTimer);
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      res.off("close", onClientClose);
    };

    try {
      const credentialResult = await auth.getCredentials();
      if (!credentialResult.ok) {
        respondProxyError(res, credentialResult.error);
        return;
      }
      let credential = credentialResult.value;
      let upstream: Response | undefined;
      // Bounded retry: the initial attempt, plus one more only if the credential can
      // actually be refreshed. A provider whose credential is static gets a single
      // attempt so its truthful 401 reaches the client instead of a refresh error.
      const maxAttempts = auth.refreshable ? 2 : 1;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        let response: Response;
        try {
          response = await fetchImpl(responsesUrl, {
            method: "POST",
            headers: buildHeaders(credential, sessionId, transportConstants),
            body: JSON.stringify(translated.value.body),
            signal: controller.signal,
          });
        } catch {
          if (res.writableEnded || res.destroyed) return;
          respondProxyError(
            res,
            controller.signal.aborted
              ? { kind: "timeout", message: `${providerId} request timed out` }
              : { kind: "upstream", message: `${providerId} upstream unreachable` },
          );
          return;
        }
        // Refresh only while the budget still has an attempt left to spend it on.
        // Refreshing on the last permitted attempt would renew a static provider's
        // credential behind its back and replace the upstream's truthful 401 with a
        // synthesised refresh failure.
        if (response.status === 401 && attempt + 1 < maxAttempts) {
          logger.log("warn", events.upstream401Refreshing, { model });
          await response.body?.cancel().catch(() => undefined);
          const refreshed = await auth.forceRefresh();
          if (!refreshed.ok) {
            respondProxyError(res, refreshed.error);
            return;
          }
          credential = refreshed.value;
          continue;
        }
        upstream = response;
        break;
      }
      // INVARIANT, not an error path. Every attempt either returns from this function or
      // assigns `upstream`, except the one that refreshes — and that one is gated on
      // `attempt + 1 < maxAttempts`, so it cannot fire on the last permitted attempt.
      // With `refreshable: boolean`, `maxAttempts` is 1 or 2 and the loop therefore always
      // leaves through `upstream = response`. Reaching here means the bound and the guard
      // have drifted apart in a later edit: a programming error, not an upstream or
      // credential condition, and it must not be dressed up as one.
      //
      // Kept as an assertion rather than deleted because `tsc` cannot prove `maxAttempts
      // >= 1`; deleting the check needs `upstream!`, which converts that same drift into
      // an opaque TypeError on `.ok`. Reported through the normal response path rather
      // than thrown — business logic returns, it does not throw — and logged under its own
      // derived event name so it is greppable and can never be read as a 401.
      if (upstream === undefined) {
        logger.log("error", events.retryBoundViolated, { model });
        respondJson(res, 500, toAnthropicErrorBody("api_error", `${providerId} internal error`));
        return;
      }

      if (!upstream.ok) {
        const mapped = upstreamStatusToAnthropicError(upstream.status);
        const detail = await readBoundedText(upstream.body, ERROR_BODY_PEEK_BYTES);
        logger.log("warn", events.upstreamError, { model, status: upstream.status });
        const retryAfter = upstream.headers.get("retry-after");
        // Only 401s get a remediation hint — no other status code changes behaviour.
        // The error-type prefix ("${providerId} upstream error") is preserved so the
        // pattern /codex upstream error/ continues to match. The full string is not a
        // strict prefix because redactCredentials may rewrite the interior. (applies ADR-008)
        const remediation = upstream.status === 401 ? ` — run \`${loginCommand}\`` : "";
        respondJson(
          res,
          mapped.status,
          toAnthropicErrorBody(mapped.type, `${providerId} upstream error (${upstream.status})${detail === "" ? "" : `: ${detail}`}${remediation}`),
          retryAfter !== null ? { "retry-after": retryAfter } : {},
        );
        return;
      }

      if (upstream.body === null) {
        respondProxyError(res, { kind: "upstream", message: `${providerId} upstream returned an empty body` });
        return;
      }

      const wantStream = translated.value.stream;
      const parser = createSseParser(provider.maxSseEventBytes);
      const translator = createAnthropicSseTranslator({
        // Use the canonical model as the fallback for message_start (options.model)
        // so clients see the canonical id even when the upstream omits model in response.created.
        model: request.model,
        logger,
        providerId,
        onReasoningItems: (callId, items) => cache.put(callId, items),
        ...(conversationKey !== undefined ? { conversationKey } : {}),
        ...(wantStream ? { pingIntervalMs } : {}),
      });
      const bodyStream = Readable.fromWeb(upstream.body as WebReadableStream<Uint8Array>);
      bodyStream.on("data", resetIdle);
      resetIdle();

      if (wantStream) {
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", "x-subswitch-synthesized": "1" });
        res.socket?.setNoDelay(true);
        // res is written manually rather than placed inside pipeline(): on an
        // upstream error, pipeline destroys every stream it owns, which would
        // kill the client connection before the error SSE event can be sent.
        //
        // writeFrame races the drain wait against controller.signal so a client
        // that stops reading without closing cannot hold the connection open past
        // requestTimeoutMs. Project rule: every resource must have an explicit bound.
        const writeFrame = createFrameWriter(res, controller.signal);
        try {
          await pipeline(bodyStream, parser, translator, async (source) => {
            for await (const chunk of source) await writeFrame(String(chunk));
          });
          res.end();
        } catch {
          // Mid-stream failure after message_start: emit an error event, never retry.
          logger.log("warn", events.streamInterrupted, { model });
          if (!res.writableEnded && !res.destroyed) {
            res.write(toAnthropicErrorSse("api_error", `${providerId} stream interrupted`));
            res.end();
          }
        }
        return;
      }

      const frames: string[] = [];
      let framesBytes = 0;
      try {
        await pipeline(bodyStream, parser, translator, async (source) => {
          for await (const chunk of source) {
            const frame = String(chunk);
            framesBytes += frame.length;
            // RELI-06: bound the accumulation buffer before aggregateFrames materialises
            // the turn. Every other buffer on this path is bounded (maxEventBytes,
            // maxBodyBytes, MAX_CONTENT_BLOCKS); this is the one that was not.
            // Exceeding the cap is reported as a pipeline failure — the same 502
            // "stream interrupted" shape as any other midstream abort. We must never
            // pass a truncated frames array to aggregateFrames, which would produce a
            // silent 200 with empty content (avoids PF-008).
            if (framesBytes > provider.maxAggregateBytes) {
              throw new Error("sse_aggregate_too_large");
            }
            frames.push(frame);
          }
        });
      } catch {
        respondProxyError(res, { kind: "upstream", message: `${providerId} stream interrupted` });
        return;
      }
      const aggregated = aggregateFrames(frames, providerId);
      if (!aggregated.ok) {
        respondProxyError(res, aggregated.error);
        return;
      }
      if (aggregated.value.kind === "error") {
        respondJson(res, 502, toAnthropicErrorBody(aggregated.value.errorType, aggregated.value.message));
        return;
      }
      respondJson(res, 200, JSON.stringify(aggregated.value.message));
    } finally {
      cleanup();
    }
  };

  const handleCountTokens = (_req: IncomingMessage, res: ServerResponse, rawBody: Buffer): void => {
    respondJson(res, 200, JSON.stringify({ input_tokens: estimateTokens(rawBody) }));
  };

  return { handleMessages, handleCountTokens };
};
