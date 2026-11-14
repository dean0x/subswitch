/** Private summary lifecycle: fabricated state, socketless transports. */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as source from "../../src/routing/kimi-responses-bridge.js";
import { KimiExecPending } from "../../src/routing/kimi-exec-pending.js";
import { aggregateFrames } from "../../src/codex-response.js";
import { ClaudeCache } from "../../src/claude-cache.js";
import type { Item } from "../../src/routing/routing-types.js";
import { fixture, ordered, profile, response, wire } from "../helpers/kimi-ordered-route.js";
import { added, created, done, terminal, textItem } from "../helpers/kimi-responses-bridge.js";

const generated = await import(new URL("../../dist/routing/kimi-responses-bridge.js", import.meta.url).href) as typeof source;
const empty = () => ({ type: "summary_text", text: "" });
const summaryEvent = (type: string, summary_index = 0, rest: Item = {}): Item =>
  ({ type: `response.reasoning_summary_${type}`, output_index: 0, item_id: "r", summary_index, ...rest });
function events(count = 1, texts: readonly string[] = [], encrypted = true): Item[] {
  const summaries = Array.from({ length: count }, (_, i) => ({ type: "summary_text", text: texts[i] ?? "" }));
  const r = { id: "r", type: "reasoning", status: "completed", summary: summaries,
    ...(encrypted ? { encrypted_content: "fabricated-encryption" } : {}) };
  const m = textItem("m", ["שלום 🦊"]);
  const c = { id: "fc", type: "function_call", call_id: "caller", name: "inspect", arguments: ' { "n":-0,"s":"🦊" } ', status: "completed" };
  const summaryEvents = summaries.map((part, i) => [
    summaryEvent("part.added", i, { part: empty() }), summaryEvent("text.delta", i, { delta: part.text }),
    summaryEvent("text.done", i, { text: part.text }), summaryEvent("part.done", i, { part }),
  ]).flat();
  return [created(), added(0, { ...r, summary: [], status: "in_progress", encrypted_content: null }), ...summaryEvents, done(0, r),
    added(1, { ...m, content: [], status: "in_progress" }), done(1, m), added(2, { ...c, arguments: "", status: "in_progress" }), done(2, c), terminal([r, m, c])].map(e => structuredClone(e));
}

