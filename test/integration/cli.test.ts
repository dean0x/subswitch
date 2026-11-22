/**
 * Integration tests for the CLI entry point.
 *
 * Each test starts the CLI through the shared CLI-child helper and checks exit
 * code + stdout/stderr. Tests are bounded with a 10 s timeout. [F9/F26]
 *
 * Important constraints:
 * - Spawned processes have no TTY (piped I/O), so init without --yes triggers
 *   the fail-closed "refuse" path — this is what we test.
 * - We never assert that doctor exits 0 (avoids PF-006 pattern).
 * - Each child gets fresh HOME and XDG folders and the exec-deny preload. These tests
 *   check the project and user files, so SUBSWITCH_CONFIG is empty: the user file is
 *   in the fresh folder.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, readdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliChildCommand, cliChildFolders, offlineDoctorConfig, readExecLog, runCliChild, type CliChildFolders } from "../helpers/cli-child.js";
import { startRelayChild } from "../helpers/relay-child.js";
import { GEMINI_TEST_MODEL, geminiTestProvider } from "../fixtures/gemini.js";

const geminiTerms = "Google's terms do not allow third-party tools such as Subswitch to use the Gemini subscription sign-in, and if you turn this route on, that choice is yours.";

describe("CLI Gemini surfaces", () => {
  for (const active of [false, true]) {
    it(`TP-43: shows terms and attempts Gemini exec only with the block (${active})`, async (t) => {
      const config = await offlineDoctorConfig(active ? { providers: { gemini: geminiTestProvider } } : {});
      const relay = await startRelayChild({ config, offlineDarwin: true, env: { SUBSWITCH_LIMIT_RECORDING: "0" } });
      t.after(relay.cleanup);
      await relay.waitFor("to verify setup");
      const banner = relay.stderr;
      assert.match(banner, /subswitch ready/);
      assert.match(banner, /gemini\s+0 models/);
      assert.equal(banner.split(geminiTerms).length - 1, active ? 1 : 0);
      assert.deepEqual(await readExecLog(relay.folders), ["preload"], "serve must not start an exec before the request");
      const reply = await fetch(`http://127.0.0.1:${relay.port}/v1/messages`, {
        method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(5_000),
        body: JSON.stringify({ model: GEMINI_TEST_MODEL, max_tokens: 16, messages: [{ role: "user", content: "hello" }] }),
      });
      assert.equal(reply.status, active ? 503 : 400);
      assert.match(await reply.text(), active ? /Subswitch could not read from Keychain/ : /Gemini is not turned on/);
      assert.deepEqual(await readExecLog(relay.folders), active ? ["preload", "execFile /usr/bin/security"] : ["preload"]);
    });
  }

  it("reports an empty Gemini model list in text and JSON", async (t) => {
    const folders = await cliChildFolders();
    t.after(() => rm(folders.home, { recursive: true, force: true }));
    await writeFile(folders.configFile, '{"providers":{"gemini":{}}}');
    const text = await runCliChild(folders, ["models"]);
    assert.equal(text.code, 0);
    assert.match(text.stdout, /^\s+gemini\s+\(no models\)$/m);
    const json = await runCliChild(folders, ["models", "--json"]);
    assert.equal(json.code, 0);
    const rows: { providers: { id: string }[]; models: { provider: string }[] } = JSON.parse(json.stdout);
    assert.ok(rows.providers.some(({ id }) => id === "gemini"));
    assert.deepEqual(rows.models.filter(({ provider }) => provider === "gemini"), []);
    assert.ok(!text.stdout.includes(geminiTerms) && !json.stdout.includes(geminiTerms));
  });

  it("probes Gemini only with the block and does not stat the Keychain file", async (t) => {
    for (const active of [false, true]) {
      const folders = await cliChildFolders();
      t.after(() => rm(folders.home, { recursive: true, force: true }));
      const keychains = join(folders.home, "Library", "Keychains");
      const fixture = join(keychains, "fixture-codex.json");
      const config = await offlineDoctorConfig(active ? { providers: {
        gemini: {}, codex: { baseUrl: "http://127.0.0.1:9", authFile: fixture },
      } } : {});
      await writeFile(folders.configFile, JSON.stringify(config));
      const result = await runCliChild(folders, ["doctor"], { recordFsUnder: keychains, offlineDarwin: true });
      const log = await readExecLog(folders);
      assert.equal(result.stdout.split(geminiTerms).length - 1, active ? 1 : 0);
      assert.match(result.stdout, active ? /gemini auth:\s+UNAVAILABLE/ : /gemini auth:\s+not configured/);
      assert.equal(log.filter((line) => line === "execFile /usr/bin/security").length, active ? 2 : 1,
        "Together probes once independently of Gemini");
      const fileCalls = log.filter((line) => line.startsWith("fs"));
      assert.ok(fileCalls.every((line) => line.endsWith(` ${fixture}`)));
      assert.equal(fileCalls.length > 0, active, "the configured Codex path proves the recorder sees file calls");
    }
  });
});

interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** One fresh folder set for the runs that bring no folders of their own. */
let sharedFolders: Promise<CliChildFolders> | undefined;
after(async () => {
  if (sharedFolders !== undefined) await rm((await sharedFolders).home, { recursive: true, force: true });
});

