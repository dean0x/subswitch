/** Fabricated private files only. No installed client, native home or network. */
import assert from "node:assert/strict";
import { renameSync, writeFileSync } from "node:fs";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { KimiNativeAuthManager, kimiNativeTokenFilename } from "../../src/kimi-native-auth.js";
import { inspectKimiProfiles } from "../../src/kimi-doctor.js";
import { loadConfig } from "../../src/config.js";
import { ProfileAuth } from "../../src/routing/profile-auth.js";
import { RoutedAttempts } from "../../src/routing/routed-attempt.js";
import { ownerKey } from "../../src/routing/continuation-store.js";
import type { AccessProfile, Item } from "../../src/routing/routing-types.js";
import { noopLogger } from "../../src/logger.js";
import { aggregateFrames } from "../../src/codex-response.js";
import { nativeEvents, messageFrames } from "../fixtures/native-messages.js";

const signal = () => AbortSignal.timeout(2000);
const token = (access = "fabricated-access", expires = Math.floor(Date.now() / 1000) + 3600) => ({
  access_token: access, refresh_token: "fabricated-refresh-do-not-use", expires_at: expires,
  token_type: "Bearer", scope: "fabricated-scope", expires_in: 3600,
});
async function fixture(t: TestContext, region: "global" | "mainland-cn" = "global") {
  const root = await mkdtemp(join(await realpath(tmpdir()), "subswitch-native-kimi-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "credentials"); await mkdir(directory, { mode: 0o700 });
  const authFile = join(directory, kimiNativeTokenFilename(region));
  const raw = JSON.stringify(token()); await writeFile(authFile, raw, { mode: 0o600 });
  const profile: AccessProfile = { provider: "kimi", product: "kimi-code", region, billing: "subscription", account: "fabricated",
    credential: { kind: "native-oauth", source: "kimi-code", authFile } };
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));
  return { root, directory, authFile, raw, profile };
}

