import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ReasoningCache } from "../../src/reasoning-cache.js";

const LARGE_BYTES = 64 * 1024 * 1024;
import { estimateTokens, translateRequest } from "../../src/codex-request.js";
import { deriveConversationKey } from "../../src/conversation-key.js";
import { AnthropicRequestSchema, type AnthropicRequest } from "../../src/anthropic-wire-types.js";

const loadFixture = (name: string): AnthropicRequest => {
  const raw = readFileSync(new URL(`../fixtures/request/${name}`, import.meta.url), "utf8");
  return AnthropicRequestSchema.parse(JSON.parse(raw));
};

describe("translateRequest", () => {
  it("translates a simple text request with fixed codex fields", () => {
    const result = translateRequest(loadFixture("simple-text.json"), new ReasoningCache(4, LARGE_BYTES));
    assert.ok(result.ok);
    const body = result.value.body;
    assert.equal(body["model"], "gpt-5.5");
    assert.equal(body["instructions"], "You are a helpful worker agent.");
    assert.equal(body["stream"], true);
    assert.equal(body["store"], false);
    assert.deepEqual(body["include"], ["reasoning.encrypted_content"]);
    assert.equal(body["parallel_tool_calls"], true);
    assert.equal("max_output_tokens" in body, false, "codex backend rejects max_output_tokens");
    assert.equal("temperature" in body, false);
    assert.equal("metadata" in body, false);
    assert.deepEqual(body["input"], [
      { type: "message", role: "user", content: [{ type: "input_text", text: "List the files in this directory." }] },
    ]);
    assert.equal(result.value.stream, true);
  });

  it("splices cached reasoning items immediately before their function_call", () => {
    const cache = new ReasoningCache(4, LARGE_BYTES);
    const reasoningItems = [{ type: "reasoning", id: "rs_1", summary: [], encrypted_content: "ENCRYPTED_REASONING_BLOB_1" }];
    cache.put("call_abc", reasoningItems);

    const result = translateRequest(loadFixture("tool-roundtrip.json"), cache);
    assert.ok(result.ok);
    const input = result.value.body["input"] as Record<string, unknown>[];

    const reasoningIndex = input.findIndex((item) => item["type"] === "reasoning");
    const callIndex = input.findIndex((item) => item["type"] === "function_call");
    assert.notEqual(reasoningIndex, -1);
    assert.equal(callIndex, reasoningIndex + 1, "reasoning item must sit directly before its function_call");
    assert.equal(input[reasoningIndex]!["encrypted_content"], "ENCRYPTED_REASONING_BLOB_1");
    assert.equal(input[callIndex]!["call_id"], "call_abc");
    assert.equal(input[callIndex]!["name"], "list_files");
    assert.equal(input[callIndex]!["arguments"], JSON.stringify({ path: "." }));

    const output = input.find((item) => item["type"] === "function_call_output");
    assert.ok(output !== undefined);
    assert.equal(output["call_id"], "call_abc");
    assert.equal(output["output"], "a.txt\nb.txt");
    assert.ok(result.value.warnings.includes("image_dropped"));
  });

  it("joins system blocks and translates tools with cache_control stripped", () => {
    const result = translateRequest(loadFixture("tool-roundtrip.json"), new ReasoningCache(4, LARGE_BYTES));
    assert.ok(result.ok);
    assert.equal(result.value.body["instructions"], "You are a helpful worker agent.\n\nFollow instructions exactly.");
    const tools = result.value.body["tools"] as Record<string, unknown>[];
    assert.equal(tools.length, 1);
    assert.equal(tools[0]!["type"], "function");
    assert.equal(tools[0]!["name"], "list_files");
    assert.equal(tools[0]!["strict"], false);
    const parameters = tools[0]!["parameters"] as Record<string, unknown>;
    assert.equal("cache_control" in parameters, false);
    assert.equal(result.value.body["tool_choice"], "auto");
  });

  it("warns on a reasoning cache miss but still emits the function_call", () => {
    const result = translateRequest(loadFixture("tool-roundtrip.json"), new ReasoningCache(4, LARGE_BYTES));
    assert.ok(result.ok);
    const input = result.value.body["input"] as Record<string, unknown>[];
    assert.equal(input.some((item) => item["type"] === "reasoning"), false);
    assert.equal(input.some((item) => item["type"] === "function_call"), true);
    assert.ok(result.value.warnings.includes("reasoning_cache_miss"));
  });

  it("dedupes shared reasoning items across parallel tool calls", () => {
    const cache = new ReasoningCache(4, LARGE_BYTES);
    const shared = [{ type: "reasoning", id: "rs_shared", encrypted_content: "BLOB" }];
    cache.put("call_a", shared);
    cache.put("call_b", shared);
    const request = AnthropicRequestSchema.parse({
      model: "gpt-5.5",
      max_tokens: 100,
      messages: [
        { role: "user", content: "read both files" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "call_a", name: "read_file", input: { path: "a.txt" } },
            { type: "tool_use", id: "call_b", name: "read_file", input: { path: "b.txt" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call_a", content: "A" },
            { type: "tool_result", tool_use_id: "call_b", content: "B" },
          ],
        },
      ],
    });
    const result = translateRequest(request, cache);
    assert.ok(result.ok);
    const input = result.value.body["input"] as Record<string, unknown>[];
    assert.equal(input.filter((item) => item["type"] === "reasoning").length, 1);
    assert.equal(input.filter((item) => item["type"] === "function_call").length, 2);
    assert.equal(input.filter((item) => item["type"] === "function_call_output").length, 2);
  });

  it("maps tool_choice variants", () => {
    const base = {
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "t", input_schema: { type: "object" } }],
    };
    const withChoice = (tool_choice: Record<string, unknown>) =>
      translateRequest(AnthropicRequestSchema.parse({ ...base, tool_choice }), new ReasoningCache(4, LARGE_BYTES));

    const any = withChoice({ type: "any" });
    assert.ok(any.ok);
    assert.equal(any.value.body["tool_choice"], "required");

    const none = withChoice({ type: "none" });
    assert.ok(none.ok);
    assert.equal(none.value.body["tool_choice"], "none");

    const specific = withChoice({ type: "tool", name: "t" });
    assert.ok(specific.ok);
    assert.deepEqual(specific.value.body["tool_choice"], { type: "function", name: "t" });
  });

  it("translates system-role messages in messages[] to developer input messages", () => {
    const request = AnthropicRequestSchema.parse({
      model: "gpt-5.5",
      messages: [
        { role: "system", content: "You are a focused worker agent." },
        { role: "user", content: "hi" },
      ],
    });
    const result = translateRequest(request, new ReasoningCache(4, LARGE_BYTES));
    assert.ok(result.ok);
    const input = result.value.body["input"] as Record<string, unknown>[];
    assert.deepEqual(input[0], {
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: "You are a focused worker agent." }],
    });
    assert.equal(input[1]!["role"], "user");
  });

  it("maps output_config.effort to reasoning.effort", () => {
    // Claude Code sends the agent's `effort` frontmatter as output_config.effort,
    // including for verbatim non-Anthropic model strings (verified live).
    const request = AnthropicRequestSchema.parse({
      model: "gpt-5.6-luna",
      messages: [{ role: "user", content: "hi" }],
      output_config: { effort: "low" },
    });
    const result = translateRequest(request, new ReasoningCache(4, LARGE_BYTES));
    assert.ok(result.ok);
    assert.deepEqual(result.value.body["reasoning"], { effort: "low" });
    assert.equal(result.value.effort, "low");
    assert.deepEqual(result.value.warnings, []);
  });

  it("drops an effort value the codex backend does not accept, with a warning", () => {
    const request = AnthropicRequestSchema.parse({
      model: "gpt-5.6-luna",
      messages: [{ role: "user", content: "hi" }],
      output_config: { effort: "turbo" },
    });
    const result = translateRequest(request, new ReasoningCache(4, LARGE_BYTES));
    assert.ok(result.ok);
    assert.equal("reasoning" in result.value.body, false);
    assert.equal(result.value.effort, undefined);
    assert.deepEqual(result.value.warnings, ["unsupported_effort_dropped"]);
  });

  it("omits reasoning when the request carries no output_config", () => {
    const request = AnthropicRequestSchema.parse({ model: "gpt-5.6-luna", messages: [{ role: "user", content: "hi" }] });
    const result = translateRequest(request, new ReasoningCache(4, LARGE_BYTES));
    assert.ok(result.ok);
    assert.equal("reasoning" in result.value.body, false);
    assert.equal(result.value.effort, undefined);
  });

  it("marks non-streaming requests", () => {
    const request = AnthropicRequestSchema.parse({ model: "gpt-5.5", messages: [{ role: "user", content: "hi" }] });
    const result = translateRequest(request, new ReasoningCache(4, LARGE_BYTES));
    assert.ok(result.ok);
    assert.equal(result.value.stream, false);
    assert.equal(result.value.body["stream"], true, "upstream is always streamed regardless of client mode");
  });
});

