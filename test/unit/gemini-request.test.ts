import assert from "node:assert/strict";
import { it } from "node:test";
import type { AnthropicRequest } from "../../src/anthropic-wire-types.js";
import { proxyErrorToAnthropic } from "../../src/errors.js";
import { toGeminiProxyError } from "../../src/gemini-errors.js";
import { buildGeminiRequest, geminiClientToolId, geminiSignatureKey, parseGeminiInput } from "../../src/gemini-request.js";
import { ReasoningCache } from "../../src/reasoning-cache.js";

const call = (id: string, name = "lookup") => ({ type: "tool_use", id, name, input: { query: name } });
const result = (id: string, content: unknown = "done") => ({ type: "tool_result", tool_use_id: id, content });
const text = (value: string) => ({ type: "text", text: value });
const thinking = { type: "thinking", thinking: "foreign thought", signature: "foreign signature" };
const redacted = { type: "redacted_thinking", data: "foreign opaque data" };
const request = (messages: AnthropicRequest["messages"]): AnthropicRequest => ({ model: "fixture-model", messages });
const rig = () => {
  const signatures = new ReasoningCache(2, 200, true);
  const build = (input: AnthropicRequest, conversationKey = "session") =>
    buildGeminiRequest(input, { conversationKey, signatures });
  return { signatures, build };
};

it("removes both kinds of inbound thinking without changing the input", () => {
  const { build } = rig();
  const input = request([
    { role: "user", content: "prompt" },
    { role: "assistant", content: [thinking, redacted] },
    { role: "assistant", content: [thinking, text("answer"), redacted] },
  ]);
  const original = structuredClone(input);
  assert.deepEqual(build(input), { ok: true, value: { request: { contents: [
    { role: "user", parts: [{ text: "prompt" }] },
    { role: "model", parts: [{ text: "answer" }] },
  ] } } });
  assert.deepEqual(input, original);
});

it("pairs parallel results by ID with model role and retains the user's text", () => {
  const { build } = rig();
  const first = geminiClientToolId("call-A", false);
  const second = geminiClientToolId("call-B", false);
  const input = request([
    { role: "assistant", content: [call(first, "lookup"), call(second, "search")] },
    { role: "user", content: [result(second, [text("B"), thinking, redacted]), result(first, "A"), text("next")] },
  ]);
  assert.deepEqual(build(input), { ok: true, value: { request: { contents: [
    { role: "model", parts: [
      { functionCall: { id: "call-A", name: "lookup", args: { query: "lookup" } } },
      { functionCall: { id: "call-B", name: "search", args: { query: "search" } } },
    ] },
    { role: "model", parts: [
      { functionResponse: { id: "call-B", name: "search", response: { output: "B" } } },
      { functionResponse: { id: "call-A", name: "lookup", response: { output: "A" } } },
    ] },
    { role: "user", parts: [{ text: "next" }] },
  ] } } });
});

it("replays a cached signature only in the same call part, including on retry", () => {
  const { signatures, build } = rig();
  const signed = geminiClientToolId("call-signed", true);
  const unsigned = geminiClientToolId("call-unsigned", false);
  signatures.put(geminiSignatureKey("session", "call-signed"), ["fixture /+= signature"]);
  signatures.put(geminiSignatureKey("session", "call-unsigned"), ["not for this part"]);
  const input = request([{ role: "assistant", content: [
    text("wait"), call(signed), { ...call(unsigned), thoughtSignature: "client value", signature: "client value" },
  ] }]);
  const expected = { ok: true, value: { request: { contents: [{ role: "model", parts: [
    { text: "wait" },
    { functionCall: { id: "call-signed", name: "lookup", args: { query: "lookup" } },
      thoughtSignature: "fixture /+= signature" },
    { functionCall: { id: "call-unsigned", name: "lookup", args: { query: "lookup" } } },
  ] }] } } };
  assert.deepEqual(build(input), expected);
  assert.deepEqual(build(input), expected);
});

it("returns a fixed 409 without a body when the call needs a signature that the cache lacks", () => {
  const { signatures, build } = rig();
  const signed = geminiClientToolId("call-needed", true);
  const input = request([
    { role: "assistant", content: [{ ...call(signed), thoughtSignature: "client value" }] },
    { role: "user", content: [result(signed)] },
  ]);
  signatures.put(geminiSignatureKey("other-session", "call-needed"), ["wrong session"]);
  signatures.put(geminiSignatureKey("session", "other-call"), ["wrong call"]);
  const failure = { ok: false, error: "signature_missing" };
  assert.deepEqual(build(input), failure);
  signatures.put(geminiSignatureKey("session", "call-needed"), ["evicted"]);
  signatures.put("another-entry", ["fixture"]);
  signatures.put("newest-entry", ["fixture"]);
  assert.deepEqual(build(input), failure);
  const error = toGeminiProxyError("signature_missing");
  assert.equal(proxyErrorToAnthropic(error).status, 409);
  assert.equal(error.message, "Gemini tool history needs a signature that Subswitch does not have. Start a new conversation.");
});

