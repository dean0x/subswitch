/** Recovery regressions: fabricated grants, owned scratch and injected fetch only. */
import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { KimiNativeAuthManager, kimiNativeTokenFilename } from "../../src/kimi-native-auth.js";
import { withNativeLease } from "../../src/kimi-native-store.js";
import { setTimeout as delay } from "node:timers/promises";
import { inspectKimiProfiles } from "../../src/kimi-doctor.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "subswitch-renewal-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "credentials"), { mode: 0o700 }); await mkdir(join(root, "oauth"), { mode: 0o700 });
  const file = join(root, "credentials", kimiNativeTokenFilename("global"));
  await writeFile(file, JSON.stringify({ access_token: "fake-old", refresh_token: "fake-grant", token_type: "Bearer", expires_at: 1, expires_in: 3600 }), { mode: 0o600 });
  t.mock.method(globalThis, "fetch", async () => assert.fail("unexpected uninjected transport"));
  return { root, file, lock: join(root, "oauth", kimiNativeTokenFilename("global").slice(0, -5) + ".lock") };
}
const success = () => new Response(JSON.stringify({ access_token: "fake-renewed", refresh_token: "fake-rotated", expires_in: 3600, token_type: "Bearer" }));
const signal = () => AbortSignal.timeout(15000);

test("crashed native owner's empty stale lock is recovered without manual intervention", async t => {
  const { file, lock } = await fixture(t); await mkdir(lock, { mode: 0o700 });
  const old = new Date(Date.now() - 10000); await utimes(lock, old, old); let calls = 0;
  const credential = await new KimiNativeAuthManager(file, "global", Date.now, async () => { calls++; return success(); }).credentials(signal());
  assert.equal(calls, 1); assert.equal(credential.authHeaders.authorization, "Bearer fake-renewed");
});

for (const status of [429, 403]) test(`HTTP${status} definite rejection recovers on a later request after process restart`, async t => {
  const { file } = await fixture(t); let now = Date.now(), calls = 0;
  const original = await readFile(file, "utf8");
  const transport: typeof fetch = async () => { calls++; return calls === 1 ? new Response(JSON.stringify({ error: status === 403 ? "invalid_client" : "rate_limited" }), { status }) : success(); };
  await assert.rejects(new KimiNativeAuthManager(file, "global", () => now, transport).credentials(signal()), /kimi_native_refresh_/);
  assert.equal(await readFile(file, "utf8"), original);
  now += 300001;
  const recovered = await new KimiNativeAuthManager(file, "global", () => now, transport).credentials(signal());
  assert.equal(calls, 2); assert.equal(recovered.authHeaders.authorization, "Bearer fake-renewed");
});

test("non-dispatch DNS/connect failures back off, while a lost socket outcome remains protected", async t => {
  for (const code of ["ENOTFOUND", "ECONNREFUSED", "ECONNRESET"]) {
    const { file } = await fixture(t); let now = Date.now(), calls = 0;
    const transport: typeof fetch = async () => {
      calls++; if (calls > 1) return success();
      throw new TypeError("fake-private-error", { cause: Object.assign(new Error("fake-private-cause"), { code }) });
    };
    await assert.rejects(new KimiNativeAuthManager(file, "global", () => now, transport).credentials(signal()), /kimi_native_refresh_(unavailable|recovery_required)/);
    now += 300001;
    const next = new KimiNativeAuthManager(file, "global", () => now, transport).credentials(signal());
    if (code === "ECONNRESET") { await assert.rejects(next, /kimi_native_refresh_recovery_required/); assert.equal(calls, 1); }
    else { assert.equal((await next).authHeaders.authorization, "Bearer fake-renewed"); assert.equal(calls, 2); }
  }
});

