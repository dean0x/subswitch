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
import { join } from "node:path";
import net from "node:net";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { loadConfig, type Config } from "../../src/config.js";
import { buildDeps, createProxyServer, SERVER_TUNING } from "../../src/server.js";
import { startFakeUpstream } from "./fake-upstreams.js";

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

/**
 * Returns a Config built from loadConfig with an empty file — identical to what a
 * user gets with no config options set.  Cannot drift from loadConfig's real
 * defaults because it IS loadConfig's real defaults.
 *
 * Pattern from test/unit/codex-handler.test.ts lines 104-106.
 */
const defaultConfig = (): Config => {
  const result = loadConfig({ configPath: "inline-test.json", readFile: () => "{}", env: {} });
  if (!result.ok) throw new Error(`loadConfig failed with empty config: ${result.error.message}`);
  return result.value.config;
};

/**
 * Build a Config for testing buildDeps directly, bypassing Zod validation.
 * This is the only way to exercise the runtime defence-in-depth with URLs that
 * the schema's https-only refinements would reject at parse time.
 *
 * Derives from defaultConfig() so non-URL fields can never drift from real defaults.
 * Overrides are applied AFTER parsing — the https bypass still works because
 * we spread over the already-parsed Config object, not re-running the schema.
 *
 * Non-vacuity: see "makeMinimalConfig — non-vacuity guard" describe block below.
 */
const makeMinimalConfig = (overrides: {
  codexBaseUrl?: string;
  codexOauthTokenUrl?: string;
  codexAllowInsecureBaseUrl?: boolean;
  anthropicBaseUrl?: string;
  anthropicAllowInsecureBaseUrl?: boolean;
} = {}): Config => {
  const {
    codexBaseUrl = "https://chatgpt.com/backend-api/codex",
    codexOauthTokenUrl = "https://auth.openai.com/oauth/token",
    codexAllowInsecureBaseUrl = false,
    anthropicBaseUrl = "https://api.anthropic.com",
    anthropicAllowInsecureBaseUrl = false,
  } = overrides;
  const base = defaultConfig();
  return {
    ...base,
    logLevel: "warn",  // quieter test output (deliberate override)
    anthropic: {
      ...base.anthropic,
      baseUrl: anthropicBaseUrl,
      allowInsecureBaseUrl: anthropicAllowInsecureBaseUrl,
    },
    providers: {
      codex: {
        ...base.providers.codex,
        baseUrl: codexBaseUrl,
        oauthTokenUrl: codexOauthTokenUrl,
        authFile: "/tmp/nonexistent-auth.json",  // deliberate: non-default path for tests
        allowInsecureBaseUrl: codexAllowInsecureBaseUrl,
      },
    },
  };
};

describe("makeMinimalConfig — non-vacuity guard", () => {
  it("non-overridden fields of makeMinimalConfig() match real loadConfig defaults — cannot drift", () => {
    // Verifies that the spread-over-defaultConfig() pattern keeps non-URL fields
    // in sync with loadConfig's real defaults.  Previously maxUpstreamSockets was
    // hardcoded as 32 when the real default was 256 — that is now a structural
    // impossibility because we spread ...base.anthropic.
    const base = defaultConfig();
    const fixture = makeMinimalConfig();
    assert.equal(fixture.port, base.port, "port must match default");
    assert.equal(fixture.anthropic.connectTimeoutMs, base.anthropic.connectTimeoutMs, "connectTimeoutMs must match default");
    assert.equal(fixture.anthropic.maxUpstreamSockets, base.anthropic.maxUpstreamSockets, "maxUpstreamSockets must match default");
    assert.equal(fixture.limits.maxBodyBytes, base.limits.maxBodyBytes, "limits.maxBodyBytes must match default");
    assert.equal(fixture.limits.pingIntervalMs, base.limits.pingIntervalMs, "limits.pingIntervalMs must match default");
    assert.deepEqual(fixture.providers.codex.aliases, base.providers.codex.aliases, "aliases must match default");
    assert.equal(fixture.providers.codex.requestTimeoutMs, base.providers.codex.requestTimeoutMs, "requestTimeoutMs must match default");
    assert.equal(fixture.providers.codex.streamIdleTimeoutMs, base.providers.codex.streamIdleTimeoutMs, "streamIdleTimeoutMs must match default");
  });
});

