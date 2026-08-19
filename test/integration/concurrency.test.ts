/**
 * Byte-based admission gate integration tests.
 *
 * The gate was replaced from count-based rejection (→ 503) to byte-budget admission
 * with queueing (→ 529 only on queue exhaustion). Tests verify:
 *
 *   (a) Requests are admitted while under budget
 *   (b) A request that would exceed the budget WAITS then succeeds (core assertion)
 *   (c) A single oversized request does not deadlock (single-request progress)
 *   (d) Client disconnect while queued releases correctly, no reservation leak
 *   (e) inFlightBytes returns to zero when idle (no counter leak)
 *   (f) Queue-bound exhaustion returns 529 + overloaded_error (not 503)
 *   (g) Health endpoint is never subject to the gate
 *   (h) FIFO is preserved — later arrivals cannot barge past queued requests (anti-starvation)
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { startSubswitch } from "./fake-upstreams.js";

const cleanups: (() => Promise<void>)[] = [];
after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

// ---------------------------------------------------------------------------
// Shared upstream that parks a single request and lets the test release it.
// Also records the URL of the parked request so tests can assert request identity.
// ---------------------------------------------------------------------------

interface ParkingUpstream {
  readonly url: string;
  /** If a request is parked, holds its ServerResponse so the test can release it. */
  parkedRes: ServerResponse | null;
  /** URL path+query of the currently parked request — allows identity assertions. */
  parkedUrl: string | null;
  /** Release the parked request with a 200 { ok: true } response. */
  release(): void;
  close(): Promise<void>;
}

const startParkingUpstream = async (): Promise<ParkingUpstream> => {
  const state: { parkedRes: ServerResponse | null; parkedUrl: string | null } = {
    parkedRes: null,
    parkedUrl: null,
  };
  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      state.parkedRes = res;
      state.parkedUrl = req.url ?? null;
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    get parkedRes() { return state.parkedRes; },
    set parkedRes(v) { state.parkedRes = v; },
    get parkedUrl() { return state.parkedUrl; },
    set parkedUrl(v) { state.parkedUrl = v; },
    release() {
      if (state.parkedRes) {
        state.parkedRes.writeHead(200, { "content-type": "application/json" });
        state.parkedRes.end(JSON.stringify({ ok: true }));
        state.parkedRes = null;
        state.parkedUrl = null;
      }
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};

// ---------------------------------------------------------------------------
// Helper: poll until condition is true or deadline passes.
// ---------------------------------------------------------------------------
const pollUntil = async (condition: () => boolean, timeoutMs: number, intervalMs = 5): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise<void>((r) => setTimeout(r, intervalMs));
  }
  return condition();
};

// ---------------------------------------------------------------------------
// (a) Byte-based admission: requests are admitted while under budget.
// ---------------------------------------------------------------------------

describe("byte-based admission gate — admitted under budget (P0-2a)", () => {
  it("requests with total bytes under maxInFlightBytes are admitted without error", async () => {
    const parked = await startParkingUpstream();
    cleanups.push(parked.close);

    // Very small budget (128 bytes) but each GET request reserves 0 bytes
    // (non-buffered path) — so they are always admitted.
    const subswitch = await startSubswitch({
      anthropic: { baseUrl: parked.url },
      limits: { maxInFlightBytes: 128 },
    });
    cleanups.push(subswitch.close);

    // Fire two concurrent GETs — neither buffers a body, so neither takes budget.
    const controller1 = new AbortController();
    const req1 = fetch(`${subswitch.url}/v1/probe-1`, { method: "GET", signal: controller1.signal });

    await pollUntil(() => parked.parkedRes !== null, 2000);
    assert.ok(parked.parkedRes !== null, "first request must reach upstream");

    // Second request — should also be admitted (GETs take 0 bytes).
    parked.parkedRes = null;
    // (parkedUrl is updated automatically when the next request parks)
    const controller2 = new AbortController();
    const req2 = fetch(`${subswitch.url}/v1/probe-2`, { method: "GET", signal: controller2.signal });

    const admitted = await pollUntil(() => parked.parkedRes !== null, 2000);
    assert.ok(admitted, "second request must also reach upstream — both GETs take 0 bytes");

    controller1.abort();
    controller2.abort();
    try { await req1; } catch { /* AbortError */ }
    try { await req2; } catch { /* AbortError */ }
  });
});

