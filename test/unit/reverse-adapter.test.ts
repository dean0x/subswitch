import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { reverseRequest, reverseResponse, reverseEvents, ReverseContractError } from "../../src/claude-adapter.js";
import { ReverseState, replayIdentity } from "../../src/claude-state.js";

const code = { type: "custom", name: "exec", description: "Execute JavaScript with the native tools object.", format: { type: "text" } };
const tool = { type: "function", name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } };
const request = () => ({ model: "claude-sonnet-5", instructions: "Keep all instructions.",
  input: [{ type: "additional_tools", tools: [{ type: "namespace", name: "functions", tools: [code, tool] }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: "Read the fixture." }] }],
});
const rejects = (fn: () => unknown, code: string) => assert.throws(fn, error => error instanceof ReverseContractError && error.code === code);

describe("experimental reverse native contract", () => {
  it("restores freeform namespace/type/input and replays its result without rewriting text", () => {
    const original = request(); const snapshot = structuredClone(original);
    const translated = reverseRequest(original);
    assert.deepEqual(original, snapshot);
    const mapping = [...translated.tools.values()].find(tool => tool.type === "custom")!;
    const input = 'const r = await tools.exec_command({cmd:"cat check.txt"}); text(r);';
    const output = reverseResponse({ type: "message", stop_reason: "tool_use", content: [
      { type: "tool_use", id: "toolu_test", name: mapping.wire, input: { input } },
    ] }, translated);
    assert.equal(output[0]?.["type"], "custom_tool_call");
    assert.equal(output[0]?.["namespace"], "functions");
    assert.equal(output[0]?.["name"], "exec");
    assert.equal(output[0]?.["input"], input);
    const continued = reverseRequest({ ...original, input: [...original.input, ...output,
      { type: "custom_tool_call_output", call_id: "toolu_test", output: [{ type: "input_text", text: "unpredictable-result" }] }] });
    assert.deepEqual((continued.body["messages"] as Record<string, unknown>[]).at(-1), { role: "user", content: [
      { type: "tool_result", tool_use_id: "toolu_test", content: [{ type: "text", text: "unpredictable-result" }] },
    ] });
  });

  it("maps identical local tool names in different namespaces to distinct stable names", () => {
    const translated = reverseRequest({ ...request(), tools: [
      { type: "namespace", name: "other", tools: [code] },
    ] });
    const tools = [...translated.tools.values()].filter(tool => tool.name === "exec");
    assert.equal(tools.length, 2); assert.notEqual(tools[0]?.wire, tools[1]?.wire);
    assert.equal(tools[1]?.wire, [...reverseRequest(request()).tools.values()][0]?.wire);
  });

  it("does not convert invalid or truncated output into executable native calls", () => {
    const translated = reverseRequest(request());
    const mapping = [...translated.tools.values()][0]!;
    rejects(() => reverseResponse({ type: "message", stop_reason: "max_tokens", content: [
      { type: "tool_use", id: "toolu_test", name: mapping.wire, input: { input: "unfinished(" } },
    ] }, translated), "incomplete_claude_response");
    rejects(() => reverseResponse({ type: "message", stop_reason: "tool_use", content: [
      { type: "tool_use", id: "toolu_test", name: "unknown", input: {} },
    ] }, translated), "unknown_claude_tool");
    rejects(() => reverseResponse({ type: "message", stop_reason: "tool_use", content: [
      { type: "tool_use", id: "toolu_test", name: mapping.wire, input: { input: "text", ignored: true } },
    ] }, translated), "invalid_custom_tool_input");
  });

  it("rejects opaque state, encrypted calls, and orphaned results explicitly", () => {
    const base = request();
    rejects(() => reverseRequest({ ...base, input: [...base.input, { type: "reasoning", encrypted_content: "opaque" }] }), "opaque_state_unimplemented");
    rejects(() => reverseRequest({ ...base, input: [...base.input, { type: "function_call_output", call_id: "missing", output: "result" }] }), "unmatched_tool_result");
    rejects(() => reverseRequest({ ...base, input: [...base.input, { type: "function_call", namespace: "functions", name: "read", call_id: "call", arguments: "{}", encrypted_function_args: ["path"] }] }), "encrypted_tool_arguments");
  });

  it("preserves image-bearing tool results and rejects unrepresentable blocks", () => {
    const base = request();
    const continued = reverseRequest({ ...base, input: [...base.input,
      { type: "function_call", namespace: "functions", name: "read", call_id: "call", arguments: '{"path":"image.png"}' },
      { type: "function_call_output", call_id: "call", output: [{ type: "input_image", image_url: "data:image/png;base64,AAAA" }] },
    ] });
    assert.match(JSON.stringify(continued.body), /"media_type":"image\/png","data":"AAAA"/);
    rejects(() => reverseRequest({ ...base, input: [{ type: "message", role: "user", content: [{ type: "input_audio", data: "opaque" }] }] }), "unsupported_content_block");
  });

  it("emits matched custom-call events and terminal output with stable identities", () => {
    const output = [{ type: "custom_tool_call", id: "fc_test", call_id: "call_test", namespace: "functions", name: "exec", input: "text(1)", status: "completed" }];
    const events = reverseEvents("resp_test", "claude-sonnet-5", output);
    assert.equal(events.find(event => event["type"] === "response.custom_tool_call_input.delta")?.["item_id"], "fc_test");
    assert.deepEqual(events.find(event => event["type"] === "response.output_item.done")?.["item"], output[0]);
    assert.equal(events.at(-1)?.["type"], "response.completed");
    assert.deepEqual(events.map(event => event["sequence_number"]), events.map((_, index) => index));
    assert.deepEqual((events.at(-1)?.["response"] as Record<string, unknown>)["usage"], {
      input_tokens: 0, output_tokens: 0, total_tokens: 0, input_tokens_details: { cached_tokens: 0 },
    });
    const cached = reverseEvents("resp_cached", "claude-sonnet-5", [], { input_tokens: 10, output_tokens: 5,
      cache_creation_input_tokens: 20, cache_read_input_tokens: 30 });
    assert.deepEqual((cached.at(-1)?.["response"] as Record<string, unknown>)["usage"], {
      input_tokens: 60, output_tokens: 5, total_tokens: 65, input_tokens_details: { cached_tokens: 30 },
    });
  });

  it("preserves signed thinking verbatim through encrypted state and a fresh codec instance", () => {
    const key = Buffer.alloc(32, 9), writer = new ReverseState(key), reader = new ReverseState(key);
    const base = request(), translated = reverseRequest(base);
    const tool = [...translated.tools.values()][0]!;
    const original = [
      { type: "thinking", thinking: "private fixture thinking", signature: "fixture-signed-state" },
      { type: "redacted_thinking", data: "fixture-redacted-state" },
      { type: "tool_use", id: "toolu_thinking", name: tool.wire, input: { input: "text(1)" } },
    ];
    const output = reverseResponse({ type: "message", stop_reason: "tool_use", content: original }, translated, writer);
    assert.equal(output[0]?.["type"], "reasoning");
    assert.ok(!JSON.stringify(output).includes("fixture-signed-state"));
    const continued = reverseRequest({ ...base, input: [...base.input, ...output,
      { type: "custom_tool_call_output", call_id: "toolu_thinking", output: "1" }] }, [], reader);
    const assistant = (continued.body["messages"] as Record<string, unknown>[]).find(message => message["role"] === "assistant");
    assert.deepEqual(assistant?.["content"], original);
    rejects(() => reverseRequest({ ...base, input: [...base.input, ...output,
      { type: "custom_tool_call_output", call_id: "toolu_thinking", output: "1" }] }, [], new ReverseState()), "invalid_opaque_state");
    const altered = structuredClone(output); altered[1]!["input"] = "text(2)";
    rejects(() => reverseRequest({ ...base, input: [...base.input, ...altered] }, [], reader), "state_history_mismatch");
  });

  it("preserves supported effort settings and rejects unsupported values", () => {
    const active = reverseRequest({ ...request(), reasoning: { effort: "medium" } });
    assert.deepEqual(active.body["thinking"], { type: "adaptive" });
    assert.deepEqual(active.body["output_config"], { effort: "medium" });
    const disabled = reverseRequest({ ...request(), reasoning: { effort: "none" } });
    assert.deepEqual(disabled.body["thinking"], { type: "disabled" });
    rejects(() => reverseRequest({ ...request(), reasoning: { effort: "ultra" } }), "unsupported_reasoning_effort");
  });
  it("accepts native replay serialization while preserving meaningful content and call arguments", () => {
    assert.equal(replayIdentity({ type: "message", role: "assistant", content: [{ type: "output_text", text: "hello", annotations: [] }] }),
      replayIdentity({ type: "message", role: "assistant", content: [{ type: "input_text", text: "hello" }] }));
    assert.notEqual(replayIdentity({ type: "message", role: "assistant", content: "hello" }), replayIdentity({ type: "message", role: "assistant", content: "changed" }));
    const call = { type: "function_call", namespace: "functions", name: "read", call_id: "one" };
    assert.equal(replayIdentity({ ...call, arguments: '{"a":1,"b":2}' }), replayIdentity({ ...call, arguments: '{ "b": 2, "a": 1 }' }));
    assert.notEqual(replayIdentity({ ...call, arguments: '{"a":1}' }), replayIdentity({ ...call, arguments: '{"a":2}' }));
  });
});
