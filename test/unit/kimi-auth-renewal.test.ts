/** Offline renewal failures use an in-memory store and injected transport only. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import { KimiAuthManager, loginKimi } from "../../src/kimi-auth.js";
import type { KimiAuthRecord, KimiAuthStore } from "../../src/kimi-auth-store.js";
import { ProfileAuth } from "../../src/routing/profile-auth.js";
import { noopLogger } from "../../src/logger.js";
import type { AccessProfile } from "../../src/routing/routing-types.js";

function fixture() {
  let now = Date.now();
  const access = randomUUID();
  let record: KimiAuthRecord = { version: 1, revision: randomUUID(), generation: randomUUID(), region: "global", deviceId: randomUUID(),
    tokens: { access_token: access, refresh_token: randomUUID(), expires_at: Math.floor(now / 1000) + 600, token_type: "Bearer" } };
  const store: KimiAuthStore = {
    coordinationKey: `fake-${randomUUID()}`,
    read: async () => record,
    withLock: async operation => operation(),
    write: async next => { record = next; },
    compareAndSwap: async (revision, next) => { if (revision !== record.revision) return false; record = next; return true; },
  };
  return { store, access, now: () => now, due: () => { now += 510000; }, expire: () => { now += 600000; },
    replace: () => { record = { ...record, revision: randomUUID(), generation: randomUUID() }; } };
}
const signal = () => new AbortController().signal;
function deadline(t: TestContext, milliseconds: number) {
  const controller = new AbortController(), timeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, "timeout", (ms: number) => ms === milliseconds ? controller.signal : timeout(ms));
  return () => controller.abort(new DOMException("fake deadline", "TimeoutError"));
}

for (const failure of ["network", "503", "timeout"] as const) test(`managed proactive ${failure} keeps the verified bearer and sibling binding`, async t => {
  const f = fixture(), expire = deadline(t, 10000);
  let calls = 0;
  const manager = new KimiAuthManager({ store: f.store, region: "global", now: f.now, transport: async () => {
    calls++;
    if (failure === "network") throw new TypeError("fake network failure");
    if (failure === "timeout") { expire(); return new Promise<Response>(() => {}); }
    return new Response("{}", { status: 503 });
  } });
  const profile: AccessProfile = { provider: "kimi", product: "kimi-code", billing: "subscription", region: "global", account: "fake",
    credential: { kind: "native-oauth", authFile: "/fake/never-read.json" } };
  const auth = new ProfileAuth({ first: profile, alias: profile }, noopLogger, {}, () => manager);
  const first = await auth.get("first", signal()), sibling = await auth.get("alias", signal());
  f.due();
  const current = await auth.get("first", signal());
  assert.equal(current.generation, first.generation);
  assert.equal(current.authHeaders.authorization, `Bearer ${f.access}`);
  assert.doesNotThrow(() => auth.validate(sibling));
  assert.equal(calls, 1);
});

for (const status of [400, 401, 403]) test(`managed proactive HTTP${status} still rejects`, async () => {
  const f = fixture(); f.due();
  const manager = new KimiAuthManager({ store: f.store, region: "global", now: f.now,
    transport: async () => new Response('{"error":"invalid_grant"}', { status }) });
  await assert.rejects(manager.credentials(signal()), { code: "kimi_oauth_refresh_failed" });
});

for (const mode of ["forced", "expired", "owner-changed", "malformed"] as const) test(`managed ${mode} never falls back to the previous bearer`, async () => {
  const f = fixture(); f.due();
  if (mode === "expired") f.expire();
  const manager = new KimiAuthManager({ store: f.store, region: "global", now: f.now, transport: async () => {
    if (mode === "owner-changed") f.replace();
    if (mode === "malformed") return new Response("not-json");
    throw new TypeError("fake network failure");
  } });
  await assert.rejects(manager.credentials(signal(), mode === "forced"));
});

test("managed transient failure with an expired bearer does not invalidate a sibling binding", async () => {
  const f = fixture();
  const manager = new KimiAuthManager({ store: f.store, region: "global", now: f.now,
    transport: async () => { throw new TypeError("fake network failure"); } });
  const profile: AccessProfile = { provider: "kimi", product: "kimi-code", billing: "subscription", region: "global", account: "fake",
    credential: { kind: "native-oauth", authFile: "/fake/never-read.json" } };
  const auth = new ProfileAuth({ first: profile, alias: profile }, noopLogger, {}, () => manager);
  const sibling = await auth.get("alias", signal()); f.expire();
  await assert.rejects(auth.get("first", signal()));
  assert.doesNotThrow(() => auth.validate(sibling));
});

test("managed HTTP401 headers with a body timeout never preserve the bearer", async t => {
  const f = fixture(); f.due(); const expire = deadline(t, 10000);
  const manager = new KimiAuthManager({ store: f.store, region: "global", now: f.now, transport: async () =>
    new Response(new ReadableStream<Uint8Array>({ pull() { expire(); } }, { highWaterMark: 0 }), { status: 401 }) });
  await assert.rejects(manager.credentials(signal()), { code: "kimi_oauth_timeout", status: 504 });
});

for (const [operation, unavailable] of [["credentials", "kimi_oauth_unavailable"], ["login", "kimi_oauth_login_failed"]] as const) {
  for (const busy of [true, false]) test(`${operation} ${busy ? "lock contention reports a distinct code" : "unrecognized store failures stay sanitized"}`, async () => {
    const f = fixture(); f.expire();
    f.store.withLock = async () => { throw new Error(busy ? "kimi_auth_store_lock_timeout" : "fabricated-private-store-detail"); };
    const options = { store: f.store, region: "global" as const, now: f.now,
      transport: async () => assert.fail("store refusal must precede OAuth transport") };
    const pending = operation === "credentials" ? new KimiAuthManager(options).credentials(signal())
      : loginKimi({ ...options, signal: signal(), onVerification: () => assert.fail("unexpected verification") });
    const code = busy ? "kimi_oauth_lock_busy" : unavailable;
    await assert.rejects(pending, { code, message: code, status: 503 });
  });
}

for (const milliseconds of [10000, 15000]) test(`managed internal ${milliseconds}ms deadline reports timeout, not cancellation`, async t => {
  const f = fixture(); f.expire(); const expire = deadline(t, milliseconds);
  const manager = new KimiAuthManager({ store: f.store, region: "global", now: f.now,
    transport: async () => { expire(); return new Promise<Response>(() => {}); } });
  await assert.rejects(manager.credentials(signal()), { code: "kimi_oauth_timeout", status: 504 });
});

for (const milliseconds of [10000, 300000]) test(`login internal ${milliseconds}ms deadline reports timeout, not cancellation`, async t => {
  const f = fixture(), expire = deadline(t, milliseconds);
  f.store.read = async () => { throw new Error("kimi_auth_store_missing"); };
  await assert.rejects(loginKimi({ store: f.store, region: "global", signal: signal(), onVerification: () => assert.fail("unexpected verification"),
    transport: async () => { expire(); return new Promise<Response>(() => {}); } }), { code: "kimi_oauth_timeout", status: 504 });
});

for (const operation of ["credentials", "login"] as const) test(`${operation} caller abort still reports cancellation`, async () => {
  const f = fixture(), caller = new AbortController(); f.expire();
  const transport: typeof fetch = async () => { caller.abort(new Error("fake private reason")); return new Promise<Response>(() => {}); };
  if (operation === "credentials") {
    const manager = new KimiAuthManager({ store: f.store, region: "global", now: f.now, transport });
    await assert.rejects(manager.credentials(caller.signal), { code: "kimi_oauth_cancelled", status: 499 });
  } else {
    f.store.read = async () => { throw new Error("kimi_auth_store_missing"); };
    await assert.rejects(loginKimi({ store: f.store, region: "global", transport, signal: caller.signal,
      onVerification: () => assert.fail("unexpected verification") }), { code: "kimi_oauth_cancelled", status: 499 });
  }
});
