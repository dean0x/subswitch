/**
 * The Kimi stream translator: Kimi Anthropic SSE events in, client Anthropic SSE frames out.
 *
 * Each event that the client gets is built again from its known fields only, so no Kimi
 * field that the client must not see can pass. Kimi thinking blocks stay on the server:
 * the translator keeps them for the replay to Kimi and gives the client the other blocks
 * with their indexes renumbered. An error frame and each protocol failure become fixed
 * text, so no Kimi text reaches the client.
 */
import { Transform } from "node:stream";
import { createSseParser, MAX_CONTENT_BLOCKS, type SseEvent } from "./codex-response.js";
import { toAnthropicErrorSse, type AnthropicErrorType } from "./errors.js";
import type { KimiThinkingBlock } from "./kimi-request.js";
import { isPlainObject, object } from "./plain-object.js";
import { reasoningKey } from "./together-request.js";

/** The client text for each error type of a Kimi reply, for a status and for an error frame. */
export const KIMI_REPLY_ERRORS: { readonly [T in AnthropicErrorType]: string } = {
  invalid_request_error: "Kimi refused the request as not valid.",
  authentication_error: "Kimi refused the sign-in. Run `kimi login` in your own Terminal.",
  permission_error: "Kimi refused access for this sign-in.",
  not_found_error: "Kimi did not find the model or the endpoint.",
  request_too_large: "The request is too large for Kimi.",
  rate_limit_error: "Kimi refused the request because of a rate limit. Retry later.",
  api_error: "Kimi returned an error. Retry the request.",
};

const USAGE_KEYS = ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"] as const;
const STOP_REASONS: ReadonlySet<string> = new Set(["end_turn", "max_tokens", "stop_sequence", "tool_use", "pause_turn", "refusal"]);
const MESSAGE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export interface KimiStreamOptions {
  /** The canonical model id that the client gets in message_start. */
  readonly model: string;
  /** Use a fresh UUID per response. Tests can supply a fixed seed. */
  readonly seed: string;
  readonly maxEventBytes: number;
  /** The most thinking bytes that one response can keep for the replay. */
  readonly maxTurnBytes: number;
  readonly conversationKey?: string | undefined;
  readonly putThinking?: (key: string, blocks: readonly KimiThinkingBlock[]) => void;
}

type KimiStreamWarning = "thinking_too_large" | "unknown_event" | "unknown_stop_reason";

interface VisibleBlock { readonly index: number; readonly type: "text" | "tool_use"; open: boolean }
interface ThinkingDraft { readonly type: KimiThinkingBlock["type"]; readonly text: string[]; readonly signature: string[]; open: boolean }

const isErrorType = (value: unknown): value is AnthropicErrorType =>
  typeof value === "string" && Object.hasOwn(KIMI_REPLY_ERRORS, value);

/** Only the known token counts of a usage object. */
const usageOf = (value: unknown): Record<string, number> => {
  const usage: Record<string, number> = {};
  if (!isPlainObject(value)) return usage;
  for (const key of USAGE_KEYS) {
    const count = value[key];
    if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0) usage[key] = count;
  }
  return usage;
};

const parseJson = (data: string): unknown => {
  try { return JSON.parse(data); } catch { return undefined; }
};

const finishDraft = (draft: ThinkingDraft): KimiThinkingBlock => {
  if (draft.type === "redacted_thinking") return { type: "redacted_thinking", data: draft.text.join("") };
  const signature = draft.signature.join("");
  return { type: "thinking", thinking: draft.text.join(""), ...(signature === "" ? {} : { signature }) };
};

