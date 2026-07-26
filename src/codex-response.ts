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
      const prevLen = buffer.length;
      buffer += decoder.write(chunk);
      // Only scan from (prevLen - 3) on the first search: a 4-byte separator
      // (\r\n\r\n) cannot begin earlier, so any boundary in the already-scanned
      // prefix was consumed in the previous chunk. This makes the search O(new
      // bytes) rather than O(total buffer), fixing O(S²/C) complexity for large
      // streams with infrequent events (e.g. a single 4 MiB reasoning block).
      const scanStart = Math.max(0, prevLen - 3);
      let rel = buffer.slice(scanStart).search(/\r?\n\r?\n/);
      let boundary = rel === -1 ? -1 : scanStart + rel;
      while (boundary !== -1) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, "");
        const event = parseRawEvent(raw);
        if (event !== undefined) this.push(event);
        // After consuming an event the buffer is trimmed; search from 0.
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
  /**
   * Provider display name used in client-visible fallback error messages.
   * Defaults to `"codex"` so all existing Codex error messages are byte-identical.
   */
  readonly providerName?: string;
  /**
   * Fallback message id placed in the `message_start` frame when the upstream
   * response does not provide one. Defaults to `"msg_codex"` for the Codex leg.
   * A second provider should pass its own prefix (e.g. `"msg_kimi"`) so clients
   * see a provider-appropriate id when the upstream omits it.
   */
  readonly messageIdFallback?: string;
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

  // Resolve provider-specific display values once at construction time (not per-chunk)
  // so the hot streaming path stays monomorphic. [preserves performance invariant]
  const providerName = options.providerName ?? "codex";
  const msgIdFallback = options.messageIdFallback ?? "msg_codex";

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
              id: id ?? msgIdFallback,
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
          }
          // reasoning items produce no Anthropic frames; captured at .done.
          break;
        }
        case "response.output_text.delta": {
          const parsed = ResponsesDeltaEventSchema.safeParse(json);
          if (!parsed.success) break;
          const index = lookupBlockIndex(parsed.data.item_id, parsed.data.output_index);
          if (index === undefined) break;
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
          if (index === undefined) break;
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
          }
          break;
        }
        case "response.completed":
        case "response.incomplete": {
          const parsed = ResponsesLifecycleEventSchema.safeParse(json);
          if (!parsed.success) break;
          ensureStarted(parsed.data.response.id, parsed.data.response.model);
          finished = true;
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
              : `${providerName} response failed`;
          ensureStarted();
          emitError("api_error", message);
          break;
        }
        case "error": {
          const parsed = ResponsesErrorEventSchema.safeParse(json);
          const message = parsed.success && parsed.data.message != null ? parsed.data.message : `${providerName} stream error`;
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

export const aggregateFrames = (frames: readonly string[], providerName = "codex"): Result<AggregateOutcome, ProxyError> => {
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
          message: (errorBody?.["message"] as string | undefined) ?? `${providerName} upstream error`,
        });
      }
      default:
        break;
    }
  }

  if (message === undefined) {
    return err({ kind: "upstream", message: `${providerName} stream ended before producing a message` });
  }
  return ok({
    kind: "message",
    message: { ...message, content, stop_reason: stopReason, stop_sequence: null, usage },
  });
};
