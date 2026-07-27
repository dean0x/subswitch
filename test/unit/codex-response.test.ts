import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { noopLogger, createConsoleLogger } from "../../src/logger.js";
import type { ProviderId } from "../../src/models.js";
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

/**
 * SYNTHETIC-PROVIDER CAST — the single sanctioned cast in this file.
 *
 * `providerId` is now required and typed as the closed `ProviderId` union, which is
 * `"codex"` alone today. A test that can only ever pass `"codex"` cannot distinguish a
 * threaded provider id from a hardcoded literal, so every assertion about
 * parameterization would be vacuous. Casting through `string` (not a direct
 * `as ProviderId`, which TypeScript rejects outright) buys a second value to test with.
 *
 * Remove this helper and all its callers when a second real provider lands and
 * PROVIDER_IDS expands. (mirrors test/unit/routing-table.test.ts)
 */
const otherProviderName: string = "kimi";
const OTHER_PROVIDER = otherProviderName as ProviderId;

const translate = async (sse: string, options: { readonly providerId?: ProviderId } = {}): Promise<TranslateRun> => {
  const frames: string[] = [];
  const reasoningPuts: TranslateRun["reasoningPuts"] = [];
  await pipeline(
    Readable.from([Buffer.from(sse)]),
    createSseParser(1024 * 1024),
    createAnthropicSseTranslator({
      model: "gpt-5.5",
      logger: noopLogger,
      onReasoningItems: (callId, items) => reasoningPuts.push({ callId, items }),
      providerId: options.providerId ?? "codex",
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

/** Client-visible message carried by the stream's error frame, or undefined if there is none. */
const errorFrameMessage = (frames: readonly string[]): string | undefined => {
  const errorFrame = frames.find((f) => frameData(f)["type"] === "error");
  if (errorFrame === undefined) return undefined;
  return (frameData(errorFrame)["error"] as Record<string, unknown>)["message"] as string;
};

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

  it("parses correctly when the \\r\\n\\r\\n separator straddles a chunk boundary", async () => {
    // SSE events split so the FIRST separator (\r\n\r\n) falls across two chunks.
    // Before the O(S²/C) fix, scanning always restarted from 0 — this test verifies
    // that the scanStart offset does not skip any boundary straddling the split point.
    // Three bytes of slack (prevLen - 3) is exactly what a 4-byte separator needs to
    // be found when it begins in the previous chunk; remove the slack and it is missed.
    //
    // The SECOND event is load-bearing, not decoration. With a single event, flush()
    // re-parses the whole leftover buffer at EOF and recovers it even when the scan
    // never found the boundary at all — so a one-event fixture passes against a parser
    // whose boundary search is entirely broken. With two events, a missed boundary
    // makes flush() fold both into one record (eventName overwritten, data lines
    // concatenated), and the count assertion fires.
    const first = "event: first\r\ndata: one\r\n";
    const second = "event: second\r\ndata: two\r\n";
    const full = `${first}\r\n${second}\r\n`;
    // Split one byte into the first separator: chunk 1 ends with \r\n\r, chunk 2 starts with \n.
    const splitAt = first.length + 1;
    const chunks = [Buffer.from(full.slice(0, splitAt)), Buffer.from(full.slice(splitAt))];
    const events = await parseSse(chunks);
    assert.equal(
      events.length,
      2,
      "the straddled boundary must be found by the scan — one event here means flush() folded both together",
    );
    assert.equal(events[0]!.event, "first");
    assert.equal(events[0]!.data, "one");
    assert.equal(events[1]!.event, "second");
    assert.equal(events[1]!.data, "two");
  });

  it("produces all events when a large event body arrives in many small chunks", async () => {
    // Regression guard for the O(S²/C) scan pattern: a 64 KB data payload
    // arriving in 1-byte chunks would previously cause ~2B char comparisons.
    // This test verifies correctness under that delivery pattern.
    const payload = "x".repeat(64 * 1024);
    const sse = `data: ${payload}\n\ndata: second\n\n`;
    const chunks = [...Buffer.from(sse)].map((b) => Buffer.from([b]));
    const events = await parseSse(chunks, 128 * 1024);
    assert.equal(events.length, 2);
    assert.equal(events[0]!.data, payload);
    assert.equal(events[1]!.data, "second");
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

    const aggregated = aggregateFrames(frames, "codex");
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

  // P1-6: these tests belong here (translator behaviour), not in "cache observability".
  it("closes a block left open by a missing output_item.done before the terminal frames", async () => {
    // response.completed arrives before output_item.done, so the upstream never closes
    // the block. The synthesised stop must land before message_stop: a streaming client
    // that receives a content_block_stop after the terminal frame sees a corrupt stream.
    const { frames } = await translate(loadSse("completed-before-done.sse"));
    assert.deepEqual(frameTypes(frames), [
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
  });

  it("errors on dropped deltas even when every block was closed", async () => {
    // The delta's item_id matches no block, so its text is dropped, but output_item.done
    // still closes the block. Without an error the client would receive HTTP 200 and an
    // empty text block while the upstream had actually produced content.
    const { frames } = await translate(loadSse("delta-id-mismatch.sse"));
    const types = frameTypes(frames);
    assert.ok(types.includes("error"), `expected an error frame, got ${types.join(",")}`);
    assert.ok(!types.includes("message_stop"), "terminal frames must not follow the error frame");
    const result = aggregateFrames(frames, "codex");
    assert.ok(result.ok);
    assert.equal(result.value.kind, "error");
  });

  // P0-2 Variant A: block opened, no delta, EOF before terminal event → must be error, not 200.
  it("emits error when stream ends with an opened block but no deltas and no terminal event", async () => {
    const sse = [
      'event: response.created',
      'data: {"type":"response.created","response":{"id":"r7","model":"gpt-5.5","status":"in_progress"}}',
      '',
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"m7","role":"assistant"}}',
      '',
      '',
    ].join('\n');
    const { frames } = await translate(sse);
    assert.ok(frameTypes(frames).includes("error"), `expected error frame, got: ${frameTypes(frames).join(",")}`);
    const result = aggregateFrames(frames, "codex");
    assert.ok(result.ok);
    assert.equal(result.value.kind, "error");
  });

  // P0-2 Variant B: response.created only, EOF before any output block → must be error, not 200.
  it("emits error when stream ends after response.created with no output blocks and no terminal event", async () => {
    const sse = [
      'event: response.created',
      'data: {"type":"response.created","response":{"id":"r8","model":"gpt-5.5","status":"in_progress"}}',
      '',
      '',
    ].join('\n');
    const { frames } = await translate(sse);
    assert.ok(frameTypes(frames).includes("error"), `expected error frame, got: ${frameTypes(frames).join(",")}`);
    const result = aggregateFrames(frames, "codex");
    assert.ok(result.ok);
    assert.equal(result.value.kind, "error");
  });

  // P1-3: duplicate output_item.added with the same item id must not create a second block.
  it("ignores duplicate output_item.added for the same item id (no spurious empty block)", async () => {
    const sse = [
      'event: response.created',
      'data: {"type":"response.created","response":{"id":"resp_dup","model":"gpt-5.5","status":"in_progress"}}',
      '',
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_dup","role":"assistant"}}',
      '',
      // Duplicate announcement — must be ignored.
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_dup","role":"assistant"}}',
      '',
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","item_id":"msg_dup","output_index":0,"delta":"real content"}',
      '',
      'event: response.output_item.done',
      'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"msg_dup","role":"assistant"}}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_dup","model":"gpt-5.5","status":"completed","usage":{"input_tokens":5,"output_tokens":3}}}',
      '',
      '',
    ].join('\n');
    const { frames } = await translate(sse);
    assert.ok(!frameTypes(frames).includes("error"), `must not produce error frame; got: ${frameTypes(frames).join(",")}`);
    const result = aggregateFrames(frames, "codex");
    assert.ok(result.ok);
    assert.equal(result.value.kind, "message");
    const msg = result.value.kind === "message" ? result.value.message : {};
    // Exactly one content block with the real text; no spurious empty block.
    assert.deepEqual(msg["content"], [{ type: "text", text: "real content" }]);
  });

  // W1: a stray unmatched delta from an unknown-type item must not poison a turn that has real content.
  // Mutation target: reconcileOpenBlocks error condition — change back to `if (sawUnmatchedDelta)`
  // (drop the `&& blocksWithContent.size === 0` guard) and the test must FAIL.
  it("W1: stray unmatched delta from an unknown-type item does not poison a turn with real content", async () => {
    const sse = [
      'event: response.created',
      'data: {"type":"response.created","response":{"id":"resp_w1","model":"gpt-5.5","status":"in_progress"}}',
      '',
      // Real message block — registered, receives a delta, then properly closed.
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_real","role":"assistant"}}',
      '',
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","item_id":"msg_real","output_index":0,"delta":"real content"}',
      '',
      'event: response.output_item.done',
      'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"msg_real","role":"assistant"}}',
      '',
      // Unknown-type item (e.g. web_search_call) — type not handled, never registered.
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","output_index":1,"item":{"type":"web_search_call","id":"ws_1"}}',
      '',
      // Stray delta for the unknown item — unmatched (no block registered for ws_1 / oi:1).
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","item_id":"ws_1","output_index":1,"delta":"dropped"}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_w1","model":"gpt-5.5","status":"completed","usage":{"input_tokens":5,"output_tokens":3}}}',
      '',
      '',
    ].join('\n');
    const { frames } = await translate(sse);
    assert.ok(!frameTypes(frames).includes("error"), `must not produce error frame; got: ${frameTypes(frames).join(",")}`);
    assert.ok(frameTypes(frames).includes("message_stop"), "must produce message_stop");
    const result = aggregateFrames(frames, "codex");
    assert.ok(result.ok);
    assert.equal(result.value.kind, "message");
    const msg = result.value.kind === "message" ? result.value.message : {};
    assert.deepEqual(msg["content"], [{ type: "text", text: "real content" }]);
  });

  // W2: a block that was opened but never received any delta must not produce a spurious empty entry.
  // Mutation target: remove the `blocksWithContent.has(index)` guard in reconcileOpenBlocks (emit
  // content_block_stop for ALL open blocks). The test must FAIL because block 1 now gets a stop,
  // and aggregateFrames appends {type:"text", text:""} to the content.
  it("W2: no spurious empty block when a second block is opened but never delta'd before EOF", async () => {
    const sse = [
      'event: response.created',
      'data: {"type":"response.created","response":{"id":"resp_w2","model":"gpt-5.5","status":"in_progress"}}',
      '',
      // Block 0: receives content.
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_content","role":"assistant"}}',
      '',
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","item_id":"msg_content","output_index":0,"delta":"real content"}',
      '',
      // Block 1: opened but never delta'd — upstream truncated before producing content for it.
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","output_index":1,"item":{"type":"message","id":"msg_empty","role":"assistant"}}',
      '',
      // EOF with no terminal event (truncation).
      '',
    ].join('\n');
    const { frames } = await translate(sse);
    assert.ok(!frameTypes(frames).includes("error"), `must not produce error frame; got: ${frameTypes(frames).join(",")}`);
    const result = aggregateFrames(frames, "codex");
    assert.ok(result.ok);
    assert.equal(result.value.kind, "message");
    const msg = result.value.kind === "message" ? result.value.message : {};
    // Exactly one content block with the real text; the zero-delta block must be discarded.
    assert.deepEqual(msg["content"], [{ type: "text", text: "real content" }]);
  });

  // W6: the output_index (oi:) fallback in lookupBlockIndex must be exercised for DELTA lookup.
  // Mutation target: delete `if (outputIndex !== undefined) keys.push(\`oi:${outputIndex}\`)` from
  // blockKeys. The test must FAIL because the delta's item_id="msg_B" has no id: match and the
  // oi: fallback is the only path to the block — dropping it makes the delta unmatched → error.
  it("W6: oi: fallback resolves a delta whose item_id differs from the registered id but output_index matches", async () => {
    const sse = [
      'event: response.created',
      'data: {"type":"response.created","response":{"id":"resp_w6","model":"gpt-5.5","status":"in_progress"}}',
      '',
      // Block registered under id:msg_A and oi:0.
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_A","role":"assistant"}}',
      '',
      // Delta carries item_id="msg_B" — no id: match. Only oi:0 can resolve this.
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","item_id":"msg_B","output_index":0,"delta":"found via oi fallback"}',
      '',
      'event: response.output_item.done',
      'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"msg_A","role":"assistant"}}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_w6","model":"gpt-5.5","status":"completed","usage":{"input_tokens":5,"output_tokens":3}}}',
      '',
      '',
    ].join('\n');
    const { frames } = await translate(sse);
    assert.ok(!frameTypes(frames).includes("error"), `must not produce error frame; got: ${frameTypes(frames).join(",")}`);
    const result = aggregateFrames(frames, "codex");
    assert.ok(result.ok);
    assert.equal(result.value.kind, "message");
    const msg = result.value.kind === "message" ? result.value.message : {};
    assert.deepEqual(msg["content"], [{ type: "text", text: "found via oi fallback" }]);
  });

  // P1-4 path (d): done.item.id differs from added.item.id but output_index matches — content preserved.
  it("path d: preserves content when output_item.done carries a different id than output_item.added", async () => {
    const { frames } = await translate(loadSse("done-id-mismatch.sse"));
    assert.deepEqual(frameTypes(frames), [
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    const result = aggregateFrames(frames, "codex");
    assert.ok(result.ok);
    assert.equal(result.value.kind, "message");
    const msg = result.value.kind === "message" ? result.value.message : {};
    assert.deepEqual(msg["content"], [{ type: "text", text: "hello world" }]);
  });
});

describe("cache observability logging", () => {
  // Inline SSE with response.completed that includes input_tokens_details.cached_tokens
  const cachedTokensSse = [
    'data: {"type":"response.created","response":{"id":"resp_obs","model":"gpt-5.5"}}',
    "",
    'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_1"}}',
    "",
    'data: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"delta":"hi"}',
    "",
    'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"msg_1"}}',
    "",
    'data: {"type":"response.completed","response":{"id":"resp_obs","model":"gpt-5.5","status":"completed","usage":{"input_tokens":100,"output_tokens":5,"input_tokens_details":{"cached_tokens":80}}}}',
    "",
    "data: [DONE]",
    "",
    "",
  ].join("\n");

  it("logs cachedTokens at debug level from response.completed usage", async () => {
    const logs: string[] = [];
    const logger = createConsoleLogger("debug", (line) => logs.push(line));
    await pipeline(
      Readable.from([Buffer.from(cachedTokensSse)]),
      createSseParser(1024 * 1024),
      createAnthropicSseTranslator({ model: "gpt-5.5", logger, providerId: "codex" }),
      async (source) => {
        for await (const _ of source) { /* drain */ }
      },
    );
    const cacheLine = logs.find((l) => l.includes("cachedTokens="));
    assert.ok(cacheLine !== undefined, "expected a debug log line with cachedTokens");
    assert.match(cacheLine, /cachedTokens=80/);
  });

  it("logs sessionKey (8 hex chars) at debug level when a conversationKey is provided", async () => {
    const logs: string[] = [];
    const logger = createConsoleLogger("debug", (line) => logs.push(line));
    const key = "a1b2c3d4-5e6f-7a8b-9c0d-e1f2a3b4c5d6";
    await pipeline(
      Readable.from([Buffer.from(cachedTokensSse)]),
      createSseParser(1024 * 1024),
      createAnthropicSseTranslator({ model: "gpt-5.5", logger, conversationKey: key, providerId: "codex" }),
      async (source) => {
        for await (const _ of source) { /* drain */ }
      },
    );
    const keyLine = logs.find((l) => l.includes("sessionKey="));
    assert.ok(keyLine !== undefined, "expected a debug log line with sessionKey");
    // sessionKey must be the first 8 chars of the conversation key UUID (8 hex chars)
    assert.match(keyLine, /sessionKey=a1b2c3d4/);
    assert.match(keyLine, /sessionKey=[0-9a-f]{8}(\s|$)/);
  });

});

describe("aggregateFrames", () => {
  it("folds streamed frames into a complete message", async () => {
    const { frames } = await translate(loadSse("tool-call-with-reasoning.sse"));
    const result = aggregateFrames(frames, "codex");
    assert.ok(result.ok);
    assert.equal(result.value.kind, "message");
    const message = result.value.kind === "message" ? result.value.message : {};
    assert.equal(message["stop_reason"], "tool_use");
    assert.deepEqual(message["content"], [{ type: "tool_use", id: "call_abc", name: "list_files", input: { path: "." } }]);
    assert.deepEqual(message["usage"], { input_tokens: 40, output_tokens: 18 });
  });

  it("folds text frames into a text message", async () => {
    const { frames } = await translate(loadSse("text-only.sse"));
    const result = aggregateFrames(frames, "codex");
    assert.ok(result.ok);
    const message = result.value.kind === "message" ? result.value.message : {};
    assert.deepEqual(message["content"], [{ type: "text", text: "Hello from codex" }]);
    assert.equal(message["stop_reason"], "end_turn");
  });

  it("surfaces stream errors as an error outcome", async () => {
    const { frames } = await translate(loadSse("failed.sse"));
    const result = aggregateFrames(frames, "codex");
    assert.ok(result.ok);
    assert.equal(result.value.kind, "error");
  });

  it("errors when no message was produced", () => {
    const result = aggregateFrames([], "codex");
    assert.ok(!result.ok);
    assert.equal(result.error.kind, "upstream");
  });

  it("errors rather than dropping content when a block was never closed", () => {
    // Safety net: the translator reconciles open blocks before this point, so these
    // frames should be unreachable in production. Assembling them anyway would return
    // HTTP 200 with content:[] while the deltas carried text.
    const result = aggregateFrames([
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m","content":[]}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"orphaned"}}\n\n',
    ], "codex");
    assert.ok(!result.ok);
    assert.equal(result.error.kind, "upstream");
  });

  // P0-1: tool_use block with non-empty but unparseable partialJson must return err(), not input:{}.
  it("errors when a tool_use block carries non-empty but unparseable partial_json", () => {
    // reconcileOpenBlocks synthesises the content_block_stop; aggregateFrames then
    // encounters truncated JSON.  Substituting {} would let callers act on invented
    // empty arguments (e.g. execute write_file with no path).
    const result = aggregateFrames([
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m","content":[]}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_x","name":"write_file","input":{}}}\n\n',
      // Truncated JSON — closing quote, brace, and outer brace are all missing.
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\\"path\\\":\\\"/etc/hosts\\\",\\\"content\\\":\\\"DAN"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"input_tokens":5,"output_tokens":3}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ], "codex");
    assert.ok(!result.ok);
    assert.equal(result.error.kind, "upstream");
    assert.match(result.error.message, /unparseable tool_use/);
  });

  // W4: whitespace-only partial_json must be treated as equivalent to empty → input:{}, not 502.
  // Mutation target: change `pending.partialJson.trim() === ""` back to `pending.partialJson === ""`.
  // The test must FAIL because "  ".trim() !== "" → JSON.parse("  ") throws → returns err.
  it("W4: whitespace-only partial_json is treated as empty and produces input:{}", () => {
    const result = aggregateFrames([
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m","content":[]}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_w4","name":"no_args","input":{}}}\n\n',
      // Whitespace-only partial_json — not empty string, but no parseable JSON content.
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"  "}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"input_tokens":5,"output_tokens":2}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ], "codex");
    assert.ok(result.ok);
    assert.equal(result.value.kind, "message");
    const msg = result.value.kind === "message" ? result.value.message : {};
    assert.deepEqual(msg["content"], [{ type: "tool_use", id: "call_w4", name: "no_args", input: {} }]);
  });

  // P0-1: a tool_use block whose partialJson is empty string (zero-argument call) must still return input:{}.
  it("preserves input:{} for a tool_use block with an empty partial_json (zero-argument call)", () => {
    const result = aggregateFrames([
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m","content":[]}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_y","name":"no_args","input":{}}}\n\n',
      // No input_json_delta — partialJson stays "".
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"input_tokens":5,"output_tokens":2}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ], "codex");
    assert.ok(result.ok);
    assert.equal(result.value.kind, "message");
    const msg = result.value.kind === "message" ? result.value.message : {};
    assert.deepEqual(msg["content"], [{ type: "tool_use", id: "call_y", name: "no_args", input: {} }]);
  });
});

