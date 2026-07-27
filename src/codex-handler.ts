import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { upstreamStatusToAnthropicError, toAnthropicErrorBody, toAnthropicErrorSse } from "./errors.js";
import { respondJson, respondProxyError, readBoundedText } from "./provider-transport.js";
import type { Config } from "./config.js";
import type { Logger } from "./logger.js";
import type { CodexAuthManager, CodexCredentials } from "./codex-auth.js";
import type { ReasoningCache } from "./reasoning-cache.js";
import { estimateTokens, translateRequest } from "./codex-request.js";
import { deriveConversationKey } from "./conversation-key.js";
import { aggregateFrames, createAnthropicSseTranslator, createSseParser } from "./codex-response.js";
import { AnthropicRequestSchema } from "./anthropic-wire-types.js";

const ERROR_BODY_PEEK_BYTES = 2048;

export interface CodexHandlerDeps {
  readonly config: Config;
  readonly logger: Logger;
  readonly auth: CodexAuthManager;
  readonly cache: ReasoningCache;
  readonly fetchImpl?: typeof fetch;
  readonly newSessionId?: () => string;
  /**
   * Display name used in client-visible error messages (e.g. "codex upstream unreachable").
   * Defaults to `"codex"`. A second provider passes its own name so failures say
   * "kimi upstream unreachable" rather than implying the Codex leg failed.
   */
  readonly providerName?: string;
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

export const createCodexHandler = (deps: CodexHandlerDeps): CodexHandler => {
  const { config, logger, auth, cache } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const newSessionId = deps.newSessionId ?? randomUUID;
  // providerName drives client-visible error strings; defaults to "codex" so
  // every existing error message is byte-identical and no pinned test assertions change.
  const providerName = deps.providerName ?? "codex";
  const responsesUrl = `${config.codex.baseUrl.replace(/\/$/, "")}/responses`;
  const requestTimeoutMs = config.codex.requestTimeoutMs;
  const streamIdleTimeoutMs = config.codex.streamIdleTimeoutMs;
  const maxSseEventBytes = config.codex.maxSseEventBytes;

  const buildHeaders = (credentials: CodexCredentials, sessionId: string): Record<string, string> => ({
    authorization: `Bearer ${credentials.accessToken}`,
    "chatgpt-account-id": credentials.accountId,
    // These constants are verified working against the /responses HTTP API (2026-07-21).
    // The real `codex exec` CLI uses a WebSocket app-server transport for inference,
    // so its REST headers are a different transport and not a valid parity reference.
    // We are adding UA/session stability here, NOT re-doing the working protocol
    // constants on unverified wrong-transport data. See e2e/README.md.
    "openai-beta": "responses=experimental",
    originator: "codex_cli_rs",
    session_id: sessionId,
    accept: "text/event-stream",
    "content-type": "application/json",
    "user-agent": config.codex.userAgent,
  });

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
      logger.log("warn", "codex_translate_warning", { model, errorCode: warning });
    }
    if (translated.value.effort !== undefined) {
      logger.log("info", "codex_effort_applied", { model, effort: translated.value.effort });
    }

    const credentialsResult = await auth.getCredentials();
    if (!credentialsResult.ok) {
      respondProxyError(res, credentialsResult.error);
      return;
    }
    let credentials = credentialsResult.value;

    const controller = new AbortController();
    const onClientClose = (): void => {
      if (!res.writableFinished) controller.abort();
    };
    res.on("close", onClientClose);
    const totalTimer = setTimeout(() => controller.abort(), requestTimeoutMs);
    totalTimer.unref();

