/** Production route/cache/bridge/delivery with fabricated credentials and SSE only. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregateFrames } from "../../src/codex-response.js";
import { ClaudeCache, type KimiOrderedAssociation } from "../../src/claude-cache.js";
import { StagedCache } from "../../src/routing/replay-cache.js";
import { KimiExecPending } from "../../src/routing/kimi-exec-pending.js";
import { orderedCanonical, orderedJsonBytes } from "../../src/routing/kimi-ordered-replay.js";
import { RoutingError, type Item } from "../../src/routing/routing-types.js";
import { fixture, ordered, output, response, wire } from "../helpers/kimi-ordered-route.js";
import { added, created, done, terminal, textItem } from "../helpers/kimi-responses-bridge.js";

const code = (error: unknown, expected: string) => { assert(error instanceof RoutingError); assert.equal(error.code, expected); };
const source = (): Item => ({ ...ordered(), thinking: { type: "adaptive", display: "omitted" } });
function assistant(seen: Item[]): Item {
  const result = aggregateFrames(seen.map(e => wire([e])), "codex");
  assert(result.ok && result.value.kind === "message");
  return { role: "assistant", content: result.value.message.content };
}
function reasoningOutput(text = "visible", tools = false): Item[] {
  const r = { type: "reasoning", id: "reasoning-private-id", status: "completed", summary: [], encrypted_content: "fabricated-private-encrypted" };
  const visible = tools ? output().slice(1, -1) : [added(0, { ...textItem("msg", []), status: "in_progress" }), done(0, textItem("msg", [text]))];
  const final = tools ? (output().at(-1)!["response"] as Item)["output"] as Item[] : [textItem("msg", [text])];
  return [created(), added(0, { ...r, status: "in_progress", encrypted_content: null }), done(0, r),
    ...visible.map(e => ({ ...e, output_index: Number(e["output_index"]) + 1 })), terminal([r, ...final])].map(e => structuredClone(e));
}

test("canonical identity preserves UTF16 order, Unicode, -0, missing/null and rejects executable JSON", () => {
  const value = { z: -0, "\ue000": "é", "🦊": "e\u0301", a: null };
  assert.equal(orderedCanonical(value), '{"a":null,"z":-0,"🦊":"é","":"é"}');
  assert.notEqual(orderedCanonical({}), orderedCanonical({ a: null }));
  assert.notEqual(orderedCanonical(-0), orderedCanonical(0));
  assert.equal(orderedCanonical({ b: 1, a: ["x", "y"] }), orderedCanonical({ a: ["x", "y"], b: 1 }));
  for (const text of ['"\\\n\u0000', "🦊", "\ud800", "é", "e\u0301"]) assert.equal(orderedJsonBytes(text), Buffer.byteLength(JSON.stringify(text)));
  let invoked = 0;
  for (const invalid of [{ get a() { invoked++; return 1; } }, { toJSON() { invoked++; return {}; } }, [undefined], NaN, new Date(), { [Symbol()]: 1 }])
    assert.throws(() => orderedCanonical(invalid));
  assert.equal(invoked, 0);
});

for (const state of ["missing", "foreign", "expired", "forged"] as const) test(`selected ${state} action refuses before auth/admission`, async () => {
  const f = fixture({ action: state !== "missing" });
  try {
    let context = f.context;
    if (state === "foreign") context = { ...context!, actionId: "foreign-action" };
    if (state === "expired") f.router.actions.complete(context!.actionId);
    if (state === "forged") context = { ...context!, conversationId: "another-conversation" };
    const seen: Item[] = []; let error: unknown;
    try { for await (const e of f.router.events(source(), "claude-code", "work", f.controller.signal, context)) seen.push(e); }
    catch (caught) { error = caught; }
    code(error, state === "missing" ? "action_identity_required" : "action_state_lost");
    assert.deepEqual(seen, []); assert.equal(f.auth.gets, 0); assert.equal(f.effects().physicalAdmissions, 0); assert.equal(f.stats().reserves, 0);
  } finally { f.router.close(); }
});

for (const tools of [false, true]) for (const streaming of [false, true]) test(`exact three-turn owned replay tools${tools} streaming${streaming}`, async () => {
  const first = reasoningOutput("first", tools), later = reasoningOutput("later");
  if (tools) {
    // Raw spelling is intentionally different from the public parsed tool JSON.
    for (const e of first) {
      const item = e["type"] === "response.output_item.done" ? e["item"] as Item : undefined;
      if (item?.["type"] === "function_call") item["arguments"] = ' { "n" : 7 } ';
    }
    (((first.at(-1)!["response"] as Item)["output"] as Item[]).at(-1) as Item)["arguments"] = ' { "n" : 7 } ';
  }
  const f = fixture({ reply: i => response(wire(i === 1 ? first : later), 7) });
  try {
    const one: Item = { ...source(), stream: streaming }, r1 = await f.run(one); assert.equal(r1.error, undefined);
    const a1 = assistant(r1.seen), suffix: Item[] = [{ role: "system", content: "new instruction" }, { role: "user", content: tools ?
      [{ type: "text", text: "before" }, { type: "tool_result", tool_use_id: "caller-id", content: "caller result" }, { type: "text", text: "after" }] : "next" }];
    const two = { ...one, messages: [...one.messages as Item[], a1, ...suffix] }, r2 = await f.run(two); assert.equal(r2.error, undefined);
    const raw1 = (first.at(-1)!["response"] as Item)["output"] as Item[];
    const expectedSuffix = tools ? [
      { type: "message", role: "system", content: [{ type: "input_text", text: "new instruction" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "before" }] },
      { type: "function_call_output", call_id: "caller-id", output: "caller result" },
      { type: "message", role: "user", content: [{ type: "input_text", text: "after" }] },
    ] : [{ type: "message", role: "system", content: [{ type: "input_text", text: "new instruction" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "next" }] }];
    assert.deepEqual(f.sent[1]!.body["input"], [...f.sent[0]!.body["input"] as Item[], ...raw1, ...expectedSuffix]);
    const three = { ...two, messages: [...two.messages, assistant(r2.seen), { role: "user", content: "third" }] };
    const r3 = await f.run(three); assert.equal(r3.error, undefined);
    assert.deepEqual(f.sent[2]!.body["input"], [...f.sent[1]!.body["input"] as Item[], ...(later.at(-1)!["response"] as Item)["output"] as Item[],
      { type: "message", role: "user", content: [{ type: "input_text", text: "third" }] }]);
    assert.deepEqual(f.sent[0]!.body["include"], ["reasoning.encrypted_content"]); assert.equal(f.sent[0]!.body["store"], false);
    assert.equal(f.cache.size, 3); assert.equal(f.stats().commits, 3);
    assert(!JSON.stringify([r1.seen, r2.seen, r3.seen]).includes("fabricated-private-encrypted"));
    assert(!JSON.stringify(r1.seen).includes("reasoning-private-id"));
  } finally { f.router.close(); }
});

for (const mutation of ["control", "block", "earlier", "assistant", "loss", "generation", "action", "agent"] as const)
  test(`owned prefix ${mutation} fails before another physical attempt`, async () => {
    const f = fixture({ reply: () => response(wire(reasoningOutput())) });
    try {
      const seed = source(), first = await f.run(seed); assert.equal(first.error, undefined);
      const body: Item & { messages: Item[] } = { ...seed, messages: [...seed["messages"] as Item[], assistant(first.seen), { role: "user", content: "next" }] };
      let context = f.context;
      if (mutation === "control") body["metadata"] = { user_id: "new" };
      if (mutation === "block") body.messages[3]!["content"] = "changed visible text";
      if (mutation === "earlier") body.messages[0]!["content"] = "changed";
      if (mutation === "assistant") body.messages.splice(4, 0, { role: "assistant", content: [{ type: "text", text: "unmatched" }] });
      if (mutation === "loss") Object.defineProperty(f.attempts, "replay", { value: new ClaudeCache() });
      if (mutation === "generation") f.auth.generation = "generation2";
      if (mutation === "action") context = f.router.actions.context(f.router.actions.create("claude-code", "synthetic-thread").id, "claude-code");
      if (mutation === "agent") context = { ...context!, agentId: "b".repeat(64) };
      const seen: Item[] = []; let error: unknown;
      try { for await (const e of f.router.events(body, "claude-code", "work", f.controller.signal, context)) seen.push(e); } catch (caught) { error = caught; }
      code(error, mutation === "generation" ? "credential_owner_changed" : "continuity_unavailable");
      assert.deepEqual(seen, []); assert.equal(f.effects().physicalAdmissions, 1); assert.equal(f.stats().commits, 1);
    } finally { f.router.close(); }
  });

test("simultaneous identical scoped seeds are insert-only; distinct actions remain isolated", async () => {
  const f = fixture({ reply: () => response(wire(reasoningOutput())) });
  try {
    const results = await Promise.all([f.run(source()), f.run(source())]);
    assert.equal(results.filter(r => !r.error).length, 1);
    code(results.find(r => r.error)!.error, "continuity_unavailable");
    assert.equal(f.cache.size, 1); assert.equal(f.stats().commits, 1);
    const second = f.router.actions.context(f.router.actions.create("claude-code", "synthetic-thread").id, "claude-code");
    const seen: Item[] = [];
    for await (const e of f.router.events(source(), "claude-code", "work", f.controller.signal, second)) seen.push(e);
    assert(seen.length); assert.equal(f.cache.size, 2);
  } finally { f.router.close(); }
});

for (const privateOnly of [false, true]) test(`seed branches compare complete public prefix privateOnly${privateOnly}`, async () => {
  const f = fixture({ reply: i => {
    const events = reasoningOutput(privateOnly ? "same" : `branch${i}`);
    for (const e of events) {
      const item = e["type"] === "response.output_item.done" ? e["item"] as Item : undefined;
      if (item?.["type"] === "reasoning") item["encrypted_content"] = `fabricated-${i}`;
    }
    (((events.at(-1)!["response"] as Item)["output"] as Item[])[0]!)["encrypted_content"] = `fabricated-${i}`;
    return response(wire(events));
  } });
  try {
    assert.equal((await f.run(source())).error, undefined);
    const second = await f.run(source());
    if (privateOnly) { code(second.error, "continuity_unavailable"); assert.deepEqual(second.seen, []); }
    else assert.equal(second.error, undefined);
    assert.equal(f.stats().commits, privateOnly ? 1 : 2); assert.equal(f.cache.size, privateOnly ? 1 : 2);
  } finally { f.router.close(); }
});

for (const provisional of [undefined, null, "", "fabricated-provisional"]) test(`provisional encryption ${String(provisional)} and sequence gaps are supported`, async () => {
  const events = reasoningOutput();
  if (provisional === undefined) delete (events[1]!["item"] as Item)["encrypted_content"];
  else (events[1]!["item"] as Item)["encrypted_content"] = provisional;
  events.forEach((e, i) => { e["sequence_number"] = 10 + i * 3; });
  const f = fixture({ reply: () => response(wire(events)) });
  try { const r = await f.run(source()); assert.equal(r.error, undefined); assert.equal(f.stats().commits, 1); }
  finally { f.router.close(); }
});

const malformed: Record<string, (events: Item[]) => void> = {
  "missing sequence": e => { e[1]!["sequence_number"] = undefined; },
  "duplicate sequence": e => { e[1]!["sequence_number"] = 0; },
  "negative sequence": e => { e[1]!["sequence_number"] = -1; },
  "unsafe sequence": e => { e[1]!["sequence_number"] = Number.MAX_SAFE_INTEGER + 1; },
  "readable summary": e => { (e[1]!["item"] as Item)["summary"] = [{ type: "summary_text", text: "private" }]; },
  "content even empty": e => { (e[1]!["item"] as Item)["content"] = []; },
  "unknown field": e => { (e[1]!["item"] as Item)["unknown"] = null; },
  "added status": e => { (e[1]!["item"] as Item)["status"] = "completed"; },
  "done status": e => { (e[2]!["item"] as Item)["status"] = "in_progress"; },
  "missing encryption": e => { delete (e[2]!["item"] as Item)["encrypted_content"]; },
  "empty encryption": e => { (e[2]!["item"] as Item)["encrypted_content"] = ""; },
  "null encryption": e => { (e[2]!["item"] as Item)["encrypted_content"] = null; },
  "missing done": e => { e.splice(2, 1); },
  "duplicate done": e => { e.splice(3, 0, structuredClone(e[2]!)); },
  "terminal encryption": e => { (((e.at(-1)!["response"] as Item)["output"] as Item[])[0]!)["encrypted_content"] = "different"; },
  "terminal order": e => { ((e.at(-1)!["response"] as Item)["output"] as Item[]).reverse(); },
  "top-level encrypted null": e => { (e[0]!["response"] as Item)["encrypted_content"] = null; },
  "incomplete": e => { e[e.length - 1] = terminal((e.at(-1)!["response"] as Item)["output"] as Item[], "max_output_tokens"); },
  "truncated": e => { e.pop(); },
  "late": e => { e.push(created()); },
  "readable event": e => { e.splice(2, 0, { type: "response.reasoning_text.delta", item_id: "reasoning-private-id", output_index: 0, content_index: 0, delta: "private" }); },
};
for (const [name, mutate] of Object.entries(malformed)) test(`closed versioned lifecycle rejects ${name} atomically`, async () => {
  const events = structuredClone(reasoningOutput()); mutate(events);
  const f = fixture({ reply: () => response(wire(events), 3) });
  try {
    const r = await f.run(source()); assert(r.error instanceof RoutingError);
    assert.deepEqual(r.seen, []); assert.equal(f.cache.size, 0); assert.equal(f.stats().commits, 0); assert.equal(f.stats().successes, 0);
  } finally { f.router.close(); }
});

test("reasoning requires explicit omitted display; terminal cannot supply missing visible done", async () => {
  for (const display of [false, true]) {
    const events = reasoningOutput(); if (display) events.splice(4, 1);
    const f = fixture({ reply: () => response(wire(events)) });
    try { const r = await f.run(display ? source() : ordered()); assert(r.error instanceof RoutingError); assert.deepEqual(r.seen, []); assert.equal(f.cache.size, 0); }
    finally { f.router.close(); }
  }
});

test("shared and pending budget failures publish no frames or success", async () => {
  for (const smallShared of [true, false]) {
    let ledger: KimiExecPending | undefined;
    const f = fixture({ ...(smallShared ? { cache: new ClaudeCache({ maxEntries: 1, maxBytes: 100 }, true) } : {}),
      reply: () => response(wire(reasoningOutput("x".repeat(2000)))),
      prepared(ready) { ledger = ready.atomicPending; if (!smallShared) Object.defineProperty(ledger!, "limit", { value: ledger!.byteSize + 500 }); } });
    try {
      const r = await f.run(source()); code(r.error, smallShared ? "continuation_store_full" : "provider_state_too_large");
      assert.deepEqual(r.seen, []); assert.equal(f.cache.size, 0); assert.equal(f.stats().commits, 0); assert.equal(f.stats().successes, 0);
      assert.equal(ledger!.byteSize, 0, "all attempt-local leases release on refusal");
    } finally { f.router.close(); }
  }
});

test("canonical strings share one allowance and duplicate batches are atomic", () => {
  const pending = new KimiExecPending(), leases: { release(): void }[] = [];
  Object.defineProperty(pending, "limit", { value: 400 });
  assert.throws(() => orderedCanonical({ prefix: "x".repeat(100) }, pending, leases), /provider_state_too_large/);
  assert.equal(pending.byteSize, 0);
  const chunks = new KimiExecPending();
  Object.defineProperty(chunks, "limit", { value: 600 });
  assert.throws(() => orderedCanonical(Array(64).fill(0), chunks, []), /provider_state_too_large/);
  assert.equal(chunks.byteSize, 0, "token quotes/separators and joined string share the allowance");
  const value: KimiOrderedAssociation = Object.freeze({ version: 1, scopeCanonical: "{}", prefixCanonical: "{}", upstreamInputCanonical: "[]", rawOutputCanonical: "[]" });
  const shared = new ClaudeCache(), stage = new StagedCache(shared);
  assert.throws(() => stage.putBatch([{ kind: "kimiOrdered", id: "same", value }, { kind: "kimiOrdered", id: "same", value }]), /continuity_unavailable/);
  assert.equal(stage.size, 0); assert.equal(shared.size, 0);
  stage.put("kimiOrdered", "same", value); stage.commit();
  assert.throws(() => shared.put("kimiOrdered", "same", value), /continuity_unavailable/);
  assert.equal(shared.size, 1);
});
