/** Fabricated byte streams only. No fetch, files, listeners, auth or tools. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Readable } from "node:stream";
import { createSseParser, type SseEvent } from "../../src/codex-response.js";
import { kimiExecTransport } from "../../src/routing/kimi-exec-transport.js";
import { KimiExecPending } from "../../src/routing/kimi-exec-pending.js";
import { RoutingError } from "../../src/routing/routing-types.js";

function fixture(chunks: readonly Uint8Array[]) {
  let index = 0, pulls = 0, cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      if (index === chunks.length) controller.close();
      else controller.enqueue(chunks[index++]!);
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  return { body, stats: () => ({ pulls, cancelled }) };
}
async function original(chunks: readonly Uint8Array[]): Promise<SseEvent[]> {
  const parser = createSseParser(4 * 1024 * 1024, true), source = Readable.from(chunks);
  source.pipe(parser);
  const events: SseEvent[] = [];
  try { for await (const event of parser as AsyncIterable<SseEvent>) events.push(event); }
  finally { source.destroy(); parser.destroy(); }
  return events;
}
async function collect(chunks: readonly Uint8Array[], pending = new KimiExecPending()) {
  const input = fixture(chunks), sourceErrors: unknown[] = [], sizes: number[] = [], events: SseEvent[] = [];
  const controller = new AbortController();
  let error: unknown, byteReads = 0;
  try {
    for await (const event of kimiExecTransport(input.body, pending, controller.signal,
      () => { byteReads++; }, e => { sourceErrors.push(e); })) {
      events.push(event); sizes.push(pending.byteSize);
    }
  } catch (caught) { error = caught; }
  return { events, sizes, error, sourceErrors, pending, input, byteReads };
}

const corpus = [
  "", "\n", "\r\n\r\n", ":comment\r\n\r\nid: 3\nretry: 7\n\n",
  "event: old\nevent: current\ndata: one\ndata:  two\n\n",
  "event: named\r\ndata: {\"text\":\"😀é\\u0000\"}\r\n\r\n",
  "data:\n\ndata: unfinished tail", "data: a\n\r\ndata: b\r\n\ndata: c\r\n\r\n",
  "\ufeffevent: bom\ndata: preserved\n\n", "unknown: ignored\r\ndata: one\r\ndata: two",
];
for (const [i, wire] of corpus.entries()) test(`pull parser matches existing framing at every split, corpus${i}`, async () => {
  const bytes = Buffer.from(wire), expected = await original([bytes]);
  for (let split = 0; split <= bytes.length; split++) {
    const chunks = [bytes.subarray(0, split), bytes.subarray(split)], result = await collect(chunks);
    assert.equal(result.error, undefined, `split${split}`);
    assert.deepEqual(result.events, expected, `split${split}`);
    assert(result.sizes.every(n => n > 0), "parser-owned record remains reserved through yield");
    assert.equal(result.pending.byteSize, 0);
    assert.equal(result.input.body.locked, false);
    assert.deepEqual(result.sourceErrors, []);
  }
});

test("single-byte UTF8, escapes and CRLF fragments preserve full scalar values", async () => {
  const bytes = Buffer.from(corpus.join("")), chunks = [...bytes].map(byte => Uint8Array.of(byte));
  const result = await collect(chunks);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.events, await original([bytes]));
  assert.equal(result.byteReads, chunks.length);
  assert.equal(result.pending.byteSize, 0);
});
test("malformed and truncated UTF8 fail closed with no replacement repair", async () => {
  for (const bytes of [Buffer.from([0xc3, 0x28]), Buffer.from([0xf0, 0x9f]),
    Buffer.concat([Buffer.from("data: "), Buffer.from([0xed, 0xa0, 0x80]), Buffer.from("\n\n")])]) {
    const result = await collect([...bytes].map(b => Uint8Array.of(b)));
    assert(result.error instanceof RoutingError);
    assert.equal(result.error.code, "invalid_provider_utf8");
    assert.equal(result.events.length, 0);
    assert.equal(result.pending.byteSize, 0);
    assert.deepEqual(result.sourceErrors, [], "decoder rejection is not a transport failure");
  }
});
for (const framed of [false, true]) test(`byte frame limit refuses oversized${framed ? " delimited" : " EOF"} record`, async () => {
  const bytes = Buffer.from("data: " + "é".repeat(2 * 1024 * 1024) + (framed ? "\n\n" : ""));
  const result = await collect([bytes]);
  assert(result.error instanceof RoutingError);
  assert.equal(result.error.code, "sse_event_too_large");
  assert.equal(result.events.length, 0);
  assert.equal(result.pending.byteSize, 0);
});
test("whole received chunk shares existing pressure before parser retention or reset", async () => {
  const pending = new KimiExecPending(), external = pending.reserve(pending.limit - 64);
  const result = await collect([Buffer.from("data: " + "x".repeat(256) + "\n\n")], pending);
  assert(result.error instanceof RoutingError);
  assert.equal(result.error.code, "provider_state_too_large");
  assert.equal(result.events.length, 0);
  assert.equal(pending.byteSize, pending.limit - 64);
  assert.equal(result.input.body.locked, false);
  external.release();
  assert.equal(pending.byteSize, 0);
});
test("fixed parser state capacity failure never acquires a body reader", async () => {
  const pending = new KimiExecPending(), external = pending.reserve(pending.limit - 1);
  const result = await collect([Buffer.from("data: one\n\n")], pending);
  assert(result.error instanceof RoutingError);
  assert.equal(result.error.code, "provider_state_too_large");
  assert.equal(result.input.body.locked, false);
  assert.equal(result.input.stats().pulls, 0);
  assert.equal(pending.byteSize, pending.limit - 1);
  external.release();
});
test("parked single-record yield owns the rest of its chunk without prefetching another chunk", async () => {
  const pending = new KimiExecPending(), external = pending.reserve(73);
  const input = fixture([Buffer.from("data: first\n\ndata: second\n\ndata: third\n\n"), Buffer.from("data: fourth\n\n")]);
  const iterator = kimiExecTransport(input.body, pending, new AbortController().signal, () => {}, () => {});
  assert.deepEqual((await iterator.next()).value, { event: undefined, data: "first" });
  assert.equal(input.stats().pulls, 1);
  assert(pending.byteSize > 73);
  assert.deepEqual((await iterator.next()).value, { event: undefined, data: "second" });
  assert.equal(input.stats().pulls, 1);
  await iterator.return(undefined);
  assert.equal(input.stats().cancelled, true);
  assert.equal(input.body.locked, false);
  assert.equal(pending.byteSize, 73, "return releases own buffers, preserving another owner's allocation");
  external.release();
});
for (const settles of [true, false]) test(`parked buffered abort rejects without a second record, cancel${settles ? " settles" : " remains pending"}`, async () => {
  const pending = new KimiExecPending(), external = pending.reserve(73), controller = new AbortController();
  const reason = new Error("fabricated parked abort"), errors: unknown[] = [];
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(Buffer.from("data: first\n\ndata: second\n\n")); },
    cancel() { cancelled = true; if (!settles) return new Promise<void>(() => {}); },
  }, { highWaterMark: 0 });
  const iterator = kimiExecTransport(body, pending, controller.signal, () => {}, e => { errors.push(e); });
  try {
    assert.deepEqual((await iterator.next()).value, { event: undefined, data: "first" });
    assert(pending.byteSize > 73);
    controller.abort(reason);
    await assert.rejects(iterator.next(), e => e === reason);
    assert.equal(cancelled, true);
    assert.equal(body.locked, false);
    assert.equal(pending.byteSize, 73, "abort releases only the transport's retained state");
    assert.deepEqual(errors, [], "buffered cancellation is not a source read failure");
    assert.equal((await iterator.next()).done, true);
  } finally { await iterator.return(undefined); external.release(); }
});
test("abort while parked at EOF tail rejects instead of completing normally", async () => {
  const pending = new KimiExecPending(), external = pending.reserve(73), controller = new AbortController();
  const input = fixture([Buffer.from("data: unfinished tail")]), errors: unknown[] = [];
  const reason = new Error("fabricated EOF parked abort");
  const iterator = kimiExecTransport(input.body, pending, controller.signal, () => {}, e => { errors.push(e); });
  try {
    assert.deepEqual((await iterator.next()).value, { event: undefined, data: "unfinished tail" });
    assert.equal(input.stats().pulls, 2, "tail is published only after the reader observes EOF");
    assert(pending.byteSize > 73);
    controller.abort(reason);
    await assert.rejects(iterator.next(), e => e === reason);
    assert.equal(input.body.locked, false);
    assert.equal(pending.byteSize, 73);
    assert.deepEqual(errors, []);
    // A closed stream's reader.cancel() does not invoke the underlying cancel hook.
    assert.equal(input.stats().cancelled, false);
  } finally { await iterator.return(undefined); external.release(); }
});
test("abort after EOF read resolution prevents parsing or yielding the buffered tail", async () => {
  const pending = new KimiExecPending(), external = pending.reserve(73), controller = new AbortController();
  const reason = new Error("fabricated EOF boundary abort"), errors: unknown[] = [];
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (++pulls === 1) c.enqueue(Buffer.from("data: unfinished tail"));
      else {
        c.close();
        // Let abortable observe the resolved read, then abort before its caller resumes.
        queueMicrotask(() => queueMicrotask(() => controller.abort(reason)));
      }
    },
  }, { highWaterMark: 0 });
  const iterator = kimiExecTransport(body, pending, controller.signal, () => {}, e => { errors.push(e); });
  try {
    await assert.rejects(iterator.next(), e => e === reason);
    assert.equal(pulls, 2);
    assert.equal(body.locked, false);
    assert.equal(pending.byteSize, 73);
    assert.deepEqual(errors, [], "resolved EOF is not a source read rejection");
  } finally { await iterator.return(undefined); external.release(); }
});
test("iterator return releases owned state even when reader cancellation never settles", async () => {
  const pending = new KimiExecPending(), external = pending.reserve(73);
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(Buffer.from("data: one\n\n")); },
    cancel() { cancelled = true; return new Promise<void>(() => {}); },
  }, { highWaterMark: 0 });
  const iterator = kimiExecTransport(body, pending, new AbortController().signal, () => {}, () => {});
  try {
    assert.equal((await iterator.next()).value!.data, "one");
    await iterator.return(undefined);
    assert.equal(cancelled, true);
    assert.equal(body.locked, false);
    assert.equal(pending.byteSize, 73);
  } finally { await iterator.return(undefined); external.release(); }
});
test("abort during a pending read cancels and drops framing fragments without publication", async () => {
  let upstream!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ start(c) { upstream = c; }, cancel() { cancelled = true; } });
  const pending = new KimiExecPending(), controller = new AbortController(), errors: unknown[] = [];
  const iterator = kimiExecTransport(body, pending, controller.signal, () => {}, e => { errors.push(e); });
  upstream.enqueue(Buffer.from("data: partial"));
  const waiting = iterator.next();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert(pending.byteSize > 32);
  controller.abort();
  await assert.rejects(waiting);
  assert.equal(errors.length, 1);
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
  assert.equal(pending.byteSize, 0);
});
test("source read rejection is preserved separately from framing errors", async () => {
  const failure = new Error("fabricated transport failure"), failures: unknown[] = [], pending = new KimiExecPending();
  const body = new ReadableStream<Uint8Array>({ pull(c) { c.error(failure); } });
  const iterator = kimiExecTransport(body, pending, new AbortController().signal, () => {}, e => { failures.push(e); });
  await assert.rejects(iterator.next(), e => e === failure);
  assert.deepEqual(failures, [failure]);
  assert.equal(pending.byteSize, 0);
  assert.equal(body.locked, false);
});
