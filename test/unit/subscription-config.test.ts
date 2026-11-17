import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../../src/config.js";

const profile = {
  provider: "codex", product: "chatgpt-codex", billing: "subscription",
  account: "synthetic", credential: { kind: "native-oauth", authFile: "/synthetic/never-read.json" },
};
const load = (accessProfile: object, route: object = {}) => loadConfig({
  configPath: "/synthetic/subscription-config.json", env: {},
  readFile: () => JSON.stringify({ configVersion: 2, accessProfiles: { work: accessProfile }, ...route }),
});
const error = (path: string, message: string) =>
  `invalid config: ${path}: ${message} (sources: /synthetic/subscription-config.json)`;

describe("subscription-only explicit configuration", () => {
  for (const product of ["openai-api", "anthropic-api", "kimi-platform"]) {
    it(`rejects removed product ${product} with its exact value`, () => {
      const loaded = load({ ...profile, product });
      assert.equal(loaded.ok, false);
      if (!loaded.ok) assert.equal(loaded.error.message,
        error("accessProfiles.work.product", `unsupported product: ${product}`));
    });
  }
  it("rejects the removed env credential kind with its exact value", () => {
    const loaded = load({ ...profile, credential: { kind: "env", name: "SYNTHETIC_REMOVED_KEY" } });
    assert.equal(loaded.ok, false);
    if (!loaded.ok) assert.equal(loaded.error.message,
      error("accessProfiles.work.credential.kind", "unsupported credential kind: env"));
  });
  it("rejects API billing with its exact value", () => {
    const loaded = load({ ...profile, billing: "api" });
    assert.equal(loaded.ok, false);
    if (!loaded.ok) assert.equal(loaded.error.message,
      error("accessProfiles.work.billing", "unsupported billing: api"));
  });
  it("accepts a Kimi route only through its subscription sign-in", () => {
    const kimi = { ...profile, provider: "kimi", product: "kimi-code", region: "global" };
    const target = { profile: "work", model: "kimi-for-coding", effort: "high" };
    const loaded = load(kimi, {
      routes: { work: { clients: ["claude-code"], primary: target } },
    });
    assert.ok(loaded.ok);
    assert.deepEqual(loaded.value.config.accessProfiles!.work, kimi);
    assert.deepEqual(loaded.value.config.routes!.work!.primary, target);
  });
  for (const field of ["product", "billing", "credential kind"] as const) {
    it(`rejects an object-valued ${field} without string coercion`, () => {
      const malformed = { toString: null, valueOf: null };
      const input = field === "credential kind"
        ? { ...profile, credential: { ...profile.credential, kind: malformed } }
        : { ...profile, [field]: malformed };
      assert.doesNotThrow(() => {
        const loaded = load(input);
        assert.equal(loaded.ok, false);
        if (!loaded.ok) assert.equal(loaded.error.message,
          error(`accessProfiles.work.${field === "credential kind" ? "credential.kind" : field}`,
            `${field} must be a string`));
      });
    });
  }
  it("rejects the removed sameModelApi route key instead of dropping it", () => {
    const target = { profile: "work", model: "gpt-6-sol", effort: "high" };
    const loaded = load(profile, { routes: { work: { clients: ["claude-code"], primary: target, sameModelApi: target } } });
    assert.equal(loaded.ok, false);
    if (!loaded.ok) assert.equal(loaded.error.message,
      error("routes.work", 'Unrecognized key: "sameModelApi"'));
  });
});
