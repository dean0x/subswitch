import assert from "node:assert/strict";
import { it } from "node:test";
import { TOGETHER_DEFAULT_CAPABILITIES } from "../../src/together-models.js";
import type { AnthropicRequest } from "../../src/anthropic-wire-types.js";
import { reasoningKey, translateTogetherRequest, type TogetherRequestOptions } from "../../src/together-request.js";

const model = "org/fixture-model";
const request: AnthropicRequest = { model: "together:fixture", messages: [{ role: "user", content: "hello" }] };

const translate = (fields: Partial<AnthropicRequest> = {}, options: Partial<TogetherRequestOptions> = {}) => {
  const result = translateTogetherRequest({ ...request, ...fields }, { model, ...options });
  assert.ok(result.ok);
  return result.value;
};

it("sends only allowed fields and clamps a large output request", () => {
  const { body, clamp } = translate({
    max_tokens: 10_000_000, context_length_exceeded_behavior: "truncate", n: 50, metadata: { user_id: "not-sent" },
    session_id: "not-sent", prompt_cache_key: "not-sent", stream: true, stream_options: { include_usage: false },
    temperature: 0, top_p: 0.7, stop_sequences: ["done"], stop: ["not-sent"],
  }, { outputCap: 1234 });

  assert.deepEqual(body, {
    model, messages: [{ role: "user", content: "hello" }], max_tokens: 1234, stream: true,
    stream_options: { include_usage: true }, temperature: 0, top_p: 0.7, stop: ["done"],
  });
  assert.deepEqual(clamp, { requested: 10_000_000, applied: 1234 });
});

it("uses the default or configured cap when the client gives no limit", () => {
  const defaults = translate();
  assert.equal(defaults.body.max_tokens, 16_384);
  assert.equal(defaults.clamp, undefined);
  assert.equal(defaults.body.stream, true);
  assert.deepEqual(defaults.body.stream_options, { include_usage: true });
  assert.equal(translate({ stream: false }).body.stream, true);
  assert.equal(translate({}, { outputCap: 32_768 }).body.max_tokens, 32_768);
});

it("uses the lower model cap and returns one clamp record", () => {
  const capabilities = { ...TOGETHER_DEFAULT_CAPABILITIES, maxOutputTokens: 300 };
  const missing = translate({}, { capabilities });
  const lower = translate({ max_tokens: 12 }, { capabilities });
  assert.equal(missing.body.max_tokens, 300);
  assert.deepEqual(missing.clamp, { requested: 16_384, applied: 300 });
  assert.equal(lower.body.max_tokens, 12);
  assert.equal(lower.clamp, undefined);
});

it("converts system instructions and keeps assistant text and calls in one message", () => {
  const { body } = translate({
    system: [{ type: "text", text: "Instructions", cache_control: { type: "ephemeral" } }],
    messages: [
      { role: "system", content: [{ type: "text", text: "Subagent instructions" }] },
      { role: "assistant", content: [
        { type: "text", text: "I will read the file" },
        { type: "tool_use", id: "call_1", name: "Read", input: { path: "sample" }, signature: "not-sent" },
      ] },
    ],
  });

  assert.deepEqual(body.messages, [
    { role: "system", content: "Instructions" },
    { role: "system", content: "Subagent instructions" },
    { role: "assistant", content: "I will read the file", tool_calls: [
      { id: "call_1", type: "function", function: { name: "Read", arguments: '{"path":"sample"}' } },
    ] },
  ]);
});

it("sends tool results in block order before the rest of the user turn", () => {
  const { body, warnings } = translate({ messages: [{ role: "user", content: [
    { type: "text", text: "Reminder" },
    { type: "tool_result", tool_use_id: "call_2", content: "second call finished" },
    { type: "tool_result", tool_use_id: "call_1", is_error: true, content: [
      { type: "text", text: "file missing" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "Zg==" } },
    ] },
  ] }] });

  assert.deepEqual(body.messages, [
    { role: "tool", tool_call_id: "call_2", content: "second call finished" },
    { role: "tool", tool_call_id: "call_1", content: "[Tool error] file missing" },
    { role: "user", content: "Reminder" },
  ]);
  assert.deepEqual(warnings, ["image_dropped"]);
});

it("maps user images to data URIs and drops documents and server tools with warnings", () => {
  const { body, warnings } = translate({
    messages: [{ role: "user", content: [
      { type: "text", text: "Review" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "Zg==" }, cache_control: {} },
      { type: "document", source: { type: "text", data: "not-sent" } },
    ] }],
    tools: [
      { name: "Read", type: "custom", description: "Read a file", input_schema: { type: "object" } },
      { name: "web_search", type: "web_search_20250305", input_schema: { type: "object" } },
    ],
  });

  assert.deepEqual(body.messages, [{ role: "user", content: [
    { type: "text", text: "Review" },
    { type: "image_url", image_url: { url: "data:image/png;base64,Zg==" } },
  ] }]);
  assert.deepEqual(body.tools, [
    { type: "function", function: { name: "Read", description: "Read a file", parameters: { type: "object" } } },
  ]);
  assert.deepEqual(warnings, ["unsupported_block_dropped", "unsupported_tool_skipped"]);
});

