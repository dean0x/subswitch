/** Synthetic device/refresh grants only. Every transport is an injected numeric loopback server. */
import assert from "node:assert/strict";
import { test } from "node:test";
import http from "node:http";
import { KimiAuthManager, loginKimi } from "../../src/kimi-auth.js";
import type { KimiAuthRecord, KimiAuthStore } from "../../src/kimi-auth-store.js";

const initial = (): KimiAuthRecord => ({ version: 1, revision: "revision-1", generation: "login-1", region: "global", deviceId: "device-1",
  tokens: { access_token: "fabricated-access", refresh_token: "fabricated-refresh", expires_at: 1, token_type: "Bearer" } });
function store(record?: KimiAuthRecord): KimiAuthStore {
  let value = record;
  let tail: Promise<unknown> = Promise.resolve();
  return { coordinationKey: `fabricated-${Math.random()}`,
    async read(signal) { signal.throwIfAborted(); if (!value) throw new Error("kimi_auth_store_missing"); return structuredClone(value); },
    async withLock(operation, signal) { signal.throwIfAborted(); const previous = tail; let release!: () => void; tail = new Promise<void>(resolve => { release = resolve; }); await previous; try { signal.throwIfAborted(); return await operation(); } finally { release(); } },
    async write(next, signal) { signal.throwIfAborted(); assert.equal(value, undefined); value = structuredClone(next); },
    async compareAndSwap(revision, next, signal) { signal.throwIfAborted(); if (value?.revision !== revision) return false; value = structuredClone(next); return true; },
  };
}
async function server(handler: (path: string, form: URLSearchParams, headers: http.IncomingHttpHeaders) => unknown | Promise<unknown>) {
  const requests: string[] = [], failures: unknown[] = [];
  const instance = http.createServer((req, res) => { void (async () => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push(req.url!);
    assert.match(req.headers["user-agent"]!, /^subswitch\//); assert.equal(req.headers["x-msh-platform"], "subswitch");
    assert.ok(req.headers["x-msh-device-id"]); assert.equal(req.headers.authorization, undefined);
    const data = await handler(req.url!, new URLSearchParams(Buffer.concat(chunks).toString()), req.headers);
    const payload = data as { status?: number; body?: unknown };
    res.writeHead(payload.status ?? 200, { "content-type": "application/json" }); res.end(JSON.stringify(payload.body ?? data));
  })().catch(error => { failures.push(error); res.writeHead(500).end("{}"); }); });
  await new Promise<void>(resolve => instance.listen(0, "127.0.0.1", resolve));
  const address = instance.address(); assert.ok(address && typeof address !== "string");
  return { origin: `http://127.0.0.1:${address.port}`, requests, async close() { instance.closeAllConnections(); await new Promise<void>(resolve => instance.close(() => resolve())); assert.deepEqual(failures, []); } };
}

test("managed refresh rotates atomically, coalesces managers, preserves login and only returns auth headers", async () => {
  const s = store(initial()); let refreshes = 0;
  const endpoint = await server((_path, form) => {
    assert.equal(form.get("client_id"), "17e5f671-d194-4dfb-9706-5516cb48c098");
    assert.equal(form.get("grant_type"), "refresh_token"); assert.equal(form.get("refresh_token"), "fabricated-refresh");
    refreshes++; return { access_token: "fabricated-rotated", refresh_token: "fabricated-rotated-refresh", expires_in: 3600 };
  });
  try {
    const a = new KimiAuthManager({ store: s, region: "global", fixtureOrigin: endpoint.origin });
    const b = new KimiAuthManager({ store: s, region: "global", fixtureOrigin: endpoint.origin });
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? a : b).credentials(AbortSignal.timeout(2000))));
    assert.equal(refreshes, 1);
    for (const result of results) { assert.equal(result.generation, "login-1"); assert.deepEqual(result.authHeaders, { authorization: "Bearer fabricated-rotated" }); }
    const persisted = await s.read(AbortSignal.timeout(1000)); assert.equal(persisted.tokens.refresh_token, "fabricated-rotated-refresh"); assert.notEqual(persisted.revision, "revision-1");
  } finally { await endpoint.close(); }
});

test("one cancelled waiter does not cancel shared refresh; pre-aborted caller performs no work", async () => {
  let release!: () => void, started!: () => void;
  const parked = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { started = resolve; });
  const endpoint = await server(async () => { started(); await parked; return { access_token: "fabricated-new", expires_in: 3600 }; });
  try {
    const manager = new KimiAuthManager({ store: store(initial()), region: "global", fixtureOrigin: endpoint.origin });
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(manager.credentials(aborted.signal)); assert.equal(endpoint.requests.length, 0);
    const c = new AbortController(); const first = manager.credentials(c.signal); const rejected = assert.rejects(first, /cancelled/);
    await entered; const remaining = manager.credentials(AbortSignal.timeout(2000)); c.abort(); await rejected; release();
    assert.equal((await remaining).generation, "login-1"); assert.equal(endpoint.requests.length, 1);
  } finally { release?.(); await endpoint.close(); }
});

