import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { it } from "node:test";
import { aggregateFrames } from "../../src/codex-response.js";
import type { KimiThinkingBlock } from "../../src/kimi-request.js";
import { createKimiSseTranslator, type KimiStreamOptions } from "../../src/kimi-stream.js";
import { reasoningKey } from "../../src/together-request.js";

type Event = Record<string, unknown> & { readonly type: string };
const sse = (events: readonly Event[]): string =>
  events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");

const messageStart: Event = { type: "message_start", message: {
  id: "msg_kimi_1", type: "message", role: "assistant", model: "kimi-upstream-name", content: [],
  stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1, note: "dropped" },
} };
const thinkingBlock = (index: number, thought: string, signature: string): Event[] => [
  { type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } },
  { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: thought } },
  { type: "content_block_delta", index, delta: { type: "signature_delta", signature } },
  { type: "content_block_stop", index },
];
const textBlock = (index: number, text: string): Event[] => [
  { type: "content_block_start", index, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index, delta: { type: "text_delta", text } },
  { type: "content_block_stop", index },
];
const toolBlock = (index: number, id: string): Event[] => [
  { type: "content_block_start", index, content_block: { type: "tool_use", id, name: "Read", input: {} } },
  { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: '{"path":"a"}' } },
  { type: "content_block_stop", index },
];
const finish = (stopReason: string): Event[] => [
  { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 30 } },
  { type: "message_stop" },
];
const toolTurn: Event[] = [
  messageStart, { type: "ping" },
  ...thinkingBlock(0, "kimi thought fixture", "KIMI-SIGNATURE-FIXTURE"),
  ...textBlock(1, "I will read it"),
  { type: "content_block_start", index: 2, content_block: { type: "redacted_thinking", data: "KIMI-REDACTED-FIXTURE" } },
  { type: "content_block_stop", index: 2 },
  ...toolBlock(3, "toolu_kimi_1"),
  ...finish("tool_use"),
];

const translate = async (events: readonly Event[] | string, overrides: Partial<KimiStreamOptions> = {}) => {
  const puts: [string, readonly KimiThinkingBlock[]][] = [];
  const { parser, translator, diagnostics } = createKimiSseTranslator({
    model: "kimi-for-coding", seed: "seed-a", maxEventBytes: 1024 * 1024, maxTurnBytes: 1024 * 1024,
    conversationKey: "fixture-conversation", putThinking: (key, blocks) => puts.push([key, blocks]), ...overrides,
  });
  const frames: string[] = [];
  await pipeline(Readable.from([Buffer.from(typeof events === "string" ? events : sse(events))]), parser, translator,
    async (source) => { for await (const frame of source) frames.push(String(frame)); });
  return { frames, puts, warnings: diagnostics().warnings };
};

const payloads = (frames: readonly string[]): Event[] =>
  frames.map((frame) => JSON.parse(frame.split("\ndata: ")[1] ?? "") as Event);

const folded = (frames: readonly string[]) => {
  const result = aggregateFrames(frames, "kimi");
  assert.ok(result.ok, JSON.stringify(result));
  return result.value;
};

const assertFailure = (frames: readonly string[], message: string) => {
  assert.deepEqual(folded(frames), { kind: "error", errorType: "api_error", message });
  assert.match(frames.at(-1) ?? "", /^event: error\n/);
};

it("sends no thinking block and no signature to the client, with the block indexes renumbered", async () => {
  const { frames } = await translate(toolTurn);
  const client = frames.join("");
  for (const hidden of ["thinking", "signature", "KIMI-SIGNATURE-FIXTURE", "KIMI-REDACTED-FIXTURE", "kimi thought fixture"]) {
    assert.equal(client.includes(hidden), false, `${hidden} must not reach the client`);
  }
  const blocks = payloads(frames).filter((event) => event.type.startsWith("content_block_"));
  assert.deepEqual(blocks.map((event) => [event.type, event["index"]]), [
    ["content_block_start", 0], ["content_block_delta", 0], ["content_block_stop", 0],
    ["content_block_start", 1], ["content_block_delta", 1], ["content_block_stop", 1],
  ]);
  assert.deepEqual(folded(frames), { kind: "message", message: {
    id: "msg_kimi_1", type: "message", role: "assistant", model: "kimi-for-coding",
    content: [{ type: "text", text: "I will read it" }, { type: "tool_use", id: "toolu_kimi_1", name: "Read", input: { path: "a" } }],
    stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 12, output_tokens: 30 },
  } });
  assert.equal(frames.at(-1), 'event: message_stop\ndata: {"type":"message_stop"}\n\n');
});