/** Capture stderr lines AND the Result from buildDeps in one shot. */
const buildAndCapture = (config: Config): { result: ReturnType<typeof buildDeps>; lines: string[] } => {
  let result!: ReturnType<typeof buildDeps>;
  const lines = captureStderr(() => { result = buildDeps(config); });
  return { result, lines };
};

// ---------------------------------------------------------------------------
// buildDeps — host-rejection gate (SEC-04)
//
// A credential-bearing URL pointing at a non-default host is now fatal unless
// the operator opts in with `allowInsecureBaseUrl: true`. Tests cover:
//   - Refused without opt-in (err Result + error event)
//   - Permitted with opt-in (ok Result + warn event)
//   - Loopback always exempt (ok Result, no event)
//   - Both baseUrl and oauthTokenUrl covered
//   - Anthropic leg covered consistently
//
// MUTATION PROOF per PF-011/PF-012:
//   - Removing the `if (!allowInsecureBaseUrl)` guard in buildDeps causes the
//     "rejects when..." tests to fail (no err Result returned).
//   - Removing the `if (parsedBase.hostname !== defaultHost)` condition causes
//     both the rejection and the opt-in warning tests to fail.
// ---------------------------------------------------------------------------

describe("buildDeps — SEC-04 host-rejection gate (providers.codex.baseUrl)", () => {
  it("returns err and logs error when providers.codex.baseUrl is on a foreign host (no opt-in)", () => {
    // MUTATION: remove the `if (!allowInsecureBaseUrl)` check in buildDeps — this test fails
    const config = makeMinimalConfig({ codexBaseUrl: "https://evil.example/backend-api/codex" });
    const { result, lines } = buildAndCapture(config);
    assert.ok(!result.ok, "buildDeps must return err for a foreign host without opt-in");
    assert.match(result.error, /providers\.codex\.baseUrl/, "error message must name the config key");
    assert.match(result.error, /evil\.example/, "error message must name the offending host");
    assert.match(result.error, /allowInsecureBaseUrl/, "error message must name the opt-in key");
    const errorLine = lines.find((line) => line.includes("codex_base_url_host_rejected"));
    assert.ok(errorLine !== undefined, `expected codex_base_url_host_rejected event; got: ${lines.join(" | ")}`);
    assert.match(errorLine, /level=error/);
  });

  it("returns ok and logs a warning (not fatal) when providers.codex.baseUrl is on a foreign host with allowInsecureBaseUrl: true", () => {
    // MUTATION: change `logger.log("warn", events.baseUrlOverrideDetected)` to no-op — warning test fails
    const config = makeMinimalConfig({
      codexBaseUrl: "https://evil.example/backend-api/codex",
      codexAllowInsecureBaseUrl: true,
    });
    const { result, lines } = buildAndCapture(config);
    assert.ok(result.ok, `buildDeps must return ok when allowInsecureBaseUrl is true; error: ${!result.ok ? result.error : ""}`);
    const warnLine = lines.find((line) => line.includes("codex_base_url_override_detected"));
    assert.ok(warnLine !== undefined, `expected codex_base_url_override_detected warning; got: ${lines.join(" | ")}`);
    assert.match(warnLine, /level=warn/);
  });

  it("returns ok and stays silent when providers.codex.baseUrl is on the default host", () => {
    const config = makeMinimalConfig({ codexBaseUrl: "https://chatgpt.com/backend-api/codex" });
    const { result, lines } = buildAndCapture(config);
    assert.ok(result.ok, `buildDeps must return ok for the default host; error: ${!result.ok ? result.error : ""}`);
    assert.equal(
      lines.filter((l) => l.includes("base_url")).length,
      0,
      `default host must produce no base-URL events; got: ${lines.join(" | ")}`,
    );
  });

  it("returns ok and stays silent when providers.codex.baseUrl uses http:// to loopback (loopback exemption)", () => {
    // Loopback is always exempt — host-mismatch check does not apply to 127.*/localhost/::1
    const config = makeMinimalConfig({ codexBaseUrl: "http://127.0.0.1:4142/backend-api/codex" });
    const { result, lines } = buildAndCapture(config);
    assert.ok(result.ok, "http://127.0.0.1 must be exempt (loopback)");
    assert.equal(
      lines.filter((l) => l.includes("base_url_host_rejected")).length,
      0,
      "loopback must not trigger host rejection",
    );
  });

  it("returns exactly one error for the first misconfigured provider", () => {
    // Verifies the count tracks the gate rather than firing unconditionally.
    // With a single foreign-host provider the gate fires once then returns early.
    const config = makeMinimalConfig({ codexBaseUrl: "https://evil.example/backend-api/codex" });
    const { lines } = buildAndCapture(config);
    const rejections = lines.filter((l) => l.includes("base_url_host_rejected"));
    assert.equal(rejections.length, 1, "exactly one provider is misconfigured — exactly one rejection");
  });
});

