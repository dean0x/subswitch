import { Transform } from "node:stream";
import { z } from "zod";
import { createSseParser, MAX_CONTENT_BLOCKS, type SseEvent } from "./codex-response.js";
import { toAnthropicErrorSse } from "./errors.js";
import { isPlainObject } from "./plain-object.js";
import { reasoningKey } from "./together-request.js";

const MAX_ARGUMENT_BYTES = 1024 * 1024; // Across all calls in one response.
const MAX_REASONING_BYTES = 1024 * 1024;

const ToolDelta = z.object({
  index: z.int(),
  function: z.object({ name: z.string().max(64).nullish(), arguments: z.string().nullish() }).nullish(),
});
const ChatChunk = z.object({
  choices: z.array(z.object({
    index: z.literal(0).optional(),
    finish_reason: z.string().nullish(),
    delta: z.object({
      content: z.string().nullish(),
      reasoning_content: z.string().nullish(),
      reasoning: z.string().nullish(),
      tool_calls: z.array(ToolDelta).max(MAX_CONTENT_BLOCKS).nullish(),
    }).nullish(),
  })).max(1),
  usage: z.object({ prompt_tokens: z.int().nonnegative(), completion_tokens: z.int().nonnegative() }).nullish(),
});
const ErrorEnvelope = z.object({ error: z.object({ code: z.unknown().optional() }) });
const ErrorCode = /^[a-z0-9_]{1,64}$/;

/** Return safe text for a parsed JSON error envelope, or undefined for a non-error body. */
export const mapTogetherErrorJson = (body: unknown): string | undefined => {
  const parsed = ErrorEnvelope.safeParse(body);
  if (!parsed.success) return undefined;
  const { code } = parsed.data.error;
  return typeof code === "string" && ErrorCode.test(code)
    ? `Together upstream error (${code})`
    : "Together upstream error";
};

const parseJson = (data: string): unknown => {
  try { return JSON.parse(data); } catch { return undefined; }
};

export interface TogetherTranslatorOptions {
  readonly model: string;
  /** Use a fresh UUID per response. Tests can supply a fixed seed. */
  readonly seed: string;
  readonly maxEventBytes: number;
  readonly conversationKey?: string;
  readonly putReasoning?: (key: string, text: string) => void;
}

type TogetherStreamWarning = "unknown_finish_reason" | "usage_missing" | "reasoning_too_large";
interface TogetherStreamDiagnostics {
  readonly warnings: readonly TogetherStreamWarning[];
  readonly unparsableChunks: number;
}

type ToolCall = { name?: string; readonly arguments: string[] };
type ReadyTool = { readonly id: string; readonly name: string; readonly arguments: string };
type StopReason = "end_turn" | "tool_use" | "max_tokens";

const stopReason = (reason: string | undefined, hasTools: boolean): StopReason | undefined => {
  switch (reason) {
    case "stop": return hasTools ? "tool_use" : "end_turn";
    case "eos": return "end_turn";
    case "length":
    case undefined: return "max_tokens";
    case "tool_calls":
    case "function_call": return "tool_use";
    default: return undefined;
  }
};