for (const region of ["global", "mainland-cn"] as const) test(`native ${region} access uses truthful Subswitch identity without changing native files`, async t => {
  const { directory, authFile, raw, profile } = await fixture(t, region);
  const before = await lstat(authFile);
  const auth = new ProfileAuth({ native: profile }, noopLogger, { KIMI_CODE_OAUTH_HOST: "https://fabricated.invalid", KIMI_CODE_HOME: "/fabricated/never-read" });
  const value = await auth.get("native", signal());
  assert.deepEqual(value.authHeaders, { authorization: "Bearer fabricated-access" });
  const identity = auth.identity(value);
  assert.match(identity["user-agent"]!, /^subswitch\//);
  assert.equal(identity["x-msh-platform"], "subswitch");
  assert.match(identity["x-msh-device-id"]!, /^[0-9a-f-]{36}$/);
  assert.doesNotMatch(JSON.stringify(value) + JSON.stringify(identity), /fabricated-refresh|fabricated-scope/);
  const after = await lstat(authFile);
  assert.deepEqual([after.ino, after.size, after.mtimeMs, after.ctimeMs, after.mode], [before.ino, before.size, before.mtimeMs, before.ctimeMs, before.mode]);
  assert.equal(await readFile(authFile, "utf8"), raw);
  assert.deepEqual(await readdir(directory), [kimiNativeTokenFilename(region)]);
});

test("invalid grants refuse the rejected token until its native owner replaces it", async t => {
  const { authFile } = await fixture(t);
  const manager = new KimiNativeAuthManager(authFile, "global");
  const first = await manager.credentials(signal());
  await assert.rejects(manager.credentials(signal(), true, first.generation), /kimi_native_reauthorization_required/);
  await assert.rejects(manager.credentials(signal()), /kimi_native_reauthorization_required/);
  const replacement = `${authFile}.replacement`;
  await writeFile(replacement, JSON.stringify(token("fabricated-rotated")), { mode: 0o600 });
  await rename(replacement, authFile);
  const next = await manager.credentials(signal(), true, first.generation);
  assert.equal(next.authHeaders["authorization"], "Bearer fabricated-rotated");
  assert.notEqual(first.generation, next.generation); assert.equal(first.deviceId, next.deviceId);
});

test("native force requires an exact failed credential, not the last observed bearer", async t => {
  const { authFile, raw } = await fixture(t);
  const manager = new KimiNativeAuthManager(authFile, "global");
  await manager.credentials(signal());
  await assert.rejects(manager.credentials(signal(), true), /kimi_native_refresh_required/);
  await assert.rejects(manager.credentials(signal(), true, "fabricated-invalid"), /kimi_native_refresh_required/);
  assert.equal(await readFile(authFile, "utf8"), raw);
});

test("late 401s reject only their dispatched bearer and aliases share rejection state", async t => {
  const { authFile, profile } = await fixture(t);
  const auth = new ProfileAuth({ first: profile, alias: { ...profile, account: "another-label" } }, noopLogger, {});
  const first = await auth.get("first", signal());
  await writeFile(authFile, JSON.stringify(token("fabricated-second")));
  const second = await auth.get("alias", signal());
  const refreshed = await auth.refresh("first", signal(), first);
  assert.equal(refreshed.authHeaders.authorization, "Bearer fabricated-second");
  auth.validate(second);
  assert.equal((await auth.get("alias", signal())).generation, second.generation);
  await assert.rejects(auth.refresh("alias", signal()), /kimi_native_refresh_required/);
  await assert.rejects(auth.refresh("alias", signal(), { ...second }), /kimi_native_refresh_required/);
  await assert.rejects(auth.refresh("alias", signal(), second), /kimi_native_reauthorization_required/);
  await assert.rejects(auth.get("first", signal()), /kimi_native_reauthorization_required/);
  // An even later T1 failure must not clear the independent T2 rejection.
  await assert.rejects(auth.refresh("first", signal(), first), /kimi_native_reauthorization_required/);
  await assert.rejects(auth.get("alias", signal()), /kimi_native_reauthorization_required/);
});

for (const protocol of ["messages", "responses"] as const) for (const rotated of [false, true])
test(`${protocol}: native 401 ${rotated ? "with overlapping rotation requires a new action" : "refuses the unchanged bearer without retry"}`, async t => {
  const { authFile, profile } = await fixture(t);
  const auth = new ProfileAuth({ first: profile, alias: { ...profile, account: "another-label" } }, noopLogger, {});
  const first = await auth.get("first", signal()), scope = auth.scope(first);
  const target = { profile: "first", model: "kimi-for-coding", effort: "high" };
  const body: Item = protocol === "messages"
    ? { model: "route", max_tokens: 256, system: "Caller system", tools: [{ name: "caller_read", input_schema: { type: "object" } }], messages: [{ role: "user", content: "Caller history" }, { role: "assistant", content: [{ type: "tool_use", id: "caller-tool:7", name: "caller_read", input: {} }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "caller-tool:7", content: "Caller result" }] }] }
    : { model: "route", max_output_tokens: 256, instructions: "Caller system", tools: [{ type: "function", name: "caller_read", parameters: { type: "object" } }], input: [{ role: "user", content: "Caller history" }, { type: "function_call", id: "caller-item:7", call_id: "caller-tool:7", name: "caller_read", arguments: "{}" }, { type: "function_call_output", call_id: "caller-tool:7", output: "Caller result" }] };
  let enter!: () => void, release!: (response: Response) => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const held = new Promise<Response>(resolve => { release = resolve; });
  const requests: { body: Item; authorization: string | null }[] = [];
  const attempts = new RoutedAttempts(auth, noopLogger, async (_url, init) => {
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("x-msh-platform"), "subswitch");
    requests.push({ body: JSON.parse(String(init?.body)), authorization: headers.get("authorization") });
    if (requests.length === 1) { enter(); return held; }
    const item: Item = { type: "message", id: "fabricated-answer", role: "assistant", status: "completed", content: [{ type: "output_text", text: "fabricated-answer", annotations: [] }] };
    const frames = protocol === "messages" ? messageFrames(nativeEvents([{ type: "text", text: "fabricated-answer" }])) : [
      { type: "response.created", response: { id: "fabricated-response", status: "in_progress", output: [] } },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: "fabricated-response", status: "completed", output: [item] } },
    ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    return new Response(frames.join(""), { headers: { "content-type": "text/event-stream" } });
  });
  const request = { profile, target, body, protocol, conversation: "fabricated-conversation", signal: signal(), refreshes: new Set<string>() };
  const pending = assert.rejects(attempts.prepare({ ...request, credential: first }), rotated ? /credential_owner_changed/ : /kimi_native_reauthorization_required/);
  await entered;
  if (rotated) {
    const replacement = `${authFile}.replacement`;
    await writeFile(replacement, JSON.stringify(token("fabricated-second")), { mode: 0o600 });
    await rename(replacement, authFile);
    // Request B observes T2 while request A's T1 response remains outstanding.
    assert.deepEqual(auth.scope(await auth.get("alias", signal())), scope);
  }
  release(new Response("{}", { status: 401 })); await pending;
  assert.equal(requests.length, 1, "401 never dispatches a native retry");
  if (!rotated) {
    await assert.rejects(auth.get("alias", signal()), /kimi_native_reauthorization_required/);
    return;
  }
  await assert.rejects(attempts.prepare({ ...request, refreshes: new Set(), expectedOwner: ownerKey(profile, target, protocol, first.generation) }), /credential_owner_changed/);
  assert.equal(requests.length, 1, "old action ownership cannot adopt T2");
  const prepared = await attempts.prepare({ ...request, refreshes: new Set() });
  try {
    const events = []; for await (const event of prepared.events) events.push(event);
    const answer = protocol === "messages"
      ? aggregateFrames(events.map(event => `event: ${event.payload.type}\ndata: ${JSON.stringify(event.payload)}\n\n`), "codex") : events;
    assert.match(JSON.stringify(answer), /fabricated-answer/); prepared.commit();
  } finally { await prepared.cancel(); }
  assert.equal(requests.length, 2);
  assert.equal(requests[0]!.authorization, "Bearer fabricated-access");
  assert.equal(requests[1]!.authorization, "Bearer fabricated-second");
  assert.deepEqual(requests[1]!.body, requests[0]!.body);
  assert.deepEqual(requests[1]!.body.tools, body.tools);
  assert.match(JSON.stringify(requests[1]!.body), /caller-tool:7/);
  assert.match(JSON.stringify(requests[1]!.body), /Caller result/);
});

