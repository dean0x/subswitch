import assert from "node:assert/strict";
import { it } from "node:test";
import type { LogLevel } from "../../src/logger.js";
import { vetCredentialUrl } from "../../src/upstream-policy.js";

/**
 * The https flag of the credential URL check, with a generic fixture host and
 * fixture event names. No real provider host or id is used here.
 */
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
