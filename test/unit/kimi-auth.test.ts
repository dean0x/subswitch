/** Offline credential boundaries; all profiles, paths and keys are fabricated. */
import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { loadConfig } from "../../src/config.js";
import { noopLogger } from "../../src/logger.js";
import { ProfileAuth, type BoundCredential } from "../../src/routing/profile-auth.js";
import type { AccessProfile } from "../../src/routing/routing-types.js";

/** Park a fabricated refresh without constructing a native manager or reading a file. */
function controlledRefresh(t: TestContext, provider: "claude" | "codex") {
  const profiles: Record<string, AccessProfile> = {
    native: {
      provider, product: provider === "claude" ? "claude-code" : "chatgpt-codex",
      billing: "subscription", account: "fabricated",
      credential: { kind: "native-oauth", authFile: "/fabricated/never-read.json" },
    },
  };
  const auth = new ProfileAuth(profiles, noopLogger, {});
  const credential: BoundCredential = {
    provider, profile: "native", generation: "fabricated-generation", binding: "fabricated-binding",
    authHeaders: { authorization: "Bearer fabricated-refresh" },
  };
  let resolve!: (value: BoundCredential) => void;
  const pending = new Promise<BoundCredential>(done => { resolve = done; });
  const get = t.mock.method(auth, "get", (id: string, _signal: AbortSignal, refresh = false) => {
    assert.equal(id, "native");
    assert.equal(refresh, true);
    return pending;
  });
  return { auth, profiles, credential, get, finish: () => resolve(credential) };
}

describe("Kimi authentication support boundary", () => {
  for (const product of ["kimi-code", "kimi-platform"] as const) {
    const profile: AccessProfile = {
      provider: "kimi", product, region: "global",
      billing: product === "kimi-code" ? "subscription" : "api",
      account: "synthetic", credential: { kind: "env", name: "SYNTHETIC_KEY" },
    };

    it(`rejects ${product} native OAuth in configuration`, () => {
      const loaded = loadConfig({
        configPath: "/fabricated/config.json", env: {},
        readFile: () => JSON.stringify({
          configVersion: 2,
          accessProfiles: {
            kimi: { ...profile, credential: { kind: "native-oauth", authFile: "/fabricated/auth.json" } },
          },
        }),
      });
      assert.equal(loaded.ok, false);
      if (!loaded.ok) assert.match(loaded.error.message, /credential_product_mismatch/);
    });

    it(`rejects programmatic ${product} OAuth before inspecting a credential path`, async () => {
      const auth = new ProfileAuth({
        kimi: {
          ...profile,
          credential: {
            kind: "native-oauth",
            get authFile(): string {
              return assert.fail("unsupported native credential path was inspected");
            },
          },
        },
      }, noopLogger, {});
      assert.equal(auth.has("kimi"), false);
      await assert.rejects(auth.get("kimi", new AbortController().signal), /credential_product_mismatch/);
      await assert.rejects(auth.refresh("kimi", new AbortController().signal), /credential_product_mismatch/);
    });

    it(`rejects ${product} OAuth before reusing a supported pending refresh`, async t => {
      const fixture = controlledRefresh(t, "claude");
      const first = fixture.auth.refresh("native", new AbortController().signal);
      try {
        fixture.profiles.native = {
          ...profile,
          credential: {
            kind: "native-oauth",
            get authFile(): string {
              return assert.fail("unsupported native credential path was inspected");
            },
          },
        };
        const rejected = assert.rejects(
          fixture.auth.refresh("native", new AbortController().signal),
          /credential_product_mismatch/,
        );
        fixture.finish();
        await rejected;
        assert.equal(await first, fixture.credential);
        assert.equal(fixture.get.mock.callCount(), 1);
      } finally {
        fixture.finish();
        await first;
      }
    });

    it(`binds ${product} only to its explicitly named environment key`, async () => {
      const auth = new ProfileAuth({ kimi: profile }, noopLogger, {
        SYNTHETIC_KEY: "fabricated-kimi-key",
        ANTHROPIC_API_KEY: "fabricated-unrelated-key",
      });
      const credential = await auth.get("kimi", new AbortController().signal);
      assert.equal(credential.provider, "kimi");
      assert.deepEqual(credential.authHeaders, { authorization: "Bearer fabricated-kimi-key" });
      assert.equal(auth.scope(credential).product, product);
      assert.throws(() => auth.refresh("kimi", new AbortController().signal), /profile_not_refreshable/);
    });
  }

  for (const provider of ["claude", "codex"] as const) {
    it(`preserves ${provider} refresh deduplication when one waiter cancels`, async t => {
      const fixture = controlledRefresh(t, provider);
      const cancelled = new AbortController();
      const first = fixture.auth.refresh("native", cancelled.signal);
      const rejected = assert.rejects(first, { name: "AbortError" });
      const remaining = fixture.auth.refresh("native", new AbortController().signal);
      try {
        cancelled.abort();
        await rejected;
        assert.equal(fixture.get.mock.callCount(), 1);
        assert.equal(fixture.get.mock.calls[0]?.arguments[1].aborted, false);
        fixture.finish();
        assert.equal(await remaining, fixture.credential);
        assert.equal(await fixture.auth.refresh("native", new AbortController().signal), fixture.credential);
        assert.equal(fixture.get.mock.callCount(), 2, "a completed refresh leaves no pending cache entry");
      } finally {
        fixture.finish();
        await remaining;
      }
    });
  }
});
