/** Fabricated streams and in-memory stores only; no IO, auth or tool execution. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { deliverResponse } from "../../src/routing/response-delivery.js";
import { identifyProviderEvents } from "../../src/routing/provider-identity.js";
import { KimiExecPending } from "../../src/routing/kimi-exec-pending.js";
import { KimiExecStream } from "../../src/routing/kimi-exec-stream.js";
import { validatedProviderEvents } from "../../src/routing/provider-stream.js";
import { systemClock } from "../../src/routing/clock.js";
import { ContinuationStore } from "../../src/routing/continuation-store.js";
import { StagedCache } from "../../src/routing/replay-cache.js";
import { ClaudeCache } from "../../src/claude-cache.js";
import type { RoutedPrepared } from "../../src/routing/routed-attempt.js";
import { RoutingError, type AccessProfile, type Item } from "../../src/routing/routing-types.js";

const profile: AccessProfile = { provider: "kimi", product: "kimi-code", region: "global", billing: "subscription",
  account: "fabricated", credential: { kind: "native-oauth", authFile: "/fabricated/never-read" } };
const start = (): Item => ({ type: "response.created", sequence_number: -99,
  response: { id: "provider", status: "in_progress", output: [] } });
const call = (id: string, input: string, name = "exec"): Item => ({ type: "function_call", id, call_id: "call-" + id,
  name, status: "completed", arguments: name === "exec" ? JSON.stringify({ input }) : input });
const added = (item: Item, index: number): Item => ({ type: "response.output_item.added", output_index: index,
  item: { ...item, status: "in_progress", arguments: "" } });
const args = (item: Item, index: number): Item => ({ type: "response.function_call_arguments.done", item_id: item["id"],
  output_index: index, arguments: item["arguments"] });
const done = (item: Item, index: number): Item => ({ type: "response.output_item.done", output_index: index, item });
const terminal = (output: Item[]): Item => ({ type: "response.completed", sequence_number: 1e100,
  response: { id: "provider", status: "completed", output } });
const source = "// @exec: data only\r\n\u{1f600}e\u0301\0 ";
function interleaved(): Item[] {
  const one = call("one", source), two = call("two", " "), other = call("other", '{"path":"literal"}', "apply_patch");
  const message: Item = { type: "message", id: "message", status: "completed", role: "assistant", content: [] };
  return [start(), { type: "response.in_progress", sequence_number: 999, response: start()["response"] },
    added(one, 0), added(other, 2), added(two, 1),
    { type: "response.output_item.added", output_index: 3, item: { ...message, status: "in_progress" } },
    { type: "response.function_call_arguments.delta", item_id: "one", delta: one["arguments"] },
    args(one, 0), { type: "response.output_text.delta", item_id: "message", output_index: 3, delta: "after input.done" },
    args(other, 2), done(other, 2), args(two, 1), done(one, 0),
    { type: "response.output_text.delta", item_id: "message", output_index: 3, delta: "after executable done" },
    done(two, 1), done(message, 3), terminal([one, two, other, message])];
}
async function* items(events: readonly Item[]) { yield* events; }
function fixture(events: readonly Item[], options: {
  streaming?: boolean; validated?: boolean; direct?: boolean; pending?: KimiExecPending; model?: string;
  stage?: () => undefined; publish?: (response: Item | undefined) => void;
} = {}) {
  const pending = options.pending ?? new KimiExecPending(), controller = new AbortController(), log: string[] = [];
  let providerCompleted = false;
  const bytes = Buffer.from(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""));
  let offset = 0;
  const response = new Response(new ReadableStream<Uint8Array>({ pull(c) {
    if (offset === bytes.length) { c.close(); return; }
    c.enqueue(bytes.subarray(offset, offset + 31)); offset = Math.min(offset + 31, bytes.length);
  } }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });
  const raw = options.validated ? validatedProviderEvents(response, profile, "responses", controller.signal,
    controller, systemClock, () => { providerCompleted = true; }, undefined, undefined, new KimiExecStream(pending)) : items(events);
  const prepared: RoutedPrepared = { owner: "owner", protocol: "responses", commit() {}, async cancel() {},
    events: options.direct ? (async function* () { for (const payload of events) yield { protocol: "responses" as const, payload }; })()
      : identifyProviderEvents(raw, "responses", pending),
    orderedResponsesSuffix: { pending, beforePublication() { log.push("stage"); return options.stage?.(); } } };
  const iterator = deliverResponse(prepared, { protocol: "responses", responseId: "resp_subswitch_route_local", model: options.model ?? "kimi-for-coding",
    streaming: options.streaming ?? true, signal: controller.signal, checkDeadline() {},
    onCommit() { log.push("commit"); }, onTerminal(final) { log.push("publish"); options.publish?.(final); } });
  return { iterator, prepared, pending, controller, log, providerCompleted: () => providerCompleted };
}
async function collect(f: ReturnType<typeof fixture>) {
  const seen: Item[] = []; let error: unknown;
  try { for await (const event of f.iterator) seen.push(event); } catch (caught) { error = caught; }
  return { seen, error };
}
function errorCode(error: unknown, code: string) { assert(error instanceof RoutingError, String(error)); assert.equal(error.code, code); }

for (const streaming of [true, false]) test(`actual validator/identity/delivery preserves full projected order, streaming${streaming}`, async () => {
  const f = fixture(interleaved(), { streaming, validated: true });
  const seen: Item[] = [];
  for await (const event of f.iterator) {
    if (!streaming || seen.length >= 2) {
      assert(f.providerCompleted());
      assert.deepEqual(f.log.filter(v => v !== "commit"), ["stage", "publish"]);
    }
    seen.push(event);
  }
  assert.deepEqual(seen.map(e => e["sequence_number"]), seen.map((_, i) => i));
  const expectedTypes = interleaved().map(e => e["type"]).filter(t => t !== "response.function_call_arguments.delta");
  for (const index of [6, 10]) expectedTypes[index] = "response.custom_tool_call_input.done";
  assert.deepEqual(seen.map(e => e["type"]), expectedTypes);
  assert.equal(seen[6]!["input"], source);
  assert.equal((seen[11]!["item"] as Item)["input"], source);
  assert.equal((seen[8]!["arguments"]), '{"path":"literal"}');
  for (const e of seen) if (e["response"]) {
    assert.equal((e["response"] as Item)["id"], "resp_subswitch_route_local");
    assert.equal((e["response"] as Item)["model"], "kimi-for-coding");
  }
  assert.equal(f.log.filter(v => v === "commit").length, 1);
  assert.equal(f.pending.byteSize, 0);
});

for (const failure of ["none", "stage", "continuation", "cache"] as const) test(`synchronous stores publish or withhold entire suffix: ${failure}`, async () => {
  const shared = new ClaudeCache({ maxEntries: 10, maxBytes: failure === "cache" ? 1 : 100000 }, true);
  const stage = new StagedCache(shared), continuations = new ContinuationStore();
  const request: Item = { tools: [{ type: "custom", name: "exec" }], input: [] };
  const state = { conversation: "conversation", route: "route", request, output: [] as Item[], owner: "owner",
    protocol: "responses" as const, scope: "single-target" as const };
  const id = "resp_subswitch_route_local";
  if (failure === "continuation") continuations.put(state, id);
  const order: string[] = [];
  const f = fixture(interleaved(), { validated: true, stage() {
    order.push("stage"); if (failure === "stage") throw new RoutingError("fabricated_stage_failure", 502);
    stage.put("adapted", "marker", true); return undefined;
  }, publish(final) {
    order.push("continuation-preflight");
    const publish = continuations.preparePut({ ...state, output: final!["output"] as Item[] }, id);
    order.push("cache-commit"); stage.commit();
    order.push("continuation-publish"); publish(); order.push("quota-success");
  } });
  const result = await collect(f);
  if (failure === "none") {
    assert.equal(result.error, undefined);
    assert.deepEqual(order, ["stage", "continuation-preflight", "cache-commit", "continuation-publish", "quota-success"]);
    assert.equal(shared.get("adapted", "marker"), true);
    const saved = continuations.get(id, undefined, "route", "responses");
    assert.deepEqual(saved.request, request);
    assert.equal(saved.output[0]!["type"], "custom_tool_call");
    assert.equal(saved.output[0]!["input"], source);
  } else {
    assert(result.error);
    assert.deepEqual(result.seen.map(e => e["type"]), ["response.created", "response.in_progress"]);
    assert.equal(shared.get("adapted", "marker"), undefined);
    assert(!order.includes("continuation-publish"));
    if (failure !== "continuation") assert.throws(() => continuations.get(id, undefined, "route", "responses"));
  }
  assert.equal(f.pending.byteSize, 0);
});

test("local model escape expansion rejects prefix before commitment", async () => {
  const f = fixture([start(), terminal([])], { direct: true, model: "\0".repeat(700000) });
  const result = await collect(f);
  errorCode(result.error, "sse_event_too_large"); assert.deepEqual(result.seen, []); assert.deepEqual(f.log, []);
  assert.equal(f.pending.byteSize, 0);
});
test("final terminal frame expansion rejects the whole held suffix before staging", async () => {
  const item: Item = { type: "custom_tool_call", name: "exec", id: "call", call_id: "call", input: "a".repeat(2200000) };
  const f = fixture([start(), { type: "response.output_item.added", item: { ...item, input: "" } },
    { type: "response.custom_tool_call_input.done", input: item["input"] },
    { type: "response.output_item.done", item }, terminal([item])], { direct: true, model: "m".repeat(2000000) });
  const result = await collect(f);
  errorCode(result.error, "sse_event_too_large");
  assert.deepEqual(result.seen.map(e => e["type"]), ["response.created"]); assert.deepEqual(f.log, ["commit"]);
  assert.equal(f.pending.byteSize, 0);
});
for (const extra of [0, 1]) test(`final encoded SSE envelope boundary extra${extra}`, async () => {
  const event: Item = { type: "response.in_progress", padding: "", sequence_number: 0 };
  event["padding"] = "x".repeat(4 * 1024 * 1024 - 8 - Buffer.byteLength(JSON.stringify(event)) + extra);
  const f = fixture([event, terminal([])], { direct: true }), result = await collect(f);
  if (extra) { errorCode(result.error, "sse_event_too_large"); assert.equal(result.seen.length, 0); }
  else { assert.equal(result.error, undefined); assert.equal(Buffer.byteLength(`data: ${JSON.stringify(result.seen[0])}\n\n`), 4 * 1024 * 1024); }
  assert.equal(f.pending.byteSize, 0);
});
test("delivery never resets another owner's pending pressure", async () => {
  const pending = new KimiExecPending(), other = pending.reserve(pending.limit - 64);
  const f = fixture([start(), terminal([])], { direct: true, pending }), result = await collect(f);
  errorCode(result.error, "provider_state_too_large"); assert.deepEqual(result.seen, []); assert.deepEqual(f.log, []);
  assert.equal(pending.byteSize, pending.limit - 64); other.release();
});
test("identity retains raw, parsed and ClientEvent representations while parked", async () => {
  const pending = new KimiExecPending(), other = pending.reserve(73), raw = { data: JSON.stringify(start()) };
  const iterator = identifyProviderEvents((async function* () { yield raw; })(), "responses", pending);
  const next = await iterator.next();
  const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value)) + 1;
  assert.equal(pending.byteSize, 73 + size(raw) + size(start()) + size(next.value));
  await iterator.return(undefined); assert.equal(pending.byteSize, 73); other.release();
});
test("identity parse error releases only its own raw reservation", async () => {
  const pending = new KimiExecPending(), other = pending.reserve(73);
  const iterator = identifyProviderEvents((async function* () { yield { data: "{invalid" }; })(), "responses", pending);
  await assert.rejects(iterator.next(), SyntaxError); assert.equal(pending.byteSize, 73); other.release();
});
for (const when of ["before", "after"] as const) test(`cancellation ${when} publication drops suffix without rollback`, async () => {
  const pending = new KimiExecPending(), other = pending.reserve(73); let published = false;
  const f = fixture(interleaved(), { validated: true, pending,
    stage() { if (when === "before") f.controller.abort(); return undefined; },
    publish() { published = true; if (when === "after") f.controller.abort(); } });
  const result = await collect(f); assert(result.error);
  assert.equal(published, when === "after");
  assert.deepEqual(result.seen.map(e => e["type"]), ["response.created", "response.in_progress"]);
  assert.equal(pending.byteSize, 73); other.release();
});
test("parked suffix stays charged through publication and clears on abort", async () => {
  const pending = new KimiExecPending(), other = pending.reserve(73), f = fixture(interleaved(), { validated: true, pending });
  await f.iterator.next(); await f.iterator.next();
  assert.equal((await f.iterator.next()).value!["type"], "response.output_item.added");
  assert(f.pending.byteSize > 73); assert(f.log.includes("publish"));
  f.controller.abort(); await assert.rejects(f.iterator.next());
  assert.equal(f.pending.byteSize, 73); other.release();
});
for (const events of [[start()], [start(), terminal([]), { type: "response.output_text.delta", delta: "late" }]])
  test(`missing/trailing terminal fails before publication, length${events.length}`, async () => {
    const f = fixture(events), result = await collect(f); assert(result.error);
    assert.deepEqual(f.log, ["commit"]); assert.equal(f.pending.byteSize, 0);
  });

test("final local response identity expansion refuses a provider-sized terminal before publication", async () => {
  const last = terminal([]); last["sequence_number"] = 0;
  const response = last["response"] as Item; response["padding"] = "";
  response["padding"] = "x".repeat(4 * 1024 * 1024 - 8 - Buffer.byteLength(JSON.stringify(last)));
  assert.equal(Buffer.byteLength(`data: ${JSON.stringify(last)}\n\n`), 4 * 1024 * 1024);
  const f = fixture([start(), last], { direct: true }), result = await collect(f);
  errorCode(result.error, "sse_event_too_large"); assert.deepEqual(result.seen.map(e => e["type"]), ["response.created"]);
  assert.deepEqual(f.log, ["commit"]); assert.equal(f.pending.byteSize, 0);
});
for (const index of [9, 10]) test(`final decimal sequence expansion exact boundary index${index}`, async () => {
  const event: Item = { type: "response.output_text.delta", delta: "", sequence_number: 0 };
  event["delta"] = "x".repeat(4 * 1024 * 1024 - 8 - Buffer.byteLength(JSON.stringify(event)));
  const prefix: Item[] = Array.from({ length: index }, () => ({ type: "response.in_progress", sequence_number: 0 }));
  const f = fixture([...prefix, event, terminal([])], { direct: true }), result = await collect(f);
  if (index === 9) {
    assert.equal(result.error, undefined); assert.equal(result.seen[index]!["sequence_number"], index);
    assert.equal(Buffer.byteLength(`data: ${JSON.stringify(result.seen[index])}\n\n`), 4 * 1024 * 1024);
  } else {
    errorCode(result.error, "sse_event_too_large"); assert.equal(result.seen.length, index); assert.deepEqual(f.log, ["commit"]);
  }
  assert.equal(f.pending.byteSize, 0);
});
