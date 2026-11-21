import assert from "node:assert/strict";
import { it } from "node:test";
import type { LogLevel } from "../../src/logger.js";
import { vetCredentialUrl } from "../../src/upstream-policy.js";
import { loadConfig } from "../../src/config.js";
import { keychainBackedCodex, keychainCredential } from "../fixtures/native-keychain.js";
import { buildTestDeps } from "../helpers/server-deps.js";

const startWithKeychainUrl = (baseUrl: string) => {
  const config = loadConfig({ configPath: "fixture", readFile: () => "{}", env: {} });
  assert.ok(config.ok);
  return buildTestDeps(config.value.config, { log: () => {} }, {
    providerConfigFor: keychainBackedCodex(true, { ...keychainCredential, baseUrl }),
  });
};

it("refuses an invalid Keychain base URL at startup", () => {
  const result = startWithKeychainUrl("not a url");
  assert.deepEqual(result, { ok: false, error: "providers.codex.baseUrl is not a valid URL." });
});

it("refuses plain http for a Keychain credential on the expected host at startup", () => {
  const result = startWithKeychainUrl("http://upstream.example.test/v1");
  assert.ok(!result.ok);
  assert.equal(result.error, "providers.codex.baseUrl must use https.");
});

for (const host of ["other.example.test", "upstream.example.test:8443", "127.0.0.1:443"]) {
  it(`refuses the Keychain origin ${host} at startup with fixed text and no opt-in hint`, () => {
    const result = startWithKeychainUrl(`https://${host}/v1`);
    assert.ok(!result.ok);
    assert.equal(result.error, "providers.codex.baseUrl must use the default host on port 443.");
  });
}

it("checks the actual provider URLs even with injected report metadata", () => {
  const loaded = loadConfig({ configPath: "fixture", env: {}, readFile: () => JSON.stringify({
    providers: { codex: { oauthTokenUrl: "https://other.example.test/token" } },
  }) });
  assert.ok(loaded.ok);
  const result = buildTestDeps(loaded.value.config, { log: () => {} }, { providerConfigFor: keychainBackedCodex(true) });
  assert.ok(!result.ok);
  assert.match(result.error, /^providers\.codex\.oauthTokenUrl /);
});

it("starts with only the approved Keychain base URL and no token URL", () => {
  assert.equal(startWithKeychainUrl("https://upstream.example.test/v1").ok, true);
});

const events = {
  insecureBaseUrlScheme: "fixture_insecure_base_url_scheme",
  baseUrlHostRejected: "fixture_base_url_host_rejected",
  baseUrlOverrideDetected: "fixture_base_url_override_detected",
};

const vet = (url: string, options: { requireHttps?: boolean; allowOverride?: boolean } = {}) => {
  const lines: { level: LogLevel; event: string }[] = [];
  const result = vetCredentialUrl({
    url, path: "fixture.baseUrl", expectedHost: "upstream.example.test", optInKey: "fixture.allowInsecureBaseUrl",
    allowOverride: options.allowOverride ?? false, logger: { log: (level, event) => { lines.push({ level, event }); } },
    events, ...(options.requireHttps === undefined ? {} : { requireHttps: options.requireHttps }),
  });
  return { result, lines };
};

it("refuses a plain http URL on the expected host when https is required", () => {
  const { result, lines } = vet("http://upstream.example.test/v1", { requireHttps: true });
  assert.deepEqual(result, { ok: false, error: "fixture.baseUrl must use https. Plain http is allowed only for a loopback address." });
  assert.deepEqual(lines, [{ level: "error", event: events.insecureBaseUrlScheme }]);
});

it("refuses a plain http URL on another host when https is required, even with the host opt-in", () => {
  const { result } = vet("http://other.example.test/v1", { requireHttps: true, allowOverride: true });
  assert.equal(result.ok, false);
});

it("refuses a plain http hostname that only starts like a loopback address when https is required", () => {
  const { result } = vet("http://127.0.0.1.evil.test/v1", { requireHttps: true, allowOverride: true });
  assert.equal(result.ok, false);
});

it("allows a plain http loopback URL when https is required", () => {
  for (const url of ["http://127.0.0.1:8787/v1", "http://localhost:8787/v1", "http://[::1]:8787/v1"]) {
    const { result, lines } = vet(url, { requireHttps: true });
    assert.deepEqual(result, { ok: true, value: undefined }, url);
    assert.deepEqual(lines, [], url);
  }
});

it("allows an https URL on the expected host when https is required", () => {
  const { result, lines } = vet("https://upstream.example.test/v1", { requireHttps: true });
  assert.deepEqual(result, { ok: true, value: undefined });
  assert.deepEqual(lines, []);
});

it("keeps the warning-only result for a plain http URL on the expected host without the flag", () => {
  for (const requireHttps of [undefined, false]) {
    const { result, lines } = vet("http://upstream.example.test/v1", requireHttps === undefined ? {} : { requireHttps });
    assert.deepEqual(result, { ok: true, value: undefined });
    assert.deepEqual(lines, [{ level: "warn", event: events.insecureBaseUrlScheme }]);
  }
});