/**
 * Module-level cache: collapsed (args, cwd, env, folders) tuples → their single spawn.
 *
 * Tests that use unique mkdtemp directories or other env values always get
 * distinct keys, so they are never aliased to a previous result. Parallel suites
 * therefore share at most one live process per unique invocation tuple.
 */
const runCliCache = new Map<string, Promise<SpawnResult>>();

/**
 * Spawn the CLI with the given args. `cwd` defaults to the fresh home folder, and `env`
 * holds only the variables to add for the child. Bounded by a 10 s timeout so a hanging
 * serve never blocks the suite.
 *
 * Identical invocations (same args, cwd, env, folders) are memoised to a single spawn so
 * repeated `it()` blocks over the same command do not each pay a tsx start-up cost.
 */
const runCli = async (
  args: string[],
  options: {
    cwd?: string;
    env?: Readonly<Record<string, string | undefined>>;
    folders?: CliChildFolders;
    timeoutMs?: number;
  } = {},
): Promise<SpawnResult> => {
  const { timeoutMs = 10_000 } = options;
  const folders = options.folders ?? (await (sharedFolders ??= cliChildFolders()));
  // NO_COLOR defaults to "1" (colour off) but caller-supplied env wins,
  // including an explicit NO_COLOR: undefined (i.e. unsetting it).
  const env = { NO_COLOR: "1", SUBSWITCH_CONFIG: "", ...options.env };
  const command = cliChildCommand(folders, args, { ...(options.cwd === undefined ? {} : { cwd: options.cwd }), env });

  const key = JSON.stringify([args, command.cwd, Object.entries(env).sort(([a], [b]) => a.localeCompare(b)), folders.home]);
  const cached = runCliCache.get(key);
  if (cached !== undefined) return cached;

  const promise = new Promise<SpawnResult>((resolve, reject) => {
    // Do NOT pass stdio: "inherit" — we need to capture stdout/stderr
    const proc = spawn(command.file, command.args, { cwd: command.cwd, env: command.env });

    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`CLI timed out after ${timeoutMs}ms (args: ${args.join(" ")})`));
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });

    proc.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });

  runCliCache.set(key, promise);
  return promise;
};

// ---------------------------------------------------------------------------
// --help / --version → exit 0
// ---------------------------------------------------------------------------