test("token rotation invalidates aliases but preserves a conservative source allowance", async t => {
  const { authFile, profile } = await fixture(t);
  const auth = new ProfileAuth({ first: profile, alias: { ...profile, account: "another-label" } }, noopLogger, {});
  const first = await auth.get("first", signal());
  const sibling = await auth.get("alias", signal());
  const scope = auth.scope(first); assert.deepEqual(auth.scope(sibling), scope);
  await writeFile(authFile, JSON.stringify(token("fabricated-replacement-login")));
  const next = await auth.get("alias", signal());
  assert.throws(() => auth.validate(first)); assert.throws(() => auth.validate(sibling));
  assert.deepEqual(auth.scope(next), scope);
  await rm(authFile);
  await assert.rejects(auth.get("alias", signal()), /kimi_native_unavailable/);
  assert.throws(() => auth.validate(next));
  await writeFile(authFile, JSON.stringify(token("fabricated-third")), { mode: 0o600 });
  assert.deepEqual(auth.scope(await auth.get("first", signal())), scope);
});

test("read-only inspection reports renewal due without renewing and rejects revoked tombstones", async t => {
  const { authFile } = await fixture(t);
  for (const expires of [1, Math.floor(Date.now() / 1000) + 10]) {
    const raw = JSON.stringify(token("fabricated-access", expires)); await writeFile(authFile, raw);
    assert.deepEqual(await new KimiNativeAuthManager(authFile, "global").inspect(signal()), { renewalDue: true });
    assert.equal(await readFile(authFile, "utf8"), raw);
  }
  await writeFile(authFile, JSON.stringify({ ...token("", 0), refresh_token: "" }));
  await assert.rejects(new KimiNativeAuthManager(authFile, "global").inspect(signal()), /kimi_native_reauthorization_required/);
});

