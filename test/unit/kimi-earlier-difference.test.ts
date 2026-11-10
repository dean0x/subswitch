/** Fabricated histories and real socketless publication/lookup only. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregateFrames } from "../../src/codex-response.js";
import { ClaudeCache, type KimiOrderedAssociation } from "../../src/claude-cache.js";
import { orderedCanonical } from "../../src/routing/kimi-ordered-replay.js";
import { earlierDifference } from "../../src/routing/replay-prefix-comparison.js";
import { OrderedReplayDiagnostics, StagedCache, type OrderedReplayEarlierDiagnostic } from "../../src/routing/replay-cache.js";
import { RoutingError, type Item } from "../../src/routing/routing-types.js";
import { fixture, ordered, output, response, wire } from "../helpers/kimi-ordered-route.js";
import { added, created, done, terminal, textItem } from "../helpers/kimi-responses-bridge.js";

const secret = 'FABRICATED_PRIVATE_🦊_\\_"role":{},"messages":[{]}';
const canonical = (earlier: Item[]) => orderedCanonical({ controls: {}, messages: [...earlier,
  { role: "assistant", content: [{ type: "text", text: "final assistant" }] }] });
const fields = ["role", "type", "text", "id", "name", "input", "tool_use_id", "content", "is_error", "citations",
  "none", "message_count", "content_shape", "block_count", "other", "limit", "unavailable"];
function closed(fact: Readonly<OrderedReplayEarlierDiagnostic>) {
  assert(Object.isFrozen(fact));
  assert.deepEqual(Object.keys(fact).sort(), ["afterShape", "beforeShape", "blockIndex", "event", "field", "messageIndex", "reference", "sameText"]);
  assert.equal(fact.event, "earlier_difference"); assert(["last_staged", "unavailable"].includes(fact.reference));
  for (const index of [fact.messageIndex, fact.blockIndex]) assert(index === null || Number.isInteger(index) && index >= 0 && index <= 255);
  assert(fields.includes(fact.field));
  for (const value of [fact.beforeShape, fact.afterShape]) assert(["string", "array", "object", "number", "boolean", "null", "missing", "unknown"].includes(value));
  assert(fact.sameText === null || typeof fact.sameText === "boolean");
  assert(!JSON.stringify(fact).includes("FABRICATED_PRIVATE"));
}
const scenarios = [
  ["match", "none", null, null, "unknown", "unknown", null],
  ["string-block", "none", null, null, "unknown", "unknown", null],
  ["string-block-changed", "text", 0, null, "string", "string", false],
  ["block-string", "none", null, null, "unknown", "unknown", null],
  ["string-text", "text", 0, null, "string", "string", false],
  ["role", "role", 0, null, "string", "string", null],
  ["block-text", "text", 1, 1, "string", "string", false],
  ["empty-citations", "citations", 1, 0, "missing", "null", true],
  ["block-count", "block_count", 1, 2, "missing", "object", null],
  ["message-count", "message_count", 3, null, "missing", "object", null],
  ["advisory-hint", "none", null, null, "unknown", "unknown", null],
] as const;
for (const [scenario, ...expected] of scenarios) test(`earlier first difference ${scenario} keeps strict route and existing callbacks unchanged`, async () => {
  const outcomes: unknown[] = [];
  for (const enabled of [false, true]) {
    const original: unknown[] = [], partition: unknown[] = [], detail: Readonly<OrderedReplayEarlierDiagnostic>[] = [];
    const diagnostics = new OrderedReplayDiagnostics(fact => original.push(fact), fact => partition.push(fact), enabled ? fact => detail.push(fact) : undefined);
    const text = textItem("end", ["done"]), final = wire([created(), added(0, { ...text, content: [], status: "in_progress" }), done(0, text), terminal([text])]);
    const f = fixture({ diagnostics, reply: index => response(index === 1 ? wire(output()) : final, 7) });
    try {
      const first = ordered(); first["thinking"] = { type: "adaptive", display: "omitted" };
      const messages = first["messages"] as Item[]; messages[0]!["content"] = secret;
      messages[2]!["content"] = [{ type: "text", text: "next" }];
      const firstCopy = structuredClone(first), one = await f.run(first); assert.equal(one.error, undefined);
      const aggregate = aggregateFrames(one.seen.map(e => wire([e])), "codex"); assert(aggregate.ok && aggregate.value.kind === "message");
      const next: Item & { messages: Item[] } = { ...structuredClone(first), messages: [...structuredClone(messages),
        { role: "assistant", content: aggregate.value.message.content },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "caller-id", content: "fabricated result" }] }] };
      const blocks = next.messages[1]!["content"] as Item[];
      if (scenario === "string-block") next.messages[0]!["content"] = [{ type: "text", text: secret }];
      if (scenario === "string-block-changed") next.messages[0]!["content"] = [{ type: "text", text: "changed" }];
      if (scenario === "block-string") next.messages[2]!["content"] = "next";
      if (scenario === "string-text") next.messages[0]!["content"] = "changed";
      if (scenario === "role") next.messages[0]!["role"] = "system";
      if (scenario === "block-text") blocks[1]!["text"] = "changed";
      if (scenario === "empty-citations") blocks[0]!["citations"] = null;
      if (scenario === "block-count") blocks.push({ type: "text", text: "extra" });
      if (scenario === "message-count") next.messages.splice(3, 0, { role: "user", content: "extra" });
      if (scenario === "advisory-hint") blocks[1]!["cache_control"] = { type: "ephemeral", ttl: "5m" };
      const nextCopy = structuredClone(next), two = await f.run(next), hit = ["match", "advisory-hint", "string-block", "block-string"].includes(scenario);
      if (hit) assert.equal(two.error, undefined);
      else { assert(two.error instanceof RoutingError); assert.equal(two.error.code, "continuity_unavailable"); assert.equal(two.error.status, 409); assert.deepEqual(two.seen, []); }
      assert.deepEqual(first, firstCopy); assert.deepEqual(next, nextCopy); assert.equal(f.sent.length, hit ? 2 : 1);
      if (enabled) {
        assert.equal(detail.length, 1); const fact = detail[0]!; closed(fact);
        assert.deepEqual([fact.field, fact.messageIndex, fact.blockIndex, fact.beforeShape, fact.afterShape, fact.sameText], expected);
      } else assert.deepEqual(detail, []);
      outcomes.push({ original, partition, sent: f.sent, stats: f.stats(), effects: f.effects(), bytes: f.cache.byteSize,
        size: f.cache.size, frameTypes: two.seen.map(e => e["type"]) });
    } finally { f.router.close(); }
  }
  assert.deepEqual(outcomes[0], outcomes[1]);
});

test("earlier first difference labels known tool input without traversing caller argument names", () => {
  const message = (value: string) => ({ role: "assistant", content: [{ type: "tool_use", id: "id", name: "tool", input: { [secret]: value } }] });
  const fact = earlierDifference(canonical([message("old")]), canonical([message("new")]));
  assert.deepEqual(fact, { messageIndex: 0, blockIndex: 0, field: "input", beforeShape: "object", afterShape: "object", sameText: null });
  assert(!JSON.stringify(fact).includes("FABRICATED_PRIVATE"));
});
for (const variant of ["missing", "unknown-key", "depth", "message-limit", "block-limit"] as const)
  test(`earlier first difference ${variant} gives closed unknown or limit`, () => {
    let prior: string | undefined = canonical([{ role: "user", content: secret }]), current = prior;
    if (variant === "missing") prior = undefined;
    if (variant === "unknown-key") {
      prior = canonical([{ role: "user", content: [{ type: "text", text: "old" }] }]);
      current = canonical([{ role: "user", content: [{ type: "text", text: "new", [secret]: "private" }] }]);
    }
    if (variant === "depth") current = canonical([{ role: "user", content: Array.from({ length: 130 }).reduce<Item>(v => ({ child: v }), {}) }]);
    if (variant === "message-limit") {
      const messages = Array.from({ length: 257 }, () => ({ role: "user", content: secret })); prior = canonical(messages);
      messages[256]!.content = "changed"; current = canonical(messages);
    }
    if (variant === "block-limit") {
      const content = Array.from({ length: 257 }, () => ({ type: "text", text: secret })); prior = canonical([{ role: "user", content }]);
      content[256]!.text = "changed"; current = canonical([{ role: "user", content }]);
    }
    const fact = earlierDifference(prior, current);
    assert.equal(fact.field, variant.endsWith("limit") ? "limit" : "unavailable");
    assert(!JSON.stringify(fact).includes("FABRICATED_PRIVATE"));
  });

for (const failure of ["callback", "callback-getter", "record-getter"] as const)
  test(`earlier first difference hostile ${failure} preserves original cache observation`, () => {
    let reads = 0;
    const diagnostics = new OrderedReplayDiagnostics(() => {}, undefined, () => { throw Error(secret); });
    if (failure === "callback-getter") Object.defineProperty(diagnostics, "observeEarlier", { get() { throw Error(secret); } });
    const shared = new ClaudeCache(), stage = new StagedCache(shared, diagnostics);
    const value: KimiOrderedAssociation = { version: 1, scopeCanonical: "scope", prefixCanonical: canonical([{ role: "user", content: secret }]), upstreamInputCanonical: "[]", rawOutputCanonical: "[]" };
    if (failure === "record-getter") Object.defineProperty(value, "prefixCanonical", { get() { reads++; return secret; } });
    try { stage.put("kimiOrdered", "key", value); const record = stage.get("kimiOrdered", "key"), before = reads;
      stage.observeOrderedLookup("scope", canonical([]), record); assert.equal(reads, before); assert.equal(record, value); assert.equal(shared.size, 0);
    } finally { stage.dispose(); }
  });
