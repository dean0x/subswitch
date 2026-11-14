import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderKimiResponsesRequest, type KimiMessagesRefusal } from "../../src/routing/kimi-responses-request.js";

const text = (text: string) => ({ type: "text", text });
const call = (id = "call_a") => ({ type: "tool_use", id, name: "inspect", input: { path: "שלום/🦊", flags: [true, null, 3] } });
const result = (id = "call_a") => ({ type: "tool_result", tool_use_id: id, content: "owned result" });
const request = (messages: unknown[] = [{ role: "user", content: "hello" }]) => ({ model: "kimi-for-coding", messages });
const message = (role: string, ...texts: string[]) => ({ type: "message", role, content: texts.map((text) => ({ type: "input_text", text })) });
const render = (source: unknown) => {
  const outcome = renderKimiResponsesRequest(source);
  assert.ok(outcome.ok, JSON.stringify(outcome));
  return outcome.value;
};
const refused = (source: unknown, code: KimiMessagesRefusal) => {
  assert.deepEqual(renderKimiResponsesRequest(source), { ok: false, error: code });
};

describe("selected ordered destination-owned cache hints", () => {
  type Item = Record<string, unknown>;
  const source = (): Item => ({ ...request([
    { role: "user", content: [text("first"), text("")] },
    { role: "assistant", content: [text("before"), call(), text("between"), { ...call("call_b"), input: { cache_control: { scope: "caller data" } } }, text("after")] },
    { role: "system", content: [text("late one"), text("late two")] },
    { role: "user", content: [text("prefix"), result("call_b"), text("between results"), { ...result(), content: '{"cache_control":{"ttl":"caller data"}}' }, text("suffix")] },
  ]), system: [text("initial")], max_tokens: 256, stream: false,
    tools: [{ name: "inspect", input_schema: { type: "object", properties: { cache_control: { type: "string" } }, cache_control: { scope: "schema data" } } }] });
  const content = (s: Item, index: number) => ((s["messages"] as Item[])[index]!["content"] as Item[]);
  const locations: [string, (s: Item) => Item, KimiMessagesRefusal][] = [
    ["request", s => s, "unsupported_request_field"],
    ["initial system text", s => (s["system"] as Item[])[0]!, "unsupported_block_cache_control"],
    ["late system text", s => content(s, 2)[0]!, "unsupported_block_cache_control"],
    ["user text", s => content(s, 0)[0]!, "unsupported_block_cache_control"],
    ["assistant text", s => content(s, 1)[0]!, "unsupported_block_cache_control"],
    ["tool use", s => content(s, 1)[1]!, "unsupported_block_cache_control"],
    ["tool result", s => content(s, 3)[1]!, "unsupported_block_cache_control"],
    ["function tool", s => (s["tools"] as Item[])[0]!, "unsupported_tool_field"],
  ];
  for (const [name, select, code] of locations) {
    for (const [variant, hint] of [["absent", null], ["null", null], ["ephemeral", { type: "ephemeral" }],
      ["5m", { type: "ephemeral", ttl: "5m" }], ["1h", { type: "ephemeral", ttl: "1h" }]] as const) {
      it(`preserves complete input with ${variant} at ${name}`, () => {
        const input = source(), control = source();
        if (variant !== "absent") select(input)["cache_control"] = structuredClone(hint);
        const before = structuredClone(input), rendered = render(input);
        assert.deepEqual(rendered, render(control)); assert.deepEqual(input, before);
        assert.equal(rendered.body["store"], false);
        assert.deepEqual(rendered.pendingCallIds, []);
        (rendered.body["tools"] as Item[])[0]!["parameters"] = {};
        assert.deepEqual(input, before, "destination cannot mutate caller schema");
      });
    }
    for (const [variant, hint] of [
      ["empty", {}], ["array", []], ["string", "private"], ["number", 0], ["boolean", false],
      ["missing type", { ttl: "5m" }], ["null type", { type: null }], ["unknown type", { type: "private" }],
      ["null TTL", { type: "ephemeral", ttl: null }], ["numeric TTL", { type: "ephemeral", ttl: 300 }],
      ["array TTL", { type: "ephemeral", ttl: [] }], ["object TTL", { type: "ephemeral", ttl: {} }],
      ["unknown TTL", { type: "ephemeral", ttl: "24h" }], ["case TTL", { type: "ephemeral", ttl: "5M" }],
      ["eviction", { type: "ephemeral", evict_on_complete: true }], ["scope", { type: "ephemeral", scope: "private" }],
      ["unknown member", { type: "ephemeral", ["private\nhttps://synthetic.invalid/?token=private"]: "private" }],
      ["prototype-like key", JSON.parse('{"type":"ephemeral","__proto__":{"ttl":"5m"}}')],
    ] as const) it(`refuses ${variant} at ${name} without exposing data`, () => {
      const input = source(); select(input)["cache_control"] = hint;
      const before = structuredClone(input); refused(input, code); assert.deepEqual(input, before);
      assert(!JSON.stringify(renderKimiResponsesRequest(input)).includes("private"));
    });
    it(`validates JSON before hints at ${name} without getters or coercion`, () => {
      let invoked = 0;
      const cycle: Item = { type: "ephemeral" }; cycle["ttl"] = cycle;
      const hidden = Object.defineProperty({ type: "ephemeral" }, "ttl", { value: "5m" });
      const getter = { type: "ephemeral", get ttl() { invoked++; throw Error("private"); } };
      const toJSON = { type: "ephemeral", toJSON() { invoked++; return {}; } };
      const boxed = Object.assign(new String("5m"), { [Symbol.toPrimitive]() { invoked++; return "5m"; } });
      for (const hint of [undefined, NaN, Infinity, 1n, Symbol("private"), () => "private", getter, toJSON, hidden,
        Object.create({ type: "ephemeral" }), cycle, { type: "ephemeral", ttl: undefined }, { type: "ephemeral", ttl: boxed },
        { type: "ephemeral", [Symbol("private")]: true }]) {
        const input = source(); select(input)["cache_control"] = hint; refused(input, "invalid_json");
      }
      const outerGetter = source();
      Object.defineProperty(select(outerGetter), "cache_control", { enumerable: true, get() { invoked++; throw Error("private"); } });
      refused(outerGetter, "invalid_json"); assert.equal(invoked, 0);
      const proxy = new Proxy({}, { ownKeys() { invoked++; throw Error("private"); } });
      const input = source(); select(input)["cache_control"] = proxy; refused(input, "invalid_json");
      assert.equal(invoked, 1, "proxy reflection may trap; errors stay fixed");
      const revoked = Proxy.revocable({}, {}); revoked.revoke();
      select(input)["cache_control"] = revoked.proxy; refused(input, "invalid_json");
    });
    it(`accepts frozen null-prototype hint data at ${name} without aliasing`, () => {
      const input = source(), hint = Object.freeze(Object.assign(Object.create(null), { type: "ephemeral", ttl: "1h" }));
      select(input)["cache_control"] = hint;
      const freeze = (value: unknown): void => {
        if (!value || typeof value !== "object") return;
        for (const child of Object.values(value)) freeze(child);
        Object.freeze(value);
      };
      freeze(input); const before = JSON.stringify(input), descriptors = Object.getOwnPropertyDescriptors(hint);
      assert.deepEqual(render(input), render(source()));
      assert.equal(JSON.stringify(input), before); assert.equal(Object.getPrototypeOf(hint), null);
      assert.deepEqual(Object.getOwnPropertyDescriptors(hint), descriptors);
    });
  }
  it("keeps ownership, opaque content, nested results and unknown block families refused", () => {
    const cache_control = { type: "ephemeral" };
    for (const type of ["thinking", "redacted_thinking", "reasoning"]) {
      refused({ ...request([{ role: "assistant", content: [{ type, cache_control, signature: "private" }] }]) }, "opaque_reasoning");
    }
    refused(request([{ role: "assistant", content: [{ ...call(), cache_control, caller: null }] }]), "unsupported_tool_use_caller");
    refused(request([{ role: "user", content: [{ ...text("x"), cache_control, signature: null }] }]), "unsupported_block_field");
    refused(request([{ role: "assistant", content: [call()] }, { role: "user", content: [{ ...result(), cache_control,
      content: [{ ...text("nested"), cache_control: { type: "ephemeral" } }] }] }]), "unsupported_tool_result");
    for (const type of ["image", "server_tool_use", "custom"]) {
      refused(request([{ role: "user", content: [{ type, cache_control }] }]), "unsupported_block");
    }
    for (const type of ["custom", "web_search_20250305"]) {
      refused({ ...request(), tools: [{ type, name: "inspect", input_schema: {}, cache_control }] }, "unsupported_tool_field");
    }
    refused(request([{ role: "user", content: "hello", cache_control }]), "unsupported_message_field");
    const input = source(), shared = { type: "ephemeral" };
    input["cache_control"] = shared; selectTool(input)["cache_control"] = shared;
    refused(input, "invalid_json");
  });
  function selectTool(input: Item) { return (input["tools"] as Item[])[0]!; }
});