describe("prompt_cache_key via conversationKey parameter", () => {
  const baseRequest = AnthropicRequestSchema.parse({
    model: "gpt-5.5",
    messages: [{ role: "user", content: "hello" }],
    system: "You are helpful.",
  });

  it("adds prompt_cache_key to body when a conversation key is provided", () => {
    const key = deriveConversationKey(baseRequest);
    assert.ok(key !== undefined);
    const result = translateRequest(baseRequest, new ReasoningCache(4, LARGE_BYTES), key);
    assert.ok(result.ok);
    assert.equal(result.value.body["prompt_cache_key"], key);
    assert.equal(result.value.conversationKey, key);
  });

  it("produces the same prompt_cache_key for two identical requests", () => {
    const req = AnthropicRequestSchema.parse({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "stable input" }],
    });
    const key = deriveConversationKey(req);
    assert.ok(key !== undefined);
    const r1 = translateRequest(req, new ReasoningCache(4, LARGE_BYTES), key);
    const r2 = translateRequest(req, new ReasoningCache(4, LARGE_BYTES), key);
    assert.ok(r1.ok);
    assert.ok(r2.ok);
    assert.equal(r1.value.body["prompt_cache_key"], r2.value.body["prompt_cache_key"]);
  });

  it("produces different prompt_cache_keys for different first user messages", () => {
    const req1 = AnthropicRequestSchema.parse({ model: "gpt-5.5", messages: [{ role: "user", content: "alpha" }] });
    const req2 = AnthropicRequestSchema.parse({ model: "gpt-5.5", messages: [{ role: "user", content: "beta" }] });
    const key1 = deriveConversationKey(req1)!;
    const key2 = deriveConversationKey(req2)!;
    const r1 = translateRequest(req1, new ReasoningCache(4, LARGE_BYTES), key1);
    const r2 = translateRequest(req2, new ReasoningCache(4, LARGE_BYTES), key2);
    assert.ok(r1.ok);
    assert.ok(r2.ok);
    assert.notEqual(r1.value.body["prompt_cache_key"], r2.value.body["prompt_cache_key"]);
  });

  it("omits prompt_cache_key when no conversation key is provided", () => {
    const req = AnthropicRequestSchema.parse({ model: "gpt-5.5", messages: [{ role: "user", content: "hi" }] });
    const result = translateRequest(req, new ReasoningCache(4, LARGE_BYTES));
    assert.ok(result.ok);
    assert.equal("prompt_cache_key" in result.value.body, false);
    assert.equal(result.value.conversationKey, undefined);
  });
});

describe("estimateTokens", () => {
  it("uses the chars/4 heuristic, rounding up", () => {
    assert.equal(estimateTokens("12345678"), 2);
    assert.equal(estimateTokens("123456789"), 3);
    assert.equal(estimateTokens(Buffer.from("")), 0);
  });
});
