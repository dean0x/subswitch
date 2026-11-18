/** Fake time and in-memory Claude Messages SSE. No live inference or credentials. */
import assert from "node:assert/strict";
import { it } from "node:test";
import { setImmediate } from "node:timers/promises";
import { loadConfig } from "../../src/config.js";
import { noopLogger } from "../../src/logger.js";
import type { RoutingClock } from "../../src/routing/clock.js";
import { RoutingError, type Item } from "../../src/routing/routing-types.js";
import { SharedRouting } from "../../src/routing/shared-routing.js";
import { messageFrames, nativeEvents } from "../fixtures/native-messages.js";
import { nativeCredential } from "../fixtures/native-profile.js";

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

function timedRoute(fetchImpl: typeof fetch, stream: boolean) {
  const clock = new FakeClock();
  const loaded = loadConfig({ configPath: "/fabricated/config.json", env: {}, readFile: () => JSON.stringify({
    configVersion: 2,
    accessProfiles: { native: {
      provider: "claude", product: "claude-code", billing: "subscription", account: "synthetic",
      credential: nativeCredential("claude", "route-timeout"),
    } },
    routes: { work: { clients: ["claude-code"], primary: { profile: "native", model: "claude-sonnet-5", effort: "high" } } },
  }) });
  if (!loaded.ok) assert.fail(loaded.error.message);
  let dispatch!: () => void;
  const dispatched = new Promise<true>(resolve => { dispatch = () => resolve(true); });
  const router = new SharedRouting(loaded.value.config, noopLogger, clock, (...args) => {
    dispatch();
    return fetchImpl(...args);
  });
  const body = { model: "work", max_tokens: 128, stream, messages: [{ role: "user", content: "synthetic" }] };
  const seen: Item[] = [];
  let finished = false;
  const consumed = (async () => {
    try {
      for await (const event of router.events(body, "claude-code", "work", new AbortController().signal)) seen.push(event);
    } catch (error) { return error; }
    finally { finished = true; }
    return undefined;
  })();
  return { clock, seen, consumed, dispatched: Promise.race([dispatched, consumed]),
    get finished() { return finished; }, async close() { router.close(); await consumed; } };
}

async function timedStream(stream: boolean) {
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(controller) { source = controller; } });
  const route = timedRoute(async () => new Response(body, { headers: { "content-type": "text/event-stream" } }), stream);
  const [first, ...rest] = messageFrames(nativeEvents([{ type: "text", text: "Synthetic response" }]));
  assert(first);
  const send = (frame: string) => source.enqueue(Buffer.from(frame));
  try {
    assert.equal(await route.dispatched, true);
    send(first);
    await setImmediate();
  } catch (error) {
    await route.close();
    throw error;
  }
  return { route, keepalive: () => send(": alive\n\n"),
    finish() { for (const frame of rest) send(frame); source.close(); } };
}

const timeout = (code: string) => (error: unknown) =>
  error instanceof RoutingError && error.code === code && error.status === 504;

it("bounds the wait for Claude headers by the shared ten minute deadline", async () => {
  const route = timedRoute(() => new Promise<Response>(() => {}), true);
  try {
    assert.equal(await route.dispatched, true);
    route.clock.advance(599_999);
    await setImmediate();
    assert.equal(route.finished, false);
    route.clock.advance(1);
    await setImmediate();
    assert.equal(route.finished, true, "the total bound must end the wait for headers");
    assert(timeout("request_timeout")(await route.consumed));
    assert.equal(route.clock.size, 0);
  } finally { await route.close(); }
});

it("accepts a healthy Claude stream beyond thirty seconds", async () => {
  const { route, keepalive, finish } = await timedStream(true);
  try {
    assert.equal(route.seen[0]?.["type"], "message_start");
    for (let index = 0; index < 2; index++) {
      route.clock.advance(20_000);
      await setImmediate();
      assert.equal(route.finished, false, "healthy data must survive the old total cap");
      keepalive();
      await setImmediate();
    }
    finish();
    assert.equal(await route.consumed, undefined, "healthy data must survive the old total cap");
    assert.equal(route.seen.at(-1)?.["type"], "message_stop");
    assert.equal(route.clock.size, 0, "publication must clear all routing timers");
  } finally { await route.close(); }
});

it("fails an idle Claude stream at the shared five minute bound with 504", async () => {
  const { route } = await timedStream(false);
  try {
    route.clock.advance(299_999);
    await setImmediate();
    assert.equal(route.seen.length, 0, "non-stream delivery must withhold partial output");
    assert.equal(route.finished, false, "the idle bound must not fire early");
    route.clock.advance(1);
    await setImmediate();
    assert.equal(route.finished, true, "the idle bound must end the read");
    assert(timeout("provider_stream_timeout_or_cancelled")(await route.consumed));
    assert.equal(route.clock.size, 0, "timeout must clear both idle and total timers");
  } finally { await route.close(); }
});

it("fails an active Claude stream at the shared ten minute total bound with 504", async () => {
  const { route, keepalive } = await timedStream(false);
  try {
    for (let index = 0; index < 5; index++) {
      route.clock.advance(100_000);
      await setImmediate();
      assert.equal(route.finished, false, "active data must survive until the total bound");
      keepalive();
      await setImmediate();
    }
    route.clock.advance(99_999);
    keepalive();
    await setImmediate();
    assert.equal(route.finished, false);
    route.clock.advance(1);
    await setImmediate();
    assert.equal(route.finished, true, "the total bound must end an active read");
    assert(timeout("request_timeout")(await route.consumed));
    assert.equal(route.seen.length, 0);
    assert.equal(route.clock.size, 0);
  } finally { await route.close(); }
});