test("persisted rejection backoff increases across restart, caps at five minutes, and never busy-loops", async t => {
  const { file, root } = await fixture(t); let now = Date.now(), calls = 0;
  const transport: typeof fetch = async () => { calls++; return new Response("fake-private-error", { status: 429 }); };
  const marker = join(root, "oauth", kimiNativeTokenFilename("global").slice(0, -5) + ".subswitch-renewal.json");
  for (const expected of [30000, 60000, 120000, 240000, 300000, 300000]) {
    await assert.rejects(new KimiNativeAuthManager(file, "global", () => now, transport).credentials(signal()), /kimi_native_refresh_busy/);
    const saved = JSON.parse(await readFile(marker, "utf8"));
    assert.equal(saved.version, 2); assert.equal(saved.retryAt - now, expected);
    const count = calls;
    await assert.rejects(new KimiNativeAuthManager(file, "global", () => now, transport).credentials(signal()), /kimi_native_refresh_busy/);
    assert.equal(calls, count); assert.doesNotMatch(JSON.stringify(saved), /fake-|https:|Authorization/);
    now = saved.retryAt + 1;
  }
  assert.equal(calls, 6);
});

for (const replace of [false, true]) test(`stale observation never removes a ${replace ? "successor" : "rejuvenated"} native lease`, async t => {
  const { file, lock } = await fixture(t); await mkdir(lock, { mode: 0o700 });
  const old = new Date(Date.now() - 10000); await utimes(lock, old, old);
  let calls = 0;
  const pending = new KimiNativeAuthManager(file, "global", Date.now, async () => { calls++; return success(); }).credentials(signal());
  await delay(30);
  if (replace) { await rename(lock, lock + ".old"); await mkdir(lock, { mode: 0o700 }); }
  else { const current = new Date(); await utimes(lock, current, current); }
  const owner = await lstat(lock); await delay(150);
  assert.equal((await lstat(lock)).ino, owner.ino); assert.equal(calls, 0);
  await writeFile(file + ".peer", JSON.stringify({ access_token: "fake-peer", refresh_token: "fake-peer-grant", token_type: "Bearer", expires_at: Math.floor(Date.now() / 1000) + 3600 }), { mode: 0o600 });
  await rename(file + ".peer", file); await rm(lock, { recursive: true });
  assert.equal((await pending).authHeaders.authorization, "Bearer fake-peer"); assert.equal(calls, 0);
});

test("stale nonempty directories are never recursively deleted or entered", async t => {
  const { file, lock } = await fixture(t); await mkdir(lock, { mode: 0o700 }); await writeFile(join(lock, "owned"), "fake-preserve");
  const old = new Date(Date.now() - 10000); await utimes(lock, old, old);
  await assert.rejects(withNativeLease(file, AbortSignal.timeout(350), async () => assert.fail("nonempty lease must not be acquired")));
  assert.equal(await readFile(join(lock, "owned"), "utf8"), "fake-preserve");
});

test("two independent stale recovery contenders serialize their critical sections", async t => {
  const { file, lock } = await fixture(t); await mkdir(lock, { mode: 0o700 });
  const old = new Date(Date.now() - 10000); await utimes(lock, old, old); let active = 0, completed = 0;
  const enter = () => withNativeLease(file, signal(), async lease => {
    assert.equal(++active, 1); await delay(50); await lease.verify(); active--; completed++;
  });
  await Promise.all([enter(), enter()]); assert.equal(completed, 2);
});

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
for (const boundary of ["pending-persisted", "credential-guard"] as const)
test(`${boundary}: deterministic native takeover stops the next side effect`, async t => {
  const { file, lock } = await fixture(t), entered = deferred(), resume = deferred();
  const original = await readFile(file, "utf8"); let calls = 0;
  const pause = async () => { entered.resolve(); await resume.promise; };
  const manager = new KimiNativeAuthManager(file, "global", Date.now, async () => { calls++; return success(); }, boundary === "pending-persisted" ? { afterPendingPersist: pause } : { beforeCredentialCommit: pause });
  const rejected = assert.rejects(manager.credentials(signal()), /kimi_native_lock_lost/);
  await entered.promise;
  await rename(lock, lock + ".old"); await mkdir(lock, { mode: 0o700 }); const successor = await lstat(lock);
  resume.resolve(); await rejected;
  assert.equal(calls, boundary === "pending-persisted" ? 0 : 1);
  assert.equal(await readFile(file, "utf8"), original); assert.equal((await lstat(lock)).ino, successor.ino);
});

