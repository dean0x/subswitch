import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  planSettingsWrite,
  planConfigWrite,
  settingsPathFor,
  resolveOptionsFromFlags,
  resolveInitDispatch,
  collectPreconditionWarnings,
  executeInit,
  runInitNonInteractive,
  runInitDryRun,
} from "../../src/init.js";
import { makeFakeDeps } from "./init-test-helpers.js";

// ---------------------------------------------------------------------------
// settingsPathFor — pure path resolution
// ---------------------------------------------------------------------------

describe("settingsPathFor", () => {
  it("local target uses settings.local.json", () => {
    assert.equal(settingsPathFor("local", "/project"), join("/project", ".claude/settings.local.json"));
  });

  it("shared target uses settings.json", () => {
    assert.equal(settingsPathFor("shared", "/project"), join("/project", ".claude/settings.json"));
  });
});

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
// planConfigWrite — pure planning tests [F1]
// ---------------------------------------------------------------------------

describe("planConfigWrite", () => {
  it("fresh file: writes port and codex.models", () => {
    const result = planConfigWrite(null, 4141, ["gpt-5.6-sol", "gpt-5.5"], "/project");
    assert.ok(result.ok);
    assert.equal(result.value.path, join("/project", "subswitch.config.json"));
    const parsed = JSON.parse(result.value.content) as { port: number; codex: { models: string[] } };
    assert.equal(parsed.port, 4141);
    assert.deepEqual(parsed.codex.models, ["gpt-5.6-sol", "gpt-5.5"]);
  });

  it("preserves unknown top-level keys", () => {
    const existing = JSON.stringify({ port: 4141, codex: { models: ["gpt-5.6-sol"] }, logLevel: "debug" });
    const result = planConfigWrite(existing, 9090, ["gpt-5.5"], "/project");
    assert.ok(result.ok);
    const parsed = JSON.parse(result.value.content) as {
      port: number;
      codex: { models: string[] };
      logLevel: string;
    };
    assert.equal(parsed.port, 9090, "port should be updated");
    assert.deepEqual(parsed.codex.models, ["gpt-5.5"], "models should be updated");
    assert.equal(parsed.logLevel, "debug", "unknown top-level key must be preserved");
  });

  it("preserves unknown codex.* keys (deep merge within codex)", () => {
    const existing = JSON.stringify({
      codex: { models: ["gpt-5.6-sol"], userAgent: "custom-ua", baseUrl: "https://example.com" },
    });
    const result = planConfigWrite(existing, 4141, ["gpt-5.5"], "/project");
    assert.ok(result.ok);
    const parsed = JSON.parse(result.value.content) as {
      codex: { models: string[]; userAgent: string; baseUrl: string };
    };
    assert.deepEqual(parsed.codex.models, ["gpt-5.5"], "models should be updated");
    assert.equal(parsed.codex.userAgent, "custom-ua", "codex.userAgent must be preserved");
    assert.equal(parsed.codex.baseUrl, "https://example.com", "codex.baseUrl must be preserved");
  });

  it("returns error on malformed JSON input", () => {
    const result = planConfigWrite("{bad", 4141, ["gpt-5.6-sol"], "/project");
    assert.ok(!result.ok);
    assert.equal(result.error.kind, "malformed_json");
    assert.ok(result.error.message.includes("malformed JSON"));
  });

  it("returns error on non-object JSON input", () => {
    const result = planConfigWrite(JSON.stringify([1, 2, 3]), 4141, ["gpt-5.6-sol"], "/project");
    assert.ok(!result.ok);
    assert.equal(result.error.kind, "malformed_json");
  });

  it("produces valid JSON output", () => {
    const result = planConfigWrite(null, 5555, ["gpt-5.6-luna"], "/project");
    assert.ok(result.ok);
    assert.doesNotThrow(() => JSON.parse(result.value.content));
  });

  it("omits codex.models key when models is undefined", () => {
    const result = planConfigWrite(null, 4141, undefined, "/project");
    assert.ok(result.ok);
    const parsed = JSON.parse(result.value.content) as { port: number; codex?: { models?: unknown } };
    assert.equal(parsed.port, 4141);
    // models key must be absent entirely
    assert.ok(parsed.codex === undefined || !("models" in (parsed.codex as object)), "codex.models must be absent");
  });

  it("removes a stale pre-existing codex.models key when models is undefined", () => {
    const existing = JSON.stringify({ port: 4141, codex: { models: ["gpt-5.6-sol"], userAgent: "ua" } });
    const result = planConfigWrite(existing, 4141, undefined, "/project");
    assert.ok(result.ok);
    const parsed = JSON.parse(result.value.content) as { codex: { userAgent: string; models?: unknown } };
    // models key must be gone
    assert.ok(!("models" in parsed.codex), "stale codex.models must be removed when models is undefined");
    // other codex keys must be preserved
    assert.equal(parsed.codex.userAgent, "ua", "codex.userAgent must be preserved");
  });

  it("preserves other codex.* keys when models is undefined", () => {
    const existing = JSON.stringify({ codex: { models: ["gpt-5.5"], baseUrl: "https://example.com", userAgent: "ua" } });
    const result = planConfigWrite(existing, 4141, undefined, "/project");
    assert.ok(result.ok);
    const parsed = JSON.parse(result.value.content) as { codex: Record<string, unknown> };
    assert.ok(!("models" in parsed.codex), "models must be removed");
    assert.equal(parsed.codex["baseUrl"], "https://example.com", "baseUrl must be preserved");
    assert.equal(parsed.codex["userAgent"], "ua", "userAgent must be preserved");
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
    // No model flags → codexModels is absent (floats with registry default)
    assert.equal(result.value.codexModels, undefined);
  });

  it("parses a valid --port flag", () => {
    const result = resolveOptionsFromFlags({ port: "9090" });
    assert.ok(result.ok);
    assert.equal(result.value.port, 9090);
  });

  it("rejects an invalid port string — unified error message shape", () => {
    const result = resolveOptionsFromFlags({ port: "not-a-number" });
    assert.ok(!result.ok);
    assert.equal(result.error.kind, "invalid_input");
    assert.match(result.error.message, /invalid --port "not-a-number":/);
  });

  it("rejects a port out of range", () => {
    const result = resolveOptionsFromFlags({ port: "99999" });
    assert.ok(!result.ok);
    assert.equal(result.error.kind, "invalid_input");
    assert.match(result.error.message, /invalid --port "99999":/);
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

  it("rejects an invalid settings-target — unified error message shape", () => {
    const result = resolveOptionsFromFlags({ settingsTarget: "global" });
    assert.ok(!result.ok);
    assert.equal(result.error.kind, "invalid_input");
    assert.match(result.error.message, /invalid --settings-target "global":/);
  });

  // Merged-flag matrix [F16/F17/F35]

  it("no model flags → codexModels is undefined (floats with registry default)", () => {
    const result = resolveOptionsFromFlags({});
    assert.ok(result.ok);
    assert.equal(result.value.codexModels, undefined);
  });

  it("--codex-model (repeatable) sets models", () => {
    const result = resolveOptionsFromFlags({ codexModel: ["gpt-5.6-sol", "gpt-5.5"] });
    assert.ok(result.ok);
    assert.deepEqual(result.value.codexModels, ["gpt-5.6-sol", "gpt-5.5"]);
  });

  it("--codex-models CSV string sets models", () => {
    const result = resolveOptionsFromFlags({ codexModels: "gpt-5.6-sol,gpt-5.5" });
    assert.ok(result.ok);
    assert.deepEqual(result.value.codexModels, ["gpt-5.6-sol", "gpt-5.5"]);
  });

  it("--codex-model and --codex-models are merged", () => {
    const result = resolveOptionsFromFlags({ codexModel: ["gpt-5.6-sol"], codexModels: "gpt-5.5" });
    assert.ok(result.ok);
    assert.deepEqual(result.value.codexModels, ["gpt-5.6-sol", "gpt-5.5"]);
  });

  it("merged models are deduplicated, preserving first-occurrence order", () => {
    // README documents the two model flags as "combined and deduplicated".
    const result = resolveOptionsFromFlags({
      codexModel: ["gpt-5.6-sol", "gpt-5.5"],
      codexModels: "gpt-5.5,gpt-5.6-sol,gpt-5.6-luna",
    });
    assert.ok(result.ok);
    assert.deepEqual(result.value.codexModels, ["gpt-5.6-sol", "gpt-5.5", "gpt-5.6-luna"]);
  });

  it("--codex-models \"\" (empty string) → error (model flags given but resolve to empty)", () => {
    const result = resolveOptionsFromFlags({ codexModels: "" });
    assert.ok(!result.ok);
    assert.equal(result.error.kind, "invalid_input");
    // Unified error shape: invalid --flag "value": reason [F14/F15]
    assert.match(result.error.message, /invalid --codex-models "":/);
    assert.ok(result.error.message.includes("at least one model is required"));
  });

  it("--codex-models CSV with whitespace-only entries → error", () => {
    const result = resolveOptionsFromFlags({ codexModels: " , , " });
    assert.ok(!result.ok);
    assert.equal(result.error.kind, "invalid_input");
  });
});

// ---------------------------------------------------------------------------
// collectPreconditionWarnings — pure helper
// ---------------------------------------------------------------------------

describe("collectPreconditionWarnings", () => {
  it("returns empty array when no problems", () => {
    const warnings = collectPreconditionWarnings({}, true, "/home/user/.codex/auth.json");
    assert.deepEqual(warnings, []);
  });

  it("warns when ANTHROPIC_API_KEY is set", () => {
    const warnings = collectPreconditionWarnings({ ANTHROPIC_API_KEY: "sk-xxx" }, true, "/home/user/.codex/auth.json");
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0]?.includes("ANTHROPIC_API_KEY"), "should mention the env var");
  });

  it("does not warn when ANTHROPIC_API_KEY is empty string", () => {
    const warnings = collectPreconditionWarnings({ ANTHROPIC_API_KEY: "" }, true, "/home/user/.codex/auth.json");
    assert.deepEqual(warnings, []);
  });

  it("warns when auth file does not exist", () => {
    const authPath = "/home/user/.codex/auth.json";
    const warnings = collectPreconditionWarnings({}, false, authPath);
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0]?.includes(authPath), "should mention the auth file path");
  });

  it("returns both warnings when both problems present", () => {
    const warnings = collectPreconditionWarnings(
      { ANTHROPIC_API_KEY: "sk-xxx" },
      false,
      "/home/user/.codex/auth.json",
    );
    assert.equal(warnings.length, 2);
  });
});

