import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { aggregateFrames } from "../../src/codex-response.js";
import { validatedProviderEvents } from "../../src/routing/provider-stream.js";
import { systemClock } from "../../src/routing/clock.js";
import { RoutingError, type AccessProfile, type Item } from "../../src/routing/routing-types.js";
import { invalidSignedCases, invalidSignedEvents, messageFrames, nativeContent, nativeEvents } from "../fixtures/native-messages.js";
import { nativeCredential } from "../fixtures/native-profile.js";

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

  for (const initialSignature of [undefined, ""]) {
    it(`accepts an initially ${initialSignature === undefined ? "absent" : "empty"} signature supplied by deltas for an empty thought`, () => {
      const content = [{ type: "thinking", thinking: "", signature: "fabricated-deferred-signature" }];
      const events = nativeEvents(content, { signatureInDeltas: true });
      const start = events.find(event => event.type === "content_block_start");
      assert.ok(start);
      (start.content_block as Item).signature = initialSignature;
      const result = aggregateFrames(messageFrames(events), "codex");
      assert.ok(result.ok);
      assert.equal(result.value.kind, "message");
      if (result.value.kind === "message") assert.deepEqual(result.value.message.content, content);
    });
  }

  for (const state of ["open", "closed"]) {
    it(`rejects a duplicate index while the original content block is ${state}`, () => {
      const events = nativeEvents([{ type: "text", text: "First" }, { type: "text", text: "Second" }])
        .filter(event => state === "closed" || event.type !== "content_block_stop" || event.index !== 0)
        .map(event => event.index === 1 ? { ...event, index: 0 } : event);
      const result = aggregateFrames(messageFrames(events), "codex");
      assert.ok(!result.ok);
      assert.deepEqual(result.error, { kind: "upstream", message: "codex stream contained duplicate content block index" });
    });
  }

  it("preserves a matched native stop sequence across later usage-only deltas", () => {
    const events = nativeEvents([{ type: "text", text: "Complete" }]);
    events[events.length - 2]!.delta = { stop_reason: "stop_sequence", stop_sequence: "\nEND α" };
    events.splice(events.length - 1, 0, { type: "message_delta", delta: {}, usage: { output_tokens: 11 } });
    const result = aggregateFrames(messageFrames(events), "codex");
    assert.ok(result.ok);
    assert.equal(result.value.kind, "message");
    if (result.value.kind !== "message") return;
    assert.equal(result.value.message.stop_reason, "stop_sequence");
    assert.equal(result.value.message.stop_sequence, "\nEND α");
    assert.deepEqual(result.value.message.usage, { input_tokens: 7, output_tokens: 11 });
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
      const profile: AccessProfile = { provider: "claude", product: "claude-code", billing: "subscription", account: "fixture",
        credential: nativeCredential("claude", "fabricated-profile-token") };
      const controller = new AbortController(), completed: Item[] = [], emitted: Item[] = [];
      const response = new Response(messageFrames(invalidSignedEvents(testCase)).join(""), {
        headers: { "content-type": "text/event-stream" },
      });
      await assert.rejects(async () => {
        for await (const event of validatedProviderEvents(response, profile, "messages", controller.signal, controller,
          systemClock, final => completed.push(final))) emitted.push(JSON.parse(event.data) as Item);
      }, (error: unknown) => {
        assert.ok(error instanceof RoutingError);
        assert.equal(error.status, 502);
        assert.equal(error.code, testCase.code);
        assert.equal(error.message, testCase.code);
        return true;
      });
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

  it("rejects an invalid unclosed signed start before the unclosed-content check", () => {
    const events = nativeEvents([{ type: "thinking", thinking: 123, signature: "fabricated-invalid" }])
      .filter(event => event.type !== "content_block_delta" && event.type !== "content_block_stop");
    const result = aggregateFrames(messageFrames(events), "codex");
    assert.ok(!result.ok);
    assert.deepEqual(result.error, { kind: "upstream", message: "codex stream contained invalid signed content" });
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
