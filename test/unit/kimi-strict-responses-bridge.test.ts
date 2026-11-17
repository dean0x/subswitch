import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderKimiResponsesRequest } from "../../src/routing/kimi-responses-request.js";
import { KimiResponsesBridgeError, KIMI_OPAQUE_RESPONSE_SITES } from "../../src/routing/kimi-responses-bridge.js";
import { strictBridge } from "../helpers/kimi-strict-responses-bridge.js";
import { created, added, done, delta, terminal, textItem, toolRound, frameData, type Event } from "../helpers/kimi-responses-bridge.js";

const call = (id = "fc", callId = "caller", args = '{"n":7}') => ({ type: "function_call", id, call_id: callId, name: "inspect", arguments: args, status: "completed" });
const startCall = (c: Event) => ({ ...c, arguments: "", status: "in_progress" });
const startMessage = (id: string) => ({ ...textItem(id, []), status: "in_progress" });
const arg = (c: Event, oi: number, value: string, final = false): Event => ({ type: `response.function_call_arguments.${final ? "done" : "delta"}`, item_id: c["id"], output_index: oi, [final ? "arguments" : "delta"]: value });
const round = (): Event[] => { const c = call(); return [created(), added(0, startCall(c)), arg(c, 0, c.arguments, true), done(0, c), terminal([c])]; };
const textRound = (reason?: string): Event[] => { const m = textItem("m", ["complete"]); return [created(), added(0, startMessage("m")), delta("m", 0, "complete"), done(0, m), terminal([m], reason)]; };
const message = (run: Awaited<ReturnType<typeof strictBridge>>) => {
  assert.equal(run.error, undefined); assert.equal(run.completions, 1);
  assert.ok(run.aggregate.ok && run.aggregate.value.kind === "message");
  return run.aggregate.value.message;
};
const rejected = async (events: Event[], pattern?: RegExp) => {
  const run = await strictBridge(events, { fragment: 7 }); assert.ok(run.error);
  if (pattern) assert.match(String(run.error), pattern);
  assert.deepEqual(run.frames, [], "no text/tool frames or healthy terminal on any refusal");
  assert.equal(run.completions, 0, "no completion callback on rejected raw order/terminal");
  return run;
};