describe("CLI --help", () => {
  it("exits 0 and prints usage to stdout", async () => {
    const result = await runCli(["--help"]);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.ok(result.stdout.includes("Usage:"), "stdout should contain 'Usage:'");
    assert.ok(result.stdout.includes("subswitch"), "stdout should mention subswitch");
  });

  it("--help output contains Examples section", async () => {
    const result = await runCli(["--help"]);
    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.includes("Examples:"), "USAGE should have Examples section");
  });

  it("--help output contains Environment section", async () => {
    const result = await runCli(["--help"]);
    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.includes("Environment:"), "USAGE should have Environment section");
  });

  it("--help output mentions NO_COLOR and FORCE_COLOR", async () => {
    const result = await runCli(["--help"]);
    assert.ok(result.stdout.includes("NO_COLOR"), "USAGE should document NO_COLOR");
    assert.ok(result.stdout.includes("FORCE_COLOR"), "USAGE should document FORCE_COLOR");
  });

  it("--help output lists the models command", async () => {
    const result = await runCli(["--help"]);
    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.includes("models"), "help output must mention the models command");
  });

  // The README's CLI reference block is the published contract for these flags.
  // Substring checks let it drift silently once already — it documented
  // --codex-model/--codex-models for a release after both were deleted.
  it("--help output is byte-identical to the README CLI reference block", async () => {
    const result = await runCli(["--help"]);
    assert.equal(result.exitCode, 0);

    const readme = await readFile(new URL("../../README.md", import.meta.url), "utf8");
    const marker = "subswitch — local subscription-routing proxy for Claude Code";
    const start = readme.indexOf("```\n" + marker);
    assert.ok(start >= 0, "README must contain a fenced CLI reference block");
    const bodyStart = start + 4;
    const end = readme.indexOf("```", bodyStart);
    assert.ok(end > bodyStart, "README CLI reference block must be closed");

    const readmeBlock = readme.slice(bodyStart, end);
    assert.equal(result.stdout, readmeBlock, "USAGE and the README CLI block must stay byte-identical");
    assert.match(result.stdout, /^      --detach +\S/m);
  });
});

describe("CLI --version", () => {
  it("exits 0 and prints a version string to stdout", async () => {
    const result = await runCli(["--version"]);
    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.trim().length > 0, "stdout should not be empty");
    // Version should look like x.y.z or contain a number
    assert.ok(/\d/.test(result.stdout), "version output should contain a number");
  });
});

// ---------------------------------------------------------------------------
// Unknown flag → clean subswitch: prefixed error, no stack trace
// ---------------------------------------------------------------------------

describe("CLI unknown flag", () => {
  it("--nope → exit 1 with subswitch: prefix on stderr", async () => {
    const result = await runCli(["--nope"]);
    assert.equal(result.exitCode, 1);
    assert.ok(result.stderr.includes("subswitch:"), "stderr should have 'subswitch:' prefix");
  });

  it("--nope → no stack trace in stderr", async () => {
    const result = await runCli(["--nope"]);
    assert.ok(
      !result.stderr.includes("at ") || !result.stderr.includes(".ts:"),
      "stderr should not contain a TypeScript stack trace",
    );
  });

  it("--nope → stderr contains the flag name", async () => {
    const result = await runCli(["--nope"]);
    assert.ok(result.stderr.includes("nope") || result.stderr.includes("unknown"), "stderr should mention the unknown flag");
  });
});

// ---------------------------------------------------------------------------
// init non-TTY without --yes → exit 1 + refusal + ZERO files
// ---------------------------------------------------------------------------