// ---------------------------------------------------------------------------
// (b) Queueing: a request that would exceed the budget WAITS then succeeds.
//
// This is the core assertion of the whole change. The old gate would have
// returned 503 immediately; the new gate must queue and then serve the request.
//
// Non-vacuity verification: with queueing disabled (huge maxInFlightBytes both
// requests are immediately admitted without ever entering the queue — a test
// that passes in that world is vacuous.  These tests are non-vacuous because:
//   b1: asserts res2.status === 200 and { ok: true } body — a 504 or queued-forever
//       failure would not satisfy this.  With queueing disabled req2 is admitted
//       immediately and parks in upstream before parked.release() is called for
//       req1, so parked.parkedRes would already be non-null after req1 parks and
//       the test would fail at the "req2 must queue" assertion.
//   b2: explicitly asserts parked.parkedRes === null BEFORE controller1.abort(),
//       which fails when queueing is disabled (req2 is immediately admitted).
// ---------------------------------------------------------------------------

describe("byte-based admission gate — queueing not rejection (P0-2b)", () => {
  it("a POST request queued due to budget pressure succeeds with 200 once the slot opens", async () => {
    const parked = await startParkingUpstream();
    cleanups.push(parked.close);

    // Budget: 10 bytes exactly.
    // req1 (content-length: 10) fills the budget.
    // req2 (content-length: 10) would exceed it (10 + 10 > 10) → must queue.
    // Completing req1 frees the slot → drainQueue admits req2 → req2 gets a real 200.
    const BUDGET = 10;
    const subswitch = await startSubswitch({
      anthropic: { baseUrl: parked.url },
      limits: { maxInFlightBytes: BUDGET, maxQueueWaitMs: 10_000 },
    });
    cleanups.push(subswitch.close);

    const body = Buffer.alloc(BUDGET, "x");

    // Step 1: fire req1 — fills the budget exactly.
    const req1Promise = fetch(`${subswitch.url}/v1/messages?id=b1-req1`, {
      method: "POST",
      headers: { "content-length": String(body.length) },
      body: Buffer.from(body),
    });
    const req1Parked = await pollUntil(() => parked.parkedRes !== null, 2000);
    assert.ok(req1Parked, "req1 must park in upstream — it fills the budget");
    assert.ok(parked.parkedUrl?.includes("b1-req1"), `upstream must hold req1, got url: ${parked.parkedUrl}`);

    // Save req1's response before resetting the parking slot, so we can complete it later.
    // Resetting parked.parkedRes to null lets us detect whether req2 parks (i.e., jumps the queue).
    const req1Res = parked.parkedRes!;
    parked.parkedRes = null;

    // Step 2: fire req2 — budget is full so it must queue, not be immediately admitted.
    const req2Promise = fetch(`${subswitch.url}/v1/messages?id=b1-req2`, {
      method: "POST",
      headers: { "content-length": String(body.length) },
      body: Buffer.from(body),
    });

    // Give req2 30 ms to reach the gate and enter the queue.
    await new Promise<void>((r) => setTimeout(r, 30));

    // Positive assertion: req2 must NOT have reached upstream yet (it must be queued).
    // With queueing disabled (huge budget) req2 would park immediately and this fails.
    assert.equal(parked.parkedRes, null, "req2 must still be queued — budget is full");

    // Step 3: complete req1 by sending its response — this releases the slot.
    // drainQueue runs and admits req2.
    req1Res.writeHead(200, { "content-type": "application/json" });
    req1Res.end(JSON.stringify({ ok: true }));
    await req1Promise;

    // Step 4: req2 must now be admitted and park in the upstream.
    const req2Reached = await pollUntil(() => parked.parkedRes !== null, 3000);
    assert.ok(req2Reached, "req2 must reach upstream after req1 releases the slot");
    assert.ok(parked.parkedUrl?.includes("b1-req2"), `upstream must now hold req2, got url: ${parked.parkedUrl}`);

    // Step 5: complete req2 — it must receive the upstream's real 200 response.
    parked.release();
    const res2 = await req2Promise;
    assert.equal(res2.status, 200, "queued request must succeed with 200 from upstream (not a relay-invented error)");
    const responseBody = (await res2.json()) as { ok: boolean };
    assert.equal(responseBody.ok, true, "upstream response body must be forwarded byte-identical");
  });

  it("a queued POST is admitted and reaches upstream after the blocking request completes", async () => {
    const parked = await startParkingUpstream();
    cleanups.push(parked.close);

    // Budget: 10 bytes. A single 10-byte POST fills it exactly.
    // The next 10-byte POST must queue and be admitted after the first completes.
    const BUDGET = 10;
    const subswitch = await startSubswitch({
      anthropic: { baseUrl: parked.url },
      limits: { maxInFlightBytes: BUDGET, maxQueueWaitMs: 10_000 },
    });
    cleanups.push(subswitch.close);

    const body = Buffer.alloc(BUDGET, "x");

    // Step 1: fill the budget with req1.
    const controller1 = new AbortController();
    void fetch(`${subswitch.url}/v1/messages?id=b2-req1`, {
      method: "POST",
      headers: { "content-length": String(body.length) },
      body: Buffer.from(body),
      signal: controller1.signal,
    }).catch(() => { /* aborted */ });

    // Poll until req1 holds the budget (parked in upstream).
    const req1Parked = await pollUntil(() => parked.parkedRes !== null, 2000);
    assert.ok(req1Parked, "first request must park in upstream — it fills the budget");
    assert.ok(parked.parkedUrl?.includes("b2-req1"), `upstream must hold req1, got url: ${parked.parkedUrl}`);

    // Step 2: fire req2 (will queue since budget is full) and wait for it to queue.
    parked.parkedRes = null;
    // (parkedUrl is updated automatically when the next request parks)
    const req2Promise = fetch(`${subswitch.url}/v1/messages?id=b2-req2`, {
      method: "POST",
      headers: { "content-length": String(body.length) },
      body: Buffer.from(body),
    });

    // Give req2 time to reach the gate and be queued.
    await new Promise<void>((r) => setTimeout(r, 50));

    // Key non-vacuity assertion: req2 must still be queued at this point.
    // With queueing disabled (huge budget) req2 would be admitted immediately and
    // parked.parkedRes would be non-null here — proving this assertion is load-bearing.
    assert.equal(parked.parkedRes, null, "req2 must still be queued — budget is full");

    // Step 3: release req1 by aborting the client.
    // The proxy sees the client disconnect, fires "close"/"finish", releases the budget,
    // and drains the queue — admitting req2.
    controller1.abort();

    // Step 4: poll for req2 to reach the upstream.
    const req2Reached = await pollUntil(() => parked.parkedRes !== null, 3000);
    assert.ok(req2Reached, "second request must reach upstream after first is aborted (queued, not permanently rejected)");
    assert.ok(parked.parkedUrl?.includes("b2-req2"), `upstream must now hold req2, got url: ${parked.parkedUrl}`);

    // Clean up.
    parked.release();
    try { await req2Promise; } catch { /* expected */ }
  });
});

