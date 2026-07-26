import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { type Result, ok, err } from "./result.js";
import { type AnthropicErrorType, type ProxyError, toAnthropicErrorSse } from "./errors.js";
import type { Logger } from "./logger.js";
import {
  ResponsesDeltaEventSchema,
  ResponsesErrorEventSchema,
  ResponsesEventEnvelopeSchema,
  ResponsesLifecycleEventSchema,
  ResponsesOutputItemEventSchema,
} from "./wire-types.js";

// ---------------------------------------------------------------------------
// 1) Bounded SSE parser: Buffer chunks in, { event, data } records out.
// ---------------------------------------------------------------------------

export interface SseEvent {
  readonly event: string | undefined;
  readonly data: string;
}

export const createSseParser = (maxEventBytes: number): Transform => {
  const decoder = new StringDecoder("utf8");
  let buffer = "";

  const parseRawEvent = (raw: string): SseEvent | undefined => {
    let eventName: string | undefined;
    const dataLines: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^ /, ""));
      } else if (line.startsWith("event:")) {
        eventName = line.slice(6).replace(/^ /, "");
      }
      // id:, retry:, and comment lines are irrelevant to translation.
    }
    if (dataLines.length === 0) return undefined;
    return { event: eventName, data: dataLines.join("\n") };
  };

  return new Transform({
    readableObjectMode: true,
    transform(chunk: Buffer, _encoding, callback) {
      buffer += decoder.write(chunk);
      let boundary = buffer.search(/\r?\n\r?\n/);
      while (boundary !== -1) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, "");
        const event = parseRawEvent(raw);
        if (event !== undefined) this.push(event);
        boundary = buffer.search(/\r?\n\r?\n/);
      }
      if (buffer.length > maxEventBytes) {
        callback(new Error("sse_event_too_large"));
        return;
      }
      callback();
    },
    flush(callback) {
      buffer += decoder.end();
      const event = parseRawEvent(buffer);
      if (event !== undefined) this.push(event);
      buffer = "";
      callback();
    },
  });
};

// ---------------------------------------------------------------------------
// 2) Streaming state machine: Responses events in, Anthropic SSE frames out.
// ---------------------------------------------------------------------------

const frame = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const PING_FRAME = frame("ping", { type: "ping" });

export interface TranslatorOptions {
  readonly model: string;
  readonly logger: Logger;
  readonly onReasoningItems?: (callId: string, items: readonly unknown[]) => void;
  readonly pingIntervalMs?: number;
  /** Derived conversation key (v7-shaped UUID). When present, the first 8 hex
   *  chars are logged as `sessionKey` at debug level on response.completed so
   *  key stability across turns can be verified without logging the full key. */
  readonly conversationKey?: string;
}

