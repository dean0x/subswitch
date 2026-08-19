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
import { loadConfig, type Config } from "../../src/config.js";
import { buildDeps } from "../../src/server.js";

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
 * Build a minimal Config for testing buildDeps directly, bypassing Zod validation.
 * This is the only way to exercise the runtime defence-in-depth with URLs that
 * the schema's https-only refinements would reject at parse time.
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
  return {
    port: 4141,
    logLevel: "warn",
    anthropic: {
      baseUrl: anthropicBaseUrl,
      connectTimeoutMs: 10_000,
      headerTimeoutMs: 600_000,
      streamIdleTimeoutMs: 300_000,
      maxUpstreamSockets: 32,
      allowInsecureBaseUrl: anthropicAllowInsecureBaseUrl,
    },
    providers: {
      codex: {
        baseUrl: codexBaseUrl,
        oauthTokenUrl: codexOauthTokenUrl,
        authFile: "/tmp/nonexistent-auth.json",
        userAgent: "test/1.0",
        aliases: {},
        reasoningCache: { maxEntries: 10, maxBytes: 1024 },
        requestTimeoutMs: 60_000,
        streamIdleTimeoutMs: 60_000,
        maxSseEventBytes: 1024,
        maxAggregateBytes: 64 * 1024 * 1024,
        allowInsecureBaseUrl: codexAllowInsecureBaseUrl,
      },
    },
    limits: { maxBodyBytes: 1024, pingIntervalMs: 15_000, maxConcurrentRequests: 32, maxInFlightBytes: 2 * 1024 * 1024 * 1024, maxQueueDepth: 1000, maxQueueWaitMs: 60_000 },
  };
};

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
  it("subswitch.config.example.json parses cleanly with the new allowInsecureBaseUrl fields", () => {
    const result = loadConfig({ configPath: join(process.cwd(), "subswitch.config.example.json") });
    assert.ok(result.ok, `example config must parse: ${!result.ok ? result.error.message : ""}`);
    assert.strictEqual(result.value.config.anthropic.allowInsecureBaseUrl, false, "anthropic.allowInsecureBaseUrl must default to false in example");
    assert.strictEqual(result.value.config.providers.codex.allowInsecureBaseUrl, false, "providers.codex.allowInsecureBaseUrl must default to false in example");
  });
});
