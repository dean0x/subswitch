/**
 * Unit tests for runInitInteractive — scripted fake InitPrompts. [F25]
 *
 * We never import or call makeClackPrompts here, keeping @clack/prompts unloaded.
 * All tests verify BEHAVIOUR: what exit code is returned, what files are written,
 * what initialValues seeds were passed to each prompt.
 *
 * Wizard flow (Phase 6f): port (text) → settings target (select). Two prompts only.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  runInitInteractive,
  type InitPrompts,
  type InitFlags,
} from "../../src/init.js";
import { DEFAULT_PORT } from "../../src/config.js";
import { makeFakeDeps } from "./init-test-helpers.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

// Cancel sentinel — any symbol satisfies isCancel since our fake just checks typeof
const CANCEL = Symbol("cancel");

/** Recorded call shapes (with optional fields intentionally not set when absent). */
interface TextCall {
  message: string;
  initialValue?: string;
}
interface SelectCall {
  message: string;
  initialValue?: string;
}

interface ScriptedPromptsConfig {
  textResponse: string | symbol;
  selectResponse: string | symbol;
}

/** Build a scripted InitPrompts that records what was passed and returns preset responses. */
const makeScriptedPrompts = (
  config: ScriptedPromptsConfig,
): InitPrompts & {
  introArgs: string[];
  warnArgs: string[];
  cancelArgs: string[];
  outroArgs: string[];
  noteArgs: Array<{ message: string; title?: string }>;
  textCalls: TextCall[];
  selectCalls: SelectCall[];
  spinnerStarts: string[];
  spinnerStops: string[];
} => {
  const introArgs: string[] = [];
  const warnArgs: string[] = [];
  const cancelArgs: string[] = [];
  const outroArgs: string[] = [];
  const noteArgs: Array<{ message: string; title?: string }> = [];
  const textCalls: TextCall[] = [];
  const selectCalls: SelectCall[] = [];
  const spinnerStarts: string[] = [];
  const spinnerStops: string[] = [];

  return {
    intro: (t) => { introArgs.push(t); },
    warn: (m) => { warnArgs.push(m); },
    cancel: (m) => { cancelArgs.push(m); },
    outro: (m) => { outroArgs.push(m); },
    note: (message, title) => {
      noteArgs.push({ message, ...(title !== undefined ? { title } : {}) });
    },
    isCancel: (v) => typeof v === "symbol",
    text: (opts) => {
      textCalls.push({
        message: opts.message,
        ...(opts.initialValue !== undefined ? { initialValue: opts.initialValue } : {}),
      });
      return Promise.resolve(config.textResponse);
    },
    select: (opts) => {
      selectCalls.push({
        message: opts.message,
        ...(opts.initialValue !== undefined ? { initialValue: opts.initialValue } : {}),
      });
      return Promise.resolve(config.selectResponse);
    },
    spinner: () => ({
      start: (m) => { spinnerStarts.push(m); },
      stop: (m) => { spinnerStops.push(m); },
    }),
    introArgs,
    warnArgs,
    cancelArgs,
    outroArgs,
    noteArgs,
    textCalls,
    selectCalls,
    spinnerStarts,
    spinnerStops,
  };
};

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("runInitInteractive — happy path", () => {
  it("returns exit code 0 and writes both files", async () => {
    const deps = makeFakeDeps();
    const prompts = makeScriptedPrompts({
      textResponse: "4141",
      selectResponse: "local",
    });

    const exitCode = await runInitInteractive("/project", deps, {}, prompts);

    assert.equal(exitCode, 0, "should return exit code 0 on success");
    const writtenPaths = Object.keys(deps.written);
    assert.equal(writtenPaths.length, 2, "should write exactly two files");
  });

  it("writes config BEFORE settings (config-first order)", async () => {
    const deps = makeFakeDeps();
    const prompts = makeScriptedPrompts({
      textResponse: "4141",
      selectResponse: "local",
    });

    const exitCode = await runInitInteractive("/project", deps, {}, prompts);

    assert.equal(exitCode, 0);
    const configPath = join("/project", "subswitch.config.json");
    const settingsPath = join("/project", ".claude/settings.local.json");
    assert.equal(deps.writeOrder[0], configPath, "config must be written first");
    assert.equal(deps.writeOrder[1], settingsPath, "settings must be written second");
  });

  it("emits intro at the start", async () => {
    const deps = makeFakeDeps();
    const prompts = makeScriptedPrompts({
      textResponse: "4141",
      selectResponse: "local",
    });

    await runInitInteractive("/project", deps, {}, prompts);

    assert.equal(prompts.introArgs.length, 1, "intro should be called once");
    assert.ok(prompts.introArgs[0]?.includes("subswitch init"), "intro should mention subswitch init");
  });

  it("emits outro on success", async () => {
    const deps = makeFakeDeps();
    const prompts = makeScriptedPrompts({
      textResponse: "4141",
      selectResponse: "local",
    });

    await runInitInteractive("/project", deps, {}, prompts);

    assert.equal(prompts.outroArgs.length, 1, "outro should be called once on success");
  });

  it("outro mentions restart Claude Code session (ANTHROPIC_BASE_URL)", async () => {
    const deps = makeFakeDeps();
    const prompts = makeScriptedPrompts({
      textResponse: "4141",
      selectResponse: "local",
    });

    await runInitInteractive("/project", deps, {}, prompts);

    const noteTexts = prompts.noteArgs.map((n) => n.message).join("\n");
    assert.ok(
      noteTexts.includes("ANTHROPIC_BASE_URL") || noteTexts.includes("restart"),
      "note should mention restarting Claude Code or ANTHROPIC_BASE_URL",
    );
  });

  it("writes correct ANTHROPIC_BASE_URL derived from chosen port", async () => {
    const deps = makeFakeDeps();
    const prompts = makeScriptedPrompts({
      textResponse: "7777",
      selectResponse: "local",
    });

    await runInitInteractive("/project", deps, {}, prompts);

    const settingsPath = join("/project", ".claude/settings.local.json");
    const settings = JSON.parse(deps.written[settingsPath] as string) as {
      env: { ANTHROPIC_BASE_URL: string };
    };
    assert.equal(settings.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:7777");
  });

  it("uses shared settings file when select returns 'shared'", async () => {
    const deps = makeFakeDeps();
    const prompts = makeScriptedPrompts({
      textResponse: "4141",
      selectResponse: "shared",
    });

    await runInitInteractive("/project", deps, {}, prompts);

    assert.ok(
      Object.keys(deps.written).some((p) => p.endsWith("settings.json") && !p.endsWith("settings.local.json")),
      "should write .claude/settings.json for target=shared",
    );
  });

  it("wizard calls exactly one text prompt and one select prompt", async () => {
    const deps = makeFakeDeps();
    const prompts = makeScriptedPrompts({
      textResponse: "4141",
      selectResponse: "local",
    });

    await runInitInteractive("/project", deps, {}, prompts);

    assert.equal(prompts.textCalls.length, 1, "exactly one text prompt (port)");
    assert.equal(prompts.selectCalls.length, 1, "exactly one select prompt (settings target)");
  });
});

// ---------------------------------------------------------------------------
// Cancel at each prompt — exit 1 + zero writes [F18]
// ---------------------------------------------------------------------------

describe("runInitInteractive — cancel at port prompt", () => {
  it("returns exit code 1 when cancel at port (text) prompt", async () => {
    const deps = makeFakeDeps();
    const prompts = makeScriptedPrompts({
      textResponse: CANCEL,
      selectResponse: "local",
    });

    const exitCode = await runInitInteractive("/project", deps, {}, prompts);

    assert.equal(exitCode, 1);
    assert.equal(Object.keys(deps.written).length, 0, "zero files written on cancel");
    assert.equal(prompts.cancelArgs.length, 1, "cancel message should be emitted");
  });

  it("does not call select after port cancel", async () => {
    const deps = makeFakeDeps();
    const prompts = makeScriptedPrompts({
      textResponse: CANCEL,
      selectResponse: "local",
    });

    await runInitInteractive("/project", deps, {}, prompts);

    assert.equal(prompts.selectCalls.length, 0, "select should not be called");
  });
});

describe("runInitInteractive — cancel at settings target (select) prompt", () => {
  it("returns exit code 1 when cancel at select prompt", async () => {
    const deps = makeFakeDeps();
    const prompts = makeScriptedPrompts({
      textResponse: "4141",
      selectResponse: CANCEL,
    });

    const exitCode = await runInitInteractive("/project", deps, {}, prompts);

    assert.equal(exitCode, 1);
    assert.equal(Object.keys(deps.written).length, 0, "zero files written on cancel");
    assert.equal(prompts.cancelArgs.length, 1, "cancel message should be emitted");
  });
});

// ---------------------------------------------------------------------------
// Write failure → exit 1
// ---------------------------------------------------------------------------

describe("runInitInteractive — write failure", () => {
  it("returns exit code 1 when executeInit fails", async () => {
    const deps = makeFakeDeps({}, /* failOnWrite */ true);
    const prompts = makeScriptedPrompts({
      textResponse: "4141",
      selectResponse: "local",
    });

    const exitCode = await runInitInteractive("/project", deps, {}, prompts);

    assert.equal(exitCode, 1);
  });

  it("calls outro with incomplete message on write failure", async () => {
    const deps = makeFakeDeps({}, /* failOnWrite */ true);
    const prompts = makeScriptedPrompts({
      textResponse: "4141",
      selectResponse: "local",
    });

    await runInitInteractive("/project", deps, {}, prompts);

    assert.ok(
      prompts.outroArgs.some((a) => a.toLowerCase().includes("incomplete")),
      "outro should mention incomplete setup",
    );
  });
});

// ---------------------------------------------------------------------------
// Seeding: flags beat existing config beat defaults [F1]
// ---------------------------------------------------------------------------

describe("runInitInteractive — seeding", () => {
  it("seeds port initialValue from DEFAULT_PORT when no flags and no existing config", async () => {
    const deps = makeFakeDeps();
    const prompts = makeScriptedPrompts({
      textResponse: String(DEFAULT_PORT),
      selectResponse: "local",
    });

    await runInitInteractive("/project", deps, {}, prompts);

    assert.equal(
      prompts.textCalls[0]?.initialValue,
      String(DEFAULT_PORT),
      "port prompt should be seeded with DEFAULT_PORT",
    );
  });

  it("seeds port initialValue from existing config when no port flag", async () => {
    const configPath = join("/project", "subswitch.config.json");
    const existingConfig = JSON.stringify({ port: 9090 });
    const deps = makeFakeDeps({ [configPath]: existingConfig });
    const prompts = makeScriptedPrompts({
      textResponse: "9090",
      selectResponse: "local",
    });

    await runInitInteractive("/project", deps, {}, prompts);

    assert.equal(
      prompts.textCalls[0]?.initialValue,
      "9090",
      "port prompt should be seeded from existing config",
    );
  });

  it("seeds port initialValue from --port flag (flag beats existing config)", async () => {
    const configPath = join("/project", "subswitch.config.json");
    const existingConfig = JSON.stringify({ port: 9090 });
    const deps = makeFakeDeps({ [configPath]: existingConfig });
    const flags: InitFlags = { port: "8080" };
    const prompts = makeScriptedPrompts({
      textResponse: "8080",
      selectResponse: "local",
    });

    await runInitInteractive("/project", deps, {}, prompts, flags);

    assert.equal(
      prompts.textCalls[0]?.initialValue,
      "8080",
      "flag port (8080) must beat existing config port (9090)",
    );
  });

  it("seeds settingsTarget initialValue from flags", async () => {
    const deps = makeFakeDeps();
    const flags: InitFlags = { settingsTarget: "shared" };
    const prompts = makeScriptedPrompts({
      textResponse: "4141",
      selectResponse: "shared",
    });

    await runInitInteractive("/project", deps, {}, prompts, flags);

    assert.equal(
      prompts.selectCalls[0]?.initialValue,
      "shared",
      "settingsTarget select should be seeded from flag",
    );
  });

  it("seeds settingsTarget initialValue to 'local' by default", async () => {
    const deps = makeFakeDeps();
    const prompts = makeScriptedPrompts({
      textResponse: "4141",
      selectResponse: "local",
    });

    await runInitInteractive("/project", deps, {}, prompts);

    assert.equal(
      prompts.selectCalls[0]?.initialValue,
      "local",
      "settingsTarget select should default to 'local'",
    );
  });
});

// ---------------------------------------------------------------------------
// Precondition warnings [F13]
// ---------------------------------------------------------------------------

describe("runInitInteractive — precondition warnings", () => {
  it("warns when ANTHROPIC_API_KEY is set", async () => {
    const authPath = join(homedir(), ".codex", "auth.json");
    const deps = makeFakeDeps({ [authPath]: '{"token":"x"}' });
    const prompts = makeScriptedPrompts({
      textResponse: "4141",
      selectResponse: "local",
    });

    await runInitInteractive("/project", deps, { ANTHROPIC_API_KEY: "sk-xxx" }, prompts);

    assert.ok(
      prompts.warnArgs.some((w) => w.includes("ANTHROPIC_API_KEY")),
      "should warn about ANTHROPIC_API_KEY",
    );
  });

  it("warns when auth file does not exist", async () => {
    const deps = makeFakeDeps(); // auth file not in existingFiles
    const prompts = makeScriptedPrompts({
      textResponse: "4141",
      selectResponse: "local",
    });

    await runInitInteractive("/project", deps, {}, prompts);

    assert.ok(
      prompts.warnArgs.some((w) => w.includes(".codex") || w.includes("codex login")),
      "should warn about missing auth file",
    );
  });

  it("emits no warnings when env is clean and auth file exists", async () => {
    const authPath = join(homedir(), ".codex", "auth.json");
    const deps = makeFakeDeps({ [authPath]: '{"token":"x"}' });
    const prompts = makeScriptedPrompts({
      textResponse: "4141",
      selectResponse: "local",
    });

    await runInitInteractive("/project", deps, {}, prompts);

    assert.equal(prompts.warnArgs.length, 0, "should emit no warnings when conditions are met");
  });
});