for (const [name, module] of [["source", source], ["generated", generated]] as const) {
  async function run(input: Item[], options: { omitted?: boolean; noReplay?: boolean; tail?: string; abortAtEof?: boolean; errorAtEof?: boolean; pendingLimit?: number } = {}) {
    const controller = new AbortController(), pending = new KimiExecPending(), leases: { release(): void }[] = [];
    if (options.pendingLimit !== undefined) Object.defineProperty(pending, "limit", { value: options.pendingLimit });
    let completions = 0, publications = 0, raw: readonly Item[] | undefined, assistant: Item | undefined, error: unknown;
    let frames: readonly string[] = [];
    const logs: unknown[] = [];
    const transport = response(wire(input) + (options.tail ?? ""), 4096, () => {
      assert.equal(publications, 0); assert.equal(completions, 0);
      if (options.abortAtEof) controller.abort();
      if (options.errorAtEof) throw Error("fabricated-stream-failure");
    });
    try {
      frames = await module.renderValidatedKimiResponses(transport, profile, controller.signal, controller,
        { now: () => 1, monotonic: () => 1, random: () => 0.5, schedule: () => () => {} }, () => { completions++; },
        { logger: { log(...values) { logs.push(values); } }, limitContext: {} as never },
        options.noReplay ? undefined : { pending, leases, omittedDisplay: options.omitted ?? true,
          onOutput(output, visible) { publications++; raw = output; assistant = visible; } });
    } catch (caught) { error = caught; }
    finally { for (const lease of leases) lease.release(); }
    assert.equal(pending.byteSize, 0);
    if (error) { assert.deepEqual(frames, []); assert.equal(completions, 0); assert.equal(publications, 0); }
    return { error, frames, completions, publications, raw, assistant, logs };
  }
  for (const count of [0, 1, 3]) test(`${name}: empty summary lifecycle ${count} preserves exact final state and visible tools`, async () => {
    const input = events(count), result = await run(input);
    assert.equal(result.error, undefined); assert.equal(result.completions, 1); assert.equal(result.publications, 1);
    assert.deepEqual(result.raw, (input.at(-1)!["response"] as Item)["output"]);
    assert.deepEqual(result.assistant, { role: "assistant", content: [{ type: "text", text: "שלום 🦊" },
      { type: "tool_use", id: "caller", name: "inspect", input: { n: 0, s: "🦊" } }] });
    assert.equal((result.raw![2]!["arguments"] as string), ' { "n":-0,"s":"🦊" } ');
    assert(!JSON.stringify(result.frames).includes("fabricated-encryption")); assert.deepEqual(result.logs, []);
  });
  test(`${name}: empty deltas are optional and may repeat before text completion`, async () => {
    for (const mode of ["none", "repeated"]) {
      const input = events();
      if (mode === "none") input.splice(3, 1); else input.splice(3, 0, structuredClone(input[3]!));
      assert.equal((await run(input)).error, undefined);
    }
  });
  test(`${name}: readable Unicode summaries remain exact private state across delta splits and done-only text`, async () => {
    const texts = ["private e\u0301 🦊\u0000\"\\\n", "second private summary"];
    for (const mode of ["split", "done-only"]) {
      const input = events(2, texts);
      if (mode === "split") {
        input[3]!["delta"] = texts[0]!.slice(0, 12);
        input.splice(4, 0, summaryEvent("text.delta", 0, { delta: texts[0]!.slice(12) }));
      } else input.splice(3, 1);
      const result = await run(input);
      assert.equal(result.error, undefined); assert.equal(result.publications, 1);
      assert.deepEqual(result.raw, (input.at(-1)!["response"] as Item)["output"]);
      assert(!JSON.stringify([result.frames, result.assistant, result.logs]).includes("private"));
      assert.deepEqual(result.assistant, { role: "assistant", content: [{ type: "text", text: "שלום 🦊" },
        { type: "tool_use", id: "caller", name: "inspect", input: { n: 0, s: "🦊" } }] });
    }
  });
  test(`${name}: readable summary mismatches at text, part, item and terminal refuse atomically`, async () => {
    for (const encrypted of [true, false]) for (const stage of ["text", "part", "item", "terminal"]) {
      const input = events(1, ["private summary"], encrypted);
      if (stage === "text") input[4]!["text"] = "different";
      if (stage === "part") (input[5]!["part"] as Item)["text"] = "different";
      if (stage === "item") ((input[6]!["item"] as Item)["summary"] as Item[])[0]!["text"] = "different";
      if (stage === "terminal") ((input.at(-1)!["response"] as Item)["output"] as Item[])[0]!["summary"] = [{ type: "summary_text", text: "different" }];
      const result = await run(input);
      assert(result.error instanceof module.KimiResponsesBridgeError); assert.equal(result.error.code, "conflicting_content");
      assert(!JSON.stringify([result.error, result.logs]).includes("private summary"));
    }
  });
  const mutations: Record<string, (e: Item[]) => void> = {
    "missing added item": e => { e.splice(1, 1); },
    "foreign item id": e => { e[2]!["item_id"] = "other"; },
    "foreign output index": e => { e[2]!["output_index"] = 1; },
    "non reasoning owner": e => { e[1] = added(0, { ...textItem("r", []), status: "in_progress" }); },
    "negative index": e => { e[2]!["summary_index"] = -1; },
    "fractional index": e => { e[2]!["summary_index"] = 0.5; },
    "string index": e => { e[2]!["summary_index"] = "0"; },
    "missing index": e => { delete e[2]!["summary_index"]; },
    "unsafe index": e => { e[2]!["summary_index"] = Number.MAX_SAFE_INTEGER + 1; },
    "sparse index": e => { e[2]!["summary_index"] = Number.MAX_SAFE_INTEGER; },
    "foreign text part": e => { e[3]!["summary_index"] = 1; },
    "part before prior closure": e => { e.splice(3, 0, summaryEvent("part.added", 1, { part: empty() })); },
    "duplicate part added": e => { e.splice(3, 0, structuredClone(e[2]!)); },
    "text before added": e => { e.splice(2, 1); },
    "duplicate text done": e => { e.splice(5, 0, structuredClone(e[4]!)); },
    "delta after text done": e => { e.splice(5, 0, structuredClone(e[3]!)); },
    "delta after part done": e => { e.splice(6, 0, structuredClone(e[3]!)); },
    "duplicate part done": e => { e.splice(6, 0, structuredClone(e[5]!)); },
    "part done before text done": e => { e.splice(4, 1); },
    "missing part done": e => { e.splice(5, 1); },
    "item done before part done": e => { [e[5], e[6]] = [e[6]!, e[5]!]; },
    "event after item done": e => { e.splice(7, 0, structuredClone(e[3]!)); },
    "event after terminal": e => { e.push(structuredClone(e[3]!)); },
    "interrupted part": e => { e[5]!["status"] = "incomplete"; },
    "null part status": e => { e[5]!["status"] = null; },
    "unsupported complete part status": e => { e[5]!["status"] = "completed"; },
    "status on added": e => { e[2]!["status"] = "incomplete"; },
    "unknown event field": e => { e[2]!["unknown"] = null; },
    "content index on summary": e => { e[2]!["content_index"] = 0; },
    "logprobs on summary": e => { e[3]!["logprobs"] = []; },
    "unknown part field": e => { (e[2]!["part"] as Item)["unknown"] = null; },
    "opaque part field": e => { (e[5]!["part"] as Item)["encrypted_content"] = null; },
    "wrong part type": e => { (e[2]!["part"] as Item)["type"] = "reasoning_text"; },
    "null part": e => { e[2]!["part"] = null; },
    "null text": e => { (e[2]!["part"] as Item)["text"] = null; },
    "missing delta": e => { delete e[3]!["delta"]; },
    "non string text done": e => { e[4]!["text"] = []; },
    "readable added part": e => { (e[2]!["part"] as Item)["text"] = "fabricated-readable-private"; },
    "delta and text done mismatch": e => { e[3]!["delta"] = "fabricated-readable-private"; },
    "text done and delta mismatch": e => { e[4]!["text"] = "fabricated-readable-private"; },
    "part done and text done mismatch": e => { (e[5]!["part"] as Item)["text"] = "fabricated-readable-private"; },
    "final missing summary": e => { (e[6]!["item"] as Item)["summary"] = []; },
    "final extra summary": e => { ((e[6]!["item"] as Item)["summary"] as Item[]).push(empty()); },
    "final summary and streamed part mismatch": e => { ((e[6]!["item"] as Item)["summary"] as Item[])[0]!["text"] = "fabricated-readable-private"; },
    "terminal summary mismatch": e => { (((e.at(-1)!["response"] as Item)["output"] as Item[])[0] as Item)["summary"] = []; },
    "null encryption": e => { (e[6]!["item"] as Item)["encrypted_content"] = null; },
    "reasoning content remains forbidden": e => { (e[6]!["item"] as Item)["content"] = []; },
    "raw reasoning text event": e => { e[3] = { type: "response.reasoning_text.delta", output_index: 0, item_id: "r", content_index: 0, delta: "" }; },
    "unknown reasoning event": e => { e[3]!["type"] = "response.reasoning_summary_text.other"; },
    "missing terminal": e => { e.pop(); },
    "missing item done": e => { e.splice(6, 1); },
    "incomplete terminal": e => { const t = e.at(-1)!;t["type"] = "response.incomplete";(t["response"] as Item)["status"] = "incomplete"; },
    "duplicate sequence": e => { e[3]!["sequence_number"] = 2; },
  };
  for (const [label, mutate] of Object.entries(mutations)) test(`${name}: atomically refuses ${label}`, async () => {
    const input = events(); mutate(input); const result = await run(input); assert(result.error);
    assert(!JSON.stringify([result.error, result.logs]).includes("fabricated-readable-private"));
  });
  test(`${name}: display and non replay boundaries remain closed`, async () => {
    for (const encrypted of [true, false]) for (const options of [{ omitted: false }, { noReplay: true }])
      assert((await run(events(1, [], encrypted), options)).error);
  });
  test(`${name}: EOF failure, cancellation and malformed tail prevent publication`, async () => {
    for (const options of [{ abortAtEof: true }, { errorAtEof: true }, { tail: "data: {\n\n" }])
      for (const encrypted of [true, false]) for (const input of [events(1, [], encrypted), events(1, ["private summary"], encrypted)])
        assert((await run(input, options)).error);
  });
  test(`${name}: absent encryption preserves exact completed private state only after clean EOF`, async () => {
    for (const texts of [[], ["private e\u0301 🦊\u0000"]]) {
      const input = events(texts.length, texts, false), result = await run(input);
      assert.equal(result.error, undefined); assert.equal(result.completions, 1); assert.equal(result.publications, 1);
      assert.deepEqual(result.raw, (input.at(-1)!["response"] as Item)["output"]);
      assert(!Object.hasOwn(result.raw![0]!, "encrypted_content"));
      assert.equal(result.raw![2]!["arguments"], ' { "n":-0,"s":"🦊" } ');
      assert(!JSON.stringify([result.frames, result.assistant, result.logs]).includes("private"));
      assert.deepEqual(result.logs, []);
      assert((await run(input.slice(0, -1))).error, "premature EOF cannot publish");
    }
  });
  test(`${name}: accumulated readable summary uses the existing pending allowance and releases on refusal`, async () => {
    for (const encrypted of [true, false]) {
      assert.equal((await run(events(1, ["short private summary"], encrypted), { pendingLimit: 32768 })).error, undefined);
      const result = await run(events(1, ["x".repeat(8192)], encrypted), { pendingLimit: 32768 });
      assert.match(String(result.error), /provider_state_too_large/);
    }
  });
  test(`${name}: oversized summary scalar keeps existing frame and pending limits`, async () => {
    const input = events(); input[3]!["delta"] = "x".repeat(4 * 1024 * 1024 + 1);
    assert.match(String((await run(input)).error), /sse_event_too_large|provider_state_too_large/);
  });
}