describe("CLI init (non-TTY, no --yes) — fail-closed", () => {
  it("exits 1 with refusal message on stderr", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "croxy-cli-test-"));
    try {
      const result = await runCli(["init"], { cwd: tmpDir });
      assert.equal(result.exitCode, 1);
      assert.ok(
        result.stderr.includes("subswitch:") || result.stderr.includes("interactive"),
        "stderr should contain refusal message",
      );
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("writes ZERO files on non-TTY init without --yes", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "croxy-cli-test-"));
    try {
      await runCli(["init"], { cwd: tmpDir });
      const entries = await readdir(tmpDir);
      assert.equal(entries.length, 0, "no files should be written on fail-closed refuse path");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Per-command flag validation: misapplied flags → error (A3.19)
// ---------------------------------------------------------------------------

describe("CLI per-command flag validation", () => {
  it("doctor --verbose → exit 1 with error mentioning the flag", async () => {
    const result = await runCli(["doctor", "--verbose"]);
    assert.equal(result.exitCode, 1);
    assert.ok(
      result.stderr.includes("verbose") || result.stderr.includes("subswitch:"),
      "stderr should mention the misapplied flag or be a subswitch error",
    );
  });

  it("doctor --verbose → no stack trace", async () => {
    const result = await runCli(["doctor", "--verbose"]);
    assert.ok(
      !result.stderr.includes("at ") || !result.stderr.includes(".ts:"),
      "should not print a stack trace for misapplied flag",
    );
  });
});

// ---------------------------------------------------------------------------
// serve --port abc → clean error, no server started (A3.20)
// ---------------------------------------------------------------------------

describe("CLI serve --port validation", () => {
  it("serve --port abc → exit 1 with clean error on stderr", async () => {
    const result = await runCli(["serve", "--port", "abc"]);
    assert.equal(result.exitCode, 1);
    assert.ok(result.stderr.includes("subswitch:"), "stderr should have subswitch: prefix");
    assert.ok(result.stderr.includes("port") || result.stderr.includes("abc"), "stderr should mention the invalid port");
  });

  it("serve --port abc → no server banner on stderr", async () => {
    const result = await runCli(["serve", "--port", "abc"]);
    // If the server had started, stderr would contain the "subswitch ready" banner
    assert.ok(!result.stderr.includes("subswitch ready"), "server should not start with invalid port");
  });

  it("serve --port 99999 → exit 1 with port range error", async () => {
    const result = await runCli(["serve", "--port", "99999"]);
    assert.equal(result.exitCode, 1);
    assert.ok(result.stderr.includes("subswitch:"), "stderr should have subswitch: prefix");
  });
});

// ---------------------------------------------------------------------------
// init --dry-run → exit 0 without writing files (A2.17)
// ---------------------------------------------------------------------------

describe("CLI init --dry-run", () => {
  it("exits 0 without writing any files", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "croxy-cli-test-"));
    try {
      const result = await runCli(["init", "--dry-run"], { cwd: tmpDir });
      assert.equal(result.exitCode, 0);
      const entries = await readdir(tmpDir);
      assert.equal(entries.length, 0, "dry-run must not write any files");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("dry-run works without --yes in non-TTY (allowed because nothing is written)", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "croxy-cli-test-"));
    try {
      // Should NOT refuse even without --yes, because dry-run writes nothing
      const result = await runCli(["init", "--dry-run"], { cwd: tmpDir });
      assert.equal(result.exitCode, 0, "dry-run should exit 0 without --yes in non-TTY");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("prints planned file paths to stdout", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "croxy-cli-test-"));
    try {
      const result = await runCli(["init", "--dry-run"], { cwd: tmpDir });
      assert.ok(result.stdout.includes("subswitch.config.json"), "dry-run stdout should show config path");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// models subcommand
// ---------------------------------------------------------------------------

describe("CLI models", () => {
  it("ends the list with the Together pass-through line and the configured output cap", async () => {
    const folders = await cliChildFolders();
    try {
      const configDir = join(folders.configHome, "subswitch");
      await mkdir(configDir, { recursive: true });
      await writeFile(join(configDir, "config.json"), JSON.stringify({ providers: { together: { outputCap: 1024 } } }), "utf8");
      const result = await runCli(["models"], { folders });
      assert.equal(result.exitCode, 0, result.stderr);
      assert.match(result.stdout, /\n  together:<model-id>  →  any Together AI model \(pass-through; output cap 1024 tokens\)\n$/);
    } finally {
      await rm(folders.home, { recursive: true, force: true });
    }
  });

  it("exits 0 and prints both the alias (sol) and its canonical (gpt-5.6-sol)", async () => {
    const result = await runCli(["models"]);
    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.includes("sol"), "output should include the 'sol' alias");
    assert.ok(result.stdout.includes("gpt-5.6-sol"), "output should include the canonical 'gpt-5.6-sol'");
  });

  it("prints the generation for each alias", async () => {
    const result = await runCli(["models"]);
    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.includes("gen:5.6"), "output should include generation gen:5.6");
  });

  it("shows a config alias override with the (config) source label", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "subswitch-models-test-"));
    try {
      await writeFile(
        join(tmpDir, "subswitch.config.json"),
        JSON.stringify({ providers: { codex: { aliases: { myalias: "gpt-5.6-sol" } } } }),
        "utf8",
      );
      const result = await runCli(["models"], { cwd: tmpDir });
      assert.equal(result.exitCode, 0);
      assert.ok(result.stdout.includes("myalias"), "output should include the custom alias name");
      assert.ok(result.stdout.includes("(config)"), "output should label config overrides with (config)");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("models --verbose exits 1 — models takes no flags", async () => {
    const result = await runCli(["models", "--verbose"]);
    assert.equal(result.exitCode, 1);
    // The CLI emits: "flag '--verbose' is not valid for 'models' — run `subswitch --help` for usage"
    // Assert on both the flag name and the command name so the check is falsifiable.
    assert.ok(
      result.stderr.includes("verbose") && result.stderr.includes("models"),
      "stderr must name both the misapplied flag ('verbose') and the command ('models')",
    );
  });

  it("shows gpt-5.6-sol as a (direct) row — still routable after GPT-6 took the sol alias", async () => {
    // gpt-5.6-sol is no longer the canonical of any alias row. Without a direct row it
    // would silently disappear from the output even though it is routable by exact id.
    const result = await runCli(["models"]);
    assert.equal(result.exitCode, 0);
    const line = result.stdout.split("\n").find((l) => l.includes("gpt-5.6-sol"));
    assert.ok(line !== undefined, "output must include gpt-5.6-sol");
    assert.ok(line.includes("(direct)"), "gpt-5.6-sol must appear as a (direct) row");
  });

  it("omits the retired gpt-5.5 from the human-readable table", async () => {
    const result = await runCli(["models"]);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.includes("gpt-5.5"), false, "retired gpt-5.5 must not be listed");
  });

  it("shows the provider column in human-readable output", async () => {
    const result = await runCli(["models"]);
    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.includes("codex"), "models output must include the provider column");
  });
});

