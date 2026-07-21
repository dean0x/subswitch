import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ReasoningCache } from "../../src/reasoning-cache.js";

describe("ReasoningCache", () => {
  it("stores and returns items without removing them", () => {
    const cache = new ReasoningCache(4);
    const items = [{ type: "reasoning", id: "rs_1" }];
    cache.put("call_1", items);
    assert.equal(cache.get("call_1"), items);
    assert.equal(cache.get("call_1"), items);
    assert.equal(cache.size, 1);
  });

  it("evicts the least recently used entry beyond the bound", () => {
    const cache = new ReasoningCache(2);
    cache.put("a", [1]);
    cache.put("b", [2]);
    cache.put("c", [3]);
    assert.equal(cache.get("a"), undefined);
    assert.deepEqual(cache.get("b"), [2]);
    assert.deepEqual(cache.get("c"), [3]);
    assert.equal(cache.size, 2);
  });

  it("get refreshes recency", () => {
    const cache = new ReasoningCache(2);
    cache.put("a", [1]);
    cache.put("b", [2]);
    cache.get("a");
    cache.put("c", [3]);
    assert.deepEqual(cache.get("a"), [1]);
    assert.equal(cache.get("b"), undefined);
  });

  it("shares one items array across parallel call ids", () => {
    const cache = new ReasoningCache(4);
    const shared = [{ type: "reasoning", id: "rs_shared" }];
    cache.put("call_a", shared);
    cache.put("call_b", shared);
    assert.equal(cache.get("call_a"), cache.get("call_b"));
  });
});
