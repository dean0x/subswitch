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
// Concurrent requests all reach the upstream — no relay-invented gate (P0-2a)
//
// Non-vacuity: if the relay still had a gate set to 1 concurrent request,
// the second concurrent POST would receive 503/529 (not 200), and this
// test would fail at the "second request must reach upstream" assertion.
// ---------------------------------------------------------------------------

describe("concurrency — all requests reach upstream without relay interference (P0-2a)", () => {
  it("N concurrent POSTs all reach the upstream and return 200", async () => {
    // Two concurrent POSTs — the relay must forward both without blocking or rejecting.
    const parked = await startParkingUpstream();
    cleanups.push(parked.close);

    const subswitch = await startSubswitch({
      anthropic: { baseUrl: parked.url },
    });
    cleanups.push(subswitch.close);

    const body = JSON.stringify({ model: "claude-sonnet-4-6", messages: [] });

    // Fire req1 — parks at upstream.
    const controller1 = new AbortController();
    const req1 = fetch(`${subswitch.url}/v1/messages?id=req1`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: controller1.signal,
    });
    const req1Parked = await pollUntil(() => parked.parkedRes !== null, 2000);
    assert.ok(req1Parked, "req1 must reach upstream");
    const req1Res = parked.parkedRes!;
    parked.parkedRes = null;

    // Fire req2 while req1 is still in-flight — must also reach upstream.
    const controller2 = new AbortController();
    const req2 = fetch(`${subswitch.url}/v1/messages?id=req2`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: controller2.signal,
    });
    const req2Parked = await pollUntil(() => parked.parkedRes !== null, 2000);
    assert.ok(req2Parked, "req2 must also reach upstream — no gate must block it");

    // Complete both requests.
    req1Res.writeHead(200, { "content-type": "application/json" });
    req1Res.end(JSON.stringify({ id: "req1" }));
    parked.release();

    const [r1, r2] = await Promise.all([req1, req2]);
    assert.equal(r1.status, 200, "req1 must return 200");
    assert.equal(r2.status, 200, "req2 must return 200");
    await r1.text();
    await r2.text();

    controller1.abort();
    controller2.abort();
  });

  it("health endpoint always reaches relay regardless of in-flight requests", async () => {
    // Health endpoint must never be blocked by any relay-side gate.
    const parked = await startParkingUpstream();
    cleanups.push(parked.close);

    const subswitch = await startSubswitch({
      anthropic: { baseUrl: parked.url },
    });
    cleanups.push(subswitch.close);

    // Park a POST to simulate an in-flight request.
    const controller = new AbortController();
    const postPromise = fetch(`${subswitch.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
      signal: controller.signal,
    });
    await pollUntil(() => parked.parkedRes !== null, 2000);

    // Health must respond immediately.
    const health = await fetch(`${subswitch.url}/__subswitch/health`);
    assert.equal(health.status, 200, "health must return 200 with in-flight POST");
    assert.equal(health.headers.get("x-subswitch-synthesized"), "1");

    controller.abort();
    try { await postPromise; } catch { /* AbortError */ }
    parked.release();
  });
});
