/**
 * Source-text guards — static assertions about prohibited patterns in src/.
 *
 * These tests are NOT behavioral coverage.  They encode structural obligations
 * that cannot be exercised at runtime while PROVIDER_IDS has only one member.
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
});
