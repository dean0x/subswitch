import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bridge, created, added, done, delta, terminal, textItem, toolRound, frameData, type Event } from "../helpers/kimi-responses-bridge.js";

const textResponse = (reason?: string): Event[] => {
  const item = textItem("m", ["complete"]);
  return [created(), added(0, textItem("m", [])), delta("m", 0, "complete"), done(0, item), terminal([item], reason)];
};
const message = (run: Awaited<ReturnType<typeof bridge>>) => {
  assert.equal(run.error, undefined);
  assert.ok(run.aggregate.ok);
  assert.equal(run.aggregate.value.kind, "message");
  if (run.aggregate.value.kind !== "message") assert.fail("expected message");
  return run.aggregate.value.message;
};

describe("fabricated Kimi Responses through existing provider validation and Messages bridge", () => {
  it("preserves fragmented UTF8/argument values, interleaved text/calls, caller IDs, usage and tool stop", async () => {
    const fixture = toolRound();
    const run = await bridge(fixture.events, { fragment: 1 });
    const output = message(run);
    assert.deepEqual(output["content"], [{ type: "text", text: "שלום 🦊" }, { type: "tool_use", id: "call_caller", name: "inspect", input: fixture.args }, { type: "text", text: "after tool" }]);
    assert.equal(output["stop_reason"], "tool_use");
    assert.deepEqual(output["usage"], { input_tokens: 37, output_tokens: 11 });
    assert.equal(run.completions, 1);
    assert.ok(run.observed.filter((event) => event.type === "response.function_call_arguments.done").every((event) => event.completed));
    const frames = frameData(run.frames);
    assert.equal(frames.filter((f) => f["type"] === "message_stop").length, 1);
    assert.deepEqual(frames.filter((f) => f["type"] === "content_block_start").map((f) => f["index"]), [0, 1, 2]);
  });

  for (const [reason, stop] of [[undefined, "end_turn"], ["max_output_tokens", "max_tokens"], ["content_filter", "refusal"]] as const) {
    it(`maps ${reason ?? "completed"} to ${stop} with usage`, async () => {
      const output = message(await bridge(textResponse(reason), { fragment: 7 }));
      assert.deepEqual(output["content"], [{ type: "text", text: "complete" }]);
      assert.equal(output["stop_reason"], stop);
      assert.deepEqual(output["usage"], { input_tokens: 37, output_tokens: 11 });
    });
  }

  it("maps explicit refusal text without fabricating a tool", async () => {
    const events = textResponse();
    events[2] = { type: "response.refusal.delta", item_id: "m", output_index: 0, delta: "cannot comply" };
    const output = message(await bridge(events));
    assert.equal(output["stop_reason"], "refusal");
    assert.deepEqual(output["content"], [{ type: "text", text: "cannot comply" }]);
  });

  for (const failure of [
    { type: "error", code: "server_error", message: "fabricated error" },
    { type: "response.failed", response: { id: "resp_fixture", status: "failed", error: { type: "server_error", message: "fabricated failure" } } },
  ]) it(`propagates ${failure.type} after partial text without a healthy terminal`, async () => {
    const run = await bridge([...textResponse().slice(0, 3), failure]);
    assert.ok(run.error);
    assert.equal(run.completions, 0);
    assert.ok(!frameData(run.frames).some((f) => f["type"] === "message_stop"));
  });

  it("rejects EOF after partial content through the actual validator instead of using legacy synthetic completion", async () => {
    const run = await bridge(textResponse().slice(0, 3));
    assert.match(String(run.error), /missing_provider_terminal/);
    assert.equal(run.completions, 0);
    assert.ok(!frameData(run.frames).some((f) => f["type"] === "message_stop"));
  });

  it("rejects incomplete tools before publishing an executable closure", async () => {
    const fixture = toolRound();
    fixture.events[fixture.events.length - 1] = terminal([fixture.call], "max_output_tokens");
    const run = await bridge(fixture.events);
    assert.match(String(run.error), /incomplete_provider_tools/);
    assert.equal(run.completions, 0);
    assert.ok(!run.observed.some((e) => e.type === "response.function_call_arguments.done"));
    assert.ok(!frameData(run.frames).some((f) => f["type"] === "message_stop"));
  });

  it("rejects malformed final tool arguments rather than substituting an empty object", async () => {
    const fixture = toolRound();
    fixture.events[fixture.events.length - 1] = terminal([{ ...fixture.call, arguments: '{"path":' }]);
    const run = await bridge(fixture.events);
    assert.match(String(run.error), /invalid_provider_tool/);
    assert.equal(run.completions, 0);
    assert.ok(!run.observed.some((e) => e.type === "response.function_call_arguments.done"));
  });

  it("cancels an owned synthetic stream without completing or replaying tools", async () => {
    const run = await bridge(toolRound().events, { fragment: 3, abortAfter: "response.function_call_arguments.delta" });
    assert.match(String(run.error), /provider_stream_timeout_or_cancelled/);
    assert.equal(run.completions, 0);
    assert.ok(!run.observed.some((e) => e.type === "response.function_call_arguments.done"));
    assert.ok(!frameData(run.frames).some((f) => f["type"] === "message_stop"));
  });
});
