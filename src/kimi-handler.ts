/**
 * The Kimi leg: Claude Code Messages requests to the Kimi coding Messages endpoint, on the
 * shared translated-leg runner.
 *
 * Kimi gets only the Kimi bearer, the fixed Subswitch identity headers and the protocol
 * headers. No client header reaches Kimi, so the client's own sign-in and beta values
 * stay on this side. A Kimi failure gets a fixed reply. The leg has no fallback route.
 */
import { randomUUID } from "node:crypto";
import { AnthropicRequestSchema } from "./anthropic-wire-types.js";
import { aggregateFrames } from "./codex-response.js";
import { estimateTokens } from "./codex-request.js";
import type { KimiProviderConfig } from "./config.js";
import { deriveConversationKey } from "./conversation-key.js";
import { upstreamStatusToAnthropicError } from "./errors.js";
import { kimiIdentityHeaders } from "./kimi-constants.js";
import type { KimiAuth } from "./kimi-native-auth.js";
import { buildKimiRequest, isKimiThinkingBlock, type KimiThinkingBlock } from "./kimi-request.js";
import { createKimiSseTranslator, KIMI_REPLY_ERRORS } from "./kimi-stream.js";
import type { Logger } from "./logger.js";
import type { ProviderCredential } from "./provider-auth.js";
import { KIMI_EVENTS } from "./provider-events.js";
import type { ProviderHandler } from "./provider-handler.js";
import { respondJson, respondProxyError } from "./provider-transport.js";
import type { ReasoningCache } from "./reasoning-cache.js";
import { runTranslatedLeg } from "./translated-leg.js";

export interface KimiHandlerDeps {
  readonly provider: KimiProviderConfig;
  readonly logger: Logger;
  readonly auth: KimiAuth;
  /** The Kimi thinking of each tool turn, for the replay to Kimi only. */
  readonly cache: ReasoningCache;
  readonly fetchImpl: typeof fetch;
}

const ANTHROPIC_VERSION = "2023-06-01";
/**
 * The anthropic-beta values that Kimi gets. The list starts empty. A value joins it only
 * after a live check on Kimi. A client beta value never reaches Kimi.
 */
const KIMI_ANTHROPIC_BETA: readonly string[] = [];
const RETRY_AFTER = /^\d{1,6}$/;

const kimiHeaders = (deviceId: string, credential: ProviderCredential<"kimi">): Record<string, string> => ({
  ...kimiIdentityHeaders(deviceId),
  authorization: credential.authHeaders["authorization"] ?? "",
  "content-type": "application/json",
  accept: "text/event-stream",
  "anthropic-version": ANTHROPIC_VERSION,
  ...(KIMI_ANTHROPIC_BETA.length > 0 ? { "anthropic-beta": KIMI_ANTHROPIC_BETA.join(",") } : {}),
});

/** A fixed reply for each status. The Kimi body is not read into the reply. Only a retry-after of digits passes. */
const renderUpstreamError = (status: number, _detail: string, headers: Headers) => {
  const mapped = upstreamStatusToAnthropicError(status);
  const retryAfter = headers.get("retry-after");
  return {
    ...mapped, message: KIMI_REPLY_ERRORS[mapped.type],
    headers: retryAfter !== null && RETRY_AFTER.test(retryAfter) ? { "retry-after": retryAfter } : {},
  };
};

export const createKimiHandler = (deps: KimiHandlerDeps): ProviderHandler => {
  const { provider, logger, auth, cache, fetchImpl } = deps;
  // The base URL of the Kimi CLI ends in /coding/v1, so the Messages path adds no /v1.
  const url = `${provider.baseUrl.replace(/\/+$/, "")}/messages?beta=true`;
  const getThinking = (key: string): readonly KimiThinkingBlock[] | undefined => {
    const blocks = cache.get(key);
    return blocks?.every(isKimiThinkingBlock) === true ? blocks : undefined;
  };
  const putThinking = (key: string, blocks: readonly KimiThinkingBlock[]): void => cache.put(key, blocks);

  return {
    async handleMessages(_req, res, _rawBody, parsedBody, canonicalModel) {
      const parsed = AnthropicRequestSchema.safeParse(parsedBody);
      if (!parsed.success) {
        respondProxyError(res, { kind: "translate", message: "request body is not a valid messages request" });
        return;
      }
      const request = { ...parsed.data, model: canonicalModel };
      const model = parsed.data.model;
      const conversationKey = deriveConversationKey(request);
      const body = buildKimiRequest(request, { model: canonicalModel, getThinking, ...(conversationKey === undefined ? {} : { conversationKey }) });

      let diagnostics: ReturnType<typeof createKimiSseTranslator>["diagnostics"] | undefined;
      await runTranslatedLeg(res, {
        url, name: "Kimi", model, body, wantStream: request.stream === true,
        requestTimeoutMs: provider.requestTimeoutMs, streamIdleTimeoutMs: provider.streamIdleTimeoutMs,
        maxAggregateBytes: provider.maxAggregateBytes, logger, events: KIMI_EVENTS, auth, fetchImpl,
        redirect: "error", abortOnResponseTimeout: true,
        buildHeaders: (credential) => kimiHeaders(auth.deviceId, credential),
        renderUpstreamError,
        renderJsonResponse: () => ({ status: 502, type: "api_error", message: "Kimi returned a JSON reply to a stream request." }),
        createTranslator: () => {
          const stream = createKimiSseTranslator({
            model: canonicalModel, seed: randomUUID(), maxEventBytes: provider.maxSseEventBytes,
            maxTurnBytes: provider.reasoningCache.maxTurnBytes, conversationKey, putThinking,
          });
          diagnostics = stream.diagnostics;
          return stream;
        },
        aggregateFrames: (frames) => aggregateFrames(frames, "kimi"),
      });
      for (const warning of diagnostics?.().warnings ?? []) logger.log("warn", KIMI_EVENTS.translateWarning, { model, errorCode: warning });
    },
    handleCountTokens(_req, res, rawBody) {
      respondJson(res, 200, JSON.stringify({ input_tokens: estimateTokens(rawBody) }));
    },
  };
};
