/** Synthetic scope data. Compare fixed update work as the quota store grows. */
import { performance } from "node:perf_hooks";
import assert from "node:assert/strict";
import { QuotaStore } from "../../src/routing/quota-store.js";
import type {
  AllowanceScope,
  ClassifiedFailure,
} from "../../src/routing/routing-types.js";

const median = (values: number[]) =>
  values.sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const sizes = [512, 1024, 2048, 4096];
const results: { scopes: number; updateMs: number; bytes: number }[] = [];
let now = 1000;
const scope = (index: number): AllowanceScope => ({
  provider: "kimi",
  product: "kimi-code",
  region: "global",
  account: `synthetic-${index}`,
  allowanceGroup: "kimi-code",
});
const failure = (index: number): ClassifiedFailure => ({
  scope: scope(index),
  kind: "quota",
  evidence: "documented",
  bodyTruncated: false,
  responseCommitted: false,
  windows: [
    { id: "weekly", exhausted: true, observedAt: now, source: "inference" },
  ],
});

for (const size of sizes) {
  const store = new QuotaStore({
    now: () => now,
    monotonic: () => now,
    random: () => 0.5,
  });
  for (let index = 0; index < size; index++) store.fail(failure(index));
  const samples: number[] = [];
  for (let sample = 0; sample < 7; sample++) {
    const start = performance.now();
    for (let update = 0; update < 1000; update++) {
      now++;
      store.fail(failure(update % 32));
    }
    samples.push(performance.now() - start);
  }
  results.push({
    scopes: size,
    updateMs: median(samples),
    bytes: store.byteSize,
  });
  assert.equal(store.size, size);
  assert.ok(store.byteSize <= 4 * 1024 * 1024);
}

console.table(
  results.map((result) => ({
    ...result,
    updateMs: result.updateMs.toFixed(2),
  })),
);
const growth = results.at(-1)!.updateMs / results[0]!.updateMs;
assert.ok(
  growth < 3.5,
  `Fixed update work grew ${growth.toFixed(2)}x for 8x as many stored scopes`,
);
console.log(
  `Fixed-work update ratio, 4096/512 scopes: ${growth.toFixed(2)}x (limit 3.5x)`,
);
