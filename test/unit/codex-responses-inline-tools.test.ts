import assert from "node:assert/strict";
import { it } from "node:test";
import { ClaudeCache } from "../../src/claude-cache.js";
import { ReverseState } from "../../src/claude-state.js";
import { decodePortableHistory } from "../../src/routing/portable-history.js";
import { adaptRequest } from "../../src/routing/request-adapter.js";
import type { Item } from "../../src/routing/routing-types.js";

it("preserves Codex Responses inline tools without a role or top-level tools", () => {
  const fn = { type: "function", name: "read", description: "Read", parameters: { type: "object", properties: {} }, strict: true };
  const body: Item = { model: "work", input: [
    { role: "user", content: "before" },
    { type: "additional_tools", tools: [fn] },
    { role: "user", content: "after" },
  ] };
  const stage = new ClaudeCache();
  const { outbound } = adaptRequest({
    profile: {
      provider: "codex", product: "chatgpt-codex", billing: "subscription", account: "fixture",
      credential: { kind: "native-oauth", authFile: "/fabricated/never-read.json" },
    },
    target: { profile: "fixture", model: "gpt-6.2-sol", effort: "high" },
    body, ingress: "responses", protocol: "responses",
    transcript: decodePortableHistory(body, "responses"), stage,
    state: new ReverseState(undefined, undefined, stage), owner: "owner",
    conversation: "conversation", sessionId: "session",
  });
  assert.deepEqual(outbound.input, body.input);
  assert.equal(Object.hasOwn(outbound, "tools"), false);
});
