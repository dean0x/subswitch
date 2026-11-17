/** Synthetic request fixtures: no inference or credentials. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ClaudeCache } from "../../src/claude-cache.js";
import { ReverseState } from "../../src/claude-state.js";
import { decodePortableHistory } from "../../src/routing/portable-history.js";
import { adaptRequest } from "../../src/routing/request-adapter.js";
import type { Item, WireProtocol } from "../../src/routing/routing-types.js";

const metadata = Object.freeze({
  user_id: JSON.stringify({ account_uuid: "synthetic-account", session_id: "synthetic-session", device_id: "synthetic-device" }),
});
const adapt = (body: Item, ingress: WireProtocol, provider: "claude" | "codex"): Item => {
  const stage = new ClaudeCache();
  return adaptRequest({
    profile: {
      provider, product: provider === "claude" ? "claude-code" : "chatgpt-codex",
      billing: "subscription", account: "synthetic",
      credential: { kind: "native-oauth", authFile: "/synthetic/never-read.json" },
    },
    target: { profile: "synthetic", model: provider === "claude" ? "claude-sonnet-5-5" : "gpt-6-sol", effort: "high" },
    body, ingress, protocol: provider === "claude" ? "messages" : "responses",
    transcript: decodePortableHistory(body, ingress), stage,
    state: new ReverseState(undefined, undefined, stage),
    owner: "synthetic-owner", conversation: "synthetic-conversation", sessionId: "synthetic-session",
  }).outbound;
};
const messagesBody = () => Object.freeze({
  model: "work", messages: [{ role: "user", content: "Read once" }], max_tokens: 1024, metadata,
});
const responsesBody = () => Object.freeze({ model: "work", input: "Read once", metadata });

describe("request adapter vendor metadata", () => {
  it("omits Claude metadata on the Codex subscription route without changing input", () => {
    const body = messagesBody();
    assert.equal(Object.hasOwn(adapt(body, "messages", "codex"), "metadata"), false);
    assert.deepEqual(body.metadata, metadata);
  });
  it("preserves Messages metadata for the Claude subscription", () => {
    const body = messagesBody();
    assert.deepEqual(adapt(body, "messages", "claude"), {
      ...body, model: "claude-sonnet-5-5", stream: true, output_config: { effort: "high" },
    });
  });
  it("omits Codex metadata on the Claude subscription route without changing input", () => {
    const body = responsesBody();
    assert.equal(Object.hasOwn(adapt(body, "responses", "claude"), "metadata"), false);
    assert.deepEqual(body.metadata, metadata);
  });
  it("preserves Responses metadata for the Codex subscription", () => {
    assert.deepEqual(adapt(responsesBody(), "responses", "codex")["metadata"], metadata);
  });
});
