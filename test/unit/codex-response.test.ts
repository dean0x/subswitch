import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { noopLogger } from "../../src/logger.js";
import {
  aggregateFrames,
  createAnthropicSseTranslator,
  createSseParser,
  type SseEvent,
} from "../../src/codex-response.js";

const loadSse = (name: string): string => readFileSync(new URL(`../fixtures/response/${name}`, import.meta.url), "utf8");

const parseSse = async (chunks: readonly Buffer[], maxEventBytes = 1024 * 1024): Promise<SseEvent[]> => {
  const events: SseEvent[] = [];
  await pipeline(Readable.from([...chunks]), createSseParser(maxEventBytes), async (source) => {
    for await (const event of source) events.push(event as SseEvent);
  });
  return events;
};

interface TranslateRun {
  readonly frames: string[];
  readonly reasoningPuts: { callId: string; items: readonly unknown[] }[];
}

const translate = async (sse: string): Promise<TranslateRun> => {
  const frames: string[] = [];
  const reasoningPuts: TranslateRun["reasoningPuts"] = [];
  await pipeline(
    Readable.from([Buffer.from(sse)]),
    createSseParser(1024 * 1024),
    createAnthropicSseTranslator({
      model: "gpt-5.5",
      logger: noopLogger,
      onReasoningItems: (callId, items) => reasoningPuts.push({ callId, items }),
    }),
    async (source) => {
      for await (const frame of source) frames.push(String(frame));
    },
  );
  return { frames, reasoningPuts };
};

const frameTypes = (frames: readonly string[]): string[] =>
  frames.map((frame) => (JSON.parse(frame.split("\n")[1]!.slice(6)) as { type: string }).type);

const frameData = (frame: string): Record<string, unknown> => JSON.parse(frame.split("\n")[1]!.slice(6));

describe("createSseParser", () => {
  it("parses events split across arbitrary chunk boundaries", async () => {
    const sse = loadSse("text-only.sse");
    const bytes = Buffer.from(sse);
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < bytes.length; offset += 7) {
      chunks.push(bytes.subarray(offset, Math.min(offset + 7, bytes.length)));
    }
    const events = await parseSse(chunks);
    assert.equal(events.length, 6);
    assert.equal(events[0]!.event, "response.created");
    assert.match(events[0]!.data, /^\{"type":"response\.created"/);
  });

  it("handles CRLF delimiters and multi-line data", async () => {
    const sse = 'event: e1\r\ndata: {"a":\r\ndata: 1}\r\n\r\n';
    const events = await parseSse([Buffer.from(sse)]);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.data, '{"a":\n1}');
  });

  it("ignores comment and retry lines", async () => {
    const events = await parseSse([Buffer.from(": keepalive\n\nretry: 100\ndata: {}\n\n")]);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.data, "{}");
  });

  it("errors when a single event exceeds the bound", async () => {
    await assert.rejects(
      parseSse([Buffer.from(`data: ${"x".repeat(2048)}`)], 1024),
      /sse_event_too_large/,
    );
  });
});

