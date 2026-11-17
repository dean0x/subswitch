import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ClaudeCache } from "../../src/claude-cache.js";
import { ReverseState } from "../../src/claude-state.js";
import { adaptRequest } from "../../src/routing/request-adapter.js";
import { validatesNativeThinking } from "../../src/routing/destination-catalog.js";
import { decodePortableHistory } from "../../src/routing/portable-history.js";
import { foreignThinking, observeThinking, rememberThinking } from "../../src/routing/signed-thinking.js";
import { StagedCache } from "../../src/routing/replay-cache.js";
import { RoutingError, type AccessProfile, type Item, type WireProtocol } from "../../src/routing/routing-types.js";

const profile: AccessProfile = {
  provider: "claude", product: "claude-code", billing: "subscription", account: "fabricated",
  credential: { kind: "native-oauth", authFile: "/fabricated/never-read.json" },
};
const thinking = { type: "thinking", thinking: "fabricated thought", signature: "fabricated-signature" };

function adapt(options: {
  block?: Item; blocks?: Item[]; stage?: ClaudeCache; allow?: boolean; profile?: AccessProfile;
  destination?: WireProtocol; priorOwner?: string; conversation?: string;
} = {}) {
  const body = { model: "work", messages: [
    { role: "assistant", content: options.blocks ?? [options.block ?? thinking] }, { role: "user", content: "continue" },
  ] };
  return adaptRequest({
    body, profile: options.profile ?? profile,
    target: { profile: "fabricated", model: "claude-sonnet-5", effort: "high" },
    ingress: "messages", protocol: options.destination ?? "messages",
    transcript: decodePortableHistory(body, "messages"),
    stage: options.stage ?? new StagedCache(new ClaudeCache()), state: new ReverseState(),
    owner: "original-owner", conversation: options.conversation ?? "original-conversation",
    sessionId: "fabricated", allowNativeThinkingReplay: options.allow ?? true,
    ...(options.priorOwner ? { priorOwner: options.priorOwner } : {}),
  });
}