describe("buildDeps — SEC-04 host-rejection gate (providers.codex.oauthTokenUrl)", () => {
  it("returns err and logs error when providers.codex.oauthTokenUrl is on a foreign host (no opt-in)", () => {
    // MUTATION: remove the `if (!allowInsecureBaseUrl)` check for oauthTokenUrl — this test fails
    const config = makeMinimalConfig({ codexOauthTokenUrl: "https://evil.example/oauth/token" });
    const { result, lines } = buildAndCapture(config);
    assert.ok(!result.ok, "buildDeps must return err for a foreign oauthTokenUrl host without opt-in");
    assert.match(result.error, /providers\.codex\.oauthTokenUrl/, "error message must name the config key");
    assert.match(result.error, /evil\.example/, "error message must name the offending host");
    assert.match(result.error, /allowInsecureBaseUrl/, "error message must name the opt-in key");
    // oauthTokenUrl carries the long-lived refresh token — the message should mention it
    assert.match(result.error, /refresh token/, "error message must mention the refresh token risk");
    const errorLine = lines.find((line) => line.includes("codex_base_url_host_rejected"));
    assert.ok(errorLine !== undefined, `expected codex_base_url_host_rejected for oauthTokenUrl; got: ${lines.join(" | ")}`);
    assert.match(errorLine, /level=error/);
  });

  it("returns ok and warns when providers.codex.oauthTokenUrl is on a foreign host with allowInsecureBaseUrl: true", () => {
    const config = makeMinimalConfig({
      codexOauthTokenUrl: "https://evil.example/oauth/token",
      codexAllowInsecureBaseUrl: true,
    });
    const { result, lines } = buildAndCapture(config);
    assert.ok(result.ok, `expected ok with allowInsecureBaseUrl; error: ${!result.ok ? result.error : ""}`);
    const warnLine = lines.find((line) => line.includes("codex_base_url_override_detected"));
    assert.ok(warnLine !== undefined, `expected codex_base_url_override_detected for opted-in oauthTokenUrl; got: ${lines.join(" | ")}`);
  });

  it("returns ok when oauthTokenUrl uses http:// to loopback (loopback exemption)", () => {
    const config = makeMinimalConfig({ codexOauthTokenUrl: "http://127.0.0.1:9000/oauth" });
    const { result, lines } = buildAndCapture(config);
    assert.ok(result.ok, "http://127.0.0.1 oauthTokenUrl must be exempt (loopback)");
    assert.equal(
      lines.filter((l) => l.includes("base_url_host_rejected")).length,
      0,
      "loopback oauthTokenUrl must not trigger host rejection",
    );
  });
});

// ---------------------------------------------------------------------------
// buildDeps — insecureBaseUrlScheme runtime warnings (SEC-01 defence-in-depth)
//
// The Zod refinements in config.ts already reject http:// non-loopback URLs at
// parse time. These tests exercise the RUNTIME defence-in-depth in buildDeps,
// which also fires when a Config is constructed programmatically.
//
// All scheme-warning tests use the DEFAULT host (chatgpt.com / auth.openai.com /
// api.anthropic.com) so they are not affected by the new host-rejection gate.
//
// MUTATION PROOF: removing the `parsedBase.protocol !== "https:"` branch from
// buildDeps causes these tests to fail (no insecure_base_url_scheme event emitted).
// ---------------------------------------------------------------------------

