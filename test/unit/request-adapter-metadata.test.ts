/** Synthetic request fixtures: no inference or credentials. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ClaudeCache } from "../../src/claude-cache.js";
import { ReverseState } from "../../src/claude-state.js";
import { decodePortableHistory } from "../../src/routing/portable-history.js";
import { adaptRequest } from "../../src/routing/request-adapter.js";
import type {
  AccessProfile,
  Item,
  WireProtocol,
} from "../../src/routing/routing-types.js";

const metadata = Object.freeze({
  user_id: JSON.stringify({
    account_uuid: "synthetic-account",
    session_id: "synthetic-session",
    device_id: "synthetic-device",
  }),
});

const adapt = (
  body: Item,
  ingress: WireProtocol,
  provider: AccessProfile["provider"],
  product: AccessProfile["product"],
  billing: AccessProfile["billing"],
): Item => {
  const stage = new ClaudeCache();
  return adaptRequest({
    profile: {
      provider,
      product,
      billing,
      account: "synthetic",
      credential: { kind: "env", name: "SYNTHETIC_KEY" },
    },
    target: { profile: "synthetic", model: "target-model", effort: "high" },
    body,
    ingress,
    protocol: ingress,
    transcript: decodePortableHistory(body, ingress),
    stage,
    state: new ReverseState(undefined, undefined, stage),
    owner: "synthetic-owner",
    conversation: "synthetic-conversation",
    sessionId: "synthetic-session",
  }).outbound;
};

const messagesBody = () =>
  Object.freeze({
    model: "work",
    messages: [{ role: "user", content: "Read once" }],
    max_tokens: 1024,
    metadata,
  });

const responsesBody = () =>
  Object.freeze({ model: "work", input: "Read once", metadata });

describe("request adapter vendor metadata", () => {
  for (const product of ["kimi-code", "kimi-platform"] as const) {
    it(`omits Messages metadata for ${product} without changing the input`, () => {
      const body = messagesBody();
      const outbound = adapt(
        body,
        "messages",
        "kimi",
        product,
        product === "kimi-code" ? "subscription" : "api",
      );
      assert.equal(Object.hasOwn(outbound, "metadata"), false);
      assert.deepEqual(outbound["messages"], body.messages);
      assert.equal(outbound["max_tokens"], body.max_tokens);
      assert.deepEqual(body.metadata, metadata);
    });
  }

  for (const product of ["claude-code", "anthropic-api"] as const) {
    it(`preserves the Messages body metadata for ${product}`, () => {
      const body = messagesBody();
      const outbound = adapt(
        body,
        "messages",
        "claude",
        product,
        product === "claude-code" ? "subscription" : "api",
      );
      assert.deepEqual(outbound, {
        ...body,
        model: "target-model",
        stream: true,
        output_config: { effort: "high" },
      });
    });
  }

  it("omits Responses metadata for Kimi without changing the input", () => {
    const body = responsesBody();
    const outbound = adapt(
      body,
      "responses",
      "kimi",
      "kimi-code",
      "subscription",
    );
    assert.equal(Object.hasOwn(outbound, "metadata"), false);
    assert.deepEqual(body.metadata, metadata);
  });

  for (const product of ["chatgpt-codex", "openai-api"] as const) {
    it(`preserves Responses metadata for ${product}`, () => {
      const body = responsesBody();
      const outbound = adapt(
        body,
        "responses",
        "codex",
        product,
        product === "chatgpt-codex" ? "subscription" : "api",
      );
      assert.deepEqual(outbound["metadata"], metadata);
    });
  }
});