// ---------------------------------------------------------------------------
// executeInit — integration tests with fake fs deps
// ---------------------------------------------------------------------------

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

  it("writes config BEFORE settings (config-first order) [F6]", async () => {
    const deps = makeFakeDeps();
    const result = await executeInit(
      { port: 4141, codexModels: ["gpt-5.6-sol"], settingsTarget: "local" },
      deps,
      "/project",
    );
    assert.ok(result.ok);
    const configPath = join("/project", "subswitch.config.json");
    const settingsPath = join("/project", ".claude/settings.local.json");
    assert.equal(deps.writeOrder[0], configPath, "config must be written first");
    assert.equal(deps.writeOrder[1], settingsPath, "settings must be written second");
  });

  it("returns [configPath, settingsPath] tuple on success", async () => {
    const deps = makeFakeDeps();
    const result = await executeInit(
      { port: 4141, codexModels: ["gpt-5.6-sol"], settingsTarget: "local" },
      deps,
      "/project",
    );
    assert.ok(result.ok);
    const [configPath, settingsPath] = result.value;
    assert.equal(configPath, join("/project", "subswitch.config.json"));
    assert.equal(settingsPath, join("/project", ".claude/settings.local.json"));
  });

  it("returns error on malformed existing config JSON — no partial write", async () => {
    const configPath = join("/project", "subswitch.config.json");
    const deps = makeFakeDeps({ [configPath]: "{bad json" });
    const result = await executeInit(
      { port: 4141, codexModels: ["gpt-5.6-sol"], settingsTarget: "local" },
      deps,
      "/project",
    );
    assert.ok(!result.ok);
    assert.equal(result.error.kind, "malformed_json");
    assert.equal(Object.keys(deps.written).length, 0);
  });

  it("writes config without codex.models when codexModels is undefined", async () => {
    const deps = makeFakeDeps();
    const result = await executeInit(
      { port: 4141, settingsTarget: "local" }, // no codexModels
      deps,
      "/project",
    );
    assert.ok(result.ok);
    const configPath = join("/project", "subswitch.config.json");
    assert.ok(deps.written[configPath] !== undefined, "subswitch.config.json should be written");
    const config = JSON.parse(deps.written[configPath] as string) as { codex?: { models?: unknown } };
    assert.ok(config.codex === undefined || !("models" in (config.codex as object)), "codex.models must not be present");
  });
});

