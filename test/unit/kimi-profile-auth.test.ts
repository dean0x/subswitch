import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { KimiAuthManager, type KimiCredential } from "../../src/kimi-auth.js";
import type { KimiAuthStore } from "../../src/kimi-auth-store.js";
import { ProfileAuth } from "../../src/routing/profile-auth.js";
import type { AccessProfile } from "../../src/routing/routing-types.js";
import { loadConfig } from "../../src/config.js";
import { noopLogger } from "../../src/logger.js";

const profile: AccessProfile = { provider: "kimi", product: "kimi-code", billing: "subscription", region: "global", account: "personal", credential: { kind: "native-oauth", authFile: "/fabricated/private/auth.json" } };
const credential = (generation: string): KimiCredential => ({ provider: "kimi", generation, deviceId: "fabricated-device", authHeaders: { authorization: "Bearer fabricated-access" } });
function fixture(t: TestContext) {
  const manager = new KimiAuthManager({ store: {} as KimiAuthStore, region: "global" });
  const replies: (() => Promise<KimiCredential>)[] = [];
  t.mock.method(manager, "credentials", () => replies.shift()!());
  const profiles = { first: profile, alias: { ...profile, account: "another-label" } };
  return { auth: new ProfileAuth(profiles, noopLogger, () => manager), replies };
}
for (const region of ["global", "mainland-cn"] as const) for (const suffix of ["", "/"])
test(`${region} default HTTPS port passes startup and runtime OAuth checks${suffix}`, async t => {
  const p: AccessProfile = { ...profile, region, baseUrl: `https://API.KIMI.${region === "global" ? "AI" : "COM"}:443/coding${suffix}` };
  const loaded = loadConfig({ configPath: "/fabricated/config.json", env: {},
    readFile: () => JSON.stringify({ configVersion: 2, accessProfiles: { kimi: p } }) });
  assert.equal(loaded.ok, true);
  const manager = new KimiAuthManager({ store: {} as KimiAuthStore, region });
  t.mock.method(manager, "credentials", async () => credential("fake-login"));
  const auth = new ProfileAuth({ kimi: p }, noopLogger, () => manager);
  assert.equal((await auth.get("kimi", new AbortController().signal)).authHeaders.authorization, "Bearer fabricated-access");
  assert.equal((await auth.refresh("kimi", new AbortController().signal)).authHeaders.authorization, "Bearer fabricated-access");
});

for (const baseUrl of ["https://fabricated.invalid/coding", "https://api.kimi.com/coding", "https://api.kimi.ai:444/coding",
  "http://api.kimi.ai/coding", "https://api.kimi.ai/coding/v1", "https://api.kimi.ai/coding?x=1", "https://api.kimi.ai/coding#x",
  "https://fake@api.kimi.ai/coding", "not-a-url"])
test(`runtime OAuth endpoint check refuses ${baseUrl} before credential construction`, async () => {
  const p: AccessProfile = { ...profile, baseUrl, allowInsecureBaseUrl: true };
  let calls = 0;
  const auth = new ProfileAuth({ kimi: p }, noopLogger, () => { calls++; return assert.fail("credential factory must not run"); });
  await assert.rejects(auth.get("kimi", new AbortController().signal), { code: "kimi_oauth_endpoint_mismatch" });
  await assert.rejects(auth.refresh("kimi", new AbortController().signal), { code: "kimi_oauth_endpoint_mismatch" });
  assert.equal(calls, 0);
  if (baseUrl !== "not-a-url") {
    const loaded = loadConfig({ configPath: "/fabricated/config.json", env: {},
      readFile: () => JSON.stringify({ configVersion: 2, accessProfiles: { kimi: p } }) });
    assert.equal(loaded.ok, false);
    if (!loaded.ok) assert.match(loaded.error.message, /kimi_oauth_endpoint_mismatch/);
  }
});

test("runtime OAuth endpoint check refuses a missing region before credential construction", async () => {
  let calls = 0;
  const auth = new ProfileAuth({ kimi: { ...profile, region: undefined } }, noopLogger, () => { calls++; return assert.fail("credential factory must not run"); });
  await assert.rejects(auth.get("kimi", new AbortController().signal), { code: "kimi_oauth_endpoint_mismatch" });
  assert.equal(calls, 0);
});

test("Kimi quota follows persistent login lineage across transient read failure and aliases", async t => {
  const { auth, replies } = fixture(t), signal = AbortSignal.timeout(1000);
  replies.push(async () => credential("login-A")); const first = await auth.get("first", signal); const scope = auth.scope(first);
  replies.push(async () => credential("login-A")); assert.deepEqual(auth.scope(await auth.get("alias", signal)), scope);
  replies.push(async () => { throw new Error("fabricated-store-missing"); }); await assert.rejects(auth.get("first", signal));
  assert.throws(() => auth.validate(first));
  replies.push(async () => credential("login-B")); const replacement = await auth.get("first", signal);
  assert.notDeepEqual(auth.scope(replacement), scope);
});
test("one cancelled alias cannot invalidate a valid sibling credential", async t => {
  const { auth, replies } = fixture(t), signal = AbortSignal.timeout(1000);
  replies.push(async () => credential("login-A")); const sibling = await auth.get("alias", signal);
  const cancelled = new AbortController(); replies.push(async () => { cancelled.abort(); throw new Error("fabricated-cancelled"); });
  await assert.rejects(auth.get("first", cancelled.signal)); assert.doesNotThrow(() => auth.validate(sibling));
});
test("pre-aborted refresh performs no manager work and creates no pending rejection", async t => {
  const { auth, replies } = fixture(t);
  const cancelled = new AbortController(); cancelled.abort();
  assert.throws(() => auth.refresh("first", cancelled.signal), { name: "AbortError" });
  replies.push(async () => credential("login-A"));
  const valid = await auth.refresh("first", AbortSignal.timeout(1000));
  assert.doesNotThrow(() => auth.validate(valid));
  assert.equal(replies.length, 0);
});
for (const fails of [false, true]) test(`late old-owner ${fails ? "failure" : "success"} cannot invalidate/revert a published replacement`, async t => {
  const { auth, replies } = fixture(t), signal = AbortSignal.timeout(1000);
  let release!: (value: KimiCredential) => void;
  replies.push(() => new Promise<KimiCredential>((resolve, reject) => { release = value => fails ? reject(new Error("fabricated-old-store-failure")) : resolve(value); }));
  const old = auth.get("first", signal); const rejected = assert.rejects(old);
  replies.push(async () => credential("login-B")); const current = await auth.get("alias", signal); const scope = auth.scope(current);
  release(credential("login-A")); await rejected;
  assert.doesNotThrow(() => auth.validate(current)); assert.deepEqual(auth.scope(current), scope);
});
