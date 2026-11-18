/** Fabricated native refresh; no credential files or provider calls. */
import assert from "node:assert/strict";
import { it } from "node:test";
import { noopLogger } from "../../src/logger.js";
import { ProfileAuth, type BoundCredential } from "../../src/routing/profile-auth.js";

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