export const createTogetherSseTranslator = (options: TogetherTranslatorOptions) => {
  const tools = new Map<number, ToolCall>();
  const warnings: TogetherStreamWarning[] = [];
  const reasoning: string[] = [];
  const { conversationKey, putReasoning } = options;
  let reasoningBytes = 0;
  let argumentsBytes = 0;
  let unparsableChunks = 0;
  let started = false;
  let terminal = false;
  let hasText = false;
  let finishReason: string | undefined;
  let firstToolId: string | undefined;
  let usage: z.infer<typeof ChatChunk>["usage"];

  const emit = (type: string, data: Record<string, unknown> = {}): void => {
    translator.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  };

  const fail = (message: string): void => {
    terminal = true;
    translator.push(toAnthropicErrorSse("api_error", message));
  };

  const start = (): void => {
    if (started) return;
    started = true;
    emit("message_start", { message: {
      id: `msg_${options.seed}`, type: "message", role: "assistant", model: options.model,
      content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 },
    } });
  };

  const appendText = (text: string): void => {
    if (!hasText) {
      if (tools.size >= MAX_CONTENT_BLOCKS) {
        fail("Together stream exceeded the content block limit");
        return;
      }
      start();
      emit("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      hasText = true;
    }
    emit("content_block_delta", { index: 0, delta: { type: "text_delta", text } });
  };

  const appendTools = (deltas: readonly z.infer<typeof ToolDelta>[]): void => {
    for (const delta of deltas) {
      if (delta.index < 0 || delta.index >= MAX_CONTENT_BLOCKS) {
        fail("Together stream contained a tool index out of range");
        return;
      }
      let call = tools.get(delta.index);
      if (call === undefined) {
        if (tools.size + Number(hasText) >= MAX_CONTENT_BLOCKS) {
          fail("Together stream exceeded the content block limit");
          return;
        }
        call = { arguments: [] };
        tools.set(delta.index, call);
      }
      const name = delta.function?.name;
      if (name) call.name ??= name;
      const args = delta.function?.arguments;
      if (args) {
        argumentsBytes += Buffer.byteLength(args);
        if (argumentsBytes > MAX_ARGUMENT_BYTES) {
          fail("Together stream exceeded the tool argument byte limit");
          return;
        }
        call.arguments.push(args);
      }
    }
  };

  const appendReasoning = (text: string): void => {
    if (reasoningBytes > MAX_REASONING_BYTES) return;
    reasoningBytes += Buffer.byteLength(text);
    if (reasoningBytes > MAX_REASONING_BYTES) {
      reasoning.length = 0;
      warnings.push("reasoning_too_large");
    } else if (conversationKey !== undefined && putReasoning !== undefined) {
      reasoning.push(text);
    }
  };

  // A call needs argument data. An explicit length stop can leave JSON incomplete.
  // Stream its partial arguments with max_tokens. The shared fold rejects them for a JSON reply.
  const readyTools = (): ReadyTool[] | undefined => {
    const ready: ReadyTool[] = [];
    for (const [index, call] of [...tools].sort(([a], [b]) => a - b)) {
      const args = call.arguments.join("");
      if (args.trim() === "") continue;
      const input = parseJson(args);
      const partial = finishReason === "length" && input === undefined;
      if (call.name === undefined || (!partial && !isPlainObject(input))) return undefined;
      ready.push({ id: `toolu_${options.seed}_${index}`, name: call.name, arguments: args });
    }
    return ready;
  };

  const closeBlocks = (): void => {
    const ready = readyTools();
    if (ready === undefined) {
      fail("Together stream contained invalid tool arguments");
      return;
    }
    if (finishReason === undefined && !hasText && ready.length === 0) {
      fail("Together stream ended without a finish reason or recoverable content");
      return;
    }
    if (ready.length === 0 && (finishReason === "tool_calls" || finishReason === "function_call" || (!hasText && tools.size > 0))) {
      fail("Together stream contained no complete tool call");
      return;
    }
    start();
    if (hasText) emit("content_block_stop", { index: 0 });
    for (const [offset, call] of ready.entries()) {
      const index = Number(hasText) + offset;
      emit("content_block_start", { index, content_block: { type: "tool_use", id: call.id, name: call.name, input: {} } });
      emit("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: call.arguments } });
      emit("content_block_stop", { index });
    }
    firstToolId = ready[0]?.id;
  };

  const seal = (): void => {
    if (terminal) return;
    if (unparsableChunks > 0) {
      fail("Together stream contained unparsable chunks");
      return;
    }
    // At EOF without a finish reason, recover any blocks that still have content.
    if (finishReason === undefined) closeBlocks();
    if (terminal) return;
    terminal = true;
    if (firstToolId !== undefined && conversationKey !== undefined && reasoning.length > 0) {
      putReasoning?.(reasoningKey(conversationKey, firstToolId), reasoning.join(""));
    }
    const stop = stopReason(finishReason, firstToolId !== undefined);
    if (stop === undefined) warnings.push("unknown_finish_reason");
    if (usage == null) warnings.push("usage_missing");
    emit("message_delta", {
      delta: { stop_reason: stop ?? "end_turn", stop_sequence: null },
      usage: { input_tokens: usage?.prompt_tokens ?? 0, output_tokens: usage?.completion_tokens ?? 0 },
    });
    emit("message_stop");
  };

  const accept = (record: SseEvent): void => {
    if (terminal) return;
    if (record.data === "[DONE]") { seal(); return; }
    // The shared parser caps pending data. Cap complete payloads before JSON parse.
    if (Buffer.byteLength(record.data) > options.maxEventBytes) {
      fail("Together stream exceeded the event byte limit");
      return;
    }
    const json = parseJson(record.data);
    const error = mapTogetherErrorJson(json);
    if (error !== undefined) { fail(error); return; }
    const parsed = ChatChunk.safeParse(json);
    if (!parsed.success) { unparsableChunks++; return; }
    // A post-finish chunk may carry usage but cannot add content.
    usage = parsed.data.usage ?? usage;
    if (unparsableChunks > 0 || finishReason !== undefined) return;
    const choice = parsed.data.choices[0];
    if (choice === undefined) return;
    const delta = choice.delta;
    if (delta?.content) appendText(delta.content);
    if (!terminal && delta?.tool_calls) appendTools(delta.tool_calls);
    const thought = delta?.reasoning_content ?? delta?.reasoning;
    if (!terminal && thought) appendReasoning(thought);
    finishReason = choice.finish_reason ?? undefined;
    if (!terminal && finishReason !== undefined) closeBlocks();
  };

  const translator = new Transform({
    writableObjectMode: true,
    readableObjectMode: true,
    transform(record: SseEvent, _encoding, callback) { accept(record); callback(); },
    flush(callback) { seal(); callback(); },
  });

  return {
    parser: createSseParser(options.maxEventBytes),
    translator,
    diagnostics: (): TogetherStreamDiagnostics => ({ warnings: [...warnings], unparsableChunks }),
  };
};