describe("ordered display and text citation compatibility", () => {
  for (const citations of [null, []]) it(`preserves all roles and tools with empty citations ${JSON.stringify(citations)}`, () => {
    const block = (value: string) => ({ ...text(value), citations: structuredClone(citations) });
    const source = { ...request([
      { role: "user", content: [block("first"), block("")] },
      { role: "assistant", content: [block("before"), call(), block("after")] },
      { role: "system", content: [block("late")] },
      { role: "user", content: [block("prefix"), result(), block("suffix")] },
    ]), system: [block("initial")], thinking: { type: "enabled", budget_tokens: 1024, display: "omitted" }, max_tokens: 256 };
    const before = structuredClone(source), control = structuredClone(source);
    const blocks = [control.system, ...(control.messages as { content: Record<string, unknown>[] }[]).map(m => m.content)];
    for (const content of blocks) for (const entry of content) {
      if (entry.type === "text") delete (entry as Record<string, unknown>)["citations"];
    }
    assert.deepEqual(render(source), render(control)); assert.deepEqual(source, before);
  });

  for (const citations of [[{}], "private", {}, false, 0]) it(`refuses citation information or malformed ${JSON.stringify(citations)}`, () => {
    refused(request([{ role: "assistant", content: [{ ...text("private"), citations }] }]), "unsupported_text_block_citations");
  });

  it("rejects non-JSON display/citations without reading accessors or accepting empty-looking objects", () => {
    let reads = 0;
    const accessor = Object.defineProperty({}, "citations", { enumerable: true, get() { reads++; throw Error("private"); } });
    const cycle: unknown[] = []; cycle.push(cycle);
    const shared: unknown[] = [];
    for (const block of [Object.assign(accessor, text("private")),
      { ...text("private"), citations: new Array(1) }, { ...text("private"), citations: Object.assign([], { extra: "private" }) },
      { ...text("private"), citations: cycle }, { ...text("private"), citations: Object.create(Array.prototype) },
      { ...text("private"), citations: undefined }]) refused(request([{ role: "user", content: [block] }]), "invalid_json");
    refused(request([{ role: "user", content: [{ ...text("a"), citations: shared }, { ...text("b"), citations: shared }] }]), "invalid_json");
    refused({ ...request(), thinking: { type: "adaptive", get display() { reads++; return "omitted"; } } }, "invalid_json");
    assert.equal(reads, 0);
  });

  it("keeps fixed field diagnostics, precedence, opaque history and tool-owned data", () => {
    for (const cache_control of [{}, { type: "ephemeral", ttl: "private" }, "private"]) {
      refused(request([{ role: "user", content: [{ ...text("private"), citations: [], cache_control }] }]), "unsupported_block_cache_control");
      refused(request([{ role: "assistant", content: [{ ...call(), cache_control }] }]), "unsupported_block_cache_control");
      refused(request([{ role: "assistant", content: [call()] }, { role: "user", content: [{ ...result(), cache_control }] }]), "unsupported_block_cache_control");
    }
    refused(request([{ role: "assistant", content: [{ ...call(), caller: { type: "direct" } }] }]), "unsupported_tool_use_caller");
    for (const key of ["cache_control_extra", "citations\nprivate", "caller", "annotations", "signature", "__proto__"]) {
      refused(request([{ role: "user", content: [{ ...text("private"), [key]: "private" }] }]), "unsupported_block_field");
    }
    refused({ ...request([{ role: "user", content: [{ ...text("private"), cache_control: {} }] }]),
      thinking: { type: "adaptive", display: "updates" } }, "unsupported_thinking_display");
    for (const type of ["thinking", "redacted_thinking", "reasoning"]) refused({
      ...request([{ role: "assistant", content: [{ type, signature: "private", citations: [] }] }]),
      thinking: { type: "adaptive", display: "omitted" } }, "opaque_reasoning");
    const input = { citations: [{ private: "owned" }], cache_control: {}, caller: {}, signature: "owned", thinking: { display: "summarized" } };
    const output = render(request([{ role: "assistant", content: [{ ...call(), input }] }])).body["input"] as Record<string, unknown>[];
    assert.equal(output[0]!["arguments"], JSON.stringify(input));
  });
});