test("device login handles pending/slow_down, stores only new isolated lineage and never invokes a model", async () => {
  const s = store(); let polls = 0; const delays: number[] = []; let shown: unknown;
  const endpoint = await server((path, form) => {
    if (path.endsWith("device_authorization")) return { device_code: "fabricated-device-code", user_code: "ABCD-EFGH", verification_uri_complete: endpoint.origin + "/approve?user_code=ABCD-EFGH", expires_in: 180, interval: 1 };
    assert.equal(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:device_code"); assert.equal(form.get("device_code"), "fabricated-device-code");
    polls++; return polls < 3 ? { status: 400, body: { error: polls === 1 ? "authorization_pending" : "slow_down" } } : { access_token: "fabricated-login-access", refresh_token: "fabricated-login-refresh", expires_in: 3600 };
  });
  try {
    await loginKimi({ store: s, region: "global", fixtureOrigin: endpoint.origin, signal: AbortSignal.timeout(2000), onVerification: info => { shown = info; }, sleep: async ms => { delays.push(ms); } });
    assert.deepEqual(delays, [1000, 1000, 6000]); assert.deepEqual(shown, { uri: endpoint.origin + "/approve?user_code=ABCD-EFGH", userCode: "ABCD-EFGH" });
    const result = await s.read(AbortSignal.timeout(1000)); assert.equal(result.region, "global"); assert.match(result.generation, /^[a-f0-9-]{36}$/); assert.equal(result.tokens.access_token, "fabricated-login-access");
    await assert.rejects(loginKimi({ store: s, region: "global", fixtureOrigin: endpoint.origin, signal: AbortSignal.timeout(1000), onVerification() { assert.fail(); } }), /store_exists/);
    assert.equal(endpoint.requests.length, 4);
  } finally { await endpoint.close(); }
});

test("denial, invalid token, malicious verification URL and refresh error remain sanitized without persistence", async () => {
  for (const scenario of ["denied", "token", "uri", "refresh"] as const) {
    const s = store(scenario === "refresh" ? initial() : undefined);
    const endpoint = await server(path => path.endsWith("device_authorization") ? { device_code: "fabricated-device", user_code: "FABRICATED", verification_uri_complete: scenario === "uri" ? "https://attacker.invalid/secret" : endpoint.origin + "/approve", expires_in: 60, interval: 1 }
      : scenario === "token" ? { access_token: "fabricated-secret\ninvalid", expires_in: 100 }
      : { status: 403, body: { error: "access_denied", error_description: "fabricated-private-secret" } });
    try {
      const operation = scenario === "refresh" ? new KimiAuthManager({ store: s, region: "global", fixtureOrigin: endpoint.origin }).credentials(AbortSignal.timeout(2000))
        : loginKimi({ store: s, region: "global", fixtureOrigin: endpoint.origin, signal: AbortSignal.timeout(2000), onVerification() {}, sleep: async () => {} });
      await assert.rejects(operation, error => { assert.ok(error instanceof Error); assert.doesNotMatch(error.message, /fabricated-private|fabricated-secret|attacker/); return true; });
      if (scenario !== "refresh") await assert.rejects(s.read(AbortSignal.timeout(1000)), /missing/);
    } finally { await endpoint.close(); }
  }
});

test("region and endpoint mismatches fail before dispatch", async () => {
  let calls = 0; const transport: typeof fetch = async () => { calls++; throw new Error("must not call"); };
  assert.throws(() => new KimiAuthManager({ store: store(initial()), region: "global", fixtureOrigin: "https://attacker.invalid", transport }), /fixture_endpoint/);
  await assert.rejects(new KimiAuthManager({ store: store(initial()), region: "mainland-cn", transport }).credentials(AbortSignal.timeout(1000)), /region_mismatch/);
  assert.equal(calls, 0);
});

test("explicit regions select matching official auth hosts without ambient overrides", async () => {
  for (const region of ["global", "mainland-cn"] as const) {
    const urls: string[] = [];
    const manager = new KimiAuthManager({ store: store({ ...initial(), region }), region, transport: async url => {
      urls.push(String(url));
      return new Response(JSON.stringify({ access_token: "fabricated-region-access", expires_in: 3600 }), { status: 200 });
    } });
    await manager.credentials(AbortSignal.timeout(1000));
    assert.deepEqual(urls, [`https://auth.kimi.${region === "global" ? "ai" : "com"}/api/oauth/token`]);
    const authOrigin = `https://auth.kimi.${region === "global" ? "ai" : "com"}`;
    const loginUrls: string[] = [];
    await loginKimi({ store: store(), region, signal: AbortSignal.timeout(1000), sleep: async () => {}, onVerification: info => assert.equal(info.uri, authOrigin + "/approve"), transport: async url => {
      loginUrls.push(String(url));
      return new Response(JSON.stringify(String(url).endsWith("device_authorization")
        ? { device_code: "fabricated-device", user_code: "FABRICATED", verification_uri_complete: authOrigin + "/approve", expires_in: 60, interval: 1 }
        : { access_token: "fabricated-login", refresh_token: "fabricated-refresh", expires_in: 3600 }), { status: 200 });
    } });
    assert.deepEqual(loginUrls, [authOrigin + "/api/oauth/device_authorization", authOrigin + "/api/oauth/token"]);
  }
});
