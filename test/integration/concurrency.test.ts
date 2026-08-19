/**
 * Concurrency integration tests.
 *
 * The admission gate has been removed (ADR-010): a relay-invented status that the
 * origin would not have produced is a defect. Tests verify that concurrent requests
 * all reach the upstream without relay interference.
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
// Shared upstream that parks ALL arriving requests and lets the test release them.
// Each request is held until releaseAll() is called.
// ---------------------------------------------------------------------------

interface ParkingUpstream {
  readonly url: string;
  /** Number of requests that have fully arrived at the upstream and are waiting. */
  readonly arrivedCount: number;
  /** Release every parked request with a 200 { ok: true } response. */
  releaseAll(): void;
  close(): Promise<void>;
}

const startParkingUpstream = async (): Promise<ParkingUpstream> => {
  const parked: ServerResponse[] = [];
  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => { parked.push(res); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    get arrivedCount() { return parked.length; },
    releaseAll() {
      for (const res of parked.splice(0)) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
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
// Concurrent requests all reach the upstream — no relay-invented gate (P0-2a)
//
// N = 20: one-fifth of the ~100-concurrent-sub-agent product thesis.  All 20
// are fired simultaneously; the test asserts all 20 arrive at the upstream
// before any are released.  If a relay-side gate blocked any request, that
// request would never arrive and pollUntil would time out — RED at the
// arrivedCount assertion.  Within the 30 s hard per-test timeout (package.json).
// ---------------------------------------------------------------------------

describe("concurrency — all requests reach upstream without relay interference (P0-2a)", () => {
  it("20 concurrent POSTs all reach the upstream and return 200", async () => {
    // Non-vacuity: if the relay had a gate set to K < 20 concurrent requests, at most K
    // requests would arrive at the upstream before the others stalled.  pollUntil would
    // time out before arrivedCount reached 20 and the test would fail at the assert.equal
    // below.  Positive control: all 20 are released and must each return 200.
    const N = 20;

    const parked = await startParkingUpstream();
    cleanups.push(parked.close);

    const subswitch = await startSubswitch({
      anthropic: { baseUrl: parked.url },
    });
    cleanups.push(subswitch.close);

    const body = JSON.stringify({ model: "claude-sonnet-4-6", messages: [] });
    const headers = { "content-type": "application/json" };

    // Fire all N concurrently — no sequential sequencing.
    const requests = Array.from({ length: N }, (_, i) =>
      fetch(`${subswitch.url}/v1/messages?id=${i}`, { method: "POST", headers, body }),
    );

    // Wait for all N to arrive at the upstream (no relay-side gate may block any).
    const allArrived = await pollUntil(() => parked.arrivedCount >= N, 5000);
    assert.ok(allArrived, `all ${N} requests must reach upstream within 5 s`);
    assert.equal(parked.arrivedCount, N, `all ${N} requests must have arrived — no relay gate may block any`);

    // Positive control: release all and verify every request returns 200.
    parked.releaseAll();
    const results = await Promise.all(requests);
    for (const [i, r] of results.entries()) {
      assert.equal(r.status, 200, `request ${i} must return 200`);
      await r.text();
    }
  });

  it("health endpoint always reaches relay regardless of in-flight requests", async () => {
    // Non-vacuity: if health were blocked by in-flight traffic, the fetch() call
    // would hang until the 30 s test deadline, triggering a hard timeout failure.
    // Positive control: after health check, the parked POST is released and must
    // also return 200 — confirming it was genuinely in-flight, not already dropped.
    const parked = await startParkingUpstream();
    cleanups.push(parked.close);

    const subswitch = await startSubswitch({
      anthropic: { baseUrl: parked.url },
    });
    cleanups.push(subswitch.close);

    // Fire a POST — it parks at the upstream.
    const postPromise = fetch(`${subswitch.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
    });
    const postArrived = await pollUntil(() => parked.arrivedCount >= 1, 2000);
    assert.ok(postArrived, "POST must reach upstream before health check");

    // Health must respond immediately while POST is still in-flight.
    const health = await fetch(`${subswitch.url}/__subswitch/health`);
    assert.equal(health.status, 200, "health must return 200 with in-flight POST");
    assert.equal(health.headers.get("x-subswitch-synthesized"), "1");

    // Positive control: release the parked POST — it must complete successfully,
    // confirming it was genuinely in-flight (not already dropped by the relay).
    parked.releaseAll();
    const postResult = await postPromise;
    assert.equal(postResult.status, 200, "in-flight POST must complete 200 after release");
    await postResult.text();
  });
});
