import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config.js";

const missingFile = (): never => {
  const error = new Error("ENOENT") as Error & { code: string };
  error.code = "ENOENT";
  throw error;
};

describe("loadConfig", () => {
  it("returns full defaults when the implicit cwd config file is missing", () => {
    // No configPath, no CROXY_CONFIG env var — implicit cwd path → silently use defaults.
    const result = loadConfig({ readFile: missingFile, env: {} });
    assert.ok(result.ok);
    assert.equal(result.value.config.port, 4141);
    assert.equal(result.value.config.logLevel, "info");
    assert.equal(result.value.config.anthropic.baseUrl, "https://api.anthropic.com");
    assert.equal(result.value.config.codex.baseUrl, "https://chatgpt.com/backend-api/codex");
    assert.equal(result.value.config.codex.oauthTokenUrl, "https://auth.openai.com/oauth/token");
    assert.equal(result.value.config.codex.authFile, join(homedir(), ".codex/auth.json"));
    assert.deepEqual(result.value.config.codex.models, ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"]);
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

  it("explicit configPath that is missing returns an error", () => {
    const result = loadConfig({ configPath: "/nope/croxy.config.json", readFile: missingFile });
    assert.ok(!result.ok);
    assert.equal(result.error.kind, "translate");
    assert.match(result.error.message, /not found/);
  });

  // -------------------------------------------------------------------------
  // R3: config discovery tests
  // -------------------------------------------------------------------------

  it("CROXY_CONFIG env var takes precedence over implicit cwd default", () => {
    let calledWith: string | undefined;
    const result = loadConfig({
      readFile: (path) => {
        calledWith = path;
        return JSON.stringify({ port: 7777 });
      },
      env: { CROXY_CONFIG: "/custom/croxy.config.json" },
    });
    assert.ok(result.ok);
    assert.equal(calledWith, "/custom/croxy.config.json");
    assert.equal(result.value.config.port, 7777);
    assert.equal(result.value.configPath, "/custom/croxy.config.json");
    assert.equal(result.value.fileFound, true);
  });

  it("explicit configPath takes precedence over CROXY_CONFIG env var", () => {
    let calledWith: string | undefined;
    const result = loadConfig({
      configPath: "/explicit/croxy.config.json",
      readFile: (path) => {
        calledWith = path;
        return JSON.stringify({ port: 9999 });
      },
      env: { CROXY_CONFIG: "/env/croxy.config.json" },
    });
    assert.ok(result.ok);
    assert.equal(calledWith, "/explicit/croxy.config.json");
    assert.equal(result.value.config.port, 9999);
  });

  it("CROXY_CONFIG pointing at a missing file returns an error", () => {
    const result = loadConfig({
      readFile: missingFile,
      env: { CROXY_CONFIG: "/missing/croxy.config.json" },
    });
    assert.ok(!result.ok);
    assert.equal(result.error.kind, "translate");
    assert.match(result.error.message, /not found/);
  });

  it("expands ~ in CROXY_CONFIG path", () => {
    let calledWith: string | undefined;
    const result = loadConfig({
      readFile: (path) => {
        calledWith = path;
        return JSON.stringify({});
      },
      env: { CROXY_CONFIG: "~/my-croxy.config.json" },
    });
    assert.ok(result.ok);
    assert.equal(calledWith, join(homedir(), "my-croxy.config.json"));
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
});