it("does not send an image URL or an unsupported image media type", () => {
  const { body, warnings } = translate({ messages: [{ role: "user", content: [
    { type: "text", text: "hello" },
    { type: "image", source: { type: "url", url: "https://fixture.invalid/file.png" } },
    { type: "image", source: { type: "base64", media_type: "text/html", data: "Zg==" } },
  ] }] });
  assert.deepEqual(body.messages, [{ role: "user", content: "hello" }]);
  assert.deepEqual(warnings, ["image_dropped", "image_dropped"]);
});

it("returns a local translation error when model capabilities exclude images", () => {
  const result = translateTogetherRequest({ ...request, messages: [{ role: "user", content: [
    { type: "image", source: { type: "base64", media_type: "image/png", data: "Zg==" } },
  ] }] }, { model, capabilities: { ...TOGETHER_DEFAULT_CAPABILITIES, images: false } });
  assert.deepEqual(result, { ok: false, error: { kind: "translate", message: "Together model does not support images" } });
});

it("rejects incomplete tool calls, unlinked tool results, and unknown roles", () => {
  const cases: readonly [AnthropicRequest["messages"], string][] = [
    [[{ role: "assistant", content: [{ type: "tool_use", id: "call_1" }] }], "Together tool call needs an ID and a name"],
    [[{ role: "user", content: [{ type: "tool_result", content: "done" }] }], "Together tool result needs a tool call ID"],
    [[{ role: "developer", content: "not-sent" }], "Together request has an unsupported message role"],
  ];
  for (const [messages, message] of cases) {
    assert.deepEqual(translateTogetherRequest({ ...request, messages }, { model }), {
      ok: false, error: { kind: "translate", message },
    });
  }
});

it("refuses tool input that cannot form a JSON object", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic["child"] = cyclic;
  for (const input of [null, [], "text", cyclic]) {
    const content = [{ type: "tool_use", id: "call_1", name: "Read", input }];
    assert.deepEqual(translateTogetherRequest({ ...request, messages: [{ role: "assistant", content }] }, { model }), {
      ok: false, error: { kind: "translate", message: "Together tool input must be a JSON object" },
    });
  }
});

it("omits an unknown tool choice with a warning", () => {
  const { body, warnings } = translate({ tool_choice: { type: "unconfirmed" } });
  assert.equal(Object.hasOwn(body, "tool_choice"), false);
  assert.deepEqual(warnings, ["unknown_tool_choice"]);
});

it("maps each tool choice without a parallel tool flag", () => {
  for (const [type, expected] of [
    ["auto", "auto"], ["any", "required"], ["none", "none"],
    ["tool", { type: "function", function: { name: "Read" } }],
  ] as const) {
    const { body } = translate({ tool_choice: { type, name: "Read", disable_parallel_tool_use: true } });
    assert.deepEqual(body.tool_choice, expected);
    assert.equal(Object.hasOwn(body, "parallel_tool_calls"), false);
  }
});

it("drops history thinking and signatures and warns about the top-level thinking field", () => {
  const { body, warnings } = translate({
    thinking: { type: "enabled", budget_tokens: 1024 },
    messages: [{ role: "assistant", signature: "not-sent", content: [
      { type: "thinking", thinking: "not-sent", signature: "not-sent" },
      { type: "redacted_thinking", data: "not-sent" },
      { type: "text", text: "Answer", signature: "not-sent" },
    ] }],
  });
  assert.deepEqual(body, { model, messages: [{ role: "assistant", content: "Answer" }], max_tokens: 16_384,
    stream: true, stream_options: { include_usage: true } });
  assert.deepEqual(warnings, ["thinking_dropped"]);
});

const continuation: AnthropicRequest["messages"] = [{ role: "assistant", content: [
  { type: "tool_use", id: "call_1", name: "Read" }, { type: "tool_use", id: "call_2", name: "Read" },
] }];

it("replays exact cached reasoning only under the first tool ID of the assistant turn", (t) => {
  const getReasoning = t.mock.fn((_key: string) => "  prior reasoning\n");
  const { body } = translate({ messages: continuation }, { conversationKey: "fixture-session", getReasoning });
  assert.deepEqual(getReasoning.mock.calls.map(({ arguments: args }) => args), [["fixture-session|call_1"]]);
  assert.deepEqual(body.messages, [{ role: "assistant", content: null, reasoning_content: "  prior reasoning\n", tool_calls: [
    { id: "call_1", type: "function", function: { name: "Read", arguments: "{}" } },
    { id: "call_2", type: "function", function: { name: "Read", arguments: "{}" } },
  ] }]);
  assert.equal(reasoningKey("fixture-session", "call_1"), "fixture-session|call_1");
  assert.ok(!JSON.stringify(body).includes("fixture-session"));
});

it("omits reasoning when the key is absent, replay is disabled, or the cache misses", (t) => {
  const getReasoning = t.mock.fn((_key: string) => undefined);
  const input = { messages: continuation };
  const disabled = { ...TOGETHER_DEFAULT_CAPABILITIES, reasoningReplay: false };
  for (const options of [{}, { conversationKey: "fixture-session", capabilities: disabled }]) {
    assert.ok(!Object.hasOwn(translate(input, { ...options, getReasoning }).body.messages[0] ?? {}, "reasoning_content"));
  }
  assert.equal(getReasoning.mock.callCount(), 0);
  const miss = translate(input, { conversationKey: "fixture-session", getReasoning });
  assert.equal(getReasoning.mock.callCount(), 1);
  assert.ok(!Object.hasOwn(miss.body.messages[0] ?? {}, "reasoning_content"));
});