test("native records reject malformed/oversized data with fixed secret-free errors", async t => {
  const { authFile } = await fixture(t);
  for (const raw of ["fabricated-secret-not-json", "[]", "null", JSON.stringify({ ...token(), access_token: "fabricated-secret\n" }), JSON.stringify({ ...token(), token_type: "Basic" }), JSON.stringify({ ...token(), expires_at: "fabricated-secret" }), JSON.stringify({ ...token(), expires_at: 1.5 }), JSON.stringify({ ...token(), expires_at: Number.MAX_SAFE_INTEGER }), "fabricated-secret".repeat(5000)]) {
    await writeFile(authFile, raw);
    await assert.rejects(new KimiNativeAuthManager(authFile, "global").credentials(signal()), error => {
      assert.ok(error instanceof Error); assert.match(error.message, /^kimi_native_(invalid_record|unavailable)$/);
      assert.doesNotMatch(JSON.stringify(error) + error.message, /fabricated-secret|refresh_token|access_token/); return true;
    });
  }
});

test("wrong region and unsupported slots are rejected before reading files", () => {
  for (const path of ["relative/credentials/kimi-code.json", "/fabricated/credentials/kimi-code.json", "/fabricated/other/" + kimiNativeTokenFilename("global"), "/fabricated/credentials/../credentials/" + kimiNativeTokenFilename("global"), "/fabricated/credentials/" + kimiNativeTokenFilename("global") + "\0"]) {
    assert.throws(() => new KimiNativeAuthManager(path, "global"), /kimi_native_region_store_mismatch/);
  }
});

test("native reader rejects symlink files and ancestors without changing targets", async t => {
  const { root, directory, authFile, raw } = await fixture(t);
  const target = join(root, "target"); await rename(authFile, target); await symlink(target, authFile);
  await assert.rejects(new KimiNativeAuthManager(authFile, "global").credentials(signal()), /kimi_native_unsafe_path/);
  assert.equal(await readFile(target, "utf8"), raw);
  await rm(authFile); await rename(target, authFile);
  await rename(directory, join(root, "real-credentials")); await symlink(join(root, "real-credentials"), directory);
  await assert.rejects(new KimiNativeAuthManager(authFile, "global").credentials(signal()), /kimi_native_unsafe_path/);
});

test("native reader rejects hardlinks, unsafe modes and foreign ownership", async t => {
  const { root, directory, authFile } = await fixture(t);
  const manager = new KimiNativeAuthManager(authFile, "global");
  await link(authFile, join(root, "link"));
  await assert.rejects(manager.credentials(signal()), /kimi_native_unsafe_path/); await rm(join(root, "link"));
  for (const path of [authFile, directory]) {
    await chmod(path, 0o755);
    await assert.rejects(manager.credentials(signal()), /kimi_native_unsafe_path/);
    await chmod(path, path === authFile ? 0o600 : 0o700);
  }
  if (process.getuid) {
    const uid = process.getuid(); const mock = t.mock.method(process as { getuid(): number }, "getuid", () => uid + 1);
    try { await assert.rejects(manager.credentials(signal()), /kimi_native_unsafe_path/); }
    finally { mock.mock.restore(); }
  }
});