describe("createAnthropicSseTranslator", () => {
  it("translates a text-only response into the Anthropic event sequence", async () => {
    const { frames } = await translate(loadSse("text-only.sse"));
    assert.deepEqual(frameTypes(frames), [
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    const start = frameData(frames[0]!);
    const message = start["message"] as Record<string, unknown>;
    assert.equal(message["id"], "resp_text1");
    assert.equal(message["model"], "gpt-5.5");
    const delta = frameData(frames[5]!);
    assert.deepEqual(delta["delta"], { stop_reason: "end_turn", stop_sequence: null });
    assert.deepEqual(delta["usage"], { input_tokens: 12, output_tokens: 5 });
  });

  it("translates a tool call and captures its reasoning items", async () => {
    const { frames, reasoningPuts } = await translate(loadSse("tool-call-with-reasoning.sse"));
    const types = frameTypes(frames);
    assert.deepEqual(types, [
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    const blockStart = frameData(frames[1]!);
    assert.deepEqual(blockStart["content_block"], { type: "tool_use", id: "call_abc", name: "list_files", input: {} });
    const argDelta = frameData(frames[2]!);
    assert.deepEqual(argDelta["delta"], { type: "input_json_delta", partial_json: '{"path":' });
    assert.equal((frameData(frames[5]!)["delta"] as Record<string, unknown>)["stop_reason"], "tool_use");

    assert.equal(reasoningPuts.length, 1);
    assert.equal(reasoningPuts[0]!.callId, "call_abc");
    const item = reasoningPuts[0]!.items[0] as Record<string, unknown>;
    assert.equal(item["encrypted_content"], "ENCRYPTED_REASONING_BLOB_1");
  });

  it("attaches shared reasoning to every parallel call id", async () => {
    const { reasoningPuts } = await translate(loadSse("parallel-tool-calls.sse"));
    assert.deepEqual(
      reasoningPuts.map((put) => put.callId),
      ["call_a", "call_b"],
    );
    const first = reasoningPuts[0]!.items[0] as Record<string, unknown>;
    const second = reasoningPuts[1]!.items[0] as Record<string, unknown>;
    assert.equal(first["id"], "rs_par");
    assert.equal(second["id"], "rs_par");
  });

  it("maps incomplete/max_output_tokens to stop_reason max_tokens", async () => {
    const { frames } = await translate(loadSse("max-tokens.sse"));
    const delta = frameData(frames.at(-2)!);
    assert.equal((delta["delta"] as Record<string, unknown>)["stop_reason"], "max_tokens");
  });

  it("translates response.failed into an Anthropic error event", async () => {
    const { frames } = await translate(loadSse("failed.sse"));
    assert.deepEqual(frameTypes(frames), ["message_start", "error"]);
    const error = frameData(frames[1]!)["error"] as Record<string, unknown>;
    assert.equal(error["type"], "api_error");
    assert.equal(error["message"], "upstream exploded");
  });

  it("translates a recorded real transcript (sanitized) end-to-end", async () => {
    const { frames } = await translate(loadSse("live-transcript.sse"));
    assert.deepEqual(frameTypes(frames), [
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_delta",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    const blockStart = frameData(frames[1]!);
    assert.deepEqual(blockStart["content_block"], { type: "tool_use", id: "call_live_1", name: "list_files", input: {} });
    const delta = frameData(frames.at(-2)!);
    assert.equal((delta["delta"] as Record<string, unknown>)["stop_reason"], "tool_use");
    assert.deepEqual(delta["usage"], { input_tokens: 66, output_tokens: 18 });

    const aggregated = aggregateFrames(frames);
    assert.ok(aggregated.ok);
    const message = aggregated.value.kind === "message" ? aggregated.value.message : {};
    assert.deepEqual(message["content"], [{ type: "tool_use", id: "call_live_1", name: "list_files", input: { path: "." } }]);
  });

  it("ignores unknown event types without disturbing the stream", async () => {
    const { frames } = await translate(loadSse("unknown-events.sse"));
    assert.deepEqual(frameTypes(frames), [
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
  });
});

describe("aggregateFrames", () => {
  it("folds streamed frames into a complete message", async () => {
    const { frames } = await translate(loadSse("tool-call-with-reasoning.sse"));
    const result = aggregateFrames(frames);
    assert.ok(result.ok);
    assert.equal(result.value.kind, "message");
    const message = result.value.kind === "message" ? result.value.message : {};
    assert.equal(message["stop_reason"], "tool_use");
    assert.deepEqual(message["content"], [{ type: "tool_use", id: "call_abc", name: "list_files", input: { path: "." } }]);
    assert.deepEqual(message["usage"], { input_tokens: 40, output_tokens: 18 });
  });

  it("folds text frames into a text message", async () => {
    const { frames } = await translate(loadSse("text-only.sse"));
    const result = aggregateFrames(frames);
    assert.ok(result.ok);
    const message = result.value.kind === "message" ? result.value.message : {};
    assert.deepEqual(message["content"], [{ type: "text", text: "Hello from codex" }]);
    assert.equal(message["stop_reason"], "end_turn");
  });

  it("surfaces stream errors as an error outcome", async () => {
    const { frames } = await translate(loadSse("failed.sse"));
    const result = aggregateFrames(frames);
    assert.ok(result.ok);
    assert.equal(result.value.kind, "error");
  });

  it("errors when no message was produced", () => {
    const result = aggregateFrames([]);
    assert.ok(!result.ok);
    assert.equal(result.error.kind, "upstream");
  });
});
