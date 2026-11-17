/** Fake time and in-memory SSE. No live inference, quota, or credentials. */
import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import type { RoutingClock } from "../../src/routing/clock.js";
import { noopLogger } from "../../src/logger.js";
import { RoutedAttempts } from "../../src/routing/routed-attempt.js";
import { RoutingError, type ClientEvent } from "../../src/routing/routing-types.js";
import { fixture, ordered, output, profile, target, wire } from "../helpers/kimi-ordered-route.js";

class FakeClock implements RoutingClock {
  private elapsed = 0;
  private next = 0;
  private timers = new Map<number, { at: number; callback: () => void }>();
  now = () => this.elapsed;
  monotonic = () => this.elapsed;
  random = () => 0.5;
  schedule = (callback: () => void, delay: number) => {
    const id = this.next++;
    this.timers.set(id, { at: this.elapsed + delay, callback });
    return () => { this.timers.delete(id); };
  };
  advance(ms: number) {
    this.elapsed += ms;
    const due = [...this.timers].filter(([, timer]) => timer.at <= this.elapsed)
      .sort(([, left], [, right]) => left.at - right.at);
    for (const [id, timer] of due) if (this.timers.delete(id)) timer.callback();
  }
  get size() { return this.timers.size; }
}

async function timedAttempt(t: TestContext) {
  const clock = new FakeClock();
  // Node's native timeout signal uses internal timers. Put the old cap on the same fake clock.
  t.mock.method(AbortSignal, "timeout", (ms: number) => {
    const controller = new AbortController();
    clock.schedule(() => controller.abort(new DOMException("Timeout", "TimeoutError")), ms);
    return controller.signal;
  });
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { source = controller; } });
  const f = fixture({ clock, reply: () => new Response(stream, { headers: { "content-type": "text/event-stream" } }) });
  assert(f.context);
  const ready = await f.attempts.prepare({ profile, target, body: ordered(), protocol: "messages", route: "work",
    action: f.context, conversation: "synthetic-thread", signal: f.controller.signal, refreshes: new Set() });
  const seen: ClientEvent[] = [];
  let finished = false;
  const consumed = (async () => {
    try { for await (const event of ready.events) seen.push(event); }
    catch (error) { return error; }
    finally { finished = true; }
    return undefined;
  })();
  const records = wire(output()).split("\n\n").filter(Boolean).map(record => record + "\n\n");
  const send = (chunk: string) => source.enqueue(Buffer.from(chunk));
  send(records[0]!);
  await setImmediate();
  return { clock, ready, seen, consumed, records, send, source, get finished() { return finished; },
    async close() { await ready.cancel(); f.router.close(); } };
}

it("bounds the Kimi header phase and clears its timers on failure", async () => {
  const clock = new FakeClock(), f = fixture({ clock });
  const attempts = new RoutedAttempts(f.auth, noopLogger, async () => new Promise<Response>(() => {}), clock);
  let finished = false;
  const pending = attempts.prepare({ profile, target, body: { model: "work", input: "synthetic" },
    protocol: "responses", conversation: "synthetic", signal: f.controller.signal, refreshes: new Set() })
    .then(() => { finished = true; return undefined; }, (error: unknown) => { finished = true; return error; });
  try {
    await setImmediate();
    clock.advance(299_999);
    await setImmediate();
    assert.equal(finished, false);
    clock.advance(1);
    await setImmediate();
    assert.equal(finished, true, "headers must not wait for the total bound");
    const error: unknown = await pending;
    assert(error instanceof RoutingError && error.code === "request_timeout" && error.status === 504);
    assert.equal(clock.size, 0);
  } finally { f.controller.abort(); await pending; f.router.close(); }
});

const streamTimeout = (error: unknown) => error instanceof RoutingError &&
  error.code === "provider_stream_timeout_or_cancelled" && error.status === 504;

it("accepts a healthy ordered Kimi stream beyond thirty seconds", async t => {
  const f = await timedAttempt(t);
  try {
    for (let index = 0; index < 2; index++) {
      f.clock.advance(20_000);
      await setImmediate();
      assert.equal(f.finished, false, "healthy data must survive the old total cap");
      f.send(": alive\n\n");
      await setImmediate();
    }
    for (const record of f.records.slice(1)) f.send(record);
    f.source.close();
    assert.equal(await f.consumed, undefined, "healthy data must survive the old total cap");
    assert.equal(f.seen.at(-1)?.payload["type"], "message_stop");
    f.ready.commit();
    assert.equal(f.clock.size, 0, "publication must clear all attempt timers");
  } finally { await f.close(); }
});

it("fails an idle Kimi stream at the shared five minute bound with 504", async t => {
  const f = await timedAttempt(t);
  try {
    f.clock.advance(299_999);
    await setImmediate();
    assert.equal(f.seen.length, 0, "the ordered codec must withhold partial output");
    assert.equal(f.finished, false, "the idle bound must not fire early");
    f.clock.advance(1);
    await setImmediate();
    assert.equal(f.finished, true, "the idle bound must end the read");
    assert(streamTimeout(await f.consumed));
    assert.equal(f.clock.size, 0, "timeout must clear both idle and total timers");
  } finally { await f.close(); }
});

it("fails an active Kimi stream at the shared ten minute total bound with 504", async t => {
  const f = await timedAttempt(t);
  try {
    for (let index = 0; index < 5; index++) {
      f.clock.advance(100_000);
      await setImmediate();
      assert.equal(f.finished, false, "active data must survive until the total bound");
      f.send(": alive\n\n");
      await setImmediate();
    }
    f.clock.advance(99_999);
    f.send(": alive\n\n");
    await setImmediate();
    assert.equal(f.finished, false);
    f.clock.advance(1);
    await setImmediate();
    assert.equal(f.finished, true, "the total bound must end an active read");
    assert(streamTimeout(await f.consumed));
    assert.equal(f.seen.length, 0);
    assert.equal(f.clock.size, 0);
  } finally { await f.close(); }
});
