/** Real SharedRouting/attempt/delivery, fabricated auth and in-memory transport only. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderKimiResponsesRequest } from "../../src/routing/kimi-responses-request.js";
import { aggregateFrames } from "../../src/codex-response.js";
import { ClaudeCache } from "../../src/claude-cache.js";
import { ownerKey } from "../../src/routing/continuation-store.js";
import { kimiNativeTokenFilename } from "../../src/kimi-native-auth.js";
import { RoutingError, type AccessProfile, type Item } from "../../src/routing/routing-types.js";
import { added, created, terminal, textItem } from "../helpers/kimi-responses-bridge.js";

import { profile, target, ordered, ordinary, output, nativeMessages, wire, response, fixture } from "../helpers/kimi-ordered-route.js";

function code(error: unknown, expected: string) { assert(error instanceof RoutingError, String(error)); assert.equal(error.code, expected); }

for (const stream of [true, false]) for (const citations of [null, []]) test(`actual ordered empty citations preserve complete request stream${stream} citations${JSON.stringify(citations)}`, async () => {
  const f = fixture(), baseline = fixture();
  try {
    const body: Item = { ...ordered(), stream, thinking: { type: "adaptive", display: "omitted" } };
    const messages = body["messages"] as Item[];
    messages.push({ role: "system", content: [{ type: "text", text: "later" }] },
      { role: "user", content: [{ type: "text", text: "after" }] });
    const control = structuredClone(body);
    body["system"] = [{ type: "text", text: "initial", citations: structuredClone(citations) }];
    for (const m of messages) if (Array.isArray(m["content"])) for (const block of m["content"] as Item[]) {
      if (block["type"] === "text") block["citations"] = structuredClone(citations);
    }
    const before = structuredClone(body), r = await f.run(body), base = await baseline.run(control);
    assert.equal(r.error, undefined); assert.equal(base.error, undefined); assert.deepEqual(body, before);
    assert.deepEqual(f.sent, baseline.sent); assert.deepEqual(r.seen, base.seen);
    assert.deepEqual(f.stats(), { eof: true, commits: 1, successes: 1, reserves: 1, releases: 1 });
  } finally { f.router.close(); baseline.router.close(); }
});

const privateOutput = "fabricated-private-output\nhttps://synthetic.invalid/?token=fabricated";
const opaqueEnvelopeFields = ["signature", "encrypted_content", "thinking", "redacted_thinking", "reasoning_content", "reasoning_text"] as const;
function envelopeOutput(stage: "created" | "in_progress" | "completed" | "incomplete"): Item[] {
  // Each event owns its envelope/items: final-only changes cannot mutate earlier frames.
  const events = output().map(event => structuredClone(event));
  if (stage === "in_progress") events.splice(events.length - 1, 0, { type: "response.in_progress", response: structuredClone(events[0]!["response"]) });
  if (stage === "incomplete") {
    // Incomplete tool output is independently forbidden; use a valid text-only control.
    events.splice(3, 2);
    events[events.length - 1] = terminal([textItem("msg", ["שלום 🦊", "separate"])], "max_output_tokens");
  }
  return events;
}
for (const stream of [true, false]) for (const stage of ["created", "in_progress", "completed", "incomplete"] as const) {
  for (const key of opaqueEnvelopeFields) test(`KDB-1 envelope ${stage} ${key} stream${stream} refuses atomically`, async () => {
    const events = envelopeOutput(stage);
    const envelope = events.find(event => event["type"] === `response.${stage}`)!["response"] as Item;
    envelope[key] = privateOutput;
    const f = fixture({ fallback: true, reply: () => response(wire(events), 3) });
    try {
      const body: Item = { ...ordered(), stream, thinking: { type: "adaptive", display: "omitted" } };
      const before = structuredClone(body), affinity = structuredClone(f.router.actions.affinity(f.context!, "work"));
      const r = await f.run(body);
      assert(r.error instanceof RoutingError, JSON.stringify({ frames: r.seen.length, effects: f.effects(), stats: f.stats() }));
      code(r.error, "kimi_ordered_response_opaque_output"); assert.equal(r.error.status, 502);
      assert.deepEqual(f.logs.filter(([, event]) => event === "kimi_ordered_response_refused"), [["warn", "kimi_ordered_response_refused", {
        errorCode: "kimi_ordered_response_opaque_output", eventType: `${stage}_envelope_${key}`, status: null,
      }]]);
      assert.deepEqual(r.seen, []); assert.deepEqual(body, before); assert.equal(f.sent.length, 1);
      assert.deepEqual(f.effects(), { physicalAdmissions: 1, cacheWriteCalls: 0 });
      assert.equal(f.stats().commits, 0); assert.equal(f.stats().successes, 0); assert.equal(f.stats().releases, 1);
      assert.equal(f.cache.size, 0); assert.deepEqual(f.router.actions.affinity(f.context!, "work"), affinity);
      assert(!JSON.stringify([f.logs, r.seen, String(r.error)]).includes("fabricated-private-output"));
      assert(!JSON.stringify([f.logs, r.seen, String(r.error)]).includes("synthetic.invalid"));
    } finally { f.router.close(); }
  });
}
for (const stream of [true, false]) for (const stage of ["created", "in_progress", "completed", "incomplete"] as const) test(`KDB-1 benign envelope ${stage} metadata stream${stream} remains accepted`, async () => {
  const events = envelopeOutput(stage), control = envelopeOutput(stage);
  const envelope = events.find(event => event["type"] === `response.${stage}`)!["response"] as Item;
  Object.assign(envelope, { reasoning: { effort: "high", summary: "auto" }, metadata: { signature: "caller metadata", encrypted_content: "metadata value" },
    service_tier: "default", created_at: 1000 });
  if (stage === "completed" || stage === "incomplete") (envelope["usage"] as Item)["output_tokens_details"] = { reasoning_tokens: 7 };
  const f = fixture({ reply: () => response(wire(events), 3) }), baseline = fixture({ reply: () => response(wire(control), 3) });
  try {
    const body: Item = { ...ordered(), stream, thinking: { type: "adaptive", display: "omitted" } };
    const r = await f.run(body), base = await baseline.run(body);
    if (stage === "incomplete") {
      code(r.error, "kimi_ordered_response_invalid_terminal"); code(base.error, "kimi_ordered_response_invalid_terminal");
      assert.deepEqual(r.seen, []); assert.equal(f.stats().commits, 0);
    } else {
      assert.equal(r.error, undefined); assert.equal(base.error, undefined); assert.deepEqual(r.seen, base.seen);
      assert.deepEqual(f.sent, baseline.sent); assert.equal(f.stats().commits, 1); assert.equal(f.stats().successes, 1);
    }
  } finally { f.router.close(); baseline.router.close(); }
});
for (const stream of [true, false]) for (const key of ["signature", "encrypted_content"] as const) for (const value of [null, "", false, 0, [], {}]) test(`KDB-1 empty-looking envelope ${key} ${JSON.stringify(value)} stream${stream} is still refused`, async () => {
  const events = envelopeOutput("completed"); (events.at(-1)!["response"] as Item)[key] = value;
  const f = fixture({ fallback: true, reply: () => response(wire(events), 1) });
  try {
    const r = await f.run({ ...ordered(), stream, thinking: { type: "enabled", budget_tokens: 1024, display: "omitted" } });
    assert(r.error instanceof RoutingError); assert.deepEqual(r.seen, []); assert.equal(f.sent.length, 1);
    code(r.error, "kimi_ordered_response_opaque_output"); assert.equal(r.error.status, 502);
    assert.equal(f.effects().cacheWriteCalls, 0); assert.equal(f.stats().commits, 0); assert.equal(f.stats().successes, 0); assert.equal(f.stats().releases, 1);
  } finally { f.router.close(); }
});
for (const stage of ["created", "in_progress"] as const) test(`KDB-1 late ${stage} envelope after terminal cannot publish earlier output`, async () => {
  const events = envelopeOutput("completed");
  events.push({ type: `response.${stage}`, response: { ...(created()["response"] as Item), encrypted_content: privateOutput } });
  const f = fixture({ reply: () => response(wire(events), 3) });
  try {
    const r = await f.run({ ...ordered(), thinking: { type: "adaptive", display: "omitted" } });
    assert(r.error instanceof RoutingError); assert.deepEqual(r.seen, []); assert.equal(f.effects().cacheWriteCalls, 0);
    assert.equal(f.stats().commits, 0); assert.equal(f.stats().successes, 0);
  } finally { f.router.close(); }
});
test("KDB-1 same-name output tool JSON remains caller data on ordered and ordinary Responses routes", async () => {
  const events = output().map(event => structuredClone(event));
  const input = Object.fromEntries(opaqueEnvelopeFields.map(key => [key, { literal: key, private: "caller-owned" }]));
  for (const event of events) {
    const item = event["type"] === "response.output_item.done" ? event["item"] as Item : event["type"] === "response.completed" ? ((event["response"] as Item)["output"] as Item[])[1] : undefined;
    if (item?.["type"] === "function_call") item["arguments"] = JSON.stringify(input);
  }
  for (const client of ["claude-code", "codex"] as const) {
    const f = fixture({ reply: () => response(wire(events), 3) });
    try {
      const body: Item = client === "claude-code" ? { ...ordered(), thinking: { type: "adaptive", display: "omitted" } } : { model: "work", input: [{ role: "user", content: "hello" }] };
      const r = await f.run(body, client); assert.equal(r.error, undefined);
      if (client === "claude-code") {
        const aggregate = aggregateFrames(r.seen.map(e => wire([e])), "codex"); assert(aggregate.ok && aggregate.value.kind === "message");
        const tool = (aggregate.value.message.content as Item[]).find(b => b["type"] === "tool_use");
        assert(tool?.["type"] === "tool_use"); assert.deepEqual(tool["input"], input);
      } else assert.deepEqual(JSON.parse((((r.seen.at(-1)!["response"] as Item)["output"] as Item[])[1]!["arguments"] as string)), input);
      assert.equal(f.sent.length, 1); assert.equal(f.stats().commits, 1); assert.equal(f.stats().successes, 1);
    } finally { f.router.close(); }
  }
});
test("KDB-1 envelope guard stays out of ordinary direct Responses", async () => {
  const events = output().map(event => structuredClone(event));
  for (const event of [events[0]!, events.at(-1)!]) Object.assign(event["response"] as Item, { signature: "native-owned", encrypted_content: "native-owned" });
  const f = fixture({ reply: () => response(wire(events), 3) });
  try {
    const r = await f.run({ model: "work", input: [{ role: "user", content: "hello" }] }, "codex");
    assert.equal(r.error, undefined); assert.equal((r.seen[0]!["response"] as Item)["signature"], "native-owned");
    assert.equal((r.seen.at(-1)!["response"] as Item)["encrypted_content"], "native-owned");
    assert.equal(f.stats().commits, 1); assert.equal(f.stats().successes, 1);
  } finally { f.router.close(); }
});
const opaqueOutputCases: Record<string, (events: Item[]) => Item[]> = {
  lateReasoningEvent: e => [...e.slice(0, -1), { type: "response.reasoning_summary_text.delta", item_id: "msg", output_index: 0, content_index: 0, delta: privateOutput }, e.at(-1)!],
  lateReasoningItem: e => [...e.slice(0, -1), added(2, { type: "reasoning", id: "opaque", status: "in_progress", encrypted_content: privateOutput }), e.at(-1)!],
  finalReasoningItem: e => { ((e.at(-1)!["response"] as Item)["output"] as Item[]).push({ type: "reasoning", id: "opaque", summary: [{ type: "summary_text", text: privateOutput }] }); return e; },
  lateSignatureEvent: e => [...e.slice(0, -1), { type: "response.signature.delta", item_id: "msg", output_index: 0, content_index: 0, delta: privateOutput }, e.at(-1)!],
  finalMessageSignature: e => { (((e.at(-1)!["response"] as Item)["output"] as Item[])[0]!)["signature"] = privateOutput; return e; },
  finalToolSignature: e => { (((e.at(-1)!["response"] as Item)["output"] as Item[])[1]!)["signature"] = privateOutput; return e; },
  finalTextSignature: e => { ((((e.at(-1)!["response"] as Item)["output"] as Item[])[0]!["content"] as Item[])[0]!)["signature"] = privateOutput; return e; },
  finalMixedReasoningPart: e => { ((((e.at(-1)!["response"] as Item)["output"] as Item[])[0]!["content"] as Item[])).push({ type: "reasoning_text", text: privateOutput }); return e; },
  lateRedactedItem: e => [...e.slice(0, -1), added(2, { type: "redacted_thinking", id: "opaque", status: "in_progress", data: privateOutput }), e.at(-1)!],
};
for (const stream of [true, false]) for (const [name, transform] of Object.entries(opaqueOutputCases)) test(`actual omitted display refuses whole late/mixed ${name} stream${stream}`, async () => {
  // Clone each event independently so terminal-only mutations follow valid text/tool frames.
  const raw = wire(transform(output().map(event => structuredClone(event))));
  const f = fixture({ fallback: true, reply: () => response(raw, 7) });
  try {
    const body: Item = { ...ordered(), stream, thinking: { type: "enabled", budget_tokens: 1024, display: "omitted" } };
    const before = structuredClone(body), affinity = structuredClone(f.router.actions.affinity(f.context!, "work"));
    const r = await f.run(body);
    assert(r.error instanceof RoutingError); assert.deepEqual(r.seen, []); assert.deepEqual(body, before);
    assert.equal(f.sent.length, 1, "no fallback after opaque output");
    assert.deepEqual(f.effects(), { physicalAdmissions: 1, cacheWriteCalls: 0 });
    assert.equal(f.stats().commits, 0); assert.equal(f.stats().successes, 0); assert.equal(f.stats().releases, 1);
    assert.equal(f.cache.size, 0); assert.deepEqual(f.router.actions.affinity(f.context!, "work"), affinity);
    assert(!JSON.stringify([r.seen, f.logs, String(r.error)]).includes("fabricated-private-output"));
    assert(!JSON.stringify([r.seen, f.logs, String(r.error)]).includes("synthetic.invalid"));
  } finally { f.router.close(); }
});

for (const [name, block, expected] of [
  ["citation data", { type: "text", text: privateOutput, citations: [{ cited_text: privateOutput }] }, "unsupported_text_block_citations"],
  ["text cache", { type: "text", text: privateOutput, cache_control: { type: "ephemeral", private: privateOutput } }, "unsupported_block_cache_control"],
  ["tool caller", { type: "tool_use", id: "caller", name: "inspect", input: {}, caller: { type: "direct", private: privateOutput } }, "unsupported_tool_use_caller"],
  ["lookalike unknown", { type: "text", text: privateOutput, ["cache_control\n" + privateOutput]: privateOutput }, "unsupported_block_field"],
] as const) test(`actual ordered closed ${name} diagnostic preserves local refusal and confidentiality`, async () => {
  const f = fixture({ fallback: true });
  try {
    const body: Item = { ...ordered(), thinking: { type: "adaptive", display: "omitted" } };
    (body["messages"] as Item[]).push({ role: block.type === "tool_use" ? "assistant" : "user", content: [structuredClone(block)] });
    if (block.type === "tool_use") (body["messages"] as Item[]).push({ role: "user", content: [{ type: "tool_result", tool_use_id: "caller", content: "owned result" }] });
    const before = structuredClone(body), r = await f.run(body);
    code(r.error, `kimi_ordered_request_${expected}`); assert.equal((r.error as RoutingError).status, 422);
    assert.deepEqual(body, before); assert.deepEqual(r.seen, []); assert.deepEqual(f.sent, []);
    assert.deepEqual(f.effects(), { physicalAdmissions: 0, cacheWriteCalls: 0 });
    assert.deepEqual(f.stats(), { eof: false, commits: 0, successes: 0, reserves: 1, releases: 1 });
    assert.equal(f.auth.gets, 1); assert.equal(f.auth.refreshCount, 0);
    assert(!JSON.stringify([f.logs, String(r.error)]).includes("fabricated-private-output"));
    assert(!JSON.stringify([f.logs, String(r.error)]).includes("synthetic.invalid"));
  } finally { f.router.close(); }
});

for (const streaming of [true, false]) test(`actual ordered route preserves request and multipart/final-only tools streaming${streaming}`, async () => {
  let owner = "";
  const f = fixture({ prepared(r) { assert.equal(r.atomicMessages, true); owner = r.owner; } });
  try {
    const body = { ...ordered(), stream: streaming }, before = structuredClone(body), r = await f.run(body);
    assert.equal(r.error, undefined); assert.deepEqual(body, before); assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0]!.url, "https://api.kimi.ai/coding/v1/responses");
    const sent = f.sent[0]!.body, input = sent["input"] as Item[];
    assert.deepEqual(input.map(e => e["role"]), ["system", "user", "system", "user"]);
    assert.deepEqual(input[2]!["content"], [{ type: "input_text", text: "later1" }, { type: "input_text", text: "later2" }]);
    assert.deepEqual(sent["tools"], [{ type: "function", name: "inspect", description: "Caller tool", parameters: { type: "object" }, strict: false }]);
    assert.equal(sent["max_output_tokens"], 128); assert.deepEqual(sent["reasoning"], { effort: "high" }); assert.equal(sent["store"], false);
    assert.equal(owner, ownerKey(profile, target, "responses", "generation1", "kimi-ordered-messages-v4"));
    assert.notEqual(owner, ownerKey(profile, target, "responses", "generation1"));
    assert.deepEqual(f.stats(), { eof: true, commits: 1, successes: 1, reserves: 1, releases: 1 });
    assert(f.timeline.indexOf("eof") < f.timeline.indexOf("cache-commit")); assert(f.timeline.indexOf("quota-success") < f.timeline.indexOf("frame"));
    assert.equal(f.cache.size, 1, "complete selected output publishes one owned association");
    const aggregate = aggregateFrames(r.seen.map(e => wire([e])), "codex"); assert(aggregate.ok && aggregate.value.kind === "message");
    assert.deepEqual(aggregate.value.message.content, [{ type: "text", text: "שלום 🦊" }, { type: "text", text: "separate" },
      { type: "tool_use", id: "caller-id", name: "inspect", input: { n: 7 } }]);
  } finally { f.router.close(); }
});

test("imported assistant/tool history cannot migrate into selected replay", async () => {
  const f = fixture();
  try {
    const body = ordered();
    (body["messages"] as Item[]).push({ role: "assistant", content: [{ type: "tool_use", id: "old-call", name: "inspect", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "old-call", content: "result" }] });
    const r = await f.run(body); code(r.error, "continuity_unavailable");
    assert.deepEqual(r.seen, []); assert.equal(f.effects().physicalAdmissions, 0); assert.equal(f.cache.size, 0);
  } finally { f.router.close(); }
});

test("ordinary Messages stays native and keeps legacy owner", async () => {
  let selected = ""; const f = fixture({ action: false, reply: () => response(wire(nativeMessages())), prepared(r) { assert.equal(r.atomicMessages, undefined); selected = r.owner; } });
  try { const r = await f.run(ordinary()); assert.equal(r.error, undefined); assert.equal(f.sent[0]!.url, "https://api.kimi.ai/coding/v1/messages?beta=true");
    assert.deepEqual(f.sent[0]!.body["system"], [{ type: "text", text: "leading" }]);
    assert.equal(selected, ownerKey(profile, target, "messages", "generation1"));
  } finally { f.router.close(); }
});

test("direct Responses stays native with original continuation ownership", async () => {
  const f = fixture({ prepared(r) { assert.equal(r.atomicMessages, undefined); assert.equal(r.owner, ownerKey(profile, target, "responses", "generation1")); } });
  try { const r = await f.run({ model: "work", input: [{ role: "user", content: "hello" }] }, "codex"); assert.equal(r.error, undefined);
    const last = r.seen.at(-1)!["response"] as Item;
    assert.equal(f.router.continuations.get(String(last["id"]), undefined, "work", "responses").owner, ownerKey(profile, target, "responses", "generation1"));
  } finally { f.router.close(); }
});

const unsupported: Record<string, (b: Item) => void> = {
  metadata: b => { b["metadata"] = { private: "must-not-drop" }; },
  cache: b => { b["cache_control"] = { type: "ephemeral", evict_on_complete: true }; },
  temperature: b => { b["temperature"] = 0; },
  customTool: b => { b["tools"] = [{ type: "custom", name: "exec" }]; },
  hostedTool: b => { b["tools"] = [{ type: "web_search_20250305", name: "web_search" }]; },
  textMetadata: b => { ((b["messages"] as Item[])[1]!["content"] as Item[])[0]!["cache_control"] = {}; },
  opaque: b => { (b["messages"] as Item[]).push({ role: "assistant", content: [{ type: "thinking", thinking: "private", signature: "foreign" }] }); },
  image: b => { (b["messages"] as Item[]).push({ role: "user", content: [{ type: "image", source: {} }] }); },
  pendingCall: b => { (b["messages"] as Item[]).push({ role: "assistant", content: [{ type: "tool_use", id: "unresolved", name: "inspect", input: {} }] }); },
  duplicateCall: b => { (b["messages"] as Item[]).push({ role: "assistant", content: [1, 2].map(() => ({ type: "tool_use", id: "same", name: "inspect", input: {} })) }); },
  errorResult: b => { (b["messages"] as Item[]).push({ role: "assistant", content: [{ type: "tool_use", id: "one", name: "inspect", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "one", content: "failure", is_error: true }] }); },
};
for (const [name, change] of Object.entries(unsupported)) test(`actual unsupported ${name} refuses before fetch and publication`, async () => {
  const f = fixture({ fallback: true });
  try { const body = ordered(); change(body); const r = await f.run(body);
    assert(r.error instanceof RoutingError); assert.deepEqual(r.seen, []); assert.deepEqual(f.sent, []); assert.equal(f.stats().successes, 0); assert.equal(f.cache.size, 0);
  } finally { f.router.close(); }
});

for (const [name, transform] of Object.entries({
  duplicateTerminal: (e: Item[]) => wire([...e, e.at(-1)!]),
  lateToolMutation: (e: Item[]) => wire([...e, { type: "response.function_call_arguments.delta", item_id: "provider-item", output_index: 1, delta: "mutation" }]),
  spoofedComment: (e: Item[]) => wire(e) + 'event: __subswitch_comment\ndata: {"type":"error","error":{"message":"private"}}\n\n',
  noTerminal: (e: Item[]) => wire(e.slice(0, -1)),
  malformedJson: (e: Item[]) => wire(e) + 'data: {bad\n\n',
  errorEvent: (e: Item[]) => wire([...e.slice(0, -1), { type: "error", error: { message: "sensitive" } }]),
  finalConflict: (e: Item[]) => { const t = structuredClone(e), final = t.at(-1)!["response"] as Item, out = final["output"] as Item[];
    final["output"] = [out[0], { ...out[1], arguments: '{"n":8}' }]; return wire(t); },
  opaqueOutput: (e: Item[]) => wire([e[0]!, added(0, { type: "reasoning", id: "r", encrypted_content: "private" })]),
  wrongModel: (e: Item[]) => wire(e).replaceAll('"kimi-for-coding"', '"different-model"'),
})) test(`actual strict ${name} publishes no frames/cache/quota success`, async () => {
  const f = fixture({ reply: () => response(transform(output()), 1) });
  try { const r = await f.run(); assert(r.error); assert.deepEqual(r.seen, []); assert.equal(f.sent.length, 1);
    assert.equal(f.stats().commits, 0); assert.equal(f.stats().successes, 0); assert.equal(f.stats().releases, 1); assert.equal(f.cache.size, 0);
    assert(!String(r.error).includes("sensitive"));
  } finally { f.router.close(); }
});

test("genuine no-data keepalive after terminal stays accepted", async () => {
  const f = fixture({ reply: () => response(wire(output()) + ': keepalive\n\n', 1) });
  try { assert.equal((await f.run()).error, undefined); } finally { f.router.close(); }
});

for (const when of ["before-admission", "after-admission", "eof", "after-first-frame"] as const) test(`actual cancellation ${when} never completes caller tool`, async () => {
  const f = fixture({ beforePrepare: () => { if (when === "after-admission") f.controller.abort(); },
    reply: () => response(undefined, 1, () => { if (when === "eof") f.controller.abort(); }) });
  try { if (when === "before-admission") f.controller.abort();
    const r = await f.run({ ...ordered(), cache_control: { type: "ephemeral", ttl: "1h" } }, "claude-code", () => { if (when === "after-first-frame") f.controller.abort(); });
    assert(r.error); assert(!r.seen.some(e => ["message_stop", "content_block_stop"].includes(String(e["type"]))));
    if (when !== "after-first-frame") { assert.deepEqual(r.seen, []); assert.equal(f.stats().commits, 0); assert.equal(f.stats().successes, 0); }
    assert.equal(f.sent.length, when === "before-admission" || when === "after-admission" ? 0 : 1);
  } finally { f.router.close(); }
});

test("credential changes at clean EOF prevent atomic publication", async () => {
  const f = fixture({ reply: () => response(undefined, 1, () => { f.auth.generation = "generation2"; }) });
  try { const r = await f.run({ ...ordered(), cache_control: { type: "ephemeral" } }); code(r.error, "credential_owner_changed"); assert.deepEqual(r.seen, []); assert.equal(f.stats().successes, 0); }
  finally { f.router.close(); }
});

test("pinned codec owner rejects changed auth generation before another fetch", async () => {
  const f = fixture({ action: true });
  try { assert.equal((await f.run()).error, undefined); const affinity = f.router.actions.affinity(f.context!, "work"), before = structuredClone(affinity);
    f.auth.generation = "generation2"; const r = await f.run({ ...ordered(), cache_control: { type: "ephemeral" } }); code(r.error, "credential_owner_changed"); assert.deepEqual(r.seen, []); assert.equal(f.sent.length, 1);
    assert.equal(affinity.selectedOwner, before.selectedOwner); assert.equal(f.stats().successes, 1);
  } finally { f.router.close(); }
});

test("retained native Messages owner cannot silently adopt scoped ordered Responses", async () => {
  const f = fixture();
  try {
    // Retired runtime affinity is supplied explicitly: the new selector cannot create it.
    Object.assign(f.router.actions.affinity(f.context!, "work"), {
      selectedTarget: target, selectedOwner: ownerKey(profile, target, "messages", "generation1"),
    });
    const r = await f.run(); code(r.error, "credential_owner_changed"); assert.deepEqual(r.seen, []); assert.equal(f.sent.length, 0);
  } finally { f.router.close(); }
});

for (const rotate of [false, true]) test(`existing 401 refresh preserves lineage rotate${rotate}`, async () => {
  const f = fixture({ reply: index => index === 1 ? new Response("{}", { status: 401 }) : response() }); f.auth.rotateOnRefresh = rotate;
  try { const r = await f.run(); assert.equal(f.auth.refreshCount, 1); assert.equal(f.sent.length, rotate ? 1 : 2);
    if (rotate) { code(r.error, "credential_owner_changed"); assert.deepEqual(r.seen, []); assert.equal(f.stats().successes, 0); }
    else { assert.equal(r.error, undefined); assert.deepEqual(f.sent[0]!.body, f.sent[1]!.body); }
  } finally { f.router.close(); }
});

test("cache publication failure prevents all frames and healthy completion", async () => {
  class FullCache extends ClaudeCache { override putBatch(): void { throw Error("full"); } }
  const f = fixture({ cache: new FullCache() });
  try { const r = await f.run(); code(r.error, "continuation_store_full"); assert.deepEqual(r.seen, []); assert.equal(f.stats().successes, 0); }
  finally { f.router.close(); }
});

test("upstream failure remains unhealthy with no silent fallback", async () => {
  const f = fixture({ fallback: true, reply: () => new Response('{"error":{"message":"private"}}', { status: 500 }) });
  try { const r = await f.run(); assert(r.error); assert.deepEqual(r.seen, []); assert.equal(f.sent.length, 1); assert.equal(f.stats().successes, 0); }
  finally { f.router.close(); }
});

test("other credential/product scope keeps its late-system refusal", async () => {
  const f = fixture({ profile: { ...profile, credential: { kind: "env", name: "FABRICATED_KEY" } } });
  try { const r = await f.run(); code(r.error, "unsupported_mid_conversation_system"); assert.deepEqual(f.sent, []); }
  finally { f.router.close(); }
});

test("native Kimi Code source selects the same codec without reading its fabricated slot", async () => {
  const p: AccessProfile = { ...profile, credential: { kind: "native-oauth",
    authFile: `/fabricated/credentials/${kimiNativeTokenFilename("global")}`, source: "kimi-code" } };
  const f = fixture({ profile: p, prepared(r) { assert.equal(r.atomicMessages, true); assert.equal(r.owner,
    ownerKey(p, target, "responses", "generation1", "kimi-ordered-messages-v4")); } });
  try { assert.equal((await f.run()).error, undefined); assert.equal(f.sent.length, 1); }
  finally { f.router.close(); }
});

for (const oldProtocol of ["messages", "responses"] as const) test(`opaque cache from ${oldProtocol} cannot cross codec identity`, async () => {
  let conversation = "";
  const f = fixture({ beforePrepare(r) { conversation = r.conversation; } });
  try {
    assert.equal((await f.run()).error, undefined);
    const thinking = { type: "thinking", thinking: "private", signature: "retained-signature" };
    f.cache.put("snapshot", `signature:${ownerKey(profile, target, oldProtocol, "generation1")}:${conversation}:retained-signature`,
      { request: {}, input: [thinking] });
    const before = f.cache.size, body: Item = { ...ordered(), cache_control: { type: "ephemeral" }, thinking: { type: "adaptive" },
      context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] } }; (body["messages"] as Item[]).push({ role: "assistant", content: [thinking] });
    const r = await f.run(body); code(r.error, "foreign_opaque_state"); assert.deepEqual(r.seen, []); assert.equal(f.sent.length, 1); assert.equal(f.cache.size, before);
  } finally { f.router.close(); }
});

test("approved caller-owned signature is still refused as unrepresentable Responses reasoning", async () => {
  let conversation = ""; const f = fixture({ beforePrepare(r) { conversation = r.conversation; } });
  try {
    assert.equal((await f.run()).error, undefined);
    const thinking = { type: "thinking", thinking: "private", signature: "same-codec-signature" };
    f.cache.put("snapshot", `signature:${ownerKey(profile, target, "responses", "generation1", "kimi-ordered-messages-v4")}:${conversation}:same-codec-signature`,
      { request: {}, input: [thinking] });
    const body: Item = { ...ordered(), cache_control: { type: "ephemeral" }, thinking: { type: "adaptive" },
      context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] } }; (body["messages"] as Item[]).push({ role: "assistant", content: [thinking] });
    const r = await f.run(body); code(r.error, "kimi_ordered_request_opaque_reasoning"); assert.deepEqual(r.seen, []); assert.equal(f.sent.length, 1); assert.equal(f.cache.size, 2);
  } finally { f.router.close(); }
});

// Visible pinned-builder variants, not claims about the discarded live request.
const callerFields = [
  ["metadata", { unknown_member: "private-user" }, "metadata_object"], ["temperature", 0.7, "temperature_number"],
  ["safeguards", [{ type: "private-policy" }], "safeguards_array"], ["speed", "private-speed", "speed_string"],
  ["thread", "private-thread", "thread_string"], ["diagnostics", { previous_message_id: "private-id" }, "diagnostics_object"],
  ["betas", ["private-beta"], "betas_array"], ["fallback_credit_token", "private-token", "fallback_credit_token_string"],
] as const;
for (const [field, value, suffix] of callerFields) test(`actual ordered caller ${field} refuses with fixed diagnostic`, async () => {
  const f = fixture({ fallback: true });
  try {
    const body = { ...ordered(), [field]: value }, before = structuredClone(body);
    const affinity = structuredClone(f.router.actions.affinity(f.context!, "work")), r = await f.run(body);
    code(r.error, `kimi_ordered_request_unsupported_request_field_${suffix}`);
    assert.equal((r.error as RoutingError).status, 422); assert.deepEqual(body, before);
    assert.deepEqual(r.seen, []); assert.deepEqual(f.sent, []); assert.equal(f.cache.size, 0);
    assert.deepEqual(f.stats(), { eof: false, commits: 0, successes: 0, reserves: 1, releases: 1 });
    assert.deepEqual(f.router.actions.affinity(f.context!, "work"), affinity);
  } finally { f.router.close(); }
});

for (const [extra, expected] of [
  [{ ["private-key\nhttps://private.invalid/?token=secret"]: "private-value" }, "unsupported_request_field"],
  [JSON.parse('{"__proto__":{"private":true}}'), "unsupported_request_field"],
  [{ output_config: { effort: "high", format: { type: "json_schema", schema: { private: true } } } }, "unsupported_output_config_field_format_object"],
  [{ output_config: { effort: "high", private_key: "private-value" } }, "unsupported_output_config_field"],
  [{ metadata: [] }, "unsupported_request_field_metadata_array"],
] as const) test(`actual ordered diagnostic stays bounded ${expected}`, async () => {
  const f = fixture({ fallback: true });
  try {
    const r = await f.run({ ...ordered(), ...extra }); code(r.error, `kimi_ordered_request_${expected}`);
    assert.deepEqual(r.seen, []); assert.deepEqual(f.sent, []); assert.equal(f.stats().successes, 0); assert.equal(f.cache.size, 0);
    assert(!String(r.error).includes("private"));
  } finally { f.router.close(); }
});

test("actual oversized ordered request retains pre-render 413 bound", async () => {
  const f = fixture({ fallback: true });
  try {
    const r = await f.run({ ...ordered(), metadata: "x".repeat(32 * 1024 * 1024) });
    code(r.error, "reconstructed_request_too_large"); assert.equal((r.error as RoutingError).status, 413);
    assert.deepEqual(r.seen, []); assert.deepEqual(f.sent, []); assert.equal(f.stats().successes, 0);
  } finally { f.router.close(); }
});

test("ordinary Messages keeps existing metadata behavior", async () => {
  const f = fixture({ action: false, reply: () => response(wire(nativeMessages())) });
  try {
    const metadata = { user_id: "synthetic" }, r = await f.run({ ...ordinary(), metadata });
    assert.equal(r.error, undefined); assert.equal(f.sent.length, 1); assert.deepEqual(f.sent[0]!.body["metadata"], metadata);
    assert.equal(f.sent[0]!.url, "https://api.kimi.ai/coding/v1/messages?beta=true");
  } finally { f.router.close(); }
});

for (const [name, metadata] of [
  ["empty", {}], ["empty identifier", { user_id: "" }],
  ["opaque identifier", { user_id: '{"session_id":"fabricated-attribution","device_id":"synthetic"}' }],
  ["512 ASCII", { user_id: "a".repeat(512) }], ["512 astral", { user_id: "🦊".repeat(512) }],
] as const) test(`actual ordered route omits validated attribution: ${name}`, async () => {
  const baseline = fixture(), owners: string[] = [], conversations: string[] = [];
  const f = fixture({ prepared(r) { owners.push(r.owner); }, beforePrepare(r) { conversations.push(r.conversation); } });
  try {
    const body = ordered();
    const without = structuredClone(body); body["metadata"] = metadata;
    const before = structuredClone(body), r = await f.run(body), control = await baseline.run(without);
    assert.equal(r.error, undefined); assert.equal(control.error, undefined); assert.deepEqual(body, before);
    assert.deepEqual(f.sent, baseline.sent, "all inference bytes/order/tools must equal the metadata-absent request");
    assert.equal(f.sent.length, 1); assert.equal(Object.hasOwn(f.sent[0]!.body, "metadata"), false);
    assert.deepEqual(owners, [ownerKey(profile, target, "responses", "generation1", "kimi-ordered-messages-v4")]);
    assert.equal(f.auth.gets, 1); assert.equal(f.auth.refreshCount, 0); assert.equal(f.auth.generation, "generation1");
    assert.equal(f.effects().physicalAdmissions, 1);
    assert.deepEqual(f.stats(), { eof: true, commits: 1, successes: 1, reserves: 1, releases: 1 });
    assert.equal(f.cache.size, 1);
    for (const fragment of ["fabricated-attribution", "session_id", "device_id"]) {
      assert(!JSON.stringify([f.sent, f.logs, owners, conversations]).includes(fragment));
    }
  } finally { f.router.close(); baseline.router.close(); }
});

for (const [name, metadata, suffix] of [
  ["null", null, "null"], ["array", [], "array"], ["string", "fabricated", "string"],
  ["number", 0, "number"], ["boolean", false, "boolean"],
  ["unknown member", { user_id: "fabricated-attribution", private_unknown: "synthetic" }, "object"],
  ["null identifier", { user_id: null }, "object"], ["array identifier", { user_id: [] }, "object"],
  ["object identifier", { user_id: {} }, "object"], ["numeric identifier", { user_id: 1 }, "object"],
  ["boolean identifier", { user_id: false }, "object"],
  ["513 ASCII", { user_id: "a".repeat(513) }, "object"], ["513 astral", { user_id: "🦊".repeat(513) }, "object"],
  ["prototype-like member", JSON.parse('{"__proto__":{"private_unknown":"synthetic"}}'), "object"],
] as const) test(`actual ordered invalid attribution ${name} releases reservation without dispatch`, async () => {
  const f = fixture({ fallback: true });
  try {
    const body = { ...ordered(), metadata }, before = structuredClone(body);
    const affinity = structuredClone(f.router.actions.affinity(f.context!, "work")), r = await f.run(body);
    code(r.error, `kimi_ordered_request_unsupported_request_field_metadata_${suffix}`);
    assert.equal((r.error as RoutingError).status, 422); assert.deepEqual(body, before);
    assert.deepEqual(r.seen, []); assert.deepEqual(f.sent, []); assert.equal(f.cache.size, 0);
    // Preserve existing auth/owner validation order. FakeAuth is fresh and cannot
    // read or refresh real credentials; production auth.get may do either.
    assert.equal(f.auth.gets, 1); assert.equal(f.auth.refreshCount, 0);
    assert.deepEqual(f.effects(), { physicalAdmissions: 0, cacheWriteCalls: 0 });
    assert.deepEqual(f.stats(), { eof: false, commits: 0, successes: 0, reserves: 1, releases: 1 });
    assert.deepEqual(f.router.actions.affinity(f.context!, "work"), affinity);
    assert(!JSON.stringify([f.logs, String(r.error)]).includes("fabricated-attribution"));
    assert(!JSON.stringify(f.logs).includes("private_unknown"));
  } finally { f.router.close(); }
});

test("valid attribution does not bypass the next unsupported field or change auth ordering", async () => {
  const f = fixture({ fallback: true });
  try {
    const body = { ...ordered(), metadata: { user_id: "fabricated-attribution" }, thinking: { type: "adaptive", display: "summarized" } };
    const before = structuredClone(body), r = await f.run(body);
    code(r.error, "kimi_ordered_request_unsupported_thinking_display");
    assert.deepEqual(body, before); assert.deepEqual(r.seen, []); assert.deepEqual(f.sent, []);
    assert.equal(f.auth.gets, 1); assert.equal(f.auth.refreshCount, 0); assert.equal(f.cache.size, 0);
    assert.deepEqual(f.effects(), { physicalAdmissions: 0, cacheWriteCalls: 0 });
    assert.deepEqual(f.stats(), { eof: false, commits: 0, successes: 0, reserves: 1, releases: 1 });
    assert(!JSON.stringify(f.logs).includes("fabricated-attribution"));
  } finally { f.router.close(); }
});

test("direct Responses metadata retains its existing behavior", async () => {
  const f = fixture();
  try {
    const metadata = { user_id: "fabricated-label" };
    const r = await f.run({ model: "work", input: [{ role: "user", content: "hello" }], metadata }, "codex");
    assert.equal(r.error, undefined); assert.equal(f.sent.length, 1);
    assert.deepEqual(f.sent[0]!.body["metadata"], metadata);
  } finally { f.router.close(); }
});

for (const effort of ["low", "high", "max"] as const) for (const [name, extra] of [
  ["absent", {}], ["adaptive", { thinking: { type: "adaptive" } }],
  ["adaptive omitted display", { thinking: { type: "adaptive", display: "omitted" } }],
  ["enabled omitted display with keep-all", { thinking: { type: "enabled", budget_tokens: 1024, display: "omitted" }, max_tokens: 256,
    context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] } }],
  ["minimum enabled", { thinking: { type: "enabled", budget_tokens: 1024 } }],
  ["cap-minus-one enabled", { thinking: { type: "enabled", budget_tokens: 4095 } }],
  ["equal-cap enabled", { thinking: { type: "enabled", budget_tokens: 4096 } }],
  ["above-cap enabled", { thinking: { type: "enabled", budget_tokens: 4097 } }],
  ["pinned builder clamp at256", { thinking: { type: "enabled", budget_tokens: Math.max(1024, Math.min(256 - 1, 4096)) }, max_tokens: 256 }],
  ["empty context config", { context_management: {} }],
  ["empty context edits", { context_management: { edits: [] } }],
  ["keep-all context and small-cap thinking", { context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
    thinking: { type: "enabled", budget_tokens: 1024 }, max_tokens: 256 }],
] as const) test(`actual ordered ${name} uses selected ${effort} effort without budget conversion`, async () => {
  const baseline = fixture({ effort }), owners: string[] = [];
  const f = fixture({ effort, prepared(r) { assert.equal(r.atomicMessages, true); owners.push(r.owner); } });
  try {
    const body: Item = { ...ordered(), max_tokens: 4096, metadata: { user_id: "fabricated-attribution" },
      output_config: { effort: effort === "max" ? "low" : "max" }, ...extra };
    const before = structuredClone(body), control = structuredClone(body);
    delete control["thinking"]; delete control["output_config"]; delete control["context_management"];
    const r = await f.run(body), base = await baseline.run(control);
    assert.equal(r.error, undefined); assert.equal(base.error, undefined); assert.deepEqual(body, before);
    assert.deepEqual(f.sent, baseline.sent, "complete history/tool order and output cap must equal the same route without caller thinking/effort");
    assert.equal(f.sent.length, 1); assert.equal(f.sent[0]!.url, "https://api.kimi.ai/coding/v1/responses");
    assert.deepEqual(f.sent[0]!.body["reasoning"], { effort });
    assert.equal(f.sent[0]!.body["max_output_tokens"], body["max_tokens"]);
    assert.equal(Object.hasOwn(f.sent[0]!.body, "thinking"), false);
    assert.equal(Object.hasOwn(f.sent[0]!.body, "context_management"), false);
    assert.deepEqual(owners, [ownerKey(profile, { ...target, effort }, "responses", "generation1", "kimi-ordered-messages-v4")]);
    assert.equal(f.auth.gets, 1); assert.equal(f.auth.refreshCount, 0);
    assert.equal(f.effects().physicalAdmissions, 1);
    assert.deepEqual(f.stats(), { eof: true, commits: 1, successes: 1, reserves: 1, releases: 1 });
    assert(!JSON.stringify(f.logs).includes("fabricated-attribution"));
  } finally { f.router.close(); baseline.router.close(); }
});

for (const [name, thinking, expected] of [
  ["null", null, "unsupported_request_field_thinking_null"], ["array", [], "unsupported_request_field_thinking_array"],
  ["string", "fabricated-private", "unsupported_request_field_thinking_string"],
  ["missing type", { budget_tokens: 1024 }, "unsupported_thinking_type"],
  ["disabled despite target effort", { type: "disabled" }, "unsupported_thinking_type"], ["off", { type: "off" }, "unsupported_thinking_type"],
  ["missing enabled budget", { type: "enabled" }, "invalid_thinking_budget"], ["below minimum", { type: "enabled", budget_tokens: 1023 }, "invalid_thinking_budget"],
  ["fractional budget", { type: "enabled", budget_tokens: 1024.5 }, "invalid_thinking_budget"],
  ["string budget", { type: "enabled", budget_tokens: "1024" }, "invalid_thinking_budget"],
  ["adaptive budget", { type: "adaptive", budget_tokens: 1024 }, "unsupported_thinking_field"],
  ["adaptive display", { type: "adaptive", display: "updates" }, "unsupported_thinking_display"],
  ["enabled display", { type: "enabled", budget_tokens: 1024, display: null }, "unsupported_thinking_display"],
  ["binding", { type: "enabled", budget_tokens: 1024, block_binding: { prefix_mismatch_behavior: "fabricated-private" } }, "unsupported_thinking_binding"],
  ["signature", { type: "adaptive", signature: "fabricated-private" }, "unsupported_thinking_binding"],
  ["unknown key", { type: "adaptive", ["fabricated-private\nhttps://synthetic.invalid/?token=fabricated"]: "private" }, "unsupported_thinking_field"],
] as const) test(`actual ordered thinking ${name} refuses without fallback, physical admission or charge`, async () => {
  const f = fixture({ fallback: true });
  try {
    const body = { ...ordered(), thinking, max_tokens: 4096, output_config: { effort: "max" } }, before = structuredClone(body);
    const affinity = structuredClone(f.router.actions.affinity(f.context!, "work")), r = await f.run(body);
    code(r.error, `kimi_ordered_request_${expected}`);
    assert.equal((r.error as RoutingError).status, 422); assert.deepEqual(body, before);
    assert.deepEqual(r.seen, []); assert.deepEqual(f.sent, []); assert.equal(f.cache.size, 0);
    // These counts belong to FakeAuth; production reads/refresh/usage may precede refusal.
    assert.equal(f.auth.gets, 1); assert.equal(f.auth.refreshCount, 0);
    assert.deepEqual(f.effects(), { physicalAdmissions: 0, cacheWriteCalls: 0 });
    assert.deepEqual(f.stats(), { eof: false, commits: 0, successes: 0, reserves: 1, releases: 1 });
    assert.deepEqual(f.router.actions.affinity(f.context!, "work"), affinity);
    assert(!JSON.stringify([f.logs, String(r.error)]).includes("fabricated-private"));
  } finally { f.router.close(); }
});

for (const [name, context_management, expected] of [
  ["null", null, "unsupported_request_field_context_management_null"],
  ["array", [], "unsupported_request_field_context_management_array"],
  ["unknown field", { ["fabricated-private\nhttps://synthetic.invalid/?token=fabricated"]: true }, "unsupported_context_management_field"],
  ["null edits", { edits: null }, "invalid_context_management_edits"],
  ["object edits", { edits: {} }, "invalid_context_management_edits"],
  ["missing keep", { edits: [{ type: "clear_thinking_20251015" }] }, "unsupported_context_management_edit"],
  ["limited retention", { edits: [{ type: "clear_thinking_20251015", keep: { type: "thinking_turns", value: 2 } }] }, "unsupported_context_management_edit"],
  ["tool clearing", { edits: [{ type: "clear_tool_uses_20250919" }] }, "unsupported_context_management_edit"],
  ["compaction", { edits: [{ type: "compact_20260112" }] }, "unsupported_context_management_edit"],
  ["combined edits", { edits: [{ type: "clear_thinking_20251015", keep: "all" }, { type: "clear_tool_uses_20250919" }] }, "unsupported_context_management_edit"],
  ["extra edit field", { edits: [{ type: "clear_thinking_20251015", keep: "all", ["fabricated-private"]: true }] }, "unsupported_context_management_edit"],
] as const) test(`actual ordered context ${name} refuses without changing history, fallback, owner or charge`, async () => {
  const f = fixture({ fallback: true });
  try {
    const body = { ...ordered(), thinking: { type: "enabled", budget_tokens: 1024 }, context_management }, before = structuredClone(body);
    const affinity = structuredClone(f.router.actions.affinity(f.context!, "work")), r = await f.run(body);
    code(r.error, `kimi_ordered_request_${expected}`); assert.equal((r.error as RoutingError).status, 422);
    assert.deepEqual(body, before); assert.deepEqual(r.seen, []); assert.deepEqual(f.sent, []); assert.equal(f.cache.size, 0);
    assert.equal(f.auth.gets, 1); assert.equal(f.auth.refreshCount, 0);
    assert.deepEqual(f.effects(), { physicalAdmissions: 0, cacheWriteCalls: 0 });
    assert.deepEqual(f.stats(), { eof: false, commits: 0, successes: 0, reserves: 1, releases: 1 });
    assert.deepEqual(f.router.actions.affinity(f.context!, "work"), affinity);
    assert(!JSON.stringify([f.logs, String(r.error)]).includes("fabricated-private"));
  } finally { f.router.close(); }
});

for (const max_tokens of [null, 0, -1, Number.MAX_SAFE_INTEGER + 1]) test(`actual invalid output cap ${max_tokens} retains the earlier capability guard`, async () => {
  const f = fixture({ fallback: true });
  try {
    const r = await f.run({ ...ordered(), max_tokens, thinking: { type: "enabled", budget_tokens: 1024 },
      context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] } });
    code(r.error, "invalid_output_limit"); assert.equal((r.error as RoutingError).status, 400);
    assert.deepEqual(r.seen, []); assert.deepEqual(f.sent, []); assert.equal(f.auth.gets, 0);
    assert.deepEqual(f.effects(), { physicalAdmissions: 0, cacheWriteCalls: 0 });
    assert.deepEqual(f.stats(), { eof: false, commits: 0, successes: 0, reserves: 0, releases: 0 });
  } finally { f.router.close(); }
});

test("ordinary Messages and direct Responses keep their existing thinking/effort/context policy", async () => {
  const native = fixture({ action: false, reply: () => response(wire(nativeMessages())) }), direct = fixture();
  try {
    const context_management = { edits: [{ type: "clear_tool_uses_20250919" }] };
    assert.equal((await native.run({ ...ordinary(), thinking: { type: "disabled" }, context_management })).error, undefined);
    assert.deepEqual(native.sent[0]!.body["thinking"], { type: "enabled" });
    assert.deepEqual(native.sent[0]!.body["output_config"], { effort: "high" });
    assert.deepEqual(native.sent[0]!.body["context_management"], context_management);
    assert.equal((await direct.run({ model: "work", input: [{ role: "user", content: "hello" }], reasoning: { effort: "low" }, context_management }, "codex")).error, undefined);
    assert.deepEqual(direct.sent[0]!.body["reasoning"], { effort: "high" });
    assert.deepEqual(direct.sent[0]!.body["context_management"], context_management);
  } finally { native.router.close(); direct.router.close(); }
});

function cacheConversation(): Item {
  const body = ordered();
  body["system"] = [{ type: "text", text: "initial" }];
  const messages = body["messages"] as Item[];
  messages[0]!["content"] = [{ type: "text", text: "first" }];
  messages.push(
    { role: "assistant", content: [{ type: "text", text: "before" }, { type: "tool_use", id: "caller-id", name: "inspect",
      input: { cache_control: { type: "caller data", scope: "private" }, signature: "caller data" } }, { type: "text", text: "after" }] },
    { role: "system", content: "between call and result" },
    { role: "user", content: [{ type: "text", text: "prefix" }, { type: "tool_result", tool_use_id: "caller-id",
      content: '{"cache_control":{"ttl":"caller data"}}' }, { type: "text", text: "suffix" }] });
  (body["tools"] as Item[])[0]!["input_schema"] = { type: "object", properties: { cache_control: { type: "string" } },
    cache_control: { type: "schema data", scope: "private" } };
  return body;
}
function cacheLocations(body: Item): Item[] {
  const messages = body["messages"] as Item[], blocks = (i: number) => messages[i]!["content"] as Item[];
  return [body, (body["system"] as Item[])[0]!, blocks(0)[0]!, blocks(1)[0]!, blocks(3)[0]!,
    blocks(3)[1]!, blocks(5)[1]!, (body["tools"] as Item[])[0]!];
}
for (const stream of [false, true]) for (const [name, hint] of [["null", null], ["ephemeral", { type: "ephemeral" }],
  ["5m", { type: "ephemeral", ttl: "5m" }], ["1h", { type: "ephemeral", ttl: "1h" }]] as const) {
  test(`actual ordered ${name} hints preserve full request, owner and accounting stream${stream}`, async () => {
    const owners: string[] = [], baseline = fixture(), f = fixture({ prepared(r) { owners.push(r.owner); } });
    try {
      const full = cacheConversation(), fullControl = cacheConversation();
      for (const location of cacheLocations(full)) location["cache_control"] = structuredClone(hint);
      // All eight locations still exercise full-request validation. An imported
      // assistant is deliberately not a routed seed in v2.
      assert.deepEqual(renderKimiResponsesRequest(full), renderKimiResponsesRequest(fullControl));
      const body: Item = { ...ordered(), stream, cache_control: structuredClone(hint) }, control: Item = { ...ordered(), stream };
      const before = structuredClone(body), result = await f.run(body), base = await baseline.run(control);
      assert.equal(result.error, undefined); assert.equal(base.error, undefined); assert.deepEqual(body, before);
      assert.deepEqual(f.sent, baseline.sent, "only validated source cache hints are omitted; prompt/tool data stays identical");
      assert.deepEqual(result.seen, base.seen); assert.equal(f.sent.length, 1); assert.equal(f.sent[0]!.body["store"], false);
      assert.deepEqual(owners, [ownerKey(profile, target, "responses", "generation1", "kimi-ordered-messages-v4")]);
      assert.equal(f.auth.gets, 1); assert.equal(f.auth.refreshCount, 0);
      assert.deepEqual(f.effects(), { physicalAdmissions: 1, cacheWriteCalls: 1 });
      assert.deepEqual(f.stats(), { eof: true, commits: 1, successes: 1, reserves: 1, releases: 1 });
      assert.equal(f.cache.size, 1, "one association, with no source cache emulation");
    } finally { f.router.close(); baseline.router.close(); }
  });
}
for (const [name, index, expected] of [["request", 0, "unsupported_request_field"],
  ["text block", 2, "unsupported_block_cache_control"], ["function tool", 7, "unsupported_tool_field"]] as const) {
  test(`actual ordered invalid cache ${name} refuses without dispatch, fallback or charge`, async () => {
    const f = fixture({ fallback: true });
    try {
      const body = cacheConversation(); cacheLocations(body)[index]!["cache_control"] = {
        type: "ephemeral", evict_on_complete: true, ["private\nhttps://synthetic.invalid/?token=private"]: "private" };
      const before = structuredClone(body), affinity = structuredClone(f.router.actions.affinity(f.context!, "work")), result = await f.run(body);
      code(result.error, `kimi_ordered_request_${expected}`); assert.equal((result.error as RoutingError).status, 422);
      assert.deepEqual(body, before); assert.deepEqual(result.seen, []); assert.deepEqual(f.sent, []);
      assert.deepEqual(f.effects(), { physicalAdmissions: 0, cacheWriteCalls: 0 });
      assert.deepEqual(f.stats(), { eof: false, commits: 0, successes: 0, reserves: 1, releases: 1 });
      // FakeAuth is isolated; production auth may read/refresh before local refusal.
      assert.equal(f.auth.gets, 1); assert.equal(f.auth.refreshCount, 0);
      assert.deepEqual(f.router.actions.affinity(f.context!, "work"), affinity);
      assert(!JSON.stringify([f.logs, String(result.error)]).includes("private"));
    } finally { f.router.close(); }
  });
}
test("cache hints keep other credential refusal and existing native Messages/direct Responses policy", async () => {
  const custom = fixture({ profile: { ...profile, credential: { kind: "env", name: "FABRICATED_KEY" } } });
  const native = fixture({ action: false, reply: () => response(wire(nativeMessages())) }), direct = fixture();
  try {
    const hints = { type: "ephemeral", evict_on_complete: true };
    const body = cacheConversation(); body["cache_control"] = { type: "ephemeral" };
    code((await custom.run(body)).error, "unsupported_mid_conversation_system"); assert.deepEqual(custom.sent, []);
    assert.equal((await native.run({ ...ordinary(), cache_control: hints })).error, undefined);
    assert.equal(Object.hasOwn(native.sent[0]!.body, "cache_control"), false, "ordinary Kimi Messages already removes its top-level hint");
    assert.equal((await direct.run({ model: "work", input: "hello", cache_control: hints }, "codex")).error, undefined);
    assert.deepEqual(direct.sent[0]!.body["cache_control"], hints);
  } finally { custom.router.close(); native.router.close(); direct.router.close(); }
});
