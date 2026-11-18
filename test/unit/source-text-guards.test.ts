/**
 * Source-text guards — static assertions about prohibited patterns in src/.
 *
 * These tests are NOT behavioral coverage. They encode structural obligations.
 * Each guard is clearly labelled so nobody mistakes it for a behavioral test.
 *
 * G1: PROVIDER_IDS[0] must not appear in src/models.ts or src/server.ts.
 *
 *   Background: `collectAliasDeclarations` iterates PROVIDER_IDS and carries
 *   the declaring provider alongside each alias declaration.  Falling back to
 *   PROVIDER_IDS[0] when the declaring provider is already in hand is correct
 *   only by coincidence while PROVIDER_IDS.length === 1.  A runtime test
 *   cannot distinguish the two cases until a second provider is wired, so a
 *   source-text guard is the only preventive control.
 *
 *   Mutation that proves it: insert `PROVIDER_IDS[0]` anywhere in models.ts or
 *   server.ts and this test goes RED.  Remove it and it returns GREEN.
 *
 * G2: Serve shutdown must stop the quota poller before server close, then flush
 *   the recorder. Remove the stop call or move it after close to prove RED.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../src");

const readSrc = (name: string): string =>
  readFileSync(join(SRC_DIR, name), "utf8");

// ---------------------------------------------------------------------------
// G1 — PROVIDER_IDS[0] must not appear in models.ts or server.ts
//
// SOURCE-TEXT GUARD: this assertion checks code structure, not runtime behavior.
// ---------------------------------------------------------------------------

describe("source-text guards", () => {
  it("G1: PROVIDER_IDS[0] must not appear in src/models.ts or src/server.ts", () => {
    const modelsTs = readSrc("models.ts");
    const serverTs = readSrc("server.ts");

    // The forbidden pattern as a literal — searching for the exact characters
    // so the guard cannot be fooled by whitespace or reformatting.
    const forbidden = "PROVIDER_IDS[0]";

    assert.ok(
      !modelsTs.includes(forbidden),
      `src/models.ts contains "${forbidden}" — the declaring provider must always be in hand (see KNOWLEDGE.md anti-patterns); PROVIDER_IDS[0] is valid only by coincidence while PROVIDER_IDS.length === 1`,
    );
    assert.ok(
      !serverTs.includes(forbidden),
      `src/server.ts contains "${forbidden}" — the declaring provider must always be in hand (see KNOWLEDGE.md anti-patterns); PROVIDER_IDS[0] is valid only by coincidence while PROVIDER_IDS.length === 1`,
    );
  });

  // SOURCE-TEXT GUARD: call order only; this is not runtime shutdown coverage.
  it("G2: serve stops the quota poller before server close and flushes the recorder after close", () => {
    const serve = readSrc("cli.ts").match(/const serve = async \([\s\S]*?\n\};/)?.[0];
    assert.ok(serve, "cli.ts must define serve");
    const shutdown = serve.match(/const shutdown = \(\): void => \{([\s\S]*?)\n  \};/)?.[1];
    assert.ok(shutdown, "serve must define its shutdown path");

    const stop = shutdown.indexOf("poller?.stop()");
    const close = shutdown.indexOf("server.close(");
    const flush = shutdown.indexOf("recorder?.flush()");
    assert.ok(stop >= 0, "serve shutdown must stop the quota poller");
    assert.ok(close > stop, "serve shutdown must stop the poller before server close");
    assert.ok(flush > close, "serve shutdown must flush the recorder after server close");
  });
});
