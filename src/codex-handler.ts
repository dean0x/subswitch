import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { upstreamStatusToAnthropicError, toAnthropicErrorBody } from "./errors.js";
import { respondJson, respondProxyError } from "./provider-transport.js";
import { codexCredentialFor, type CodexProviderConfig, type CredentialKindTable } from "./config.js";
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
import type { LimitContext } from "./limit-observation.js";
import { runTranslatedLeg } from "./translated-leg.js";

const CODEX_LIMIT_KEY: LimitContext = { provider: "codex", product: "chatgpt-codex", protocol: "responses" };

const AUTH_HINT: CredentialKindTable<string> = {
  "oauth-file": ({ loginCommand }) => ` — run \`${loginCommand}\``,
};

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
 * because another provider's config need not match `CodexProviderConfig`. The handler
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
  /** Login command from the provider accessor, for the 401 hint. */
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

export const codexTransportConstants = (userAgent: string): CodexTransportConstants => ({
  "openai-beta": "responses=experimental", originator: "codex_cli_rs", accept: "text/event-stream",
  "content-type": "application/json", "user-agent": userAgent,
});

export const createCodexHandler = <P extends ProviderId>(deps: CodexHandlerDeps<P>): ProviderHandler => {
  const { providerId, provider, logger, auth, cache, pingIntervalMs } = deps;
  const source = codexCredentialFor(provider, deps.loginCommand);
  const authHint = AUTH_HINT[source.kind](source);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const newSessionId = deps.newSessionId ?? randomUUID;
  // Event names resolved once here, not per request: the hot path does no string work,
  // and there is exactly one place to audit that every name comes from `providerId`.
  const events = providerEvents(providerId);
  const responsesUrl = `${provider.baseUrl.replace(/\/$/, "")}/responses`;
  // Built once per handler instance — values are fixed for the lifetime of this provider
  // slice, so there is no reason to rebuild on every request. (avoids PF-005)
  const transportConstants = codexTransportConstants(provider.userAgent);

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

    await runTranslatedLeg(res, {
      url: responsesUrl,
      name: providerId,
      model,
      body: translated.value.body,
      wantStream: translated.value.stream,
      requestTimeoutMs: provider.requestTimeoutMs,
      streamIdleTimeoutMs: provider.streamIdleTimeoutMs,
      maxAggregateBytes: provider.maxAggregateBytes,
      logger,
      events,
      auth,
      fetchImpl,
      redirect: "follow",
      buildHeaders: (credential) => buildHeaders(credential, sessionId, transportConstants),
      limitKey: CODEX_LIMIT_KEY,
      renderUpstreamError: (status, detail, headers) => {
        const retryAfter = headers.get("retry-after");
        const remediation = status === 401 ? authHint : "";
        return {
          ...upstreamStatusToAnthropicError(status),
          message: `${providerId} upstream error (${status})${detail === "" ? "" : `: ${detail}`}${remediation}`,
          ...(retryAfter !== null ? { headers: { "retry-after": retryAfter } } : {}),
        };
      },
      createTranslator: () => ({
        parser: createSseParser(provider.maxSseEventBytes),
        translator: createAnthropicSseTranslator({
          // Use the canonical model when the upstream response omits it.
          model: request.model,
          logger,
          providerId,
          onReasoningItems: (callId, items) => cache.put(callId, items),
          ...(conversationKey !== undefined ? { conversationKey } : {}),
          ...(translated.value.stream ? { pingIntervalMs } : {}),
        }),
      }),
      aggregateFrames: (frames) => aggregateFrames(frames, providerId),
    });
  };

  const handleCountTokens = (_req: IncomingMessage, res: ServerResponse, rawBody: Buffer): void => {
    respondJson(res, 200, JSON.stringify({ input_tokens: estimateTokens(rawBody) }));
  };

  return { handleMessages, handleCountTokens };
};
