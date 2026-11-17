import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ClaudeCache } from "../../src/claude-cache.js";

describe("atomic replay-cache batches", () => {
  it("accounts for repeated replacements and new keys using their final values", () => {
    const cache = new ClaudeCache({ maxEntries: 2, maxBytes: 4096 }, true);
    cache.put("snapshot", "existing", { request: { text: "x".repeat(2000) }, input: [] });
    const final = { request: { text: "small" }, input: [] };
    cache.putBatch([
      { kind: "snapshot", id: "existing", value: { request: { text: "large".repeat(100) }, input: [] } },
      { kind: "adapted", id: "new", value: true },
      { kind: "snapshot", id: "existing", value: final },
      { kind: "adapted", id: "new", value: true },
    ]);
    assert.equal(cache.size, 2);
    assert.deepEqual(cache.get("snapshot", "existing"), final);
    assert.equal(cache.get("adapted", "new"), true);
    assert.equal(cache.byteSize,
      Buffer.byteLength(JSON.stringify(final)) + Buffer.byteLength("snapshot:existing") +
      Buffer.byteLength("true") + Buffer.byteLength("adapted:new"));
  });

  it("keeps prior values and byte accounting intact when a later write exceeds the budget", () => {
    const cache = new ClaudeCache({ maxEntries: 4, maxBytes: 512 }, true);
    const original = { request: { text: "original" }, input: [] };
    cache.put("snapshot", "existing", original);
    const bytes = cache.byteSize;
    assert.throws(() => cache.putBatch([
      { kind: "snapshot", id: "existing", value: { request: {}, input: [] } },
      { kind: "snapshot", id: "oversized", value: { request: { text: "x".repeat(512) }, input: [] } },
    ]), /continuation_store_full/);
    assert.deepEqual(cache.get("snapshot", "existing"), original);
    assert.equal(cache.get("snapshot", "oversized"), undefined);
    assert.equal(cache.byteSize, bytes);
    assert.equal(cache.size, 1);
  });

  it("preserves existing eviction order when publishing a batch", () => {
    const cache = new ClaudeCache({ maxEntries: 2, maxBytes: 4096 });
    cache.put("adapted", "oldest", true);
    cache.put("adapted", "recent", true);
    cache.putBatch([{ kind: "adapted", id: "oldest", value: true }]);
    cache.put("adapted", "new", true);
    assert.equal(cache.get("adapted", "oldest"), undefined);
    assert.equal(cache.get("adapted", "recent"), true);
    assert.equal(cache.get("adapted", "new"), true);
  });
});
