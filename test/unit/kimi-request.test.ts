import assert from "node:assert/strict";
import { it } from "node:test";
import type { AnthropicRequest } from "../../src/anthropic-wire-types.js";
import { buildKimiRequest, type KimiRequestOptions, type KimiThinkingBlock } from "../../src/kimi-request.js";
import { reasoningKey } from "../../src/together-request.js";

const model = "kimi-for-coding";
const conversationKey = "fixture-conversation";
const userTurn = { role: "user", content: "read the file" };
const claudeThinking = { type: "thinking", thinking: "claude thought fixture", signature: "CLAUDE-SIGNATURE-FIXTURE" };
const claudeRedacted = { type: "redacted_thinking", data: "CLAUDE-REDACTED-FIXTURE" };
const toolUse = { type: "tool_use", id: "toolu_kimi_1", name: "Read", input: { path: "a" } };
const toolResult = { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_kimi_1", content: "file text" }] };
const kimiThinking: readonly KimiThinkingBlock[] = [
  { type: "thinking", thinking: "kimi thought fixture", signature: "KIMI-SIGNATURE-FIXTURE" },
  { type: "redacted_thinking", data: "KIMI-REDACTED-FIXTURE" },
];

const build = (fields: Partial<AnthropicRequest>, options: Partial<KimiRequestOptions> = {}) =>
  buildKimiRequest({ model: "kimi:kimi-for-coding", messages: [userTurn], ...fields }, { model, getThinking: () => undefined, ...options });

const blockTypes = (body: ReturnType<typeof build>): string[] => body.messages.flatMap((message) =>
  typeof message.content === "string" ? [] : message.content.map((block) => String(block["type"])));

it("sends the canonical model and always asks Kimi for a stream", () => {
  for (const stream of [true, false, undefined]) {
    const body = build({
      max_tokens: 512, system: "be brief", temperature: 0.2,
      tools: [{ name: "Read", input_schema: { type: "object" } }],
      ...(stream === undefined ? {} : { stream }),
    });
    assert.deepEqual(body, {
      model, max_tokens: 512, system: "be brief", temperature: 0.2,
      tools: [{ name: "Read", input_schema: { type: "object" } }], messages: [userTurn], stream: true,
    });
  }
});

it("does not send the client metadata to Kimi", () => {
  const body = build({ metadata: { user_id: "client-account-fixture" } });
  assert.equal(Object.hasOwn(body, "metadata"), false);
});

it("removes every inbound thinking and redacted_thinking block", () => {
  const body = build({ messages: [
    userTurn,
    { role: "assistant", content: [claudeThinking, claudeRedacted, { type: "text", text: "I will read it" }, toolUse] },
    { role: "user", content: [claudeThinking, ...toolResult.content] },
  ] }, { conversationKey });

  assert.deepEqual(blockTypes(body), ["text", "tool_use", "tool_result"]);
  const sent = JSON.stringify(body);
  for (const secret of ["CLAUDE-SIGNATURE-FIXTURE", "CLAUDE-REDACTED-FIXTURE", "claude thought fixture"]) {
    assert.equal(sent.includes(secret), false, `${secret} must not reach Kimi`);
  }
});

it("drops an assistant turn that holds only thinking", () => {
  const body = build({ messages: [userTurn, { role: "assistant", content: [claudeThinking] }, { role: "user", content: "go on" }] });
  assert.deepEqual(body.messages, [userTurn, { role: "user", content: "go on" }]);
});

it("replays Kimi thinking only from the server cache, before the content of its tool turn", () => {
  const keys: string[] = [];
  const getThinking = (key: string) => {
    keys.push(key);
    return key === reasoningKey(conversationKey, "toolu_kimi_1") ? kimiThinking : undefined;
  };
  const text = { type: "text", text: "I will read it" };
  const body = build({ messages: [
    userTurn,
    { role: "assistant", content: [{ type: "thinking", thinking: "client copy", signature: "CLIENT-SIGNATURE" }, text, toolUse] },
    toolResult,
  ] }, { conversationKey, getThinking });

  assert.deepEqual(keys, [reasoningKey(conversationKey, "toolu_kimi_1")]);
  assert.deepEqual(body.messages[1], { role: "assistant", content: [...kimiThinking, text, toolUse] });
  assert.equal(JSON.stringify(body).includes("CLIENT-SIGNATURE"), false);
});

it("replays no thinking without a conversation key or a cache entry", () => {
  const history = [userTurn, { role: "assistant", content: [claudeThinking, toolUse] }, toolResult];
  let lookups = 0;
  const unkeyed = build({ messages: history }, { getThinking: () => { lookups++; return kimiThinking; } });
  const missed = build({ messages: history }, { conversationKey });

  assert.equal(lookups, 0);
  for (const body of [unkeyed, missed]) assert.deepEqual(blockTypes(body), ["tool_use", "tool_result"]);
});

it("does not change the client request", () => {
  const request: AnthropicRequest = {
    model: "kimi:kimi-for-coding", stream: false, metadata: { user_id: "fixture" },
    messages: [userTurn, { role: "assistant", content: [claudeThinking, toolUse] }],
  };
  const before = structuredClone(request);
  buildKimiRequest(request, { model, conversationKey, getThinking: () => kimiThinking });
  assert.deepEqual(request, before);
});