export const createAnthropicSseTranslator = (options: TranslatorOptions): Transform => {
  let started = false;
  let finished = false;
  let sawFunctionCall = false;
  let nextBlockIndex = 0;
  const blockIndexByKey = new Map<string, number>();
  const reasoningItems: unknown[] = [];
  let inputTokens = 0;
  let pingTimer: NodeJS.Timeout | undefined;
  let lastActivityMs = 0;
  // Blocks opened but not yet stopped. Bounded by the number of output items in
  // one response; entries are removed on their content_block_stop and the set is
  // cleared at terminal reconciliation.
  const openBlockIndices = new Set<number>();
  // True when a delta arrived but lookupBlockIndex returned undefined, so its text
  // was dropped: the upstream carried content we cannot place in any block.
  let sawUnmatchedDelta = false;

  const blockKeys = (itemId: string | undefined, outputIndex: number | undefined): string[] => {
    const keys: string[] = [];
    if (itemId !== undefined) keys.push(`id:${itemId}`);
    if (outputIndex !== undefined) keys.push(`oi:${outputIndex}`);
    return keys;
  };

  const lookupBlockIndex = (itemId: string | undefined, outputIndex: number | undefined): number | undefined => {
    for (const key of blockKeys(itemId, outputIndex)) {
      const index = blockIndexByKey.get(key);
      if (index !== undefined) return index;
    }
    return undefined;
  };

  /** Reconcile blocks the upstream left open at a terminal point, so a response that
   *  carried content upstream is never delivered as a healthy-looking empty turn.
   *
   *  A dropped delta is unrecoverable — its text belongs to no block — so it is
   *  reported as an error even when every block happens to have been closed;
   *  otherwise the client would receive an empty text block with HTTP 200.
   *  Open blocks with no dropped delta are closed with a synthesised stop, which
   *  lets the aggregator materialise the deltas it did receive.
   *
   *  Returns true when an error frame was emitted, meaning the caller must not
   *  emit the normal terminal frames. */
  const reconcileOpenBlocks = (push: (frameText: string) => void): boolean => {
    if (sawUnmatchedDelta) {
      openBlockIndices.clear();
      push(toAnthropicErrorSse("api_error", "codex stream dropped content deltas that matched no content block"));
      return true;
    }
    for (const index of openBlockIndices) {
      push(frame("content_block_stop", { type: "content_block_stop", index }));
    }
    openBlockIndices.clear();
    return false;
  };

  const translator = new Transform({
    objectMode: true,
    transform(sseEvent: SseEvent, _encoding, callback) {
      lastActivityMs = Date.now();
      if (finished) {
        callback();
        return;
      }

      if (sseEvent.data === "[DONE]") {
        callback();
        return;
      }

      let json: unknown;
      try {
        json = JSON.parse(sseEvent.data);
      } catch {
        options.logger.log("debug", "codex_sse_unparseable_data");
        callback();
        return;
      }
      const envelope = ResponsesEventEnvelopeSchema.safeParse(json);
      const type = envelope.success ? envelope.data.type : (sseEvent.event ?? "");

      const ensureStarted = (id?: string, model?: string): void => {
        if (started) return;
        started = true;
        this.push(
          frame("message_start", {
            type: "message_start",
            message: {
              id: id ?? "msg_codex",
              type: "message",
              role: "assistant",
              model: model ?? options.model,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: 0 },
            },
          }),
        );
      };

      const emitError = (errorType: AnthropicErrorType, message: string): void => {
        finished = true;
        this.push(toAnthropicErrorSse(errorType, message));
      };

      switch (type) {
        case "response.created": {
          const parsed = ResponsesLifecycleEventSchema.safeParse(json);
          if (parsed.success) {
            ensureStarted(parsed.data.response.id, parsed.data.response.model);
          }
          break;
        }
        case "response.output_item.added": {
          const parsed = ResponsesOutputItemEventSchema.safeParse(json);
          if (!parsed.success) break;
          const item = parsed.data.item;
          ensureStarted();
          if (item.type === "message") {
            const index = nextBlockIndex++;
            for (const key of blockKeys(item.id, parsed.data.output_index)) blockIndexByKey.set(key, index);
            this.push(
              frame("content_block_start", {
                type: "content_block_start",
                index,
                content_block: { type: "text", text: "" },
              }),
            );
            openBlockIndices.add(index);
          } else if (item.type === "function_call") {
            sawFunctionCall = true;
            const index = nextBlockIndex++;
            for (const key of blockKeys(item.id, parsed.data.output_index)) blockIndexByKey.set(key, index);
            this.push(
              frame("content_block_start", {
                type: "content_block_start",
                index,
                content_block: {
                  type: "tool_use",
                  id: item.call_id ?? item.id ?? `toolu_${index}`,
                  name: item.name ?? "",
                  input: {},
                },
              }),
            );
            openBlockIndices.add(index);
          }
          // reasoning items produce no Anthropic frames; captured at .done.
          break;
        }
        case "response.output_text.delta": {
          const parsed = ResponsesDeltaEventSchema.safeParse(json);
          if (!parsed.success) break;
          const index = lookupBlockIndex(parsed.data.item_id, parsed.data.output_index);
          if (index === undefined) {
            sawUnmatchedDelta = true;
            break;
          }
          this.push(
            frame("content_block_delta", {
              type: "content_block_delta",
              index,
              delta: { type: "text_delta", text: parsed.data.delta },
            }),
          );
          break;
        }
        case "response.function_call_arguments.delta": {
          const parsed = ResponsesDeltaEventSchema.safeParse(json);
          if (!parsed.success) break;
          const index = lookupBlockIndex(parsed.data.item_id, parsed.data.output_index);
          if (index === undefined) {
            sawUnmatchedDelta = true;
            break;
          }
          this.push(
            frame("content_block_delta", {
              type: "content_block_delta",
              index,
              delta: { type: "input_json_delta", partial_json: parsed.data.delta },
            }),
          );
          break;
        }
        case "response.output_item.done": {
          const parsed = ResponsesOutputItemEventSchema.safeParse(json);
          if (!parsed.success) break;
          const item = parsed.data.item;
          if (item.type === "reasoning") {
            reasoningItems.push(item);
            break;
          }
          if (item.type === "function_call" && item.call_id !== undefined && reasoningItems.length > 0) {
            // Parallel calls in one response share the same buffered items;
            // the request translator dedupes by item id on re-injection.
            options.onReasoningItems?.(item.call_id, [...reasoningItems]);
          }
          const index = lookupBlockIndex(item.id, parsed.data.output_index);
          if (index !== undefined) {
            this.push(frame("content_block_stop", { type: "content_block_stop", index }));
            openBlockIndices.delete(index);
          }
          break;
        }
        case "response.completed":
        case "response.incomplete": {
          const parsed = ResponsesLifecycleEventSchema.safeParse(json);
          if (!parsed.success) break;
          ensureStarted(parsed.data.response.id, parsed.data.response.model);
          finished = true;
          // Close blocks left open by a missing output_item.done here rather than in
          // flush(), so the client never sees a content_block_stop after message_stop.
          if (reconcileOpenBlocks((frameText) => this.push(frameText))) break;
          const response = parsed.data.response;
          const hitMaxTokens =
            response.status === "incomplete" && response.incomplete_details?.reason === "max_output_tokens";
          const stopReason = sawFunctionCall ? "tool_use" : hitMaxTokens ? "max_tokens" : "end_turn";
          inputTokens = response.usage?.input_tokens ?? 0;
          this.push(
            frame("message_delta", {
              type: "message_delta",
              delta: { stop_reason: stopReason, stop_sequence: null },
              usage: { input_tokens: inputTokens, output_tokens: response.usage?.output_tokens ?? 0 },
            }),
          );
          this.push(frame("message_stop", { type: "message_stop" }));
          // Cache-efficacy observability: log cachedTokens to prove prompt_cache_key
          // is effective, and sessionKey (truncated, non-reversible) to verify key
          // stability across turns.
          const cachedTokens = response.usage?.input_tokens_details?.cached_tokens;
          if (cachedTokens !== undefined && cachedTokens > 0) {
            options.logger.log("debug", "codex_cache_tokens", { cachedTokens });
          }
          if (options.conversationKey !== undefined) {
            options.logger.log("debug", "codex_session_key", {
              // First 8 hex chars of the UUID (chars before the first dash).
              sessionKey: options.conversationKey.slice(0, 8),
            });
          }
          break;
        }
        case "response.failed": {
          const parsed = ResponsesLifecycleEventSchema.safeParse(json);
          const message =
            parsed.success && typeof parsed.data.response.error?.["message"] === "string"
              ? (parsed.data.response.error["message"] as string)
              : "codex response failed";
          ensureStarted();
          emitError("api_error", message);
          break;
        }
        case "error": {
          const parsed = ResponsesErrorEventSchema.safeParse(json);
          const message = parsed.success && parsed.data.message != null ? parsed.data.message : "codex stream error";
          ensureStarted();
          emitError("api_error", message);
          break;
        }
        default:
          options.logger.log("debug", "codex_sse_event_ignored", { eventType: type });
          break;
      }
      callback();
    },
    flush(callback) {
      if (pingTimer !== undefined) clearInterval(pingTimer);
      pingTimer = undefined;
      // Only reachable when the stream ended without a terminal lifecycle event:
      // response.completed/.incomplete already reconciled, and an emitted error frame
      // is itself terminal. Guarding on `finished` keeps flush() from ever appending
      // a frame after message_stop.
      if (!finished) reconcileOpenBlocks((frameText) => this.push(frameText));
      callback();
    },
  });

  if (options.pingIntervalMs !== undefined) {
    const intervalMs = options.pingIntervalMs;
    lastActivityMs = Date.now();
    pingTimer = setInterval(() => {
      if (started && !finished && Date.now() - lastActivityMs >= intervalMs) {
        translator.push(PING_FRAME);
      }
    }, intervalMs);
    pingTimer.unref();
  }

  translator.on("close", () => {
    if (pingTimer !== undefined) clearInterval(pingTimer);
    pingTimer = undefined;
  });

  return translator;
};

