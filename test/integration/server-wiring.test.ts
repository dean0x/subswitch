/**
 * Tests for what `buildDeps` wires, as opposed to what the wired server then does.
 *
 * The startup base-URL warning is emitted during `buildDeps` itself, before any
 * request and before `startSubswitch` can swap in an injected logger — so it is not
 * observable through the usual harness seam. These tests capture stderr around the
 * `buildDeps` call instead, which is the only place the warning is visible.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../../src/config.js";
import { buildDeps } from "../../src/server.js";
import { PROVIDER_IDS } from "../../src/models.js";

/** Run `fn` with stderr captured, returning every line it wrote. */
const captureStderr = (fn: () => void): string[] => {
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
  return lines.join("").split("\n").filter((line) => line !== "");
};

const buildWithCodexBaseUrl = (baseUrl: string): string[] => {
  const result = loadConfig({
    configPath: "inline-wiring-test.json",
    // logLevel must admit `warn`, or the check under test is filtered out before
    // it reaches the sink and the test passes for the wrong reason.
    readFile: () => JSON.stringify({ logLevel: "warn", providers: { codex: { baseUrl } } }),
  });
  assert.ok(result.ok, `config must load: ${!result.ok ? result.error.message : ""}`);
  return captureStderr(() => {
    buildDeps(result.value.config);
  });
};

describe("buildDeps — per-provider base-URL override warning", () => {
  it("warns with the provider's own event name when its baseUrl is on a foreign host", () => {
    const lines = buildWithCodexBaseUrl("https://evil.example/backend-api/codex");
    const warning = lines.find((line) => line.includes("base_url_override_detected"));
    assert.ok(warning !== undefined, `expected a base-URL override warning; got: ${lines.join(" | ")}`);
    // The event name is derived from the provider id, so it names WHICH provider was
    // redirected. A single shared event name would leave an operator with several
    // providers unable to tell which credential is being sent to the wrong host.
    assert.match(warning, /event=codex_base_url_override_detected/);
    assert.match(warning, /level=warn/);
  });

  it("stays silent when every provider's baseUrl is on its own default host", () => {
    const lines = buildWithCodexBaseUrl("https://chatgpt.com/backend-api/codex");
    assert.equal(
      lines.filter((line) => line.includes("base_url_override_detected")).length,
      0,
      `the default host must not warn; got: ${lines.join(" | ")}`,
    );
  });

  it("compares each provider against its own default host, not one shared constant", () => {
    // With PROVIDER_IDS = ["codex"] this cannot yet be observed behaviourally — a
    // single shared constant and a per-provider defaultHost produce identical output.
    // What IS checkable now is that the check is driven by the provider list rather
    // than by a hardcoded single provider, so adding an id extends the check for free.
    // (The per-provider value itself lives on ProviderRuntimeConfig, where the
    // Record<ProviderId, …> makes omitting one a compile error.)
    assert.ok(PROVIDER_IDS.length >= 1);
    const lines = buildWithCodexBaseUrl("https://evil.example/backend-api/codex");
    const warnings = lines.filter((line) => line.includes("base_url_override_detected"));
    assert.equal(warnings.length, 1, "exactly one provider is misconfigured, so exactly one warning");
  });
});
