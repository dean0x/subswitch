import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  loadConfig,
  detectLegacyConfigKeys,
  renderLegacyKeyEntry,
  detectUnknownProviderKeys,
  aliasesByProvider,
  enumerateDestinations,
  type RoutingDestination,
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
    assert.equal(result.value.config.anthropic.maxUpstreamSockets, 256);
    assert.equal(result.value.config.providers.codex.baseUrl, "https://chatgpt.com/backend-api/codex");
    assert.equal(result.value.config.providers.codex.oauthTokenUrl, "https://auth.openai.com/oauth/token");
    assert.equal(result.value.config.providers.codex.authFile, join(homedir(), ".codex/auth.json"));
    assert.equal(result.value.config.providers.codex.reasoningCache.maxEntries, 4096);
    assert.equal(result.value.config.providers.codex.reasoningCache.maxBytes, 64 * 1024 * 1024);
    assert.equal(result.value.config.providers.codex.requestTimeoutMs, 600_000);
    assert.equal(result.value.config.providers.codex.streamIdleTimeoutMs, 300_000);
    assert.equal(result.value.config.providers.codex.maxSseEventBytes, 4 * 1024 * 1024);
    assert.equal(result.value.config.providers.codex.maxAggregateBytes, 64 * 1024 * 1024);
    assert.equal(result.value.config.limits.maxBodyBytes, 32 * 1024 * 1024);
    assert.equal(result.value.config.limits.pingIntervalMs, 15_000);
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
  // Removed keys (hard-error via LEGACY_KEY_ENTRIES — BREAKING in 0.3.0)
  // -------------------------------------------------------------------------

  it("BREAKING 0.3.0: limits.maxConcurrentRequests is now rejected with a legible error naming the key", () => {
    // The admission gate was removed (ADR-010), so a v0.2.0 config carrying the key
    // must be rejected with an instruction rather than silently ignored.
    // MUTATION PROOF: removing the entry from LEGACY_KEY_ENTRIES causes this test to fail
    // because the config would produce a generic Zod "unrecognized key" message without
    // the 0.3.0 removal context.
    // MUTATION PROOF: changing the renderer to reuse "move X to Y" for removed keys would
    // produce "move `limits.maxConcurrentRequests` to `(removed…)`" — the delete-phrasing
    // assertions below would both fail.
    const result = loadConfig({
      configPath: "x",
      readFile: () => JSON.stringify({ limits: { maxConcurrentRequests: 64 } }),
    });
    assert.ok(!result.ok, "removed key must now be rejected as a hard error");
    assert.equal(result.error.kind, "translate");
    // Phrasing: delete `<key>` — <reason>
    assert.match(result.error.message, /delete `limits\.maxConcurrentRequests`/, "error must use delete-phrasing for removed keys");
    assert.match(result.error.message, /removed in 0\.3\.0 \(ADR-010\)/, "error must state the version and ADR");
    assert.ok(!result.error.message.includes("move `limits.maxConcurrentRequests`"), "must not use move-phrasing for a removed key");
  });

  it("BREAKING 0.3.0: a config with both v0.2.0-era removals is rejected and each key is named with delete-phrasing", () => {
    // Exactly two keys survived into a released config and were removed in 0.3.0.
    // MUTATION PROOF: re-adding either as .optional() in the schema AND removing it from
    // LEGACY_KEY_ENTRIES would cause the config to parse successfully → test fails.
    // MUTATION PROOF: reverting to the "move X to Y" renderer would produce
    // "move `anthropic.streamIdleTimeoutMs` to `(removed…)`" — the delete-phrasing
    // assertion and the no-move assertion both fail.
    const result = loadConfig({
      configPath: "x",
      readFile: () =>
        JSON.stringify({
          anthropic: { streamIdleTimeoutMs: 30_000 },
          limits: { maxConcurrentRequests: 32 },
        }),
    });
    assert.ok(!result.ok, "config with removed keys must be rejected");
    assert.equal(result.error.kind, "translate");
    // Every key must be named using delete-phrasing, not move-phrasing.
    const msg = result.error.message;
    assert.ok(msg.includes("delete `anthropic.streamIdleTimeoutMs`"), "must name anthropic.streamIdleTimeoutMs with delete-phrasing");
    assert.ok(msg.includes("delete `limits.maxConcurrentRequests`"), "must name limits.maxConcurrentRequests with delete-phrasing");
    assert.ok(!msg.includes("move `anthropic."), "must not use move-phrasing for removed keys");
  });

  it("a key that never shipped in a release is rejected by strict parsing, not by the legacy-key table", () => {
    // `limits.maxInFlightBytes` was introduced and removed inside a single unreleased
    // branch, so no config that has ever existed can carry it. A legacy-table row for it
    // would be unreachable guidance; `LimitsSchema` is a z.strictObject, so the key is
    // still a hard load error — with Zod's unrecognized-key message. (avoids PF-020: key
    // REMOVAL is the breaking direction, and strict parsing already covers it.)
    const result = loadConfig({
      configPath: "x",
      readFile: () => JSON.stringify({ limits: { maxInFlightBytes: 1_000_000 } }),
    });
    assert.ok(!result.ok, "an unknown limits key must still fail to load");
    assert.equal(result.error.kind, "translate");
    const msg = result.error.message;
    assert.match(msg, /invalid config: limits: Unrecognized key: "maxInFlightBytes"/, "must surface Zod's unrecognized-key message");
    assert.ok(!msg.includes("delete `limits.maxInFlightBytes`"), "must not carry a legacy-table row for a never-released key");
    assert.ok(!msg.includes("unsupported config keys"), "must not reach the legacy-key gate at all");
  });

  it("BREAKING 0.3.0: a config with both a moved key and a removed key produces one error with correct phrasing for each", () => {
    // This test exercises the single-pass detection: both a genuine move and a hard removal
    // appear in one config, and the renderer must phrase each correctly.
    // MUTATION PROOF: a renderer that treats all entries as "moved" would produce
    // "move `limits.streamIdleTimeoutMs` to `providers.codex.streamIdleTimeoutMs`; move
    //  `limits.maxConcurrentRequests` to `(removed…)`" — the delete-phrasing assertion fails.
    // MUTATION PROOF: a renderer that treats all entries as "removed" would produce
    // "delete `limits.streamIdleTimeoutMs` — …" — the move-phrasing assertion fails.
    const result = loadConfig({
      configPath: "x",
      readFile: () =>
        JSON.stringify({
          limits: { streamIdleTimeoutMs: 60_000, maxConcurrentRequests: 32 },
        }),
    });
    assert.ok(!result.ok, "config with legacy keys must be rejected");
    assert.equal(result.error.kind, "translate");
    const msg = result.error.message;
    // Moved key must use move-phrasing
    assert.match(msg, /move `limits\.streamIdleTimeoutMs` to `providers\.codex\.streamIdleTimeoutMs`/, "moved key must use move-phrasing");
    // Removed key must use delete-phrasing
    assert.match(msg, /delete `limits\.maxConcurrentRequests` — the admission gate was removed in 0\.3\.0 \(ADR-010\)/, "removed key must use delete-phrasing");
    // Both appear in a single error message
    assert.ok(msg.includes("unsupported config keys"), "single error must use the standard unsupported-keys prefix");
  });

  it("anthropic.maxUpstreamSockets defaults to 256 (raised to exceed peak concurrency)", () => {
    const result = loadConfig({ readFile: missingFile, env: {} });
    assert.ok(result.ok);
    assert.equal(result.value.config.anthropic.maxUpstreamSockets, 256);
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
              maxAggregateBytes: 444,
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
      maxAggregateBytes: 444,
      allowInsecureBaseUrl: false,
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
    assert.ok(found.some((f) => f.kind === "moved" && f.to.includes("providers.codex")));
  });

  it("detects top-level 'reasoningCache' key (moved to providers.codex.reasoningCache)", () => {
    const legacy = { reasoningCache: { maxEntries: 100 } };
    const found = detectLegacyConfigKeys(legacy);
    assert.ok(found.some((f) => f.path === "reasoningCache"));
    assert.ok(found.some((f) => f.kind === "moved" && f.to.includes("providers.codex.reasoningCache")));
  });

  it("detects 'limits.connectTimeoutMs' (moved to anthropic.connectTimeoutMs)", () => {
    const legacy = { limits: { connectTimeoutMs: 5000 } };
    const found = detectLegacyConfigKeys(legacy);
    assert.ok(found.some((f) => f.path === "limits.connectTimeoutMs"));
    assert.ok(found.some((f) => f.kind === "moved" && f.to.includes("anthropic.connectTimeoutMs")));
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

  it("detects 'codex.models' (removed — the routable set comes from the registry)", () => {
    const legacy = { codex: { models: ["gpt-5.5"] } };
    const found = detectLegacyConfigKeys(legacy);
    // Both 'codex' and 'codex.models' trigger
    const entry = found.find((f) => f.path === "codex.models");
    assert.ok(entry !== undefined, "codex.models must be detected as a removed key");
    assert.equal(entry.kind, "removed", "codex.models must be flagged as a removed key");
    // Same reason shape as every other removal: what changed, then version and ADR.
    // MUTATION PROOF: the pre-0.3.0 hand-appended entry carried no version and no ADR.
    assert.ok(entry.kind === "removed" && /removed in 0\.2\.0 \(ADR-006\)/.test(entry.reason), "reason must state the version and ADR like its siblings");
  });

  it("codex.models is rendered last so the operator instruction order is stable", () => {
    // The 0.2.0 CHANGELOG quotes this message verbatim; codex.models is its final clause.
    const found = detectLegacyConfigKeys({ codex: { models: ["gpt-5.5"] }, reasoningCache: { enabled: true } });
    assert.ok(found.length >= 2);
    assert.equal(found[found.length - 1]?.path, "codex.models", "codex.models must remain the last entry");
  });

  it("loadConfig rejects a file with any legacy key — silently reverting settings is the worst failure mode", () => {
    // A legacy config must never silently parse to defaults; it must hard-error.
    const result = loadConfig({
      configPath: "x",
      readFile: () => JSON.stringify({ codex: { baseUrl: "https://example.com" } }),
    });
    assert.ok(!result.ok, "legacy config must be rejected");
    assert.equal(result.error.kind, "translate");
    assert.ok(result.error.message.includes("unsupported config keys"), "error must name the problem");
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
// renderLegacyKeyEntry — one renderer for both gates (loadConfig and init)
//
// The instruction text used to be an inline ternary written verbatim in config.ts
// and init.ts. Two copies drift, and a ternary has no exhaustive arm: a third
// `kind` compiled clean and rendered as a *delete* instruction in both places.
// ---------------------------------------------------------------------------

describe("renderLegacyKeyEntry", () => {
  it("renders a moved entry as a move instruction naming the destination", () => {
    const rendered = renderLegacyKeyEntry({ kind: "moved", path: "limits.requestTimeoutMs", to: "providers.codex.requestTimeoutMs" });
    assert.equal(rendered, "move `limits.requestTimeoutMs` to `providers.codex.requestTimeoutMs`");
  });

  it("renders a removed entry as a delete instruction carrying the reason", () => {
    const rendered = renderLegacyKeyEntry({ kind: "removed", path: "limits.maxConcurrentRequests", reason: "the admission gate was removed in 0.3.0 (ADR-010)" });
    assert.equal(rendered, "delete `limits.maxConcurrentRequests` — the admission gate was removed in 0.3.0 (ADR-010)");
  });

  it("is the renderer the loadConfig gate uses, so the table and the error text cannot drift", () => {
    const expected = renderLegacyKeyEntry({ kind: "removed", path: "limits.maxConcurrentRequests", reason: "the admission gate was removed in 0.3.0 (ADR-010)" });
    const loaded = loadConfig({ configPath: "x", readFile: () => JSON.stringify({ limits: { maxConcurrentRequests: 32 } }) });
    assert.ok(!loaded.ok);
    assert.ok(loaded.error.message.includes(expected), "loadConfig must render through the shared renderer");
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

// ---------------------------------------------------------------------------
// TS-02: z.strictObject catches typo'd leaf keys (avoids PF-010)
//
// Before this fix, CodexProviderSchema, AnthropicSchema, LimitsSchema and
// FileConfigSchema used z.object (which STRIPS unknown keys). A typo'd key
// like `userAgnet` parsed clean and silently fell back to the default, giving
// the user no diagnostic and a proxy running on an unexpected value.
//
// MUTATION PROOF: removing z.strictObject (reverting to z.object) on any of
// these schemas causes the test for that schema to pass vacuously — the typo'd
// config parses without error and the assertion `!result.ok` fails.
// ---------------------------------------------------------------------------

describe("TS-02: z.strictObject catches typo'd leaf keys", () => {
  it("rejects providers.codex.userAgnet (typo of userAgent) — not silently stripped to default", () => {
    const result = loadConfig({
      configPath: "x",
      readFile: () =>
        JSON.stringify({ providers: { codex: { userAgnet: "bad-typo/1.0" } } }),
    });
    assert.ok(!result.ok, "a typo'd key must be rejected, not silently stripped to defaults");
    assert.equal(result.error.kind, "translate");
    assert.match(result.error.message, /userAgnet/i, "error must name the offending key");
  });

  it("rejects providers.codex.baseURL (wrong casing, correct value would be baseUrl)", () => {
    const result = loadConfig({
      configPath: "x",
      readFile: () =>
        JSON.stringify({ providers: { codex: { baseURL: "https://chatgpt.com/backend-api/codex" } } }),
    });
    assert.ok(!result.ok, "wrong-cased key must be rejected — casing is significant in JSON");
    assert.equal(result.error.kind, "translate");
    assert.match(result.error.message, /baseURL/i, "error must name the offending key");
  });

  it("rejects limits.pingIntervalMS (wrong casing, correct value would be pingIntervalMs)", () => {
    const result = loadConfig({
      configPath: "x",
      readFile: () => JSON.stringify({ limits: { pingIntervalMS: 5000 } }),
    });
    assert.ok(!result.ok, "wrong-cased key must be rejected");
    assert.equal(result.error.kind, "translate");
    assert.match(result.error.message, /pingIntervalMS/i, "error must name the offending key");
  });

  it("rejects anthropic.baseURL (wrong casing, correct value would be baseUrl)", () => {
    const result = loadConfig({
      configPath: "x",
      readFile: () =>
        JSON.stringify({ anthropic: { baseURL: "https://api.anthropic.com" } }),
    });
    assert.ok(!result.ok, "wrong-cased anthropic key must be rejected");
    assert.equal(result.error.kind, "translate");
    assert.match(result.error.message, /baseURL/i, "error must name the offending key");
  });

  it("rejects a top-level unknown key (FileConfigSchema is strict)", () => {
    const result = loadConfig({
      configPath: "x",
      readFile: () => JSON.stringify({ unknownTopLevel: true }),
    });
    assert.ok(!result.ok, "unknown top-level key must be rejected");
    assert.equal(result.error.kind, "translate");
  });

  it("accepts a valid config — strict schemas must not over-reject", () => {
    const result = loadConfig({
      configPath: "x",
      readFile: () =>
        JSON.stringify({
          port: 4141,
          logLevel: "info",
          anthropic: { baseUrl: "https://api.anthropic.com" },
          providers: { codex: { userAgent: "ok/1.0" } },
          limits: { pingIntervalMs: 5000 },
        }),
    });
    assert.ok(result.ok, `valid config should be accepted; got: ${!result.ok ? result.error.message : ""}`);
  });
});

// ---------------------------------------------------------------------------
// SEC-01 + COMP-01/02/03: HTTPS-only schema refinements for credential URLs
//
// http:// to a non-loopback host sends subscription credentials in cleartext.
// Loopback (127.0.0.0/8, localhost, ::1) is exempt — the e2e dev workflow
// points baseUrl at http://127.0.0.1:4142 intentionally.
//
// MUTATION PROOF: removing the .refine(requireHttpsOrLoopback) call on any URL
// field causes the test for that field to pass vacuously — the http:// URL
// loads clean and the `!result.ok` assertion fails.
// ---------------------------------------------------------------------------

describe("SEC-01: HTTPS-only refinements for credential URLs", () => {
  // ---- providers.codex.baseUrl ----
  it("rejects providers.codex.baseUrl with http:// to a non-loopback host", () => {
    const result = loadConfig({
      configPath: "x",
      readFile: () =>
        JSON.stringify({ providers: { codex: { baseUrl: "http://chatgpt.com/backend-api/codex" } } }),
    });
    assert.ok(!result.ok, "http:// to chatgpt.com must be rejected — credential leaks in cleartext");
    assert.equal(result.error.kind, "translate");
    assert.match(result.error.message, /https/i, "error must mention the https requirement");
  });

  it("accepts providers.codex.baseUrl with https:// to any host", () => {
    const result = loadConfig({
      configPath: "x",
      readFile: () =>
        JSON.stringify({ providers: { codex: { baseUrl: "https://custom.proxy.example/api" } } }),
    });
    assert.ok(result.ok, `https:// to any host must be accepted; got: ${!result.ok ? result.error.message : ""}`);
  });

  it("accepts providers.codex.baseUrl with http:// to 127.0.0.1 (loopback exemption)", () => {
    const result = loadConfig({
      configPath: "x",
      readFile: () =>
        JSON.stringify({ providers: { codex: { baseUrl: "http://127.0.0.1:4142/backend-api/codex" } } }),
    });
    assert.ok(result.ok, `http://127.0.0.1 must be accepted (loopback exemption); got: ${!result.ok ? result.error.message : ""}`);
    assert.equal(result.value.config.providers.codex.baseUrl, "http://127.0.0.1:4142/backend-api/codex");
  });

  it("accepts providers.codex.baseUrl with http:// to localhost (loopback exemption)", () => {
    const result = loadConfig({
      configPath: "x",
      readFile: () =>
        JSON.stringify({ providers: { codex: { baseUrl: "http://localhost:4142/backend-api/codex" } } }),
    });
    assert.ok(result.ok, `http://localhost must be accepted (loopback exemption); got: ${!result.ok ? result.error.message : ""}`);
  });

  it("accepts providers.codex.baseUrl with http:// to 127.x.x.x subnet (loopback exemption)", () => {
    const result = loadConfig({
      configPath: "x",
      readFile: () =>
        JSON.stringify({ providers: { codex: { baseUrl: "http://127.0.0.2:4142/" } } }),
    });
    assert.ok(result.ok, `http://127.0.0.2 must be accepted (loopback subnet); got: ${!result.ok ? result.error.message : ""}`);
  });

  // ---- providers.codex.oauthTokenUrl ----
  it("rejects providers.codex.oauthTokenUrl with http:// to a non-loopback host", () => {
    const result = loadConfig({
      configPath: "x",
      readFile: () =>
        JSON.stringify({ providers: { codex: { oauthTokenUrl: "http://auth.openai.com/oauth/token" } } }),
    });
    assert.ok(!result.ok, "http:// oauthTokenUrl must be rejected — long-lived refresh token leaks in cleartext");
    assert.equal(result.error.kind, "translate");
    assert.match(result.error.message, /https/i);
  });

  it("accepts providers.codex.oauthTokenUrl with https://", () => {
    const result = loadConfig({
      configPath: "x",
      readFile: () =>
        JSON.stringify({ providers: { codex: { oauthTokenUrl: "https://custom.auth.example/oauth/token" } } }),
    });
    assert.ok(result.ok, `https:// oauthTokenUrl must be accepted; got: ${!result.ok ? result.error.message : ""}`);
    assert.equal(result.value.config.providers.codex.oauthTokenUrl, "https://custom.auth.example/oauth/token");
  });

  it("accepts providers.codex.oauthTokenUrl with http:// to loopback (loopback exemption)", () => {
    const result = loadConfig({
      configPath: "x",
      readFile: () =>
        JSON.stringify({ providers: { codex: { oauthTokenUrl: "http://127.0.0.1:9000/oauth" } } }),
    });
    assert.ok(result.ok, `http://127.0.0.1 oauthTokenUrl must be accepted; got: ${!result.ok ? result.error.message : ""}`);
  });

  // ---- anthropic.baseUrl ----
  it("rejects anthropic.baseUrl with http:// to a non-loopback host", () => {
    const result = loadConfig({
      configPath: "x",
      readFile: () =>
        JSON.stringify({ anthropic: { baseUrl: "http://api.anthropic.com" } }),
    });
    assert.ok(!result.ok, "http:// anthropic.baseUrl must be rejected — sk-ant-* key leaks in cleartext");
    assert.equal(result.error.kind, "translate");
    assert.match(result.error.message, /https/i);
  });

  it("accepts anthropic.baseUrl with https://", () => {
    const result = loadConfig({
      configPath: "x",
      readFile: () =>
        JSON.stringify({ anthropic: { baseUrl: "https://custom-anthropic-endpoint.example/api" } }),
    });
    assert.ok(result.ok, `https:// anthropic.baseUrl must be accepted; got: ${!result.ok ? result.error.message : ""}`);
  });

  it("accepts anthropic.baseUrl with http:// to loopback (loopback exemption)", () => {
    const result = loadConfig({
      configPath: "x",
      readFile: () =>
        JSON.stringify({ anthropic: { baseUrl: "http://127.0.0.1:8080" } }),
    });
    assert.ok(result.ok, `http://127.0.0.1 anthropic.baseUrl must be accepted; got: ${!result.ok ? result.error.message : ""}`);
  });
});

// ---------------------------------------------------------------------------
// enumerateDestinations — ARCH-04
// ---------------------------------------------------------------------------

describe("enumerateDestinations", () => {
  const defaultConfig = (() => {
    const r = loadConfig({ readFile: () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); }, env: {} });
    assert.ok(r.ok);
    return r.value.config;
  })();

  it("first destination is Anthropic with routing='passthrough'", () => {
    const destinations = enumerateDestinations(defaultConfig);
    assert.ok(destinations.length > 0, "must return at least one destination");
    const first = destinations[0] as RoutingDestination;
    assert.equal(first.routing, "passthrough");
    assert.equal(first.id, "anthropic");
    assert.equal(first.displayName, "Anthropic");
  });

  it("includes an entry for every PROVIDER_ID with routing='registry'", () => {
    const destinations = enumerateDestinations(defaultConfig);
    for (const id of PROVIDER_IDS) {
      const entry = destinations.find((d) => d.id === id);
      assert.ok(entry !== undefined, `enumerateDestinations must include provider '${id}'`);
      assert.equal(entry.routing, "registry", `provider '${id}' must have routing='registry'`);
    }
  });

  it("total destination count equals 1 (Anthropic) + PROVIDER_IDS.length", () => {
    const destinations = enumerateDestinations(defaultConfig);
    assert.equal(
      destinations.length,
      1 + PROVIDER_IDS.length,
      "total count must be Anthropic (1) + all registry providers",
    );
  });

  it("registry destinations carry an authFile field", () => {
    const destinations = enumerateDestinations(defaultConfig);
    for (const d of destinations) {
      if (d.routing === "registry") {
        assert.ok(
          typeof d.authFile === "string" && d.authFile.length > 0,
          `registry destination '${d.id}' must have a non-empty authFile`,
        );
      }
    }
  });

  it("MUTATION CHECK: Anthropic must be first — omitting it would shrink destinations by 1", () => {
    // If the passthrough entry were removed, length would equal PROVIDER_IDS.length only.
    const destinations = enumerateDestinations(defaultConfig);
    assert.ok(
      destinations.length > PROVIDER_IDS.length,
      "destinations must outnumber PROVIDER_IDS alone — Anthropic must be present",
    );
  });
});
