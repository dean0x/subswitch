import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { it } from "node:test";
import { aggregateFrames } from "../../src/codex-response.js";
import { createGeminiAccountBlockLatch } from "../../src/gemini-errors.js";
import { createGeminiSseTranslator, type GeminiResponseOptions } from "../../src/gemini-response.js";
import { ReasoningCache } from "../../src/reasoning-cache.js";

const candidate = (parts: readonly object[], finishReason?: string) => ({
  response: { candidates: [{ content: { role: "model", parts }, finishReason }],
    responseId: "PRIVATE-RESPONSE-ID", usageMetadata: { promptTokenCount: 21 } },
  traceId: "PRIVATE-TRACE-ID",
});
const stop = candidate([{ text: "" }], "STOP");
const call = (id: string) => ({ id, name: "Read", args: { path: "a" }, extra: "PRIVATE-CALL-FIELD" });
const sse = (frame: object) => `data: ${JSON.stringify(frame)}\r\n\r\n`;

const translate = async (wire: readonly string[], overrides: Partial<GeminiResponseOptions> = {}) => {
  const signatures = new ReasoningCache(8, 4096, true);
  const accountBlock = createGeminiAccountBlockLatch();
  const failures: unknown[] = [];
  const { parser, translator } = createGeminiSseTranslator({ model: "gemini-fixture", seed: "fixture",
    maxEventBytes: 4096, conversationKey: "conversation", signatures, accountBlock,
    onError: (code, status) => failures.push([code, status]), ...overrides });
  const frames: string[] = [];
  await pipeline(Readable.from(wire.map(chunk => Buffer.from(chunk))), parser, translator, async source => {
    for await (const chunk of source) frames.push(String(chunk));
  });
  return { frames, wire: frames.join(""), message: aggregateFrames(frames, "gemini"), signatures, accountBlock, failures };
};

it("TP-25: uses tool_use for parallel calls even when Gemini ends with STOP", async () => {
  const { message } = await translate([sse(candidate([
    { functionCall: call("a"), thoughtSignature: "PRIVATE-TOOL-SIGNATURE" }, { functionCall: call("b") },
  ])), sse(stop)]);
  assert.ok(message.ok && message.value.kind === "message");
  assert.equal(message.value.message.stop_reason, "tool_use");
  assert.deepEqual(message.value.message.content, [
    { type: "tool_use", id: "toolu_subswitch_gemini_s_YQ", name: "Read", input: { path: "a" } },
    { type: "tool_use", id: "toolu_subswitch_gemini_u_Yg", name: "Read", input: { path: "a" } },
  ]);
});

it("TP-27: drops thoughts and extra fields and numbers only visible blocks", async () => {
  const output = await translate([sse(candidate([
    { text: "PRIVATE-THOUGHT", thought: true, thoughtSignature: "PRIVATE-THOUGHT-SIGNATURE" },
    { text: "visible", extra: "PRIVATE-TEXT-FIELD" },
    { text: "PRIVATE-SIGNED-TEXT", thoughtSignature: "PRIVATE-TEXT-SIGNATURE" },
    { functionCall: call("a"), thoughtSignature: "PRIVATE-TOOL-SIGNATURE" },
  ])), sse(stop)]);
  assert.doesNotMatch(output.wire, /PRIVATE-|thinking|signature/i);
  assert.deepEqual(output.frames.filter(frame => frame.startsWith("event: content_block_start"))
    .map(frame => /"index":(\d+)/.exec(frame)?.[1]), ["0", "1"]);
  assert.deepEqual(output.signatures.get('["conversation","a"]'), ["PRIVATE-TOOL-SIGNATURE"]);
  assert.equal(output.signatures.size, 1);
});

it("TP-26: maps a malformed error status to one fixed error and no DONE marker", async () => {
  const { wire, failures } = await translate([
    sse(candidate([{ text: "partial" }])), sse({ error: { code: "PRIVATE-STATUS", message: "PRIVATE-ERROR" } }), sse(stop),
  ]);
  assert.deepEqual(failures, [["upstream_error", undefined]]);
  assert.match(wire, /event: error\ndata: \{"type":"error","error":\{"type":"api_error","message":"Gemini did not complete the request\. Retry later\."\}\}/);
  assert.doesNotMatch(wire, /PRIVATE-|NaN|\[DONE\]|event: message_stop/);
});

it("closes text once at EOF and returns one complete Messages object with zero usage", async () => {
  const data = sse(candidate([{ text: "hello" }])) + sse(candidate([{ text: " world" }], "STOP"));
  const { message, wire } = await translate([data.slice(0, 23), data.slice(23)]);
  assert.deepEqual(message, { ok: true, value: { kind: "message", message: {
    id: "msg_fixture", type: "message", role: "assistant", model: "gemini-fixture",
    content: [{ type: "text", text: "hello world" }], stop_reason: "end_turn", stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  } } });
  assert.equal(wire.match(/event: content_block_stop/g)?.length, 1);
  assert.doesNotMatch(wire, /\[DONE\]/);
});

it("does not commit signatures from a truncated or unqualified finish", async () => {
  for (const finishReason of [undefined, "UNQUALIFIED-FINISH"]) {
    const { signatures, failures, wire } = await translate([sse(candidate([
      { functionCall: call("a"), thoughtSignature: "PRIVATE-TOOL-SIGNATURE" },
    ], finishReason))]);
    assert.deepEqual(failures, [["upstream_error", undefined]]);
    assert.equal(signatures.size, 0);
    assert.doesNotMatch(wire, /event: message_stop/);
  }
});

it("refuses malformed arguments instead of returning an empty tool input", async () => {
  const { wire, failures } = await translate([sse(candidate([
    { functionCall: { ...call("a"), args: "PRIVATE-BROKEN-ARGS" } },
  ], "STOP"))]);
  assert.deepEqual(failures, [["upstream_error", undefined]]);
  assert.doesNotMatch(wire, /PRIVATE-|event: content_block_start/);
});

it("refuses tool arguments too deep to serialize before it opens a tool block", async () => {
  const nested = `${"[".repeat(16_384)}0${"]".repeat(16_384)}`;
  const payload = JSON.stringify(candidate([{ functionCall: { ...call("a"), args: "NESTED-ARGS" } }], "STOP"));
  const { wire, failures } = await translate([`data: ${payload.replace('"NESTED-ARGS"', `{"value":${nested}}`)}\n\n`], {
    maxEventBytes: 64 * 1024,
  });
  assert.deepEqual(failures, [["upstream_error", undefined]]);
  assert.doesNotMatch(wire, /event: content_block_start/);
});
