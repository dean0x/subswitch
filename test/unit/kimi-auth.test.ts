/** Offline credential boundaries; all profiles, paths and keys are fabricated. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../../src/config.js";
import { noopLogger } from "../../src/logger.js";
import { ProfileAuth } from "../../src/routing/profile-auth.js";
import type { AccessProfile } from "../../src/routing/routing-types.js";

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
});