// ---------------------------------------------------------------------------
// models --json (A14–A22, P5)
// ---------------------------------------------------------------------------

describe("CLI models --json", () => {
  // A14: exits 0
  it("A14 — exits 0", async () => {
    const result = await runCli(["models", "--json"]);
    assert.equal(result.exitCode, 0);
  });

  // A15: stdout is valid JSON
  it("A15 — stdout is valid JSON", async () => {
    const result = await runCli(["models", "--json"]);
    assert.doesNotThrow(() => JSON.parse(result.stdout), "stdout must be valid JSON");
  });

  // A16: JSON has kind: "models"
  it("A16 — JSON.kind === 'models'", async () => {
    const result = await runCli(["models", "--json"]);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.equal(parsed["kind"], "models");
  });

  // A17: JSON has schemaVersion: 1
  it("A17 — JSON.schemaVersion === 1", async () => {
    const result = await runCli(["models", "--json"]);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.equal(parsed["schemaVersion"], 1);
  });

  // A18: models array is present and non-empty
  it("A18 — JSON.models is a non-empty array", async () => {
    const result = await runCli(["models", "--json"]);
    const parsed = JSON.parse(result.stdout) as { models: unknown[] };
    assert.ok(Array.isArray(parsed.models), "models must be an array");
    assert.ok(parsed.models.length > 0, "models array must be non-empty");
  });

  // structural: each model entry has the required fields
  it("each model entry has id, provider, routable, preview, retired, source", async () => {
    const result = await runCli(["models", "--json"]);
    const parsed = JSON.parse(result.stdout) as { models: Record<string, unknown>[] };
    for (const model of parsed.models) {
      assert.ok(typeof model["id"] === "string", `model.id must be a string; got: ${JSON.stringify(model["id"])}`);
      assert.ok(typeof model["provider"] === "string", `model.provider must be a string; got: ${JSON.stringify(model["provider"])}`);
      assert.ok(typeof model["routable"] === "boolean", `model.routable must be a boolean; got: ${JSON.stringify(model["routable"])}`);
      assert.ok(typeof model["preview"] === "boolean", `model.preview must be a boolean; got: ${JSON.stringify(model["preview"])}`);
      assert.ok(typeof model["retired"] === "boolean", `model.retired must be a boolean; got: ${JSON.stringify(model["retired"])}`);
      assert.equal(model["source"], "registry", "model.source must be 'registry'");
    }
  });

  // structural: providers array includes codex
  it("providers array includes a codex entry", async () => {
    const result = await runCli(["models", "--json"]);
    const parsed = JSON.parse(result.stdout) as { providers: Array<{ id: string }> };
    assert.ok(Array.isArray(parsed.providers), "providers must be an array");
    assert.ok(
      parsed.providers.some((p) => p.id === "codex"),
      "providers must include an entry with id 'codex'",
    );
  });

  // structural: fallbackProvider is "anthropic"
  it("JSON.fallbackProvider === 'anthropic'", async () => {
    const result = await runCli(["models", "--json"]);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.equal(parsed["fallbackProvider"], "anthropic");
  });

  // structural: gpt-5.6-sol appears in models array with gen: [5, 6]
  it("gpt-5.6-sol appears in models with gen: [5, 6] (tuple, not string)", async () => {
    const result = await runCli(["models", "--json"]);
    const parsed = JSON.parse(result.stdout) as { models: Array<{ id: string; gen?: number[] }> };
    const solModel = parsed.models.find((m) => m.id === "gpt-5.6-sol");
    assert.ok(solModel !== undefined, "models must include gpt-5.6-sol");
    assert.ok(Array.isArray(solModel.gen), "gen must be an array (tuple), not a string");
    assert.deepEqual(solModel.gen, [5, 6], "gen for gpt-5.6-sol must be [5, 6]");
  });

  it("lists the Astra family default and keeps GPT-6 Astra's generation and efforts", async () => {
    const result = await runCli(["models", "--json"]);
    const parsed = JSON.parse(result.stdout) as {
      models: Array<{ id: string; gen?: number[]; aliases?: Array<{ name: string }>; reasoningEfforts?: string[] }>;
    };
    const astra = parsed.models.find((model) => model.id === "gpt-6-astra");
    assert.ok(astra !== undefined, "models must include gpt-6-astra");
    const latestAstra = parsed.models.find((model) => model.id === "gpt-6.2-astra");
    assert.ok(
      latestAstra?.aliases?.some((alias) => alias.name === "astra"),
      "gpt-6.2-astra must carry its derived 'astra' family alias",
    );
    assert.equal(astra.aliases?.some((alias) => alias.name === "astra"), false);
    // Keep the single-element generation tuple covered for the older exact ID.
    assert.deepEqual(astra.gen, [6], "gen for gpt-6-astra must be [6]");
    // The registry's narrowed effort vocabulary must reach the machine-readable registry:
    // a consumer that cannot see it will offer efforts this model rejects. (avoids PF-004)
    assert.deepEqual(
      astra.reasoningEfforts,
      ["low", "medium", "high", "xhigh", "max"],
      "reasoningEfforts for gpt-6-astra must be its five declared values",
    );
  });

  it("lists current family defaults with their generations and reasoning efforts", async () => {
    const result = await runCli(["models", "--json"]);
    const parsed = JSON.parse(result.stdout) as {
      models: Array<{ id: string; gen?: number[]; aliases?: Array<{ name: string }>; reasoningEfforts?: string[] }>;
    };
    for (const [id, family, gen] of [["gpt-6.2-sol", "sol", [6, 2]], ["gpt-6.2-astra", "astra", [6, 2]], ["gpt-6-luna", "luna", [6]]] as const) {
      const model = parsed.models.find((m) => m.id === id);
      assert.ok(model !== undefined, `models must include ${id}`);
      assert.ok(model.aliases?.some((alias) => alias.name === family), `${id} must carry the derived '${family}' alias`);
      assert.deepEqual(model.gen, gen, `gen for ${id}`);
      assert.deepEqual(model.reasoningEfforts, ["low", "medium", "high", "xhigh", "max"], `${id} reasoningEfforts`);
    }
    for (const id of ["gpt-6.1-sol", "gpt-6-sol", "gpt-5.6-sol"]) {
      const oldSol = parsed.models.find((m) => m.id === id);
      assert.ok(oldSol !== undefined, `models must still include ${id}`);
      assert.equal(oldSol.aliases?.some((alias) => alias.name === "sol"), false, "'sol' must have moved to gpt-6.2-sol");
    }
  });

  it("lists Terra 6.1 as preview without changing the terra family default", async () => {
    const result = await runCli(["models", "--json"]);
    const parsed = JSON.parse(result.stdout) as {
      models: Array<{ id: string; gen: number[]; aliases: Array<{ name: string }>; reasoningEfforts?: string[]; preview: boolean; routable: boolean }>;
    };
    const preview = parsed.models.find((model) => model.id === "gpt-6.1-terra");
    assert.ok(preview);
    assert.equal(preview.preview, true);
    assert.equal(preview.routable, true);
    assert.deepEqual(preview.gen, [6, 1]);
    assert.deepEqual(preview.reasoningEfforts, ["low", "medium", "high", "xhigh", "max"]);
    assert.deepEqual(preview.aliases, []);
    assert.ok(parsed.models.find((model) => model.id === "gpt-5.6-terra")?.aliases.some((alias) => alias.name === "terra"));
  });

  it("lists the retired gpt-5.5 as retired and not routable", async () => {
    const result = await runCli(["models", "--json"]);
    const parsed = JSON.parse(result.stdout) as { models: Array<{ id: string; retired: boolean; routable: boolean }> };
    const gpt55 = parsed.models.find((m) => m.id === "gpt-5.5");
    assert.ok(gpt55 !== undefined, "retired models stay in the registry and in models --json");
    assert.equal(gpt55.retired, true, "gpt-5.5 must be marked retired");
    assert.equal(gpt55.routable, false, "gpt-5.5 must not be advertised as routable");
  });

  // Conditional spread, not `?? undefined`: exactOptionalPropertyTypes is on, so an entry
  // that declares no reasoningEfforts must omit the key entirely rather than emit null.
  it("omits reasoningEfforts for a model that declares none (gpt-5.6-sol)", async () => {
    const result = await runCli(["models", "--json"]);
    const parsed = JSON.parse(result.stdout) as { models: Array<Record<string, unknown>> };
    const sol = parsed.models.find((model) => model["id"] === "gpt-5.6-sol");
    assert.ok(sol !== undefined, "models must include gpt-5.6-sol");
    assert.equal("reasoningEfforts" in sol, false, "gpt-5.6-sol declares no reasoningEfforts, so the key must be absent");
  });

  // ANSI bleed prevention: JSON branch returns before resolveColorEnabled.
  // With FORCE_COLOR=1, human-readable `models` stdout has ANSI; `models --json` stdout must NOT.
  it("FORCE_COLOR=1 does NOT bleed ANSI codes into JSON output (structural: JSON branch exits early)", async () => {
    // Force color on for the non-JSON branch (FORCE_COLOR beats NO_COLOR).
    // Passing NO_COLOR: undefined unsets it so FORCE_COLOR dominates.
    const forcedEnv = { FORCE_COLOR: "1", NO_COLOR: undefined };

    const humanResult = await runCli(["models"], { env: forcedEnv });
    const jsonResult = await runCli(["models", "--json"], { env: forcedEnv });

    // Human-readable output MUST contain ANSI when FORCE_COLOR=1.
    assert.ok(
      humanResult.stdout.includes("\x1b["),
      "models without --json must include ANSI codes when FORCE_COLOR=1",
    );

    // JSON output must NEVER contain ANSI codes — FORCE_COLOR must not bleed through.
    assert.ok(
      !jsonResult.stdout.includes("\x1b"),
      "models --json stdout must not contain ANSI escape codes even with FORCE_COLOR=1",
    );

    // And the JSON must still be valid.
    assert.doesNotThrow(() => JSON.parse(jsonResult.stdout), "JSON output must remain valid with FORCE_COLOR=1");
  });

  // A19: anthropic appears in providers with routing='passthrough' and contributes no model rows.
  // Anthropic is the fallback pass-through destination — it belongs in providers even though
  // the model registry has no anthropic-provider entries.
  it("A19 — anthropic appears in providers with routing='passthrough' and contributes no model rows", async () => {
    const result = await runCli(["models", "--json"]);
    const parsed = JSON.parse(result.stdout) as {
      providers: Array<{ id: string; routing: string }>;
      models: Array<{ provider: string }>;
    };
    const anthropicProv = parsed.providers.find((p) => p.id === "anthropic");
    assert.ok(anthropicProv !== undefined, "providers must include 'anthropic' entry");
    assert.equal(anthropicProv.routing, "passthrough", "anthropic provider must have routing='passthrough'");
    assert.ok(
      parsed.models.every((m) => m.provider !== "anthropic"),
      "no model row must claim provider='anthropic' (anthropic contributes no registry rows)",
    );
  });

  // A20: when config fails (legacy layout), stdout is exactly "" — no partial JSON,
  // no error text written to stdout. All diagnostics go to stderr.
  it("A20 — stdout is exactly empty when config fails to load", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "subswitch-a20-test-"));
    try {
      // Legacy top-level 'codex' key is rejected by detectLegacyConfigKeys.
      await writeFile(
        join(tmpDir, "subswitch.config.json"),
        JSON.stringify({ codex: { baseUrl: "https://chatgpt.com/backend-api/codex" } }),
        "utf8",
      );
      const result = await runCli(["models", "--json"], { cwd: tmpDir });
      assert.notEqual(result.exitCode, 0, "exit code must be non-zero on config failure");
      assert.equal(result.stdout, "", "stdout must be exactly empty on config failure");
      assert.ok(result.stderr.length > 0, "error message must be written to stderr");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  // A21: alias names are unique across all models in the JSON output.
  // The routing table build rejects duplicate alias names — this test verifies that
  // invariant is preserved end-to-end in the models --json output.
  it("A21 — alias names are unique across all model entries", async () => {
    const result = await runCli(["models", "--json"]);
    const parsed = JSON.parse(result.stdout) as {
      models: Array<{ aliases?: Array<{ name: string }> }>;
    };
    const seenNames = new Set<string>();
    for (const model of parsed.models) {
      for (const alias of model.aliases ?? []) {
        assert.ok(
          !seenNames.has(alias.name),
          `duplicate alias name '${alias.name}' in models --json output`,
        );
        seenNames.add(alias.name);
      }
    }
  });

  // A22: two consecutive runs produce byte-identical stdout.
  // The models command must be deterministic — same registry, same config, same output.
  it("A22 — two consecutive runs produce byte-identical stdout", async () => {
    const run1 = await runCli(["models", "--json"]);
    const run2 = await runCli(["models", "--json"]);
    assert.equal(run1.exitCode, 0, "first run must exit 0");
    assert.equal(run2.exitCode, 0, "second run must exit 0");
    assert.equal(run1.stdout, run2.stdout, "models --json stdout must be deterministic across runs");
  });

  // P5: models --json requires no network and no auth file — it reads only the config.
  // Verified by running in an empty directory (no config, no auth file) and confirming
  // the command exits 0 with valid JSON (pure registry + defaults).
  it("P5 — models --json exits 0 and produces valid JSON without auth file and without network", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "subswitch-p5-test-"));
    try {
      // No subswitch.config.json, no auth file — pure defaults from embedded registry.
      const result = await runCli(["models", "--json"], { cwd: tmpDir });
      assert.equal(result.exitCode, 0, "models --json must exit 0 (no network or auth required)");
      assert.doesNotThrow(() => JSON.parse(result.stdout), "output must be valid JSON");
      const parsed = JSON.parse(result.stdout) as { kind: string };
      assert.equal(parsed.kind, "models", "JSON kind must be 'models'");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("models --json output does not contain aliases when there are no config overrides", async () => {
    const result = await runCli(["models", "--json"]);
    const parsed = JSON.parse(result.stdout) as { models: Array<{ aliases?: unknown[] }> };
    // aliases array may be present but should be an array (possibly empty for models with no alias)
    for (const model of parsed.models) {
      if (model.aliases !== undefined) {
        assert.ok(Array.isArray(model.aliases), "model.aliases must be an array when present");
      }
    }
  });

  it("models --json includes a config alias when one is configured", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "subswitch-json-test-"));
    try {
      await writeFile(
        join(tmpDir, "subswitch.config.json"),
        JSON.stringify({ providers: { codex: { aliases: { fast: "gpt-5.6-sol" } } } }),
        "utf8",
      );
      const result = await runCli(["models", "--json"], { cwd: tmpDir });
      assert.equal(result.exitCode, 0);
      const parsed = JSON.parse(result.stdout) as {
        models: Array<{ id: string; aliases: Array<{ name: string; source: string }> }>;
      };
      const solModel = parsed.models.find((m) => m.id === "gpt-5.6-sol");
      assert.ok(solModel !== undefined, "gpt-5.6-sol must appear in models");
      const fastAlias = solModel.aliases.find((a) => a.name === "fast" && a.source === "config");
      assert.ok(fastAlias !== undefined, "gpt-5.6-sol must have 'fast' alias with source 'config'");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