    let idleTimer: NodeJS.Timeout | undefined;
    const resetIdle = (): void => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(), streamIdleTimeoutMs);
      idleTimer.unref();
    };
    const cleanup = (): void => {
      clearTimeout(totalTimer);
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      res.off("close", onClientClose);
    };

    try {
      let upstream: Response | undefined;
      // Bounded retry: exactly one forced refresh on a pre-stream 401.
      for (let attempt = 0; attempt < 2; attempt++) {
        let response: Response;
        try {
          response = await fetchImpl(responsesUrl, {
            method: "POST",
            headers: buildHeaders(credentials, sessionId),
            body: JSON.stringify(translated.value.body),
            signal: controller.signal,
          });
        } catch {
          if (res.writableEnded || res.destroyed) return;
          respondProxyError(
            res,
            controller.signal.aborted
              ? { kind: "timeout", message: `${providerName} request timed out` }
              : { kind: "upstream", message: `${providerName} upstream unreachable` },
          );
          return;
        }
        if (response.status === 401 && attempt === 0) {
          logger.log("warn", "codex_upstream_401_refreshing", { model });
          await response.body?.cancel().catch(() => undefined);
          const refreshed = await auth.forceRefresh();
          if (!refreshed.ok) {
            respondProxyError(res, refreshed.error);
            return;
          }
          credentials = refreshed.value;
          continue;
        }
        upstream = response;
        break;
      }
      if (upstream === undefined) {
        respondProxyError(res, { kind: "auth", message: `${providerName} authentication failed after refresh — run \`${providerName} login\`` });
        return;
      }

      if (!upstream.ok) {
        const mapped = upstreamStatusToAnthropicError(upstream.status);
        const detail = await readBoundedText(upstream.body, ERROR_BODY_PEEK_BYTES);
        logger.log("warn", "codex_upstream_error", { model, status: upstream.status });
        const retryAfter = upstream.headers.get("retry-after");
        respondJson(
          res,
          mapped.status,
          toAnthropicErrorBody(mapped.type, `${providerName} upstream error (${upstream.status})${detail === "" ? "" : `: ${detail}`}`),
          retryAfter !== null ? { "retry-after": retryAfter } : {},
        );
        return;
      }

      if (upstream.body === null) {
        respondProxyError(res, { kind: "upstream", message: `${providerName} upstream returned an empty body` });
        return;
      }

      const wantStream = translated.value.stream;
      const parser = createSseParser(maxSseEventBytes);
      const translator = createAnthropicSseTranslator({
        // Use the canonical model as the fallback for message_start (options.model)
        // so clients see the canonical id even when the upstream omits model in response.created.
        model: request.model,
        logger,
        providerName,
        onReasoningItems: (callId, items) => cache.put(callId, items),
        ...(conversationKey !== undefined ? { conversationKey } : {}),
        ...(wantStream ? { pingIntervalMs: config.limits.pingIntervalMs } : {}),
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
        const writeFrame = (frame: string): Promise<void> =>
          new Promise((resolve) => {
            if (res.destroyed || res.write(frame)) {
              resolve();
              return;
            }
            const cleanup = (): void => {
              res.off("drain", onDrain);
              res.off("close", onClose);
              controller.signal.removeEventListener("abort", onAbort);
            };
            const onDrain = (): void => { cleanup(); resolve(); };
            const onClose = (): void => { cleanup(); resolve(); };
            const onAbort = (): void => { cleanup(); resolve(); };
            res.once("drain", onDrain);
            res.once("close", onClose);
            controller.signal.addEventListener("abort", onAbort, { once: true });
          });
        try {
          await pipeline(bodyStream, parser, translator, async (source) => {
            for await (const chunk of source) await writeFrame(String(chunk));
          });
          res.end();
        } catch {
          // Mid-stream failure after message_start: emit an error event, never retry.
          logger.log("warn", "codex_stream_interrupted", { model });
          if (!res.writableEnded && !res.destroyed) {
            res.write(toAnthropicErrorSse("api_error", `${providerName} stream interrupted`));
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
        respondProxyError(res, { kind: "upstream", message: `${providerName} stream interrupted` });
        return;
      }
      const aggregated = aggregateFrames(frames, providerName);
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
