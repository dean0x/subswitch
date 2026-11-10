/** Real renderer/publication/lookup with fabricated credentials and socketless SSE. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregateFrames } from "../../src/codex-response.js";
import { ClaudeCache } from "../../src/claude-cache.js";
import { ownerKey } from "../../src/routing/continuation-store.js";
import { renderKimiResponsesRequest } from "../../src/routing/kimi-responses-request.js";
import { RoutingError, type Item } from "../../src/routing/routing-types.js";
import { fixture, output, profile, response, target, wire } from "../helpers/kimi-ordered-route.js";
import { added, created, done, terminal, textItem } from "../helpers/kimi-responses-bridge.js";

type Request = Item & { messages: Item[] };
const texts = [' \nשלום 🦊 e\u0301 "\\\u0000\ud800', "second", ""];
const content = (text: string, blocks: boolean) => blocks ? [{ type: "text", text }] : text;
function seed(blocks = false, stream = true): Request {
  return { model: "work", stream, max_tokens: 128, system: "unchanged control",
    thinking: { type: "adaptive", display: "omitted" }, output_config: { effort: "high" },
    messages: [{ role: "user", content: content(texts[0]!, blocks) },
      { role: "system", content: content(texts[1]!, blocks) }, { role: "user", content: content(texts[2]!, blocks) }],
    tools: [{ name: "inspect", input_schema: { type: "object", properties: {
      nested: { type: "object", cache_control: { const: "caller schema data" } } } } }] };
}
function firstOutput(): Item[] {
  const visible = output(), privateItem = { type: "reasoning", id: "private-item", status: "completed",
    summary: [], encrypted_content: "fabricated-private-reasoning" };
  const raw = (visible.at(-1)!["response"] as Item)["output"] as Item[];
  const args = ' { "n" : 7, "nested" : {"cache_control":"caller data","signature":"argument data"} } ';
  for (const event of visible) if (event["type"] === "response.output_item.done" && (event["item"] as Item)["type"] === "function_call")
    (event["item"] as Item)["arguments"] = args;
  raw[1]!["arguments"] = args;
  return [created(), added(0, { ...privateItem, status: "in_progress", encrypted_content: null }), done(0, privateItem),
    ...visible.slice(1, -1).map(event => ({ ...event, output_index: Number(event["output_index"]) + 1 })), terminal([privateItem, ...raw])];
}
function finalOutput(): Item[] {
  const item = textItem("final", ["finished 🦊"]);
  return [created(), added(0, { ...item, content: [], status: "in_progress" }), done(0, item), terminal([item])];
}
function assistant(seen: Item[]): Item {
  const aggregate = aggregateFrames(seen.map(event => wire([event])), "codex");
  assert(aggregate.ok && aggregate.value.kind === "message");
  return { role: "assistant", content: aggregate.value.message.content };
}
function continuation(body: Request, seen: Item[], suffix: Item = { role: "user", content: [
  { type: "tool_result", tool_use_id: "caller-id", content: "caller result", is_error: false }] }): Request {
  return { ...structuredClone(body), messages: [...structuredClone(body.messages), assistant(seen), suffix] };
}
function equalRendering(left: Request, right: Request): void {
  const a = renderKimiResponsesRequest(left), b = renderKimiResponsesRequest(right);
  assert(a.ok && b.ok);
  // Complete destination body, flush spans, pending tool IDs and stream mode.
  assert.equal(JSON.stringify(a.value), JSON.stringify(b.value));
}
async function threeTurns(blocks: boolean, stream: boolean, flip: boolean): Promise<string[]> {
  const first = firstOutput(), final = finalOutput(), f = fixture({ reply: index => response(wire(index === 1 ? first : final), 7), prepared(ready) {
    assert.equal(ready.owner, ownerKey(profile, target, "responses", "generation1", "kimi-ordered-messages-v4"));
    assert.notEqual(ready.owner, ownerKey(profile, target, "responses", "generation1", "kimi-ordered-messages-v3"));
  } });
  try {
    const one = seed(blocks, stream), beforeOne = structuredClone(one), r1 = await f.run(one);
    assert.equal(r1.error, undefined); assert.deepEqual(one, beforeOne);
    const two = continuation(one, r1.seen), beforeFlip = structuredClone(two);
    if (flip) for (let i = 0; i < texts.length; i++) two.messages[i]!["content"] = content(texts[i]!, !blocks);
    equalRendering(beforeFlip, two);
    const beforeTwo = structuredClone(two), r2 = await f.run(two);
    assert.equal(r2.error, undefined); assert.deepEqual(two, beforeTwo);
    const rawFirst = (first.at(-1)!["response"] as Item)["output"] as Item[];
    assert.deepEqual(f.sent[1]!.body["input"], [...f.sent[0]!.body["input"] as Item[], ...rawFirst,
      { type: "function_call_output", call_id: "caller-id", output: "caller result" }]);
    const three = continuation(two, r2.seen, { role: "user", content: "third" }), beforeThirdFlip = structuredClone(three);
    if (flip) {
      for (let i = 0; i < texts.length; i++) three.messages[i]!["content"] = content(texts[i]!, blocks);
      const finalAssistant = three.messages.at(-2)!, only = finalAssistant["content"] as Item[];
      assert.equal(only.length, 1); finalAssistant["content"] = only[0]!["text"];
    }
    equalRendering(beforeThirdFlip, three);
    const beforeThree = structuredClone(three), r3 = await f.run(three);
    assert.equal(r3.error, undefined); assert.deepEqual(three, beforeThree);
    assert.deepEqual(f.sent[2]!.body["input"], [...f.sent[1]!.body["input"] as Item[],
      ...(final.at(-1)!["response"] as Item)["output"] as Item[],
      { type: "message", role: "user", content: [{ type: "input_text", text: "third" }] }]);
    assert.equal(f.sent.length, 3); assert.equal(f.stats().commits, 3);
    assert(!JSON.stringify([r1.seen, r2.seen, r3.seen]).includes("fabricated-private-reasoning"));
    return f.sent.map(request => request.serialized);
  } finally { f.router.close(); }
}

for (const blocks of [true, false]) for (const stream of [true, false])
  test(`text representation full three-turn equivalence blocks${blocks} stream${stream}`, async () => {
    assert.deepEqual(await threeTurns(blocks, stream, true), await threeTurns(blocks, stream, false));
  });

const mutations = ["text", "later-text", "role", "message-count", "message-order", "multi-block", "citations-null", "citations-empty",
  "unsupported-field", "opaque", "control", "logical-model", "target-model", "tool-schema", "tool-choice", "output-cap", "effort",
  "assistant-text", "assistant-order", "tool-input", "call-id", "result-id", "generation", "agent", "action", "store", "expired", "old-codec"] as const;
for (const mutation of mutations) test(`text representation keeps ${mutation} rejection`, async () => {
  let second = false;
  const f = fixture({ reply: () => response(wire(firstOutput())), beforePrepare(request) {
    if (second && mutation === "target-model") request.target = { ...request.target, model: "k3" };
    if (second && mutation === "old-codec") request.expectedOwner = ownerKey(profile, target, "responses", "generation1", "kimi-ordered-messages-v3");
  } });
  try {
    const first = seed(), one = await f.run(first); assert.equal(one.error, undefined);
    const next = continuation(first, one.seen), original = structuredClone(next);
    next.messages[1]!["content"] = content(texts[1]!, true); // The newly admitted wrapper alone.
    const block = () => (next.messages[1]!["content"] as Item[])[0]!;
    const published = next.messages[3]!["content"] as Item[], call = published.at(-1)!, result = (next.messages[4]!["content"] as Item[])[0]!;
    let context = f.context;
    if (mutation === "text") next.messages[0]!["content"] = "altered";
    if (mutation === "later-text") next.messages[2]!["content"] = "altered after the equal wrapper";
    if (mutation === "role") next.messages[0]!["role"] = "system";
    if (mutation === "message-count") next.messages.splice(3, 0, { role: "user", content: "extra" });
    if (mutation === "message-order") [next.messages[0], next.messages[1]] = [next.messages[1]!, next.messages[0]!];
    if (mutation === "multi-block") next.messages[1]!["content"] = [{ type: "text", text: "sec" }, { type: "text", text: "ond" }];
    if (mutation === "citations-null") block()["citations"] = null;
    if (mutation === "citations-empty") block()["citations"] = [];
    if (mutation === "unsupported-field") block()["unmapped"] = true;
    if (mutation === "opaque") published.unshift({ type: "thinking", thinking: "fabricated", signature: "unowned" });
    if (mutation === "control") next["system"] = "altered control";
    if (mutation === "logical-model") next["model"] = "altered logical model";
    if (mutation === "tool-schema") (((next["tools"] as Item[])[0]!["input_schema"] as Item)["properties"] as Item)["nested"] = { cache_control: "altered" };
    if (mutation === "tool-choice") next["tool_choice"] = { type: "none" };
    if (mutation === "output-cap") next["max_tokens"] = 256;
    if (mutation === "effort") next["output_config"] = { effort: "low" };
    if (mutation === "assistant-text") published[0]!["text"] = "altered assistant";
    if (mutation === "assistant-order") published.unshift(published.pop()!);
    if (mutation === "tool-input") (call["input"] as Item)["n"] = 8;
    if (mutation === "call-id") { call["id"] = "other"; result["tool_use_id"] = "other"; }
    if (mutation === "result-id") result["tool_use_id"] = "other";
    if (mutation === "generation") f.auth.generation = "changed";
    if (mutation === "agent") context = { ...context!, agentId: "b".repeat(64) };
    if (mutation === "action") context = f.router.actions.context(f.router.actions.create("claude-code", "synthetic-thread").id, "claude-code");
    if (mutation === "store") Object.defineProperty(f.attempts, "replay", { value: new ClaudeCache() });
    if (mutation === "expired") f.router.actions.complete(context!.actionId);
    if (mutation === "citations-null" || mutation === "citations-empty") equalRendering(original, next); // Conservatively outside the new domain.
    second = true;
    const seen: Item[] = []; let error: unknown;
    try { for await (const event of f.router.events(next, "claude-code", "work", f.controller.signal, context)) seen.push(event); }
    catch (caught) { error = caught; }
    assert(error instanceof RoutingError);
    const expected = mutation === "unsupported-field" ? "kimi_ordered_request_unsupported_block_field" :
      mutation === "opaque" ? "foreign_opaque_state" : mutation === "result-id" ? "unsupported_routed_content" :
      ["generation", "target-model", "old-codec"].includes(mutation) ? "credential_owner_changed" :
      mutation === "expired" ? "action_state_lost" : "continuity_unavailable";
    assert.equal(error.code, expected); assert.deepEqual(seen, []);
    assert.equal(f.sent.length, 1); assert.equal(f.effects().physicalAdmissions, 1); assert.equal(f.stats().commits, 1);
  } finally { f.router.close(); }
});

for (const mutation of ["content", "order"] as const) test(`text representation keeps prior tool-result ${mutation} exact`, async () => {
  const f = fixture({ reply: index => response(wire(index === 1 ? firstOutput() : finalOutput())) });
  try {
    const first = seed(), one = await f.run(first); assert.equal(one.error, undefined);
    const two = continuation(first, one.seen, { role: "user", content: [{ type: "text", text: "before" },
      { type: "tool_result", tool_use_id: "caller-id", content: "caller result" }, { type: "text", text: "after" }] });
    const replay = await f.run(two); assert.equal(replay.error, undefined);
    const three = continuation(two, replay.seen, { role: "user", content: "third" });
    three.messages[1]!["content"] = content(texts[1]!, true);
    const prior = three.messages[4]!["content"] as Item[];
    if (mutation === "content") prior[1]!["content"] = "changed old result";
    else [prior[0], prior[2]] = [prior[2]!, prior[0]!];
    const failed = await f.run(three); assert(failed.error instanceof RoutingError); assert.equal(failed.error.code, "continuity_unavailable");
    assert.deepEqual(failed.seen, []); assert.equal(f.sent.length, 2); assert.equal(f.stats().commits, 2);
  } finally { f.router.close(); }
});