// ---------------------------------------------------------------------------
// (c) Single oversized request does not deadlock.
//
// A request larger than the entire budget must still be admitted when the
// server is otherwise idle (single-request progress guarantee). It will be
// caught by maxBodyBytes if genuinely oversized.
// ---------------------------------------------------------------------------

describe("byte-based admission gate — single oversized request admitted (P0-2c)", () => {
  it("a request larger than maxInFlightBytes is admitted when server is idle", async () => {
    const parked = await startParkingUpstream();
    cleanups.push(parked.close);

    // Budget: 1 byte. Request sends content-length: 10.
    // 10 > 1 but server is idle (inFlightBytes === 0) → must be admitted.
    const subswitch = await startSubswitch({
      anthropic: { baseUrl: parked.url },
      limits: { maxInFlightBytes: 1, maxQueueWaitMs: 5_000 },
    });
    cleanups.push(subswitch.close);

    const body = Buffer.alloc(10, "x");
    const controller = new AbortController();
    void fetch(`${subswitch.url}/v1/messages`, {
      method: "POST",
      headers: { "content-length": String(body.length) },
      body,
      signal: controller.signal,
    }).catch(() => { /* AbortError expected at cleanup */ });

    // The request must reach upstream (not deadlock in the queue forever).
    const reached = await pollUntil(() => parked.parkedRes !== null, 3000);
    assert.ok(reached, "oversized request must still be admitted when server is idle (single-request progress)");

    controller.abort();
  });
});