// ---------------------------------------------------------------------------
// Provider-id parameterization.
//
// Four client-visible fallback messages on this leg name the provider they came
// from. Each is pinned TWICE against the same input: once as "codex", which must
// stay byte-identical, and once as OTHER_PROVIDER.
//
// The pair is what keeps the assertions falsifiable in both directions:
//   - re-hardcoding "codex" into a message body fails ONLY the OTHER_PROVIDER case;
//   - rendering some other constant fails ONLY the "codex" case.
// A single-sided test would pass under one of those two regressions.
//
// `providerId` is now required with no default, so the previous third failure mode —
// a hardcode hiding inside a `?? "codex"` fallback — is gone by construction: there
// is no fallback left to hide in.
//
// Assertions are on the fully rendered message, not on the interpolation.
// ---------------------------------------------------------------------------

describe("provider-id parameterization", () => {
  // (2) flush() — stream opened, block announced, but EOF arrived with no delta
  // and no terminal lifecycle event.
  const truncatedNoContentSse = [
    "event: response.created",
    'data: {"type":"response.created","response":{"id":"r_pn","model":"gpt-5.5","status":"in_progress"}}',
    "",
    "event: response.output_item.added",
    'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"m_pn","role":"assistant"}}',
    "",
    "",
  ].join("\n");

  // (3) aggregateFrames — tool_use block whose partial_json is non-empty but truncated.
  const unparseableToolUseFrames = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"m","content":[]}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_pn","name":"write_file","input":{}}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"/etc/hosts\\",\\"content\\":\\"DAN"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  ];

  // (4) aggregateFrames — one block carrying text that never received its stop.
  const unclosedBlockFrames = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"m","content":[]}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"orphaned"}}\n\n',
  ];

  // --- (0) message_start id fallback when the upstream never supplies one ---

  // The stream opens on output_item.added, so ensureStarted() runs with no upstream id
  // and message_start must fall back to a synthesised one. response.completed arrives
  // later but cannot backfill the id — `started` is already true by then.
  const noUpstreamIdSse = [
    "event: response.output_item.added",
    'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"m_noid","role":"assistant"}}',
    "",
    "event: response.output_text.delta",
    'data: {"type":"response.output_text.delta","output_index":0,"item_id":"m_noid","delta":"hi"}',
    "",
    "event: response.output_item.done",
    'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"m_noid","role":"assistant"}}',
    "",
    "event: response.completed",
    'data: {"type":"response.completed","response":{"id":"resp_noid","model":"gpt-5.5","status":"completed"}}',
    "",
    "",
  ].join("\n");

  const messageStartId = (frames: readonly string[]): unknown =>
    (frameData(frames[0]!)["message"] as Record<string, unknown>)["id"];

  it("derives the message_start fallback id from the provider id", async () => {
    // The fallback id is the one provider-derived value with no other observable
    // effect, so without this pair it can be re-hardcoded to "msg_codex" silently.
    const { frames } = await translate(noUpstreamIdSse, { providerId: OTHER_PROVIDER });
    assert.equal(messageStartId(frames), "msg_kimi");
  });

  it("keeps the Codex leg's fallback message id byte-identical", async () => {
    const { frames } = await translate(noUpstreamIdSse);
    assert.equal(messageStartId(frames), "msg_codex");
  });

  // --- (1) reconcileOpenBlocks: every delta dropped, no block ever got content ---

  it("names the codex provider when all content deltas matched no block", async () => {
    const { frames } = await translate(loadSse("delta-id-mismatch.sse"));
    assert.equal(
      errorFrameMessage(frames),
      "codex stream dropped content deltas that matched no content block",
      "the Codex leg's rendered message must stay byte-identical",
    );
  });

  it("names a second provider when all content deltas matched no block", async () => {
    const { frames } = await translate(loadSse("delta-id-mismatch.sse"), { providerId: OTHER_PROVIDER });
    assert.equal(errorFrameMessage(frames), "kimi stream dropped content deltas that matched no content block");
  });

  // --- (2) flush(): truncated stream with no recoverable content ---

  it("names the codex provider when the stream ends with no terminal event or content", async () => {
    const { frames } = await translate(truncatedNoContentSse);
    assert.equal(
      errorFrameMessage(frames),
      "codex stream ended without a terminal event or recoverable content",
      "the Codex leg's rendered message must stay byte-identical",
    );
  });

  it("names a second provider when the stream ends with no terminal event or content", async () => {
    const { frames } = await translate(truncatedNoContentSse, { providerId: OTHER_PROVIDER });
    assert.equal(errorFrameMessage(frames), "kimi stream ended without a terminal event or recoverable content");
  });

  // --- (3) aggregateFrames: unparseable tool_use arguments ---

  it("names the codex provider when tool_use arguments are unparseable", () => {
    const result = aggregateFrames(unparseableToolUseFrames, "codex");
    assert.ok(!result.ok);
    assert.equal(
      result.error.message,
      "codex stream ended with unparseable tool_use arguments",
      "the Codex leg's rendered message must stay byte-identical",
    );
  });

  it("names a second provider when tool_use arguments are unparseable", () => {
    const result = aggregateFrames(unparseableToolUseFrames, OTHER_PROVIDER);
    assert.ok(!result.ok);
    assert.equal(result.error.message, "kimi stream ended with unparseable tool_use arguments");
  });

  // --- (4) aggregateFrames: unclosed content blocks that carry content ---

  it("names the codex provider when a content block carrying text was never closed", () => {
    const result = aggregateFrames(unclosedBlockFrames, "codex");
    assert.ok(!result.ok);
    assert.equal(
      result.error.message,
      "codex stream ended with 1 unclosed content block(s)",
      "the Codex leg's rendered message must stay byte-identical",
    );
  });

  it("names a second provider when a content block carrying text was never closed", () => {
    const result = aggregateFrames(unclosedBlockFrames, OTHER_PROVIDER);
    assert.ok(!result.ok);
    assert.equal(result.error.message, "kimi stream ended with 1 unclosed content block(s)");
  });
});
