import { randomUUID } from "node:crypto";
import { estimateTokens } from "./codex-request.js";
import { aggregateFrames } from "./codex-response.js";
import type { GeminiProviderConfig } from "./config.js";
import { deriveConversationKey } from "./conversation-key.js";
import { createGeminiBootstrap, type GeminiBootstrapDeps } from "./gemini-bootstrap.js";
import { GEMINI_USER_AGENT } from "./gemini-constants.js";
import { GEMINI_ERRORS, geminiPrepareErrorCodes, renderGeminiRunnerError, renderGeminiUpstreamError, toGeminiProxyError, type GeminiErrorCode } from "./gemini-errors.js";
import { buildGeminiRequest, parseGeminiInput } from "./gemini-request.js";
import { createGeminiSseTranslator } from "./gemini-response.js";
import type { Logger } from "./logger.js";
import type { ProviderAuth, ProviderCredential } from "./provider-auth.js";
import { GEMINI_EVENTS } from "./provider-events.js";
import type { ProviderHandler } from "./provider-handler.js";
import { notOptedInHandler } from "./provider-opt-in.js";
import { respondJson, respondProxyError } from "./provider-transport.js";
import type { ReasoningCache } from "./reasoning-cache.js";
import { err, ok } from "./result.js";
import { runTranslatedLeg } from "./translated-leg.js";

export interface GeminiHandlerDeps extends GeminiBootstrapDeps {
  readonly provider: GeminiProviderConfig;
  /** Use the read-only Gemini auth source with the same account latch. */
  readonly auth: ProviderAuth<"gemini">;
  readonly logger: Logger;
  /** Use a dedicated ReasoningCache with strict byte bounds. */
  readonly signatures: Pick<ReasoningCache, "get" | "put">;
  readonly fetchImpl: typeof fetch;
}

const MAX_EVENT_BYTES = 4 * 1024 * 1024;
const MAX_AGGREGATE_BYTES = 64 * 1024 * 1024;

type Credential = ProviderCredential<"gemini">;

const headersFor = ({ authHeaders }: Credential): Record<string, string> => ({
  authorization: authHeaders.authorization ?? "",
  "user-agent": GEMINI_USER_AGENT,
  "content-type": "application/json",
  accept: "text/event-stream",
});

const logCode = (logger: Logger, code: GeminiErrorCode): void => {
  logger.log("warn", GEMINI_ERRORS[code].event, { errorCode: code });
};

/** The runner's shared diagnostics must not log models, statuses or exception names for Gemini. */
const fixedRunnerLogger = (logger: Logger): Logger => ({
  log: (level, event, fields) => {
    if (event === GEMINI_EVENTS.upstreamError) return; // The provider renderer reports the fixed code.
    if (event === GEMINI_EVENTS.credentialLoadFailed) {
      const code = fields?.errorCode;
      const diagnostic = code !== undefined && geminiPrepareErrorCodes.has(code) ? code : "credential_failed";
      logger.log(level, event, { errorCode: diagnostic === "account_blocked" ? "bootstrap_blocked" : diagnostic });
      return;
    }
    logger.log(level, event, { errorCode: event === GEMINI_EVENTS.upstream401Refreshing ? "sign_in_again" : "upstream_error" });
  },
});

export const createGeminiHandler = (deps: GeminiHandlerDeps): ProviderHandler => {
  const { provider, auth, logger, signatures, accountBlock, fetchImpl } = deps;
  if (!provider.optedIn) return notOptedInHandler("Gemini", "gemini");
  const bootstrap = createGeminiBootstrap(deps);
  const runnerLogger = fixedRunnerLogger(logger);
  const url = `${provider.baseUrl.replace(/\/+$/, "")}/v1internal:streamGenerateContent?alt=sse`;

  const renderError = (status: number, headers: Headers) => {
    // [D4] Qualify the reason field. Until then every 403 is unclassified and blocks the account.
    const error = renderGeminiUpstreamError(status, undefined, headers, accountBlock);
    logCode(logger, error.errorCode);
    return error;
  };

  return {
    async handleMessages(_req, res, _rawBody, parsedBody, model) {
      const refuse = (code: GeminiErrorCode): void => {
        logCode(logger, code);
        respondProxyError(res, toGeminiProxyError(code));
      };
      const parsed = parseGeminiInput(parsedBody);
      if (!parsed.ok) { refuse(parsed.error); return; }
      const request = { ...parsed.value, model };
      const conversationKey = deriveConversationKey(request);
      // A pure preflight must succeed before the runner loads credentials.
      const translated = buildGeminiRequest(request, { signatures, ...(conversationKey === undefined ? {} : { conversationKey }) });
      if (!translated.ok) { refuse(translated.error); return; }
      if (accountBlock.isBlocked()) { refuse("account_blocked"); return; }

      const requestId = randomUUID();
      let attemptCredential: Credential | undefined;
      let streamError: GeminiErrorCode | undefined;
      const observeStatus = (status: number): void => {
        // [D4] No qualified project-specific reason exists. Clear this lineage on any 4xx.
        if (status >= 400 && status < 500 && attemptCredential !== undefined) bootstrap.invalidate(attemptCredential);
        if (status === 403) accountBlock.block();
      };

      await runTranslatedLeg<Credential>(res, {
        url, name: "Gemini", model, body: translated.value, wantStream: request.stream === true,
        requestTimeoutMs: provider.requestTimeoutMs, streamIdleTimeoutMs: provider.streamIdleTimeoutMs,
        maxAggregateBytes: MAX_AGGREGATE_BYTES, logger: runnerLogger, events: GEMINI_EVENTS, auth,
        redirect: "error", abortOnResponseTimeout: true, prepareErrorCodes: geminiPrepareErrorCodes,
        renderRunnerError: renderGeminiRunnerError,
        async prepareBody(credential, signal) {
          const project = await bootstrap.loadProject(credential, signal);
          if (!project.ok) return project;
          attemptCredential = credential;
          return ok({ ...translated.value, project: project.value, requestId });
        },
        async fetchImpl(input, init) {
          // Another request can block this account after bootstrap and before generate.
          if (accountBlock.isBlocked()) return new Response(null, { status: 403 });
          try {
            const response = await fetchImpl(input, init);
            observeStatus(response.status);
            if (!response.redirected && response.ok && response.body !== null) return response;
            // Do not read unqualified error bodies or relay redirect targets.
            void response.body?.cancel().catch(() => undefined);
            if (response.redirected || response.status < 400) return new Response(null, { status: 502 });
            return new Response(null, { status: response.status, headers: response.headers });
          } catch {
            return new Response(null, { status: 502 });
          }
        },
        buildHeaders: headersFor,
        renderUpstreamError: (status, _detail, headers) => renderError(status, headers),
        renderJsonResponse: () => renderError(502, new Headers()),
        createTranslator: () => createGeminiSseTranslator({
          model, seed: requestId, maxEventBytes: MAX_EVENT_BYTES, conversationKey, signatures, accountBlock,
          onError: (code, status) => {
            if (status !== undefined) observeStatus(status);
            streamError = code;
            logCode(logger, code);
          },
        }),
        aggregateFrames: (frames) => streamError === undefined ? aggregateFrames(frames, "gemini") : err(toGeminiProxyError(streamError)),
      });
    },
    handleCountTokens(_req, res, rawBody) {
      respondJson(res, 200, JSON.stringify({ input_tokens: estimateTokens(rawBody) }));
    },
  };
};