export const createKimiSseTranslator = (options: KimiStreamOptions) => {
  const { conversationKey, putThinking, maxTurnBytes } = options;
  const visible = new Map<number, VisibleBlock>();
  const hidden = new Map<number, ThinkingDraft>();
  const thinking: KimiThinkingBlock[] = [];
  const warnings = new Set<KimiStreamWarning>();
  let thinkingBytes = 0;
  let started = false;
  let terminal = false;
  let firstToolId: string | undefined;

  const emit = (data: Readonly<Record<string, unknown>> & { readonly type: string }): void => {
    translator.push(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const fail = (message: string): void => {
    terminal = true;
    translator.push(toAnthropicErrorSse("api_error", message));
  };

  /** Keep a thinking fragment for the replay, or drop all thinking of the turn above the bound. */
  const keep = (parts: string[], fragment: string): void => {
    if (thinkingBytes > maxTurnBytes) return;
    thinkingBytes += Buffer.byteLength(fragment);
    if (thinkingBytes > maxTurnBytes) {
      thinking.length = 0;
      warnings.add("thinking_too_large");
    } else {
      parts.push(fragment);
    }
  };

  const startMessage = (data: Readonly<Record<string, unknown>>): void => {
    if (started) { fail("Kimi stream contained a second message_start"); return; }
    started = true;
    const message = object(data["message"]) ?? {};
    const id = message["id"];
    emit({ type: "message_start", message: {
      id: typeof id === "string" && MESSAGE_ID.test(id) ? id : `msg_${options.seed}`, type: "message", role: "assistant",
      model: options.model, content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0, ...usageOf(message["usage"]) },
    } });
  };

  const startBlock = (data: Readonly<Record<string, unknown>>): void => {
    const index = data["index"];
    const block = data["content_block"];
    if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || index >= MAX_CONTENT_BLOCKS ||
        visible.has(index) || hidden.has(index)) {
      fail("Kimi stream contained an invalid content block index");
      return;
    }
    if (!isPlainObject(block)) { fail("Kimi stream contained an unsupported content block"); return; }
    const { type, text, id, name, input } = block;
    if (type === "thinking" || type === "redacted_thinking") {
      const draft: ThinkingDraft = { type, text: [], signature: [], open: true };
      hidden.set(index, draft);
      const first = type === "thinking" ? block["thinking"] : block["data"];
      if (typeof first !== "string") { fail("Kimi stream contained an unsupported content block"); return; }
      keep(draft.text, first);
      if (typeof block["signature"] === "string") keep(draft.signature, block["signature"]);
      return;
    }
    const client = visible.size;
    if (type === "text" && typeof text === "string") {
      visible.set(index, { index: client, type, open: true });
      emit({ type: "content_block_start", index: client, content_block: { type, text } });
    } else if (type === "tool_use" && typeof id === "string" && id !== "" && typeof name === "string" && name !== "" &&
        (input === undefined || isPlainObject(input))) {
      visible.set(index, { index: client, type, open: true });
      firstToolId ??= id;
      emit({ type: "content_block_start", index: client, content_block: { type, id, name, input: input ?? {} } });
    } else {
      fail("Kimi stream contained an unsupported content block");
    }
  };

  const blockDelta = (data: Readonly<Record<string, unknown>>): void => {
    const index = data["index"];
    const delta = object(data["delta"]) ?? {};
    const draft = typeof index === "number" ? hidden.get(index) : undefined;
    const block = typeof index === "number" ? visible.get(index) : undefined;
    const { type, text, partial_json: partialJson, thinking: thought, signature } = delta;
    if (draft?.open === true && draft.type === "thinking" && type === "thinking_delta" && typeof thought === "string") {
      keep(draft.text, thought);
    } else if (draft?.open === true && draft.type === "thinking" && type === "signature_delta" && typeof signature === "string") {
      keep(draft.signature, signature);
    } else if (block?.open === true && block.type === "text" && type === "text_delta" && typeof text === "string") {
      emit({ type: "content_block_delta", index: block.index, delta: { type, text } });
    } else if (block?.open === true && block.type === "tool_use" && type === "input_json_delta" && typeof partialJson === "string") {
      emit({ type: "content_block_delta", index: block.index, delta: { type, partial_json: partialJson } });
    } else {
      fail("Kimi stream contained an unsupported content delta");
    }
  };

  const stopBlock = (data: Readonly<Record<string, unknown>>): void => {
    const index = data["index"];
    const draft = typeof index === "number" ? hidden.get(index) : undefined;
    const block = typeof index === "number" ? visible.get(index) : undefined;
    if (draft?.open === true) {
      draft.open = false;
      if (thinkingBytes <= maxTurnBytes) thinking.push(finishDraft(draft));
    } else if (block?.open === true) {
      block.open = false;
      emit({ type: "content_block_stop", index: block.index });
    } else {
      fail("Kimi stream closed a content block that is not open");
    }
  };

  const messageDelta = (data: Readonly<Record<string, unknown>>): void => {
    const delta = object(data["delta"]) ?? {};
    const reason = delta["stop_reason"];
    let stopReason: string | null = null;
    if (typeof reason === "string" && STOP_REASONS.has(reason)) {
      stopReason = reason;
    } else if (reason !== null && reason !== undefined) {
      warnings.add("unknown_stop_reason");
      stopReason = "end_turn";
    }
    const sequence = delta["stop_sequence"];
    emit({ type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: typeof sequence === "string" ? sequence : null },
      usage: usageOf(data["usage"]) });
  };

  const stopMessage = (): void => {
    if ([...visible.values()].some((block) => block.open)) {
      fail("Kimi stream ended with an open content block");
      return;
    }
    terminal = true;
    if (firstToolId !== undefined && conversationKey !== undefined && thinking.length > 0) {
      putThinking?.(reasoningKey(conversationKey, firstToolId), [...thinking]);
    }
    emit({ type: "message_stop" });
  };

  const accept = (record: SseEvent): void => {
    if (terminal) return;
    // The shared parser caps pending data. Cap complete payloads before JSON parse.
    if (Buffer.byteLength(record.data) > options.maxEventBytes) { fail("Kimi stream exceeded the event byte limit"); return; }
    const data = parseJson(record.data);
    if (data === undefined) { fail("Kimi stream contained data that is not JSON"); return; }
    if (!isPlainObject(data) || typeof data["type"] !== "string") { fail("Kimi stream contained an event without a type"); return; }
    const type = data["type"];
    if (type === "ping") { emit({ type }); return; }
    if (type === "error") {
      const kimiType = object(data["error"])?.["type"];
      const clientType = isErrorType(kimiType) ? kimiType : "api_error";
      terminal = true;
      translator.push(toAnthropicErrorSse(clientType, KIMI_REPLY_ERRORS[clientType]));
      return;
    }
    if (type === "message_start") { startMessage(data); return; }
    if (!started) { fail("Kimi stream did not start with message_start"); return; }
    switch (type) {
      case "content_block_start": startBlock(data); break;
      case "content_block_delta": blockDelta(data); break;
      case "content_block_stop": stopBlock(data); break;
      case "message_delta": messageDelta(data); break;
      case "message_stop": stopMessage(); break;
      default: warnings.add("unknown_event");
    }
  };

  const translator = new Transform({
    writableObjectMode: true,
    readableObjectMode: true,
    transform(record: SseEvent, _encoding, callback) { accept(record); callback(); },
    flush(callback) {
      if (!terminal) fail("Kimi stream ended before the message was complete");
      callback();
    },
  });

  return {
    parser: createSseParser(options.maxEventBytes),
    translator,
    diagnostics: (): { readonly warnings: readonly KimiStreamWarning[] } => ({ warnings: [...warnings] }),
  };
};
