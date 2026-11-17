/** Regressions for independently reproduced KRS1..4, using owned fabricated streams only. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Readable } from "node:stream";
import { aggregateFrames, createSseParser, isParserComment, type SseEvent } from "../../src/codex-response.js";
import { ClaudeCache, type KimiOrderedAssociation } from "../../src/claude-cache.js";
import { jsonBytes, jsonStringBytes } from "../../src/json-size.js";
import { KimiExecPending } from "../../src/routing/kimi-exec-pending.js";
import { kimiOrderedTransport } from "../../src/routing/kimi-ordered-transport.js";
import { StagedCache } from "../../src/routing/replay-cache.js";
import { RoutingError, type Item } from "../../src/routing/routing-types.js";
import { fixture, ordered, output, response, wire } from "../helpers/kimi-ordered-route.js";

function budget(error: unknown): boolean {
  assert(error instanceof RoutingError); assert.equal(error.code, "provider_state_too_large"); assert.equal(error.status, 502);
  return true;
}
function published(seen: Item[]): Item {
  const result = aggregateFrames(seen.map(e => wire([e])), "codex");
  assert(result.ok && result.value.kind === "message");
  return { role: "assistant", content: result.value.message.content };
}
const association = (): KimiOrderedAssociation => Object.freeze({ version: 1, scopeCanonical: "{}", prefixCanonical: "{}",
  upstreamInputCanonical: "[]", rawOutputCanonical: "x".repeat(1024 * 1024) });

for (const constrained of [true, false]) test(`KRS1 one-MiB comment shares the production ledger constrained${constrained}`, async () => {
  const events = output().map((e, i) => ({ ...e, sequence_number: i }));
  const raw = wire([events[0]!]) + ":" + "x".repeat(1024 * 1024) + "\n\n" + wire(events.slice(1));
  let ledger: KimiExecPending | undefined, peak = 0;
  const f = fixture({ reply: () => response(raw, 4096), prepared(ready) {
    ledger = ready.atomicPending!; if (constrained) Object.defineProperty(ledger, "limit", { value: 65536 });
    const reserve = ledger.reserve.bind(ledger);
    ledger.reserve = bytes => { const lease = reserve(bytes); peak = Math.max(peak, ledger!.byteSize); return lease; };
  } });
  try {
    const result = await f.run();
    if (constrained) {
      budget(result.error); assert.deepEqual(result.seen, []); assert.equal(f.cache.size, 0); assert.equal(f.stats().commits, 0); assert.equal(f.stats().successes, 0);
      assert(peak > 32768 && peak <= 65536);
    } else {
      assert.equal(result.error, undefined); assert(result.seen.length); assert.equal(f.cache.size, 1); assert.equal(f.stats().commits, 1); assert(peak > 1024 * 1024);
    }
    assert.equal(ledger!.byteSize, 0);
  } finally { f.router.close(); }
});

for (const streaming of [true, false]) test(`KRS2 exact published nested negative-zero tool prefix replays streaming${streaming}`, async () => {
  const events = output(), spelling = ' { "n" : -0, "nested" : [ -0, { "z" : -0 } ] } ';
  for (const e of events) if (e["type"] === "response.output_item.done" && (e["item"] as Item)["type"] === "function_call")
    (e["item"] as Item)["arguments"] = spelling;
  (((events.at(-1)!["response"] as Item)["output"] as Item[])[1]!)["arguments"] = spelling;
  const f = fixture({ reply: () => response(wire(events), 3) });
  try {
    const seed: Item = { ...ordered(), stream: streaming }, first = await f.run(seed); assert.equal(first.error, undefined);
    const a = published(first.seen), tool = (a["content"] as Item[]).find(b => b["type"] === "tool_use")!;
    assert.deepEqual(tool["input"], { n: 0, nested: [0, { z: 0 }] });
    assert.equal(Object.is((tool["input"] as Item)["n"], -0), false);
    const second = await f.run({ ...seed, messages: [...seed["messages"] as Item[], a,
      { role: "user", content: [{ type: "tool_result", tool_use_id: "caller-id", content: "caller result" }] }] });
    assert.equal(second.error, undefined); assert(second.seen.length); assert.equal(f.stats().commits, 2);
    const replay = f.sent[1]!.body["input"] as Item[], prior = (events.at(-1)!["response"] as Item)["output"] as Item[];
    assert.deepEqual(replay.slice(0, -1), [...f.sent[0]!.body["input"] as Item[], ...prior]);
    assert.equal(replay.find(i => i["type"] === "function_call")!["arguments"], spelling);
    assert.deepEqual(replay.at(-1), { type: "function_call_output", call_id: "caller-id", output: "caller result" });
  } finally { f.router.close(); }
});

test("KRS4 first finish-frame reservation retains the fixed budget error and releases local leases", async () => {
  let forced = false, ledger: KimiExecPending | undefined;
  const f = fixture({ prepared(ready) {
    ledger = ready.atomicPending!; const reserve = ledger.reserve.bind(ledger);
    ledger.reserve = bytes => {
      if (!forced && new Error().stack?.includes("at emit")) { forced = true; Object.defineProperty(ledger, "limit", { value: ledger!.byteSize }); }
      return reserve(bytes);
    };
  } });
  try {
    const r = await f.run(); assert(forced); budget(r.error); assert.deepEqual(r.seen, []);
    assert.equal(f.cache.size, 0); assert.equal(f.stats().commits, 0); assert.equal(f.stats().successes, 0); assert.equal(ledger!.byteSize, 0);
  } finally { f.router.close(); }
});

for (const operation of ["retain", "stage", "stage-batch", "shared", "shared-batch", "commit"] as const)
  test(`KRS3 exhausted ${operation} refuses before any stringify`, () => {
    const p = new KimiExecPending(), shared = new ClaudeCache(), stage = new StagedCache(shared), value = association();
    stage.attachPending(p);
    if (operation === "commit") stage.put("kimiOrdered", "key", value);
    const before = p.byteSize, foreign = p.reserve(p.limit - before);
    const original = JSON.stringify; let calls = 0;
    JSON.stringify = ((v: unknown) => { calls++; return original(v); }) as typeof JSON.stringify;
    try {
      assert.throws(() => {
        if (operation === "retain") p.retain(value);
        else if (operation === "stage") stage.put("kimiOrdered", "key", value);
        else if (operation === "stage-batch") stage.putBatch([{ kind: "kimiOrdered", id: "key", value }]);
        else if (operation === "shared") shared.put("kimiOrdered", "key", value, p);
        else if (operation === "shared-batch") shared.putBatch([{ kind: "kimiOrdered", id: "key", value }], p);
        else stage.commit();
      }, budget);
    } finally { JSON.stringify = original; }
    assert.equal(calls, 0); assert.equal(shared.size, 0); assert.equal(p.byteSize, p.limit);
    foreign.release(); assert.equal(p.byteSize, before); stage.dispose(); assert.equal(p.byteSize, 0);
  });

test("KRS3 zero-byte staging does not enter serialization", () => {
  const p = new KimiExecPending(), stage = new StagedCache(new ClaudeCache()), value = association();
  Object.defineProperty(p, "limit", { value: 0 }); stage.attachPending(p);
  const original = JSON.stringify; let calls = 0;
  JSON.stringify = ((v: unknown) => { calls++; return original(v); }) as typeof JSON.stringify;
  try { assert.throws(() => stage.put("kimiOrdered", "key", value), budget); }
  finally { JSON.stringify = original; stage.dispose(); }
  assert.equal(calls, 0); assert.equal(p.byteSize, 0);
});

test("KRS3 shared commit serialization has a separate lease and preserves its RoutingError", () => {
  const p = new KimiExecPending(), shared = new ClaudeCache(), stage = new StagedCache(shared), value = association();
  stage.attachPending(p); stage.put("kimiOrdered", "key", value);
  const putBatch = shared.putBatch.bind(shared);
  shared.putBatch = (writes, pending) => {
    assert.equal(pending, p); Object.defineProperty(p, "limit", { value: p.byteSize }); return putBatch(writes, pending);
  };
  const original = JSON.stringify; let calls = 0;
  JSON.stringify = ((v: unknown) => { calls++; return original(v); }) as typeof JSON.stringify;
  try { assert.throws(() => stage.commit(), budget); }
  finally { JSON.stringify = original; }
  assert.equal(calls, 0); assert.equal(shared.size, 0); assert.equal(stage.size, 1); stage.dispose(); assert.equal(p.byteSize, 0);
});

test("KRS3 successful serialization reserves temporary and retained entries separately", () => {
  const p = new KimiExecPending(), shared = new ClaudeCache(), stage = new StagedCache(shared), value = association();
  stage.attachPending(p); const size = p.measure(value), original = JSON.stringify; let calls = 0, baseline = 0;
  JSON.stringify = ((v: unknown) => {
    assert.equal(v, value); calls++; assert(p.byteSize >= baseline + 2 * size + 3); return original(v);
  }) as typeof JSON.stringify;
  try { stage.put("kimiOrdered", "key", value); baseline = p.byteSize; stage.commit(); }
  finally { JSON.stringify = original; stage.dispose(); }
  assert.equal(calls, 2); assert.equal(p.byteSize, 0); assert.equal(shared.get("kimiOrdered", "key"), value);
});

test("data-only byte counter matches JSON without allocating escaped strings or calling getters", () => {
  const alias = { x: '"\\\u0000🦊\ud800' };
  for (const value of [null, true, false, 0, -0, 1e100, NaN, [undefined, alias, alias], { absent: undefined, alias }, 'é\r\n\t'])
    assert.equal(jsonBytes(value, 4096), Buffer.byteLength(JSON.stringify(value)));
  assert.equal(jsonStringBytes("🦊", 0, 1), Buffer.byteLength(JSON.stringify("\ud83e")));
  let called = 0;
  assert.throws(() => jsonBytes({ get secret() { called++; return "x"; } }, 4096));
  assert.throws(() => jsonBytes(Object.defineProperty({}, "toJSON", { value: () => { called++; return "unmeasured"; } }), 4096));
  assert.equal(called, 0);
});

function bytesStream(chunks: Uint8Array[], effect: { pulls: number; cancels: number }) {
  let index = 0;
  return new ReadableStream<Uint8Array>({ pull(c) { effect.pulls++; if (index === chunks.length) c.close(); else c.enqueue(chunks[index++]!); },
    cancel() { effect.cancels++; } }, { highWaterMark: 0 });
}
for (const width of [1, 2, 3, 7, 65536]) test(`KRS1 pull framing preserves UTF8/CRLF/comments/multiline/EOF width${width}`, async () => {
  const raw = ': שלום🦊\r\n\r\nevent: message\r\ndata: first\r\ndata: é🦊\r\n\r\nevent: __subswitch_comment\ndata: {}\n\ndata: tail';
  const input = Buffer.from(raw), chunks: Buffer[] = [];
  for (let i = 0; i < input.length; i += width) chunks.push(input.subarray(i, i + width));
  const parser = Readable.from(chunks).pipe(createSseParser(4 * 1024 * 1024, true)), expected: SseEvent[] = [];
  for await (const event of parser) expected.push(event as SseEvent);
  const p = new KimiExecPending(), effect = { pulls: 0, cancels: 0 }, got: SseEvent[] = [];
  for await (const event of kimiOrderedTransport(bytesStream(chunks, effect), p, new AbortController().signal, () => {}, error => { throw error; })) got.push(event);
  assert.deepEqual(got, expected); assert(isParserComment(got[0]!)); assert(!isParserComment(got[2]!)); assert.equal(p.byteSize, 0);
});

test("KRS1 multiple records in one chunk stay parked without a record queue or another pull", async () => {
  const p = new KimiExecPending(), effect = { pulls: 0, cancels: 0 }, controller = new AbortController();
  const first = Buffer.from('data: first\n\ndata: second\n\n'), body = bytesStream([first, Buffer.from('data: later\n\n')], effect);
  const iterator = kimiOrderedTransport(body, p, controller.signal, () => {}, () => {});
  assert.deepEqual((await iterator.next()).value, { event: undefined, data: "first" }); assert.equal(effect.pulls, 1); assert(p.byteSize > 0);
  assert.deepEqual((await iterator.next()).value, { event: undefined, data: "second" }); assert.equal(effect.pulls, 1);
  await iterator.return(undefined); assert.equal(p.byteSize, 0); assert.equal(effect.cancels, 1);
});

for (const cancel of [false, true]) test(`KRS1 parser failure/abort releases every transport lease cancel${cancel}`, async () => {
  const p = new KimiExecPending(), controller = new AbortController(), cause = new Error("fabricated source"), effect = { pulls: 0, cancels: 0 };
  const body = cancel ? bytesStream([Buffer.from('data: one\n\ndata: two\n\n')], effect)
    : new ReadableStream<Uint8Array>({ pull() { throw cause; } }, { highWaterMark: 0 });
  let observed: unknown;
  const iterator = kimiOrderedTransport(body, p, controller.signal, () => {}, e => { observed = e; });
  if (cancel) { await iterator.next(); controller.abort(); }
  await assert.rejects(iterator.next(), cancel ? { name: "AbortError" } : cause);
  if (!cancel) assert.equal(observed, cause);
  assert.equal(p.byteSize, 0);
});
