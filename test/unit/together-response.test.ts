import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { it } from "node:test";
import { aggregateFrames, MAX_CONTENT_BLOCKS } from "../../src/codex-response.js";
import { createTogetherSseTranslator, mapTogetherErrorJson, type TogetherTranslatorOptions } from "../../src/together-response.js";
import { lateToolNames, repeatedToolIds, textTurn, toolDelta } from "../fixtures/together/streams.js";
import { chatChunk, chatSse } from "../helpers/chat-sse.js";

const translate = async (body: string | readonly Buffer[], overrides: Partial<TogetherTranslatorOptions> = {}) => {
  const { parser, translator, diagnostics } = createTogetherSseTranslator({
    model: "org/test-model", seed: "response-a", maxEventBytes: 4 * 1024 * 1024, ...overrides,
  });
  const frames: string[] = [];
  await pipeline(Readable.from(typeof body === "string" ? [Buffer.from(body)] : body), parser, translator,
    async (source) => { for await (const frame of source) frames.push(String(frame)); });
  return { frames, ...diagnostics() };
};

// Use the same frame fold as the translated leg. The ID here names only the fold's error text.
const fold = (frames: readonly string[]) => {
  const result = aggregateFrames(frames, "codex");
  assert.ok(result.ok, JSON.stringify(result));
  return result.value;
};

const message = (frames: readonly string[]) => {
  const outcome = fold(frames);
  assert.equal(outcome.kind, "message");
  if (outcome.kind === "message") return outcome.message;
  return assert.fail("Expected a message");
};

const assertError = (frames: readonly string[], text: string) => {
  assert.deepEqual(fold(frames), { kind: "error", errorType: "api_error", message: text });
  assert.match(frames.at(-1) ?? "", /^event: error\n/);
  assert.ok(!frames.some((frame) => frame.startsWith("event: message_stop\n")));
};

it("joins late tool names and argument fragments by index before DONE", async () => {
  const { frames, warnings } = await translate(lateToolNames);
  const response = message(frames);
  assert.deepEqual(response["content"], [
    { type: "tool_use", id: "toolu_response-a_0", name: "first", input: { a: 1 } },
    { type: "tool_use", id: "toolu_response-a_1", name: "second", input: { b: 2 } },
  ]);
  assert.equal(response["stop_reason"], "tool_use");
  assert.deepEqual(response["usage"], { input_tokens: 37, output_tokens: 11 });
  assert.deepEqual(warnings, []);
  assert.equal(frames.at(-1), 'event: message_stop\ndata: {"type":"message_stop"}\n\n');
});

it("keeps IDs stable for one seed and independent of all upstream IDs", async () => {
  const first = await translate(repeatedToolIds);
  assert.deepEqual((await translate(repeatedToolIds)).frames, first.frames);
  const content = (seed: string) => ["first", "second", "third", "fourth"].map((name, index) => ({
    type: "tool_use", name, input: {}, id: `toolu_${seed}_${index}`,
  }));
  assert.deepEqual(message(first.frames)["content"], content("response-a"));
  assert.deepEqual(message((await translate(repeatedToolIds, { seed: "response-b" })).frames)["content"], content("response-b"));
  assert.doesNotMatch(first.frames.join(""), /repeated_upstream_id|upstream\|invalid/);
});

for (const [reason, stop, warnings] of [
  ["eos", "end_turn", ["usage_missing"]],
  ["length", "max_tokens", ["usage_missing"]],
  ["unrecognized_upstream_reason", "end_turn", ["unknown_finish_reason", "usage_missing"]],
] as const) {
  it(`maps ${reason} and reports closed warning codes`, async () => {
    const { frames, warnings: actual } = await translate(textTurn(reason));
    assert.equal(message(frames)["stop_reason"], stop);
    assert.deepEqual(message(frames)["content"], [{ type: "text", text: "Hello" }]);
    assert.deepEqual(actual, warnings);
    assert.ok(!frames.join("").includes(reason));
  });
}

