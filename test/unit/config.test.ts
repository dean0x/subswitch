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
  it("returns full defaults when the config file is missing", () => {
    const result = loadConfig({ configPath: "/nope/croxy.config.json", readFile: missingFile });
    assert.ok(result.ok);
    assert.equal(result.value.port, 4141);
    assert.equal(result.value.logLevel, "info");
    assert.equal(result.value.anthropic.baseUrl, "https://api.anthropic.com");
    assert.equal(result.value.codex.baseUrl, "https://chatgpt.com/backend-api/codex");
    assert.equal(result.value.codex.oauthTokenUrl, "https://auth.openai.com/oauth/token");
    assert.equal(result.value.codex.authFile, join(homedir(), ".codex/auth.json"));
    assert.deepEqual(result.value.codex.models, ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"]);
    assert.equal(result.value.reasoningCache.maxEntries, 256);
    assert.equal(result.value.limits.maxBodyBytes, 32 * 1024 * 1024);
    assert.equal(result.value.limits.connectTimeoutMs, 10_000);
    assert.equal(result.value.limits.streamIdleTimeoutMs, 300_000);
    assert.equal(result.value.limits.requestTimeoutMs, 600_000);
    assert.equal(result.value.limits.pingIntervalMs, 15_000);
  });

  it("merges partial overrides over defaults", () => {
    const result = loadConfig({
      configPath: "x",
      readFile: () => JSON.stringify({ port: 5555, codex: { models: ["gpt-5.5"] } }),
    });
    assert.ok(result.ok);
    assert.equal(result.value.port, 5555);
    assert.deepEqual(result.value.codex.models, ["gpt-5.5"]);
    assert.equal(result.value.anthropic.baseUrl, "https://api.anthropic.com");
  });

  it("expands ~ in the auth file path", () => {
    const result = loadConfig({ configPath: "x", readFile: () => JSON.stringify({ codex: { authFile: "~/custom/auth.json" } }) });
    assert.ok(result.ok);
    assert.equal(result.value.codex.authFile, join(homedir(), "custom/auth.json"));
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
});