describe("buildDeps — insecureBaseUrlScheme runtime warning (SEC-01 defence-in-depth)", () => {
  it("emits codex_insecure_base_url_scheme when providers.codex.baseUrl uses http:// to a non-loopback host", () => {
    const config = makeMinimalConfig({ codexBaseUrl: "http://chatgpt.com/backend-api/codex" });
    const { result, lines } = buildAndCapture(config);
    assert.ok(result.ok, "http to default host is not fatal (host check passes, only scheme warns)");
    const warning = lines.find((line) => line.includes("codex_insecure_base_url_scheme"));
    assert.ok(
      warning !== undefined,
      `expected codex_insecure_base_url_scheme warning; got: ${lines.join(" | ")}`,
    );
    assert.match(warning, /level=warn/);
  });

  it("does NOT emit insecureBaseUrlScheme when providers.codex.baseUrl uses https://", () => {
    const config = makeMinimalConfig({ codexBaseUrl: "https://chatgpt.com/backend-api/codex" });
    const { result, lines } = buildAndCapture(config);
    assert.ok(result.ok);
    assert.equal(
      lines.filter((line) => line.includes("insecure_base_url_scheme")).length,
      0,
      `https:// baseUrl must not trigger scheme warning; got: ${lines.join(" | ")}`,
    );
  });

  it("does NOT emit insecureBaseUrlScheme when providers.codex.baseUrl uses http:// to 127.0.0.1 (loopback exemption)", () => {
    const config = makeMinimalConfig({ codexBaseUrl: "http://127.0.0.1:4142/backend-api/codex" });
    const { result, lines } = buildAndCapture(config);
    assert.ok(result.ok, "http://127.0.0.1 must be exempt (loopback)");
    assert.equal(
      lines.filter((line) => line.includes("insecure_base_url_scheme")).length,
      0,
      `http://127.0.0.1 must not trigger scheme warning (loopback exempt); got: ${lines.join(" | ")}`,
    );
  });

  it("emits codex_insecure_base_url_scheme when providers.codex.oauthTokenUrl uses http:// to a non-loopback host", () => {
    // oauthTokenUrl carries the long-lived refresh token — more damaging to leak than
    // the short-lived access token that a misconfigured baseUrl would expose.
    const config = makeMinimalConfig({ codexOauthTokenUrl: "http://auth.openai.com/oauth/token" });
    const { result, lines } = buildAndCapture(config);
    assert.ok(result.ok, "http to default oauth host is not fatal (host check passes, scheme warns)");
    const warning = lines.find((line) => line.includes("codex_insecure_base_url_scheme"));
    assert.ok(
      warning !== undefined,
      `expected codex_insecure_base_url_scheme for http oauthTokenUrl; got: ${lines.join(" | ")}`,
    );
  });

  it("does NOT emit insecureBaseUrlScheme when providers.codex.oauthTokenUrl uses https://", () => {
    const config = makeMinimalConfig({ codexOauthTokenUrl: "https://auth.openai.com/oauth/token" });
    const { result, lines } = buildAndCapture(config);
    assert.ok(result.ok);
    assert.equal(
      lines.filter((line) => line.includes("insecure_base_url_scheme")).length,
      0,
      `https:// oauthTokenUrl must not trigger scheme warning; got: ${lines.join(" | ")}`,
    );
  });

  it("does NOT emit insecureBaseUrlScheme for oauthTokenUrl pointing at loopback (loopback exemption)", () => {
    const config = makeMinimalConfig({ codexOauthTokenUrl: "http://127.0.0.1:9000/oauth" });
    const { result, lines } = buildAndCapture(config);
    assert.ok(result.ok, "http://127.0.0.1 oauthTokenUrl must be exempt (loopback)");
    assert.equal(
      lines.filter((line) => line.includes("insecure_base_url_scheme")).length,
      0,
      `http://127.0.0.1 oauthTokenUrl must not trigger warning (loopback exempt); got: ${lines.join(" | ")}`,
    );
  });

  it("emits anthropic_insecure_base_url_scheme when anthropic.baseUrl uses http:// to a non-loopback host", () => {
    // The anthropic leg forwards sk-ant-* keys verbatim; http:// to a non-loopback
    // host leaks them in cleartext. api.anthropic.com IS the default host, so
    // the host-rejection gate does not fire — only the scheme warning.
    const config = makeMinimalConfig({ anthropicBaseUrl: "http://api.anthropic.com" });
    const { result, lines } = buildAndCapture(config);
    assert.ok(result.ok, "http to default anthropic host is not fatal (host check passes, scheme warns)");
    const warning = lines.find((line) => line.includes("anthropic_insecure_base_url_scheme"));
    assert.ok(
      warning !== undefined,
      `expected anthropic_insecure_base_url_scheme warning; got: ${lines.join(" | ")}`,
    );
    assert.match(warning, /level=warn/);
  });

  it("does NOT emit anthropic_insecure_base_url_scheme when anthropic.baseUrl uses https://", () => {
    const config = makeMinimalConfig({ anthropicBaseUrl: "https://api.anthropic.com" });
    const { result, lines } = buildAndCapture(config);
    assert.ok(result.ok);
    assert.equal(
      lines.filter((line) => line.includes("anthropic_insecure_base_url_scheme")).length,
      0,
      `https:// anthropic.baseUrl must not trigger warning; got: ${lines.join(" | ")}`,
    );
  });

  it("does NOT emit anthropic_insecure_base_url_scheme when anthropic.baseUrl uses http:// to loopback", () => {
    const config = makeMinimalConfig({ anthropicBaseUrl: "http://127.0.0.1:4141" });
    const { result, lines } = buildAndCapture(config);
    assert.ok(result.ok, "http://127.0.0.1 anthropic baseUrl must be exempt (loopback)");
    assert.equal(
      lines.filter((line) => line.includes("anthropic_insecure_base_url_scheme")).length,
      0,
      `http://127.0.0.1 anthropic.baseUrl must not trigger warning (loopback exempt); got: ${lines.join(" | ")}`,
    );
  });
});

