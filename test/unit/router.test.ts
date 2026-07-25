import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decideRoute } from "../../src/router.js";
import { ALL_MODEL_IDS } from "../../src/models.js";

// Derive from the canonical registry rather than re-hardcoding literals.
// Re-hardcoding recreates the exact maintenance tax this feature removes.
const CODEX_MODELS = [...ALL_MODEL_IDS];

describe("decideRoute", () => {
  it("routes exact codex model matches on /v1/messages", () => {
    assert.deepEqual(decideRoute("POST", "/v1/messages?beta=true", "gpt-5.5", CODEX_MODELS), {
      kind: "codex",
      endpoint: "messages",
    });
    assert.deepEqual(decideRoute("POST", "/v1/messages", "gpt-5.6-terra", CODEX_MODELS), {
      kind: "codex",
      endpoint: "messages",
    });
  });

  it("routes count_tokens for codex models", () => {
    assert.deepEqual(decideRoute("POST", "/v1/messages/count_tokens", "gpt-5.5", CODEX_MODELS), {
      kind: "codex",
      endpoint: "count_tokens",
    });
  });

  it("sends claude models to anthropic", () => {
    assert.deepEqual(decideRoute("POST", "/v1/messages?beta=true", "claude-sonnet-4-6", CODEX_MODELS), { kind: "anthropic" });
  });

  it("sends near-miss model names to anthropic (exact match only)", () => {
    assert.deepEqual(decideRoute("POST", "/v1/messages", "gpt-5.5-turbo", CODEX_MODELS), { kind: "anthropic" });
    assert.deepEqual(decideRoute("POST", "/v1/messages", "gpt-5.6", CODEX_MODELS), { kind: "anthropic" });
  });

  it("sends missing models, other methods, and other paths to anthropic", () => {
    assert.deepEqual(decideRoute("POST", "/v1/messages", undefined, CODEX_MODELS), { kind: "anthropic" });
    assert.deepEqual(decideRoute("GET", "/v1/messages", "gpt-5.5", CODEX_MODELS), { kind: "anthropic" });
    assert.deepEqual(decideRoute("POST", "/v1/complete", "gpt-5.5", CODEX_MODELS), { kind: "anthropic" });
  });

  // This test pins the architectural layering (ADR-005):
  // decideRoute does exact-membership checks only. Family aliases ('sol', 'terra',
  // 'luna') must be resolved to canonical ids BEFORE decideRoute is called.
  // The resolver lives in Phase B (server.ts); decideRoute stays dumb.
  it("family aliases ('sol', 'terra', 'luna') are not routed to Codex — resolution must happen before routing", () => {
    assert.deepEqual(decideRoute("POST", "/v1/messages", "sol", CODEX_MODELS), { kind: "anthropic" });
    assert.deepEqual(decideRoute("POST", "/v1/messages", "terra", CODEX_MODELS), { kind: "anthropic" });
    assert.deepEqual(decideRoute("POST", "/v1/messages", "luna", CODEX_MODELS), { kind: "anthropic" });
  });
});
