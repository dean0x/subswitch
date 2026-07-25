/**
 * Integration tests for the CLI entry point.
 *
 * Each test spawns `tsx src/cli.ts` in a fresh temp directory and checks exit
 * code + stdout/stderr. Tests are bounded with a 10 s timeout. [F9/F26]
 *
 * Important constraints:
 * - Spawned processes have no TTY (piped I/O), so init without --yes triggers
 *   the fail-closed "refuse" path — this is what we test.
 * - We never assert that doctor exits 0 (avoids PF-006 pattern).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Resolve repo root from test/integration/ (two levels up)
const repoRoot = resolve(__dirname, "../..");

// tsx binary installed in the project's node_modules
const tsxBin = join(repoRoot, "node_modules", ".bin", "tsx");
const cliEntry = join(repoRoot, "src", "cli.ts");

interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawn the CLI with the given args. `cwd` defaults to a caller-supplied temp
 * dir. Bounced by a 10 s timeout so a hanging serve never blocks the suite.
 */
const runCli = async (
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<SpawnResult> => {
  const { cwd = repoRoot, env = process.env, timeoutMs = 10_000 } = options;

  return new Promise<SpawnResult>((resolve, reject) => {
    const proc = spawn(tsxBin, [cliEntry, ...args], {
      cwd,
      env: { ...env, NO_COLOR: "1" },
      // Do NOT pass stdio: "inherit" — we need to capture stdout/stderr
    });

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
};

// ---------------------------------------------------------------------------
// --help / --version → exit 0
// ---------------------------------------------------------------------------

describe("CLI --help", () => {
  it("exits 0 and prints usage to stdout", async () => {
    const result = await runCli(["--help"]);
    assert.equal(result.exitCode, 0);
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

  it("marks disabled models when a config in the cwd narrows codex.models", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "subswitch-models-test-"));
    try {
      // Only gpt-5.6-sol is enabled; the other registry aliases should be disabled.
      await writeFile(
        join(tmpDir, "subswitch.config.json"),
        JSON.stringify({ codex: { models: ["gpt-5.6-sol"] } }),
        "utf8",
      );
      const result = await runCli(["models"], { cwd: tmpDir });
      assert.equal(result.exitCode, 0);
      assert.ok(result.stdout.includes("disabled"), "output should mark disabled aliases");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("shows a config alias override with the (config) source label", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "subswitch-models-test-"));
    try {
      await writeFile(
        join(tmpDir, "subswitch.config.json"),
        JSON.stringify({ codex: { aliases: { myalias: "gpt-5.6-sol" } } }),
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
    assert.ok(
      result.stderr.includes("verbose") || result.stderr.includes("subswitch:"),
      "stderr should mention the misapplied flag or carry a subswitch: prefix",
    );
  });
});
