import type { IncomingMessage } from "node:http";
import type { Readable } from "node:stream";
import type { Logger } from "./logger.js";
import { decodeBody } from "./content-encoding.js";
import {
  LIMIT_CAPTURE_BYTES,
  limitHeaders,
  recordLimitEvent,
  recordLimitFailure,
  type LimitContext,
} from "./limit-observation.js";
const decoding = new WeakMap<Logger, number>();
const compressedWarnings = new WeakSet<Logger>();

/** Bounded passive scanner. No aggregation, reader ownership or backpressure changes. */
export class LimitSseObserver {
  private parts: Buffer[] = [];
  private lineBytes = 0;
  private frameBytes = 0;
  private dropped = false;
  private eventName = "";
  private data: string[] = [];
  private committed = false;
  private lastLineByte = 0;
  constructor(
    private readonly logger: Logger,
    private readonly context: LimitContext,
    private readonly headers?: Headers,
  ) {}
  write(chunk: Buffer): void {
    if (!this.logger.recordLimit) return;
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline;
      const part = chunk.subarray(offset, end);
      this.lineBytes += part.length;
      if (part.length) this.lastLineByte = part[part.length - 1]!;
      this.frameBytes += part.length + (newline < 0 ? 0 : 1);
      if (this.frameBytes > LIMIT_CAPTURE_BYTES || this.parts.length >= 4096)
        this.dropped = true;
      if (!this.dropped && part.length) this.parts.push(Buffer.from(part));
      if (newline < 0) break;
      const blank =
        this.lineBytes === 0 ||
        (this.lineBytes === 1 && this.lastLineByte === 13);
      const line = this.dropped
        ? ""
        : Buffer.concat(this.parts).toString("utf8").replace(/\r$/, "");
      this.parts = [];
      this.lineBytes = 0;
      this.lastLineByte = 0;
      if (blank) {
        if (
          this.eventName === "message_start" ||
          this.eventName === "response.created"
        )
          this.committed = true;
        if (
          this.dropped &&
          ["error", "response.failed"].includes(this.eventName)
        )
          recordLimitFailure(this.logger, this.context, {
            transport: "sse",
            committed: "unknown",
            providerStartSeen: this.committed,
            headers: this.headers,
            truncated: true,
          });
        else if (!this.dropped) {
          const data = this.data.join("\n");
          if (
            /^\s*\{\s*"type"\s*:\s*"(?:message_start|response\.created)"/.test(
              data,
            )
          )
            this.committed = true;
          if (
            ["error", "response.failed"].includes(this.eventName) ||
            /^\s*\{\s*"type"\s*:\s*"(?:error|response\.failed)"/.test(data)
          ) {
            try {
              recordLimitEvent(
                this.logger,
                this.context,
                JSON.parse(data),
                "sse",
                {
                  ...(this.headers ? { headers: this.headers } : {}),
                  providerStartSeen: this.committed,
                  ...(["error", "response.failed"].includes(this.eventName)
                    ? { eventType: this.eventName }
                    : {}),
                },
              );
            } catch {
              if (["error", "response.failed"].includes(this.eventName))
                recordLimitFailure(this.logger, this.context, {
                  transport: "sse",
                  committed: "unknown",
                  providerStartSeen: this.committed,
                  headers: this.headers,
                  text: data,
                });
            }
          }
        }
        this.frameBytes = 0;
        this.dropped = false;
        this.eventName = "";
        this.data = [];
      } else if (!this.dropped) {
        if (line.startsWith("event:")) this.eventName = line.slice(6).trim();
        if (line.startsWith("data:")) this.data.push(line.slice(5).trimStart());
      }
      offset = end + 1;
    }
  }
}
export function observeNodeResponse(
  logger: Logger,
  context: LimitContext,
  response: IncomingMessage,
): void {
  if (!logger.recordLimit) return;
  const status = response.statusCode ?? 0,
    encoding = response.headers["content-encoding"];
  if (status < 400) {
    const sse =
      String(response.headers["content-type"] ?? "").includes(
        "text/event-stream",
      ) || context.product === "chatgpt-codex";
    if (sse && !encoding) {
      const scanner = new LimitSseObserver(
        logger,
        context,
        new Headers(limitHeaders(response.headers)),
      );
      response.pause();
      response.on("data", (chunk) => scanner.write(Buffer.from(chunk)));
    } else if (encoding && sse) {
      try {
        if (compressedWarnings.has(logger)) return;
        compressedWarnings.add(logger);
        logger.log("warn", "limit_observation_partial", {
          errorCode: "compressed_native_sse",
        });
      } catch {
        /* Passive diagnostics only. */
      }
    }
    return;
  }
  let bytes = 0,
    finished = false;
  const parts: Buffer[] = [];
  const finish = (complete: boolean) => {
    if (finished) return;
    finished = true;
    response.off("data", data);
    response.off("end", end);
    response.off("close", close);
    const truncated = !complete || bytes > LIMIT_CAPTURE_BYTES;
    const raw = Buffer.concat(parts);
    const emit = (text?: string, encoded = false) =>
      recordLimitFailure(logger, context, {
        status,
        transport: "http",
        committed: "unknown",
        headers: response.headers,
        text,
        truncated,
        encoded,
      });
    if (encoding && !truncated && (decoding.get(logger) ?? 0) < 4) {
      decoding.set(logger, (decoding.get(logger) ?? 0) + 1);
      const task = decodeBody(raw, encoding, LIMIT_CAPTURE_BYTES)
        .then(
          (value) => emit(value.toString("utf8")),
          () => emit(undefined, true),
        )
        .finally(() => decoding.set(logger, (decoding.get(logger) ?? 1) - 1));
      try {
        logger.trackLimitTask?.(task);
      } catch {
        /* Custom diagnostics cannot break native delivery. */
      }
      void task.catch(() => undefined);
    } else emit(truncated ? undefined : raw.toString("utf8"), !!encoding);
  };
  const data = (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes <= LIMIT_CAPTURE_BYTES) parts.push(Buffer.from(chunk));
    else finish(false);
  };
  const end = () => finish(true),
    close = () => finish(false);
  // Adding a data observer must not race the real consumer into flowing mode.
  response.pause();
  response.on("data", data);
  response.once("end", end);
  response.once("close", close);
}
export function observeReadableSse(
  logger: Logger,
  context: LimitContext,
  source: Readable,
  headers?: Headers,
): void {
  if (!logger.recordLimit) return;
  const scanner = new LimitSseObserver(logger, context, headers);
  source.on("data", (chunk) => scanner.write(Buffer.from(chunk)));
}
