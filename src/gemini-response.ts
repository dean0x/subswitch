import { createHash } from "node:crypto";
import { Transform } from "node:stream";
import { z } from "zod";
import { createSseParser, type SseEvent } from "./codex-response.js";
import { toAnthropicErrorSse } from "./errors.js";
import { renderGeminiUpstreamError, type GeminiAccountBlockLatch, type GeminiErrorCode } from "./gemini-errors.js";
import { geminiClientToolId, geminiSignatureKey, type GeminiSignatureEntry } from "./gemini-request.js";
import { isPlainObject } from "./plain-object.js";
import type { ReasoningCache } from "./reasoning-cache.js";
import { err, ok, type Result } from "./result.js";

const MAX_BLOCKS = 1024;
const MAX_EVENTS = 65_536;
const NO_HEADERS = new Headers();
// [D4] Do not read unqualified usage fields.
const USAGE = { input_tokens: 0, output_tokens: 0 } as const;

const PartSchema = z.object({
  text: z.string().optional(),
  thought: z.boolean().optional(),
  thoughtSignature: z.string().min(1).optional(),
  functionCall: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    args: z.custom(isPlainObject),
  }).optional(),
});
const CandidateSchema = z.object({
  content: z.object({ parts: z.array(PartSchema) }).optional(),
  finishReason: z.string().optional(),
});
const FrameSchema = z.object({
  response: z.object({ candidates: z.tuple([CandidateSchema]).rest(z.unknown()) }),
});
// [D4] Confirm the error envelope. Use only a numeric error code for the offline form.
// In particular, do not infer a reason from an unqualified field or from free text.
const ErrorStatusSchema = z.object({ code: z.number().int().min(400).max(599) });

type Candidate = z.infer<typeof CandidateSchema>;
type Part = z.infer<typeof PartSchema>;
type FrameResult = Result<Candidate, { readonly status?: number }>;

const parseFrame = ({ event, data }: SseEvent): FrameResult => {
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    return err({});
  }
  if (isPlainObject(json) && Object.hasOwn(json, "error")) {
    const status = ErrorStatusSchema.safeParse(json["error"]);
    return err(status.success ? { status: status.data.code } : {});
  }
  if (event === "error") return err({});
  const frame = FrameSchema.safeParse(json);
  return frame.success ? ok(frame.data.response.candidates[0]) : err({});
};

export interface GeminiResponseOptions {
  readonly model: string;
  readonly seed: string;
  readonly maxEventBytes: number;
  readonly conversationKey: string | undefined;
  readonly signatures: Pick<ReasoningCache, "put">;
  readonly accountBlock: GeminiAccountBlockLatch;
  readonly onError: (errorCode: GeminiErrorCode, status?: number) => void;
}

type Emit = (type: string, fields?: Record<string, unknown>) => void;