// ---------------------------------------------------------------------------
// buildDeps — SEC-04 Anthropic leg host-rejection gate
//
// Consistent treatment: anthropic.baseUrl pointing at a foreign host is fatal
// unless anthropic.allowInsecureBaseUrl: true.
// ---------------------------------------------------------------------------

describe("buildDeps — SEC-04 host-rejection gate (anthropic.baseUrl)", () => {
  it("returns err and logs error when anthropic.baseUrl is on a foreign host (no opt-in)", () => {
    // MUTATION: remove the host-rejection block in the Anthropic section — this test fails
    const config = makeMinimalConfig({ anthropicBaseUrl: "https://evil.example/v1" });
    const { result, lines } = buildAndCapture(config);
    assert.ok(!result.ok, "buildDeps must return err for a foreign anthropic host without opt-in");
    assert.match(result.error, /anthropic\.baseUrl/, "error message must name the config key");
    assert.match(result.error, /evil\.example/, "error message must name the offending host");
    assert.match(result.error, /allowInsecureBaseUrl/, "error message must name the opt-in key");
    const errorLine = lines.find((line) => line.includes("anthropic_base_url_host_rejected"));
    assert.ok(errorLine !== undefined, `expected anthropic_base_url_host_rejected event; got: ${lines.join(" | ")}`);
    assert.match(errorLine, /level=error/);
  });

  it("returns ok and warns when anthropic.baseUrl is on a foreign host with allowInsecureBaseUrl: true", () => {
    const config = makeMinimalConfig({
      anthropicBaseUrl: "https://evil.example/v1",
      anthropicAllowInsecureBaseUrl: true,
    });
    const { result, lines } = buildAndCapture(config);
    assert.ok(result.ok, `expected ok with allowInsecureBaseUrl; error: ${!result.ok ? result.error : ""}`);
    const warnLine = lines.find((line) => line.includes("anthropic_base_url_override_detected"));
    assert.ok(warnLine !== undefined, `expected anthropic_base_url_override_detected warning; got: ${lines.join(" | ")}`);
    assert.match(warnLine, /level=warn/);
  });

  it("returns ok when anthropic.baseUrl uses http:// to loopback (loopback exemption)", () => {
    // Integration tests point anthropic.baseUrl at http://127.0.0.1:PORT — must remain exempt.
    const config = makeMinimalConfig({ anthropicBaseUrl: "http://127.0.0.1:4141" });
    const { result, lines } = buildAndCapture(config);
    assert.ok(result.ok, "http://127.0.0.1 anthropic must be exempt (loopback)");
    assert.equal(
      lines.filter((l) => l.includes("anthropic_base_url_host_rejected")).length,
      0,
      "loopback anthropic.baseUrl must not trigger host rejection",
    );
  });

  it("returns ok when anthropic.baseUrl is on the default host", () => {
    const config = makeMinimalConfig({ anthropicBaseUrl: "https://api.anthropic.com" });
    const { result } = buildAndCapture(config);
    assert.ok(result.ok, "default anthropic host must not be rejected");
  });
});

