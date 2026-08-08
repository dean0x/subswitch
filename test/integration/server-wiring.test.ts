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

  it("emits one warning per misconfigured provider", () => {
    // KNOWN HOLE, stated rather than dressed up. The property this file would like to
    // pin — that buildDeps compares each provider against ITS OWN defaultHost rather
    // than one shared constant — is NOT observable while PROVIDER_IDS is ["codex"]:
    // a shared constant and a per-provider defaultHost produce byte-identical output,
    // so no assertion here can separate them. An earlier version of this test opened
    // with `assert.ok(PROVIDER_IDS.length >= 1)`, which is constant-true — it read as
    // coverage of that property while proving nothing. It is gone.
    //
    // What this test does assert is real but narrow: the warning count tracks the
    // number of misconfigured providers rather than firing unconditionally.
    // The per-provider axis becomes falsifiable the moment a second id exists — at
    // that point, configure one provider on a foreign host and the other on its own,
    // and assert exactly one warning naming the right id.
    // (The per-provider value itself lives on ProviderRuntimeConfig, where the
    // Record<ProviderId, …> makes omitting one a compile error — that much IS enforced.)
    const lines = buildWithCodexBaseUrl("https://evil.example/backend-api/codex");
    const warnings = lines.filter((line) => line.includes("base_url_override_detected"));
    assert.equal(warnings.length, 1, "exactly one provider is misconfigured, so exactly one warning");
  });
});

// ---------------------------------------------------------------------------
// buildDeps — insecureBaseUrlScheme and oauthTokenUrl runtime warnings
//
// The Zod refinements in config.ts already reject http:// non-loopback URLs at
// parse time. These tests exercise the RUNTIME defence-in-depth in buildDeps,
// which also fires when a Config is constructed programmatically. They build a
// Config object directly to bypass Zod validation.
//
// MUTATION PROOF: removing the scheme check from the buildDeps loop causes
// `insecureBaseUrlScheme` tests to pass vacuously (no warning is emitted and
// the assertion that no warning fires is trivially green — but the opposite
// assertion, that the warning IS there, correctly fails).
// The named mutation for each test is: remove the `parsedBase.protocol !==
// "https:"` branch (for baseUrl) or the `parsedOauth.protocol !== "https:"`
// branch (for oauthTokenUrl).
// ---------------------------------------------------------------------------

/**
 * Build a minimal Config for testing buildDeps directly, bypassing Zod validation.
 * This is the only way to exercise the runtime defence-in-depth with URLs that
 * the schema's https-only refinements would reject at parse time.
 */
const makeMinimalConfig = (overrides: Partial<Config["anthropic"]> & {
  codexBaseUrl?: string;
  codexOauthTokenUrl?: string;
} = {}): Config => {
  const {
    codexBaseUrl = "https://chatgpt.com/backend-api/codex",
    codexOauthTokenUrl = "https://auth.openai.com/oauth/token",
    baseUrl: anthropicBaseUrl = "https://api.anthropic.com",
    ...anthropicRest
  } = overrides;
  return {
    port: 4141,
    logLevel: "warn",
    anthropic: {
      baseUrl: anthropicBaseUrl,
      connectTimeoutMs: 10_000,
      streamIdleTimeoutMs: 300_000,
      maxUpstreamSockets: 32,
      ...anthropicRest,
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
      },
    },
    limits: { maxBodyBytes: 1024, pingIntervalMs: 15_000, maxConcurrentRequests: 32 },
  };
};