for (const encrypted of [true, false]) for (const texts of [[], ["private e\u0301 🦊\u0000", "second private summary"]])
test(`selected route retains ${texts.length ? "readable" : "empty"} summary and ${encrypted ? "encrypted" : "absent-encryption"} output through owned tool continuation`, async () => {
  const input = events(2, texts, encrypted), raw = (input.at(-1)!["response"] as Item)["output"] as Item[];
  const f = fixture({ reply: () => response(wire(input), 7) });
  try {
    const body: Item = { ...ordered(), thinking: { type: "adaptive", display: "omitted" } };
    const first = await f.run(body); assert.equal(first.error, undefined);
    const aggregated = aggregateFrames(first.seen.map(e => wire([e])), "codex");
    assert(aggregated.ok && aggregated.value.kind === "message");
    const next = { ...body, messages: [...body["messages"] as Item[], { role: "assistant", content: aggregated.value.message.content },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "caller", content: "caller-owned result" }] }] };
    assert.equal((await f.run(next)).error, undefined);
    assert.deepEqual(f.sent[1]!.body["input"], [...f.sent[0]!.body["input"] as Item[], ...raw,
      { type: "function_call_output", call_id: "caller", output: "caller-owned result" }]);
    assert.deepEqual(f.sent[1]!.body["tools"], f.sent[0]!.body["tools"]);
    assert.equal(Object.hasOwn((f.sent[1]!.body["input"] as Item[])[(f.sent[0]!.body["input"] as Item[]).length]!, "encrypted_content"), encrypted);
    assert(!JSON.stringify([first.seen, aggregated, f.logs]).includes("private"));
    assert.equal(f.cache.size, 2); assert.equal(f.stats().commits, 2);
  } finally { f.router.close(); }
});