describe("native thinking import boundary", () => {
  it("requires the dispatcher's authorization and native Claude Messages on both sides", () => {
    assert.throws(() => adapt({ allow: false }), /foreign_opaque_state/);
    assert.throws(() => adapt({ destination: "responses" }), /foreign_opaque_state/);
    assert.throws(() => adapt({ profile: { ...profile, provider: "kimi", product: "kimi-code", region: "global" } }), /foreign_opaque_state/);
    assert.throws(() => adapt({ priorOwner: "different-owner" }), /foreign_opaque_state/);
    const { outbound } = adapt();
    assert.deepEqual((outbound.messages as Item[])[0]?.content, [thinking]);
  });

  it("refuses cold imports at a custom origin, path, port or scheme", () => {
    for (const baseUrl of [
      "https://gateway.example", "https://api.anthropic.com/gateway",
      "https://api.anthropic.com:8443", "http://api.anthropic.com",
    ]) assert.throws(() => adapt({ profile: { ...profile, baseUrl } }), /foreign_opaque_state/);
    assert.doesNotThrow(() => adapt({ profile: { ...profile, baseUrl: "https://api.anthropic.com/" } }));
  });

  it("keeps exact same-scope Kimi replay without a native ownership claim or cross-scope import", () => {
    // Exercise destination rules directly. This stack cannot load a Kimi sign-in profile.
    const kimi: AccessProfile = { ...profile, provider: "kimi", product: "kimi-code", region: "global" };
    const shared = new ClaudeCache(), stage = new StagedCache(shared);
    observeThinking(stage, "original-owner", "original-conversation", thinking, validatesNativeThinking(kimi));
    rememberThinking(stage, "original-owner", "original-conversation", thinking, validatesNativeThinking(kimi));
    stage.commit();
    assert.equal(foreignThinking(shared, thinking.signature, "original-owner", "original-conversation"), true);
    assert.deepEqual((adapt({ profile: kimi, stage: new StagedCache(shared), allow: false }).outbound.messages as Item[])[0]?.content,
      [thinking]);
    for (const destination of [kimi, profile]) {
      assert.throws(() => adapt({ profile: destination, stage: new StagedCache(shared), conversation: "another-conversation" }),
        (error: unknown) => error instanceof RoutingError && error.code === "foreign_opaque_state" && error.status === 409);
    }
    assert.throws(() => adapt({ profile: kimi, stage: new StagedCache(shared), block: { ...thinking, thinking: "tampered" } }),
      (error: unknown) => error instanceof RoutingError && error.code === "foreign_opaque_state" && error.status === 409);
  });

  it("does not mistake malformed native blocks for cache misses that can be imported", () => {
    for (const block of [
      { ...thinking, signature: "" }, { ...thinking, signature: undefined },
      { ...thinking, thinking: undefined }, { ...thinking, data: "extra" },
      { type: "redacted_thinking", data: "" },
      { type: "redacted_thinking", data: "fabricated-redacted", thinking: "extra" },
      { type: "redacted_thinking", data: "fabricated-redacted", signature: "extra" },
    ]) assert.throws(() => adapt({ block }), /foreign_opaque_state/);
  });

  it("preserves known conversation ownership while accepting a recorded exact replay", () => {
    const stage = new StagedCache(new ClaudeCache());
    rememberThinking(stage, "original-owner", "original-conversation", thinking);
    assert.doesNotThrow(() => adapt({ stage }));
    assert.throws(() => adapt({ stage, conversation: "another-conversation" }), /foreign_opaque_state/);
    assert.throws(() => adapt({ stage, block: { ...thinking, thinking: "tampered" } }), /foreign_opaque_state/);
  });

  it("keeps 1025 emitted native signatures in 1025 shared entries", () => {
    const shared = new ClaudeCache({ maxEntries: 2048, maxBytes: 32 * 1024 * 1024 });
    for (let index = 0; index < 1025; index++) {
      const stage = new StagedCache(shared);
      const block = { ...thinking, signature: `emitted-${index}` };
      observeThinking(stage, "original-owner", "original-conversation", block);
      rememberThinking(stage, "original-owner", "original-conversation", block);
      stage.commit();
    }
    assert.equal(shared.size, 1025);
    assert.doesNotThrow(() => adapt({ stage: new StagedCache(shared),
      block: { ...thinking, signature: "emitted-0" }, allow: false }));
  });

  it("imports 2048 native signatures in the existing replay partition", () => {
    const shared = new ClaudeCache({ maxEntries: 2048, maxBytes: 32 * 1024 * 1024 });
    const stage = new StagedCache(shared);
    const blocks = Array.from({ length: 2048 }, (_, index) => ({ ...thinking, signature: `import-${index}` }));
    assert.doesNotThrow(() => adapt({ stage, blocks }));
    stage.preflight();
    stage.commit();
    assert.equal(shared.size, 2048);
    assert.doesNotThrow(() => adapt({ stage: new StagedCache(shared), blocks, allow: false }));
  });

  for (const bound of ["entries", "bytes"] as const) {
    it(`checks the complete import ${bound} budget before any shared write`, () => {
      const shared = new ClaudeCache({ maxEntries: bound === "entries" ? 2 : 2048,
        maxBytes: bound === "bytes" ? 1024 : 32 * 1024 * 1024 });
      shared.put("adapted", "prior", true);
      const bytes = shared.byteSize;
      const stage = new StagedCache(shared);
      const blocks = Array.from({ length: 3 }, (_, index) => ({ ...thinking,
        signature: `import-${index}`, thinking: bound === "bytes" ? "x".repeat(512) : "thought" }));
      assert.doesNotThrow(() => adapt({ stage, blocks }));
      assert.equal(shared.size, 1, "imports must stay local until budget preflight");
      assert.equal(shared.byteSize, bytes);
      assert.throws(() => stage.preflight(), (error: unknown) => error instanceof RoutingError &&
        error.code === "continuation_store_full" && error.status === 503);
      stage.dispose();
      assert.equal(shared.size, 1);
      assert.equal(shared.byteSize, bytes);
      assert.equal(shared.get("adapted", "prior"), true);
    });
  }

  it("rejects a non-staged import without an ownership write", () => {
    const shared = new ClaudeCache();
    assert.throws(() => {
      // @ts-expect-error Client imports require an attempt-local stage.
      rememberThinking(shared, "original-owner", "original-conversation", thinking);
    }, (error: unknown) => error instanceof RoutingError && error.code === "invalid_replay_stage");
    assert.equal(shared.size, 0);
    assert.equal(shared.byteSize, 0);
  });

  it("maps a full local import partition to 503 without shared residue", () => {
    const shared = new ClaudeCache(), stage = new StagedCache(shared);
    const blocks = Array.from({ length: 2049 }, (_, index) => ({ ...thinking, signature: `import-${index}` }));
    assert.throws(() => adapt({ stage, blocks }), (error: unknown) => error instanceof RoutingError &&
      error.code === "continuation_store_full" && error.status === 503);
    stage.dispose();
    assert.equal(shared.size, 0);
    assert.equal(shared.byteSize, 0);
  });

  it("gives unvalidated emitted signatures no native ownership claim", () => {
    const shared = new ClaudeCache(), stage = new StagedCache(shared);
    observeThinking(stage, "original-owner", "original-conversation", thinking, false);
    stage.dispose();
    assert.equal(foreignThinking(shared, thinking.signature, "original-owner", "original-conversation"), true);
    assert.throws(() => adapt({ stage: new StagedCache(shared) }), /foreign_opaque_state/);
  });

  it("revalidates exclusive ownership before atomically publishing replay state", () => {
    const shared = new ClaudeCache(), stage = new StagedCache(shared);
    stage.reserveSnapshot("claim", { request: { owner: "original" }, input: [] });
    stage.put("snapshot", "scoped-block", { request: {}, input: [thinking] });
    const foreign = { request: { owner: "foreign" }, input: [] };
    shared.put("snapshot", "claim", foreign);
    assert.throws(() => stage.commit(), /foreign_opaque_state/);
    stage.dispose();
    assert.equal(shared.get("snapshot", "scoped-block"), undefined);
    assert.equal(shared.get("snapshot", "claim"), foreign, "rollback cannot delete another scope's claim");
  });

  it("rejects writes after disposal before checking another stage's claim", () => {
    const shared = new ClaudeCache(), stage = new StagedCache(shared);
    const value = { request: { owner: "original" }, input: [] };
    stage.reserveSnapshot("claim", value);
    stage.dispose();
    assert.equal(shared.size, 0);
    const foreign = { request: { owner: "foreign" }, input: [] };
    shared.put("snapshot", "claim", foreign);
    assert.throws(() => stage.reserveSnapshot("claim", value), /invalid_codec_publication/);
    assert.throws(() => stage.put("snapshot", "late", value), /invalid_codec_publication/);
    assert.throws(() => stage.putBatch([{ kind: "snapshot", id: "late", value }]), /invalid_codec_publication/);
    assert.equal(shared.get("snapshot", "claim"), foreign);
    assert.equal(shared.size, 1);
  });

  it("bounds pending claims and releases them without partial publication when the shared budget is full", () => {
    const shared = new ClaudeCache({ maxEntries: 1, maxBytes: 4096 }, true);
    const stage = new StagedCache(shared);
    stage.reserveSnapshot("claim", { request: { owner: "original" }, input: [] });
    stage.preflight();
    assert.equal(shared.size, 1);
    const competing = new StagedCache(shared);
    competing.reserveSnapshot("other-claim", { request: {}, input: [] });
    assert.throws(() => competing.preflight(), /continuation_store_full/);
    competing.dispose();
    stage.put("snapshot", "scoped-block", { request: {}, input: [thinking] });
    assert.throws(() => stage.commit(), /continuation_store_full/);
    assert.equal(shared.size, 1, "a failed commit keeps its claim until caller disposal");
    stage.dispose();
    assert.equal(shared.size, 0);
    assert.equal(shared.byteSize, 0);
    assert.equal(shared.get("snapshot", "scoped-block"), undefined);
    const retry = new StagedCache(shared);
    assert.doesNotThrow(() => retry.reserveSnapshot("claim", { request: { owner: "other" }, input: [] }));
    retry.dispose();
    assert.equal(shared.size, 0);
  });
});