describe("experimental Kimi ordered Responses request subset", () => {
  it("keeps initial and appended system positions, text block boundaries, and complete tool round order", () => {
    const source = { ...request([
      { role: "system", content: "leading" },
      { role: "user", content: [text("first"), text("")] },
      { role: "assistant", content: [text("before"), call(), text("between"), call("call_b"), text("after")] },
      { role: "system", content: [text("late one"), text("late two")] },
      { role: "user", content: [text("before results"), result("call_b"), text("between results"), { ...result(), is_error: false }, text("after results")] },
      { role: "system", content: "last instruction" },
      { role: "assistant", content: "done" },
    ]), system: [text("preamble"), text("preamble part two")], max_tokens: 256, stream: false,
      tools: [{ name: "inspect", description: "read only", input_schema: { type: "object", properties: { path: { type: "string" } }, additionalProperties: false } }],
      tool_choice: { type: "tool", name: "inspect", disable_parallel_tool_use: true }, output_config: { effort: "high" },
      metadata: { user_id: "fabricated-attribution-only" } };
    const before = structuredClone(source);
    const outcome = render(source);
    assert.deepEqual(outcome.body, {
      model: "kimi-for-coding", stream: true, store: false,
      input: [message("system", "preamble", "preamble part two"), message("system", "leading"), message("user", "first", ""),
        message("assistant", "before"), { type: "function_call", call_id: "call_a", name: "inspect", arguments: JSON.stringify(call().input) },
        message("assistant", "between"), { type: "function_call", call_id: "call_b", name: "inspect", arguments: JSON.stringify(call().input) },
        message("assistant", "after"), message("system", "late one", "late two"), message("user", "before results"),
        { type: "function_call_output", call_id: "call_b", output: "owned result" }, message("user", "between results"),
        { type: "function_call_output", call_id: "call_a", output: "owned result" }, message("user", "after results"),
        message("system", "last instruction"), message("assistant", "done")],
      tools: [{ type: "function", name: "inspect", description: "read only", parameters: source.tools[0]!.input_schema, strict: false }],
      tool_choice: { type: "function", name: "inspect" }, parallel_tool_calls: false, max_output_tokens: 256, reasoning: { effort: "high" },
    });
    assert.equal(outcome.stream, false);
    assert.deepEqual(outcome.pendingCallIds, []);
    assert.deepEqual(source, before);
    const tool = (outcome.body["tools"] as Record<string, unknown>[])[0]!;
    (tool["parameters"] as Record<string, unknown>)["new"] = true;
    assert.deepEqual(source, before, "output must not alias caller schema/history");
    assert.ok(!(outcome.body["input"] as Record<string, unknown>[]).some((item) => item["id"] !== undefined), "call IDs are not provider item IDs");
  });

  it("preserves JSON argument values including prototype-like keys without executing tools", () => {
    const args = JSON.parse('{"__proto__":{"polluted":true},"constructor":"plain","nested":{"x":[false,null,1,"🦊"]}}');
    const outcome = render(request([{ role: "assistant", content: [{ ...call(), input: args }] }]));
    const item = (outcome.body["input"] as Record<string, unknown>[])[0]!;
    assert.deepEqual(JSON.parse(item["arguments"] as string), args);
    assert.equal(Object.getPrototypeOf(args), Object.prototype);
    assert.equal(Object.hasOwn({}, "polluted"), false);
    assert.deepEqual(outcome.pendingCallIds, ["call_a"]);
  });

  it("allows a trailing assistant pending tool batch, including an intervening final system Item", () => {
    const outcome = render(request([{ role: "assistant", content: [call(), text("explanation"), call("b")] }, { role: "system", content: "retain here" }]));
    assert.deepEqual(outcome.pendingCallIds, ["call_a", "b"]);
    assert.deepEqual((outcome.body["input"] as unknown[]).at(-1), message("system", "retain here"));
  });

  it("does not truncate a long supported transcript or merge adjacent source messages", () => {
    const messages = Array.from({ length: 4096 }, (_, i) => ({ role: i % 2 ? "system" : "user", content: String(i) }));
    assert.deepEqual(render(request(messages)).body["input"], messages.map((m) => message(m.role, m.content)));
  });

  for (const [choice, expected] of [["auto", "auto"], ["none", "none"], ["any", "required"]] as const) {
    it(`maps ${choice} tool choice without changing tool schemas`, () => {
      const body = render({ ...request(), tools: [{ name: "inspect", input_schema: { type: "object" } }], tool_choice: { type: choice, disable_parallel_tool_use: false } }).body;
      assert.equal(body["tool_choice"], expected); assert.equal(body["parallel_tool_calls"], true);
    });
  }
  it("preserves explicit streaming preference separately from the upstream SSE request", () => {
    assert.equal(render({ ...request(), stream: true }).stream, true);
    assert.equal(render(request()).stream, false);
  });

  const cases: [string, unknown, KimiMessagesRefusal][] = [
    ["missing model", { messages: [] }, "invalid_request"],
    ["no messages", request([]), "invalid_request"],
    ["metadata", { ...request(), metadata: { secret: "fabricated" } }, "unsupported_request_field_metadata_object"],
    ["cache control", { ...request(), cache_control: {} }, "unsupported_request_field"],
    ["thinking config", { ...request(), thinking: { type: "enabled" } }, "invalid_thinking_budget"],
    ["stop sequences", { ...request(), stop_sequences: ["END"] }, "unsupported_request_field"],
    ["temperature", { ...request(), temperature: 0.1 }, "unsupported_request_field_temperature_number"],
    ["request stream type", { ...request(), stream: "true" }, "invalid_request"],
    ["bad token cap", { ...request(), max_tokens: 0 }, "invalid_request"],
    ["fractional token cap", { ...request(), max_tokens: 2.5 }, "invalid_request"],
    ["output format", { ...request(), output_config: { format: "json" } }, "unsupported_output_config_field_format_string"],
    ["empty output config", { ...request(), output_config: {} }, "invalid_request"],
    ["developer role", request([{ role: "developer", content: "do not demote" }]), "unsupported_role"],
    ["message metadata", request([{ role: "user", content: "a", metadata: {} }]), "unsupported_message_field"],
    ["empty blocks", request([{ role: "user", content: [] }]), "invalid_message"],
    ["text type", request([{ role: "user", content: [{ type: "text", text: 4 }] }]), "unsupported_block"],
    ["text cache", request([{ role: "user", content: [{ ...text("a"), cache_control: {} }] }]), "unsupported_block_cache_control"],
    ["citations", request([{ role: "assistant", content: [{ ...text("a"), citations: [{}] }] }]), "unsupported_text_block_citations"],
    ["annotations", request([{ role: "assistant", content: [{ ...text("a"), annotations: [] }] }]), "unsupported_block_field"],
    ["image", request([{ role: "user", content: [{ type: "image", source: {} }] }]), "unsupported_block"],
    ["signature", request([{ role: "assistant", content: [{ type: "thinking", thinking: "fabricated", signature: "same-profile-is-not-responses" }] }]), "opaque_reasoning"],
    ["redacted thinking", request([{ role: "assistant", content: [{ type: "redacted_thinking", data: "fabricated" }] }]), "opaque_reasoning"],
    ["Responses opaque blob", request([{ role: "assistant", content: [{ type: "reasoning", encrypted_content: "fabricated" }] }]), "opaque_reasoning"],
    ["wrong call role", request([{ role: "user", content: [call()] }]), "unsupported_block"],
    ["system tool call", request([{ role: "system", content: [call()] }]), "unsupported_block"],
    ["orphan result", request([{ role: "user", content: [result()] }]), "invalid_tool_linkage"],
    ["duplicate call", request([{ role: "assistant", content: [call(), call()] }]), "invalid_tool_linkage"],
    ["duplicate result", request([{ role: "assistant", content: [call()] }, { role: "user", content: [result(), result()] }]), "invalid_tool_linkage"],
    ["missing result before assistant", request([{ role: "assistant", content: [call()] }, { role: "assistant", content: "next" }]), "incomplete_tool_round"],
    ["missing result before user", request([{ role: "assistant", content: [call()] }, { role: "user", content: "next" }]), "incomplete_tool_round"],
    ["partial results", request([{ role: "assistant", content: [call(), call("b")] }, { role: "user", content: [result()] }]), "incomplete_tool_round"],
    ["error result", request([{ role: "assistant", content: [call()] }, { role: "user", content: [{ ...result(), is_error: true }] }]), "unsupported_tool_result"],
    ["nested result", request([{ role: "assistant", content: [call()] }, { role: "user", content: [{ ...result(), content: [text("do not flatten")] }] }]), "unsupported_tool_result"],
    ["missing result content", request([{ role: "assistant", content: [call()] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "call_a" }] }]), "unsupported_tool_result"],
    ["nonobject arguments", request([{ role: "assistant", content: [{ ...call(), input: [1] }] }]), "invalid_tool"],
    ["call metadata", request([{ role: "assistant", content: [{ ...call(), cache_control: {} }] }]), "unsupported_block_cache_control"],
    ["server tool", { ...request(), tools: [{ type: "web_search", name: "search" }] }, "unsupported_tool_field"],
    ["tool cache", { ...request(), tools: [{ name: "x", input_schema: {}, cache_control: {} }] }, "unsupported_tool_field"],
    ["duplicate definitions", { ...request(), tools: [{ name: "x", input_schema: {} }, { name: "x", input_schema: {} }] }, "invalid_tool"],
    ["unknown choice", { ...request(), tool_choice: { type: "custom" } }, "invalid_tool_choice"],
    ["missing chosen tool", { ...request(), tool_choice: { type: "tool", name: "absent" } }, "invalid_tool_choice"],
    ["required without tools", { ...request(), tool_choice: { type: "any" } }, "invalid_tool_choice"],
    ["choice metadata", { ...request(), tool_choice: { type: "auto", extra: true } }, "invalid_tool_choice"],
  ];
  for (const [name, source, code] of cases) it(`refuses ${name} atomically with a fixed code`, () => refused(source, code));

  it("refuses non-JSON data without accessor/toJSON calls or raw-error disclosure", () => {
    let calls = 0;
    const accessor = { ...request(), get system() { calls++; throw new Error("fabricated private detail"); } };
    const toJSON = { ...request(), toJSON() { calls++; return {}; } };
    for (const source of [accessor, toJSON, { ...request(), system: undefined }, { ...request(), max_tokens: NaN }, { ...request(), bigint: 1n }]) refused(source, "invalid_json");
    const cycle: Record<string, unknown> = request(); cycle["cycle"] = cycle;
    refused(cycle, "invalid_json");
    assert.equal(calls, 0);
  });

  it("reports fixed source-backed caller fields and JSON kinds without their values", () => {
    const cases = [
      ["metadata", { unknown_member: "private-user" }, "object"], ["temperature", 0.7, "number"],
      ["safeguards", [{ type: "private-policy" }], "array"], ["speed", "private-speed", "string"],
      ["thread", "private-thread", "string"], ["diagnostics", { previous_message_id: "private-id" }, "object"],
      ["betas", ["private-beta"], "array"], ["fallback_credit_token", "private-token", "string"],
    ] as const;
    for (const [field, value, kind] of cases) {
      const source = { ...request(), [field]: value }, before = structuredClone(source);
      refused(source, `unsupported_request_field_${field}_${kind}`);
      assert.deepEqual(source, before);
    }
  });

  it("distinguishes all JSON kinds without content or object coercion", () => {
    for (const [value, kind] of [[null, "null"], [[], "array"], [{ user_id: 0 }, "object"], ["secret", "string"], [3, "number"], [false, "boolean"]] as const) {
      refused({ ...request(), metadata: value }, `unsupported_request_field_metadata_${kind}`);
      refused({ ...request(), output_config: { effort: "high", format: value } }, `unsupported_output_config_field_format_${kind}`);
    }
  });

  it("keeps arbitrary, prototype-like and oversized unknown keys opaque", () => {
    for (const key of ["secret-key\nhttps://private.invalid/?token=private", "__proto__", "constructor", "toString", "x".repeat(1024 * 1024)]) {
      refused({ ...request(), [key]: "secret-value" }, "unsupported_request_field");
      refused({ ...request(), output_config: { effort: "high", [key]: "secret-value" } }, "unsupported_output_config_field");
    }
    // First refusal follows insertion order; a later known name cannot turn an
    // earlier unknown field into a guessed diagnosis.
    refused({ ...request(), private_unknown: "secret", metadata: {} }, "unsupported_request_field");
    refused({ ...request(), output_config: { private_unknown: "secret", format: {} } }, "unsupported_output_config_field");
  });

  it("rejects hostile known-field values before classification without raw errors", () => {
    let calls = 0;
    const source = { ...request(), get metadata() { calls++; throw Error("private"); } };
    const coercion = { toJSON() { calls++; throw Error("private"); }, toString() { calls++; throw Error("private"); } };
    const proxy = new Proxy({}, { ownKeys() { calls++; throw Error("private"); } });
    refused(source, "invalid_json");
    refused({ ...request(), metadata: coercion }, "invalid_json");
    assert.equal(calls, 0);
    refused({ ...request(), metadata: proxy }, "invalid_json");
    assert.equal(calls, 1, "proxy reflection can run traps; raw errors stay private");
    for (const value of [undefined, NaN, Infinity, 1n, Symbol("private"), () => "private"]) refused({ ...request(), metadata: value }, "invalid_json");
  });
});

