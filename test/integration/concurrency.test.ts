/**
 * Concurrency gate integration tests (P0-2).
 *
 * Three scenarios:
 *   (a) 503 + overloaded_error body when active requests exceed the limit
 *   (b) Health endpoint is never subject to the concurrency gate
 *   (c) Counter-leak detection: abort mid-flight, assert slot is released
 *
 * The mutation-verification note at the end of test (c) explains which line
 * deletion would make this test fail — it IS the mutation test.
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
// ---------------------------------------------------------------------------

interface ParkingUpstream {
  readonly url: string;
  /** If a request is parked, holds its ServerResponse so the test can release it. */
  parkedRes: ServerResponse | null;
  close(): Promise<void>;
}

const startParkingUpstream = async (): Promise<ParkingUpstream> => {
  const state: { parkedRes: ServerResponse | null } = { parkedRes: null };
  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      // Park the request: save the response handle but don't call res.end().
      state.parkedRes = res;
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    get parkedRes() { return state.parkedRes; },
    set parkedRes(v) { state.parkedRes = v; },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};

// ---------------------------------------------------------------------------
// (a) 503 + overloaded_error when over the limit
// ---------------------------------------------------------------------------

describe("concurrency gate — 503 overloaded_error (P0-2a)", () => {
  it("returns 503 overloaded_error when active requests exceed maxConcurrentRequests", async () => {
    const parked = await startParkingUpstream();
    cleanups.push(parked.close);

    // maxConcurrentRequests: 1 → first request passes, second is rejected.
    const subswitch = await startSubswitch({ anthropic: { baseUrl: parked.url }, limits: { maxConcurrentRequests: 1 } });
    cleanups.push(subswitch.close);

    // Fire request 1 without awaiting — it parks in the upstream.
    // GET /v1/anything hits forwardAnthropic directly (no body buffering, no auth).
    const controller1 = new AbortController();
    const req1Promise = fetch(`${subswitch.url}/v1/park-probe`, {
      method: "GET",
      signal: controller1.signal,
    });

    // Give request 1 time to reach the proxy and increment activeRequests.
    await new Promise<void>((r) => setTimeout(r, 30));

    // Request 2 — should get 503 because activeRequests (2) > maxConcurrentRequests (1).
    const res2 = await fetch(`${subswitch.url}/v1/another`, { method: "GET" });
    assert.equal(res2.status, 503, "second concurrent request must be rejected with 503");

    const body2 = (await res2.json()) as { type: string; error: { type: string; message: string } };
    assert.equal(body2.type, "error", "response type must be 'error'");
    assert.equal(body2.error.type, "overloaded_error", "error type must be 'overloaded_error'");
    assert.ok(body2.error.message.length > 0, "error message must be non-empty");

    // Clean up parked request.
    controller1.abort();
    try { await req1Promise; } catch { /* AbortError expected */ }
  });
});

// ---------------------------------------------------------------------------
// (b) Health endpoint is never gated
//
// The gate sits AFTER the /__subswitch/* early-return path, so health is
// handled before activeRequests is ever incremented.
//
// We verify this under real gate pressure: fill the single slot with a parked
// request (so the gate would reject a normal request with 503), then assert
// that health still returns 200.
// ---------------------------------------------------------------------------

describe("concurrency gate — health never gated (P0-2b)", () => {
  it("/__subswitch/health returns 200 even when the concurrency slot is fully occupied", async () => {
    const parked = await startParkingUpstream();
    cleanups.push(parked.close);

    // maxConcurrentRequests: 1 → the first non-health request fills the slot.
    const subswitch = await startSubswitch({ anthropic: { baseUrl: parked.url }, limits: { maxConcurrentRequests: 1 } });
    cleanups.push(subswitch.close);

    // Fill the slot: park a request in the upstream.
    const controller = new AbortController();
    const parkPromise = fetch(`${subswitch.url}/v1/park-probe`, {
      method: "GET",
      signal: controller.signal,
    });

    // Give the parked request time to reach the proxy and increment activeRequests.
    await new Promise<void>((r) => setTimeout(r, 30));

    // Verify the slot IS full: a normal request should be rejected.
    const normalRes = await fetch(`${subswitch.url}/v1/another-probe`, { method: "GET" });
    assert.equal(normalRes.status, 503, "non-health request must be rejected while slot is occupied");
    await normalRes.body?.cancel();

    // Health must NEVER be gated, even when all slots are full.
    const healthRes = await fetch(`${subswitch.url}/__subswitch/health`);
    assert.equal(healthRes.status, 200, "health endpoint must return 200 even with all slots occupied");
    await healthRes.body?.cancel();

    // Clean up the parked request.
    controller.abort();
    try { await parkPromise; } catch { /* AbortError expected */ }
  });
});

