import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { type Result, ok, err } from "./result.js";
import { type AnthropicErrorType, type ProxyError, toAnthropicErrorSse } from "./errors.js";
import type { Logger } from "./logger.js";
import { providerEvents } from "./provider-events.js";
import type { ProviderId } from "./models.js";
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
      // prefix was consumed in the previous chunk. A newly-completed match must
      // include at least one new byte, so prevLen - (4 - 1) is the earliest it can start.
      //
      // This bounds the REGEX work to O(new bytes), but the overall cost is still
      // quadratic in stream size: `buffer += …` builds a cons-string and `.slice()`
      // forces V8 to flatten it, an O(total buffer) memcpy per chunk. Measured with
      // 8 KiB chunks and a single event: 37ms @2MiB, 138ms @4MiB, 557ms @8MiB —
      // ~3.2x faster than scanning the whole buffer, but the same growth curve.
      // Going genuinely linear means not accumulating into one string: keep the
      // chunks in an array plus a 3-char carry tail, search only carry+chunk, and
      // join on the rare chunk that completes an event (measured 16ms @8MiB).
      // Deliberately not done here — this parser's frame boundaries are pinned by
      // exhaustive split tests and a rewrite belongs in its own change.
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
   * The provider whose stream this translator is reading. Required, and drawn from
   * the closed `ProviderId` union: it names the provider in client-visible fallback
   * error messages, seeds the `message_start` fallback id, and derives this
   * translator's log event names (see `provider-events.ts` — a config-supplied
   * string must never reach an event name).
   */
  readonly providerId: ProviderId;
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
  // Per-block set of indices that received at least one successfully-placed delta.
  // Used in reconcileOpenBlocks to distinguish between:
  //   (a) a dropped delta that lands alongside real content (gracefully degraded) vs
  //   (b) a dropped delta for a turn that produced no other content (unrecoverable).
  // Also used in flush() to decide whether to reconcile open blocks or emit an error.
  const blocksWithContent = new Set<number>();

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
  const providerId = options.providerId;
  const events = providerEvents(providerId);
  // Derived, never independently defaulted: a translator reading a "kimi" stream must
  // not emit id "msg_codex". Codex still resolves to "msg_codex", byte-identical.
  const msgIdFallback = `msg_${providerId}`;

  /** Reconcile blocks the upstream left open at a terminal point, so a response that
   *  carried content upstream is never delivered as a healthy-looking empty turn.
   *
   *  A dropped delta is only unrecoverable when NO block received any content.  If at
   *  least one block received a matched delta, the unknown item's dropped deltas degrade
   *  gracefully — the real content is returned and the dropped delta is silently ignored
   *  (matching main-branch behaviour for unknown item types).
   *
   *  Open blocks that received at least one delta are closed with a synthesised stop,
   *  which lets the aggregator materialise the accumulated deltas.  Open blocks that
   *  received ZERO deltas are intentionally left without a synthesised stop; the
   *  aggregator will discard them as zero-content blocks rather than appending a
   *  spurious empty text block.
   *
   *  Returns true when an error frame was emitted, meaning the caller must not
   *  emit the normal terminal frames. */
  const reconcileOpenBlocks = (push: (frameText: string) => void): boolean => {
    if (sawUnmatchedDelta && blocksWithContent.size === 0) {
      openBlockIndices.clear();
      push(toAnthropicErrorSse("api_error", `${providerId} stream dropped content deltas that matched no content block`));
      return true;
    }
    for (const index of openBlockIndices) {
      if (blocksWithContent.has(index)) {
        push(frame("content_block_stop", { type: "content_block_stop", index }));
      }
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
        options.logger.log("debug", events.sseUnparseableData);
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
            // Skip a duplicate announcement: upstream sometimes re-sends the same
            // item id; creating a second block would orphan the first one.
            if (item.id !== undefined && blockIndexByKey.has(`id:${item.id}`)) break;
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
            // Skip a duplicate announcement (same guard as the message case above).
            if (item.id !== undefined && blockIndexByKey.has(`id:${item.id}`)) break;
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
          blocksWithContent.add(index);
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
          blocksWithContent.add(index);
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
            options.logger.log("debug", events.cacheTokens, { cachedTokens });
          }
          if (options.conversationKey !== undefined) {
            options.logger.log("debug", events.sessionKey, {
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
              : `${providerId} response failed`;
          ensureStarted();
          emitError("api_error", message);
          break;
        }
        case "error": {
          const parsed = ResponsesErrorEventSchema.safeParse(json);
          const message = parsed.success && parsed.data.message != null ? parsed.data.message : `${providerId} stream error`;
          ensureStarted();
          emitError("api_error", message);
          break;
        }
        default:
          options.logger.log("debug", events.sseEventIgnored, { eventType: type });
          break;
      }
      callback();
    },
    flush(callback) {
      if (pingTimer !== undefined) clearInterval(pingTimer);
      pingTimer = undefined;
      // Only reachable when the stream ended without a terminal lifecycle event:
      // response.completed/.incomplete already set `finished` before they return.
      // Guarding on `finished` prevents appending frames after message_stop.
      if (!finished) {
        if (blocksWithContent.size > 0) {
          // At least one block received content before truncation — reconcile open
          // blocks that have content so the accumulated deltas are delivered.
          reconcileOpenBlocks((frameText) => this.push(frameText));
        } else if (started) {
          // The stream opened (message_start was emitted) but no recoverable content
          // arrived and no terminal lifecycle event was received.  This is a truncated
          // stream — emit an error so the client gets 502 rather than a misleading
          // 200 with empty or null content.
          this.push(toAnthropicErrorSse("api_error", `${providerId} stream ended without a terminal event or recoverable content`));
        }
        // If !started: aggregateFrames will return err("no message_start") → 502.
      }
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

export const aggregateFrames = (frames: readonly string[], providerId: ProviderId): Result<AggregateOutcome, ProxyError> => {
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
            input = pending.partialJson.trim() === "" ? {} : JSON.parse(pending.partialJson);
          } catch {
            // partialJson has non-whitespace content but is unparseable JSON — the JSON
            // was likely truncated before the upstream closed the stream. Substituting {}
            // would silently corrupt the tool arguments (e.g. a write_file call with no
            // path). Return an error so the client receives 502 rather than acting on
            // invented empty arguments. Note: partialJson === "" and whitespace-only both
            // fall through to the {} default above; this catch is only hit when there is
            // actual non-whitespace content to parse but it is malformed JSON.
            return err({ kind: "upstream", message: `${providerId} stream ended with unparseable tool_use arguments` });
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
          message: (errorBody?.["message"] as string | undefined) ?? `${providerId} upstream error`,
        });
      }
      default:
        break;
    }
  }

  if (message === undefined) {
    return err({ kind: "upstream", message: `${providerId} stream ended before producing a message` });
  }
  // Every content_block_start must be matched by a content_block_stop before we can
  // assemble a valid response.  The translator's reconcileOpenBlocks() synthesises stops
  // for blocks that received at least one delta; blocks that received zero deltas are
  // intentionally left open (no synthesised stop) so they don't produce spurious empty
  // content entries.  We honour that contract here: error only on unclosed blocks that
  // have actual content, and silently discard unclosed blocks with no content.
  const unclosedWithContent = [...blocks.values()].filter((p) => p.text !== "" || p.partialJson !== "");
  if (unclosedWithContent.length > 0) {
    return err({ kind: "upstream", message: `${providerId} stream ended with ${unclosedWithContent.length} unclosed content block(s)` });
  }
  return ok({
    kind: "message",
    message: { ...message, content, stop_reason: stopReason, stop_sequence: null, usage },
  });
};