describe("selected ordered Kimi optional attribution policy", () => {
  for (const [name, metadata] of [
    ["empty object", {}], ["empty identifier", { user_id: "" }],
    ["opaque serialized identifier", { user_id: '{"session_id":"fabricated","device_id":"synthetic"}' }],
    ["null-prototype object", Object.assign(Object.create(null), { user_id: "fabricated" })],
    ["frozen object", Object.freeze({ user_id: "fabricated" })],
  ] as const) it(`validates and omits ${name} without changing any inference field`, () => {
    const source = { ...request(), metadata }, before = JSON.stringify(source);
    const descriptors = Object.getOwnPropertyDescriptors(metadata), prototype = Object.getPrototypeOf(metadata);
    assert.deepEqual(render(source), render(request()));
    assert.equal(JSON.stringify(source), before);
    assert.deepEqual(Object.getOwnPropertyDescriptors(metadata), descriptors);
    assert.equal(Object.getPrototypeOf(metadata), prototype);
    assert.equal(Object.hasOwn(render(source).body, "metadata"), false);
  });

  for (const [name, user_id, accepted] of [
    ["zero code points", "", true], ["512 ASCII", "a".repeat(512), true], ["513 ASCII", "a".repeat(513), false],
    ["512 astral", "🦊".repeat(512), true], ["513 astral", "🦊".repeat(513), false],
    ["512 mixed", "🦊".repeat(256) + "a".repeat(256), true], ["513 mixed", "🦊".repeat(256) + "a".repeat(257), false],
    ["512 decomposed code points", "e\u0301".repeat(256), true], ["514 decomposed code points", "e\u0301".repeat(257), false],
  ] as const) it(`applies the explicit Unicode code-point bound: ${name}`, () => {
    const source = { ...request(), metadata: { user_id } }, before = structuredClone(source);
    if (accepted) assert.deepEqual(render(source), render(request()));
    else refused(source, "unsupported_request_field_metadata_object");
    assert.deepEqual(source, before);
  });

  for (const [name, metadata] of [
    ["null", null], ["array", []], ["string", "fabricated"], ["number", 1], ["boolean", false],
    ["null identifier", { user_id: null }], ["array identifier", { user_id: [] }],
    ["object identifier", { user_id: {} }], ["numeric identifier", { user_id: 1 }], ["boolean identifier", { user_id: false }],
    ["unknown member", { user_id: "fabricated", private_unknown: "synthetic" }],
    ["prototype-like own member", JSON.parse('{"__proto__":{"user_id":"fabricated"}}')],
  ] as const) it(`refuses ${name} with only the existing fixed field/kind code`, () => {
    const kind = metadata === null ? "null" : Array.isArray(metadata) ? "array" : typeof metadata;
    assert.deepEqual(renderKimiResponsesRequest({ ...request(), metadata }),
      { ok: false, error: `unsupported_request_field_metadata_${kind}` });
  });

  it("keeps invalid JSON defenses without invoking nested attribution accessors or coercion", () => {
    let invoked = 0;
    const cycle: Record<string, unknown> = {}; cycle["self"] = cycle;
    const accessor = { get user_id() { invoked++; throw Error("fabricated-private"); } };
    const toJSON = { user_id: "fabricated", toJSON() { invoked++; return {}; } };
    const boxed = Object.assign(new String("fabricated"), { [Symbol.toPrimitive]() { invoked++; return "fabricated"; } });
    const nonenumerable = Object.defineProperty({}, "user_id", { value: "fabricated" });
    for (const metadata of [accessor, toJSON, nonenumerable, Object.create({ user_id: "fabricated" }),
      { user_id: boxed }, { [Symbol("synthetic")]: "fabricated" }, cycle,
      ...[undefined, NaN, Infinity, 1n, Symbol("synthetic"), () => "fabricated"].map(user_id => ({ user_id }))]) {
      refused({ ...request(), metadata }, "invalid_json");
    }
    assert.equal(invoked, 0);
  });

  it("does not turn attribution into another field, leak it, or bypass the next refusal", () => {
    const metadata = { user_id: "fabricated-attribution\nhttps://synthetic.invalid/?token=fabricated" };
    const outcome = render({ ...request(), metadata });
    assert.deepEqual(outcome, render(request()));
    assert(!JSON.stringify(outcome).includes("fabricated-attribution"));
    refused({ ...request(), metadata, thinking: { type: "adaptive", display: "summarized" } }, "unsupported_thinking_display");
    refused({ ...request(), metadata, output_config: { format: {} } }, "unsupported_output_config_field_format_object");
    refused({ ...request(), metadata: { private_unknown: "synthetic" }, thinking: {} }, "unsupported_request_field_metadata_object");
    refused({ ...request(), private_unknown: "synthetic", metadata: { user_id: 0 } }, "unsupported_request_field");
  });
});

