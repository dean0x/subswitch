/** Synthetic replay writes: commit cost should depend on the batch, not cached history. */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { ClaudeCache } from "../../src/claude-cache.js";

const median = (values: number[]) =>
  values.sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const results: { entries: number; commitMs: number }[] = [];
for (const entries of [256, 512, 1024, 2048]) {
  const cache = new ClaudeCache({ maxEntries: 2048, maxBytes: 32 * 1024 * 1024 }, true);
  for (let index = 0; index < entries; index++)
    cache.put("adapted", `synthetic-${index}`, true);
  const samples: number[] = [];
  for (let sample = 0; sample < 7; sample++) {
    const start = performance.now();
    for (let update = 0; update < 1000; update++)
      cache.putBatch([{ kind: "adapted", id: `synthetic-${update % 16}`, value: true }]);
    samples.push(performance.now() - start);
  }
  assert.equal(cache.size, entries);
  results.push({ entries, commitMs: median(samples) });
}
console.table(results.map((result) => ({ ...result, commitMs: result.commitMs.toFixed(2) })));
const growth = results.at(-1)!.commitMs / results[0]!.commitMs;
assert.ok(growth < 3.5, `Fixed commit work grew ${growth.toFixed(2)}x for 8x as much cached history`);
console.log(`Fixed-work commit ratio, 2048/256 entries: ${growth.toFixed(2)}x (limit 3.5x)`);