for (const replaceDirectory of [false, true]) test(`descriptor read refuses concurrent ${replaceDirectory ? "directory" : "file"} replacement`, async t => {
  const { directory, authFile } = await fixture(t);
  const replacement = replaceDirectory ? `${directory}.replacement` : `${authFile}.replacement`;
  if (replaceDirectory) { await mkdir(replacement, { mode: 0o700 }); await writeFile(join(replacement, kimiNativeTokenFilename("global")), JSON.stringify(token()), { mode: 0o600 }); }
  else await writeFile(replacement, JSON.stringify(token()), { mode: 0o600 });
  const allocate = Buffer.alloc;
  const mock = t.mock.method(Buffer, "alloc", ((size: number) => {
    const buffer = allocate(size);
    if (size === 64 * 1024 + 1) {
      if (replaceDirectory) { renameSync(directory, `${directory}.old`); renameSync(replacement, directory); }
      else renameSync(replacement, authFile);
    }
    return buffer;
  }) as typeof Buffer.alloc);
  // Atomic replacement can unlink the open inode (nlink=0), which is also an
  // unsafe-path refusal; directory replacement retains its inode until cleanup.
  try { await assert.rejects(new KimiNativeAuthManager(authFile, "global").credentials(signal()), replaceDirectory ? /kimi_native_changed/ : /kimi_native_(changed|unsafe_path)/); }
  finally { mock.mock.restore(); }
});

test("descriptor read refuses in-place mutation", async t => {
  const { authFile } = await fixture(t); const allocate = Buffer.alloc;
  const mock = t.mock.method(Buffer, "alloc", ((size: number) => {
    const buffer = allocate(size);
    if (size === 64 * 1024 + 1) writeFileSync(authFile, JSON.stringify(token("fabricated-mutated-longer")));
    return buffer;
  }) as typeof Buffer.alloc);
  try { await assert.rejects(new KimiNativeAuthManager(authFile, "global").credentials(signal()), /kimi_native_changed/); }
  finally { mock.mock.restore(); }
});

test("pre-aborted reads reveal no raw cancellation reason and perform no write", async t => {
  const { authFile, raw } = await fixture(t);
  const controller = new AbortController(); controller.abort(new Error("fabricated-secret-abort"));
  await assert.rejects(new KimiNativeAuthManager(authFile, "global").credentials(controller.signal), { message: "kimi_native_cancelled" });
  assert.equal(await readFile(authFile, "utf8"), raw);
});

test("native selection is explicit, Kimi-only, and region-bound in config", async t => {
  const { profile, authFile } = await fixture(t);
  for (const [changes, ok] of [[{}, true], [{ provider: "codex", product: "chatgpt-codex", region: undefined }, false], [{ region: "mainland-cn" }, false], [{ baseUrl: "https://fabricated.invalid/coding" }, false], [{ credential: { kind: "native-oauth", source: "other", authFile } }, false]] as const) {
    const loaded = loadConfig({ configPath: "/fabricated/config.json", env: {}, readFile: () => JSON.stringify({ configVersion: 2, accessProfiles: { native: { ...profile, ...changes } } }) });
    assert.equal(loaded.ok, ok);
  }
  const codex: AccessProfile = { ...profile, provider: "codex", product: "chatgpt-codex", region: undefined };
  const auth = new ProfileAuth({ unsupported: codex }, noopLogger, {});
  assert.equal(auth.has("unsupported"), false);
  await assert.rejects(auth.get("unsupported", signal()), /credential_product_mismatch/);
});

test("doctor reports automatic renewal and fails closed without exposing file/token data", async t => {
  const { authFile, profile } = await fixture(t); const lines: string[] = [];
  assert.equal(await inspectKimiProfiles({ native: profile }, line => lines.push(line)), 0);
  assert.match(lines[0]!, /automatic renewal available/);
  await writeFile(authFile, JSON.stringify(token("fabricated-access", 1)));
  assert.equal(await inspectKimiProfiles({ native: profile }, line => lines.push(line)), 0);
  assert.match(lines.at(-1)!, /automatic renewal due/);
  assert.doesNotMatch(lines.join("\n"), /fabricated-access|fabricated-refresh|credentials\//);
});