describe("disabled strict Kimi Responses bridge through actual provider validation", () => {
  it("KRSP-B1 preserves multipart UTF8, empty part, and original part boundaries", async () => {
    const m = textItem("m", ["שלום 🦊", "", "two"]);
    const events: Event[] = [created(), added(0, startMessage("m"))];
    for (let i = 0; i < m.content.length; i++) {
      events.push({ type: "response.content_part.added", item_id: "m", output_index: 0, content_index: i, part: { type: "output_text", text: "", annotations: [] } },
        delta("m", 0, m.content[i]!.text, i), { type: "response.output_text.done", item_id: "m", output_index: 0, content_index: i, text: m.content[i]!.text },
        { type: "response.content_part.done", item_id: "m", output_index: 0, content_index: i, part: m.content[i] });
    }
    events.push(done(0, m), terminal([m]));
    assert.deepEqual(message(await strictBridge(events, { fragment: 1 }))["content"], m.content.map((p) => ({ type: "text", text: p.text })));
  });
  it("KRSP-B2 preserves final-only nonempty arguments exactly once", async () => {
    const run = await strictBridge(round());
    assert.deepEqual(message(run)["content"], [{ type: "tool_use", id: "caller", name: "inspect", input: { n: 7 } }]);
    const frames = frameData([...run.frames]);
    assert.equal(frames.filter((f) => f["type"] === "content_block_stop").length, 1);
    assert.equal(frames.filter((f) => f["type"] === "message_stop").length, 1);
  });
  it("reuses ordered request renderer and retains caller IDs/values for tool continuation", async () => {
    const fixture = toolRound();
    for (const event of fixture.events as Event[]) if (event["type"] === "response.output_item.added") (event["item"] as Event)["status"] = "in_progress";
    const run = await strictBridge(fixture.events, { fragment: 1 });
    const output = message(run);
    assert.deepEqual(output["content"], [{ type: "text", text: "שלום 🦊" }, { type: "tool_use", id: "call_caller", name: "inspect", input: fixture.args }, { type: "text", text: "after tool" }]);
    assert.equal(output["stop_reason"], "tool_use");
    const request = renderKimiResponsesRequest({ model: "kimi-for-coding", messages: [{ role: "assistant", content: output["content"] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "call_caller", content: "observed" }] }] });
    assert.ok(request.ok);
    const input = request.value.body["input"] as Event[];
    assert.equal(input[1]!["call_id"], "call_caller");
    assert.deepEqual(JSON.parse(input[1]!["arguments"] as string), fixture.args);
    assert.deepEqual(input.at(-1), { type: "function_call_output", call_id: "call_caller", output: "observed" });
  });
  it("supports final-only args at item.done or terminal and legitimate empty objects", async () => {
    for (const args of ['{"n":7}', '{}']) for (const itemDone of [true, false]) {
      const c = call("fc", "caller", args), events = [created(), added(0, startCall(c)), ...(itemDone ? [done(0, c)] : []), terminal([c])];
      assert.deepEqual((message(await strictBridge(events))["content"] as Event[])[0]!["input"], JSON.parse(args));
    }
  });
  it("reconciles fragments as JSON values, retaining prototype-like keys and detached values", async () => {
    const c = call("fc", "caller", '{"__proto__":{"x":1},"n":[1,null,"שלום"]}');
    const events = [created(), added(0, startCall(c)), arg(c, 0, c.arguments.slice(0, 13)), arg(c, 0, c.arguments.slice(13)), arg(c, 0, c.arguments, true), done(0, c), terminal([c])];
    const input = (message(await strictBridge(events, { fragment: 2 }))["content"] as Event[])[0]!["input"];
    assert.deepEqual(input, JSON.parse(c.arguments)); assert.equal(({} as Event)["x"], undefined);
  });
  it("preserves parallel calls and interleaved output by output_index/content_index", async () => {
    const a = call("f0", "c0", '{"a":1}'), b = { ...call("f2", "c2", '{"b":2}'), name: "different" }, m = textItem("m", ["one", "two"]);
    const events = [created(), added(0, startCall(a)), added(1, startMessage("m")), delta("m", 1, "one"), added(2, startCall(b)),
      arg(b, 2, b.arguments.slice(0, 4)), delta("m", 1, "two", 1), arg(a, 0, a.arguments), arg(a, 0, a.arguments, true), done(0, a),
      arg(b, 2, b.arguments.slice(4)), arg(b, 2, b.arguments, true), done(2, b), done(1, m), terminal([a, m, b])];
    assert.deepEqual(message(await strictBridge(events))["content"], [{ type: "tool_use", id: "c0", name: "inspect", input: { a: 1 } }, { type: "text", text: "one" }, { type: "text", text: "two" }, { type: "tool_use", id: "c2", name: "different", input: { b: 2 } }]);
  });
  for (const [reason, stop] of [[undefined, "end_turn"], ["max_output_tokens", "max_tokens"], ["content_filter", "refusal"]] as const) it(`preserves ${reason ?? "completed"} usage/terminal`, async () => {
    const output = message(await strictBridge(textRound(reason)));
    assert.equal(output["stop_reason"], stop); assert.deepEqual(output["usage"], { input_tokens: 37, output_tokens: 11 });
  });
  it("supports explicit refusal part while retaining text and refusal stop", async () => {
    const m = { ...textItem("m", []), content: [{ type: "refusal", refusal: "cannot comply" }] };
    const events = [created(), added(0, startMessage("m")), { type: "response.refusal.delta", item_id: "m", output_index: 0, content_index: 0, delta: "cannot comply" }, done(0, m), terminal([m])];
    const out = message(await strictBridge(events)); assert.equal(out["stop_reason"], "refusal"); assert.deepEqual(out["content"], [{ type: "text", text: "cannot comply" }]);
  });
  it("supports completion-only text content without fabricating a dropped empty message", async () => {
    const m = textItem("m", ["one", "two"]);
    assert.deepEqual(message(await strictBridge([created(), added(0, startMessage("m")), terminal([m])]))["content"], [{ type: "text", text: "one" }, { type: "text", text: "two" }]);
  });
  it("accepts a single transport DONE after terminal while requiring EOF", async () => {
    message(await strictBridge(textRound(), { tail: "data: [DONE]\n\n", fragment: 3 }));
    const run = await strictBridge(textRound(), { tail: "data: [DONE]\n\ndata: [DONE]\n\n" });
    assert.ok(run.error); assert.deepEqual(run.frames, []); assert.equal(run.completions, 0);
  });

  const mutations: [string, (events: Event[]) => Event[], RegExp?][] = [
    ["conflicting fragments/final", (e) => { e.splice(2, 0, arg(call(), 0, '{"n":8}')); return e; }, /conflicting_arguments/],
    ["delta AFTER arguments.done (original order)", (e) => { e.splice(3, 0, arg(call(), 0, '{"n":7}')); return e; }, /late_mutation/],
    ["delta AFTER item.done (original order)", (e) => { e.splice(4, 0, arg(call(), 0, '{"n":7}')); return e; }, /late_mutation/],
    ["duplicate args.done", (e) => { e.splice(3, 0, e[2]!); return e; }, /duplicate_completion/],
    ["duplicate item.done", (e) => { e.splice(4, 0, e[3]!); return e; }, /late_mutation/],
    ["missing arguments", (e) => { const c = { ...call() } as Event; delete c["arguments"]; e[3] = done(0, c); return e; }, /invalid_event/],
    ["nonobject arguments", (e) => { e[2] = arg(call(), 0, '[]', true); return e; }, /invalid_arguments/],
    ["malformed arguments", (e) => { e[2] = arg(call(), 0, '{"n":', true); return e; }, /invalid_arguments/],
    ["nonfinite decoded arguments", (e) => { e[2] = arg(call(), 0, '{"n":1e999}', true); return e; }, /invalid_arguments/],
    ["unknown item identity", (e) => { e[2] = { ...e[2], item_id: "other" }; return e; }, /conflicting_identity/],
    ["conflicting index and ID", (e) => { e[2] = { ...e[2], output_index: 1 }; return e; }, /conflicting_identity/],
    ["string output index", (e) => { e[2] = { ...e[2], output_index: "0" }; return e; }, /conflicting_identity/],
    ["unknown name", (e) => { e[2] = { ...e[2], name: "other" }; return e; }, /conflicting_identity/],
    ["unknown call ID", (e) => { e[2] = { ...e[2], call_id: "fc" }; return e; }, /conflicting_identity/],
    ["wrong terminal args", (e) => { e[4] = terminal([call("fc", "caller", '{"n":8}')]); return e; }, /conflicting_content/],
    ["missing terminal item", (e) => { e[4] = terminal([]); return e; }, /invalid_terminal/],
    ["duplicate terminal", (e) => [...e, e[4]!], /provider_event_after_terminal/],
    ["late output mutation", (e) => [...e, done(0, call())], /provider_event_after_terminal/],
    ["incomplete executable tools", (e) => { e[4] = terminal([call()], "max_output_tokens"); return e; }, /invalid_terminal/],
    ["unknown incomplete reason", (e) => { e[4] = terminal([call()], "unknown"); return e; }, /invalid_terminal/],
    ["missing terminal", (e) => e.slice(0, 4), /missing_provider_terminal/],
    ["provider error", (e) => [...e.slice(0, 3), { type: "error", error: { type: "server_error", message: "fabricated" } }]],
    ["provider failed", (e) => [...e.slice(0, 3), { type: "response.failed", response: { id: "resp_fixture", status: "failed", error: { type: "server_error" } } }]],
    ["opaque output", (e) => { e[1] = added(0, { type: "reasoning", id: "opaque", encrypted_content: "fabricated" }); return e; }, /opaque_output/],
    ["unsupported custom tool", (e) => { e[1] = added(0, { ...startCall(call()), type: "custom_tool_call" }); return e; }, /unsupported_output/],
    ["unexpected source field", (e) => { e[2] = { ...e[2], encrypted_content: "fabricated" }; return e; }, /unsupported_output/],
    ["duplicate added identity", (e) => { e.splice(2, 0, added(1, startCall(call()))); return e; }, /conflicting_identity/],
    ["duplicate caller ID", (e) => { e.splice(2, 0, added(1, startCall(call("fc2", "caller")))); return e; }, /conflicting_identity/],
    ["noncontiguous added output", (e) => { e[1] = added(1, startCall(call())); return e; }, /invalid_order/],
    ["completed added item", (e) => { e[1] = added(0, call()); return e; }, /invalid_order/],
  ];
  for (const [name, mutate, pattern] of mutations) it(`atomically refuses ${name}`, async () => { await rejected(mutate(round()), pattern); });

  for (const [name, mutate] of [
    ["unknown content_index", (e: Event[]) => { e[2] = delta("m", 0, "complete", 2); return e; }],
    ["wrong content identity", (e: Event[]) => { e[2] = delta("other", 0, "complete"); return e; }],
    ["final text conflict", (e: Event[]) => { e[4] = terminal([textItem("m", ["changed"])]); return e; }],
    ["unknown final part", (e: Event[]) => { e[4] = terminal([{ ...textItem("m", []), content: [{ type: "image", data: "fabricated" }] }]); return e; }],
    ["nonempty annotations", (e: Event[]) => { const m = textItem("m", ["complete"]); m.content[0]!.annotations.push({} as never); e[3] = done(0, m); return e; }],
    ["missing usage", (e: Event[]) => { const t = terminal([textItem("m", ["complete"])]); delete (t["response"] as Event)["usage"]; e[4] = t; return e; }],
    ["unfinished completed message", (e: Event[]) => { e[3] = done(0, { ...textItem("m", ["complete"]), status: "in_progress" }); return e; }],
    ["invalid usage", (e: Event[]) => { const t = terminal([textItem("m", ["complete"])]); ((t["response"] as Event)["usage"] as Event)["input_tokens"] = -1; e[4] = t; return e; }],
  ] as const) it(`atomically refuses ${name}`, async () => { await rejected(mutate(textRound())); });
  it("owned abort publishes no executable closure or healthy terminal and performs no replay", async () => {
    const run = await strictBridge(round(), { fragment: 20, abort: true }); assert.ok(run.error); assert.deepEqual(run.frames, []); assert.equal(run.completions, 0);
  });
  it("a later conflicting call prevents publication of an earlier valid call", async () => {
    const a = call("a", "ca"), b = call("b", "cb");
    await rejected([created(), added(0, startCall(a)), arg(a, 0, a.arguments, true), done(0, a),
      added(1, startCall(b)), arg(b, 1, '{"n":8}'), arg(b, 1, b.arguments, true), done(1, b), terminal([a, b])], /conflicting_arguments/);
  });
  it("part completion conflicts/duplicates and text after a closed part refuse atomically", async () => {
    const m = textItem("m", ["complete"]);
    const p: Event = { type: "response.content_part.done", item_id: "m", output_index: 0, content_index: 0, part: m.content[0] };
    const prefix = [created(), added(0, startMessage("m")), delta("m", 0, "complete")];
    await rejected([...prefix, { ...p, part: { ...m.content[0], text: "changed" } }, done(0, m), terminal([m])], /conflicting_content/);
    await rejected([...prefix, p, p, done(0, m), terminal([m])], /duplicate_completion/);
    await rejected([...prefix, p, delta("m", 0, "late"), done(0, m), terminal([m])], /late_mutation/);
  });
  it("rejects too-deep serialization with a fixed refusal before completion/publication", async () => {
    const args = '{"deep":' + '['.repeat(15000) + '0' + ']'.repeat(15000) + '}';
    const c = call("fc", "caller", args);
    await rejected([created(), added(0, startCall(c)), terminal([c])], /invalid_arguments/);
  });
  it("fixed codec errors contain no provider body/secret", async () => {
    const e = round(); e[2] = arg(call(), 0, 'FAKE_PRIVATE_VALUE', true);
    const run = await rejected(e); assert.ok(run.error instanceof KimiResponsesBridgeError); assert.equal(String(run.error).includes('FAKE_PRIVATE_VALUE'), false);
  });
});

