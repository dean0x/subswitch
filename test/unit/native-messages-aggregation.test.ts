import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { aggregateFrames } from "../../src/codex-response.js";
import { messageFrames, nativeContent, nativeEvents } from "../fixtures/native-messages.js";

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
  });

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