// ---------------------------------------------------------------------------
// loadConfig — example config file schema sync (PF-010)
//
// z.strictObject rejects unknown keys. If `subswitch.config.example.json` has
// a key the schema does not know, this test fails — forcing the example and the
// schema to stay in sync after every schema change.
//
// Additionally: the shipped example must never contain deprecated keys.  The
// DEPRECATED_KEYS table has 6 entries (anthropic.headerTimeoutMs,
// anthropic.streamIdleTimeoutMs, limits.maxConcurrentRequests,
// limits.maxInFlightBytes, limits.maxQueueDepth, limits.maxQueueWaitMs).
// limits.maxConcurrentRequests was NEVER present in the example; the other five
// were deprecated when the admission gate was removed (ADR-010).
// ---------------------------------------------------------------------------

describe("loadConfig — example config schema sync (PF-010)", () => {
  it("subswitch.config.example.json parses cleanly and advertises no deprecated keys", () => {
    const result = loadConfig({ configPath: join(process.cwd(), "subswitch.config.example.json") });
    assert.ok(result.ok, `example config must parse: ${!result.ok ? result.error.message : ""}`);
    // No deprecated key should ever appear in the shipped example — users would
    // see a 'config_key_deprecated' warn on startup and wonder why.
    // MUTATION: add any DEPRECATED_KEYS path to the example file → test fails.
    assert.deepEqual(
      result.value.deprecatedKeys,
      [],
      `example config must not contain deprecated keys; found: ${JSON.stringify(result.value.deprecatedKeys.map((k) => k.path))}`,
    );
    // Values spot-check: allowInsecureBaseUrl must be false in the example so
    // users don't accidentally opt in to credential forwarding.
    assert.strictEqual(result.value.config.anthropic.allowInsecureBaseUrl, false, "anthropic.allowInsecureBaseUrl must be false in example");
    assert.strictEqual(result.value.config.providers.codex.allowInsecureBaseUrl, false, "providers.codex.allowInsecureBaseUrl must be false in example");
    // maxUpstreamSockets in example must match the real default — catches the drift
    // that made makeMinimalConfig() wrong (maxUpstreamSockets: 32 vs real default 256).
    assert.strictEqual(
      result.value.config.anthropic.maxUpstreamSockets,
      defaultConfig().anthropic.maxUpstreamSockets,
      "anthropic.maxUpstreamSockets in example must match real default",
    );
  });
});

// ---------------------------------------------------------------------------
// B1: SERVER_TUNING is applied to the constructed server
//
// Pin the exact timeout values by importing SERVER_TUNING rather than restating
// literals (restated literals are a duplicated source of truth — a recognised
// disarm shape in this repo).
//
// Non-vacuity: set requestTimeout=999 on the server after construction and
// verify it changes → proves the assertion reads a live property.
// maxHeaderSize is constructor-only (not a public property) — it is verified
// behaviourally by the B4 header-overflow test.
// ---------------------------------------------------------------------------

describe("SERVER_TUNING — applied to constructed http.Server (B1)", () => {
  it("createProxyServer wires all SERVER_TUNING values onto the http.Server", async () => {
    // Build deps with a safe default config.  We do not make any requests so the
    // anthropic.baseUrl value is irrelevant; pick the real default.
    const configResult = loadConfig({
      configPath: "inline-b1.json",
      readFile: () => JSON.stringify({ logLevel: "error" }),
    });
    assert.ok(configResult.ok, `config must load: ${!configResult.ok ? configResult.error.message : ""}`);
    const depsResult = buildDeps(configResult.value.config);
    assert.ok(depsResult.ok, `buildDeps must succeed: ${!depsResult.ok ? depsResult.error : ""}`);

    const server = createProxyServer(depsResult.value);

    // Assert each tuning value using the exported const — never a restated literal.
    assert.equal(server.requestTimeout, SERVER_TUNING.requestTimeout, "requestTimeout must match SERVER_TUNING");
    assert.equal(server.headersTimeout, SERVER_TUNING.headersTimeout, "headersTimeout must match SERVER_TUNING");
    assert.equal(server.keepAliveTimeout, SERVER_TUNING.keepAliveTimeout, "keepAliveTimeout must match SERVER_TUNING");
    assert.equal(server.maxRequestsPerSocket, SERVER_TUNING.maxRequestsPerSocket, "maxRequestsPerSocket must match SERVER_TUNING");

    // Non-vacuity: mutate requestTimeout and confirm the assertion would have caught it.
    server.requestTimeout = 999;
    assert.notEqual(server.requestTimeout, SERVER_TUNING.requestTimeout, "mutated value must differ — proves the assertion reads a live property");

    // No listen call needed — we are only checking properties.
    server.close();
  });
});

