/** Fabricated grants and owned temporary files only; injected transports. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { KimiNativeAuthManager, kimiNativeTokenFilename } from "../../src/kimi-native-auth.js";
import { nativeFingerprint, readNativeSnapshot, withNativeLease } from "../../src/kimi-native-store.js";
import { ProfileAuth } from "../../src/routing/profile-auth.js";
import { RoutedAttempts } from "../../src/routing/routed-attempt.js";
import { noopLogger } from "../../src/logger.js";
import type { AccessProfile } from "../../src/routing/routing-types.js";
import { nativeEvents, messageFrames } from "../fixtures/native-messages.js";

const now = () => Date.now();
const record = (access = "fake-access", expires = Math.floor(now() / 1000) - 60) => ({ access_token: access, refresh_token: "fake-refresh", token_type: "Bearer", expires_in: 3600, expires_at: expires, scope: "coding", custom: "preserve" });
const renewed = (access = "fake-renewed") => new Response(JSON.stringify({ access_token: access, refresh_token: "fake-rotated", token_type: "Bearer", expires_in: 3600 }), { status: 200 });
const signal = () => AbortSignal.timeout(15000);
async function fixture(t: TestContext, region: "global" | "mainland-cn" = "global") {
  const root = await mkdtemp(join(await realpath(tmpdir()), "subswitch-renewal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "credentials"), { mode: 0o700 });
  const file = join(root, "credentials", kimiNativeTokenFilename(region));
  await writeFile(file, JSON.stringify(record()), { mode: 0o600 });
  t.mock.method(globalThis, "fetch", async () => assert.fail("unexpected uninjected transport"));
  return { root, file, region, lock: join(root, "oauth", kimiNativeTokenFilename(region).slice(0, -5) + ".lock") };
}
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };

for (const region of ["global", "mainland-cn"] as const) test(`${region}: automatically renews expired token, isolates identity, atomically persists native format`, async t => {
  const { root, file } = await fixture(t, region), before = await lstat(file);
  let calls = 0;
  const manager = new KimiNativeAuthManager(file, region, now, async (url, init) => {
    calls++; assert.equal(url, `https://auth.kimi.${region === "global" ? "ai" : "com"}/api/oauth/token`);
    assert.equal(init?.redirect, "error");
    const body = new URLSearchParams(String(init?.body));
    assert.equal(body.get("grant_type"), "refresh_token"); assert.equal(body.get("refresh_token"), "fake-refresh");
    assert.equal(body.get("client_id"), "17e5f671-d194-4dfb-9706-5516cb48c098");
    const headers = new Headers(init?.headers); assert.equal(headers.get("x-msh-platform"), "subswitch");
    assert.match(headers.get("user-agent")!, /^subswitch\//); assert.equal(headers.has("authorization"), false);
    assert.equal(headers.get("x-msh-device-id")!.length, 36);
    return renewed();
  });
  const credential = await manager.credentials(signal());
  assert.equal(credential.authHeaders.authorization, "Bearer fake-renewed");
  assert.equal(credential.generation, nativeFingerprint("fake-access"));
  assert.equal((await manager.credentials(signal())).generation, credential.generation); assert.equal(calls, 1);
  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.equal(saved.refresh_token, "fake-rotated"); assert.equal(saved.scope, "coding"); assert.equal(saved.custom, "preserve");
  assert.ok(saved.expires_at > now() / 1000 + 3500); assert.equal((await lstat(file)).mode & 0o777, 0o600);
  assert.notEqual((await lstat(file)).ino, before.ino);
  const names = await readdir(join(root, "oauth")); assert.ok(!names.some(n => n.endsWith(".lock") || n.includes(".tmp.")));
  const marker = await readFile(join(root, "oauth", names.find(n => n.endsWith(".json"))!), "utf8");
  assert.doesNotMatch(marker, /fake-|Bearer|refresh_token|access_token|https:|device/);
  assert.equal((await readdir(join(root, "credentials"))).length, 1);
});

test("fresh tokens remain read-only, including files with no refresh token", async t => {
  const { root, file } = await fixture(t); const value = { ...record("fake-fresh", Math.floor(now() / 1000) + 3600), refresh_token: undefined };
  const raw = JSON.stringify(value); await writeFile(file, raw);
  assert.equal((await new KimiNativeAuthManager(file, "global").credentials(signal())).authHeaders.authorization, "Bearer fake-fresh");
  assert.equal(await readFile(file, "utf8"), raw); assert.deepEqual(await readdir(root), ["credentials"]);
});

test("source single-flight survives one waiter's cancellation across manager instances", async t => {
  const { file } = await fixture(t), entered = deferred<void>(), release = deferred<Response>(); let calls = 0;
  const transport: typeof fetch = async () => { calls++; entered.resolve(); return release.promise; };
  const first = new KimiNativeAuthManager(file, "global", now, transport), second = new KimiNativeAuthManager(file, "global", now, transport);
  const controller = new AbortController();
  const cancelled = assert.rejects(first.credentials(controller.signal), { message: "kimi_native_cancelled" });
  await entered.promise;
  const survivor = second.credentials(signal()); controller.abort(new Error("fake-secret-abort"));
  release.resolve(renewed()); await cancelled;
  assert.equal((await survivor).authHeaders.authorization, "Bearer fake-renewed"); assert.equal(calls, 1);
  assert.equal((await first.credentials(signal())).generation, nativeFingerprint("fake-access"));
});

test("native-shaped cross-process lock is respected and peer rotation reread without dispatch", async t => {
  const { root, file, lock } = await fixture(t); await mkdir(join(root, "oauth"), { mode: 0o700 });
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { mkdir, writeFile, rename, rmdir } from 'node:fs/promises';
    const [lock, file, value] = process.argv.slice(1);
    await mkdir(lock, {mode:0o700}); process.stdout.write('ready\\n');
    process.stdin.once('data', async () => { await writeFile(file+'.peer', value, {mode:0o600}); await rename(file+'.peer',file); await rmdir(lock); process.exit(0); });
  `, lock, file, JSON.stringify(record("fake-peer", Math.floor(now() / 1000) + 3600))], { env: { PATH: "/usr/bin:/bin" }, stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  await once(child.stdout, "data");
  let calls = 0;
  // credentials() reads its integrity-checked snapshot before consulting the
  // clock. Rotate only after that read; replacing the file during it must fail.
  const read = deferred<void>();
  const pending = new KimiNativeAuthManager(file, "global", () => { read.resolve(); return now(); }, async () => { calls++; return renewed(); }).credentials(signal());
  await Promise.race([read.promise, pending]);
  assert.equal(calls, 0);
  child.stdin.write("rotate"); await once(child, "exit");
  assert.equal((await pending).authHeaders.authorization, "Bearer fake-peer"); assert.equal(calls, 0);
});

for (const kind of ["transport", "invalid-json", "invalid-schema", "oversized"] as const)
test(`${kind}: ambiguous renewal is durable, sanitized and never blindly replayed`, async t => {
  const { file } = await fixture(t), raw = await readFile(file, "utf8"); let calls = 0;
  const transport: typeof fetch = async () => {
    calls++;
    if (kind === "transport") throw new Error("fake-secret https://secret.invalid Authorization: fake-refresh");
    if (kind === "invalid-json") return new Response("fake-secret");
    if (kind === "invalid-schema") return new Response(JSON.stringify({ access_token: "fake-secret", expires_in: "bad" }));
    if (kind === "oversized") return new Response("fake-secret".repeat(3000));
    throw new Error("unhandled fixture");
  };
  await assert.rejects(new KimiNativeAuthManager(file, "global", now, transport).credentials(signal()), error => {
    assert.ok(error instanceof Error); assert.match(error.message, /^kimi_native_refresh_(recovery_required|rejected)$/);
    assert.doesNotMatch(JSON.stringify(error) + error.message, /fake-|https:|Authorization/); return true;
  });
  await assert.rejects(new KimiNativeAuthManager(file, "global", now, transport).credentials(signal()), /kimi_native_refresh_recovery_required/);
  assert.equal(calls, 1); assert.equal(await readFile(file, "utf8"), raw);
  // Only a changed grant clears the fingerprint boundary; formatting cannot.
  await writeFile(file, JSON.stringify(JSON.parse(raw), null, 2));
  await assert.rejects(new KimiNativeAuthManager(file, "global", now, transport).credentials(signal()), /kimi_native_refresh_recovery_required/);
  assert.equal(calls, 1);
});

test("explicit invalid grant requires reauthorization without deleting/tombstoning credentials", async t => {
  const { file } = await fixture(t), raw = await readFile(file, "utf8"); let calls = 0;
  const transport: typeof fetch = async () => { calls++; return new Response(JSON.stringify({ error: "invalid_grant", error_description: "fake-secret" }), { status: 400 }); };
  for (let i = 0; i < 2; i++) await assert.rejects(new KimiNativeAuthManager(file, "global", now, transport).credentials(signal()), /kimi_native_reauthorization_required/);
  assert.equal(calls, 1); assert.equal(await readFile(file, "utf8"), raw);
});

test("429 is a temporary cooldown with a later bounded request, not logout", async t => {
  const { file } = await fixture(t); let time = now(), calls = 0;
  const transport: typeof fetch = async () => { calls++; return calls === 1 ? new Response("{}", { status: 429 }) : renewed(); };
  const manager = new KimiNativeAuthManager(file, "global", () => time, transport);
  await assert.rejects(manager.credentials(signal()), /kimi_native_refresh_busy/);
  await assert.rejects(manager.credentials(signal()), /kimi_native_refresh_busy/); assert.equal(calls, 1);
  time += 30001; assert.equal((await manager.credentials(signal())).authHeaders.authorization, "Bearer fake-renewed"); assert.equal(calls, 2);
});

test("non-cooperating native rotation during denied refresh is adopted and never overwritten", async t => {
  const { file } = await fixture(t);
  const manager = new KimiNativeAuthManager(file, "global", now, async () => {
    await writeFile(file + ".peer", JSON.stringify(record("fake-peer", Math.floor(now() / 1000) + 3600)), { mode: 0o600 });
    await rename(file + ".peer", file);
    return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
  });
  const result = await manager.credentials(signal()); assert.equal(result.authHeaders.authorization, "Bearer fake-peer");
  assert.equal(result.generation, nativeFingerprint("fake-peer"));
  assert.equal(JSON.parse(await readFile(file, "utf8")).access_token, "fake-peer");
});

for (const unsafe of ["oauth-symlink", "marker-symlink", "sentinel-symlink", "lock-symlink", "unsafe-oauth-mode"] as const)
test(`${unsafe}: fails closed before refresh and preserves unrelated targets`, async t => {
  const { root, file, lock } = await fixture(t); const target = join(root, "unrelated"); await writeFile(target, "fake-unrelated", { mode: 0o600 });
  if (unsafe === "oauth-symlink") await symlink(root, join(root, "oauth"));
  else {
    await mkdir(dirname(lock), { mode: 0o700 });
    if (unsafe === "marker-symlink") await symlink(target, lock.slice(0, -5) + ".subswitch-renewal.json");
    if (unsafe === "sentinel-symlink") await symlink(target, lock.slice(0, -5));
    if (unsafe === "lock-symlink") await symlink(root, lock);
    if (unsafe === "unsafe-oauth-mode") await chmod(dirname(lock), 0o777);
  }
  let calls = 0;
  await assert.rejects(new KimiNativeAuthManager(file, "global", now, async () => { calls++; return renewed(); }).credentials(signal()), /^Error: kimi_native_/);
  assert.equal(calls, 0); assert.equal(await readFile(target, "utf8"), "fake-unrelated");
});

test("lost native lease prevents credential persistence and preserves successor lock", async t => {
  const { file, lock } = await fixture(t), raw = await readFile(file, "utf8");
  await assert.rejects(new KimiNativeAuthManager(file, "global", now, async () => {
    await rename(lock, lock + ".old"); await mkdir(lock, { mode: 0o700 }); return renewed();
  }).credentials(signal()), /kimi_native_lock_lost/);
  assert.equal(await readFile(file, "utf8"), raw); assert.ok((await lstat(lock)).isDirectory());
});

test("snapshot compare-and-swap refuses a peer replacement", async t => {
  const { file } = await fixture(t);
  await withNativeLease(file, signal(), async lease => {
    const before = await readNativeSnapshot(file, signal()); await writeFile(file, JSON.stringify(record("fake-peer")));
    assert.equal(await lease.replace(before, { ...before.record, access_token: "fake-unwanted" }), false);
  });
  assert.equal(JSON.parse(await readFile(file, "utf8")).access_token, "fake-peer");
});

test("heartbeat keeps the native five-second stale boundary alive during a slow renewal", async t => {
  const { file, lock } = await fixture(t);
  const manager = new KimiNativeAuthManager(file, "global", now, async () => {
    const first = await lstat(lock);
    await delay(5200);
    const after = await lstat(lock);
    assert.equal(first.ino, after.ino); assert.ok(after.mtimeMs > first.mtimeMs + 3000);
    assert.ok(Date.now() - after.mtimeMs < 2000);
    return renewed();
  });
  assert.equal((await manager.credentials(signal())).authHeaders.authorization, "Bearer fake-renewed");
});

test("lock contention is bounded and never steals a heartbeating native lock", async t => {
  const { root, file, lock } = await fixture(t); await mkdir(join(root, "oauth"), { mode: 0o700 });
  await mkdir(lock, { mode: 0o700 }); const before = await lstat(lock); let calls = 0;
  const heartbeat = setInterval(() => { const date = new Date(); void utimes(lock, date, date); }, 500);
  try { await assert.rejects(new KimiNativeAuthManager(file, "global", now, async () => { calls++; return renewed(); }).credentials(signal()), /kimi_native_lock_busy/); }
  finally { clearInterval(heartbeat); }
  assert.equal(calls, 0); assert.equal((await lstat(lock)).ino, before.ino);
});

test("late bearer failures across self-renewals coalesce without rejecting the current bearer", async t => {
  const { file } = await fixture(t); await writeFile(file, JSON.stringify(record("fake-access", Math.floor(now() / 1000) + 3600)));
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return renewed(`fake-renewed-${calls}`); });
  const profile: AccessProfile = { provider: "kimi", product: "kimi-code", region: "global", billing: "subscription", account: "fake", credential: { kind: "native-oauth", source: "kimi-code", authFile: file } };
  const auth = new ProfileAuth({ first: profile, alias: { ...profile, account: "alias" } }, noopLogger, {});
  const first = await auth.get("first", signal()), quota = auth.scope(first);
  const second = await auth.refresh("first", signal(), first);
  assert.equal(second.generation, first.generation); assert.equal(calls, 1);
  assert.equal((await auth.refresh("first", signal(), first)).authHeaders.authorization, "Bearer fake-renewed-1"); assert.equal(calls, 1);
  const third = await auth.refresh("first", signal(), second);
  assert.equal(third.generation, first.generation); assert.equal(third.authHeaders.authorization, "Bearer fake-renewed-2"); assert.equal(calls, 2);
  assert.deepEqual(auth.scope(third), quota); assert.deepEqual(auth.scope(await auth.get("alias", signal())), quota);
  assert.equal((await auth.refresh("first", signal(), second)).authHeaders.authorization, "Bearer fake-renewed-2"); assert.equal(calls, 2);
});

for (const protocol of ["messages", "responses"] as const)
test(`${protocol}: one 401 renewal preserves caller body, action lineage and quota`, async t => {
  const { file } = await fixture(t); await writeFile(file, JSON.stringify(record("fake-access", Math.floor(now() / 1000) + 3600)));
  let refreshes = 0;
  t.mock.method(globalThis, "fetch", async () => { refreshes++; return renewed(); });
  const profile: AccessProfile = { provider: "kimi", product: "kimi-code", region: "global", billing: "subscription", account: "fake", credential: { kind: "native-oauth", source: "kimi-code", authFile: file } };
  const auth = new ProfileAuth({ native: profile, alias: { ...profile, account: "alias" } }, noopLogger, {});
  const first = await auth.get("native", signal()), scope = auth.scope(first);
  const bodies: string[] = [], bearers: string[] = [];
  const attempts = new RoutedAttempts(auth, noopLogger, async (_url, init) => {
    bodies.push(String(init?.body)); bearers.push(new Headers(init?.headers).get("authorization")!);
    if (bodies.length === 1) return new Response("{}", { status: 401 });
    const frames = protocol === "messages" ? messageFrames(nativeEvents([{ type: "text", text: "fake-answer" }])) : [
      { type: "response.created", response: { id: "fake", status: "in_progress", output: [] } },
      { type: "response.completed", response: { id: "fake", status: "completed", output: [] } },
    ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    return new Response(frames.join(""), { headers: { "content-type": "text/event-stream" } });
  });
  const body = protocol === "messages" ? { model: "route", max_tokens: 256, system: "caller instructions", tools: [{ name: "caller_tool", input_schema: { type: "object" } }], messages: [{ role: "user", content: "caller history" }] }
    : { model: "route", max_output_tokens: 256, instructions: "caller instructions", tools: [{ type: "function", name: "caller_tool", parameters: { type: "object" } }], input: [{ role: "user", content: "caller history" }] };
  const prepared = await attempts.prepare({ profile, target: { profile: "native", model: "kimi-for-coding", effort: "high" }, body, protocol, credential: first, conversation: "fake", signal: signal(), refreshes: new Set() });
  try { for await (const _ of prepared.events) { /* validate terminal frame */ } } finally { await prepared.cancel(); }
  assert.equal(refreshes, 1); assert.equal(bodies.length, 2); assert.equal(bodies[0], bodies[1]);
  assert.match(bodies[1]!, /caller instructions/); assert.match(bodies[1]!, /caller history/); assert.match(bodies[1]!, /caller_tool/);
  assert.deepEqual(bearers, ["Bearer fake-access", "Bearer fake-renewed"]);
  const next = await auth.get("native", signal()); assert.equal(next.generation, first.generation); auth.validate(first);
  assert.deepEqual(auth.scope(next), scope); assert.deepEqual(auth.scope(await auth.get("alias", signal())), scope);
});
