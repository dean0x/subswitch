/**
 * H4 — test-file discovery guard.
 *
 * The npm test command globs `test/{unit,integration}/*.test.ts`
 * NON-RECURSIVELY.  A test file placed in a subdirectory of either directory
 * silently never runs, reporting as success.  This guard catches that
 * by asserting that every *.test.ts file found recursively under those two
 * directories lives at the top level (no path separator in its relative path).
 *
 * Uses readdir({ recursive: true }) — the ADR-004-sanctioned form for Node >=22.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// test/unit/ is __dirname; repo root is two levels up
const testRoot = resolve(__dirname, "..");

describe("test-file discovery", () => {
  it("no *.test.ts files exist in subdirectories that the test glob would miss", async () => {
    const missed: string[] = [];

    for (const dir of ["unit", "integration"] as const) {
      const dirPath = join(testRoot, dir);
      // recursive: true returns relative paths; files in subdirs include a separator
      const entries = await readdir(dirPath, { recursive: true });
      for (const entry of entries) {
        if (!entry.endsWith(".test.ts")) continue;
        // A top-level file has no path separator; a nested one does.
        if (entry.includes("/") || entry.includes("\\")) {
          missed.push(`test/${dir}/${entry}`);
        }
      }
    }

    assert.deepEqual(
      missed,
      [],
      `The following *.test.ts files live in subdirectories and will NOT be run by \`npm test\`:\n${missed.join("\n")}\n\nMove them to test/unit/ or test/integration/ directly.`,
    );
  });
});