describe("selected ordered Kimi thinking policy", () => {
  for (const [name, extra] of [
    ["absent", {}], ["adaptive without output cap", { thinking: { type: "adaptive" } }],
    ["adaptive omitted display", { thinking: { type: "adaptive", display: "omitted" } }],
    ["enabled omitted display", { thinking: { type: "enabled", budget_tokens: 1024, display: "omitted" }, max_tokens: 256 }],
    ["minimum enabled budget and cap", { thinking: { type: "enabled", budget_tokens: 1024 }, max_tokens: 1025 }],
    ["enabled cap minus one", { thinking: { type: "enabled", budget_tokens: 4095 }, max_tokens: 4096 }],
    ["enabled equal cap", { thinking: { type: "enabled", budget_tokens: 2048 }, max_tokens: 2048 }],
    ["enabled above cap", { thinking: { type: "enabled", budget_tokens: 2049 }, max_tokens: 2048 }],
    ["pinned builder clamp with small output cap", { thinking: { type: "enabled", budget_tokens: Math.max(1024, Math.min(256 - 1, 4096)) }, max_tokens: 256 }],
    ["minimum positive output cap", { thinking: { type: "enabled", budget_tokens: 1024 }, max_tokens: 1 }],
    ["safe-integer boundary", { thinking: { type: "enabled", budget_tokens: Number.MAX_SAFE_INTEGER - 1 }, max_tokens: Number.MAX_SAFE_INTEGER }],
  ] as const) it(`validates ${name} without changing portable history/tools or inventing budget conversion`, () => {
    const source = { ...request([
      { role: "user", content: [text("first"), text("")] },
      { role: "assistant", content: [text("before"), call(), text("after")] },
      { role: "system", content: "late instruction" },
      { role: "user", content: [text("prefix"), result(), text("suffix")] },
    ]), system: "preamble", tools: [{ name: "inspect", input_schema: { type: "object" } }],
      output_config: { effort: "low" }, ...extra };
    const before = structuredClone(source), control: Record<string, unknown> = structuredClone(source);
    delete control["thinking"];
    assert.deepEqual(render(source), render(control), "selected adapter, not a numeric conversion, supplies effective effort");
    assert.deepEqual(render(source).body["reasoning"], { effort: "low" }, "pure renderer leaves final destination precedence to the adapter");
    assert.equal(Object.hasOwn(render(source).body, "thinking"), false);
    const output = render(source).body, input = output["input"] as Record<string, unknown>[];
    input[0]!["content"] = "mutated copy";
    ((output["tools"] as Record<string, unknown>[])[0]!["parameters"] as Record<string, unknown>)["mutated"] = true;
    assert.deepEqual(source, before);
  });

  const rejected: [string, unknown, unknown, KimiMessagesRefusal][] = [
    ["null", null, 2048, "unsupported_request_field_thinking_null"],
    ["array", [], 2048, "unsupported_request_field_thinking_array"],
    ["string", "enabled", 2048, "unsupported_request_field_thinking_string"],
    ["number", 1, 2048, "unsupported_request_field_thinking_number"],
    ["boolean", false, 2048, "unsupported_request_field_thinking_boolean"],
    ["empty object", {}, 2048, "unsupported_thinking_type"],
    ["disabled", { type: "disabled" }, 2048, "unsupported_thinking_type"],
    ["off", { type: "off" }, 2048, "unsupported_thinking_type"],
    ["unknown mode", { type: "fabricated-private" }, 2048, "unsupported_thinking_type"],
    ["missing type", { budget_tokens: 1024 }, 2048, "unsupported_thinking_type"],
    ["missing budget", { type: "enabled" }, 2048, "invalid_thinking_budget"],
    ["string budget", { type: "enabled", budget_tokens: "1024" }, 2048, "invalid_thinking_budget"],
    ["fractional budget", { type: "enabled", budget_tokens: 1024.5 }, 2048, "invalid_thinking_budget"],
    ["below minimum", { type: "enabled", budget_tokens: 1023 }, 2048, "invalid_thinking_budget"],
    ["negative budget", { type: "enabled", budget_tokens: -1 }, 2048, "invalid_thinking_budget"],
    ["unsafe budget", { type: "enabled", budget_tokens: Number.MAX_SAFE_INTEGER + 1 }, Number.MAX_SAFE_INTEGER, "invalid_thinking_budget"],
    ["null cap", { type: "enabled", budget_tokens: 1024 }, null, "invalid_thinking_cap"],
    ["string cap", { type: "enabled", budget_tokens: 1024 }, "2048", "invalid_thinking_cap"],
    ["fractional cap", { type: "enabled", budget_tokens: 1024 }, 2048.5, "invalid_thinking_cap"],
    ["zero cap", { type: "enabled", budget_tokens: 1024 }, 0, "invalid_thinking_cap"],
    ["negative cap", { type: "enabled", budget_tokens: 1024 }, -1, "invalid_thinking_cap"],
    ["unsafe cap", { type: "enabled", budget_tokens: 1024 }, Number.MAX_SAFE_INTEGER + 1, "invalid_thinking_cap"],
    ["adaptive budget", { type: "adaptive", budget_tokens: 1024 }, 2048, "unsupported_thinking_field"],
    ...["adaptive", "enabled"].flatMap(type => ["summarized", "updates", "highlights", "omitted\n", "OMITTED", null, false, 0, [], {}].map(display =>
      [`${type} display ${display}`, { type, ...(type === "enabled" ? { budget_tokens: 1024 } : {}), display }, 2048, "unsupported_thinking_display"] as [string, unknown, unknown, KimiMessagesRefusal])),
    ["signature", { type: "adaptive", signature: "fabricated-private" }, 2048, "unsupported_thinking_binding"],
    ["binding", { type: "enabled", budget_tokens: 1024, block_binding: { prefix_mismatch_behavior: "fabricated-private" } }, 2048, "unsupported_thinking_binding"],
    ["unknown member", { type: "adaptive", ["fabricated-private\nhttps://synthetic.invalid/?token=fabricated"]: "private" }, 2048, "unsupported_thinking_field"],
    ["prototype-like member", JSON.parse('{"type":"adaptive","__proto__":{"private":true}}'), 2048, "unsupported_thinking_field"],
  ];
  for (const [name, thinking, max_tokens, expected] of rejected) it(`refuses ${name} with a closed reason and no values`, () => {
    const source = { ...request(), thinking, max_tokens }, before = structuredClone(source);
    refused(source, expected);
    assert(!JSON.stringify(renderKimiResponsesRequest(source)).includes("fabricated-private"));
    assert.deepEqual(source, before);
  });
  it("requires an explicit cap for enabled but leaves adaptive cap validation intact", () => {
    refused({ ...request(), thinking: { type: "enabled", budget_tokens: 1024 } }, "invalid_thinking_cap");
    refused({ ...request(), thinking: { type: "adaptive" }, max_tokens: 0 }, "invalid_request");
  });

  it("validates inert JSON before thinking policy without invoking accessors or coercion", () => {
    let invoked = 0;
    const cycle: Record<string, unknown> = { type: "adaptive" }; cycle["self"] = cycle;
    const getter = { type: "enabled", get budget_tokens() { invoked++; throw Error("fabricated-private"); } };
    const toJSON = { type: "adaptive", toJSON() { invoked++; throw Error("fabricated-private"); } };
    const hidden = Object.defineProperty({ type: "adaptive" }, "display", { value: "omitted" });
    for (const thinking of [getter, toJSON, hidden, cycle, Object.create({ type: "adaptive" }),
      { type: "adaptive", [Symbol("fabricated-private")]: true },
      ...[undefined, NaN, Infinity, 1n, Symbol("fabricated-private"), () => 1024].map(budget_tokens => ({ type: "enabled", budget_tokens }))]) {
      refused({ ...request(), thinking, max_tokens: 2048 }, "invalid_json");
    }
    const shared = { type: "adaptive" };
    refused({ ...request(), thinking: shared, metadata: shared }, "invalid_json");
    assert.equal(invoked, 0);
  });

  it("does not discard signed or opaque history to accept supported thinking controls", () => {
    for (const block of [{ type: "thinking", thinking: "fabricated-private", signature: "fabricated-signature" },
      { type: "redacted_thinking", data: "fabricated-private" }, { type: "reasoning", encrypted_content: "fabricated-private" }]) {
      refused({ ...request([{ role: "assistant", content: [block] }]), thinking: { type: "adaptive" } }, "opaque_reasoning");
    }
  });
});

