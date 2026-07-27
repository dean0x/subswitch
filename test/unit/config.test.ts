import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  loadConfig,
  detectLegacyConfigKeys,
  detectUnknownProviderKeys,
  aliasesByProvider,
} from "../../src/config.js";
import { PROVIDER_IDS } from "../../src/models.js";

const missingFile = (): never => {
  const error = new Error("ENOENT") as Error & { code: string };
  error.code = "ENOENT";
  throw error;
};

describe("loadConfig", () => {
  it("returns full defaults when the implicit cwd config file is missing", () => {
    // No configPath, no SUBSWITCH_CONFIG env var — implicit cwd path → silently use defaults.
    const result = loadConfig({ readFile: missingFile, env: {} });
    assert.ok(result.ok);
    assert.equal(result.value.config.port, 4141);
    assert.equal(result.value.config.logLevel, "info");
    assert.equal(result.value.config.anthropic.baseUrl, "https://api.anthropic.com");
    assert.equal(result.value.config.anthropic.connectTimeoutMs, 10_000);
    assert.equal(result.value.config.anthropic.streamIdleTimeoutMs, 300_000);
    assert.equal(result.value.config.anthropic.maxUpstreamSockets, 32);
    assert.equal(result.value.config.providers.codex.baseUrl, "https://chatgpt.com/backend-api/codex");
    assert.equal(result.value.config.providers.codex.oauthTokenUrl, "https://auth.openai.com/oauth/token");
    assert.equal(result.value.config.providers.codex.authFile, join(homedir(), ".codex/auth.json"));
    assert.equal(result.value.config.providers.codex.reasoningCache.maxEntries, 4096);
    assert.equal(result.value.config.providers.codex.reasoningCache.maxBytes, 64 * 1024 * 1024);
    assert.equal(result.value.config.providers.codex.requestTimeoutMs, 600_000);
    assert.equal(result.value.config.providers.codex.streamIdleTimeoutMs, 300_000);
    assert.equal(result.value.config.providers.codex.maxSseEventBytes, 4 * 1024 * 1024);
    assert.equal(result.value.config.limits.maxBodyBytes, 32 * 1024 * 1024);
    assert.equal(result.value.config.limits.pingIntervalMs, 15_000);
    assert.equal(result.value.config.limits.maxConcurrentRequests, 32);
    assert.equal(result.value.fileFound, false);
  });

  it("merges partial overrides over defaults", () => {
    const result = loadConfig({
      configPath: "x",
      readFile: () => JSON.stringify({ port: 5555 }),
    });
    assert.ok(result.ok);
    assert.equal(result.value.config.port, 5555);
    assert.equal(result.value.config.anthropic.baseUrl, "https://api.anthropic.com");
    assert.equal(result.value.fileFound, true);
  });

  it("providers.codex.baseUrl override is reflected in config.providers.codex.baseUrl", () => {
    const result = loadConfig({
      configPath: "x",
      readFile: () => JSON.stringify({ providers: { codex: { baseUrl: "https://example.com/api" } } }),
    });
    assert.ok(result.ok);
    assert.equal(result.value.config.providers.codex.baseUrl, "https://example.com/api");
  });

  it("expands ~ in the auth file path", () => {
    const result = loadConfig({
      configPath: "x",
      readFile: () => JSON.stringify({ providers: { codex: { authFile: "~/custom/auth.json" } } }),
    });
    assert.ok(result.ok);
    assert.equal(result.value.config.providers.codex.authFile, join(homedir(), "custom/auth.json"));
  });

  it("rejects invalid config values", () => {
    const result = loadConfig({ configPath: "x", readFile: () => JSON.stringify({ port: -1 }) });
    assert.ok(!result.ok);
    assert.equal(result.error.kind, "translate");
  });

  it("rejects unreadable (non-ENOENT) config files", () => {
    const result = loadConfig({
      configPath: "x",
      readFile: () => {
        throw new Error("EACCES");
      },
    });
    assert.ok(!result.ok);
  });

  it("returns an actionable error for malformed JSON", () => {
    const result = loadConfig({
      configPath: "/some/path/subswitch.config.json",
      readFile: () => "{not valid json",
    });
    assert.ok(!result.ok);
    assert.equal(result.error.kind, "translate");
    assert.match(
      result.error.message,
      /malformed JSON in \/some\/path\/subswitch\.config\.json — fix or delete the file/,
    );
  });

  it("explicit configPath that is missing returns an error", () => {
    const result = loadConfig({ configPath: "/nope/subswitch.config.json", readFile: missingFile });
    assert.ok(!result.ok);
    assert.equal(result.error.kind, "translate");
    assert.match(result.error.message, /not found/);
  });

  // -------------------------------------------------------------------------
  // R3: config discovery tests
  // -------------------------------------------------------------------------

  it("SUBSWITCH_CONFIG env var takes precedence over implicit cwd default", () => {
    let calledWith: string | undefined;
    const result = loadConfig({
      readFile: (path) => {
        calledWith = path;
        return JSON.stringify({ port: 7777 });
      },
      env: { SUBSWITCH_CONFIG: "/custom/subswitch.config.json" },
    });
    assert.ok(result.ok);
    assert.equal(calledWith, "/custom/subswitch.config.json");
    assert.equal(result.value.config.port, 7777);
    assert.equal(result.value.configPath, "/custom/subswitch.config.json");
    assert.equal(result.value.fileFound, true);
  });

  it("explicit configPath takes precedence over SUBSWITCH_CONFIG env var", () => {
    let calledWith: string | undefined;
    const result = loadConfig({
      configPath: "/explicit/subswitch.config.json",
      readFile: (path) => {
        calledWith = path;
        return JSON.stringify({ port: 9999 });
      },
      env: { SUBSWITCH_CONFIG: "/env/subswitch.config.json" },
    });
    assert.ok(result.ok);
    assert.equal(calledWith, "/explicit/subswitch.config.json");
    assert.equal(result.value.config.port, 9999);
  });

  it("SUBSWITCH_CONFIG pointing at a missing file returns an error", () => {
    const result = loadConfig({
      readFile: missingFile,
      env: { SUBSWITCH_CONFIG: "/missing/subswitch.config.json" },
    });
    assert.ok(!result.ok);
    assert.equal(result.error.kind, "translate");
    assert.match(result.error.message, /not found/);
  });

  it("expands ~ in SUBSWITCH_CONFIG path", () => {
    let calledWith: string | undefined;
    const result = loadConfig({
      readFile: (path) => {
        calledWith = path;
        return JSON.stringify({});
      },
      env: { SUBSWITCH_CONFIG: "~/my-subswitch.config.json" },
    });
    assert.ok(result.ok);
    assert.equal(calledWith, join(homedir(), "my-subswitch.config.json"));
  });

  it("reports configPath and fileFound in the success result", () => {
    const result = loadConfig({
      configPath: "/some/path.json",
      readFile: () => JSON.stringify({ port: 5000 }),
    });
    assert.ok(result.ok);
    assert.equal(result.value.configPath, "/some/path.json");
    assert.equal(result.value.fileFound, true);
  });

  // -------------------------------------------------------------------------
  // Alias validation (providers.codex.aliases)
  // -------------------------------------------------------------------------

  it("providers.codex.aliases defaults to empty object when absent", () => {
    const result = loadConfig({ readFile: missingFile, env: {} });
    assert.ok(result.ok);
    assert.deepEqual(result.value.config.providers.codex.aliases, {});
  });

  it("config.providers.codex.aliases is stored verbatim after validation", () => {
    const result = loadConfig({
      configPath: "x",
      readFile: () => JSON.stringify({ providers: { codex: { aliases: { "fast": "gpt-5.6-sol" } } } }),
    });
    assert.ok(result.ok);
    assert.deepEqual(result.value.config.providers.codex.aliases, { "fast": "gpt-5.6-sol" });
  });

  it("rejects providers.codex.aliases with a key matching 'claude-*' — would misroute Anthropic traffic", () => {
    const result = loadConfig({
      configPath: "x",
      readFile: () => JSON.stringify({ providers: { codex: { aliases: { "claude-sonnet-4-5": "gpt-5.6-sol" } } } }),
    });
    assert.ok(!result.ok);
    assert.equal(result.error.kind, "translate");
    assert.match(result.error.message, /claude/i);
  });

  it("rejects providers.codex.aliases with a key matching an Anthropic tier word (sonnet, opus, haiku, inherit)", () => {
    for (const tierWord of ["sonnet", "opus", "haiku", "inherit"]) {
      const result = loadConfig({
        configPath: "x",
        readFile: () => JSON.stringify({ providers: { codex: { aliases: { [tierWord]: "gpt-5.6-sol" } } } }),
      });
      assert.ok(!result.ok, `should reject tier word '${tierWord}'`);
      assert.equal(result.error.kind, "translate");
    }
  });

  it("rejects a providers.codex.aliases TARGET matching 'claude-*' — the target would become routable", () => {
    const result = loadConfig({
      configPath: "x",
      readFile: () => JSON.stringify({ providers: { codex: { aliases: { fast: "claude-sonnet-4-5" } } } }),
    });
    assert.ok(!result.ok, "claude-* alias target must be rejected");
    assert.equal(result.error.kind, "translate");
    assert.match(result.error.message, /claude/i);
  });

  it("rejects a providers.codex.aliases TARGET matching an Anthropic tier word", () => {
    for (const tierWord of ["sonnet", "opus", "haiku", "inherit"]) {
      const result = loadConfig({
        configPath: "x",
        readFile: () => JSON.stringify({ providers: { codex: { aliases: { fast: tierWord } } } }),
      });
      assert.ok(!result.ok, `should reject tier-word target '${tierWord}'`);
      assert.equal(result.error.kind, "translate");
    }
  });

  // -------------------------------------------------------------------------
  // limits.maxConcurrentRequests
  // -------------------------------------------------------------------------

  it("limits.maxConcurrentRequests defaults to 32", () => {
    const result = loadConfig({ readFile: missingFile, env: {} });
    assert.ok(result.ok);
    assert.equal(result.value.config.limits.maxConcurrentRequests, 32);
  });

  it("limits.maxConcurrentRequests can be overridden via config file", () => {
    const result = loadConfig({
      configPath: "x",
      readFile: () => JSON.stringify({ limits: { maxConcurrentRequests: 64 } }),
    });
    assert.ok(result.ok);
    assert.equal(result.value.config.limits.maxConcurrentRequests, 64);
  });

  // -------------------------------------------------------------------------
  // providers.codex.kind discriminant (P1-4)
  // -------------------------------------------------------------------------

  it("providers.codex config object carries kind='codex' after parsing", () => {
    // The discriminant is injected from the record key during parsing.
    // This test ensures the type machinery works end-to-end.
    const result = loadConfig({
      configPath: "x",
      readFile: () => JSON.stringify({ providers: { codex: { baseUrl: "https://chatgpt.com/backend-api/codex" } } }),
    });
    assert.ok(result.ok);
    // `kind` drives parse-time discrimination only — it must not survive into the
    // resolved slice, where the `providers` record key already selects the provider.
    assert.equal(result.value.config.providers.codex.baseUrl, "https://chatgpt.com/backend-api/codex");
    assert.ok(
      !Object.hasOwn(result.value.config.providers.codex, "kind"),
      "the parse-time discriminant must not leak into the resolved Config",
    );
  });

  // -------------------------------------------------------------------------
  // resolveConfig field mapping — every provider field reaches the resolved slice
  // -------------------------------------------------------------------------

  it("carries every providers.codex field through resolveConfig — a dropped field would be silent", () => {
    // Each value is a sentinel distinct from its schema default, so a resolver that
    // omits the field falls back to the default and this assertion fails. Without
    // this, dropping e.g. `userAgent` from PROVIDER_RESOLVERS.codex changes nothing
    // any test observes.
    const result = loadConfig({
      configPath: "x",
      readFile: () =>
        JSON.stringify({
          providers: {
            codex: {
              baseUrl: "https://sentinel.example/api",
              oauthTokenUrl: "https://sentinel.example/oauth/token",
              authFile: "~/sentinel/auth.json",
              userAgent: "sentinel-ua/9.9",
              aliases: { sentinel: "gpt-5.6-sol" },
              reasoningCache: { maxEntries: 7, maxBytes: 8 },
              requestTimeoutMs: 111,
              streamIdleTimeoutMs: 222,
              maxSseEventBytes: 333,
            },
          },
        }),
    });
    assert.ok(result.ok);
    assert.deepEqual(result.value.config.providers.codex, {
      baseUrl: "https://sentinel.example/api",
      oauthTokenUrl: "https://sentinel.example/oauth/token",
      // The one transformed field: expandHome runs in the resolver, not the schema.
      authFile: join(homedir(), "sentinel/auth.json"),
      userAgent: "sentinel-ua/9.9",
      aliases: { sentinel: "gpt-5.6-sol" },
      reasoningCache: { maxEntries: 7, maxBytes: 8 },
      requestTimeoutMs: 111,
      streamIdleTimeoutMs: 222,
      maxSseEventBytes: 333,
    });
  });

  it("aliasesByProvider exposes one alias record per ProviderId", () => {
    const result = loadConfig({
      configPath: "x",
      readFile: () => JSON.stringify({ providers: { codex: { aliases: { fast: "gpt-5.6-sol" } } } }),
    });
    assert.ok(result.ok);
    const byProvider = aliasesByProvider(result.value.config);
    assert.deepEqual(Object.keys(byProvider).sort(), [...PROVIDER_IDS].sort());
    assert.deepEqual(byProvider.codex, { fast: "gpt-5.6-sol" });
  });
});

