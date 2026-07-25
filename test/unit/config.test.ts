import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config.js";
import { ALL_MODEL_IDS } from "../../src/models.js";

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
    assert.equal(result.value.config.codex.baseUrl, "https://chatgpt.com/backend-api/codex");
    assert.equal(result.value.config.codex.oauthTokenUrl, "https://auth.openai.com/oauth/token");
    assert.equal(result.value.config.codex.authFile, join(homedir(), ".codex/auth.json"));
    // Derive from the canonical registry — re-hardcoding recreates the exact maintenance tax this feature removes.
    assert.deepEqual(result.value.config.codex.models, [...ALL_MODEL_IDS]);
    assert.equal(result.value.config.reasoningCache.maxEntries, 4096);
    assert.equal(result.value.config.reasoningCache.maxBytes, 64 * 1024 * 1024);
    assert.equal(result.value.config.limits.maxBodyBytes, 32 * 1024 * 1024);
    assert.equal(result.value.config.limits.connectTimeoutMs, 10_000);
    assert.equal(result.value.config.limits.streamIdleTimeoutMs, 300_000);
    assert.equal(result.value.config.limits.requestTimeoutMs, 600_000);
    assert.equal(result.value.config.limits.pingIntervalMs, 15_000);
    assert.equal(result.value.fileFound, false);
  });

  it("merges partial overrides over defaults", () => {
    const result = loadConfig({
      configPath: "x",
      readFile: () => JSON.stringify({ port: 5555, codex: { models: ["gpt-5.5"] } }),
    });
    assert.ok(result.ok);
    assert.equal(result.value.config.port, 5555);
    assert.deepEqual(result.value.config.codex.models, ["gpt-5.5"]);
    assert.equal(result.value.config.anthropic.baseUrl, "https://api.anthropic.com");
    assert.equal(result.value.fileFound, true);
  });

  it("expands ~ in the auth file path", () => {
    const result = loadConfig({ configPath: "x", readFile: () => JSON.stringify({ codex: { authFile: "~/custom/auth.json" } }) });
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
  // Alias and model normalization (new in this phase)
  // -------------------------------------------------------------------------

  it("codex.aliases defaults to empty object when absent", () => {
    const result = loadConfig({ readFile: missingFile, env: {} });
    assert.ok(result.ok);
    assert.deepEqual(result.value.config.codex.aliases, {});
  });

  it("normalizes derived family alias in codex.models to its canonical id", () => {
    // "sol" → "gpt-5.6-sol" via derived family alias
    const result = loadConfig({
      configPath: "x",
      readFile: () => JSON.stringify({ codex: { models: ["sol"] } }),
    });
    assert.ok(result.ok);
    assert.deepEqual(result.value.config.codex.models, ["gpt-5.6-sol"]);
  });

  it("an explicit codex.models list is authoritative and narrowing", () => {
    const result = loadConfig({
      configPath: "x",
      readFile: () => JSON.stringify({ codex: { models: ["gpt-5.5"] } }),
    });
    assert.ok(result.ok);
    assert.deepEqual(result.value.config.codex.models, ["gpt-5.5"]);
  });

  it("an unknown model id in codex.models passes through verbatim (forward-compat)", () => {
    const result = loadConfig({
      configPath: "x",
      readFile: () => JSON.stringify({ codex: { models: ["custom-forward-compat-model"] } }),
    });
    assert.ok(result.ok);
    assert.deepEqual(result.value.config.codex.models, ["custom-forward-compat-model"]);
  });

  it("codex.aliases overrides the derived family alias during normalization", () => {
    // "sol" would normally expand to "gpt-5.6-sol" but the override redirects it
    const result = loadConfig({
      configPath: "x",
      readFile: () => JSON.stringify({ codex: { models: ["sol"], aliases: { "sol": "gpt-5.6-terra" } } }),
    });
    assert.ok(result.ok);
    assert.deepEqual(result.value.config.codex.models, ["gpt-5.6-terra"]);
  });

  it("an override target outside the registry is included in the routable set when codex.models is absent", () => {
    const result = loadConfig({
      configPath: "x",
      readFile: () => JSON.stringify({ codex: { aliases: { "fast": "custom-forward-compat-model" } } }),
    });
    assert.ok(result.ok);
    assert.ok(
      result.value.config.codex.models.includes("custom-forward-compat-model"),
      "pressure valve: override target must be routable when models is absent",
    );
  });

  it("config.codex.aliases is stored verbatim after validation", () => {
    const result = loadConfig({
      configPath: "x",
      readFile: () => JSON.stringify({ codex: { aliases: { "fast": "gpt-5.6-sol" } } }),
    });
    assert.ok(result.ok);
    assert.deepEqual(result.value.config.codex.aliases, { "fast": "gpt-5.6-sol" });
  });

  it("rejects codex.aliases with a key matching 'claude-*' — would misroute Anthropic traffic", () => {
    const result = loadConfig({
      configPath: "x",
      readFile: () => JSON.stringify({ codex: { aliases: { "claude-sonnet-4-5": "gpt-5.6-sol" } } }),
    });
    assert.ok(!result.ok);
    assert.equal(result.error.kind, "translate");
    assert.match(result.error.message, /claude/i);
  });

  it("rejects codex.aliases with a key matching an Anthropic tier word (sonnet, opus, haiku, inherit)", () => {
    for (const tierWord of ["sonnet", "opus", "haiku", "inherit"]) {
      const result = loadConfig({
        configPath: "x",
        readFile: () => JSON.stringify({ codex: { aliases: { [tierWord]: "gpt-5.6-sol" } } }),
      });
      assert.ok(!result.ok, `should reject tier word '${tierWord}'`);
      assert.equal(result.error.kind, "translate");
    }
  });

  it("rejects an empty codex.models array — would silently disable all Codex routing", () => {
    const result = loadConfig({
      configPath: "x",
      readFile: () => JSON.stringify({ codex: { models: [] } }),
    });
    assert.ok(!result.ok);
    assert.equal(result.error.kind, "translate");
  });

  // -------------------------------------------------------------------------
  // codexModelsPinned — presence detection for doctor's nudge (Phase C)
  // -------------------------------------------------------------------------

  it("codexModelsPinned is false when codex.models is not explicitly set", () => {
    const result = loadConfig({ readFile: missingFile, env: {} });
    assert.ok(result.ok);
    assert.equal(result.value.codexModelsPinned, false);
  });

  it("codexModelsPinned is true when models explicitly lists a generation-specific id with a family alias", () => {
    // gpt-5.6-sol has family "sol" — explicitly listing it means the config is pinned
    const result = loadConfig({
      configPath: "x",
      readFile: () => JSON.stringify({ codex: { models: ["gpt-5.6-sol", "gpt-5.5"] } }),
    });
    assert.ok(result.ok);
    assert.equal(result.value.codexModelsPinned, true);
  });

  it("codexModelsPinned is false when models only contains ids without family aliases", () => {
    // gpt-5.5 has no family — not a pinned generation-specific id
    const result = loadConfig({
      configPath: "x",
      readFile: () => JSON.stringify({ codex: { models: ["gpt-5.5"] } }),
    });
    assert.ok(result.ok);
    assert.equal(result.value.codexModelsPinned, false);
  });

  it("codexModelsPinned is false when models only contains unknown/alias ids", () => {
    // "sol" is an alias name, not a generation-specific id
    const result = loadConfig({
      configPath: "x",
      readFile: () => JSON.stringify({ codex: { models: ["sol"] } }),
    });
    assert.ok(result.ok);
    assert.equal(result.value.codexModelsPinned, false);
  });
});
