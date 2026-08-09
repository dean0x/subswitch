import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  HAND_BUILT,
  THREE_WAY_ENTRY,
  buildCorpus,
  driveParser,
  type GoldenEvent,
  type Observations,
} from "../tools/sse-split-corpus.js";

/**
 * FRAME-BOUNDARY PIN for `createSseParser`.
 *
 * `test/fixtures/sse-splits.golden.json` was captured against the parser as it stood
 * BEFORE the deferred-join rewrite (commit "test(sse): pin frame boundaries…", which
 * contains no `src/` change). Every later parser change must reproduce it exactly.
 *
 * REVIEW GATE: a commit that modifies `src/codex-response.ts`'s parser and also modifies
 * `sse-splits.golden.json` is wrong by construction — the golden is the definition of
 * "frame boundaries unchanged", so a parser change that needs a new golden has changed
 * the thing it was forbidden to change. Regenerate the golden ONLY when the corpus grows
 * (`node --import tsx test/tools/gen-sse-splits-golden.ts`).
 *
 * The golden records ONE frame sequence per corpus entry, not one per split, and every
 * split is asserted against it. That is strictly stronger than recording each split's
 * own result — it additionally pins split-invariance, the property that makes chunk
 * boundaries unobservable — and it keeps the fixture at ~27 KB instead of tens of MB.
 */
const golden = JSON.parse(
  readFileSync(new URL("../fixtures/sse-splits.golden.json", import.meta.url), "utf8"),
) as Observations & { readonly version: number };

/** JSON compare in the hot loop (~66k drives); `deepEqual` is used only to render a failure. */
const same = (actual: readonly GoldenEvent[], expected: readonly GoldenEvent[]): boolean =>
  JSON.stringify(actual) === JSON.stringify(expected);

const expectSame = (actual: readonly GoldenEvent[], expected: readonly GoldenEvent[], where: string): void => {
  if (same(actual, expected)) return;
  assert.deepEqual(actual, expected, `frame sequence changed at ${where}`);
  assert.fail(`frame sequence changed at ${where}`);
};

const corpus = buildCorpus();
const twoWayTotal = Object.values(golden.entries).reduce((sum, e) => sum + e.twoWaySplits, 0);
const threeWayTotal = Object.values(golden.entries).reduce((sum, e) => sum + e.threeWaySplits, 0);

describe("createSseParser frame-boundary golden", () => {
  it("covers exactly the entries recorded in the golden", () => {
    assert.deepEqual(
      corpus.map((entry) => entry.name).sort(),
      Object.keys(golden.entries).sort(),
      "corpus drifted from the golden — regenerate deliberately, and review every changed frame sequence",
    );
    for (const { name, bytes } of corpus) {
      assert.equal(golden.entries[name]?.byteLength, bytes.length, `${name} changed size since the golden was captured`);
    }
  });

  it(`reproduces the golden frame sequence for all ${twoWayTotal} two-way splits`, () => {
    for (const { name, bytes } of corpus) {
      const expected = golden.entries[name];
      assert.ok(expected !== undefined, `${name} missing from golden`);
      expectSame(driveParser([bytes]), expected.events, `${name} unsplit`);
      let splits = 0;
      for (let i = 1; i < bytes.length; i += 1) {
        expectSame(driveParser([bytes.subarray(0, i), bytes.subarray(i)]), expected.events, `${name} split@${i}`);
        splits += 1;
      }
      assert.equal(splits, expected.twoWaySplits, `${name} split count drifted`);
    }
  });

  it(`reproduces the golden frame sequence for all ${threeWayTotal} three-way splits of ${THREE_WAY_ENTRY}`, () => {
    const entry = corpus.find((e) => e.name === THREE_WAY_ENTRY);
    assert.ok(entry !== undefined, `${THREE_WAY_ENTRY} is missing from the corpus`);
    const expected = golden.entries[THREE_WAY_ENTRY];
    assert.ok(expected !== undefined, `${THREE_WAY_ENTRY} is missing from the golden`);
    const { bytes } = entry;
    let splits = 0;
    for (let i = 1; i < bytes.length - 1; i += 1) {
      for (let j = i + 1; j < bytes.length; j += 1) {
        const actual = driveParser([bytes.subarray(0, i), bytes.subarray(i, j), bytes.subarray(j)]);
        expectSame(actual, expected.events, `${THREE_WAY_ENTRY} split@${i}/${j}`);
        splits += 1;
      }
    }
    assert.equal(splits, expected.threeWaySplits, "three-way split count drifted");
    assert.ok(splits > 0, "three-way sweep did not run — a separator spanning three chunks would be unexercised");
  });

  it("reproduces the golden frame sequence for hand-built multi-chunk separators", () => {
    assert.deepEqual(
      HAND_BUILT.map(([name]) => name).sort(),
      Object.keys(golden.handBuilt).sort(),
      "hand-built case list drifted from the golden",
    );
    for (const [name, chunks] of HAND_BUILT) {
      const expected = golden.handBuilt[name];
      assert.ok(expected !== undefined, `${name} missing from golden`);
      assert.deepEqual([...chunks], [...expected.chunks], `${name} chunk layout drifted from the golden`);
      expectSame(driveParser(chunks.map((c) => Buffer.from(c))), expected.events, `hand-built ${name}`);
    }
  });
});
