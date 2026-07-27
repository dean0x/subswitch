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
 */
import { writeFileSync } from "node:fs";
import { observe, totalSplits } from "./sse-split-corpus.js";

const observations = observe();
const counts = totalSplits(observations);
const target = new URL("../fixtures/sse-splits.golden.json", import.meta.url);

writeFileSync(target, `${JSON.stringify({ version: 1, ...observations }, null, 2)}\n`);

process.stdout.write(
  `wrote ${target.pathname}\n` +
    `entries=${Object.keys(observations.entries).length} ` +
    `handBuilt=${Object.keys(observations.handBuilt).length} ` +
    `twoWaySplits=${counts.twoWay} threeWaySplits=${counts.threeWay}\n`,
);
