/** Socketless native-shaped Read replay with fabricated auth, SSE and cache hints. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregateFrames } from "../../src/codex-response.js";
import { ClaudeCache } from "../../src/claude-cache.js";
import { RoutingError, type Item } from "../../src/routing/routing-types.js";
import { fixture, response, wire } from "../helpers/kimi-ordered-route.js";
import { added, created, done, terminal, textItem } from "../helpers/kimi-responses-bridge.js";

const hint = () => ({ type: "ephemeral", ttl: "5m" });
const rawArgs = ' { "file_path" : "/fabricated/fixture", "nested" : { "cache_control" : "caller-data", "n" : -0, "text" : "שלום 🦊" } } ';
function seed(stream: boolean): Item & { messages: Item[] } {
  return { model: "work", stream, max_tokens: 1024, thinking: { type: "adaptive", display: "omitted" },
    system: [{ type: "text", text: "Use caller tools.", cache_control: hint() }],
    tools: [{ name: "Read", description: "Caller Read", input_schema: { type: "object", required: ["file_path"],
      properties: { file_path: { type: "string" }, nested: { type: "object", cache_control: { const: "schema-data" } } } }, cache_control: hint() }],
    messages: [{ role: "user", content: [{ type: "text", text: "Read the fixture.", cache_control: hint() }] }] };
}
function readOutput(): Item[] {
  const reasoning = { type: "reasoning", id: "private-reasoning", status: "completed", summary: [] };
  const call = { type: "function_call", id: "private-item", call_id: "caller-read", name: "Read", arguments: rawArgs, status: "completed" };
  return [created(), added(0, { ...reasoning, status: "in_progress" }), done(0, reasoning),
    added(1, { ...call, arguments: "", status: "in_progress" }), done(1, call), terminal([reasoning, call])];
}
function finalOutput(): Item[] {
  const text = textItem("final", ["fabricated final"]);
  return [created(), added(0, { ...text, content: [], status: "in_progress" }), done(0, text), terminal([text])];
}
function continuation(first: Item & { messages: Item[] }, events: Item[]) {
  const aggregate = aggregateFrames(events.map(e => wire([e])), "codex");
  assert(aggregate.ok && aggregate.value.kind === "message");
  const next = structuredClone(first);
  next.messages.push({ role: "assistant", content: aggregate.value.message.content },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "caller-read", content: "fabricated file text", is_error: false }] });
  return next;
}
function block(body: Item & { messages: Item[] }, index: number) { return (body.messages[index]!["content"] as Item[])[0]!; }
function moveNativeMarkers(body: Item & { messages: Item[] }) {
  delete block(body, 0)["cache_control"];
  block(body, 1)["cache_control"] = hint();
  block(body, 2)["cache_control"] = hint();
}
function expectCode(error: unknown, code: string) {
  assert(error instanceof RoutingError); assert.equal(error.code, code);
}

for (const stream of [true, false]) test(`native Read cache markers can move without changing exact replay streaming${stream}`, async () => {
  const raw = readOutput(), f = fixture({ reply: i => response(wire(i === 1 ? raw : finalOutput()), 7) });
  try {
    const first = seed(stream), original = structuredClone(first), one = await f.run(first);
    assert.equal(one.error, undefined);
    const next = continuation(first, one.seen); moveNativeMarkers(next);
    const unchanged = structuredClone(next), two = await f.run(next);
    assert.equal(two.error, undefined); assert.deepEqual(first, original); assert.deepEqual(next, unchanged);
    const output = (raw.at(-1)!["response"] as Item)["output"] as Item[];
    assert.deepEqual(f.sent[1]!.body["input"], [...f.sent[0]!.body["input"] as Item[], ...output,
      { type: "function_call_output", call_id: "caller-read", output: "fabricated file text" }]);
    assert.equal((f.sent[1]!.body["input"] as Item[]).find(v => v["type"] === "function_call")!["arguments"], rawArgs);
    assert.deepEqual((f.sent[1]!.body["tools"] as Item[])[0]!["parameters"], (first["tools"] as Item[])[0]!["input_schema"]);
    assert(!JSON.stringify(two.seen).includes("private-reasoning"));
    assert.equal(f.stats().commits, 2); assert.equal(f.sent.length, 2);
    // The subsequent request can move markers again without rewriting earlier content.
    const three = structuredClone(next), final = aggregateFrames(two.seen.map(e => wire([e])), "codex");
    assert(final.ok && final.value.kind === "message");
    delete block(three, 1)["cache_control"]; delete block(three, 2)["cache_control"];
    three.messages.push({ role: "assistant", content: final.value.message.content }, { role: "user", content: "next" });
    assert.equal((await f.run(three)).error, undefined); assert.equal(f.stats().commits, 3);
  } finally { f.router.close(); }
});

for (const site of ["request", "system", "tool", "earlier-block", "assistant-block"] as const)
  test(`validated advisory hint identity is independent of ${site} placement`, async () => {
    const f = fixture({ reply: i => response(wire(i === 1 ? readOutput() : finalOutput())) });
    try {
      const first = seed(true), one = await f.run(first); assert.equal(one.error, undefined);
      const next = continuation(first, one.seen);
      if (site === "request") next["cache_control"] = null;
      if (site === "system") delete (next["system"] as Item[])[0]!["cache_control"];
      if (site === "tool") (next["tools"] as Item[])[0]!["cache_control"] = { type: "ephemeral", ttl: "1h" };
      if (site === "earlier-block") delete block(next, 0)["cache_control"];
      if (site === "assistant-block") block(next, 1)["cache_control"] = hint();
      assert.equal((await f.run(next)).error, undefined); assert.equal(f.sent.length, 2);
    } finally { f.router.close(); }
  });

for (const mutation of ["earlier-text", "tool-input", "schema-data", "tool-name", "call-id", "result-id", "metadata", "max-tokens",
  "thinking", "owner", "agent", "cache", "expired", "invalid-hint"] as const)
  test(`moving native markers does not admit changed ${mutation}`, async () => {
    const f = fixture({ reply: () => response(wire(readOutput())) });
    try {
      const first = seed(true), one = await f.run(first); assert.equal(one.error, undefined);
      const next = continuation(first, one.seen); moveNativeMarkers(next);
      let context = f.context;
      if (mutation === "earlier-text") block(next, 0)["text"] = "altered";
      if (mutation === "tool-input") ((block(next, 1)["input"] as Item)["nested"] as Item)["cache_control"] = "altered";
      if (mutation === "schema-data") (((next["tools"] as Item[])[0]!["input_schema"] as Item)["properties"] as Item)["nested"] = { type: "object", cache_control: "altered" };
      if (mutation === "tool-name") block(next, 1)["name"] = "Other";
      if (mutation === "call-id") { block(next, 1)["id"] = "other"; block(next, 2)["tool_use_id"] = "other"; }
      if (mutation === "result-id") block(next, 2)["tool_use_id"] = "other";
      if (mutation === "metadata") next["metadata"] = { user_id: "changed" };
      if (mutation === "max-tokens") next["max_tokens"] = 2048;
      if (mutation === "thinking") next["thinking"] = { type: "enabled", budget_tokens: 1024, display: "omitted" };
      if (mutation === "owner") f.auth.generation = "changed";
      if (mutation === "agent") context = { ...context!, agentId: "b".repeat(64) };
      if (mutation === "cache") Object.defineProperty(f.attempts, "replay", { value: new ClaudeCache() });
      if (mutation === "expired") f.router.actions.complete(context!.actionId);
      if (mutation === "invalid-hint") block(next, 1)["cache_control"] = { type: "ephemeral", ttl: "forever" };
      const seen: Item[] = []; let error: unknown;
      try { for await (const e of f.router.events(next, "claude-code", "work", f.controller.signal, context)) seen.push(e); } catch (caught) { error = caught; }
      expectCode(error, mutation === "invalid-hint" ? "kimi_ordered_request_unsupported_block_cache_control" :
        mutation === "result-id" ? "unsupported_routed_content" :
        mutation === "owner" ? "credential_owner_changed" : mutation === "expired" ? "action_state_lost" : "continuity_unavailable");
      assert.deepEqual(seen, []); assert.equal(f.sent.length, 1); assert.equal(f.stats().commits, 1);
    } finally { f.router.close(); }
  });

for (const partial of ["missing-terminal", "late-event"] as const) test(`partial ${partial} response cannot publish a cache-hint replay association`, async () => {
  const raw = readOutput(); if (partial === "missing-terminal") raw.pop(); else raw.push(created());
  const f = fixture({ reply: () => response(wire(raw), 3) });
  try {
    const result = await f.run(seed(true)); assert(result.error instanceof RoutingError);
    assert.deepEqual(result.seen, []); assert.equal(f.cache.size, 0); assert.equal(f.stats().commits, 0);
  } finally { f.router.close(); }
});
