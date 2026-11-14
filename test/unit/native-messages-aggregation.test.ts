import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { aggregateFrames } from "../../src/codex-response.js";
import { validatedProviderEvents } from "../../src/routing/provider-stream.js";
import { systemClock } from "../../src/routing/clock.js";
import { RoutingError, type AccessProfile, type Item } from "../../src/routing/routing-types.js";
import { invalidSignedCases, invalidSignedEvents, messageFrames, nativeContent, nativeEvents } from "../fixtures/native-messages.js";

describe("native Messages aggregation", () => {
  it("preserves thinking/signature fragments, redacted payloads and original text/tool order", () => {
    // The provider validator defers executable tool stops until its valid terminal.
    const events = nativeEvents();
    const toolStop = events.findIndex(event => event.type === "content_block_stop" && event.index === 3);
    const [stop] = events.splice(toolStop, 1);
    events.splice(events.length - 1, 0, stop!);
    const result = aggregateFrames(messageFrames(events), "codex");
    assert.ok(result.ok);
    assert.equal(result.value.kind, "message");
    if (result.value.kind !== "message") return;
    assert.deepEqual(result.value.message.content, nativeContent);
    assert.equal(result.value.message.stop_reason, "tool_use");
    assert.deepEqual(result.value.message.usage, { input_tokens: 7, output_tokens: 9 });
  });

  it("accepts an initially absent signature supplied by deltas for an empty thought", () => {
    const content = [{ type: "thinking", thinking: "", signature: "fabricated-deferred-signature" }];
    const result = aggregateFrames(messageFrames(nativeEvents(content, { signatureInDeltas: true })), "codex");
    assert.ok(result.ok);
    assert.equal(result.value.kind, "message");
    if (result.value.kind === "message") assert.deepEqual(result.value.message.content, content);
  });

  it("merges multiple partial usage deltas with the start counts and other usage fields", () => {
    const events = nativeEvents([{ type: "text", text: "fixture" }]);
    (events[0]!.message as Item).usage = { input_tokens: 7, output_tokens: 0, cache_read_input_tokens: 3 };
    events.splice(events.length - 1, 0,
      { type: "message_delta", delta: {}, usage: { cache_creation_input_tokens: 4 } },
      { type: "message_delta", delta: {}, usage: { output_tokens: 12 } });
    const result = aggregateFrames(messageFrames(events), "codex");
    assert.ok(result.ok);
    assert.equal(result.value.kind, "message");
    if (result.value.kind === "message") assert.deepEqual(result.value.message.usage, {
      input_tokens: 7, output_tokens: 12, cache_read_input_tokens: 3, cache_creation_input_tokens: 4,
    });
  });

  it("retains both counts from a full translated-style terminal usage update", () => {
    const events = nativeEvents([{ type: "text", text: "fixture" }]);
    (events[0]!.message as Item).usage = { input_tokens: 0, output_tokens: 0 };
    events[events.length - 2]!.usage = { input_tokens: 19, output_tokens: 23 };
    const result = aggregateFrames(messageFrames(events), "codex");
    assert.ok(result.ok);
    assert.equal(result.value.kind, "message");
    if (result.value.kind === "message") assert.deepEqual(result.value.message.usage, { input_tokens: 19, output_tokens: 23 });
  });

  for (const testCase of invalidSignedCases) {
    it(`rejects ${testCase.name} in the exported fold`, () => {
      const result = aggregateFrames(messageFrames(invalidSignedEvents(testCase)), "codex");
      assert.ok(!result.ok);
      assert.equal(result.error.kind, "upstream");
      assert.match(result.error.message, /invalid signed content/);
    });

    it(`does not publish replay or release completed tools for ${testCase.name}`, async () => {
      const profile: AccessProfile = { provider: "claude", product: "anthropic-api", billing: "api", account: "fixture",
        credential: { kind: "env", name: "FABRICATED_KEY" } };
      const controller = new AbortController(), completed: Item[] = [], emitted: Item[] = [];
      const response = new Response(messageFrames(invalidSignedEvents(testCase)).join(""), {
        headers: { "content-type": "text/event-stream" },
      });
      await assert.rejects(async () => {
        for await (const event of validatedProviderEvents(response, profile, "messages", controller.signal, controller,
          systemClock, final => completed.push(final))) emitted.push(JSON.parse(event.data) as Item);
      }, (error: unknown) => error instanceof RoutingError && error.status === 502 &&
        ["invalid_provider_block", "invalid_provider_delta"].includes(error.code));
      assert.deepEqual(completed, []);
      assert.equal(emitted.some(event => event.type === "content_block_stop" && event.index === 1), false);
      assert.equal(emitted.some(event => event.type === "message_stop"), false);
    });
  }

  it("preserves an empty signed thought and a tool with arguments in its start frame", () => {
    const content = [
      { type: "thinking", thinking: "", signature: "fabricated-empty-thought" },
      { type: "tool_use", id: "toolu_start", name: "Read", input: { path: "initial.txt" } },
    ];
    const events = nativeEvents(content).filter(event => event.type !== "content_block_delta");
    for (const event of events) if (event.type === "content_block_start") event.content_block = content[Number(event.index)];
    const result = aggregateFrames(messageFrames(events), "codex");
    assert.ok(result.ok);
    assert.equal(result.value.kind, "message");
    if (result.value.kind === "message") assert.deepEqual(result.value.message.content, content);
  });

  for (const type of ["thinking", "redacted_thinking"]) {
    it(`rejects an unclosed ${type} block carrying signed content`, () => {
      const block = nativeContent.find(value => value.type === type)!;
      const result = aggregateFrames(messageFrames(nativeEvents([block]).filter(event => event.type !== "content_block_stop")), "codex");
      assert.ok(!result.ok);
      assert.match(result.error.message, /unclosed content/);
    });
  }

  it("refuses unsupported content instead of silently omitting it", () => {
    const result = aggregateFrames(messageFrames(nativeEvents([{ type: "future_unsupported", data: "opaque" }])), "codex");
    assert.ok(!result.ok);
    assert.match(result.error.message, /unsupported content/);
  });
});