/** Convert bounded Code Assist SSE records to fresh Anthropic Messages frames. */
export const createGeminiSseTranslator = (options: GeminiResponseOptions) => {
  const { model, seed, maxEventBytes, conversationKey, signatures, accountBlock, onError } = options;
  const calls = new Set<string>();
  const pending = new Map<string, GeminiSignatureEntry>();
  let signatureBytes = 0;
  let events = 0;
  let started = false;
  let stopped = false;
  let failed = false;
  let nextIndex = 0;
  let textIndex: number | undefined;

  const start = (emit: Emit): void => {
    if (started) return;
    started = true;
    emit("message_start", { message: {
      id: `msg_${seed}`, type: "message", role: "assistant", model, content: [],
      stop_reason: null, stop_sequence: null, usage: USAGE,
    } });
  };
  const closeText = (emit: Emit): void => {
    if (textIndex === undefined) return;
    emit("content_block_stop", { index: textIndex });
    textIndex = undefined;
  };
  const appendText = (text: string, emit: Emit): boolean => {
    if (textIndex === undefined) {
      if (nextIndex >= MAX_BLOCKS) return false;
      start(emit);
      textIndex = nextIndex++;
      emit("content_block_start", { index: textIndex, content_block: { type: "text", text: "" } });
    }
    emit("content_block_delta", { index: textIndex, delta: { type: "text_delta", text } });
    return true;
  };
  const appendCall = (call: NonNullable<Part["functionCall"]>, signature: string | undefined, emit: Emit): boolean => {
    const { id, name, args } = call;
    if (nextIndex >= MAX_BLOCKS || Buffer.from(id).toString("utf8") !== id) return false;
    // Keep fixed-size duplicate detectors, not every upstream ID, for the whole turn.
    const digest = createHash("sha256").update(id).digest("hex");
    if (calls.has(digest)) return false;
    let input: string;
    try {
      input = JSON.stringify(args);
    } catch {
      // JSON.parse can accept nesting deeper than the serializer can handle.
      return false;
    }
    if (signature !== undefined && conversationKey !== undefined) {
      const key = geminiSignatureKey(conversationKey, id);
      const entry: GeminiSignatureEntry = [signature];
      signatureBytes += Buffer.byteLength(JSON.stringify([key, entry]));
      // Bound what waits for a clean terminal event, separate from the strict cache.
      if (signatureBytes > maxEventBytes) return false;
      pending.set(key, entry);
    }
    calls.add(digest);
    start(emit);
    closeText(emit);
    const index = nextIndex++;
    emit("content_block_start", { index, content_block: {
      type: "tool_use", id: geminiClientToolId(id, signature !== undefined), name, input: {},
    } });
    emit("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: input } });
    emit("content_block_stop", { index });
    return true;
  };
  const appendPart = (part: Part, emit: Emit): boolean => {
    if (part.functionCall !== undefined) return appendCall(part.functionCall, part.thoughtSignature, emit);
    if (part.thought || part.thoughtSignature !== undefined || part.text === "") return true;
    return part.text !== undefined && appendText(part.text, emit);
  };
  const fail = (push: (frame: string) => void, status?: number): void => {
    failed = true;
    pending.clear();
    const error = renderGeminiUpstreamError(status ?? 502, undefined, NO_HEADERS, accountBlock);
    onError(error.errorCode, status);
    push(toAnthropicErrorSse(error.type, error.message));
  };
  const acceptCandidate = (candidate: Candidate, emit: Emit): boolean => {
    // [D4] Add the finish table after qualification. Only the captured STOP ends a turn.
    const { content, finishReason } = candidate;
    if (stopped || (finishReason !== undefined && finishReason !== "STOP")) return false;
    if (content === undefined && finishReason !== "STOP") return false;
    // The parser's event byte cap bounds the part count and the JSON data per part.
    if (content?.parts.every(part => appendPart(part, emit)) === false) return false;
    stopped = finishReason === "STOP";
    return true;
  };

  const translator = new Transform({
    writableObjectMode: true,
    readableObjectMode: true,
    transform(event: SseEvent, _encoding, done) {
      if (failed) { done(); return; }
      const push = (frame: string): void => { this.push(frame); };
      // The parser's comment records have no data lines. Never relay them.
      if (event.event === "__subswitch_comment" && (event.data === "" || event.data.startsWith(":"))) { done(); return; }
      if (++events > MAX_EVENTS) { fail(push); done(); return; }
      const frame = parseFrame(event);
      const emit: Emit = (type, fields) => push(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
      if (!frame.ok) fail(push, frame.error.status);
      else if (!acceptCandidate(frame.value, emit)) fail(push);
      done();
    },
    flush(done) {
      if (!failed) {
        const push = (frame: string): void => { this.push(frame); };
        if (!stopped) fail(push);
        else {
          const emit: Emit = (type, fields) => push(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
          start(emit);
          closeText(emit);
          for (const [key, entry] of pending) signatures.put(key, entry);
          pending.clear();
          emit("message_delta", { delta: { stop_reason: calls.size > 0 ? "tool_use" : "end_turn", stop_sequence: null },
            usage: { output_tokens: USAGE.output_tokens } });
          emit("message_stop");
        }
      }
      done();
    },
  });
  // Use the shared parser's byte checks for complete events and trailing records.
  return { parser: createSseParser(maxEventBytes, true), translator };
};