test("heartbeat-observed native takeover aborts an in-flight refresh transport", async t => {
  const { file, lock } = await fixture(t), original = await readFile(file, "utf8"); let aborted = false;
  const transport: typeof fetch = async (_url, init) => {
    await rename(lock, lock + ".old"); await mkdir(lock, { mode: 0o700 });
    const keepalive = setInterval(() => {}, 250);
    try { return await new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => { aborted = true; reject(new Error("fake-private-abort")); }, { once: true });
    }); } finally { clearInterval(keepalive); }
  };
  await assert.rejects(new KimiNativeAuthManager(file, "global", Date.now, transport).credentials(signal()), /kimi_native_lock_lost/);
  assert.equal(aborted, true); assert.equal(await readFile(file, "utf8"), original);
});

test("prepared, definitely undispatched intent resumes after bounded cooldown across restart", async t => {
  const { file } = await fixture(t); let now = Date.now(), calls = 0;
  const { nativeFingerprint, readNativeSnapshot } = await import("../../src/kimi-native-store.js");
  const record = (await readNativeSnapshot(file, signal())).record;
  const grant = nativeFingerprint(JSON.stringify([record.access_token, record.refresh_token, record.expires_at]));
  await withNativeLease(file, signal(), lease => lease.writeAttempt(grant, "prepared", now + 30000));
  const transport: typeof fetch = async () => { calls++; return success(); };
  await assert.rejects(new KimiNativeAuthManager(file, "global", () => now, transport).credentials(signal()), /kimi_native_refresh_busy/);
  assert.equal(calls, 0); now += 30001;
  assert.equal((await new KimiNativeAuthManager(file, "global", () => now, transport).credentials(signal())).authHeaders.authorization, "Bearer fake-renewed"); assert.equal(calls, 1);
});

test("untyped503 remains ambiguous; secure observation of a changed native grant reconciles automatically", async t => {
  const { file } = await fixture(t); let calls = 0;
  const transport: typeof fetch = async () => { calls++; return new Response("fake-private-error", { status: 503 }); };
  await assert.rejects(new KimiNativeAuthManager(file, "global", Date.now, transport).credentials(signal()), /kimi_native_refresh_recovery_required/);
  await assert.rejects(new KimiNativeAuthManager(file, "global", Date.now, transport).credentials(signal()), /kimi_native_refresh_recovery_required/); assert.equal(calls, 1);
  assert.equal((await new KimiNativeAuthManager(file, "global").inspect(signal())).recoveryRequired, true);
  const lines: string[] = [];
  assert.equal(await inspectKimiProfiles({ native: { provider: "kimi", product: "kimi-code", region: "global", billing: "subscription", account: "fake", credential: { kind: "native-oauth", source: "kimi-code", authFile: file } } }, line => lines.push(line)), 1);
  assert.match(lines[0]!, /recovery required/); assert.doesNotMatch(lines[0]!, /temporary|logout|fake-|credentials\//);
  await writeFile(file + ".peer", JSON.stringify({ access_token: "fake-peer", refresh_token: "fake-new-grant", token_type: "Bearer", expires_at: Math.floor(Date.now() / 1000) + 3600 }), { mode: 0o600 }); await rename(file + ".peer", file);
  assert.equal((await new KimiNativeAuthManager(file, "global", Date.now, transport).credentials(signal())).authHeaders.authorization, "Bearer fake-peer"); assert.equal(calls, 1);
  assert.equal((await new KimiNativeAuthManager(file, "global").inspect(signal())).recoveryRequired, undefined);
});

for (const status of [200, 400, 401, 403, 429])
test(`HTTP${status} broken refresh body is classified immediately without replaying an ambiguous grant`, async t => {
  const { file, root } = await fixture(t), original = await readFile(file, "utf8");
  let now = Date.now(), calls = 0;
  const transport: typeof fetch = async () => {
    calls++;
    if (calls > 1) return success();
    let first = true;
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (first) {
          first = false;
          controller.enqueue(new TextEncoder().encode('{"error":"invalid_client","access_token":"fake-private'));
        } else {
          // A pre-connect-looking cause cannot prove non-dispatch after headers.
          controller.error(new TypeError("fake-private https://private.invalid Authorization: fake-grant", {
            cause: Object.assign(new Error("fake-private-cause"), { code: "ECONNREFUSED" }),
          }));
        }
      },
    }), { status });
  };
  const expected = status === 429 ? "kimi_native_refresh_busy" : "kimi_native_refresh_recovery_required";
  await assert.rejects(new KimiNativeAuthManager(file, "global", () => now, transport).credentials(signal()), error => {
    assert.ok(error instanceof Error); assert.equal(error.message, expected);
    assert.doesNotMatch(JSON.stringify(error) + error.message, /fake-|https:|Authorization/); return true;
  });
  assert.equal(await readFile(file, "utf8"), original);
  const marker = JSON.parse(await readFile(join(root, "oauth", kimiNativeTokenFilename("global").slice(0, -5) + ".subswitch-renewal.json"), "utf8"));
  assert.equal(marker.outcome, status === 429 ? "busy" : "pending");
  await assert.rejects(new KimiNativeAuthManager(file, "global", () => now, transport).credentials(signal()), { message: expected });
  assert.equal(calls, 1);
  now += 300001;
  const later = new KimiNativeAuthManager(file, "global", () => now, transport).credentials(signal());
  if (status === 429) {
    assert.equal((await later).authHeaders.authorization, "Bearer fake-renewed"); assert.equal(calls, 2);
  } else {
    await assert.rejects(later, { message: expected }); assert.equal(calls, 1);
  }
});

