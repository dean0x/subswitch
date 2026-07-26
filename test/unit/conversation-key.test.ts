import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deriveConversationKey } from "../../src/conversation-key.js";
import { AnthropicRequestSchema } from "../../src/anthropic-wire-types.js";

const makeRequest = (overrides: Record<string, unknown>) =>
  AnthropicRequestSchema.parse({
    model: "gpt-5.5",
    messages: [{ role: "user", content: "hello" }],
    ...overrides,
  });

describe("deriveConversationKey", () => {
  it("returns the same key for the same request twice", () => {
    const req = makeRequest({});
    const k1 = deriveConversationKey(req);
    const k2 = deriveConversationKey(req);
    assert.ok(k1 !== undefined);
    assert.equal(k1, k2);
  });

  it("returns different keys for different first user messages", () => {
    const k1 = deriveConversationKey(makeRequest({ messages: [{ role: "user", content: "hello" }] }));
    const k2 = deriveConversationKey(makeRequest({ messages: [{ role: "user", content: "goodbye" }] }));
    assert.ok(k1 !== undefined);
    assert.ok(k2 !== undefined);
    assert.notEqual(k1, k2);
  });

  it("returns different keys for different models", () => {
    const k1 = deriveConversationKey(makeRequest({ model: "gpt-5.5" }));
    const k2 = deriveConversationKey(makeRequest({ model: "gpt-5.6-sol" }));
    assert.ok(k1 !== undefined);
    assert.ok(k2 !== undefined);
    assert.notEqual(k1, k2);
  });

  it("returns undefined when there is no user message", () => {
    const req = AnthropicRequestSchema.parse({
      model: "gpt-5.5",
      messages: [{ role: "assistant", content: "hi" }],
    });
    assert.equal(deriveConversationKey(req), undefined);
  });

  it("returns a v7-shaped UUID (version nibble 7, RFC 4122 variant)", () => {
    const key = deriveConversationKey(makeRequest({}));
    assert.ok(key !== undefined);
    // UUID format: xxxxxxxx-xxxx-7xxx-Xxxx-xxxxxxxxxxxx
    // Position 14 must be '7' (version nibble); position 19 must be in [89ab] (variant 10xx).
    assert.match(key, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("does not throw on oversized components (16 KB cap enforced)", () => {
    const bigString = "x".repeat(200_000);
    const req = makeRequest({
      model: bigString,
      system: bigString,
      messages: [{ role: "user", content: bigString }],
    });
    assert.doesNotThrow(() => deriveConversationKey(req));
    const key = deriveConversationKey(req);
    assert.ok(key !== undefined);
    assert.match(key, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("pins the key value for a known input (algorithm stability guard)", () => {
    // The key drives BOTH prompt_cache_key and session_id. Any change to the
    // derivation algorithm would silently destroy the 76% prompt-cache hit rate
    // and break backend session correlation. This test will fail immediately
    // if the hash input, UUID encoding, or capBytes logic is inadvertently changed.
    //
    // Input:  model="gpt-5.5", no system, first user message={role:"user",content:"hello"}
    // Formula: sha256("gpt-5.5" + " " + "" + " " + '{"role":"user","content":"hello"}')
    //          → first 16 bytes → UUID v7 encoding (version nibble=7, variant=10xx)
    const req = AnthropicRequestSchema.parse({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hello" }],
    });
    assert.equal(deriveConversationKey(req), "5002ec0c-e01d-789b-8070-b44a7563fae2");
  });

  it("uses the first user message even when earlier messages exist", () => {
    const req1 = AnthropicRequestSchema.parse({
      model: "gpt-5.5",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "turn1" },
        { role: "assistant", content: "reply" },
        { role: "user", content: "turn2" },
      ],
    });
    const req2 = AnthropicRequestSchema.parse({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "turn1" }],
    });
    // Same first user message => same key
    assert.equal(deriveConversationKey(req1), deriveConversationKey(req2));
  });
});