it("closes text with max_tokens at EOF without a finish reason", async () => {
  const { frames } = await translate(chatSse([chatChunk({ content: "partial" })]));
  assert.deepEqual(message(frames)["content"], [{ type: "text", text: "partial" }]);
  assert.equal(message(frames)["stop_reason"], "max_tokens");
  assert.deepEqual(frames.slice(-3).map((frame) => frame.split("\n", 1)[0]), [
    "event: content_block_stop", "event: message_delta", "event: message_stop",
  ]);
});

it("does not materialize tool metadata with no argument delta at truncation", async () => {
  const { frames } = await translate(chatSse([
    chatChunk({ content: "partial", tool_calls: [toolDelta(0, "not_ready")] }), "[DONE]",
  ]));
  assert.deepEqual(message(frames)["content"], [{ type: "text", text: "partial" }]);
  assert.doesNotMatch(frames.join(""), /not_ready/);
});

it("emits an error at DONE if a truncated turn has no recoverable content", async () => {
  const { frames } = await translate(chatSse([
    chatChunk({ role: "assistant" }), "[DONE]", chatChunk({ content: "too late" }, "stop"),
  ]));
  assertError(frames, "Together stream ended without a finish reason or recoverable content");
});

it("preserves a tool call with complete arguments at EOF without a finish reason", async () => {
  const { frames } = await translate(chatSse([chatChunk({ tool_calls: [toolDelta(0, "tool", '{"a":1}')] })]));
  assert.deepEqual(message(frames)["content"], [{ type: "tool_use", id: "toolu_response-a_0", name: "tool", input: { a: 1 } }]);
  assert.equal(message(frames)["stop_reason"], "max_tokens");
});

it("fails a truncated tool call without exposing incomplete tool arguments", async () => {
  const { frames } = await translate(chatSse([chatChunk({ tool_calls: [toolDelta(0, "tool", '{"a":')] })]));
  assertError(frames, "Together stream contained invalid tool arguments");
  assert.doesNotMatch(frames.join(""), /tool_use|input_json_delta/);
});

it("preserves a legitimately empty finished turn", async () => {
  const { frames } = await translate(chatSse([chatChunk({ content: "" }, "stop"), "[DONE]"]));
  assert.deepEqual(message(frames)["content"], []);
  assert.equal(message(frames)["stop_reason"], "end_turn");
});

it("rejects a tool-call count above the shared block cap when text occupies a block", async () => {
  const calls = Array.from({ length: MAX_CONTENT_BLOCKS }, (_, index) => toolDelta(index, "tool", "{}"));
  const { frames } = await translate(chatSse([chatChunk({ content: "hello", tool_calls: calls }), chatChunk({}, "stop"), "[DONE]"]));
  assertError(frames, "Together stream exceeded the content block limit");
});

for (const index of [-1, MAX_CONTENT_BLOCKS]) {
  it(`rejects tool index ${index} outside the allowed range`, async () => {
    const { frames } = await translate(chatSse([chatChunk({ tool_calls: [toolDelta(index, "tool", "{}")] }), chatChunk({}, "stop")]));
    assertError(frames, "Together stream contained a tool index out of range");
  });
}

it("bounds total held argument bytes across distinct calls and chunks", async () => {
  const args = JSON.stringify({ value: "é".repeat(256 * 1024) });
  const { frames } = await translate(chatSse([
    chatChunk({ tool_calls: [toolDelta(0, "first", args)] }),
    chatChunk({ tool_calls: [toolDelta(1, "second", args)] }), chatChunk({}, "stop"),
  ]));
  assertError(frames, "Together stream exceeded the tool argument byte limit");
});

it("counts unparsable records and fails a turn that could have lost text", async () => {
  const { frames, unparsableChunks } = await translate(
    chatSse([chatChunk({ content: "hello" })]) + 'data: {"choices":[{"delta":{"content":"missing\n\ndata: {"choices":null}\n\n'
      + chatSse([chatChunk({}, "stop"), "[DONE]"]),
  );
  assert.equal(unparsableChunks, 2);
  assertError(frames, "Together stream contained unparsable chunks");
});

