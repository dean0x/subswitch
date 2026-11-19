import { randomUUID } from "node:crypto";
import { AnthropicRequestSchema } from "./anthropic-wire-types.js";
import { aggregateFrames } from "./codex-response.js";
import { estimateTokens } from "./codex-request.js";
import type { TogetherProviderConfig } from "./config.js";
import { deriveConversationKey } from "./conversation-key.js";
import { upstreamStatusToAnthropicError } from "./errors.js";
import type { Logger } from "./logger.js";
import type { ProviderAuth } from "./provider-auth.js";
import { providerEvents } from "./provider-events.js";
import type { ProviderHandler } from "./provider-handler.js";
import { respondJson, respondProxyError } from "./provider-transport.js";
import { TOGETHER_MODELS } from "./together-models.js";
import { translateTogetherRequest } from "./together-request.js";
import { createTogetherSseTranslator, mapTogetherErrorJson } from "./together-response.js";
import { runTranslatedLeg } from "./translated-leg.js";

interface TogetherHandlerDeps {
  readonly provider: TogetherProviderConfig;
  readonly logger: Logger;
  readonly auth: ProviderAuth<"together">;
  readonly getReasoning: (key: string) => string | undefined;
  readonly putReasoning: (key: string, text: string) => void;
  readonly fetchImpl?: typeof fetch;
}

const NO_RETRY = { "x-should-retry": "false" };
const parseError = (detail: string): string | undefined => {
  try {
    const body: unknown = JSON.parse(detail);
    return mapTogetherErrorJson(body);
  } catch {
    return undefined;
  }
};

const renderUpstreamError = (status: number, detail: string, headers: Headers) => {
  const responseHeaders: Record<string, string> = status === 402 || status === 504 || status === 524 ? { ...NO_RETRY } : {};
  const retryAfter = headers.get("retry-after");
  if (status !== 402 && retryAfter !== null && /^\d{1,6}$/.test(retryAfter)) responseHeaders["retry-after"] = retryAfter;
  return {
    ...upstreamStatusToAnthropicError(status),
    message: status === 402 ? "Together account balance is insufficient. Add funds before you retry."
      : parseError(detail) ?? "Together upstream error",
    headers: responseHeaders,
  };
};

export const createTogetherHandler = (deps: TogetherHandlerDeps): ProviderHandler => {
  const { provider, logger, auth, getReasoning, putReasoning, fetchImpl = fetch } = deps;
  const events = providerEvents("together");
  const url = `${provider.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const capabilities = new Map(TOGETHER_MODELS.map((model) => [model.id, model]));

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
      const capability = capabilities.get(canonicalModel);
      const translated = translateTogetherRequest(request, {
        model: canonicalModel, outputCap: provider.outputCap, getReasoning,
        ...(conversationKey === undefined ? {} : { conversationKey }),
        ...(capability === undefined ? {} : { capabilities: capability }),
      });
      if (!translated.ok) {
        respondProxyError(res, translated.error);
        return;
      }
      for (const warning of translated.value.warnings) logger.log("warn", events.translateWarning, { model, errorCode: warning });
      if (translated.value.clamp) logger.log("warn", "output_cap_clamped", { model, requestedTokens: translated.value.clamp.requested, appliedTokens: translated.value.clamp.applied });

      let diagnostics: ReturnType<typeof createTogetherSseTranslator>["diagnostics"] | undefined;
      await runTranslatedLeg(res, {
        url, name: "Together", model, body: translated.value.body, wantStream: request.stream === true,
        requestTimeoutMs: provider.requestTimeoutMs, streamIdleTimeoutMs: provider.streamIdleTimeoutMs,
        maxAggregateBytes: provider.maxAggregateBytes, logger, events, auth, fetchImpl,
        redirect: "error", abortOnResponseTimeout: true,
        buildHeaders: ({ authHeaders }) => ({
          authorization: authHeaders["authorization"] ?? "", "content-type": "application/json", accept: "text/event-stream", "user-agent": "subswitch",
        }),
        proxyErrorHeaders: (kind) => kind === "timeout" ? NO_RETRY : undefined,
        renderUpstreamError,
        renderJsonResponse: (detail) => ({
          status: 502, type: "api_error", message: parseError(detail) ?? "Together returned an unexpected JSON response",
        }),
        createTranslator: () => {
          const stream = createTogetherSseTranslator({
            model: canonicalModel, seed: randomUUID(), maxEventBytes: provider.maxSseEventBytes,
            maxTurnBytes: provider.reasoningCache.maxTurnBytes, putReasoning,
            ...(conversationKey === undefined ? {} : { conversationKey }),
          });
          diagnostics = stream.diagnostics;
          return stream;
        },
        aggregateFrames: (frames) => aggregateFrames(frames, "together"),
      });
      const info = diagnostics?.();
      if (info) {
        for (const warning of info.warnings) logger.log("warn", events.translateWarning, { model, errorCode: warning });
        if (info.unparsableChunks > 0) logger.log("warn", events.translateWarning, { model, errorCode: "unparsable_chunk" });
      }
    },
    handleCountTokens(_req, res, rawBody) {
      respondJson(res, 200, JSON.stringify({ input_tokens: estimateTokens(rawBody) }));
    },
  };
};
