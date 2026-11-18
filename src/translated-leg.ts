import type { ServerResponse } from "node:http";
import { Readable, type Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import {
  SYNTHESIZED_HEADER, SYNTHESIZED_MARKER, toAnthropicErrorBody, toAnthropicErrorSse,
  type AnthropicError, type AnthropicErrorType, type ProxyError,
} from "./errors.js";
import { observeReadableSse } from "./limit-http-observer.js";
import { recordLimitFailure, type LimitContext } from "./limit-observation.js";
import type { Logger } from "./logger.js";
import { createFrameWriter, readBoundedText, respondJson, respondProxyError } from "./provider-transport.js";
import type { Result } from "./result.js";

const ERROR_BODY_PEEK_BYTES = 2048;

type AggregateOutcome =
  | { readonly kind: "message"; readonly message: Record<string, unknown> }
  | { readonly kind: "error"; readonly errorType: AnthropicErrorType; readonly message: string };

interface UpstreamError extends AnthropicError {
  readonly message: string;
  readonly headers?: Record<string, string>;
}

export interface TranslatedLegOptions<C> {
  readonly url: string;
  readonly name: string;
  readonly model: string;
  readonly body: object;
  readonly wantStream: boolean;
  readonly requestTimeoutMs: number;
  readonly streamIdleTimeoutMs: number;
  readonly maxAggregateBytes: number;
  readonly logger: Logger;
  readonly events: {
    readonly upstream401Refreshing: string;
    readonly retryBoundViolated: string;
    readonly upstreamError: string;
    readonly streamInterrupted: string;
  };
  readonly auth: {
    readonly refreshable: boolean;
    readonly getCredentials: (signal: AbortSignal) => Promise<Result<C, ProxyError>>;
    readonly forceRefresh: () => Promise<Result<C, ProxyError>>;
  };
  readonly fetchImpl: typeof fetch;
  readonly buildHeaders: (credential: C) => Record<string, string>;
  readonly createTranslator: () => { readonly parser: Transform; readonly translator: Transform };
  readonly aggregateFrames: (frames: readonly string[]) => Result<AggregateOutcome, ProxyError>;
  readonly renderUpstreamError: (status: number, detail: string, headers: Headers) => UpstreamError;
  readonly limitKey?: LimitContext;
  readonly proxyErrorHeaders?: (kind: ProxyError["kind"]) => Record<string, string> | undefined;
  readonly redirect?: "error";
}

type ReplyError = (error: ProxyError) => void;
type FramePipeline = readonly [Readable, Transform, Transform];

/** Return the upstream response, or end the request here if no response is available. */
const requestUpstream = async <C>(res: ServerResponse, options: TranslatedLegOptions<C>, signal: AbortSignal,
  replyError: ReplyError): Promise<Response | undefined> => {
  const { auth, events, fetchImpl, logger, model, name } = options;
  const initial = await auth.getCredentials(signal);
  if (!initial.ok) {
    replyError(initial.error);
    return;
  }
  let credential = initial.value;
  const maxAttempts = auth.refreshable ? 2 : 1;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let response: Response;
    try {
      response = await fetchImpl(options.url, {
        method: "POST",
        headers: options.buildHeaders(credential),
        body: JSON.stringify(options.body),
        ...(options.redirect !== undefined ? { redirect: options.redirect } : {}),
        signal,
      });
    } catch {
      if (!res.writableEnded && !res.destroyed) {
        replyError(signal.aborted
          ? { kind: "timeout", message: `${name} request timed out` }
          : { kind: "upstream", message: `${name} upstream unreachable` });
      }
      return;
    }
    if (response.status !== 401 || attempt + 1 === maxAttempts) return response;
    logger.log("warn", events.upstream401Refreshing, { model });
    await response.body?.cancel().catch(() => undefined);
    const refreshed = await auth.forceRefresh();
    if (!refreshed.ok) {
      replyError(refreshed.error);
      return;
    }
    credential = refreshed.value;
  }
  // The last attempt must return a response or report an error.
  logger.log("error", events.retryBoundViolated, { model });
  respondJson(res, 500, toAnthropicErrorBody("api_error", `${name} internal error`));
};

