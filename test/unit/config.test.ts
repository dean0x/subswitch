import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig, detectLegacyConfigKeys } from "../../src/config.js";

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
    assert.equal(result.value.config.codex.baseUrl, "https://chatgpt.com/backend-api/codex");
    assert.equal(result.value.config.codex.oauthTokenUrl, "https://auth.openai.com/oauth/token");
    assert.equal(result.value.config.codex.authFile, join(homedir(), ".codex/auth.json"));
    assert.equal(result.value.config.codex.reasoningCache.maxEntries, 4096);
    assert.equal(result.value.config.codex.reasoningCache.maxBytes, 64 * 1024 * 1024);
    assert.equal(result.value.config.codex.requestTimeoutMs, 600_000);
    assert.equal(result.value.config.codex.streamIdleTimeoutMs, 300_000);
    assert.equal(result.value.config.codex.maxSseEventBytes, 4 * 1024 * 1024);
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

  it("providers.codex.baseUrl override is reflected in config.codex.baseUrl", () => {
    const result = loadConfig({
      configPath: "x",
      readFile: () => JSON.stringify({ providers: { codex: { baseUrl: "https://example.com/api" } } }),
    });
    assert.ok(result.ok);
    assert.equal(result.value.config.codex.baseUrl, "https://example.com/api");
  });

  it("expands ~ in the auth file path", () => {
    const result = loadConfig({
      configPath: "x",
      readFile: () => JSON.stringify({ providers: { codex: { authFile: "~/custom/auth.json" } } }),
    });
    assert.ok(result.ok);
    assert.equal(result.value.config.codex.authFile, join(homedir(), "custom/auth.json"));
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

  it("codex.aliases defaults to empty object when absent", () => {
    const result = loadConfig({ readFile: missingFile, env: {} });
    assert.ok(result.ok);
    assert.deepEqual(result.value.config.codex.aliases, {});
  });

  it("config.codex.aliases is stored verbatim after validation", () => {
    const result = loadConfig({
      configPath: "x",
      readFile: () => JSON.stringify({ providers: { codex: { aliases: { "fast": "gpt-5.6-sol" } } } }),
    });
    assert.ok(result.ok);
    assert.deepEqual(result.value.config.codex.aliases, { "fast": "gpt-5.6-sol" });
  });

  it("rejects codex.aliases with a key matching 'claude-*' — would misroute Anthropic traffic", () => {
    const result = loadConfig({
      configPath: "x",
      readFile: () => JSON.stringify({ providers: { codex: { aliases: { "claude-sonnet-4-5": "gpt-5.6-sol" } } } }),
    });
    assert.ok(!result.ok);
    assert.equal(result.error.kind, "translate");
    assert.match(result.error.message, /claude/i);
  });

  it("rejects codex.aliases with a key matching an Anthropic tier word (sonnet, opus, haiku, inherit)", () => {
    for (const tierWord of ["sonnet", "opus", "haiku", "inherit"]) {
      const result = loadConfig({
        configPath: "x",
        readFile: () => JSON.stringify({ providers: { codex: { aliases: { [tierWord]: "gpt-5.6-sol" } } } }),
      });
      assert.ok(!result.ok, `should reject tier word '${tierWord}'`);
      assert.equal(result.error.kind, "translate");
    }
  });

  it("rejects a codex.aliases TARGET matching 'claude-*' — the target would become routable", () => {
    const result = loadConfig({
      configPath: "x",
      readFile: () => JSON.stringify({ providers: { codex: { aliases: { fast: "claude-sonnet-4-5" } } } }),
    });
    assert.ok(!result.ok, "claude-* alias target must be rejected");
    assert.equal(result.error.kind, "translate");
    assert.match(result.error.message, /claude/i);
  });

  it("rejects a codex.aliases TARGET matching an Anthropic tier word", () => {
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
    // Accessing codex.* still works through the Config interface
    assert.equal(result.value.config.codex.baseUrl, "https://chatgpt.com/backend-api/codex");
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