describe("closed opaque-response diagnostics preserve every refusal", () => {
  const fields = ["signature", "encrypted_content", "thinking", "redacted_thinking", "reasoning_content", "reasoning_text"] as const;
  const secret = "FABRICATED_PRIVATE_OUTPUT https://synthetic.invalid/?token=private";
  const covered = new Set<string>();
  async function site(events: Event[], expected: string) {
    const run = await rejected(events, /opaque_output/);
    assert(run.error instanceof KimiResponsesBridgeError);
    assert.equal(run.error.code, "opaque_output"); assert.equal(run.error.opaqueSite, expected);
    assert.equal(String(run.error), "Error: kimi_responses_bridge_opaque_output");
    assert(!JSON.stringify(run.error).includes("FABRICATED_PRIVATE_OUTPUT"));
    covered.add(expected);
  }
  for (const stage of ["created", "in_progress", "completed", "incomplete"] as const) for (const key of fields) {
    for (const value of [null, "", false, 0, [], {}, secret]) it(`${stage} ${key} presence ${JSON.stringify(value)} stays opaque`, async () => {
      const events = textRound(stage === "incomplete" ? "max_output_tokens" : undefined).map(e => structuredClone(e));
      if (stage === "in_progress") events.splice(1, 0, { type: "response.in_progress", response: structuredClone(events[0]!["response"]) });
      const envelope = events.find(e => e["type"] === `response.${stage}`)!["response"] as Event;
      envelope[key] = value; await site(events, `${stage}_envelope_${key}`);
    });
  }
  it("reasoning event remains distinct from added reasoning item", async () => {
    await site([created(), { type: "response.reasoning_text.delta", item_id: secret, output_index: 0, content_index: 0, delta: secret }], "stream_reasoning_event");
    await site([created(), added(0, { type: "reasoning", id: secret, status: "in_progress", encrypted_content: secret })], "item_added_reasoning");
  });
  for (const stage of ["part_added", "part_done", "item_done", "completed", "incomplete"] as const) it(`reasoning part at ${stage} stays atomic`, async () => {
    const part = { type: "reasoning_text", text: secret }, start = [created(), added(0, startMessage("m"))];
    if (stage === "part_added") await site([...start, { type: "response.content_part.added", item_id: "m", output_index: 0, content_index: 0, part }], `${stage}_reasoning_part`);
    else if (stage === "part_done") await site([...start, delta("m", 0, "complete"), { type: "response.content_part.done", item_id: "m", output_index: 0, content_index: 0, part }], `${stage}_reasoning_part`);
    else {
      const m = { ...textItem("m", []), content: [part] };
      await site([...start, delta("m", 0, "complete"), stage === "item_done" ? done(0, m) : terminal([m], stage === "incomplete" ? "max_output_tokens" : undefined)], `${stage}_reasoning_part`);
    }
  });
  it("covers the entire fixed inventory without accepting provider labels", () => {
    assert.equal(KIMI_OPAQUE_RESPONSE_SITES.length, 31);
    assert.deepEqual([...covered].sort(), [...KIMI_OPAQUE_RESPONSE_SITES].sort());
    assert(Object.isFrozen(KIMI_OPAQUE_RESPONSE_SITES));
  });
});