// ---------------------------------------------------------------------------
// B2: Keep-Alive: timeout=300 on a response
//
// Node advertises keepAliveTimeout to the client via the Keep-Alive response
// header.  Assert the header is present and carries the right value.
//
// Non-vacuity: keepAliveTimeout is set to SERVER_TUNING.keepAliveTimeout (300 s).
// If it were left at Node's default (5 s) the header would say timeout=5.
// ---------------------------------------------------------------------------

describe("SERVER_TUNING — Keep-Alive header on response (B2)", () => {
  it("response carries Keep-Alive: timeout=300 derived from SERVER_TUNING.keepAliveTimeout", async () => {
    const upstream = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });

    const configResult = loadConfig({
      configPath: "inline-b2.json",
      readFile: () => JSON.stringify({ logLevel: "error", anthropic: { baseUrl: upstream.url } }),
    });
    assert.ok(configResult.ok, `config must load: ${!configResult.ok ? configResult.error.message : ""}`);
    const depsResult = buildDeps(configResult.value.config);
    assert.ok(depsResult.ok, `buildDeps must succeed: ${!depsResult.ok ? depsResult.error : ""}`);

    const server = createProxyServer(depsResult.value);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/models`);
      await response.body?.cancel();

      const keepAlive = response.headers.get("keep-alive");
      // Node emits "timeout=N" in Keep-Alive when keepAliveTimeout > 0.
      // Value is in seconds: 300_000 ms / 1000 = 300.
      const expectedSeconds = Math.floor(SERVER_TUNING.keepAliveTimeout / 1000);
      assert.ok(
        keepAlive !== null && keepAlive.includes(`timeout=${expectedSeconds}`),
        `Keep-Alive header must contain timeout=${expectedSeconds}; got: ${JSON.stringify(keepAlive)}`,
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await upstream.close();
    }
  });
});

// ---------------------------------------------------------------------------
// B3: Socket idle for 6.5 s is still reusable
//
// At Node's default keepAliveTimeout (5 000 ms) the server closes the idle
// socket after 5 s.  An http.Agent that tries to reuse it at 6.5 s receives
// ECONNRESET and must open a new connection (connectionCount = 2).
//
// With SERVER_TUNING.keepAliveTimeout (300 000 ms) the socket stays alive,
// reuse succeeds, and connectionCount = 1.
//
// This directly pins PF-018: a 5 s default forces reconnects and exposes
// non-idempotent POSTs to ECONNRESET-then-retry, the exact defect PF-018
// documents.  Budget: 6.5 s sleep + ~0.5 s setup = ~7 s — well inside the
// 30 s per-test limit.
// ---------------------------------------------------------------------------

describe("SERVER_TUNING — idle socket reuse after 6.5 s (B3)", () => {
  it("socket idle for 6.5 s is still reusable because keepAliveTimeout=300_000 exceeds Node default (5 000)", async () => {
    const upstream = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });

    const configResult = loadConfig({
      configPath: "inline-b3.json",
      readFile: () => JSON.stringify({ logLevel: "error", anthropic: { baseUrl: upstream.url } }),
    });
    assert.ok(configResult.ok, `config must load: ${!configResult.ok ? configResult.error.message : ""}`);
    const depsResult = buildDeps(configResult.value.config);
    assert.ok(depsResult.ok, `buildDeps must succeed: ${!depsResult.ok ? depsResult.error : ""}`);

    let proxyConnections = 0;
    const server = createProxyServer(depsResult.value);
    server.on("connection", () => { proxyConnections++; });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;

    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });

    const doGet = () =>
      new Promise<number>((resolve, reject) => {
        http
          .get(`http://127.0.0.1:${port}/v1/models`, { agent }, (res) => {
            res.resume(); // drain so the socket can return to the pool
            res.on("end", () => resolve(res.statusCode ?? 0));
          })
          .on("error", reject);
      });

    try {
      // First request — establishes the connection.
      await doGet();

      // Wait 6.5 s — past Node's 5 s default keepAliveTimeout.
      await new Promise<void>((r) => setTimeout(r, 6500));

      // Second request — must reuse the socket (server keepAlive=300 s keeps it alive).
      await doGet();
    } finally {
      agent.destroy();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await upstream.close();
    }

    assert.equal(
      proxyConnections,
      1,
      `keepAliveTimeout=300_000 must keep the socket alive for 6.5 s; ` +
        `got ${proxyConnections} connection(s) — 2 means the server closed at the Node default 5 s`,
    );
  });
});