// ---------------------------------------------------------------------------
// (d) Client disconnect while queued releases correctly and does not leak.
// ---------------------------------------------------------------------------

describe("byte-based admission gate — disconnect while queued (P0-2d)", () => {
  it("a client that disconnects while queued is removed from the queue without leaking the reservation", async () => {
    const parked = await startParkingUpstream();
    cleanups.push(parked.close);

    const BUDGET = 10;
    const subswitch = await startSubswitch({
      anthropic: { baseUrl: parked.url },
      limits: { maxInFlightBytes: BUDGET, maxQueueWaitMs: 10_000 },
    });
    cleanups.push(subswitch.close);

    const body = Buffer.alloc(BUDGET, "x");

    // Step 1: fill the budget with req1.
    const controller1 = new AbortController();
    void fetch(`${subswitch.url}/v1/messages?id=d-req1`, {
      method: "POST",
      headers: { "content-length": String(body.length) },
      body: Buffer.from(body),
      signal: controller1.signal,
    }).catch(() => { /* AbortError expected at cleanup */ });
    const req1Parked = await pollUntil(() => parked.parkedRes !== null, 2000);
    assert.ok(req1Parked, "req1 must park");
    assert.ok(parked.parkedUrl?.includes("d-req1"), `upstream must hold req1, got url: ${parked.parkedUrl}`);

    // Step 2: queue req2 (budget full, it must wait).
    const controller2 = new AbortController();
    void fetch(`${subswitch.url}/v1/messages?id=d-req2`, {
      method: "POST",
      headers: { "content-length": String(body.length) },
      body: Buffer.from(body),
      signal: controller2.signal,
    }).catch(() => { /* aborted */ });

    // Give req2 time to enter the queue (it must be queued, not admitted).
    await new Promise<void>((r) => setTimeout(r, 30));

    // Step 3: disconnect req2 while it is queued.
    controller2.abort();
    await new Promise<void>((r) => setTimeout(r, 30));

    // Step 4: release req1 (free the budget).
    // Note: parked.release() already resets parkedRes to null internally —
    // do NOT reset it first or release() will find nothing to send.
    parked.release();

    // Step 5: fire req3 — should be admitted immediately (queue is clear from step 3,
    // budget freed from step 4). If req2's disconnection leaked the reservation,
    // req3 would queue forever instead of reaching upstream.
    const controller3 = new AbortController();
    void fetch(`${subswitch.url}/v1/messages?id=d-req3`, {
      method: "POST",
      headers: { "content-length": String(body.length) },
      body: Buffer.from(body),
      signal: controller3.signal,
    }).catch(() => { /* AbortError expected at cleanup */ });

    const req3Admitted = await pollUntil(() => parked.parkedRes !== null, 3000);
    assert.ok(req3Admitted, "req3 must be admitted after req2 disconnect + req1 release (no reservation leak)");
    // Identity assertion: must be req3 (not a leaked/zombie req2) that reached upstream.
    assert.ok(parked.parkedUrl?.includes("d-req3"), `upstream must hold req3, got url: ${parked.parkedUrl}`);

    controller1.abort();
    controller3.abort();
  });
});