it("keeps foreign tool history without a signature lookup", () => {
  const { build } = rig();
  const id = "toolu_foreign";
  const input = request([
    { role: "assistant", content: [thinking, call(id)] },
    { role: "user", content: [result(id)] },
  ]);
  assert.deepEqual(build(input), { ok: true, value: { request: { contents: [
    { role: "model", parts: [{ functionCall: { id, name: "lookup", args: { query: "lookup" } } }] },
    { role: "model", parts: [{ functionResponse: { id, name: "lookup", response: { output: "done" } } }] },
  ] } } });
});

it("returns a fixed 400 without a body for direct images and images inside tool results", () => {
  const { build } = rig();
  const image = { type: "image", source: { type: "base64", data: "client value" } };
  const failure = { ok: false, error: "image_unsupported" };
  assert.deepEqual(build(request([{ role: "user", content: [image] }])), failure);
  assert.deepEqual(build({ ...request([]), system: [image] }), failure);
  assert.deepEqual(build(request([{ role: "user", content: [result("missing", [image])] }])), failure);
  assert.deepEqual(build(request([
    { role: "assistant", content: [call("call-A")] },
    { role: "user", content: [result("call-A", [image])] },
  ])), failure);
  const error = toGeminiProxyError("image_unsupported");
  assert.equal(proxyErrorToAnthropic(error).status, 400);
  assert.equal(error.message, "Gemini requests do not support images. Remove the images and retry.");
});

it("uses fixed errors for an unmatched result and an unqualified content block", () => {
  const { build } = rig();
  for (const block of [result("client value"), { type: "document", source: "client value" }]) {
    assert.deepEqual(build(request([{ role: "user", content: [block] }])), { ok: false, error: "invalid_request" });
  }
});

it("refuses duplicate wire call IDs and duplicate results", () => {
  const { build } = rig();
  const encoded = geminiClientToolId("a", false);
  assert.deepEqual(build(request([{ role: "assistant", content: [call("a"), call(encoded)] }])),
    { ok: false, error: "invalid_request" });
  assert.deepEqual(build(request([{ role: "assistant", content: [call(encoded)] },
    { role: "user", content: [result(encoded), result(encoded)] }])), { ok: false, error: "invalid_request" });
});

it("refuses a failed tool result instead of sending it as a success", () => {
  const { build } = rig();
  const withResult = (is_error: unknown) => request([
    { role: "assistant", content: [call("fixture-call")] },
    { role: "user", content: [{ ...result("fixture-call"), is_error }] },
  ]);
  assert.ok(build(withResult(false)).ok);
  for (const flag of [true, "false"]) assert.deepEqual(build(withResult(flag)), { ok: false, error: "invalid_request" });
});

it("bounds request nesting before the codec or conversation key uses it", () => {
  let input: object = {};
  for (let i = 0; i < 128; i++) input = { item: input };
  const message = (value: object) => request([{ role: "assistant", content: [{ ...call("a"), input: value }] }]);
  assert.ok(parseGeminiInput(message({ item: 1 })).ok);
  assert.deepEqual(parseGeminiInput(message(input)), { ok: false, error: "invalid_request" });
});

it("refuses unsupported system content instead of dropping an instruction", () => {
  const { build } = rig();
  for (const block of [{ type: "document" }, { type: "text", text: 1 }]) {
    assert.deepEqual(build({ ...request([]), system: [text("retain this"), block] }), { ok: false, error: "invalid_request" });
  }
});

it("sends only the verified request fields, not client metadata or deferred settings", () => {
  const { build } = rig();
  const input: AnthropicRequest = {
    ...request([{ role: "user", content: "prompt" }]), system: [text("rules"), thinking],
    max_tokens: 20, thinking: { budget_tokens: 10 }, tool_choice: { type: "any" },
    tools: [{ name: "lookup", input_schema: { type: "object" } }],
    model: "fixture-model", sessionId: "fixture-session", requestType: "fixture-type", userAgent: "fixture-agent",
    generationConfig: {}, toolConfig: {}, metadata: { user_id: "fixture-account" },
  };
  assert.deepEqual(build(input), { ok: true, value: { request: {
    contents: [{ role: "user", parts: [{ text: "prompt" }] }],
    systemInstruction: { role: "user", parts: [{ text: "rules" }] },
  } } });
});
