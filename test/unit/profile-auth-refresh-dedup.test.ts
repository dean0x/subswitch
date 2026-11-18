/** Fabricated native refresh; no credential files or provider calls. */
import assert from "node:assert/strict";
import { it } from "node:test";
import { noopLogger } from "../../src/logger.js";
import { ProfileAuth, type BoundCredential } from "../../src/routing/profile-auth.js";
import type { AccessProfile } from "../../src/routing/routing-types.js";

const codex: AccessProfile = {
  provider: "codex", product: "chatgpt-codex", billing: "subscription", account: "fabricated",
  credential: { kind: "native-oauth", authFile: "/fabricated/never-read.json" },
};
const mismatch: AccessProfile = {
  ...codex, product: "claude-code",
  credential: {
    kind: "native-oauth",
    get authFile(): string { return assert.fail("mismatched credential path was inspected"); },
  },
};
const codexCredential: BoundCredential = {
  provider: "codex", profile: "native", generation: "fabricated-generation", binding: "fabricated-binding",
  authHeaders: { authorization: "Bearer fabricated-refresh" },
};

it("rejects a provider and product mismatch before inspecting the credential path", async () => {
  const auth = new ProfileAuth({ native: mismatch }, noopLogger);
  const signal = new AbortController().signal;
  assert.equal(auth.has("native"), false);
  await assert.rejects(auth.get("native", signal), /credential_product_mismatch/);
  await assert.rejects(auth.refresh("native", signal), /credential_product_mismatch/);
});

it("does not reuse a pending refresh after a provider and product mismatch", async t => {
  const profiles = { native: codex };
  const auth = new ProfileAuth(profiles, noopLogger);
  let finish!: (value: BoundCredential) => void;
  const pending = new Promise<BoundCredential>(resolve => { finish = resolve; });
  const get = t.mock.method(auth, "get", () => pending);
  const signal = new AbortController().signal;
  const first = auth.refresh("native", signal);
  try {
    await Promise.resolve();
    assert.equal(get.mock.callCount(), 1, "the supported refresh is in flight");
    profiles.native = mismatch;
    const rejected = assert.rejects(auth.refresh("native", signal), /credential_product_mismatch/);
    finish(codexCredential);
    await rejected;
    assert.equal(await first, codexCredential);
    assert.equal(get.mock.callCount(), 1);
  } finally {
    finish(codexCredential);
    await first;
  }
});

it("does not start a refresh for an already aborted caller", async t => {
  const auth = new ProfileAuth({ native: codex }, noopLogger);
  const get = t.mock.method(auth, "get", async () => codexCredential);
  const caller = new AbortController();
  caller.abort();
  // Observe an unexpected asynchronous rejection as well as the expected synchronous one.
  assert.throws(() => { void auth.refresh("native", caller.signal).catch(() => {}); }, { name: "AbortError" });
  await Promise.resolve();
  assert.equal(get.mock.callCount(), 0);
  assert.equal(await auth.refresh("native", new AbortController().signal), codexCredential);
  assert.equal(get.mock.callCount(), 1);
});

for (const provider of ["claude", "codex"] as const) {
  it(`preserves ${provider} refresh deduplication when one waiter cancels`, async t => {
    const auth = new ProfileAuth({ native: {
      provider, product: provider === "claude" ? "claude-code" : "chatgpt-codex",
      billing: "subscription", account: "fabricated",
      credential: { kind: "native-oauth", authFile: "/fabricated/never-read.json" },
    } }, noopLogger);
    const credential: BoundCredential = {
      provider, profile: "native", generation: "fabricated-generation", binding: "fabricated-binding",
      authHeaders: { authorization: "Bearer fabricated-refresh" },
    };
    let finish!: (value: BoundCredential) => void;
    const pending = new Promise<BoundCredential>(resolve => { finish = resolve; });
    const get = t.mock.method(auth, "get", (id: string, _signal: AbortSignal, refresh = false) => {
      assert.equal(id, "native");
      assert.equal(refresh, true);
      return pending;
    });
    const cancelled = new AbortController();
    const rejected = assert.rejects(auth.refresh("native", cancelled.signal), { name: "AbortError" });
    const remaining = auth.refresh("native", new AbortController().signal);
    try {
      cancelled.abort();
      await rejected;
      assert.equal(get.mock.callCount(), 1);
      assert.equal(get.mock.calls[0]?.arguments[1].aborted, false);
      finish(credential);
      assert.equal(await remaining, credential);
      assert.equal(await auth.refresh("native", new AbortController().signal), credential);
      assert.equal(get.mock.callCount(), 2, "a completed refresh leaves no pending cache entry");
    } finally {
      finish(credential);
      await remaining;
    }
  });
}
