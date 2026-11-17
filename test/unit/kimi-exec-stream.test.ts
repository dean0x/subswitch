/** Fabricated streams only: no transport, auth, files, listeners or tool execution. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SseEvent } from "../../src/codex-response.js";
import { validatedProviderEvents } from "../../src/routing/provider-stream.js";
import { KimiExecStream } from "../../src/routing/kimi-exec-stream.js";
import { KimiExecPending } from "../../src/routing/kimi-exec-pending.js";
import { systemClock } from "../../src/routing/clock.js";
import { RoutingError, type AccessProfile, type Item } from "../../src/routing/routing-types.js";

const profile: AccessProfile = { provider: "kimi", product: "kimi-code", region: "global", billing: "subscription",
  account: "fabricated", credential: { kind: "native-oauth", authFile: "/fabricated/never-read" } };
const start = (): Item => ({ type: "response.created", sequence_number: -900,
  response: { id: "provider", status: "in_progress", output: [] } });
const call = (id = "one", source = "// @exec: data only\r\n\u{1f600}e\u0301\0"): Item => ({ type: "function_call",
  id: "item-" + id, call_id: "call-" + id, name: "exec", status: "completed", arguments: JSON.stringify({ input: source }) });
const added = (item: Item, index = 0): Item => ({ type: "response.output_item.added", output_index: index,
  item: { ...item, status: "in_progress", ...(item["type"] === "function_call" ? { arguments: "" } : { input: "" }) } });
const args = (item: Item, index = 0): Item => ({ type: "response.function_call_arguments.done", item_id: item["id"],
  call_id: item["call_id"], output_index: index, arguments: item["arguments"] });
const done = (item: Item, index = 0): Item => ({ type: "response.output_item.done", output_index: index, item });
const terminal = (output: Item[]): Item => ({ type: "response.completed", sequence_number: 999999999999,
  response: { id: "provider", status: "completed", output } });
const fixture = (item = call()): Item[] => [start(), added(item), args(item), done(item), terminal([item])];
const wire = (events: readonly Item[]) => Buffer.from(events.map(e => `event: ${e["type"]}\r\ndata: ${JSON.stringify(e)}\r\n\r\n`).join(""));
function response(bytes: Uint8Array, fragment = bytes.length): Response {
  let offset = 0;
  return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
    if (offset >= bytes.length) { controller.close(); return; }
    controller.enqueue(bytes.slice(offset, offset + fragment)); offset += fragment;
  } }), { headers: { "content-type": "text/event-stream" } });
}
async function consume(events: readonly Item[], options: {
  fragment?: number; pending?: KimiExecPending; bytes?: Uint8Array; cancelAfter?: number; defaultMode?: boolean;
} = {}) {
  const mappedCalls: Item[][] = [];
  // Observe the real terminal result before generator disposal clears its arrays.
  class ObservedStream extends KimiExecStream {
    override accept(...parameters: Parameters<KimiExecStream["accept"]>) {
      const step = super.accept(...parameters);
      if (step.kind === "terminal") mappedCalls.push(structuredClone([...step.calls]));
      return step;
    }
  }
  const context = new ObservedStream(options.pending), controller = new AbortController();
  const seen: SseEvent[] = [], usage: number[] = [], finals: Item[] = [];
  let error: unknown;
  try {
    for await (const event of validatedProviderEvents(response(options.bytes ?? wire(events), options.fragment), profile, "responses",
      controller.signal, controller, systemClock, final => { finals.push(structuredClone(final)); },
      undefined, undefined, options.defaultMode ? undefined : context)) {
      seen.push(event); usage.push(context.pending.byteSize);
      if (options.cancelAfter === seen.length) break;
    }
  } catch (caught) { error = caught; }
  return { seen, usage, finals, mappedCalls, error, context, payloads: seen.map(e => JSON.parse(e.data) as Item) };
}
function refused(result: Awaited<ReturnType<typeof consume>>, code = "invalid_provider_tool_lifecycle", prefix = ["response.created"]) {
  assert(result.error instanceof RoutingError, String(result.error));
  assert.equal(result.error.code, code);
  assert.equal(result.error.status, 502);
  assert.deepEqual(result.payloads.map(e => e["type"]), prefix);
  assert.equal(result.finals.length, 0);
  assert.equal(result.context.pending.byteSize, 0);
}

// Adapt the independent KS-1 defect reproduction to assert the desired behavior.
function nonTool(kind: "message" | "reasoning"): Item {
  return { type: kind, id: "non-tool", name: "exec", namespace: "functions", status: "completed",
    extra: { preserve: true }, ...(kind === "message"
      ? { role: "assistant", content: [{ type: "output_text", text: "must remain text" }] }
      : { summary: [{ type: "summary_text", text: "must remain reasoning" }] }) };
}
const nonToolAdded = (item: Item, index = 0): Item => ({ type: "response.output_item.added", output_index: index,
  item: { ...item, status: "in_progress" } });
function nativeCall(item: Item, source: string, initial = false): Item {
  return { type: "custom_tool_call", id: item["id"], call_id: item["call_id"], name: "exec",
    status: initial ? "in_progress" : "completed", input: initial ? "" : source };
}

for (const kind of ["message", "reasoning"] as const) {
  for (const completion of ["completed", "incomplete"] as const) {
    test(`KS-1 preserves ${kind} named exec through ${completion}, without mapped calls`, async () => {
      const item = nonTool(kind), end = terminal([item]);
      end["type"] = `response.${completion}`;
      Object.assign(end["response"] as Item, { status: completion,
        ...(completion === "incomplete" ? { incomplete_details: { reason: "max_output_tokens" } } : {}) });
      const events = [start(), nonToolAdded(item), { type: kind === "message"
        ? "response.output_text.delta" : "response.reasoning_summary_text.delta",
      item_id: item["id"], output_index: 0, content_index: 0, delta: "preserved" }, done(item), end];
      const result = await consume(events, { fragment: 1 });
      assert.equal(result.error, undefined);
      assert.deepEqual(result.finals, [end["response"]]);
      assert.deepEqual(result.payloads, events, "all non-tool fields, status and event order survive");
      assert.deepEqual(result.mappedCalls, [[]], "name collisions cannot create associations");
      for (let i = 0; i < events.length - 1; i++)
        assert.equal(result.seen[i]!.data, JSON.stringify(events[i]), "unmapped SSE data is byte-exact");
      assert.equal(result.context.pending.byteSize, 0);
    });
  }
  test(`KS-1 maps only validated exec among interleaved ${kind} name collisions`, async () => {
    const source = "// @exec: data only\r\n\0\u{1f600}", exec = call("mapped", source), other = nonTool(kind);
    const raw = [start(), added(exec), nonToolAdded(other, 1),
      { type: "response.function_call_arguments.delta", item_id: exec["id"], output_index: 0, delta: exec["arguments"] },
      args(exec), done(other, 1), done(exec), terminal([exec, other])];
    const result = await consume(raw, { fragment: 1 }), mapped = nativeCall(exec, source);
    assert.equal(result.error, undefined);
    assert.deepEqual(result.mappedCalls, [[mapped]]);
    assert.deepEqual(result.finals[0]!["output"], [mapped, other]);
    assert.deepEqual(result.payloads, [raw[0], { ...raw[1], item: nativeCall(exec, source, true) }, raw[2],
      { type: "response.custom_tool_call_input.done", item_id: exec["id"], call_id: exec["call_id"], output_index: 0, input: source },
      raw[5], { ...raw[6], item: mapped }, { ...raw[7], response: result.finals[0] }]);
    assert.equal(result.seen[2]!.data, JSON.stringify(raw[2]));
    assert.equal(result.seen[4]!.data, JSON.stringify(raw[5]));
    assert.equal(result.context.pending.byteSize, 0);
  });
}
for (const source of [" ", "\0"]) test(`KS-1 retains validated nonempty source ${JSON.stringify(source)}`, async () => {
  const item = call("source", source), result = await consume(fixture(item)), mapped = nativeCall(item, source);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.mappedCalls, [[mapped]]);
  assert.deepEqual(result.finals[0]!["output"], [mapped]);
  assert.deepEqual(result.payloads[1]!["item"], nativeCall(item, source, true));
  assert.deepEqual(result.payloads[3]!["item"], mapped);
  assert.equal(result.payloads[2]!["input"], source);
  assert.equal(result.context.pending.byteSize, 0);
});

test("actual validator projects zero-delta lifecycle once, preserving exact source and native terminal", async () => {
  const result = await consume(fixture());
  assert.equal(result.error, undefined);
  assert.deepEqual(result.payloads.map(e => e["type"]), ["response.created", "response.output_item.added",
    "response.custom_tool_call_input.done", "response.output_item.done", "response.completed"]);
  assert.equal((result.payloads[1]!["item"] as Item)["input"], "");
  const source = JSON.parse(call()["arguments"] as string).input;
  assert.equal(result.payloads[2]!["input"], source);
  assert.equal((result.payloads[3]!["item"] as Item)["input"], source);
  const output = result.finals[0]!["output"] as Item[];
  assert.deepEqual(output, [{ type: "custom_tool_call", id: "item-one", call_id: "call-one", name: "exec", status: "completed", input: source }]);
  assert.deepEqual((result.payloads.at(-1)!["response"] as Item)["output"], output);
  assert.equal(result.payloads[0]!["sequence_number"], -900, "final delivery numbering is a separate unfinished layer");
  assert(result.usage.slice(1).every(bytes => bytes > 0), "generator retains shared reservations through every projected yield");
  assert.equal(result.context.pending.byteSize, 0);
});

test("interleaved calls retain original total order and all unmapped payloads before legacy holding", async () => {
  const a = call("a"), b = call("b", " \t\r\n// @exec: untrusted source");
  const patch: Item = { type: "custom_tool_call", id: "patch", call_id: "patch-call", name: "apply_patch", input: "patch", status: "completed" };
  const message: Item = { type: "message", id: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "after" }] };
  const fragments = (a["arguments"] as string).match(/.{1,3}/gs)!;
  const delta = fragments.map(part => ({ type: "response.function_call_arguments.delta", item_id: a["id"], output_index: 0, delta: part }));
  const raw: Item[] = [start(), added(a), { type: "response.output_item.added", output_index: 1, item: { ...message, status: "in_progress", content: [] } },
    ...delta, args(a), { type: "response.output_text.delta", item_id: "message", output_index: 1, content_index: 0, delta: "after" },
    added(b, 2), added(patch, 3), done(a),
    { type: "response.custom_tool_call_input.delta", item_id: "patch", output_index: 3, delta: "patch" },
    { type: "response.custom_tool_call_input.done", item_id: "patch", output_index: 3, input: "patch" },
    args(b, 2), done(patch, 3), done(message, 1), done(b, 2), terminal([a, message, b, patch])];
  const result = await consume(raw, { fragment: 1 });
  assert.equal(result.error, undefined);
  const expected = raw.filter(e => e["type"] !== "response.function_call_arguments.delta").map(e => {
    const out = structuredClone(e), item = out["item"] as Item | undefined;
    if (item?.["name"] === "exec") {
      item["input"] = item["status"] === "in_progress" ? "" : JSON.parse(item["arguments"] as string).input;
      item["type"] = "custom_tool_call"; delete item["arguments"];
    }
    if (out["type"] === "response.function_call_arguments.done") {
      out["type"] = "response.custom_tool_call_input.done";
      out["input"] = JSON.parse(out["arguments"] as string).input; delete out["arguments"];
    }
    if (out["type"] === "response.completed") (out["response"] as Item)["output"] = result.finals[0]!["output"];
    return out;
  });
  assert.deepEqual(result.payloads, expected);
  for (const type of ["response.output_text.delta", "response.custom_tool_call_input.delta"]) {
    const original = raw.find(e => e["type"] === type)!;
    assert.equal(result.seen.find(e => JSON.parse(e.data).type === type)!.data, JSON.stringify(original));
  }
  assert.equal(result.context.pending.byteSize, 0);
});

const mutations: [string, (events: Item[]) => void][] = [
  ["wrong item id", e => { e[2]!["item_id"] = "other"; }],
  ["one conflicting call id", e => { e[2]!["call_id"] = "other"; }],
  ["one conflicting output index", e => { e[2]!["output_index"] = 1; }],
  ["fractional output index", e => { e[1]!["output_index"] = 0.5; }],
  ["negative output index", e => { e[1]!["output_index"] = -1; }],
  ["oversized output index", e => { e[1]!["output_index"] = 1024; }],
  ["namespaced wrapper", e => { (e[1]!["item"] as Item)["namespace"] = ""; }],
  ["namespaced done", e => { e[2]!["namespace"] = "functions"; }],
  ["renamed done", e => { (e[3]!["item"] as Item)["name"] = "other"; }],
  ["wrong event status", e => { e[2]!["status"] = "in_progress"; }],
  ["wrong item status", e => { (e[3]!["item"] as Item)["status"] = "in_progress"; }],
  ["changed terminal source", e => { ((e[4]!["response"] as Item)["output"] as Item[])[0]!["arguments"] = '{"input":"different"}'; }],
  ["changed item done source", e => { (e[3]!["item"] as Item)["arguments"] = '{"input":"different"}'; }],
  ["nonempty initial snapshot", e => { (e[1]!["item"] as Item)["arguments"] = '{"input":"snapshot"}'; }],
  ["encrypted tool payload", e => { (e[1]!["item"] as Item)["encrypted_function_args"] = ["opaque"]; }],
  ["top-level alternate arguments", e => { e[1]!["arguments"] = '{"input":"unprojected"}'; }],
  ["duplicate done", e => { e.splice(4, 0, structuredClone(e[3]!)); }],
  ["duplicate arguments done", e => { e.splice(3, 0, structuredClone(e[2]!)); }],
  ["duplicate added", e => { e.splice(2, 0, structuredClone(e[1]!)); }],
  ["missing added", e => { e.splice(1, 1); }],
  ["missing arguments done", e => { e.splice(2, 1); }],
  ["missing item done", e => { e.splice(3, 1); }],
  ["terminal-only tool", e => { e.splice(1, 3); }],
  ["duplicate terminal", e => { e.push(structuredClone(e[4]!)); }],
  ["event after terminal", e => { e.push({ type: "response.output_text.delta", delta: "late" }); }],
  ["wrong terminal id", e => { (e[4]!["response"] as Item)["id"] = "other"; }],
  ["wrong response id on done", e => { e[2]!["response_id"] = "other"; }],
  ["text event bearing tool id", e => { e.splice(3, 0, { type: "response.output_text.delta", item_id: "item-one", delta: "alternate" }); }],
  ["in-progress snapshot", e => { e.splice(2, 0, { type: "response.in_progress", response: { id: "provider", status: "in_progress", output: [call()] } }); }],
  ["incomplete tool", e => { e[4]!["type"] = "response.incomplete"; (e[4]!["response"] as Item)["status"] = "incomplete"; }],
  ["completed response carrying an error", e => { (e[4]!["response"] as Item)["error"] = { code: "fabricated" }; }],
  ["completed response carrying incomplete details", e => { (e[4]!["response"] as Item)["incomplete_details"] = { reason: "max_output_tokens" }; }],
  ["refusal after tool start", e => { e.splice(2, 0, { type: "response.refusal.delta", delta: "refused" }); }],
  ["refusal before tool start", e => { e.splice(1, 0, { type: "response.refusal.done", refusal: "refused" }); }],
  ["same call id in another item", e => { e.splice(2, 0, added({ ...call("other"), call_id: "call-one" }, 1)); }],
  ["same item id in another index", e => { e.splice(2, 0, added({ ...call("other"), id: "item-one" }, 1)); }],
];
for (const [name, mutate] of mutations) test(`raw lifecycle refuses ${name} without a suffix or publication`, async () => {
  const events = structuredClone(fixture()); mutate(events);
  refused(await consume(events), "invalid_provider_tool_lifecycle", name === "refusal before tool start"
    ? ["response.created", "response.refusal.done"] : ["response.created"]);
});

for (const source of ['{"input":"a","input":"b"}', '{"\\u0069nput":"source"}', '{"input":"\\ud800"}',
  '{"input":""}', '{"input":"source","other":true}', '{}', '{"input":null}', '{"input":"source"} trailing']) {
  test(`closed wrapper refuses ${source}`, async () => {
    const item = { ...call(), arguments: source }; refused(await consume(fixture(item)));
  });
}
test("nonzero deltas must concatenate exactly to done; zero-delta exception cannot repair conflicts", async () => {
  const events = fixture();
  events.splice(2, 0, { type: "response.function_call_arguments.delta", item_id: "item-one", output_index: 0, delta: '{"input":"other"}' });
  refused(await consume(events));
});
test("missing terminal or return from a suspended projected yield releases owned reservations", async () => {
  refused(await consume(fixture().slice(0, -1)), "missing_provider_terminal");
  const result = await consume(fixture(), { cancelAfter: 2 });
  assert.equal(result.error, undefined);
  assert.equal(result.context.pending.byteSize, 0);
  assert.equal(result.seen.length, 2);
  assert.equal(result.finals.length, 1, "provider validation is complete; downstream publication remains a separate pending gate");
});
test("abort while the raw suffix waits for terminal publishes nothing and clears owned reservations", async () => {
  const context = new KimiExecStream(), controller = new AbortController();
  let upstream!: ReadableStreamDefaultController<Uint8Array>;
  let completed = false;
  const body = new ReadableStream<Uint8Array>({ start(value) { upstream = value; } });
  const iterator = validatedProviderEvents(new Response(body, { headers: { "content-type": "text/event-stream" } }),
    profile, "responses", controller.signal, controller, systemClock, () => { completed = true; }, undefined, undefined, context);
  upstream.enqueue(wire([start()]));
  assert.equal(JSON.parse((await iterator.next()).value!.data).type, "response.created");
  upstream.enqueue(wire([added(call()), args(call())]));
  const waiting = iterator.next();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert(context.pending.byteSize > 0);
  controller.abort();
  await assert.rejects(waiting, /provider_stream_timeout_or_cancelled/);
  assert.equal(completed, false);
  assert.equal(context.pending.byteSize, 0);
});
test("abort while parked in the validated suffix refuses further executable events", async () => {
  const context = new KimiExecStream(), controller = new AbortController();
  const iterator = validatedProviderEvents(response(wire(fixture())), profile, "responses", controller.signal,
    controller, systemClock, () => {}, undefined, undefined, context);
  assert.equal(JSON.parse((await iterator.next()).value!.data).type, "response.created");
  assert.equal(JSON.parse((await iterator.next()).value!.data).type, "response.output_item.added");
  assert(context.pending.byteSize > 0);
  controller.abort();
  await assert.rejects(iterator.next(), /provider_stream_timeout_or_cancelled/);
  assert.equal(context.pending.byteSize, 0);
});
test("shared reservations cannot reset at the raw/projected boundary or release another owner's allocation", async () => {
  const pending = new KimiExecPending(), held = pending.limit - 128, other = pending.reserve(held);
  const result = await consume(fixture(), { pending });
  assert(result.error instanceof RoutingError);
  assert.equal(result.error.code, "provider_state_too_large");
  assert(result.seen.length <= 1, "transport may exhaust the shared allowance before even the start record");
  assert.equal(result.finals.length, 0);
  assert.equal(pending.byteSize, held);
  other.release(); other.release();
  assert.equal(pending.byteSize, 0);
});
test("simultaneous raw/lifecycle/native/projected expansion refuses before the held suffix is released", async () => {
  const item = call("large", "x".repeat(2100000)), events = fixture(item);
  events.splice(2, 0, { type: "response.function_call_arguments.delta", item_id: item["id"], output_index: 0, delta: item["arguments"] });
  refused(await consume(events, { fragment: 65536 }), "provider_state_too_large");
});
test("malformed and truncated UTF8 refuse instead of replacement-character repair", async () => {
  for (const bytes of [Buffer.concat([wire([start(), added(call())]), Buffer.from([0xc3, 0x28])]),
    Buffer.concat([wire([start(), added(call())]), Buffer.from([0xf0, 0x9f])])]) {
    const result = await consume([], { bytes, fragment: 1 });
    assert(result.error instanceof RoutingError);
    assert.equal(result.error.code, "invalid_provider_utf8");
    assert(result.seen.length <= 1);
    assert.equal(result.finals.length, 0);
    assert.equal(result.context.pending.byteSize, 0);
  }
});
test("default validator behavior and raw function payload remain unchanged without explicit context", async () => {
  const result = await consume(fixture(), { defaultMode: true });
  assert.equal(result.error, undefined);
  assert.equal(result.payloads[2]!["type"], "response.function_call_arguments.done");
  assert.equal((result.finals[0]!["output"] as Item[])[0]!["type"], "function_call");
});