// ---------------------------------------------------------------------------
// (c) Counter-leak detection: abort → slot released → next request accepted
//
// Two problems with the old fixed-sleep approach:
//  1. The 30 ms precondition was not reliable: if request 1 had not reached
//     the proxy yet, request 2 (the 503 probe) would be admitted, park forever,
//     and hang the test with no default timeout.
//  2. The 80 ms Promise.race decided leak/no-leak via a timeout: a leaked-slot
//     503 arriving at 90 ms would register as timedOut: true and score as PASS.
//
// Fix: poll parkedRes instead of fixed sleeps.  A parked request exposes the
// upstream's ServerResponse setter — poll until non-null to know the slot is
// held, then decide on an OBSERVED outcome (parkedRes update = slot released;
// immediate 503 = slot leaked) rather than on a race timing out.
//
// MUTATION VERIFICATION: deleting `res.on("close", () => { activeRequests-- })`
// at src/server.ts (after the gate check) means the slot is never decremented.
// Request 3 immediately receives 503, this test goes RED.  With the decrement,
// request 3 parks in the upstream (parkedRes becomes non-null), test stays GREEN.
// ---------------------------------------------------------------------------

describe("concurrency gate — counter not leaked after abort (P0-2c)", () => {
  it("releases the concurrency slot when the client aborts mid-flight", async () => {
    const parked = await startParkingUpstream();
    cleanups.push(parked.close);

    const subswitch = await startSubswitch({ anthropic: { baseUrl: parked.url }, limits: { maxConcurrentRequests: 1 } });
    cleanups.push(subswitch.close);

    // Step 1: fire request 1 and poll until it has parked in the upstream.
    // Polling parkedRes is the reliable signal that the slot is held —
    // no fixed sleep that might fire before the proxy has received the request.
    const controller1 = new AbortController();
    const req1Promise = fetch(`${subswitch.url}/v1/park-probe`, {
      method: "GET",
      signal: controller1.signal,
    });
    while (parked.parkedRes === null) {
      await new Promise<void>((r) => setTimeout(r, 5));
    }

    // Step 2: verify that request 2 is blocked (slot full).
    const res2 = await fetch(`${subswitch.url}/v1/probe-2`, { method: "GET" });
    assert.equal(res2.status, 503, "second request must be blocked while slot is held");
    await res2.body?.cancel();

    // Step 3: reset parkedRes so request 3's arrival is observable, then abort
    // request 1.  The proxy's res.on("close") handler fires and decrements
    // activeRequests back to 0.
    parked.parkedRes = null;
    controller1.abort();
    try { await req1Promise; } catch { /* AbortError expected */ }

    // Step 4: fire request 3 and decide on an OBSERVED outcome — no fixed race
    // timeout.  In correct code the slot is released within ms of the abort; the
    // 2 s deadline is a safety net only.
    //
    //   parkedRes non-null  → request 3 reached the upstream → slot released ✓
    //   req3Promise resolves as 503 → counter was NOT decremented (leak) ✗
    const controller3 = new AbortController();
    const req3Promise = fetch(`${subswitch.url}/v1/probe-3`, {
      method: "GET",
      signal: controller3.signal,
    });

    type Outcome =
      | { kind: "parked" }
      | { kind: "responded"; status: number }
      | { kind: "timeout" };

    const outcome: Outcome = await Promise.race<Outcome>([
      req3Promise.then((r): Outcome => ({ kind: "responded", status: r.status })),
      (async (): Promise<Outcome> => {
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline) {
          if (parked.parkedRes !== null) return { kind: "parked" };
          await new Promise<void>((r) => setTimeout(r, 5));
        }
        return { kind: "timeout" };
      })(),
    ]);

    switch (outcome.kind) {
      case "parked":
        // Slot was released: request 3 reached the upstream and parked ✓
        break;
      case "responded":
        assert.notEqual(outcome.status, 503, "request 3 must not be 503-rejected after slot was released by abort");
        break;
      case "timeout":
        assert.fail("concurrency slot was not released within 2 s of abort");
        break;
    }

    controller3.abort();
    try { await req3Promise; } catch { /* AbortError expected */ }
  });
});
