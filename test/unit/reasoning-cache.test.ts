import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ReasoningCache } from "../../src/reasoning-cache.js";

// Large byte cap that won't interfere with entry-count eviction tests.
const LARGE_BYTES = 64 * 1024 * 1024;

describe("ReasoningCache", () => {
  it("stores and returns items without removing them", () => {
    const cache = new ReasoningCache(4, LARGE_BYTES);
    const items = [{ type: "reasoning", id: "rs_1" }];
    cache.put("call_1", items);
    assert.equal(cache.get("call_1"), items);
    assert.equal(cache.get("call_1"), items);
    assert.equal(cache.size, 1);
  });

  it("evicts the least recently used entry beyond the bound", () => {
    const cache = new ReasoningCache(2, LARGE_BYTES);
    cache.put("a", [1]);
    cache.put("b", [2]);
    cache.put("c", [3]);
    assert.equal(cache.get("a"), undefined);
    assert.deepEqual(cache.get("b"), [2]);
    assert.deepEqual(cache.get("c"), [3]);
    assert.equal(cache.size, 2);
  });

  it("get refreshes recency", () => {
    const cache = new ReasoningCache(2, LARGE_BYTES);
    cache.put("a", [1]);
    cache.put("b", [2]);
    cache.get("a");
    cache.put("c", [3]);
    assert.deepEqual(cache.get("a"), [1]);
    assert.equal(cache.get("b"), undefined);
  });

  it("shares one items array across parallel call ids", () => {
    const cache = new ReasoningCache(4, LARGE_BYTES);
    const shared = [{ type: "reasoning", id: "rs_shared" }];
    cache.put("call_a", shared);
    cache.put("call_b", shared);
    assert.equal(cache.get("call_a"), cache.get("call_b"));
  });

  // -------------------------------------------------------------------------
  // R5: byte-pressure eviction tests
  // -------------------------------------------------------------------------

  it("evicts LRU entry when byte limit is exceeded", () => {
    // JSON.stringify([1,2,3]) = "[1,2,3]" = 7 bytes each
    const cache = new ReasoningCache(100, 20);
    cache.put("a", [1, 2, 3]); // 7 bytes, total=7
    cache.put("b", [4, 5, 6]); // 7 bytes, total=14
    cache.put("c", [7, 8, 9]); // 7 bytes, total=21 → evict "a" → total=14
    assert.equal(cache.get("a"), undefined);
    assert.deepEqual(cache.get("b"), [4, 5, 6]);
    assert.deepEqual(cache.get("c"), [7, 8, 9]);
    assert.equal(cache.size, 2);
  });

  it("oversized single entry stays as the only cache entry without looping", () => {
    // maxBytes=10; put a ~104-byte entry → stays as sole entry (degenerate case)
    const cache = new ReasoningCache(100, 10);
    cache.put("big", ["x".repeat(100)]); // 4+100=104 bytes
    assert.equal(cache.size, 1);
    assert.ok(cache.get("big") !== undefined);
  });

  it("evicts oversized entry when a normal entry is added after it", () => {
    const cache = new ReasoningCache(100, 10);
    cache.put("big", ["x".repeat(100)]); // 104 bytes, stays as sole entry
    cache.put("small", [1]);              // 3 bytes → big is LRU → evict big → total=3
    assert.equal(cache.size, 1);
    assert.equal(cache.get("big"), undefined);
    assert.deepEqual(cache.get("small"), [1]);
  });

  it("recency refresh under byte pressure preserves most-recently-used entry", () => {
    // Each entry: JSON.stringify([1,2,3]) = 7 bytes; maxBytes=20
    const cache = new ReasoningCache(100, 20);
    cache.put("a", [1, 2, 3]); // 7 bytes
    cache.put("b", [4, 5, 6]); // 7 bytes
    cache.get("a");             // refresh "a" → "b" is now oldest
    cache.put("c", [7, 8, 9]); // 7 bytes, total=21 → evict "b" → total=14
    assert.deepEqual(cache.get("a"), [1, 2, 3]);
    assert.equal(cache.get("b"), undefined);
    assert.deepEqual(cache.get("c"), [7, 8, 9]);
  });

  it("tracks totalBytes correctly on key overwrite", () => {
    const cache = new ReasoningCache(100, 1000);
    cache.put("a", [1, 2, 3]); // JSON.stringify = "[1,2,3]" = 7 bytes
    assert.equal(cache.byteSize, 7);
    cache.put("a", [1]);        // JSON.stringify = "[1]" = 3 bytes
    assert.equal(cache.byteSize, 3);
    assert.equal(cache.size, 1);
    assert.deepEqual(cache.get("a"), [1]);
  });
});
