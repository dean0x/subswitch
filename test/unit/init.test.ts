import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  planSettingsWrite,
  buildSubswitchConfig,
  resolveOptionsFromFlags,
  executeInit,
  runInitNonInteractive,
  type InitFsDeps,
} from "../../src/init.js";

// ---------------------------------------------------------------------------
// planSettingsWrite — pure planning tests
// ---------------------------------------------------------------------------

describe("planSettingsWrite", () => {
  it("creates settings with ANTHROPIC_BASE_URL when file does not exist", () => {
    const result = planSettingsWrite(null, 4141, "local", "/project");
    assert.ok(result.ok);
    assert.equal(result.value.path, join("/project", ".claude/settings.local.json"));
    const parsed = JSON.parse(result.value.content) as { env: { ANTHROPIC_BASE_URL: string } };
    assert.equal(parsed.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:4141");
  });

  it("merges ANTHROPIC_BASE_URL preserving existing keys", () => {
    const existing = JSON.stringify({ env: { MY_VAR: "keep" }, otherKey: "preserve" });
    const result = planSettingsWrite(existing, 9090, "local", "/project");
    assert.ok(result.ok);
    const parsed = JSON.parse(result.value.content) as {
      env: { MY_VAR: string; ANTHROPIC_BASE_URL: string };
      otherKey: string;
    };
    assert.equal(parsed.env.MY_VAR, "keep");
    assert.equal(parsed.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:9090");
    assert.equal(parsed.otherKey, "preserve");
  });

  it("overwrites an existing ANTHROPIC_BASE_URL with the new port", () => {
    const existing = JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:1234" } });
    const result = planSettingsWrite(existing, 4141, "local", "/project");
    assert.ok(result.ok);
    const parsed = JSON.parse(result.value.content) as { env: { ANTHROPIC_BASE_URL: string } };
    assert.equal(parsed.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:4141");
  });

  it("returns error on malformed JSON — does not throw", () => {
    const result = planSettingsWrite("{not valid json", 4141, "local", "/project");
    assert.ok(!result.ok);
    assert.equal(result.error.kind, "malformed_json");
    assert.ok(result.error.message.includes("malformed JSON"));
  });

  it("returns error when existing JSON is not an object", () => {
    const result = planSettingsWrite(JSON.stringify([1, 2, 3]), 4141, "local", "/project");
    assert.ok(!result.ok);
    assert.equal(result.error.kind, "malformed_json");
  });

  it("uses .claude/settings.local.json for target=local", () => {
    const result = planSettingsWrite(null, 4141, "local", "/project");
    assert.ok(result.ok);
    assert.ok(result.value.path.endsWith(".claude/settings.local.json"));
  });

  it("uses .claude/settings.json for target=shared", () => {
    const result = planSettingsWrite(null, 4141, "shared", "/project");
    assert.ok(result.ok);
    assert.ok(result.value.path.endsWith(".claude/settings.json"));
  });

  it("derives ANTHROPIC_BASE_URL from port — port and URL never drift", () => {
    const result = planSettingsWrite(null, 7777, "local", "/project");
    assert.ok(result.ok);
    const parsed = JSON.parse(result.value.content) as { env: { ANTHROPIC_BASE_URL: string } };
    assert.equal(parsed.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:7777");
  });
});

// ---------------------------------------------------------------------------
// buildSubswitchConfig — pure tests
// ---------------------------------------------------------------------------

describe("buildSubswitchConfig", () => {
  it("includes the port and codex models", () => {
    const content = buildSubswitchConfig(4141, ["gpt-5.6-sol", "gpt-5.5"]);
    const parsed = JSON.parse(content) as { port: number; codex: { models: string[] } };
    assert.equal(parsed.port, 4141);
    assert.deepEqual(parsed.codex.models, ["gpt-5.6-sol", "gpt-5.5"]);
  });

  it("produces valid JSON", () => {
    const content = buildSubswitchConfig(5555, ["gpt-5.6-luna"]);
    assert.doesNotThrow(() => JSON.parse(content));
  });
});

// ---------------------------------------------------------------------------
// resolveOptionsFromFlags — validation tests
// ---------------------------------------------------------------------------

describe("resolveOptionsFromFlags", () => {
  it("returns defaults when no flags are provided", () => {
    const result = resolveOptionsFromFlags({});
    assert.ok(result.ok);
    assert.equal(result.value.port, 4141);
    assert.equal(result.value.settingsTarget, "local");
    assert.deepEqual(result.value.codexModels, ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"]);
  });

  it("parses a valid --port flag", () => {
    const result = resolveOptionsFromFlags({ port: "9090" });
    assert.ok(result.ok);
    assert.equal(result.value.port, 9090);
  });

  it("rejects an invalid port string", () => {
    const result = resolveOptionsFromFlags({ port: "not-a-number" });
    assert.ok(!result.ok);
    assert.equal(result.error.kind, "invalid_input");
    assert.ok(result.error.message.includes("--port"));
  });

  it("rejects a port out of range", () => {
    const result = resolveOptionsFromFlags({ port: "99999" });
    assert.ok(!result.ok);
    assert.equal(result.error.kind, "invalid_input");
  });

  it("accepts settings-target=local", () => {
    const result = resolveOptionsFromFlags({ settingsTarget: "local" });
    assert.ok(result.ok);
    assert.equal(result.value.settingsTarget, "local");
  });

  it("accepts settings-target=shared", () => {
    const result = resolveOptionsFromFlags({ settingsTarget: "shared" });
    assert.ok(result.ok);
    assert.equal(result.value.settingsTarget, "shared");
  });

  it("rejects an invalid settings-target", () => {
    const result = resolveOptionsFromFlags({ settingsTarget: "global" });
    assert.ok(!result.ok);
    assert.equal(result.error.kind, "invalid_input");
    assert.ok(result.error.message.includes("--settings-target"));
  });

  it("accepts custom codex models", () => {
    const result = resolveOptionsFromFlags({ codexModels: ["gpt-5.6-sol", "gpt-5.5"] });
    assert.ok(result.ok);
    assert.deepEqual(result.value.codexModels, ["gpt-5.6-sol", "gpt-5.5"]);
  });

  it("rejects empty codex models list", () => {
    const result = resolveOptionsFromFlags({ codexModels: [] });
    assert.ok(!result.ok);
    assert.equal(result.error.kind, "invalid_input");
  });
});

// ---------------------------------------------------------------------------
// executeInit — integration tests with fake fs deps
// ---------------------------------------------------------------------------

const makeFakeDeps = (existingFiles: Record<string, string> = {}): InitFsDeps & {
  written: Record<string, string>;
} => {
  const written: Record<string, string> = {};
  return {
    readFile: async (path) => existingFiles[path] ?? null,
    writeFile: async (path, content) => {
      written[path] = content;
    },
    exists: (path) => path in existingFiles,
    cwd: "/project",
    written,
  };
};

describe("executeInit", () => {
  it("writes subswitch.config.json and settings.local.json for target=local", async () => {
    const deps = makeFakeDeps();
    const result = await executeInit(
      { port: 4141, codexModels: ["gpt-5.6-sol", "gpt-5.5"], settingsTarget: "local" },
      deps,
      "/project",
    );
    assert.ok(result.ok);

    // Settings file
    const settingsPath = join("/project", ".claude/settings.local.json");
    assert.ok(deps.written[settingsPath] !== undefined, "settings.local.json should be written");
    const settings = JSON.parse(deps.written[settingsPath] as string) as {
      env: { ANTHROPIC_BASE_URL: string };
    };
    assert.equal(settings.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:4141");

    // Config file
    const configPath = join("/project", "subswitch.config.json");
    assert.ok(deps.written[configPath] !== undefined, "subswitch.config.json should be written");
    const config = JSON.parse(deps.written[configPath] as string) as {
      port: number;
      codex: { models: string[] };
    };
    assert.equal(config.port, 4141);
    assert.deepEqual(config.codex.models, ["gpt-5.6-sol", "gpt-5.5"]);
  });

  it("writes settings.json for target=shared", async () => {
    const deps = makeFakeDeps();
    const result = await executeInit(
      { port: 4141, codexModels: ["gpt-5.6-sol"], settingsTarget: "shared" },
      deps,
      "/project",
    );
    assert.ok(result.ok);
    const settingsPath = join("/project", ".claude/settings.json");
    assert.ok(deps.written[settingsPath] !== undefined, "settings.json should be written");
  });

  it("preserves existing keys in the settings file", async () => {
    const settingsPath = join("/project", ".claude/settings.local.json");
    const deps = makeFakeDeps({
      [settingsPath]: JSON.stringify({ env: { MY_TOKEN: "keep" }, mcpServers: {} }),
    });
    const result = await executeInit(
      { port: 4141, codexModels: ["gpt-5.6-sol"], settingsTarget: "local" },
      deps,
      "/project",
    );
    assert.ok(result.ok);
    const written = JSON.parse(deps.written[settingsPath] as string) as {
      env: { MY_TOKEN: string; ANTHROPIC_BASE_URL: string };
      mcpServers: Record<string, unknown>;
    };
    assert.equal(written.env.MY_TOKEN, "keep");
    assert.equal(written.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:4141");
    assert.deepEqual(written.mcpServers, {});
  });

  it("returns error on malformed existing settings JSON — no partial write", async () => {
    const settingsPath = join("/project", ".claude/settings.local.json");
    const deps = makeFakeDeps({ [settingsPath]: "{bad json" });
    const result = await executeInit(
      { port: 4141, codexModels: ["gpt-5.6-sol"], settingsTarget: "local" },
      deps,
      "/project",
    );
    assert.ok(!result.ok);
    assert.equal(result.error.kind, "malformed_json");
    // No files written (no partial write).
    assert.equal(Object.keys(deps.written).length, 0);
  });
});

// ---------------------------------------------------------------------------
// runInitNonInteractive — non-TTY / CI flag path
// ---------------------------------------------------------------------------

describe("runInitNonInteractive", () => {
  it("succeeds with defaults when no flags given", async () => {
    const deps = makeFakeDeps();
    const outLines: string[] = [];
    const errLines: string[] = [];
    const exitCode = await runInitNonInteractive(
      {},
      "/project",
      deps,
      (l) => outLines.push(l),
      (l) => errLines.push(l),
    );
    assert.equal(exitCode, 0);
    assert.ok(outLines.some((l) => l.includes("Written:")), "should mention written files");
    assert.ok(outLines.some((l) => l.includes("Next:")), "should mention next steps");
    assert.equal(errLines.length, 0);
  });

  it("sets exit code 1 and writes to stderr on invalid --port", async () => {
    const deps = makeFakeDeps();
    const errLines: string[] = [];
    const exitCode = await runInitNonInteractive(
      { port: "99999" },
      "/project",
      deps,
      () => undefined,
      (l) => errLines.push(l),
    );
    assert.equal(exitCode, 1);
    assert.ok(errLines.some((l) => l.includes("invalid")), "should report the error");
  });

  it("sets exit code 1 on invalid --settings-target", async () => {
    const deps = makeFakeDeps();
    const errLines: string[] = [];
    const exitCode = await runInitNonInteractive(
      { settingsTarget: "global" },
      "/project",
      deps,
      () => undefined,
      (l) => errLines.push(l),
    );
    assert.equal(exitCode, 1);
    assert.ok(errLines.some((l) => l.includes("settings-target")));
  });

  it("writes correct ANTHROPIC_BASE_URL derived from --port", async () => {
    const deps = makeFakeDeps();
    const exitCode = await runInitNonInteractive(
      { port: "7777" },
      "/project",
      deps,
      () => undefined,
      () => undefined,
    );
    assert.equal(exitCode, 0);
    const settingsPath = join("/project", ".claude/settings.local.json");
    const settings = JSON.parse(deps.written[settingsPath] as string) as {
      env: { ANTHROPIC_BASE_URL: string };
    };
    assert.equal(settings.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:7777");
  });

  it("does not hang or prompt — completes synchronously without TTY", async () => {
    const deps = makeFakeDeps();
    // If this test completes, non-interactive mode worked without hanging.
    const exitCode = await runInitNonInteractive({}, "/project", deps, () => undefined, () => undefined);
    assert.equal(exitCode, 0);
  });
});