const relayUpstreamError = async <C>(res: ServerResponse, options: TranslatedLegOptions<C>, upstream: Response): Promise<void> => {
  const { logger, limitKey, events, model } = options;
  const detail = await readBoundedText(upstream.body, ERROR_BODY_PEEK_BYTES);
  if (limitKey !== undefined) {
    recordLimitFailure(logger, limitKey,
      { transport: "http", status: upstream.status, committed: false, headers: upstream.headers,
        text: detail, truncated: Buffer.byteLength(detail) >= ERROR_BODY_PEEK_BYTES });
  }
  logger.log("warn", events.upstreamError, { model, status: upstream.status });
  const error = options.renderUpstreamError(upstream.status, detail, upstream.headers);
  respondJson(res, error.status, toAnthropicErrorBody(error.type, error.message), error.headers);
};

const streamFrames = async <C>(res: ServerResponse, options: TranslatedLegOptions<C>, streams: FramePipeline,
  signal: AbortSignal): Promise<void> => {
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", [SYNTHESIZED_HEADER]: SYNTHESIZED_MARKER });
  res.socket?.setNoDelay(true);
  // Keep the client response outside the pipeline so an upstream error can still send an SSE frame.
  const writeFrame = createFrameWriter(res, signal);
  try {
    await pipeline(...streams, async (source) => {
      for await (const chunk of source) await writeFrame(String(chunk));
    });
    res.end();
  } catch {
    options.logger.log("warn", options.events.streamInterrupted, { model: options.model });
    if (!res.writableEnded && !res.destroyed) {
      res.write(toAnthropicErrorSse("api_error", `${options.name} stream interrupted`));
      res.end();
    }
  }
};

const collectFrames = async <C>(res: ServerResponse, options: TranslatedLegOptions<C>, streams: FramePipeline,
  replyError: ReplyError): Promise<void> => {
  const frames: string[] = [];
  let framesBytes = 0;
  try {
    await pipeline(...streams, async (source) => {
      for await (const chunk of source) {
        const frame = String(chunk);
        framesBytes += frame.length;
        // Reject the pipeline immediately at the bound. Do not aggregate partial frames.
        if (framesBytes > options.maxAggregateBytes) throw new Error("sse_aggregate_too_large");
        frames.push(frame);
      }
    });
  } catch {
    replyError({ kind: "upstream", message: `${options.name} stream interrupted` });
    return;
  }
  const aggregated = options.aggregateFrames(frames);
  if (!aggregated.ok) {
    replyError(aggregated.error);
  } else if (aggregated.value.kind === "error") {
    respondJson(res, 502, toAnthropicErrorBody(aggregated.value.errorType, aggregated.value.message));
  } else {
    respondJson(res, 200, JSON.stringify(aggregated.value.message));
  }
};

/** Share the request abort signal with the credential source, fetch, and client stream. */
export const runTranslatedLeg = async <C>(res: ServerResponse, options: TranslatedLegOptions<C>): Promise<void> => {
  const replyError: ReplyError = (error) => respondProxyError(res, error, options.proxyErrorHeaders?.(error.kind));
  const controller = new AbortController();
  const onClientClose = (): void => {
    if (!res.writableFinished) controller.abort();
  };
  res.on("close", onClientClose);
  const totalTimer = setTimeout(() => controller.abort(), options.requestTimeoutMs);
  totalTimer.unref();
  let idleTimer: NodeJS.Timeout | undefined;
  const resetIdle = (): void => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), options.streamIdleTimeoutMs);
    idleTimer.unref();
  };

  try {
    const upstream = await requestUpstream(res, options, controller.signal, replyError);
    if (upstream === undefined) return;
    if (!upstream.ok) {
      await relayUpstreamError(res, options, upstream);
      return;
    }
    if (upstream.body === null) {
      replyError({ kind: "upstream", message: `${options.name} upstream returned an empty body` });
      return;
    }
    const { parser, translator } = options.createTranslator();
    const bodyStream = Readable.fromWeb(upstream.body as WebReadableStream<Uint8Array>);
    if (options.limitKey !== undefined) observeReadableSse(options.logger, options.limitKey, bodyStream, upstream.headers);
    bodyStream.on("data", resetIdle);
    resetIdle();
    const streams = [bodyStream, parser, translator] as const;
    if (options.wantStream) await streamFrames(res, options, streams, controller.signal);
    else await collectFrames(res, options, streams, replyError);
  } finally {
    clearTimeout(totalTimer);
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    res.off("close", onClientClose);
  }
};
