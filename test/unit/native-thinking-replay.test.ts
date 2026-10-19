import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ClaudeCache } from "../../src/claude-cache.js";
import { ReverseState } from "../../src/claude-state.js";
import { adaptRequest } from "../../src/routing/request-adapter.js";
import { decodePortableHistory } from "../../src/routing/portable-history.js";
import { rememberThinking } from "../../src/routing/signed-thinking.js";
import { StagedCache } from "../../src/routing/replay-cache.js";
import type { AccessProfile, Item, WireProtocol } from "../../src/routing/routing-types.js";

const profile: AccessProfile = {
  provider: "claude", product: "anthropic-api", billing: "api", account: "fabricated",
  credential: { kind: "env", name: "FABRICATED_KEY" },
};
const thinking = { type: "thinking", thinking: "fabricated thought", signature: "fabricated-signature" };

function adapt(options: {
  block?: Item; stage?: ClaudeCache; allow?: boolean; profile?: AccessProfile;
  destination?: WireProtocol; priorOwner?: string; conversation?: string;
} = {}) {
  const body = { model: "work", messages: [
    { role: "assistant", content: [options.block ?? thinking] }, { role: "user", content: "continue" },
  ] };
  return adaptRequest({
    body, profile: options.profile ?? profile,
    target: { profile: "fabricated", model: "claude-sonnet-5", effort: "high" },
    ingress: "messages", protocol: options.destination ?? "messages",
    transcript: decodePortableHistory(body, "messages"),
    stage: options.stage ?? new ClaudeCache(), state: new ReverseState(),
    owner: "original-owner", conversation: options.conversation ?? "original-conversation",
    sessionId: "fabricated", allowNativeThinkingReplay: options.allow ?? true,
    ...(options.priorOwner ? { priorOwner: options.priorOwner } : {}),
  });
}

describe("native thinking import boundary", () => {
  it("requires the dispatcher's authorization and native Claude Messages on both sides", () => {
    assert.throws(() => adapt({ allow: false }), /foreign_opaque_state/);
    assert.throws(() => adapt({ destination: "responses" }), /foreign_opaque_state/);
    assert.throws(() => adapt({ profile: { ...profile, provider: "kimi", product: "kimi-platform", region: "global" } }), /foreign_opaque_state/);
    assert.throws(() => adapt({ priorOwner: "different-owner" }), /foreign_opaque_state/);
    const { outbound } = adapt();
    assert.deepEqual((outbound.messages as Item[])[0]?.content, [thinking]);
    assert.doesNotThrow(() => adapt({ profile: {
      ...profile, product: "claude-code", billing: "subscription",
      credential: { kind: "native-oauth", authFile: "/fabricated/never-read.json" },
    } }));
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
    const stage = new ClaudeCache();
    rememberThinking(stage, "original-owner", "original-conversation", thinking);
    assert.doesNotThrow(() => adapt({ stage }));
    assert.throws(() => adapt({ stage, conversation: "another-conversation" }), /foreign_opaque_state/);
    assert.throws(() => adapt({ stage, block: { ...thinking, thinking: "tampered" } }), /foreign_opaque_state/);
  });

  it("revalidates exclusive ownership before atomically publishing replay state", () => {
    const shared = new ClaudeCache(), stage = new StagedCache(shared);
    stage.reserveSnapshot("claim", { request: { owner: "original" }, input: [] });
    stage.put("snapshot", "scoped-block", { request: {}, input: [thinking] });
    const foreign = { request: { owner: "foreign" }, input: [] };
    shared.put("snapshot", "claim", foreign);
    assert.throws(() => stage.commit(), /foreign_opaque_state/);
    assert.equal(shared.get("snapshot", "scoped-block"), undefined);
    assert.equal(shared.get("snapshot", "claim"), foreign, "rollback cannot delete another scope's claim");
  });

  it("bounds pending claims and releases them without partial publication when the shared budget is full", () => {
    const shared = new ClaudeCache({ maxEntries: 1, maxBytes: 4096 }, true);
    const stage = new StagedCache(shared);
    stage.reserveSnapshot("claim", { request: { owner: "original" }, input: [] });
    assert.equal(shared.size, 1);
    const competing = new StagedCache(shared);
    assert.throws(() => competing.reserveSnapshot("other-claim", { request: {}, input: [] }), /continuation_store_full/);
    competing.discard();
    stage.put("snapshot", "scoped-block", { request: {}, input: [thinking] });
    assert.throws(() => stage.commit(), /continuation_store_full/);
    assert.equal(shared.size, 0);
    assert.equal(shared.byteSize, 0);
    assert.equal(shared.get("snapshot", "scoped-block"), undefined);
    const retry = new StagedCache(shared);
    assert.doesNotThrow(() => retry.reserveSnapshot("claim", { request: { owner: "other" }, input: [] }));
    retry.discard();
    assert.equal(shared.size, 0);
  });
});