// ---------------------------------------------------------------------------
// (e) inFlightBytes returns to zero when idle.
//
// Verified by checking that a request after a full request cycle is admitted
// immediately (not queued due to a leaked byte count).
// ---------------------------------------------------------------------------

describe("byte-based admission gate — counter returns to zero when idle (P0-2e)", () => {
  it("inFlightBytes is zero after all requests complete, so the next request is admitted", async () => {
    const parked = await startParkingUpstream();
    cleanups.push(parked.close);

    const BUDGET = 10;
    const subswitch = await startSubswitch({
      anthropic: { baseUrl: parked.url },
      limits: { maxInFlightBytes: BUDGET, maxQueueWaitMs: 5_000 },
    });
    cleanups.push(subswitch.close);

    const body = Buffer.alloc(BUDGET, "x");

    // Cycle 1: fill the budget, then abort the client (closes socket → releases slot).
    const controller1 = new AbortController();
    const req1 = fetch(`${subswitch.url}/v1/messages?id=e-cycle1`, {
      method: "POST",
      headers: { "content-length": String(body.length) },
      body: Buffer.from(body),
      signal: controller1.signal,
    }).catch(() => { /* AbortError expected */ });

    const cycle1Parked = await pollUntil(() => parked.parkedRes !== null, 2000);
    assert.ok(cycle1Parked, "cycle 1 must park in upstream");
    assert.ok(parked.parkedUrl?.includes("e-cycle1"), `upstream must hold cycle1, got url: ${parked.parkedUrl}`);

    // Abort releases the client socket → proxy's res.close fires → budget decremented.
    parked.parkedRes = null;
    // (parkedUrl is updated automatically when the next request parks)
    controller1.abort();
    await req1;

    // Give the close event time to propagate and decrement inFlightBytes.
    await new Promise<void>((r) => setTimeout(r, 50));

    // Cycle 2: budget must be 0 so this request is admitted immediately.
    const controller2 = new AbortController();
    const req2 = fetch(`${subswitch.url}/v1/messages?id=e-cycle2`, {
      method: "POST",
      headers: { "content-length": String(body.length) },
      body: Buffer.from(body),
      signal: controller2.signal,
    }).catch(() => { /* AbortError expected */ });

    const cycle2Admitted = await pollUntil(() => parked.parkedRes !== null, 2000);
    assert.ok(cycle2Admitted, "cycle 2 must reach upstream — counter must have returned to 0 after cycle 1");
    // Identity: must be cycle2, not a stale cycle1 entry.
    assert.ok(parked.parkedUrl?.includes("e-cycle2"), `upstream must hold cycle2, got url: ${parked.parkedUrl}`);

    controller2.abort();
    await req2;
  });
});

// ---------------------------------------------------------------------------
// (f) Queue-bound exhaustion returns 529 + overloaded_error.
// ---------------------------------------------------------------------------