// ---------------------------------------------------------------------------
// 3) Aggregator: fold our own Anthropic SSE frames into a complete message
//    for clients that did not request streaming.
// ---------------------------------------------------------------------------

export type AggregateOutcome =
  | { readonly kind: "message"; readonly message: Record<string, unknown> }
  | { readonly kind: "error"; readonly errorType: AnthropicErrorType; readonly message: string };

interface PendingBlock {
  block: Record<string, unknown>;
  text: string;
  partialJson: string;
}

export const aggregateFrames = (frames: readonly string[]): Result<AggregateOutcome, ProxyError> => {
  let message: Record<string, unknown> | undefined;
  const blocks = new Map<number, PendingBlock>();
  const content: Record<string, unknown>[] = [];
  let stopReason: string | null = null;
  let usage: Record<string, unknown> = { input_tokens: 0, output_tokens: 0 };

  for (const rawFrame of frames) {
    const dataLine = rawFrame.split("\n").find((line) => line.startsWith("data: "));
    if (dataLine === undefined) continue;
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(dataLine.slice(6)) as Record<string, unknown>;
    } catch {
      continue;
    }
    switch (data["type"]) {
      case "message_start":
        message = { ...(data["message"] as Record<string, unknown>) };
        break;
      case "content_block_start": {
        const index = data["index"] as number;
        blocks.set(index, { block: { ...(data["content_block"] as Record<string, unknown>) }, text: "", partialJson: "" });
        break;
      }
      case "content_block_delta": {
        const pending = blocks.get(data["index"] as number);
        if (pending === undefined) break;
        const delta = data["delta"] as Record<string, unknown>;
        if (delta["type"] === "text_delta") pending.text += delta["text"] as string;
        if (delta["type"] === "input_json_delta") pending.partialJson += delta["partial_json"] as string;
        break;
      }
      case "content_block_stop": {
        const index = data["index"] as number;
        const pending = blocks.get(index);
        if (pending === undefined) break;
        blocks.delete(index);
        if (pending.block["type"] === "text") {
          content.push({ type: "text", text: pending.text });
        } else if (pending.block["type"] === "tool_use") {
          let input: unknown = {};
          try {
            input = pending.partialJson === "" ? {} : JSON.parse(pending.partialJson);
          } catch {
            input = {};
          }
          content.push({ type: "tool_use", id: pending.block["id"], name: pending.block["name"], input });
        }
        break;
      }
      case "message_delta": {
        const delta = data["delta"] as Record<string, unknown> | undefined;
        if (delta !== undefined && typeof delta["stop_reason"] === "string") stopReason = delta["stop_reason"];
        if (data["usage"] !== undefined) usage = data["usage"] as Record<string, unknown>;
        break;
      }
      case "error": {
        const errorBody = data["error"] as Record<string, unknown> | undefined;
        return ok({
          kind: "error",
          errorType: (errorBody?.["type"] as AnthropicErrorType | undefined) ?? "api_error",
          message: (errorBody?.["message"] as string | undefined) ?? "codex upstream error",
        });
      }
      default:
        break;
    }
  }

  if (message === undefined) {
    return err({ kind: "upstream", message: "codex stream ended before producing a message" });
  }
  // Invariant: every content_block_start must be matched by a content_block_stop before
  // we can assemble a valid response.  The translator's flush() synthesises stops for
  // recoverable paths; if any blocks remain open here an irrecoverable drop occurred.
  if (blocks.size > 0) {
    return err({ kind: "upstream", message: `codex stream ended with ${blocks.size} unclosed content block(s)` });
  }
  return ok({
    kind: "message",
    message: { ...message, content, stop_reason: stopReason, stop_sequence: null, usage },
  });
};