// ---------------------------------------------------------------------------
// runInitNonInteractive — non-TTY / CI flag path
// ---------------------------------------------------------------------------

describe("runInitNonInteractive", () => {
  it("succeeds with defaults when no flags given", async () => {
    // Populate auth file to suppress the auth warning; pass empty env to suppress
    // the ANTHROPIC_API_KEY warning so errLines stays empty.
    const authFilePath = join(homedir(), ".codex", "auth.json");
    const deps = makeFakeDeps({ [authFilePath]: '{"token":"x"}' });
    const outLines: string[] = [];
    const errLines: string[] = [];
    const exitCode = await runInitNonInteractive(
      {},
      "/project",
      deps,
      (l) => outLines.push(l),
      (l) => errLines.push(l),
      {},  // empty env — no ANTHROPIC_API_KEY
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

  it("non-TTY WITH --yes → writes defaults and exits 0 (the --yes path never hangs)", async () => {
    const deps = makeFakeDeps();
    // resolveInitDispatch returns "non-interactive" when --yes is set — runInitNonInteractive is the sanctioned path
    const decision = resolveInitDispatch(false, false, false, /* yes */ true);
    assert.equal(decision, "non-interactive");
    const exitCode = await runInitNonInteractive({}, "/project", deps, () => undefined, () => undefined);
    assert.equal(exitCode, 0);
    assert.ok(Object.keys(deps.written).length > 0, "files must be written on the --yes path");
  });

  it("--codex-models empty string → error", async () => {
    const deps = makeFakeDeps();
    const errLines: string[] = [];
    const exitCode = await runInitNonInteractive(
      { codexModels: "" },
      "/project",
      deps,
      () => undefined,
      (l) => errLines.push(l),
    );
    assert.equal(exitCode, 1);
    assert.ok(errLines.some((l) => l.includes("codex-models")), "should mention codex-models in error");
  });
});

// ---------------------------------------------------------------------------
// resolveInitDispatch — fail-closed on non-interactive without --yes
// ---------------------------------------------------------------------------

describe("resolveInitDispatch", () => {
  it("non-TTY without --yes → refuse (fail closed)", () => {
    assert.equal(resolveInitDispatch(false, false, false, false), "refuse");
  });

  it("CI env without --yes → refuse", () => {
    assert.equal(resolveInitDispatch(true, true, true, false), "refuse");
  });

  it("--yes flag (no TTY) → non-interactive", () => {
    assert.equal(resolveInitDispatch(false, false, false, true), "non-interactive");
  });

  it("--yes flag (TTY + CI) → non-interactive", () => {
    assert.equal(resolveInitDispatch(true, true, true, true), "non-interactive");
  });

  it("both TTYs, no CI, no --yes → interactive", () => {
    assert.equal(resolveInitDispatch(true, true, false, false), "interactive");
  });
});

// ---------------------------------------------------------------------------
// runInitDryRun — A2.17: plan-only, no writes, always exit 0 on success
// ---------------------------------------------------------------------------

describe("runInitDryRun", () => {
  it("exits 0 and writes NO files to disk", async () => {
    const deps = makeFakeDeps();
    const outLines: string[] = [];
    const exitCode = await runInitDryRun({}, "/project", deps, (l) => outLines.push(l), () => undefined);

    assert.equal(exitCode, 0);
    assert.equal(Object.keys(deps.written).length, 0, "dry-run must not write any files");
  });

  it("includes planned config path in output", async () => {
    const deps = makeFakeDeps();
    const outLines: string[] = [];
    await runInitDryRun({}, "/project", deps, (l) => outLines.push(l), () => undefined);

    const output = outLines.join("\n");
    assert.ok(output.includes("subswitch.config.json"), "output should mention config path");
  });

  it("includes planned settings path in output", async () => {
    const deps = makeFakeDeps();
    const outLines: string[] = [];
    await runInitDryRun({}, "/project", deps, (l) => outLines.push(l), () => undefined);

    const output = outLines.join("\n");
    assert.ok(
      output.includes("settings.local.json") || output.includes("settings.json"),
      "output should mention settings path",
    );
  });

  it("uses custom port from flags in planned output", async () => {
    const deps = makeFakeDeps();
    const outLines: string[] = [];
    await runInitDryRun({ port: "8080" }, "/project", deps, (l) => outLines.push(l), () => undefined);

    const content = outLines.join("\n");
    assert.ok(content.includes("8080"), "dry-run output should reflect the custom port");
  });

  it("exits 1 with error message on invalid port flag", async () => {
    const deps = makeFakeDeps();
    const errLines: string[] = [];
    const exitCode = await runInitDryRun(
      { port: "99999" },
      "/project",
      deps,
      () => undefined,
      (l) => errLines.push(l),
    );

    assert.equal(exitCode, 1);
    assert.ok(errLines.some((l) => l.includes("port")), "should report port error");
  });

  it("labels output as dry-run so operator knows nothing was written", async () => {
    const deps = makeFakeDeps();
    const outLines: string[] = [];
    await runInitDryRun({}, "/project", deps, (l) => outLines.push(l), () => undefined);

    assert.ok(
      outLines.some((l) => l.toLowerCase().includes("dry-run") || l.toLowerCase().includes("no files")),
      "output should label itself as dry-run",
    );
  });

  it("emits unknown-model warning to stderr — parity with non-interactive [self-review P2]", async () => {
    const deps = makeFakeDeps();
    const outLines: string[] = [];
    const errLines: string[] = [];
    const exitCode = await runInitDryRun(
      { codexModel: ["my-custom-model"] },
      "/project",
      deps,
      (l) => outLines.push(l),
      (l) => errLines.push(l),
    );

    assert.equal(exitCode, 0, "exit 0 even with an unknown model name");
    assert.equal(Object.keys(deps.written).length, 0, "dry-run must write no files");
    assert.ok(
      errLines.some((l) => l.includes("warning") && l.includes("my-custom-model")),
      "should emit warning mentioning the unknown model name to stderr",
    );
  });

  it("does not emit a warning for a known alias like 'sol'", async () => {
    const deps = makeFakeDeps();
    const errLines: string[] = [];
    const exitCode = await runInitDryRun(
      { codexModels: "sol" },
      "/project",
      deps,
      () => undefined,
      (l) => errLines.push(l),
    );

    assert.equal(exitCode, 0, "exit 0 for a known alias");
    assert.equal(errLines.length, 0, "no warning for a recognized family alias");
  });
});
