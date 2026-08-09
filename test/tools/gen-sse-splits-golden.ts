/**
 * Regenerate `test/fixtures/sse-splits.golden.json`.
 *
 * Run: `node --import tsx test/tools/gen-sse-splits-golden.ts`
 *
 * The golden is the frame-boundary pin for `createSseParser`. It was captured against
 * the parser as it stood BEFORE the deferred-join rewrite, and a change to the parser
 * must never regenerate it — if a parser change requires a new golden, the parser change
 * altered frame boundaries, which is the one thing this file exists to forbid.
 *
 * Regenerate only when the corpus itself changes (a new `.sse` fixture, a new synthetic
 * separator case), and review the diff: every changed entry is a behaviour claim.
 *
 * APPEND-ONLY GUARD: if any existing entry's event sequence would change, this script
 * exits 1 rather than silently overwriting the oracle. A parser mutation therefore
 * cannot be laundered through a regeneration. Adding new corpus entries is always
 * allowed.
 */
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { observe, totalSplits } from "./sse-split-corpus.js";

type GoldenEntry = { readonly events: readonly unknown[] };
type GoldenJson = {
  readonly version: number;
  readonly entries: Readonly<Record<string, GoldenEntry>>;
  readonly handBuilt: Readonly<Record<string, GoldenEntry>>;
};

const observations = observe();
const counts = totalSplits(observations);
const target = new URL("../fixtures/sse-splits.golden.json", import.meta.url);

// APPEND-ONLY GUARD: read the existing golden and refuse to overwrite any entry whose
// event sequence changed. A parser mutation altering output must not be silenced by
// re-running this script. Adding new entries (new .sse fixtures or SYNTHETIC rows) is
// always allowed — those entries simply do not appear in the existing golden.
if (existsSync(target)) {
  const existing = JSON.parse(readFileSync(target, "utf8")) as GoldenJson;
  const changed: string[] = [];
  for (const [name, entry] of Object.entries(observations.entries)) {
    const prev = existing.entries[name];
    if (prev !== undefined && JSON.stringify(prev.events) !== JSON.stringify(entry.events)) {
      changed.push(name);
    }
  }
  for (const [name, entry] of Object.entries(observations.handBuilt)) {
    const prev = existing.handBuilt[name];
    if (prev !== undefined && JSON.stringify(prev.events) !== JSON.stringify(entry.events)) {
      changed.push(name);
    }
  }
  if (changed.length > 0) {
    process.stderr.write(
      `gen-sse-splits-golden: REFUSED. The following ${changed.length} entry/entries changed their event sequence:\n` +
        changed.map((n) => `  ${n}`).join("\n") +
        `\n\nThe golden is a pre-rewrite oracle — if createSseParser changed its output,\n` +
        `do NOT regenerate the golden. Investigate the parser change and fix it instead.\n` +
        `\nTo add a new corpus entry, add the .sse fixture or SYNTHETIC row and run again.\n`,
    );
    process.exit(1);
  }
}

writeFileSync(target, `${JSON.stringify({ version: 1, ...observations }, null, 2)}\n`);

process.stdout.write(
  `wrote ${target.pathname}\n` +
    `entries=${Object.keys(observations.entries).length} ` +
    `handBuilt=${Object.keys(observations.handBuilt).length} ` +
    `twoWaySplits=${counts.twoWay} threeWaySplits=${counts.threeWay}\n`,
);
