/** Socketless fabricated publication/lookup comparisons. No native/auth/provider I/O. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregateFrames } from "../../src/codex-response.js";
import { ClaudeCache, type KimiOrderedAssociation } from "../../src/claude-cache.js";
import { orderedCanonical } from "../../src/routing/kimi-ordered-replay.js";
import { OrderedReplayDiagnostics, StagedCache, type OrderedReplayDiagnostic, type OrderedReplayPrefixDiagnostic } from "../../src/routing/replay-cache.js";
import { RoutingError, type Item } from "../../src/routing/routing-types.js";
import { fixture, ordered, response, wire } from "../helpers/kimi-ordered-route.js";
import { added, created, done, terminal, textItem } from "../helpers/kimi-responses-bridge.js";

const privateText = 'FABRICATED_PRIVATE_🦊_\\_\"controls\":{},\"messages\":[{]}';
const rawArgs = JSON.stringify({ file_path: privateText, nested: { cache_control: "tool data", n: -0 } });
function reply(first: boolean): Response {
  const text = textItem("message", [privateText]);
  const call = { type: "function_call", id: "item", call_id: "read-call", name: "Read", arguments: rawArgs, status: "completed" };
  return response(wire([created(), added(0, { ...text, content: [], status: "in_progress" }), done(0, text),
    ...(first ? [added(1, { ...call, arguments: "", status: "in_progress" }), done(1, call)] : []), terminal(first ? [text, call] : [text])]), 7);
}
function closed(fact: Readonly<OrderedReplayPrefixDiagnostic>): void {
  assert(Object.isFrozen(fact));
  assert.deepEqual(Object.keys(fact).sort(), ["event", "reference", "sameAssistant", "sameControls", "sameEarlierMessages"]);
  assert.equal(fact.event, "prefix_components");
  assert(["last_staged", "unavailable"].includes(fact.reference));
  for (const key of ["sameControls", "sameEarlierMessages", "sameAssistant"] as const)
    assert(fact[key] === null || typeof fact[key] === "boolean");
  assert(!JSON.stringify(fact).includes(privateText));
  assert(!JSON.stringify(fact).includes("read-call"));
}
const cases = [
  ["match", [true, true, true]],
  ["controls", [false, true, true]],
  ["earlier-history", [true, false, true]],
  ["assistant-input", [true, true, false]],
  ["assistant-shape", [true, true, false]],
  ["multiple", [false, false, false]],
] as const;
for (const [scenario, expected] of cases) test(`prefix components distinguish ${scenario} without changing the real route`, async () => {
  const outcomes: unknown[] = [];
  for (const enabled of [false, true]) {
    const ordinary: Readonly<OrderedReplayDiagnostic>[] = [], details: Readonly<OrderedReplayPrefixDiagnostic>[] = [];
    const diagnostics = new OrderedReplayDiagnostics(fact => ordinary.push(fact), enabled ? fact => details.push(fact) : undefined);
    const f = fixture({ diagnostics, reply: index => reply(index === 1) });
    try {
      const first = ordered();
      first["tools"] = [{ name: "Read", input_schema: { type: "object", description: privateText } }];
      const one = await f.run(first); assert.equal(one.error, undefined);
      const aggregate = aggregateFrames(one.seen.map(e => wire([e])), "codex");
      assert(aggregate.ok && aggregate.value.kind === "message");
      const assistant: Item = { role: "assistant", content: aggregate.value.message.content };
      const next: Item & { messages: Item[] } = { ...structuredClone(first), messages: [...structuredClone(first["messages"] as Item[]), assistant,
        { role: "user", content: [{ type: "tool_result", tool_use_id: "read-call", content: "fabricated successful Read" }] }] };
      if (scenario === "controls" || scenario === "multiple") next["max_tokens"] = 256;
      if (scenario === "earlier-history" || scenario === "multiple") next.messages[0]!["content"] = "changed earlier text";
      if (scenario === "assistant-input" || scenario === "multiple")
        ((assistant["content"] as Item[])[1]!["input"] as Item)["file_path"] = "changed tool input";
      if (scenario === "assistant-shape") (assistant["content"] as Item[])[0]!["citations"] = null;
      const two = await f.run(next);
      if (scenario === "match") assert.equal(two.error, undefined);
      else {
        assert(two.error instanceof RoutingError); assert.equal(two.error.code, "continuity_unavailable");
        assert.equal(two.error.status, 409); assert.deepEqual(two.seen, []);
      }
      assert.equal(f.sent.length, scenario === "match" ? 2 : 1);
      const lookup = ordinary.find(fact => fact.event === "lookup"); assert(lookup);
      assert.equal(lookup.samePrefix, scenario === "match");
      assert.equal(lookup.sameScope, true); assert.equal(lookup.sameStore, true); assert.equal(lookup.committed, true);
      if (enabled) {
        assert.equal(details.length, 1); const detail = details[0]!; closed(detail);
        assert.deepEqual([detail.sameControls, detail.sameEarlierMessages, detail.sameAssistant], expected);
        assert.equal(detail.reference, "last_staged");
      } else assert.deepEqual(details, []);
      outcomes.push({ ordinary, sent: f.sent, stats: f.stats(), effects: f.effects(), bytes: f.cache.byteSize,
        size: f.cache.size, frameTypes: two.seen.map(e => e["type"]) });
    } finally { f.router.close(); }
  }
  assert.deepEqual(outcomes[0], outcomes[1]);
});

const prefix = (controls: Item = {}, messages: Item[] = [{ role: "user", content: privateText },
  { role: "assistant", content: [{ type: "tool_use", id: "read-call", name: "Read", input: { file_path: privateText } }] }]) =>
  orderedCanonical({ controls, messages });
function compare(prior: string | undefined, current: string): Readonly<OrderedReplayPrefixDiagnostic> {
  const events: Readonly<OrderedReplayPrefixDiagnostic>[] = [];
  const diagnostics = new OrderedReplayDiagnostics(() => {}, fact => events.push(fact)), shared = new ClaudeCache();
  const stage = new StagedCache(shared, diagnostics);
  try {
    if (prior !== undefined) stage.put("kimiOrdered", "key", { version: 1, scopeCanonical: "scope", prefixCanonical: prior,
      upstreamInputCanonical: "[]", rawOutputCanonical: "[]" });
    diagnostics.lookup(shared, "scope", current, false);
    assert.equal(events.length, 1); closed(events[0]!); return events[0]!;
  } finally { stage.dispose(); }
}
test("borrowed canonical ranges handle escaped delimiters, nested data, unicode and changed message count", () => {
  const canonical = prefix({ tools: [{ input_schema: { properties: { messages: { enum: [privateText] } } } }] });
  assert.deepEqual(compare(canonical, canonical), { event: "prefix_components", reference: "last_staged",
    sameControls: true, sameEarlierMessages: true, sameAssistant: true });
  const changed = prefix({}, [{ role: "user", content: privateText }, { role: "system", content: "extra earlier message" },
    { role: "assistant", content: [{ type: "tool_use", id: "read-call", name: "Read", input: { file_path: privateText } }] }]);
  const detail = compare(prefix(), changed);
  assert.equal(detail.sameControls, true); assert.equal(detail.sameEarlierMessages, false); assert.equal(detail.sameAssistant, true);
});
for (const malformed of ["missing", "framing", "unclosed", "depth"] as const)
  test(`unavailable ${malformed} comparison returns unknown, never copied text`, () => {
    const invalid = malformed === "missing" ? undefined : malformed === "framing" ? privateText :
      malformed === "unclosed" ? '{"controls":{},"messages":[{"role":"assistant"}' :
      prefix({ nested: Array.from({ length: 130 }).reduce<Item>(value => ({ child: value }), {}) });
    const detail = compare(invalid, prefix());
    assert.deepEqual([detail.sameControls, detail.sameEarlierMessages, detail.sameAssistant], [null, null, null]);
    assert.equal(detail.reference, malformed === "missing" ? "unavailable" : "last_staged");
  });

test("unavailable oversized comparison returns unknown before scanning or copying history", () => {
  const events: Readonly<OrderedReplayPrefixDiagnostic>[] = [], shared = new ClaudeCache();
  const stage = new StagedCache(shared), diagnostics = new OrderedReplayDiagnostics(() => {}, fact => events.push(fact));
  const record: KimiOrderedAssociation = { version: 1, scopeCanonical: "scope", prefixCanonical: "x".repeat(32 * 1024 * 1024 + 1),
    upstreamInputCanonical: "[]", rawOutputCanonical: "[]" };
  try {
    // Directly supply the fabricated diagnostic reference; do not bypass a real cache budget.
    diagnostics.staged(stage, shared, record); diagnostics.lookup(shared, "scope", prefix(), false);
    assert.equal(events.length, 1); closed(events[0]!);
    assert.deepEqual([events[0]!.sameControls, events[0]!.sameEarlierMessages, events[0]!.sameAssistant], [null, null, null]);
    assert.equal(shared.size, 0);
  } finally { stage.dispose(); }
});

for (const hostile of ["callback", "callback-getter", "record-getter"] as const)
  test(`hostile prefix ${hostile} cannot replace the cache result or execute an association getter`, () => {
    let reads = 0;
    const diagnostics = new OrderedReplayDiagnostics(() => {}, () => { throw Error(privateText); });
    if (hostile === "callback-getter") Object.defineProperty(diagnostics, "observePrefix", { get() { throw Error(privateText); } });
    const value: KimiOrderedAssociation = { version: 1, scopeCanonical: "scope", prefixCanonical: prefix(), upstreamInputCanonical: "[]", rawOutputCanonical: "[]" };
    if (hostile === "record-getter") Object.defineProperty(value, "prefixCanonical", { get() { reads++; return privateText; } });
    const shared = new ClaudeCache(), stage = new StagedCache(shared, diagnostics);
    try {
      stage.put("kimiOrdered", "key", value); const record = stage.get("kimiOrdered", "key"), before = reads;
      stage.observeOrderedLookup("scope", prefix(), record);
      assert.equal(reads, before); assert.equal(record, value); assert.equal(shared.size, 0);
    } finally { stage.dispose(); }
  });