it("names the canonical model in message_start and passes ping frames", async () => {
  const { frames } = await translate([messageStart, { type: "ping" }, ...textBlock(0, "hello"), ...finish("end_turn")]);
  const [start, ping] = payloads(frames);
  assert.deepEqual(start, { type: "message_start", message: {
    id: "msg_kimi_1", type: "message", role: "assistant", model: "kimi-for-coding", content: [],
    stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 },
  } });
  assert.deepEqual(ping, { type: "ping" });
});

it("keeps Kimi thinking on the server under the conversation key and the first tool id", async () => {
  const { puts, warnings } = await translate([...toolTurn.slice(0, -2), ...toolBlock(4, "toolu_kimi_2"), ...finish("tool_use")]);
  assert.deepEqual(puts, [[reasoningKey("fixture-conversation", "toolu_kimi_1"), [
    { type: "thinking", thinking: "kimi thought fixture", signature: "KIMI-SIGNATURE-FIXTURE" },
    { type: "redacted_thinking", data: "KIMI-REDACTED-FIXTURE" },
  ]]]);
  assert.deepEqual(warnings, []);
});

it("keeps no thinking for a turn without a tool call or without a conversation key", async () => {
  const textTurn = [messageStart, ...thinkingBlock(0, "kimi thought fixture", "KIMI-SIGNATURE-FIXTURE"), ...textBlock(1, "done"), ...finish("end_turn")];
  assert.deepEqual((await translate(textTurn)).puts, []);
  const unkeyed = await translate(toolTurn, { conversationKey: undefined });
  assert.deepEqual(unkeyed.puts, []);
});

it("keeps no thinking above the turn byte bound and reports it", async () => {
  const { frames, puts, warnings } = await translate(toolTurn, { maxTurnBytes: 8 });
  assert.deepEqual(puts, []);
  assert.deepEqual(warnings, ["thinking_too_large"]);
  assert.equal(folded(frames).kind, "message");
});

it("maps an in-stream error frame to a fixed type and text", async () => {
  const cases = [
    ["overloaded_error", "api_error", "Kimi returned an error. Retry the request."],
    ["rate_limit_error", "rate_limit_error", "Kimi refused the request because of a rate limit. Retry later."],
    ["fixture_unknown_type", "api_error", "Kimi returned an error. Retry the request."],
  ] as const;
  for (const [kimiType, type, message] of cases) {
    const { frames } = await translate([messageStart, ...textBlock(0, "partial"),
      { type: "error", error: { type: kimiType, message: "UPSTREAM-DETAIL-FIXTURE" } }, ...finish("end_turn")]);
    assert.deepEqual(folded(frames), { kind: "error", errorType: type, message });
    assert.equal(frames.join("").includes("UPSTREAM-DETAIL-FIXTURE"), false);
    assert.equal(frames.some((frame) => frame.startsWith("event: message_stop\n")), false);
  }
});

it("fails closed on a signature for a block that the client sees", async () => {
  const { frames } = await translate([messageStart,
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "KIMI-SIGNATURE-FIXTURE" } },
    { type: "content_block_stop", index: 0 }, ...finish("end_turn")]);
  assertFailure(frames, "Kimi stream contained an unsupported content delta");
  assert.equal(frames.join("").includes("KIMI-SIGNATURE-FIXTURE"), false);
});

it("fails closed on a content block type that the client can not take", async () => {
  const { frames } = await translate([messageStart,
    { type: "content_block_start", index: 0, content_block: { type: "server_tool_use", id: "srv_1", name: "web_search", input: {} } },
    ...finish("end_turn")]);
  assertFailure(frames, "Kimi stream contained an unsupported content block");
});

it("fails closed when the stream ends early or a block is still open", async () => {
  const truncated = await translate([messageStart, ...textBlock(0, "partial")]);
  assertFailure(truncated.frames, "Kimi stream ended before the message was complete");
  const open = await translate([messageStart, ...textBlock(0, "partial").slice(0, 2), ...finish("end_turn")]);
  assertFailure(open.frames, "Kimi stream ended with an open content block");
});

it("fails closed on data that is not JSON or a stream that does not start with message_start", async () => {
  assertFailure((await translate("event: message_start\ndata: {not json\n\n")).frames, "Kimi stream contained data that is not JSON");
  assertFailure((await translate(textBlock(0, "early"))).frames, "Kimi stream did not start with message_start");
});
