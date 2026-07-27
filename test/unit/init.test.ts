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
  it("fresh file: writes port only", () => {
    const result = planConfigWrite(null, 4141, "/project");
    assert.ok(result.ok);
    assert.equal(result.value.path, join("/project", "subswitch.config.json"));
    const parsed = JSON.parse(result.value.content) as { port: number };
    assert.equal(parsed.port, 4141);
  });

  it("preserves unknown top-level keys", () => {
    const existing = JSON.stringify({ port: 4141, logLevel: "debug" });
    const result = planConfigWrite(existing, 9090, "/project");
    assert.ok(result.ok);
    const parsed = JSON.parse(result.value.content) as { port: number; logLevel: string };
    assert.equal(parsed.port, 9090, "port should be updated");
    assert.equal(parsed.logLevel, "debug", "unknown top-level key must be preserved");
  });

  it("preserves existing providers.codex.* keys (deep merge)", () => {
    const existing = JSON.stringify({
      providers: { codex: { userAgent: "custom-ua", baseUrl: "https://example.com" } },
    });
    const result = planConfigWrite(existing, 4141, "/project");
    assert.ok(result.ok);
    const parsed = JSON.parse(result.value.content) as {
      providers: { codex: { userAgent: string; baseUrl: string } };
    };
    assert.equal(parsed.providers.codex.userAgent, "custom-ua", "providers.codex.userAgent must be preserved");
    assert.equal(parsed.providers.codex.baseUrl, "https://example.com", "providers.codex.baseUrl must be preserved");
  });

  it("returns error on malformed JSON input", () => {
    const result = planConfigWrite("{bad", 4141, "/project");
    assert.ok(!result.ok);
    assert.equal(result.error.kind, "malformed_json");
    assert.ok(result.error.message.includes("malformed JSON"));
  });

  it("returns error on non-object JSON input", () => {
    const result = planConfigWrite(JSON.stringify([1, 2, 3]), 4141, "/project");
    assert.ok(!result.ok);
    assert.equal(result.error.kind, "malformed_json");
  });

  it("produces valid JSON output", () => {
    const result = planConfigWrite(null, 5555, "/project");
    assert.ok(result.ok);
    assert.doesNotThrow(() => JSON.parse(result.value.content));
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
      { port: 4141, settingsTarget: "local" },
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
    const config = JSON.parse(deps.written[configPath] as string) as { port: number };
    assert.equal(config.port, 4141);
  });

  it("writes settings.json for target=shared", async () => {
    const deps = makeFakeDeps();
    const result = await executeInit(
      { port: 4141, settingsTarget: "shared" },
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
      { port: 4141, settingsTarget: "local" },
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
      { port: 4141, settingsTarget: "local" },
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
      { port: 4141, settingsTarget: "local" },
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
      { port: 4141, settingsTarget: "local" },
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
      { port: 4141, settingsTarget: "local" },
      deps,
      "/project",
    );
    assert.ok(!result.ok);
    assert.equal(result.error.kind, "malformed_json");
    assert.equal(Object.keys(deps.written).length, 0);
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
});
