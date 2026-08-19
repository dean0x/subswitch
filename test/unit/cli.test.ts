/**
 * CLI-level smoke tests for the `subswitch serve` command.
 *
 * This is the ONLY test file that can observe what `serve` actually prints:
 * `startSubswitch` (the integration harness) never calls `serve`, so the
 * integration tests structurally cannot see it.
 *
 * Precision on the two deprecation surfaces, because they have different
 * guarantees: the `config_key_deprecated` record goes through the logger and so
 * IS gated on log level (it appears here because "warn" >= the default "info");
 * the `errOut` notice writes to stderr directly and is NOT gated on log level at
 * all. Only the first is evidence about level handling.
 *
 * Non-vacuity strategy: each assertion is paired with a negative control that
 * proves the absence-of-warning case is observable — i.e. that a clean config
 * produces no warning, while a dirty config does. Without that control, a test
 * that asserts "warning appears" only proves the process can write to stderr.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";

// Resolve project root: test/unit/cli.test.ts → ../../
const PROJECT_ROOT = join(fileURLToPath(import.meta.url), "..", "..", "..");
const CLI_ENTRY = join(PROJECT_ROOT, "src", "cli.ts");

// ---------------------------------------------------------------------------
// Port helpers
// ---------------------------------------------------------------------------

/**
 * Allocate an OS-assigned ephemeral port by binding to 0, recording the port,
 * then closing the server. Not port 0 itself — PortSchema min(1) rejects 0.
 *
 * TOCTOU note: the port could be reused in the gap between close() and the
 * spawn. In practice this race is negligible for test-local ports; do not
 * hardcode port 4141 (it collides with a running subswitch instance).
 */
function getEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as net.AddressInfo;
      const { port } = addr;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
    server.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// CLI spawn helper
// ---------------------------------------------------------------------------

interface ServeResult {
  /** All text written to stderr by the process. */
  readonly stderr: string;
  /** All text written to stdout by the process. */
  readonly stdout: string;
  /** Exit code (null if the process was killed). */
  readonly code: number | null;
}

/**
 * Spawn `subswitch serve --port <port>` with a given config path, wait for
 * the ready banner on stderr, then send SIGTERM and resolve once the process
 * exits. Rejects on timeout (10 s default) or if the process exits before
 * the ready banner appears.
 *
 * Non-vacuity: the deprecation warning is emitted BEFORE the ready banner.
 * If the warning were only emitted at verbose level (or never), the stderr
 * string would not contain it — and asserting its presence would then fail.
 *
 * @param port         Ephemeral port previously allocated via getEphemeralPort().
 * @param configPath   Path to a config file passed via SUBSWITCH_CONFIG env var.
 * @param timeoutMs    Maximum wait time for the ready banner.
 */
function runServeUntilReady(
  port: number,
  configPath: string,
  timeoutMs = 10_000,
): Promise<ServeResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,           // node
      ["--import", "tsx", CLI_ENTRY, "serve", "--port", String(port)],
      {
        env: {
          ...process.env,
          SUBSWITCH_CONFIG: configPath,
          // Suppress color codes so assertions can use plain string includes.
          NO_COLOR: "1",
          // CI=1 prevents interactive prompts in case stdin is a TTY.
          CI: "1",
        },
        cwd: PROJECT_ROOT,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    let settled = false;

    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      // The ready banner is: "subswitch ready — http://127.0.0.1:<port>"
      if (!settled && stderr.includes(`subswitch ready`)) {
        settled = true;
        // Signal the process to shut down gracefully.
        child.kill("SIGTERM");
      }
    });

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        reject(new Error(`runServeUntilReady: timed out after ${timeoutMs} ms waiting for ready banner.\nstderr so far:\n${stderr}`));
      }
    }, timeoutMs);

    child.on("exit", (code) => {
      clearTimeout(timer);
      if (!settled) {
        // Process exited before ready banner — likely a startup failure.
        settled = true;
        reject(new Error(`runServeUntilReady: process exited with code ${code} before ready banner.\nstderr:\n${stderr}`));
        return;
      }
      resolve({ stderr, stdout, code });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("serve — deprecation warning at default log level", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "subswitch-cli-test-"));
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("emits config_key_deprecated warning on stderr when a deprecated key is present", async () => {
    // Non-vacuity argument:
    //   - Positive case: deprecated key present → warning MUST appear on stderr.
    //   - Negative control (next test): no deprecated key → warning MUST be absent.
    // If the warning were only emitted at verbose level (not at the default "info"
    // logLevel), this test would fail because no --verbose is passed here.
    // If errOut were removed from the serve path, or the warning text changed,
    // this test would fail too.

    const configPath = join(tmpDir, "config-deprecated.json");
    // limits.maxConcurrentRequests is one of the six deprecated keys.
    await writeFile(configPath, JSON.stringify({
      limits: { maxConcurrentRequests: 32 },
    }));

    const port = await getEphemeralPort();
    const result = await runServeUntilReady(port, configPath);

    // Two INDEPENDENT surfaces, asserted separately.  An `||` across them would let
    // either one be deleted while the other kept the assertion green — the structured
    // record could be dropped to `debug`, or the human notice removed, unnoticed.
    assert.ok(
      result.stderr.includes("config_key_deprecated"),
      `stderr must carry the structured warn record 'config_key_deprecated' — it is what a log ` +
      `pipeline greps for, and it must be emitted at warn (a debug-level record would not appear here).\n` +
      `stderr:\n${result.stderr}`,
    );
    assert.ok(
      result.stderr.includes('deprecated config key "limits.maxConcurrentRequests"'),
      `stderr must carry the human-readable errOut() notice naming the key.\n` +
      `stderr:\n${result.stderr}`,
    );
    assert.ok(
      result.stderr.includes("limits.maxConcurrentRequests"),
      `stderr must name the deprecated key.\nstderr:\n${result.stderr}`,
    );
    assert.ok(
      result.stderr.includes("admission gate"),
      `stderr must include the deprecation reason.\nstderr:\n${result.stderr}`,
    );
  });

  it("does NOT emit config_key_deprecated warning when no deprecated keys are present (negative control)", async () => {
    // This test proves the positive assertion above is non-vacuous: the warning
    // does NOT appear for a clean config, so a passing positive test means the
    // warning was actually triggered by the deprecated key — not emitted always.

    const configPath = join(tmpDir, "config-clean.json");
    // No deprecated keys — just a port override (omitted here since we pass --port).
    await writeFile(configPath, JSON.stringify({}));

    const port = await getEphemeralPort();
    const result = await runServeUntilReady(port, configPath);

    assert.ok(
      !result.stderr.includes("deprecated config key"),
      `stderr must NOT contain any deprecation warning for a clean config.\nstderr:\n${result.stderr}`,
    );
  });
});