// ---------------------------------------------------------------------------
// detectLegacyConfigKeys — hard-error gate on every config load (P1-8)
// ---------------------------------------------------------------------------

describe("detectLegacyConfigKeys", () => {
  it("returns empty array for a clean current-layout config", () => {
    const clean = { port: 4141, providers: { codex: { baseUrl: "https://chatgpt.com/backend-api/codex" } } };
    assert.deepEqual(detectLegacyConfigKeys(clean), []);
  });

  it("returns empty array for an empty object (no-config scenario)", () => {
    assert.deepEqual(detectLegacyConfigKeys({}), []);
  });

  it("returns empty array for non-object input (null, string, array)", () => {
    assert.deepEqual(detectLegacyConfigKeys(null), []);
    assert.deepEqual(detectLegacyConfigKeys("string"), []);
    assert.deepEqual(detectLegacyConfigKeys([1, 2, 3]), []);
  });

  it("detects top-level 'codex' key (moved to providers.codex)", () => {
    const legacy = { codex: { baseUrl: "https://example.com" } };
    const found = detectLegacyConfigKeys(legacy);
    assert.ok(found.some((f) => f.path === "codex"), "must detect legacy top-level codex key");
    assert.ok(found.some((f) => f.replacement.includes("providers.codex")));
  });

  it("detects top-level 'reasoningCache' key (moved to providers.codex.reasoningCache)", () => {
    const legacy = { reasoningCache: { maxEntries: 100 } };
    const found = detectLegacyConfigKeys(legacy);
    assert.ok(found.some((f) => f.path === "reasoningCache"));
    assert.ok(found.some((f) => f.replacement.includes("providers.codex.reasoningCache")));
  });

  it("detects 'limits.connectTimeoutMs' (moved to anthropic.connectTimeoutMs)", () => {
    const legacy = { limits: { connectTimeoutMs: 5000 } };
    const found = detectLegacyConfigKeys(legacy);
    assert.ok(found.some((f) => f.path === "limits.connectTimeoutMs"));
    assert.ok(found.some((f) => f.replacement.includes("anthropic.connectTimeoutMs")));
  });

  it("detects 'limits.maxUpstreamSockets' (moved to anthropic.maxUpstreamSockets)", () => {
    const legacy = { limits: { maxUpstreamSockets: 64 } };
    const found = detectLegacyConfigKeys(legacy);
    assert.ok(found.some((f) => f.path === "limits.maxUpstreamSockets"));
  });

  it("detects 'limits.streamIdleTimeoutMs' (moved to anthropic/codex)", () => {
    const legacy = { limits: { streamIdleTimeoutMs: 60000 } };
    const found = detectLegacyConfigKeys(legacy);
    assert.ok(found.some((f) => f.path === "limits.streamIdleTimeoutMs"));
  });

  it("detects 'limits.requestTimeoutMs' (moved to providers.codex.requestTimeoutMs)", () => {
    const legacy = { limits: { requestTimeoutMs: 120000 } };
    const found = detectLegacyConfigKeys(legacy);
    assert.ok(found.some((f) => f.path === "limits.requestTimeoutMs"));
  });

  it("detects 'limits.maxSseEventBytes' (moved to providers.codex.maxSseEventBytes)", () => {
    const legacy = { limits: { maxSseEventBytes: 1024 } };
    const found = detectLegacyConfigKeys(legacy);
    assert.ok(found.some((f) => f.path === "limits.maxSseEventBytes"));
  });

  it("detects 'codex.models' (deleted — use registry)", () => {
    const legacy = { codex: { models: ["gpt-5.5"] } };
    const found = detectLegacyConfigKeys(legacy);
    // Both 'codex' and 'codex.models' trigger
    assert.ok(found.some((f) => f.path === "codex.models"), "codex.models must be detected as a deleted key");
    assert.ok(found.some((f) => f.replacement.includes("removed")));
  });

  it("loadConfig rejects a file with any legacy key — silently reverting settings is the worst failure mode", () => {
    // A legacy config must never silently parse to defaults; it must hard-error.
    const result = loadConfig({
      configPath: "x",
      readFile: () => JSON.stringify({ codex: { baseUrl: "https://example.com" } }),
    });
    assert.ok(!result.ok, "legacy config must be rejected");
    assert.equal(result.error.kind, "translate");
    assert.ok(result.error.message.includes("outdated config layout"), "error must name the problem");
    assert.ok(result.error.message.includes("codex"), "error must name the detected key");
  });

  it("names both the detected key and where it moved, so the error is actionable", () => {
    // The value of the pre-parse scan is not just "reject" — it is telling the
    // operator where their setting went. A scan that errored without the mapping
    // would leave them with a config that is rejected and no way to fix it.
    const result = loadConfig({
      configPath: "x",
      readFile: () => JSON.stringify({ limits: { requestTimeoutMs: 120_000 } }),
    });
    assert.ok(!result.ok);
    assert.match(result.error.message, /`limits\.requestTimeoutMs`/);
    assert.match(result.error.message, /`providers\.codex\.requestTimeoutMs`/);
  });

  it("MUTATION CHECK: removing detectLegacyConfigKeys call would silently drop all settings", () => {
    // Zod strips unknown keys by default. Without detectLegacyConfigKeys, a pre-restructure
    // config { codex: { aliases: { fast: "gpt-5.6-sol" } } } would parse to defaults —
    // aliases vanish, baseUrl reverts, no error. This test ensures the gate exists.
    // If this test passes without the gate, it means the caller is still checking.
    const result = loadConfig({
      configPath: "x",
      readFile: () => JSON.stringify({ codex: { aliases: { fast: "gpt-5.6-sol" } } }),
    });
    // Must fail — not silently succeed with empty aliases
    assert.ok(!result.ok, "pre-restructure config must be rejected, not silently stripped to defaults");
  });
});