for (const encrypted of [true, false]) for (const mutation of ["generation", "agent", "cache", "action", "history", "owner"] as const)
test(`${encrypted ? "encrypted" : "absent-encryption"} private summary remains unavailable to a changed ${mutation}`, async () => {
  let changedOwner = false;
  const f = fixture({ reply: () => response(wire(events(1, ["private summary"], encrypted))),
    beforePrepare(request) { if (changedOwner) request.profile = { ...request.profile, account: "foreign-owner" }; } });
  try {
    const body: Item = { ...ordered(), thinking: { type: "adaptive", display: "omitted" } };
    const first = await f.run(body); assert.equal(first.error, undefined);
    const aggregated = aggregateFrames(first.seen.map(e => wire([e])), "codex");
    assert(aggregated.ok && aggregated.value.kind === "message");
    const next: Item = { ...body, messages: [...body["messages"] as Item[], { role: "assistant", content: aggregated.value.message.content },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "caller", content: "caller-owned result" }] }] };
    if (mutation === "generation") f.auth.generation = "generation2";
    if (mutation === "cache") Object.defineProperty(f.attempts, "replay", { value: new ClaudeCache() });
    if (mutation === "history") (next["messages"] as Item[])[0] = { role: "user", content: "changed prefix" };
    if (mutation === "owner") changedOwner = true;
    const context = mutation === "agent" ? { ...f.context!, agentId: "a".repeat(64) } : mutation === "action"
      ? f.router.actions.context(f.router.actions.create("claude-code", "synthetic-thread").id, "claude-code") : f.context;
    let error: unknown;
    try {
      for await (const _event of f.router.events(next, "claude-code", "work", f.controller.signal,
        context)) { assert.fail("foreign continuation published"); }
    } catch (caught) { error = caught; }
    assert.match(String(error), /credential_owner_changed|continuity_unavailable/);
    assert.equal(f.sent.length, 1); assert.equal(f.stats().commits, 1);
  } finally { f.router.close(); }
});

test("selected route refusal creates no cache writes, commits, visible frames or fallback", async () => {
  const input = events(); input[3]!["delta"] = "fabricated-readable-private";
  const f = fixture({ reply: () => response(wire(input)), fallback: true });
  try {
    const result = await f.run({ ...ordered(), thinking: { type: "adaptive", display: "omitted" } });
    assert(result.error); assert.deepEqual(result.seen, []); assert.equal(f.stats().commits, 0);
    assert.equal(f.effects().cacheWriteCalls, 0); assert.equal(f.cache.size, 0); assert.equal(f.sent.length, 1);
    assert(!JSON.stringify(f.logs).includes("fabricated-readable-private"));
  } finally { f.router.close(); }
});
