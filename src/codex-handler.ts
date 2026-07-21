import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { codexStatusToAnthropicError, proxyErrorToAnthropic, toAnthropicErrorBody, toAnthropicErrorSse, type ProxyError } from "./errors.js";
import type { Config } from "./config.js";
import type { Logger } from "./logger.js";
import type { CodexAuthManager, CodexCredentials } from "./codex-auth.js";
import type { ReasoningCache } from "./reasoning-cache.js";
import { estimateTokens, translateRequest } from "./codex-request.js";
import { aggregateFrames, createAnthropicSseTranslator, createSseParser } from "./codex-response.js";
import { AnthropicRequestSchema } from "./wire-types.js";

const ERROR_BODY_PEEK_BYTES = 2048;

export interface CodexHandlerDeps {
  readonly config: Config;
  readonly logger: Logger;
  readonly auth: CodexAuthManager;
  readonly cache: ReasoningCache;
  readonly fetchImpl?: typeof fetch;
  readonly newSessionId?: () => string;
}

export interface CodexHandler {
  handleMessages(req: IncomingMessage, res: ServerResponse, rawBody: Buffer): Promise<void>;
  handleCountTokens(req: IncomingMessage, res: ServerResponse, rawBody: Buffer): void;
}

const respondJson = (res: ServerResponse, status: number, body: string, extraHeaders: Record<string, string> = {}): void => {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json", ...extraHeaders });
  res.end(body);
};

const respondProxyError = (res: ServerResponse, error: ProxyError): void => {
  const mapped = proxyErrorToAnthropic(error);
  respondJson(res, mapped.status, toAnthropicErrorBody(mapped.type, error.message));
};

const readBoundedText = async (body: Response["body"], maxBytes: number): Promise<string> => {
  if (body === null) return "";
  const reader = body.getReader();
  const parts: Buffer[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(Buffer.from(value));
      total += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(parts).toString("utf8").slice(0, maxBytes);
};

export const createCodexHandler = (deps: CodexHandlerDeps): CodexHandler => {
  const { config, logger, auth, cache } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const newSessionId = deps.newSessionId ?? randomUUID;
  const responsesUrl = `${config.codex.baseUrl.replace(/\/$/, "")}/responses`;

  const buildHeaders = (credentials: CodexCredentials): Record<string, string> => ({
    authorization: `Bearer ${credentials.accessToken}`,
    "chatgpt-account-id": credentials.accountId,
    "openai-beta": "responses=experimental",
    originator: "codex_cli_rs",
    session_id: newSessionId(),
    accept: "text/event-stream",
    "content-type": "application/json",
  });

  const handleMessages = async (_req: IncomingMessage, res: ServerResponse, rawBody: Buffer): Promise<void> => {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawBody.toString("utf8"));
    } catch {
      respondJson(res, 400, toAnthropicErrorBody("invalid_request_error", "request body is not valid JSON"));
      return;
    }
    const parsed = AnthropicRequestSchema.safeParse(parsedJson);
    if (!parsed.success) {
      respondJson(res, 400, toAnthropicErrorBody("invalid_request_error", "request body is not a valid messages request"));
      return;
    }
    const model = parsed.data.model;

    const translated = translateRequest(parsed.data, cache);
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
    const totalTimer = setTimeout(() => controller.abort(), config.limits.requestTimeoutMs);
    totalTimer.unref();

    let idleTimer: NodeJS.Timeout | undefined;
    const resetIdle = (): void => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(), config.limits.streamIdleTimeoutMs);
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
            headers: buildHeaders(credentials),
            body: JSON.stringify(translated.value.body),
            signal: controller.signal,
          });
        } catch {
          if (res.writableEnded || res.destroyed) return;
          respondProxyError(
            res,
            controller.signal.aborted
              ? { kind: "timeout", message: "codex request timed out" }
              : { kind: "upstream", message: "codex upstream unreachable" },
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
        respondProxyError(res, { kind: "auth", message: "codex authentication failed after refresh — run `codex login`" });
        return;
      }

      if (!upstream.ok) {
        const mapped = codexStatusToAnthropicError(upstream.status);
        const detail = await readBoundedText(upstream.body, ERROR_BODY_PEEK_BYTES);
        logger.log("warn", "codex_upstream_error", { model, status: upstream.status });
        const retryAfter = upstream.headers.get("retry-after");
        respondJson(
          res,
          mapped.status,
          toAnthropicErrorBody(mapped.type, `codex upstream error (${upstream.status})${detail === "" ? "" : `: ${detail}`}`),
          retryAfter !== null ? { "retry-after": retryAfter } : {},
        );
        return;
      }

      if (upstream.body === null) {
        respondProxyError(res, { kind: "upstream", message: "codex upstream returned an empty body" });
        return;
      }

      const wantStream = translated.value.stream;
      const parser = createSseParser(config.limits.maxSseEventBytes);
      const translator = createAnthropicSseTranslator({
        model,
        logger,
        onReasoningItems: (callId, items) => cache.put(callId, items),
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
        const writeFrame = (frame: string): Promise<void> =>
          new Promise((resolve) => {
            if (res.destroyed || res.write(frame)) {
              resolve();
              return;
            }
            const onDrain = (): void => {
              res.off("close", onClose);
              resolve();
            };
            const onClose = (): void => {
              res.off("drain", onDrain);
              resolve();
            };
            res.once("drain", onDrain);
            res.once("close", onClose);
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
            res.write(toAnthropicErrorSse("api_error", "codex stream interrupted"));
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
        respondProxyError(res, { kind: "upstream", message: "codex stream interrupted" });
        return;
      }
      const aggregated = aggregateFrames(frames);
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
