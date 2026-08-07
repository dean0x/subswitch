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
import type { ReasoningCache } from "./reasoning-cache.js";
import { estimateTokens, translateRequest } from "./codex-request.js";
import { deriveConversationKey } from "./conversation-key.js";
import { aggregateFrames, createAnthropicSseTranslator, createSseParser } from "./codex-response.js";
import { AnthropicRequestSchema } from "./anthropic-wire-types.js";

const ERROR_BODY_PEEK_BYTES = 2048;

/**
 * `P` is the provider this handler speaks for, and it is one type parameter rather than
 * two independent fields on purpose: `providerId` fixes it and `auth` must then match.
 * A type parameter that constrained only `providerId` would be ceremony; it earns its
 * place precisely because a second field is checked against it.
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

export interface CodexHandler {
  /**
   * Handle a /v1/messages request.
   *
   * `parsed` is the body already JSON-parsed by the server (JSON.parse is called
   * exactly once per request — the P4 contract). The handler applies its own schema
   * to `parsed` without re-parsing `rawBody`.
   *
   * `rawBody` is still provided for providers that forward it untouched and for
   * `estimateTokens` (rawBody.length). Codex currently uses neither in this method.
   *
   * `canonicalModel` is the resolved canonical id (never an alias) so that
   * `deriveConversationKey` and `translateRequest` both see the same stable id.
   * Callers resolve once before routing (applies ADR-005).
   */
  handleMessages(req: IncomingMessage, res: ServerResponse, rawBody: Buffer, parsed: unknown, canonicalModel: string): Promise<void>;
  handleCountTokens(req: IncomingMessage, res: ServerResponse, rawBody: Buffer): void;
}

export const createCodexHandler = <P extends ProviderId>(deps: CodexHandlerDeps<P>): CodexHandler => {
  const { providerId, provider, logger, auth, cache, pingIntervalMs, loginCommand } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const newSessionId = deps.newSessionId ?? randomUUID;
  // Event names resolved once here, not per request: the hot path does no string work,
  // and there is exactly one place to audit that every name comes from `providerId`.
  const events = providerEvents(providerId);
  const responsesUrl = `${provider.baseUrl.replace(/\/$/, "")}/responses`;

  const buildHeaders = (credential: ProviderCredential<P>, sessionId: string): Record<string, string> => {
    // Seed from the credential so its headers (authorization, chatgpt-account-id) land
    // first. Transport constants follow via put(), which refuses any name the credential
    // already owns — comparison is lowercased so a credential returning "User-Agent" and
    // our put("user-agent", …) collide: the credential wins and exactly one key is
    // emitted, never a comma-joined pair that the server would reject.
    //
    // This is regression avoidance, not fingerprint parity. Parity is unreachable:
    // undici injects accept-language and sec-fetch-mode that a Rust reqwest client never
    // sends; no application-layer reordering closes that gap.
    //
    // PF-005 scope: PF-005 forbids using the e2e/README.md wrong-transport capture table
    // to change header NAMES or VALUES. It does NOT govern ORDER. Restoring a
    // previously-live-verified order is not a PF-005 violation.
    //
    // Both orders have been observed working against the live backend: the pre-fix build
    // (auth headers at tail) returned HTTP 200 with a well-formed SSE stream and a usage
    // object on 2026-08-07. Restoring auth-first is precautionary — it returns this leg to
    // the configuration live-verified in the b337a75 era and hedges against upstream
    // fingerprinting changes. It is not fixing an observed failure. The substantive
    // correctness fix in this block is the owned shadowing guard, not the ordering. (avoids PF-005)
    const headers: Record<string, string> = { ...credential.authHeaders };
    const owned = new Set(Object.keys(credential.authHeaders).map((k) => k.toLowerCase()));
    // Both sides of the comparison are lowercased so the guard holds for any caller, not
    // only for callers that remembered the convention. All six call sites below already
    // pass lowercase literals, so `name.toLowerCase()` is a no-op today and no test
    // exercises a mixed-case name — it is here so that a future `put("Content-Type", …)`
    // cannot silently reopen the duplicate-header hole that U1.3 pins.
    const put = (name: string, value: string): void => {
      if (!owned.has(name.toLowerCase())) headers[name] = value;
    };
    put("openai-beta", "responses=experimental");
    put("originator", "codex_cli_rs");
    put("session_id", sessionId);
    put("accept", "text/event-stream");
    put("content-type", "application/json");
    put("user-agent", provider.userAgent);
    return headers;
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

    const credentialResult = await auth.getCredentials();
    if (!credentialResult.ok) {
      respondProxyError(res, credentialResult.error);
      return;
    }
    let credential = credentialResult.value;

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
            headers: buildHeaders(credential, sessionId),
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
        // The existing message remains a strict prefix of the new one so existing
        // pattern matches (/codex upstream error/) continue to work unchanged.
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
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
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
      try {
        await pipeline(bodyStream, parser, translator, async (source) => {
          for await (const chunk of source) frames.push(String(chunk));
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
