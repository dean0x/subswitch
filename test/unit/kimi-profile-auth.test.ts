import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { KimiAuthManager, type KimiCredential } from "../../src/kimi-auth.js";
import type { KimiAuthStore } from "../../src/kimi-auth-store.js";
import { ProfileAuth } from "../../src/routing/profile-auth.js";
import type { AccessProfile } from "../../src/routing/routing-types.js";
import { noopLogger } from "../../src/logger.js";

const profile: AccessProfile = { provider: "kimi", product: "kimi-code", billing: "subscription", region: "global", account: "personal", credential: { kind: "native-oauth", authFile: "/fabricated/private/auth.json" } };
const credential = (generation: string): KimiCredential => ({ provider: "kimi", generation, deviceId: "fabricated-device", authHeaders: { authorization: "Bearer fabricated-access" } });
function fixture(t: TestContext) {
  const manager = new KimiAuthManager({ store: {} as KimiAuthStore, region: "global" });
  const replies: (() => Promise<KimiCredential>)[] = [];
  t.mock.method(manager, "credentials", () => replies.shift()!());
  const profiles = { first: profile, alias: { ...profile, account: "another-label" } };
  return { auth: new ProfileAuth(profiles, noopLogger, {}, () => manager), replies };
}
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