// ---------------------------------------------------------------------------
// B4: Header overflow (>64 KiB) produces Anthropic-shaped 431 with synthesized
//     marker — not Node's canned bodyless 431 (PF-021)
//
// Node's http.Server handles HPE_HEADER_OVERFLOW in the HTTP parser before any
// request handler runs.  Its canned response is a BODYLESS 431 with Connection:
// close — no JSON body, no x-subswitch-synthesized, never logged.
//
// attachClientErrorHandler replaces that with an Anthropic-shaped error body
// and the synthesized marker.  A raw TCP socket is needed because the Node http
// client enforces its own (16 KiB) header limit before sending.
//
// Non-vacuity: without attachClientErrorHandler (or with the wrong maxHeaderSize),
// the response body would be empty, body-parse would fail, and the type assertion
// would not pass.  The presence of the JSON Anthropic body is the discriminant.
// ---------------------------------------------------------------------------

describe("attachClientErrorHandler — Anthropic-shaped 431 on header overflow (B4)", () => {
  it("request with headers exceeding maxHeaderSize receives Anthropic-shaped 431 with synthesized marker", async () => {
    const configResult = loadConfig({
      configPath: "inline-b4.json",
      readFile: () => JSON.stringify({ logLevel: "error" }),
    });
    assert.ok(configResult.ok, `config must load: ${!configResult.ok ? configResult.error.message : ""}`);
    const depsResult = buildDeps(configResult.value.config);
    assert.ok(depsResult.ok, `buildDeps must succeed: ${!depsResult.ok ? depsResult.error : ""}`);

    const server = createProxyServer(depsResult.value);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;

    try {
      // Build a raw request with a single header value that pushes total headers
      // over 64 KiB.  A raw TCP socket is needed — http.request() applies its own
      // (16 KiB) limit and would reject the request before connecting.
      const bigHeaderValue = "A".repeat(65 * 1024);
      const rawRequest =
        `GET /v1/messages HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${port}\r\n` +
        `X-Overflow: ${bigHeaderValue}\r\n` +
        `\r\n`;

      const responseBytes = await new Promise<string>((resolve, reject) => {
        const socket = net.connect(port, "127.0.0.1", () => {
          socket.write(rawRequest);
        });
        let received = "";
        socket.on("data", (data: Buffer) => { received += data.toString(); });
        socket.on("end", () => resolve(received));
        socket.on("close", () => resolve(received));
        socket.on("error", reject);
        socket.setTimeout(5000, () => { socket.destroy(); reject(new Error("raw socket timeout waiting for 431")); });
      });

      assert.match(responseBytes, /^HTTP\/1\.1 431/, "response must be a 431");
      assert.ok(
        responseBytes.toLowerCase().includes("x-subswitch-synthesized: 1"),
        `431 must carry x-subswitch-synthesized: 1; got:\n${responseBytes.slice(0, 500)}`,
      );

      const bodyStart = responseBytes.indexOf("\r\n\r\n");
      assert.ok(bodyStart >= 0, "response must have a body (\\r\\n\\r\\n separator missing)");
      const body = JSON.parse(responseBytes.slice(bodyStart + 4)) as {
        type: string;
        error: { type: string; message: string };
      };
      assert.equal(body.type, "error", "431 body outer type must be 'error'");
      assert.equal(body.error.type, "request_too_large", "431 error.type must be 'request_too_large'");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
