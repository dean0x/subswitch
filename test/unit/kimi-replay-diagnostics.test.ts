/** Fabricated in-memory route/cache cases only. No native client, socket or credential read. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregateFrames } from "../../src/codex-response.js";
import { ClaudeCache, type CacheWrite, type ClaudeCacheValues, type KimiOrderedAssociation } from "../../src/claude-cache.js";
import { StagedCache, OrderedReplayDiagnostics, type OrderedReplayDiagnostic } from "../../src/routing/replay-cache.js";
import { KimiExecPending } from "../../src/routing/kimi-exec-pending.js";
import { RoutingError, type Item } from "../../src/routing/routing-types.js";
import { fixture, ordered, response, wire } from "../helpers/kimi-ordered-route.js";
import { added, created, done, terminal, textItem } from "../helpers/kimi-responses-bridge.js";

const sentinel = "FABRICATED_PRIVATE_SCOPE_PREFIX_TOOL_HISTORY_CIPHERTEXT_TOKEN_DEVICE_https://invalid.example";
const association = (): Readonly<KimiOrderedAssociation> => Object.freeze({ version: 1,
  scopeCanonical: sentinel + "scope", prefixCanonical: sentinel + "prefix",
  upstreamInputCanonical: "[]", rawOutputCanonical: JSON.stringify([sentinel]) });
class CountedCache extends ClaudeCache {
  gets = 0; puts = 0; batches = 0;
  override get<K extends keyof ClaudeCacheValues>(kind: K, id: string): ClaudeCacheValues[K] | undefined {
    this.gets++; return super.get(kind, id);
  }
  override put<K extends keyof ClaudeCacheValues>(kind: K, id: string, value: ClaudeCacheValues[K], pending?: KimiExecPending): void {
    this.puts++; super.put(kind, id, value, pending);
  }
  override putBatch(writes: readonly CacheWrite[], pending?: KimiExecPending): void {
    this.batches++; super.putBatch(writes, pending);
  }
  order() { return [...this.retainedEntries.keys()]; }
  forget() { this.clearEntries(); }
  orderedRecords() { return [...this.retainedEntries.values()].filter(e => e.kind === "kimiOrdered").map(e => e.value); }
}
function closed(events: readonly Readonly<OrderedReplayDiagnostic>[]) {
  for (const event of events) {
    assert(Object.isFrozen(event));
    assert.deepEqual(Object.keys(event).sort(), ["committed", "event", "recordPresent", "reference", "samePrefix", "sameScope", "sameStore"]);
    assert(["staged", "published", "publication_failed", "aborted", "lookup"].includes(event.event));
    assert(["last_staged", "unavailable"].includes(event.reference));
    for (const key of ["sameScope", "samePrefix", "sameStore", "recordPresent", "committed"] as const)
      assert(event[key] === null || typeof event[key] === "boolean");
  }
  assert(!JSON.stringify(events).includes(sentinel));
  assert(!JSON.stringify(events).includes("f".repeat(64)));
}
function replayAssistant(events: Item[]): Item {
  const result = aggregateFrames(events.map(e => wire([e])), "codex");
  assert(result.ok && result.value.kind === "message");
  return { role: "assistant", content: result.value.message.content };
}
const reply = () => {
  const item = textItem("msg", [sentinel]);
  return response(wire([created(), added(0, { ...item, content: [], status: "in_progress" }), done(0, item), terminal([item])]));
};
const errorCode = (error: unknown) => {
  if (error === undefined) return undefined;
  assert(error instanceof RoutingError); return error.code;
};

for (const scenario of ["hit", "scope", "prefix", "store", "absent"] as const)
  test(`private comparison ${scenario} preserves route result, real cache calls and quota`, async () => {
    const results: unknown[] = [];
    for (const enabled of [false, true]) {
      const events: Readonly<OrderedReplayDiagnostic>[] = [], cache = new CountedCache();
      const diagnostics = new OrderedReplayDiagnostics(e => events.push(e));
      const f = fixture({ cache, reply, ...(enabled ? { diagnostics } : {}) });
      let replacement: CountedCache | undefined;
      try {
        const first = ordered(); (first["messages"] as Item[])[0]!["content"] = sentinel;
        const seed = await f.run(first); assert.equal(seed.error, undefined);
        // This fixture deliberately keeps its fabricated record alive to distinguish
        // entry loss from collection. The diagnostic implementation does not own it.
        const retained = cache.orderedRecords(); assert.equal(retained.length, 1);
        const body = { ...first, messages: [...first["messages"] as Item[], replayAssistant(seed.seen), { role: "user", content: "next" }] };
        let context = f.context;
        if (scenario === "scope") context = { ...context!, agentId: "b".repeat(64) };
        if (scenario === "prefix") body.messages[0] = { ...body.messages[0], content: "changed fabricated history" };
        if (scenario === "store") { replacement = new CountedCache(); Object.defineProperty(f.attempts, "replay", { value: replacement }); }
        if (scenario === "absent") cache.forget();
        const second: Item[] = []; let error: unknown;
        try { for await (const event of f.router.events(body, "claude-code", "work", f.controller.signal, context)) second.push(event); }
        catch (caught) { error = caught; }
        assert.equal(errorCode(error), scenario === "hit" ? undefined : "continuity_unavailable");
        if (scenario !== "hit") { assert.deepEqual(second, []); assert.equal((error as RoutingError).status, 409); }
        assert.equal(f.effects().physicalAdmissions, scenario === "hit" ? 2 : 1);
        assert.equal(cache.gets + (replacement?.gets ?? 0), 1, "only the real shared lookup");
        assert.equal(cache.puts + (replacement?.puts ?? 0), 0);
        assert.equal(cache.batches + (replacement?.batches ?? 0), scenario === "hit" ? 2 : 1);
        if (enabled) {
          const lookup = events.filter(e => e.event === "lookup"); assert.equal(lookup.length, 1);
          assert.deepEqual(lookup[0], { event: "lookup", reference: "last_staged", sameScope: scenario !== "scope",
            samePrefix: scenario !== "prefix", sameStore: scenario !== "store", recordPresent: scenario === "hit", committed: true });
          assert.equal(events[0]!.event, "staged"); assert.equal(events[0]!.committed, false);
          assert.equal(events[1]!.event, "published"); assert.equal(events[1]!.committed, true);
          closed(events);
          for (const log of f.logs) assert(!JSON.stringify(log).includes("samePrefix"));
          assert(!JSON.stringify(second).includes("samePrefix"), "private fields never reach caller frames");
        } else assert.deepEqual(events, []);
        assert.equal(retained[0]!.version, 1);
        results.push({ error: errorCode(error), sent: f.sent, stats: f.stats(), effects: f.effects(),
          gets: cache.gets, replacementGets: replacement?.gets, batches: cache.batches, replacementBatches: replacement?.batches,
          bytes: cache.byteSize, size: cache.size, replacementSize: replacement?.size,
          frameTypes: second.map(e => e["type"]) });
      } finally { f.router.close(); }
    }
    assert.deepEqual(results[0], results[1]);
  });

test("missing prior evidence reports unknown and preserves ordinary 409", async () => {
  const events: Readonly<OrderedReplayDiagnostic>[] = [], diagnostics = new OrderedReplayDiagnostics(e => events.push(e));
  const f = fixture({ diagnostics, reply });
  try {
    const first = ordered(), body = { ...first, messages: [...first["messages"] as Item[],
      { role: "assistant", content: [{ type: "text", text: "unobserved" }] }, { role: "user", content: "next" }] };
    const result = await f.run(body); assert.equal(errorCode(result.error), "continuity_unavailable");
    assert.equal(f.effects().physicalAdmissions, 0); assert.deepEqual(result.seen, []);
    assert.deepEqual(events, [{ event: "lookup", reference: "unavailable", sameScope: null, samePrefix: null,
      sameStore: null, recordPresent: false, committed: null }]); closed(events);
  } finally { f.router.close(); }
});

for (const finish of ["staged", "aborted", "published", "failed"] as const)
  test(`actual publication boundary ${finish} keeps accounting and atomicity`, () => {
    const outcomes: unknown[] = [];
    for (const enabled of [false, true]) {
      const events: Readonly<OrderedReplayDiagnostic>[] = [], diagnostics = new OrderedReplayDiagnostics(e => events.push(e));
      const shared = new CountedCache({ maxEntries: finish === "failed" ? 1 : 8, maxBytes: 100000 }, true);
      const stage = new StagedCache(shared, enabled ? diagnostics : undefined), pending = new KimiExecPending(), value = association();
      stage.attachPending(pending);
      stage.putBatch([{ kind: "kimiOrdered", id: "f".repeat(64), value }, { kind: "adapted", id: "marker", value: true }]);
      const stagedBytes = pending.byteSize; assert(stagedBytes > 0); assert.equal(shared.size, 0);
      assert.equal(shared.batches, 0);
      if (enabled) assert.deepEqual(events.map(e => [e.event, e.committed]), [["staged", false]]);
      if (finish === "published") stage.commit();
      if (finish === "failed") assert.throws(() => stage.commit(), (e: unknown) => errorCode(e) === "continuation_store_full");
      if (finish === "aborted" || finish === "failed") stage.dispose();
      if (finish !== "staged") assert.equal(pending.byteSize, 0);
      assert.equal(shared.size, finish === "published" ? 2 : 0, "failed group publishes neither association nor marker");
      if (enabled) {
        const expected = finish === "staged" ? [["staged", false]] : finish === "aborted" ? [["staged", false], ["aborted", false]] :
          finish === "published" ? [["staged", false], ["published", true]] : [["staged", false], ["publication_failed", false], ["aborted", false]];
        assert.deepEqual(events.map(e => [e.event, e.committed]), expected); closed(events);
      }
      outcomes.push({ stagedBytes, bytes: pending.byteSize, sharedBytes: shared.byteSize, size: shared.size,
        gets: shared.gets, puts: shared.puts, batches: shared.batches });
      stage.dispose(); assert.equal(pending.byteSize, 0);
    }
    assert.deepEqual(outcomes[0], outcomes[1]);
  });

test("diagnostics add no LRU read and do not change subsequent eviction", () => {
  const events: Readonly<OrderedReplayDiagnostic>[] = [], diagnostics = new OrderedReplayDiagnostics(e => events.push(e));
  const shared = new CountedCache({ maxEntries: 3, maxBytes: 100000 }), stage = new StagedCache(shared, diagnostics), value = association();
  shared.put("adapted", "old", true); stage.put("kimiOrdered", "f".repeat(64), value); stage.commit();
  shared.put("adapted", "middle", true);
  const lookup = new StagedCache(shared, diagnostics), record = lookup.get("kimiOrdered", "f".repeat(64)), afterGet = shared.order();
  lookup.observeOrderedLookup(value.scopeCanonical, value.prefixCanonical, record);
  assert.deepEqual(shared.order(), afterGet); assert.equal(shared.gets, 1);
  shared.put("adapted", "new", true);
  assert.deepEqual(shared.order(), ["adapted:middle", `kimiOrdered:${"f".repeat(64)}`, "adapted:new"]);
  assert.equal(shared.puts, 3); assert.equal(shared.batches, 1); closed(events); lookup.dispose(); stage.dispose();
});

test("staged observer cannot interleave partial batch registration", () => {
  const shared = new ClaudeCache(), pending = new KimiExecPending(), observed: number[] = [];
  const events: Readonly<OrderedReplayDiagnostic>[] = [];
  const diagnostics = new OrderedReplayDiagnostics(event => {
    events.push(event);
    if (event.event === "staged") { observed.push(stage.size); stage.commit(); }
  });
  const stage = new StagedCache(shared, diagnostics); stage.attachPending(pending);
  stage.putBatch([{ kind: "kimiOrdered", id: "key", value: association() }, { kind: "adapted", id: "marker", value: true }]);
  assert.deepEqual(observed, [2]); assert.equal(shared.size, 2); assert.equal(pending.byteSize, 0);
  assert.deepEqual(events.map(e => [e.event, e.committed]), [["staged", false], ["published", true]]); closed(events);
});

test("latest staged reference is explicit and is not asserted to be a matching predecessor", () => {
  const events: Readonly<OrderedReplayDiagnostic>[] = [], diagnostics = new OrderedReplayDiagnostics(e => events.push(e));
  const shared = new ClaudeCache(), first = new StagedCache(shared, diagnostics), second = new StagedCache(shared, diagnostics);
  const a = association(), b = Object.freeze({ ...association(), scopeCanonical: "another scope", prefixCanonical: "another prefix" });
  first.put("kimiOrdered", "a", a); second.put("kimiOrdered", "b", b); first.commit();
  const record = first.get("kimiOrdered", "a"); first.observeOrderedLookup(a.scopeCanonical, a.prefixCanonical, record);
  assert.deepEqual(events.at(-1), { event: "lookup", reference: "last_staged", sameScope: false, samePrefix: false,
    sameStore: true, recordPresent: true, committed: false });
  second.dispose(); first.dispose(); closed(events);
});

for (const failure of ["observer", "observer-getter", "diagnostics-getter"] as const)
  test(`hostile ${failure} cannot replace cache success or failure`, () => {
    const diagnostics = new OrderedReplayDiagnostics(() => { throw Error(sentinel); });
    if (failure === "observer-getter") Object.defineProperty(diagnostics, "observe", { get() { throw Error(sentinel); } });
    const shared = new CountedCache(), value = association();
    const makeStage = () => {
      const stage = new StagedCache(shared, diagnostics);
      if (failure === "diagnostics-getter") Object.defineProperty(stage, "diagnostics", { get() { throw Error(sentinel); } });
      return stage;
    };
    const stage = makeStage();
    stage.put("kimiOrdered", "f".repeat(64), value); stage.commit();
    const lookup = makeStage(), record = lookup.get("kimiOrdered", "f".repeat(64)); assert.equal(record, value);
    lookup.observeOrderedLookup(value.scopeCanonical, value.prefixCanonical, record);
    const collision = makeStage();
    collision.put("kimiOrdered", "f".repeat(64), value);
    assert.throws(() => collision.commit(), (e: unknown) => errorCode(e) === "continuity_unavailable");
    collision.dispose(); lookup.dispose(); stage.dispose(); assert.equal(shared.size, 1); assert.equal(shared.gets, 1); assert.equal(shared.batches, 2);
  });

test("comparison does not execute association getters", () => {
  let reads = 0;
  const value: Readonly<KimiOrderedAssociation> = { ...association(),
    get scopeCanonical() { reads++; return sentinel; }, get prefixCanonical() { reads++; return sentinel; } };
  const events: Readonly<OrderedReplayDiagnostic>[] = [], diagnostics = new OrderedReplayDiagnostics(e => events.push(e));
  const shared = new ClaudeCache(), stage = new StagedCache(shared, diagnostics);
  stage.put("kimiOrdered", "key", value);
  const record = stage.get("kimiOrdered", "key"), before = reads;
  stage.observeOrderedLookup(sentinel, sentinel, record);
  assert.equal(reads, before);
  assert.deepEqual(events.at(-1), { event: "lookup", reference: "last_staged", sameScope: null, samePrefix: null,
    sameStore: true, recordPresent: true, committed: false }); closed(events); stage.dispose();
});
