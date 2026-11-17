import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ClaudeCache, type KimiExecAssociation } from "../../src/claude-cache.js";

const association = (attempt = "first"): KimiExecAssociation => ({
  codecVersion: "kimi-exec-v1", declarationFingerprint: "fixture", owner: "owner", conversation: "conversation",
  credentialGeneration: "generation", attempt, callId: "call", item: { type: "custom_tool_call", input: "source" },
});
const entryBytes = (kind: string, id: string, value: unknown) =>
  Buffer.byteLength(`${kind}:${id}`) + Buffer.byteLength(JSON.stringify(value));

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

  for (const strict of [false, true]) {
    it(`rejects a committed exec identity without publishing any sibling writes (strict=${strict})`, () => {
      const cache = new ClaudeCache({ maxEntries: 8, maxBytes: 8192 }, strict);
      const original = association(), snapshot = { request: { text: "original" }, input: [] };
      cache.put("kimiExec", "committed", original);
      cache.put("snapshot", "existing", snapshot);
      const bytes = cache.byteSize;
      assert.throws(() => cache.putBatch([
        { kind: "snapshot", id: "existing", value: { request: {}, input: [] } },
        { kind: "kimiExec", id: "fresh", value: association("fresh") },
        { kind: "kimiExec", id: "committed", value: association("second") },
        { kind: "adapted", id: "fresh", value: true },
      ]), /continuity_unavailable/);
      assert.equal(cache.get("kimiExec", "committed"), original);
      assert.equal(cache.get("snapshot", "existing"), snapshot);
      assert.equal(cache.get("kimiExec", "fresh"), undefined);
      assert.equal(cache.get("adapted", "fresh"), undefined);
      assert.equal(cache.size, 2);
      assert.equal(cache.byteSize, bytes);
    });

    for (const second of ["first", "second"]) {
      it(`rejects duplicate exec keys within one batch, including identical values (strict=${strict}, attempt=${second})`, () => {
        const cache = new ClaudeCache({ maxEntries: 3, maxBytes: 8192 }, strict);
        cache.put("adapted", "existing", true);
        const bytes = cache.byteSize;
        assert.throws(() => cache.putBatch([
          { kind: "snapshot", id: "fresh", value: { request: {}, input: [] } },
          { kind: "kimiExec", id: "duplicate", value: association() },
          { kind: "kimiExec", id: "duplicate", value: association(second) },
        ]), /continuity_unavailable/);
        assert.equal(cache.get("snapshot", "fresh"), undefined);
        assert.equal(cache.get("kimiExec", "duplicate"), undefined);
        assert.equal(cache.size, 1);
        assert.equal(cache.byteSize, bytes);
        cache.putBatch([{ kind: "kimiExec", id: "valid", value: association() }]);
        assert.equal(cache.size, 2);
        assert.equal(cache.byteSize, bytes + entryBytes("kimiExec", "valid", association()));
      });
    }

    it(`single writes cannot replace an exec identity or alter its budget (strict=${strict})`, () => {
      const cache = new ClaudeCache({ maxEntries: 1, maxBytes: 8192 }, strict), original = association();
      cache.put("kimiExec", "committed", original);
      const bytes = cache.byteSize;
      for (const replacement of [original, association("second")])
        assert.throws(() => cache.put("kimiExec", "committed", replacement), /continuity_unavailable/);
      assert.equal(cache.get("kimiExec", "committed"), original);
      assert.equal(cache.size, 1);
      assert.equal(cache.byteSize, bytes);
    });
  }

  for (const bound of ["entries", "bytes"]) {
    it(`retains atomic ${bound} preflight for mixed exec batches and exact accounting after failure`, () => {
      const value = association();
      const exactBytes = entryBytes("adapted", "existing", true) + entryBytes("kimiExec", "valid", value);
      const cache = new ClaudeCache({ maxEntries: bound === "entries" ? 2 : 8,
        maxBytes: bound === "bytes" ? exactBytes : 8192 }, true);
      cache.put("adapted", "existing", true);
      const bytes = cache.byteSize;
      assert.throws(() => cache.putBatch([
        { kind: "kimiExec", id: "valid", value },
        { kind: "snapshot", id: "too-large", value: { request: { text: "x".repeat(bound === "bytes" ? 8192 : 1) }, input: [] } },
      ]), /continuation_store_full/);
      assert.equal(cache.size, 1);
      assert.equal(cache.byteSize, bytes);
      assert.equal(cache.get("kimiExec", "valid"), undefined);
      assert.equal(cache.get("snapshot", "too-large"), undefined);
      cache.putBatch([{ kind: "kimiExec", id: "valid", value }]);
      assert.equal(cache.size, 2);
      assert.equal(cache.byteSize, exactBytes);
    });
  }

  it("preserves snapshot, replay and adapted upserts and their namespaced keys", () => {
    const cache = new ClaudeCache({ maxEntries: 4, maxBytes: 4096 }, true);
    cache.put("kimiExec", "same", association());
    cache.put("snapshot", "same", { request: {}, input: [] });
    cache.put("replay", "same", { content: [], output: [] });
    cache.put("adapted", "same", true);
    const snapshot = { request: { text: "final" }, input: [] };
    const replay = { content: [{ type: "text", text: "final" }], output: [] };
    cache.putBatch([
      { kind: "snapshot", id: "same", value: { request: { text: "interim" }, input: [] } },
      { kind: "replay", id: "same", value: { content: [], output: [{ type: "reasoning" }] } },
      { kind: "adapted", id: "same", value: true },
      { kind: "snapshot", id: "same", value: snapshot },
      { kind: "replay", id: "same", value: replay },
      { kind: "adapted", id: "same", value: true },
    ]);
    assert.equal(cache.get("snapshot", "same"), snapshot);
    assert.equal(cache.get("replay", "same"), replay);
    assert.equal(cache.get("adapted", "same"), true);
    assert.equal(cache.size, 4);
    assert.equal(cache.byteSize, entryBytes("kimiExec", "same", association()) +
      entryBytes("snapshot", "same", snapshot) + entryBytes("replay", "same", replay) + entryBytes("adapted", "same", true));
    cache.put("snapshot", "same", { request: {}, input: [] });
    cache.put("replay", "same", { content: [], output: [] });
    assert.equal(cache.size, 4);
    assert.equal(cache.byteSize, entryBytes("kimiExec", "same", association()) +
      entryBytes("snapshot", "same", { request: {}, input: [] }) + entryBytes("replay", "same", { content: [], output: [] }) +
      entryBytes("adapted", "same", true));
  });
});