for (const status of [200, 403, 429])
test(`HTTP${status} body deadline preserves header evidence and cancels the reader`, async t => {
  const { file } = await fixture(t), original = await readFile(file, "utf8"), deadline = new AbortController();
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  const mockedTimeout = t.mock.method(AbortSignal, "timeout", (milliseconds: number) => milliseconds === 20000 ? deadline.signal : timeout(milliseconds));
  let calls = 0, cancelled = false;
  const transport: typeof fetch = async () => {
    calls++;
    return new Response(new ReadableStream<Uint8Array>({
      pull() { deadline.abort(new Error("fake-private-deadline")); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 }), { status });
  };
  const expected = status === 429 ? "kimi_native_refresh_busy" : "kimi_native_refresh_recovery_required";
  await assert.rejects(new KimiNativeAuthManager(file, "global", Date.now, transport).credentials(signal()), { message: expected });
  mockedTimeout.mock.restore();
  assert.equal(cancelled, true); assert.equal(calls, 1); assert.equal(await readFile(file, "utf8"), original);
  await assert.rejects(new KimiNativeAuthManager(file, "global", Date.now, transport).credentials(signal()), { message: expected });
  assert.equal(calls, 1);
});

test("caller cancellation during refresh body keeps the shared grant outcome separate", async t => {
  const { file } = await fixture(t), original = await readFile(file, "utf8");
  const entered = deferred(), resume = deferred(), caller = new AbortController(); let calls = 0;
  const transport: typeof fetch = async () => {
    calls++;
    return new Response(new ReadableStream<Uint8Array>({
      async pull(controller) { entered.resolve(); await resume.promise; controller.error(new Error("fake-private-body")); },
    }, { highWaterMark: 0 }));
  };
  const cancelled = assert.rejects(new KimiNativeAuthManager(file, "global", Date.now, transport).credentials(caller.signal), { message: "kimi_native_cancelled" });
  await entered.promise; caller.abort(new Error("fake-private-caller")); await cancelled;
  const survivor = assert.rejects(new KimiNativeAuthManager(file, "global", Date.now, transport).credentials(signal()), { message: "kimi_native_refresh_recovery_required" });
  resume.resolve(); await survivor;
  assert.equal(calls, 1); assert.equal(await readFile(file, "utf8"), original);
});

test("heartbeat-observed lease loss during refresh body reports lock loss and cancels the reader", async t => {
  const { file, lock } = await fixture(t), original = await readFile(file, "utf8");
  let calls = 0, cancelled = false;
  const transport: typeof fetch = async () => {
    calls++;
    return new Response(new ReadableStream<Uint8Array>({
      async pull() { await rename(lock, lock + ".old"); await mkdir(lock, { mode: 0o700 }); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 }));
  };
  const keepalive = setInterval(() => {}, 250);
  try {
    await assert.rejects(new KimiNativeAuthManager(file, "global", Date.now, transport).credentials(signal()), { message: "kimi_native_lock_lost" });
  } finally { clearInterval(keepalive); }
  assert.equal(cancelled, true); assert.equal(calls, 1); assert.equal(await readFile(file, "utf8"), original);
  assert.ok((await lstat(lock)).isDirectory());
});