describe("buildDeps — insecureBaseUrlScheme runtime warning (SEC-01 defence-in-depth)", () => {
  it("emits codex_insecure_base_url_scheme when providers.codex.baseUrl uses http:// to a non-loopback host", () => {
    const config = makeMinimalConfig({ codexBaseUrl: "http://chatgpt.com/backend-api/codex" });
    const lines = captureStderr(() => buildDeps(config));
    const warning = lines.find((line) => line.includes("codex_insecure_base_url_scheme"));
    assert.ok(
      warning !== undefined,
      `expected codex_insecure_base_url_scheme warning; got: ${lines.join(" | ")}`,
    );
    assert.match(warning, /level=warn/);
  });

  it("does NOT emit insecureBaseUrlScheme when providers.codex.baseUrl uses https://", () => {
    const config = makeMinimalConfig({ codexBaseUrl: "https://chatgpt.com/backend-api/codex" });
    const lines = captureStderr(() => buildDeps(config));
    assert.equal(
      lines.filter((line) => line.includes("insecure_base_url_scheme")).length,
      0,
      `https:// baseUrl must not trigger scheme warning; got: ${lines.join(" | ")}`,
    );
  });

  it("does NOT emit insecureBaseUrlScheme when providers.codex.baseUrl uses http:// to 127.0.0.1 (loopback exemption)", () => {
    const config = makeMinimalConfig({ codexBaseUrl: "http://127.0.0.1:4142/backend-api/codex" });
    const lines = captureStderr(() => buildDeps(config));
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
    const lines = captureStderr(() => buildDeps(config));
    const warning = lines.find((line) => line.includes("codex_insecure_base_url_scheme"));
    assert.ok(
      warning !== undefined,
      `expected codex_insecure_base_url_scheme for http oauthTokenUrl; got: ${lines.join(" | ")}`,
    );
  });

  it("does NOT emit insecureBaseUrlScheme when providers.codex.oauthTokenUrl uses https://", () => {
    const config = makeMinimalConfig({ codexOauthTokenUrl: "https://auth.openai.com/oauth/token" });
    const lines = captureStderr(() => buildDeps(config));
    assert.equal(
      lines.filter((line) => line.includes("insecure_base_url_scheme")).length,
      0,
      `https:// oauthTokenUrl must not trigger scheme warning; got: ${lines.join(" | ")}`,
    );
  });

  it("does NOT emit insecureBaseUrlScheme for oauthTokenUrl pointing at loopback (loopback exemption)", () => {
    const config = makeMinimalConfig({ codexOauthTokenUrl: "http://127.0.0.1:9000/oauth" });
    const lines = captureStderr(() => buildDeps(config));
    assert.equal(
      lines.filter((line) => line.includes("insecure_base_url_scheme")).length,
      0,
      `http://127.0.0.1 oauthTokenUrl must not trigger warning (loopback exempt); got: ${lines.join(" | ")}`,
    );
  });

  it("emits codex_base_url_override_detected for oauthTokenUrl pointing at a foreign host", () => {
    // The existing host-override check now also covers oauthTokenUrl — an operator who
    // points the OAuth endpoint at a third-party host is leaking the refresh token there.
    const config = makeMinimalConfig({ codexOauthTokenUrl: "https://evil.example/oauth/token" });
    const lines = captureStderr(() => buildDeps(config));
    const warning = lines.find((line) => line.includes("codex_base_url_override_detected"));
    assert.ok(
      warning !== undefined,
      `expected codex_base_url_override_detected for foreign oauthTokenUrl host; got: ${lines.join(" | ")}`,
    );
  });

  it("emits anthropic_insecure_base_url_scheme when anthropic.baseUrl uses http:// to a non-loopback host", () => {
    // The anthropic leg forwards sk-ant-* keys verbatim; http:// to a non-loopback
    // host leaks them in cleartext.
    const config = makeMinimalConfig({ baseUrl: "http://api.anthropic.com" });
    const lines = captureStderr(() => buildDeps(config));
    const warning = lines.find((line) => line.includes("anthropic_insecure_base_url_scheme"));
    assert.ok(
      warning !== undefined,
      `expected anthropic_insecure_base_url_scheme warning; got: ${lines.join(" | ")}`,
    );
    assert.match(warning, /level=warn/);
  });

  it("does NOT emit anthropic_insecure_base_url_scheme when anthropic.baseUrl uses https://", () => {
    const config = makeMinimalConfig({ baseUrl: "https://api.anthropic.com" });
    const lines = captureStderr(() => buildDeps(config));
    assert.equal(
      lines.filter((line) => line.includes("anthropic_insecure_base_url_scheme")).length,
      0,
      `https:// anthropic.baseUrl must not trigger warning; got: ${lines.join(" | ")}`,
    );
  });

  it("does NOT emit anthropic_insecure_base_url_scheme when anthropic.baseUrl uses http:// to loopback", () => {
    const config = makeMinimalConfig({ baseUrl: "http://127.0.0.1:4141" });
    const lines = captureStderr(() => buildDeps(config));
    assert.equal(
      lines.filter((line) => line.includes("anthropic_insecure_base_url_scheme")).length,
      0,
      `http://127.0.0.1 anthropic.baseUrl must not trigger warning (loopback exempt); got: ${lines.join(" | ")}`,
    );
  });
});