// ---------------------------------------------------------------------------
// detectUnknownProviderKeys — the other half of the PF-010 pre-parse scan
//
// `ProvidersSchema` is a z.object, so a block under an id that is not a ProviderId
// is STRIPPED: the config parses clean and the block does nothing. Same silent
// failure mode as the pre-`providers.*` layout, same remedy — scan the raw object
// before parsing, because a stripping schema can never report what it discarded.
// ---------------------------------------------------------------------------

describe("detectUnknownProviderKeys", () => {
  it("returns empty array when every providers.<id> key is a ProviderId", () => {
    assert.deepEqual(detectUnknownProviderKeys({ providers: { codex: { baseUrl: "https://x.example" } } }), []);
  });

  it("returns empty array when there is no providers block at all", () => {
    assert.deepEqual(detectUnknownProviderKeys({ port: 4141 }), []);
    assert.deepEqual(detectUnknownProviderKeys({}), []);
  });

  it("returns empty array for non-object input and a non-object providers value", () => {
    assert.deepEqual(detectUnknownProviderKeys(null), []);
    assert.deepEqual(detectUnknownProviderKeys("string"), []);
    assert.deepEqual(detectUnknownProviderKeys([1, 2, 3]), []);
    assert.deepEqual(detectUnknownProviderKeys({ providers: "codex" }), []);
  });

  it("detects a misspelled provider id", () => {
    assert.deepEqual(detectUnknownProviderKeys({ providers: { codexx: { baseUrl: "https://x.example" } } }), ["codexx"]);
  });

  it("reports unknown keys alongside known ones, in file order", () => {
    assert.deepEqual(
      detectUnknownProviderKeys({ providers: { kimi: {}, codex: {}, openai: {} } }),
      ["kimi", "openai"],
    );
  });

  it("ignores inherited properties — a polluted prototype must not forge a match", () => {
    const providers = Object.create({ evil: { baseUrl: "https://attacker.example" } }) as Record<string, unknown>;
    providers["codex"] = {};
    assert.deepEqual(detectUnknownProviderKeys({ providers }), []);
  });

  it("loadConfig rejects a misspelled provider block instead of silently ignoring it", () => {
    // Without the scan this config loads successfully and every setting under
    // `providers.codexx` is discarded by Zod — the operator sees a configured-looking
    // file and a proxy running on defaults, with nothing anywhere saying why.
    const result = loadConfig({
      configPath: "x",
      readFile: () =>
        JSON.stringify({ providers: { codexx: { baseUrl: "https://typo.example/api", userAgent: "typo/1.0" } } }),
    });
    assert.ok(!result.ok, "a provider block under an unknown id must be rejected, not stripped");
    assert.equal(result.error.kind, "translate");
    assert.match(result.error.message, /providers\.codexx/, "error must name the offending key");
    assert.match(result.error.message, /codex/, "error must list the known provider ids");
  });

  it("loadConfig still accepts a config whose only provider block is a known id", () => {
    const result = loadConfig({
      configPath: "x",
      readFile: () => JSON.stringify({ providers: { codex: { userAgent: "ok/1.0" } } }),
    });
    assert.ok(result.ok, "the negative check must not reject a valid config");
    assert.equal(result.value.config.providers.codex.userAgent, "ok/1.0");
  });
});