describe("byte-based admission gate — queue-bound exhaustion returns 529 (P0-2f)", () => {
  it("returns HTTP 529 overloaded_error when the queue depth is exhausted", async () => {
    const parked = await startParkingUpstream();
    cleanups.push(parked.close);

    // Budget: 10 bytes, queue depth: 1.
    // req1 fills the budget; req2 enters the single queue slot; req3 overflows.
    const BUDGET = 10;
    const subswitch = await startSubswitch({
      anthropic: { baseUrl: parked.url },
      limits: { maxInFlightBytes: BUDGET, maxQueueDepth: 1, maxQueueWaitMs: 10_000 },
    });
    cleanups.push(subswitch.close);

    const body = Buffer.alloc(BUDGET, "x");

    // req1: fills the budget.
    const controller1 = new AbortController();
    void fetch(`${subswitch.url}/v1/messages`, {
      method: "POST",
      headers: { "content-length": String(body.length) },
      body: Buffer.from(body),
      signal: controller1.signal,
    }).catch(() => { /* AbortError expected at cleanup */ });
    const req1Parked = await pollUntil(() => parked.parkedRes !== null, 2000);
    assert.ok(req1Parked, "req1 must park");

    // req2: enters the queue (the single available slot).
    const controller2 = new AbortController();
    void fetch(`${subswitch.url}/v1/messages`, {
      method: "POST",
      headers: { "content-length": String(body.length) },
      body: Buffer.from(body),
      signal: controller2.signal,
    }).catch(() => { /* aborted */ });

    // Give req2 time to enter the queue.
    await new Promise<void>((r) => setTimeout(r, 30));

    // req3: queue is full → must receive 529 overloaded_error immediately.
    const res3 = await fetch(`${subswitch.url}/v1/messages`, {
      method: "POST",
      headers: { "content-length": String(body.length) },
      body: Buffer.from(body),
    });
    assert.equal(res3.status, 529, "queue overflow must return 529, not 503");
    const body3 = (await res3.json()) as { type: string; error: { type: string; message: string } };
    assert.equal(body3.type, "error", "response type must be 'error'");
    assert.equal(body3.error.type, "overloaded_error", "error type must be 'overloaded_error'");
    assert.ok(body3.error.message.length > 0, "error message must be non-empty");

    controller1.abort();
    controller2.abort();
  });
});

// ---------------------------------------------------------------------------
// (g) Health endpoint is never gated.
//
// Non-vacuity / positive control: before checking health, we verify that a
// second non-health POST IS gated (queued, not admitted) while the first holds
// the budget. This proves the gate is engaged, not simply removed.
// ---------------------------------------------------------------------------

describe("byte-based admission gate — health never gated (P0-2g)", () => {
  it("/__subswitch/health returns 200 even when the byte budget is exhausted", async () => {
    const parked = await startParkingUpstream();
    cleanups.push(parked.close);

    // Minimal budget (1 byte) + 10-byte request fills it immediately.
    const subswitch = await startSubswitch({
      anthropic: { baseUrl: parked.url },
      limits: { maxInFlightBytes: 1, maxQueueWaitMs: 10_000 },
    });
    cleanups.push(subswitch.close);

    const body = Buffer.alloc(10, "x");

    // req1: admitted via single-request progress (server idle despite budget = 1 byte).
    const controller1 = new AbortController();
    void fetch(`${subswitch.url}/v1/messages`, {
      method: "POST",
      headers: { "content-length": String(body.length) },
      body,
      signal: controller1.signal,
    }).catch(() => { /* AbortError expected at cleanup */ });

    // Wait for req1 to be admitted and hold the budget.
    await pollUntil(() => parked.parkedRes !== null, 2000);
    assert.ok(parked.parkedRes !== null, "req1 must park in upstream (holding the byte budget)");

    // Positive control: a second non-health POST must be QUEUED (not admitted immediately).
    // This proves the gate is actually engaged — if the gate were disabled, req2 would
    // bypass and park in the upstream immediately.
    const controller2 = new AbortController();
    void fetch(`${subswitch.url}/v1/messages`, {
      method: "POST",
      headers: { "content-length": String(body.length) },
      body: Buffer.from(body),
      signal: controller2.signal,
    }).catch(() => { /* aborted */ });

    // Reset parkedRes so we can detect whether req2 sneaks through.
    parked.parkedRes = null;
    // (parkedUrl is updated automatically when the next request parks)

    // Give req2 time to reach the gate.
    await new Promise<void>((r) => setTimeout(r, 30));

    assert.equal(parked.parkedRes, null, "positive control: a second POST must be queued — gate is engaged");

    // Health must NEVER be gated — it is handled before the admission check.
    const healthRes = await fetch(`${subswitch.url}/__subswitch/health`);
    assert.equal(healthRes.status, 200, "health endpoint must return 200 even with budget exhausted");
    await healthRes.body?.cancel();

    controller1.abort();
    controller2.abort();
  });
});

