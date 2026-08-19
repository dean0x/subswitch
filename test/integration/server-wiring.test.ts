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
 * Non-vacuity: the "makeMinimalConfig — non-vacuity guard" describe block below pins
 * non-overridden fields to their literal default values (not to defaultConfig()), so
 * the guard catches hardcoded drift even when both sides call the same function.
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
  it("non-overridden fields of makeMinimalConfig() equal the real loadConfig defaults — literal pin", () => {
    // Compares against LITERAL values (not against defaultConfig()) so the guard is
    // genuinely discriminating: if makeMinimalConfig() ever stops spreading defaultConfig()
    // and hardcodes wrong values, the literals catch it even when both sides call the same
    // underlying function (avoids PF-011, PF-012).
    //
    // MUTATION PROOF: temporarily changing a default in src/config.ts (e.g. DEFAULT_PORT
    // from 4141 to 4142, or connectTimeoutMs from 10_000 to 9_999) causes this test to go
    // RED at the corresponding assertion — the literal no longer matches.  A spread-vs-base
    // comparison would remain green because both sides derive from the same function.
    //
    // Canonical defaults (kept in sync with src/config.ts):
    //   port:                              4141   (DEFAULT_PORT)
    //   anthropic.connectTimeoutMs:        10_000
    //   anthropic.maxUpstreamSockets:      256
    //   limits.maxBodyBytes:               33_554_432  (32 MiB)
    //   limits.pingIntervalMs:             15_000
    //   providers.codex.aliases:           {}
    //   providers.codex.requestTimeoutMs:  600_000
    //   providers.codex.streamIdleTimeoutMs: 300_000
    const fixture = makeMinimalConfig();
    assert.equal(fixture.port, 4141, "port default must be 4141 (DEFAULT_PORT)");
    assert.equal(fixture.anthropic.connectTimeoutMs, 10_000, "anthropic.connectTimeoutMs default must be 10 000 ms");
    assert.equal(fixture.anthropic.maxUpstreamSockets, 256, "anthropic.maxUpstreamSockets default must be 256");
    assert.equal(fixture.limits.maxBodyBytes, 32 * 1024 * 1024, "limits.maxBodyBytes default must be 32 MiB");
    assert.equal(fixture.limits.pingIntervalMs, 15_000, "limits.pingIntervalMs default must be 15 000 ms");
    assert.deepEqual(fixture.providers.codex.aliases, {}, "providers.codex.aliases default must be empty");
    assert.equal(fixture.providers.codex.requestTimeoutMs, 600_000, "providers.codex.requestTimeoutMs default must be 600 000 ms");
    assert.equal(fixture.providers.codex.streamIdleTimeoutMs, 300_000, "providers.codex.streamIdleTimeoutMs default must be 300 000 ms");
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
// ---------------------------------------------------------------------------

describe("loadConfig — example config schema sync (PF-010)", () => {
  it("subswitch.config.example.json parses cleanly against the current schema", () => {
    const result = loadConfig({ configPath: join(process.cwd(), "subswitch.config.example.json") });
    assert.ok(result.ok, `example config must parse: ${!result.ok ? result.error.message : ""}`);
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
// B1: SERVER_TUNING is applied to the constructed server, AND the values are
//     the intended ones
//
// Two distinct claims, which need two distinct assertions:
//
//   (a) WIRING — every SERVER_TUNING field reaches the http.Server.  Comparing
//       server.X to SERVER_TUNING.X proves this and nothing else: it compares the
//       value to its own source of truth, so editing SERVER_TUNING moves both
//       sides together.  Verified: changing requestTimeout to 2 000 and
//       headersTimeout to 1 000 left the whole suite green.
//
//   (b) VALUES — the numbers themselves are what the design calls for.  This is
//       the claim a restated literal is REQUIRED for.  The usual rule against
//       duplicating a source of truth is inverted for a constant whose whole
//       purpose is to be a specific number: with no independent copy, nothing can
//       report that it changed.  A deliberate retune must edit both sides, which
//       is the point — it forces the changer past a comment explaining why the
//       value is what it is.
//
// These bounds are load-bearing under ADR-010: requestTimeout and headersTimeout
// govern inbound receipt and now produce a synthesized 408 on expiry, so shrinking
// them silently turns healthy slow clients into relay-invented errors.
//
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

    // (a) WIRING: each field reaches the server. Catches a deleted assignment.
    assert.equal(server.requestTimeout, SERVER_TUNING.requestTimeout, "requestTimeout must be wired from SERVER_TUNING");
    assert.equal(server.headersTimeout, SERVER_TUNING.headersTimeout, "headersTimeout must be wired from SERVER_TUNING");
    assert.equal(server.keepAliveTimeout, SERVER_TUNING.keepAliveTimeout, "keepAliveTimeout must be wired from SERVER_TUNING");
    assert.equal(server.maxRequestsPerSocket, SERVER_TUNING.maxRequestsPerSocket, "maxRequestsPerSocket must be wired from SERVER_TUNING");

    // (b) VALUES: independently restated, so a retune cannot pass unnoticed.
    // Changing one of these is a deliberate act — update the literal here and say why.
    assert.equal(
      server.requestTimeout,
      600_000,
      "requestTimeout must be 600 s — Anthropic's own ceiling for a long completion. " +
        "It bounds RECEIPT of the request only (never the response), so it cannot cut a slow stream; " +
        "shrinking it turns a slow uploader into a synthesized 408 (ADR-010).",
    );
    assert.equal(
      server.headersTimeout,
      120_000,
      "headersTimeout must be 120 s — a local client that has not finished its headers in 2 minutes is dead. " +
        "Node's 60 s default is too tight and now yields a synthesized 408 (ADR-010).",
    );
    assert.equal(
      server.keepAliveTimeout,
      300_000,
      "keepAliveTimeout must be 300 s. Node's 5 s default is the PF-018 regression: an idle-socket close " +
        "racing an outgoing POST gives an ECONNRESET undici will not retry for a non-idempotent request.",
    );
    assert.equal(server.maxRequestsPerSocket, 0, "maxRequestsPerSocket must be 0 (unlimited) — any cap cycles connections on long-lived agents");
    assert.equal(SERVER_TUNING.maxHeaderSize, 64 * 1024, "maxHeaderSize must be 64 KiB (behaviour pinned by B4)");

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

// ---------------------------------------------------------------------------
// B4b: An inbound timeout must keep Node's 408 — not become a 400 (ADR-010)
//
// PF-021 records the requestTimeout/headersTimeout 408 as written by the HTTP
// parser before any handler and therefore un-interceptable.  That is true of
// Node's DEFAULT reply only: measured on Node 22.22, attaching a `clientError`
// listener SUPPRESSES the canned 408 and delivers the expiry to the listener as
// err.code === "ERR_HTTP_REQUEST_TIMEOUT" for BOTH knobs.
//
// So attachClientErrorHandler owns this status now.  Folding the timeout into the
// generic 400 arm would emit a status neither Node nor the origin sends for a slow
// client, and would report a merely-slow request as a malformed one — a relay-
// invented status on a live connection, which is the defect class ADR-010 forbids.
//
// Non-vacuity: this test is RED on code that maps every non-HPE_HEADER_OVERFLOW
// clientError to 400 — it receives "HTTP/1.1 400 Bad Request" and the status
// assertion fails.  The B4 test above is the paired control proving the 400/431
// arm still works, so a mutation that returns 408 unconditionally is also caught.
//
// headersTimeout and connectionsCheckingInterval are overridden AFTER
// createProxyServer so the expiry is reachable in test time; the production
// values themselves are pinned separately by B1.
// ---------------------------------------------------------------------------

describe("attachClientErrorHandler — inbound timeout keeps 408, never 400 (B4b)", () => {
  it("a client that stalls mid-headers receives an Anthropic-shaped 408, not a 400", async () => {
    const configResult = loadConfig({
      configPath: "inline-b4b.json",
      readFile: () => JSON.stringify({ logLevel: "error" }),
    });
    assert.ok(configResult.ok, `config must load: ${!configResult.ok ? configResult.error.message : ""}`);
    const depsResult = buildDeps(configResult.value.config);
    assert.ok(depsResult.ok, `buildDeps must succeed: ${!depsResult.ok ? depsResult.error : ""}`);

    const server = createProxyServer(depsResult.value);
    // Node only samples the timeout on connectionsCheckingInterval ticks, so both
    // knobs must shrink together or the expiry never fires inside the test budget.
    server.headersTimeout = 300;
    server.requestTimeout = 0;
    (server as unknown as { connectionsCheckingInterval: number }).connectionsCheckingInterval = 50;
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;

    try {
      const responseBytes = await new Promise<string>((resolve, reject) => {
        const socket = net.connect(port, "127.0.0.1", () => {
          // Partial headers: no terminating blank line, so headersTimeout expires.
          socket.write(`GET /v1/messages HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n`);
        });
        let received = "";
        socket.on("data", (data: Buffer) => { received += data.toString(); });
        socket.on("end", () => resolve(received));
        socket.on("close", () => resolve(received));
        socket.on("error", reject);
        socket.setTimeout(5000, () => { socket.destroy(); reject(new Error("raw socket timeout waiting for 408")); });
      });

      assert.match(
        responseBytes,
        /^HTTP\/1\.1 408 Request Timeout/,
        `an inbound header timeout must keep Node's own 408 — a 400 would report a slow ` +
          `client as a malformed one and invent a status the origin never sends (ADR-010). Got:\n` +
          `${responseBytes.slice(0, 200)}`,
      );
      assert.ok(
        responseBytes.toLowerCase().includes("x-subswitch-synthesized: 1"),
        `408 must carry x-subswitch-synthesized: 1; got:\n${responseBytes.slice(0, 500)}`,
      );

      const bodyStart = responseBytes.indexOf("\r\n\r\n");
      assert.ok(bodyStart >= 0, "response must have a body (\\r\\n\\r\\n separator missing)");
      const body = JSON.parse(responseBytes.slice(bodyStart + 4)) as {
        type: string;
        error: { type: string; message: string };
      };
      assert.equal(body.type, "error", "408 body outer type must be 'error'");
      assert.match(
        body.error.message,
        /timed out/,
        `408 message must describe a timeout, not a malformed request; got: ${JSON.stringify(body.error.message)}`,
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

// ---------------------------------------------------------------------------
// B4c: a genuinely malformed request still gets the Anthropic-shaped 400
//
// The 400 arm of attachClientErrorHandler had no test at all: its status, error
// type, message and the `client_error` warn could all be mutated to garbage with
// the suite fully green.  It is also the fallback arm — any clientError code the
// response table does not name lands here — so it is what a future Node adding a
// new code will produce, and it is the control that stops the B4b 408 fix from
// being over-applied to every code.
//
// Non-vacuity: RED if the fallback status/type/message change, and RED if the 408
// entry is widened to catch every code (the response would become a 408).
// ---------------------------------------------------------------------------

describe("attachClientErrorHandler — Anthropic-shaped 400 on a malformed request (B4c)", () => {
  it("an invalid request line receives an Anthropic-shaped 400 with the synthesized marker", async () => {
    const configResult = loadConfig({
      configPath: "inline-b4c.json",
      readFile: () => JSON.stringify({ logLevel: "error" }),
    });
    assert.ok(configResult.ok, `config must load: ${!configResult.ok ? configResult.error.message : ""}`);
    const depsResult = buildDeps(configResult.value.config);
    assert.ok(depsResult.ok, `buildDeps must succeed: ${!depsResult.ok ? depsResult.error : ""}`);

    const server = createProxyServer(depsResult.value);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;

    try {
      const responseBytes = await new Promise<string>((resolve, reject) => {
        const socket = net.connect(port, "127.0.0.1", () => {
          // Not a valid HTTP method — the parser rejects it with HPE_INVALID_METHOD.
          socket.write("BAD METHOD / HTTP/1.1\r\nHost: x\r\n\r\n");
        });
        let received = "";
        socket.on("data", (data: Buffer) => { received += data.toString(); });
        socket.on("end", () => resolve(received));
        socket.on("close", () => resolve(received));
        socket.on("error", reject);
        socket.setTimeout(5000, () => { socket.destroy(); reject(new Error("raw socket timeout waiting for 400")); });
      });

      assert.match(
        responseBytes,
        /^HTTP\/1\.1 400 Bad Request/,
        `a malformed request line must yield 400; got:\n${responseBytes.slice(0, 200)}`,
      );
      assert.ok(
        responseBytes.toLowerCase().includes("x-subswitch-synthesized: 1"),
        `400 must carry x-subswitch-synthesized: 1; got:\n${responseBytes.slice(0, 500)}`,
      );

      const bodyStart = responseBytes.indexOf("\r\n\r\n");
      assert.ok(bodyStart >= 0, "response must have a body (CRLF CRLF separator missing)");
      const body = JSON.parse(responseBytes.slice(bodyStart + 4)) as {
        type: string;
        error: { type: string; message: string };
      };
      assert.equal(body.type, "error", "400 body outer type must be 'error'");
      assert.equal(body.error.type, "invalid_request_error", "400 error.type must be 'invalid_request_error'");
      assert.equal(body.error.message, "malformed request", "400 message must be the fixed malformed-request text");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