describe("selected ordered Kimi context preservation", () => {
  for (const [name, context_management] of [
    ["empty config", {}], ["no edits", { edits: [] }],
    ["explicit keep-all thinking", { edits: [{ type: "clear_thinking_20251015", keep: "all" }] }],
  ] as const) it(`treats ${name} as preservation of the entire portable transcript`, () => {
    const source = { ...request([
      { role: "user", content: "first" },
      { role: "assistant", content: [text("before"), call(), text("after")] },
      { role: "system", content: "late" },
      { role: "user", content: [text("prefix"), result(), text("suffix")] },
    ]), system: "preamble", tools: [{ name: "inspect", input_schema: { type: "object" } }],
      max_tokens: 256, thinking: { type: "enabled", budget_tokens: 1024 }, context_management };
    const before = structuredClone(source), control: Record<string, unknown> = structuredClone(source);
    delete control["context_management"];
    const outcome = render(source);
    assert.deepEqual(outcome, render(control));
    assert.equal(Object.hasOwn(outcome.body, "context_management"), false);
    assert.deepEqual(source, before);
  });

  const rejected: [string, unknown, KimiMessagesRefusal][] = [
    ["null", null, "unsupported_request_field_context_management_null"],
    ["array", [], "unsupported_request_field_context_management_array"],
    ["string", "fabricated-private", "unsupported_request_field_context_management_string"],
    ["number", 1, "unsupported_request_field_context_management_number"],
    ["boolean", false, "unsupported_request_field_context_management_boolean"],
    ["unknown config field", { ["fabricated-private\nhttps://synthetic.invalid/?token=fabricated"]: true }, "unsupported_context_management_field"],
    ["null edits", { edits: null }, "invalid_context_management_edits"],
    ["object edits", { edits: {} }, "invalid_context_management_edits"],
    ["string edits", { edits: "fabricated-private" }, "invalid_context_management_edits"],
    ["null edit", { edits: [null] }, "unsupported_context_management_edit"],
    ["missing type", { edits: [{ keep: "all" }] }, "unsupported_context_management_edit"],
    ["implicit model default", { edits: [{ type: "clear_thinking_20251015" }] }, "unsupported_context_management_edit"],
    ["limited thinking retention", { edits: [{ type: "clear_thinking_20251015", keep: { type: "thinking_turns", value: 2 } }] }, "unsupported_context_management_edit"],
    ["tool clearing", { edits: [{ type: "clear_tool_uses_20250919" }] }, "unsupported_context_management_edit"],
    ["compaction", { edits: [{ type: "compact_20260112" }] }, "unsupported_context_management_edit"],
    ["extra edit field", { edits: [{ type: "clear_thinking_20251015", keep: "all", trigger: "fabricated-private" }] }, "unsupported_context_management_edit"],
    ["combined preservation and clearing", { edits: [{ type: "clear_thinking_20251015", keep: "all" }, { type: "clear_tool_uses_20250919" }] }, "unsupported_context_management_edit"],
    ["repeated strategy", { edits: [{ type: "clear_thinking_20251015", keep: "all" }, { type: "clear_thinking_20251015", keep: "all" }] }, "unsupported_context_management_edit"],
    ["unknown edit", { edits: [{ type: "fabricated-private" }] }, "unsupported_context_management_edit"],
    ["prototype-like field", JSON.parse('{"__proto__":{"private":true}}'), "unsupported_context_management_field"],
  ];
  for (const [name, context_management, expected] of rejected) it(`refuses ${name} without interpreting or echoing it`, () => {
    const source = { ...request(), context_management }, before = structuredClone(source);
    refused(source, expected);
    assert.deepEqual(source, before);
    assert(!JSON.stringify(renderKimiResponsesRequest(source)).includes("fabricated-private"));
  });

  it("validates inert JSON before interpreting edits and accepts frozen null-prototype data", () => {
    let invoked = 0;
    const accessor = { get edits() { invoked++; throw Error("fabricated-private"); } };
    const cycle: Record<string, unknown> = {}; cycle["edits"] = [cycle];
    const edit = { type: "clear_thinking_20251015", keep: "all" };
    for (const context_management of [accessor, cycle, Object.create({ edits: [] }),
      Object.defineProperty({}, "edits", { value: [] }), { edits: [edit, edit] },
      { edits: [new String("all")] }, { edits: undefined }, { [Symbol("fabricated-private")]: true }]) {
      refused({ ...request(), context_management }, "invalid_json");
    }
    const preserved = Object.freeze(Object.assign(Object.create(null), { type: "clear_thinking_20251015", keep: "all" }));
    const context_management = Object.freeze(Object.assign(Object.create(null), { edits: Object.freeze([preserved]) }));
    assert.deepEqual(render({ ...request(), context_management }), render(request()));
    assert.equal(invoked, 0);
  });

  it("preserves caller tool data named like policy fields and refuses opaque history", () => {
    const context_management = { edits: [{ type: "clear_thinking_20251015", keep: "all" }] };
    const input = { thinking: { display: "fabricated-private" }, context_management: { edits: [{ type: "clear_tool_uses_20250919" }] } };
    const outcome = render({ ...request([{ role: "assistant", content: [{ ...call(), input }] }]), context_management });
    assert.equal((outcome.body["input"] as Record<string, unknown>[])[0]!["arguments"], JSON.stringify(input));
    for (const block of [{ type: "thinking", thinking: "fabricated-private", signature: "fabricated-private" },
      { type: "redacted_thinking", data: "fabricated-private" }, { type: "reasoning", encrypted_content: "fabricated-private" }]) {
      refused({ ...request([{ role: "assistant", content: [block] }]), context_management }, "opaque_reasoning");
    }
    refused({ ...request(), context_management, temperature: 0.7 }, "unsupported_request_field_temperature_number");
    refused({ ...request(), private_unknown: "fabricated-private", context_management: { edits: null } }, "unsupported_request_field");
  });
});