it("stores exact reasoning once under the first emitted tool ID", async () => {
  const puts: string[][] = [];
  const { frames } = await translate(chatSse([
    chatChunk({ reasoning_content: " first\n", reasoning: "duplicate", tool_calls: [toolDelta(1, "second", "{}")] }),
    chatChunk({ reasoning: "last ", tool_calls: [toolDelta(0, "first", "{}")] }), chatChunk({}, "stop"), "[DONE]",
  ]), { conversationKey: "conversation", putReasoning: (...entry) => { puts.push(entry); } });
  assert.deepEqual(puts, [["conversation|toolu_response-a_0", " first\nlast "]]);
  assert.doesNotMatch(frames.join(""), /thinking|first\\nlast|duplicate/);
});

it("drops the full reasoning at overflow and warns once for the turn", async () => {
  const puts: string[][] = [];
  const { frames, warnings } = await translate(chatSse([
    chatChunk({ reasoning_content: "é".repeat(256 * 1024) }),
    chatChunk({ reasoning_content: "é".repeat(256 * 1024) + "!" }),
    chatChunk({ reasoning_content: "also too large", tool_calls: [toolDelta(0, "tool", "{}")] }), chatChunk({}, "stop"), "[DONE]",
  ]), { conversationKey: "conversation", putReasoning: (...entry) => { puts.push(entry); } });
  assert.deepEqual(puts, []);
  assert.deepEqual(warnings, ["reasoning_too_large", "usage_missing"]);
  assert.equal(message(frames)["stop_reason"], "tool_use");
});

it("does not store reasoning without a conversation key", async () => {
  const puts: string[][] = [];
  const { frames } = await translate(chatSse([
    chatChunk({ reasoning_content: "reason", tool_calls: [toolDelta(0, "tool", "{}")] }), chatChunk({}, "stop"), "[DONE]",
  ]), { putReasoning: (...entry) => { puts.push(entry); } });
  assert.deepEqual(puts, []);
  assert.equal(message(frames)["stop_reason"], "tool_use");
});

it("maps JSON and SSE error objects to fixed text and permits only strict codes", async () => {
  const message = "FAKE-TOGETHER-KEY-must-not-appear";
  const error = { error: { code: "service_unavailable", message } };
  assert.equal(mapTogetherErrorJson(error), "Together upstream error (service_unavailable)");
  for (const code of [undefined, 401, "", "x".repeat(65), "x\n", "UPPER", message]) {
    assert.equal(mapTogetherErrorJson({ error: { code, message } }), "Together upstream error");
  }
  assert.equal(mapTogetherErrorJson({ choices: [] }), undefined);
  const { frames } = await translate(chatSse([chatChunk({ content: "start" }), error, "[DONE]"]));
  assertError(frames, "Together upstream error (service_unavailable)");
  assert.doesNotMatch(frames.join(""), /FAKE-TOGETHER-KEY/);
});

it("uses the shared parser for split UTF-8 and ignores comment records", async () => {
  const body = Buffer.from(": heartbeat\r\n\r\n" + chatSse([chatChunk({ content: "é" }, "stop"), "[DONE]"]));
  const split = body.indexOf(Buffer.from("é")) + 1;
  const { frames, unparsableChunks } = await translate([body.subarray(0, split), body.subarray(split)]);
  assert.deepEqual(message(frames)["content"], [{ type: "text", text: "é" }]);
  assert.equal(unparsableChunks, 0);
});

it("rejects an over-limit data record even if it arrives in one read", async () => {
  const { frames } = await translate(chatSse([chatChunk({ content: "é".repeat(60) }, "stop"), "[DONE]"]), {
    maxEventBytes: 180,
  });
  assertError(frames, "Together stream exceeded the event byte limit");
});

it("does not discard JSON data in a record with the parser's comment name", async () => {
  const { frames } = await translate(`event: __subswitch_comment\n${textTurn("stop")}`);
  assert.deepEqual(message(frames)["content"], [{ type: "text", text: "Hello" }]);
  const error = chatSse([{ error: { code: "service_unavailable" } }, "[DONE]"]);
  assertError((await translate(`event: __subswitch_comment\n${error}`)).frames, "Together upstream error (service_unavailable)");
});
