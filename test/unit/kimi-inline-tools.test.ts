/** Fabricated in-memory requests only: no sockets, auth, credentials or providers. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { test } from "node:test";
import { ClaudeCache } from "../../src/claude-cache.js";
import { ReverseState } from "../../src/claude-state.js";
import { reverseRequest } from "../../src/claude-adapter.js";
import { noopLogger } from "../../src/logger.js";
import { systemClock } from "../../src/routing/clock.js";
import { writeRoutedHttp } from "../../src/routing/http-ingress.js";
import { decodePortableHistory, renderResponsesHistory } from "../../src/routing/portable-history.js";
import { adaptRequest } from "../../src/routing/request-adapter.js";
import { RoutingError, type AccessProfile, type Item, type WireProtocol } from "../../src/routing/routing-types.js";

const kimi: AccessProfile = {
  provider: "kimi", product: "kimi-code", region: "global", billing: "subscription",
  account: "fabricated", credential: { kind: "native-oauth", authFile: "/fabricated/unused" },
};
const fn = { type: "function", name: "read", description: "Read", parameters: { type: "object", properties: {} }, strict: true };
const patch = { type: "custom", name: "apply_patch", format: { type: "grammar", syntax: "lark", definition: "start: /.+/" } };
const namespace = { type: "namespace", name: "functions", description: "Caller tools", tools: [fn, patch] };
const inline = (tools: unknown = [fn]): Item => ({ type: "additional_tools", role: "developer", id: "declaration", tools });
const bodyWith = (entry: Item): Item => ({ input: [{ role: "user", content: "before" }, entry, { role: "user", content: "after" }] });

function adapt(body: Item, options: {
  profile?: AccessProfile; protocol?: WireProtocol; priorOwner?: string; conversation?: string; stage?: ClaudeCache;
} = {}) {
  const stage = options.stage ?? new ClaudeCache();
  return adaptRequest({
    profile: options.profile ?? kimi,
    target: { profile: "fixture", model: "kimi-for-coding", effort: "high" },
    body, ingress: "responses", protocol: options.protocol ?? "responses",
    transcript: decodePortableHistory(body, "responses"), stage,
    state: new ReverseState(undefined, undefined, stage), owner: "owner",
    conversation: options.conversation ?? "conversation", sessionId: "session", priorOwner: options.priorOwner,
  }).outbound;
}

test("Kimi Responses preserves temporal inline declarations, namespaced call/result identity and caller ownership", () => {
  const agent = { type: "agent_message", author: "planner", recipient: "worker", content: "continue" };
  const body: Item = {
    instructions: "Caller instructions", metadata: { caller: true }, tools: [fn],
    input: [
      { role: "user", content: "before" },
      inline([namespace]),
      { type: "function_call", id: "fc1", call_id: "call1", namespace: "functions", name: "read", arguments: "{}" },
      { type: "function_call_output", id: "out1", call_id: "call1", output: "contents" },
      agent,
      { ...inline([patch]), id: "later" },
      { type: "custom_tool_call", id: "cc1", call_id: "call2", name: "apply_patch", input: "fabricated patch" },
      { type: "custom_tool_call_output", id: "out2", call_id: "call2", output: "done" },
    ],
  };
  const before = structuredClone(body), transcript = decodePortableHistory(body, "responses");
  const outbound = adapt(body);
  assert.deepEqual(outbound.input, (body.input as Item[]).map(entry => entry === agent ? {
    type: "message", role: "user", content: [
      { type: "input_text", text: "Agent message from planner to worker:" },
      { type: "input_text", text: "continue" },
    ],
  } : entry));
  assert.deepEqual(outbound.tools, [fn], "inline tools must not become available before their item");
  assert.deepEqual(transcript.tools, [fn, namespace, patch], "aggregate metadata retains every declaration");
  assert.deepEqual(outbound.instructions, body.instructions);
  assert.deepEqual(outbound.metadata, body.metadata);
  assert.deepEqual(body, before);
});

for (const topLevel of [undefined, [], [fn]]) {
  test(`top-level ${topLevel === undefined ? "absence" : topLevel.length ? "definitions" : "empty tools"} survives empty/repeated inline items`, () => {
    const body: Item = {
      ...(topLevel === undefined ? {} : { tools: topLevel }),
      input: [inline([]), inline([fn]), inline([fn]), { role: "user", content: "continue" }],
    };
    const before = structuredClone(body), outbound = adapt(body);
    assert.equal(Object.hasOwn(outbound, "tools"), Object.hasOwn(body, "tools"));
    assert.deepEqual(outbound.tools, body.tools);
    assert.deepEqual(outbound.input, body.input, "repeated IDs/declarations are not merged or reordered");
    assert.deepEqual(body, before);
  });
}

test("inline optional IDs and schema-optional function fields remain optional", () => {
  const body = { input: [
    { type: "additional_tools", role: "developer", tools: [{ type: "function", name: "_read-1" }] },
    { ...inline([{ type: "namespace", name: "", description: "", tools: [] }]), id: "" },
  ] };
  assert.deepEqual(adapt(body).input, body.input);
});

const malformed: [string, Item][] = [
  ["missing role", { type: "additional_tools", tools: [fn] }],
  ["wrong role", { ...inline(), role: "assistant" }],
  ["non-string ID", { ...inline(), id: 1 }],
  ["null ID", { ...inline(), id: null }],
  ["missing tools", { type: "additional_tools", role: "developer" }],
  ["non-array tools", inline({})],
  ["null declaration", inline([null])],
  ["unknown inline field", { ...inline(), unknown: true }],
  ["hosted tool", inline([{ type: "web_search" }])],
  ["unknown tool variant", inline([{ type: "tool_search", name: "search" }])],
  ["missing name", inline([{ type: "function" }])],
  ["bad function name", inline([{ ...fn, name: "read.file" }])],
  ["long function name", inline([{ ...fn, name: "a".repeat(129) }])],
  ["non-object parameters", inline([{ ...fn, parameters: [] }])],
  ["null parameters", inline([{ ...fn, parameters: null }])],
  ["non-boolean strict", inline([{ ...fn, strict: "true" }])],
  ["non-string description", inline([{ ...fn, description: null }])],
  ["unknown function field", inline([{ ...fn, unknown: true }])],
  ["custom exec", inline([{ ...patch, name: "exec" }])],
  ["missing custom format", inline([{ type: "custom", name: "apply_patch" }])],
  ["text custom format", inline([{ ...patch, format: { type: "text" } }])],
  ["unknown grammar syntax", inline([{ ...patch, format: { ...patch.format, syntax: "regex" } }])],
  ["missing grammar definition", inline([{ ...patch, format: { type: "grammar", syntax: "lark" } }])],
  ["non-string grammar", inline([{ ...patch, format: { ...patch.format, definition: 1 } }])],
  ["unknown grammar field", inline([{ ...patch, format: { ...patch.format, unknown: true } }])],
  ["missing namespace description", inline([{ type: "namespace", name: "functions", tools: [fn] }])],
  ["missing namespace name", inline([{ type: "namespace", description: "tools", tools: [fn] }])],
  ["non-array namespace tools", inline([{ ...namespace, tools: {} }])],
  ["nested namespace", inline([{ ...namespace, tools: [namespace] }])],
  ["invalid namespaced child", inline([{ ...namespace, tools: [{ ...fn, strict: null }] }])],
  ["unknown history item", { type: "future_item", role: "developer", tools: [fn] }],
];
for (const [name, entry] of malformed) {
  test(`rejects ${name} without changing caller history`, () => {
    const body = bodyWith(entry), before = structuredClone(body);
    assert.throws(() => adapt(body), (error: unknown) =>
      error instanceof RoutingError && error.code === "unsupported_routed_content" && error.status === 400);
    assert.deepEqual(body, before);
  });
}

test("inline preservation retains encrypted arguments and opaque owner/conversation guards", () => {
  const encrypted = { type: "function_call", call_id: "call", name: "read", arguments: "{}", encrypted_function_args: ["foreign"] };
  assert.throws(() => adapt({ input: [inline(), encrypted] }), /foreign_opaque_state/);
  const reasoning = { type: "reasoning", id: "reason", encrypted_content: "fabricated" };
  const body = { input: [inline(), reasoning, { role: "user", content: "continue" }] };
  assert.throws(() => adapt(body), /foreign_opaque_state/);
  const stage = new ClaudeCache();
  stage.put("snapshot", "opaque:owner:conversation:fabricated", { request: {}, input: [reasoning] });
  assert.deepEqual(adapt(body, { stage, priorOwner: "owner" }).input, body.input);
  assert.throws(() => adapt(body, { stage, priorOwner: "other" }), /continuity_unavailable/);
  assert.throws(() => adapt(body, { stage, conversation: "other" }), /foreign_opaque_state/);
});

test("inline declarations do not weaken complete tool call/result checks", () => {
  const call = { type: "function_call", call_id: "call", name: "read", arguments: "{}" };
  const result = { type: "function_call_output", call_id: "call", output: "done" };
  assert.throws(() => adapt({ input: [inline(), call] }), /continuity_unavailable/);
  for (const history of [[result], [call, call, result], [call, result, result]])
    assert.throws(() => adapt({ input: [inline(), ...history] }), /unsupported_routed_content/);
  const body = { input: [inline(), call, result] };
  assert.deepEqual(adapt(body).input, body.input);
});

test("non-Kimi same-protocol and Kimi cross-protocol behavior remain unchanged", () => {
  // A missing inline role is legacy-supported; new Kimi same-protocol validation stays scoped.
  const body: Item = { ...bodyWith({ type: "additional_tools", tools: [fn] }), model: "fixture" };
  const api: AccessProfile = { provider: "codex", product: "openai-api", billing: "api", account: "fixture", credential: { kind: "env", name: "UNUSED" } };
  assert.deepEqual(adapt(body, { profile: api }).input, body.input);
  assert.equal(Object.hasOwn(adapt(body, { profile: api }), "tools"), false);
  const legacy = reverseRequest(renderResponsesHistory(decodePortableHistory(body, "responses"))).body;
  const converted = adapt(body, { protocol: "messages" });
  assert.deepEqual(converted.tools, legacy.tools);
  assert.deepEqual(converted.messages, legacy.messages);
});

test("socketless Responses ingress refuses malformed inline content before simulated dispatch", async () => {
  for (const invalid of [true, false]) {
    const body = bodyWith({ ...inline(), role: invalid ? "user" : "developer" });
    let dispatched = 0, status = 0, text = "";
    const res = Object.assign(new EventEmitter(), {
      destroyed: false, writableEnded: false, headersSent: false,
      writeHead(value: number) { status = value; },
      end(value: string) { text = value; },
    }) as unknown as ServerResponse;
    await writeRoutedHttp({
      context: () => undefined,
      async *events(request) {
        adapt(request);
        dispatched++;
        yield { type: "response.completed", response: { id: "fixture", status: "completed", output: [] } };
      },
    }, noopLogger, systemClock, {} as IncomingMessage, res, body, "codex", "fixture");
    assert.equal(dispatched, invalid ? 0 : 1);
    assert.equal(status, invalid ? 400 : 200);
    if (invalid) assert.equal(JSON.parse(text).error.code, "unsupported_routed_content");
    else assert.equal(JSON.parse(text).status, "completed");
  }
});