// ---------------------------------------------------------------------------
// (h) FIFO — later arrivals cannot barge past queued requests.
//
// Scenario: A fills the budget, B queues (cannot fit), then five small C
// requests arrive.  The Cs must not barge past the waiting B.
// After releasing A, B must be admitted next (FIFO), then the Cs.
//
// Non-vacuity: with the FIFO guard removed (old code: no queue.length === 0
// check), each C would be immediately admitted (fits the freed slot), so B
// would starve and eventually time out with 529.  The test asserts B's URL
// is the FIRST arrival after A is released, which fails without the fix.
// ---------------------------------------------------------------------------

describe("byte-based admission gate — FIFO: no barging past queued requests (P0-2h)", () => {
  it("a large queued request is admitted before later-arriving small ones", async () => {
    // Record all arrivals in order so we can assert B arrived before the Cs.
    const arrivals: string[] = [];
    const parkedList: ServerResponse[] = [];

    const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = req.url ?? "";
      req.on("data", () => {});
      req.on("end", () => {
        arrivals.push(url);
        parkedList.push(res);
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const upstreamUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const BUDGET = 60;
    const subswitch = await startSubswitch({
      anthropic: { baseUrl: upstreamUrl },
      limits: { maxInFlightBytes: BUDGET, maxQueueWaitMs: 10_000 },
    });
    cleanups.push(subswitch.close);
    cleanups.push(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));

    const post = (id: string, n: number): AbortController => {
      const c = new AbortController();
      const b = Buffer.alloc(n, "x");
      void fetch(`${subswitch.url}/v1/messages?id=${id}`, {
        method: "POST",
        headers: { "content-length": String(n) },
        body: b,
        signal: c.signal,
      }).catch(() => {});
      return c;
    };
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    // A fills the budget (60 bytes).
    const cA = post("A", BUDGET);
    // Wait for A to park.
    await pollUntil(() => arrivals.length >= 1, 2000);
    assert.equal(arrivals[0], "/v1/messages?id=A", "A must be first arrival");

    // B queues (60 + 60 > 60 — cannot fit while A holds the slot).
    const cB = post("B", BUDGET);
    await sleep(80); // B must be in the queue

    // Five Cs arrive — each is 1 byte. They MUST NOT barge past B.
    const cCs: AbortController[] = [];
    for (let i = 0; i < 5; i++) {
      cCs.push(post(`C${i}`, 1));
      await sleep(20);
    }
    await sleep(100); // let any barging attempts settle

    // With the FIFO guard, Cs cannot be admitted while B is queued.
    assert.equal(arrivals.length, 1, `only A should have arrived at upstream; got ${JSON.stringify(arrivals)}`);

    // Release A — drainQueue runs. B must be admitted first (FIFO).
    // Release all parked responses first so connection slots are freed.
    for (const r of parkedList) { r.writeHead(200); r.end("{}"); }
    parkedList.length = 0;

    // Wait for B to arrive.
    await pollUntil(() => arrivals.length >= 2, 3000);
    assert.equal(arrivals[1], "/v1/messages?id=B", `B must be admitted before any C; arrivals: ${JSON.stringify(arrivals)}`);

    // Clean up.
    cA.abort();
    cB.abort();
    cCs.forEach((c) => c.abort());
    for (const r of parkedList) { try { r.writeHead(200); r.end("{}"); } catch {} }
  });
});
