import assert from "node:assert/strict";
import { it } from "node:test";
import { ClaudeCache } from "../../src/claude-cache.js";
import { ReverseState } from "../../src/claude-state.js";
import { decodePortableHistory } from "../../src/routing/portable-history.js";
import { adaptRequest } from "../../src/routing/request-adapter.js";
import type { AccessProfile, Item, WireProtocol } from "../../src/routing/routing-types.js";

const profileFields = {
  billing: "subscription",
  account: "fixture",
  credential: { kind: "native-oauth", authFile: "/fabricated/never-read.json" },
} as const;
const destinations = {
  messages: {
    profile: { ...profileFields, provider: "claude", product: "claude-code" },
    model: "claude-fable-5-2",
  },
  responses: {
    profile: { ...profileFields, provider: "codex", product: "chatgpt-codex" },
    model: "gpt-6.2-sol",
  },
} satisfies Record<WireProtocol, { profile: AccessProfile; model: string }>;

function nativeRequest(body: Item, protocol: WireProtocol, effort = "high") {
  const { profile, model } = destinations[protocol];
  const stage = new ClaudeCache();
  return {
    profile,
    target: { profile: "fixture", model, effort },
    body,
    ingress: protocol,
    protocol,
    transcript: decodePortableHistory(body, protocol),
    stage,
    state: new ReverseState(undefined, undefined, stage),
    owner: "owner",
    conversation: "conversation",
    sessionId: "session",
  } satisfies Parameters<typeof adaptRequest>[0];
}

const functionTool = (name: string) => ({
  type: "function",
  name,
  parameters: { type: "object", properties: {} },
});
const inlineTools = (tools: unknown) => ({ type: "additional_tools", tools });
const userTurn = (content: string) => ({ role: "user", content });
const toolCall = () => ({ type: "function_call", call_id: "call", name: "read", arguments: "{}" });
const toolResult = () => ({ type: "function_call_output", call_id: "call", output: "done" });
const foreignOpaqueState = { code: "foreign_opaque_state", status: 409 };
const unsupportedContent = { code: "unsupported_routed_content", status: 400 };

function opaqueRequest(withSnapshot: boolean) {
  const reasoning = { type: "reasoning", id: "reason", encrypted_content: "fixture-ciphertext" };
  const body = { input: [inlineTools([functionTool("read")]), reasoning, userTurn("Continue")] };
  const request = nativeRequest(body, "responses");
  if (withSnapshot) {
    request.stage.put("snapshot", `opaque:${request.owner}:${request.conversation}:${reasoning.encrypted_content}`, {
      request: {},
      input: [reasoning],
    });
  }
  return request;
}

// src/routing/request-adapter.ts:111-128 checks the snapshot scope.
it("rejects Responses opaque reasoning without a snapshot", () => {
  const request = opaqueRequest(false);
  assert.throws(() => adaptRequest(request), foreignOpaqueState);
});

it("accepts Responses opaque reasoning with its matching snapshot", () => {
  const request = opaqueRequest(true);
  const input = structuredClone(request.body["input"]);
  const { outbound } = adaptRequest({ ...request, priorOwner: request.owner });
  assert.deepEqual(outbound["input"], input);
});

it("rejects Responses opaque reasoning from another conversation", () => {
  const request = opaqueRequest(true);
  assert.throws(() => adaptRequest({ ...request, conversation: "other" }), foreignOpaqueState);
});

// src/routing/request-adapter.ts:106-107 refuses an owner switch.
it("rejects a Responses opaque reasoning owner switch", () => {
  const request = opaqueRequest(true);
  assert.throws(() => adaptRequest({ ...request, priorOwner: "other" }), {
    code: "continuity_unavailable",
    status: 409,
  });
});

// src/routing/portable-history.ts:80-85 refuses encrypted function arguments.
it("rejects non-empty encrypted_function_args on a Responses call", () => {
  const body = { input: [{ ...toolCall(), encrypted_function_args: ["fixture-ciphertext"] }, toolResult()] };
  assert.throws(() => decodePortableHistory(body, "responses"), foreignOpaqueState);
});

// src/routing/portable-history.ts:66-79,113-116,154-170 checks item and declaration types.
const invalidResponsesHistory = [
  ["missing inline tools", { type: "additional_tools" }],
  ["non-array inline tools", inlineTools({})],
  ["a null inline declaration", inlineTools([null])],
  ["an inline hosted tool", inlineTools([{ type: "web_search" }])],
  ["an unknown inline tool variant", inlineTools([{ type: "tool_search", name: "search" }])],
  ["non-array namespace tools", inlineTools([{ type: "namespace", name: "fixture", tools: {} }])],
  ["an unknown history item", { type: "future_item", role: "developer", tools: [functionTool("read")] }],
] as const;
for (const [name, item] of invalidResponsesHistory) {
  it(`rejects ${name} in Responses history`, () => {
    const body = { input: [userTurn("Start"), item, userTurn("Continue")] };
    assert.throws(() => decodePortableHistory(body, "responses"), unsupportedContent);
  });
}

// src/routing/portable-history.ts:55-63 requires unique call and result IDs.
const duplicateResponsesHistory = [
  ["call", [toolCall(), toolCall(), toolResult()]],
  ["result", [toolCall(), toolResult(), toolResult()]],
] as const;
for (const [name, history] of duplicateResponsesHistory) {
  it(`rejects a duplicate Responses tool ${name} with inline tools`, () => {
    const body = { input: [inlineTools([functionTool("read")]), ...history] };
    assert.throws(() => decodePortableHistory(body, "responses"), unsupportedContent);
  });
}

// src/routing/portable-history.ts:113-116 aggregates tools for src/routing/shared-routing.ts:279.
it("lists top-level tools before inline Responses tools in declaration order", () => {
  const [top, first, second, third] = [functionTool("top"), functionTool("first"), functionTool("second"), functionTool("third")];
  const body = {
    tools: [top],
    input: [userTurn("Start"), inlineTools([first, second]), userTurn("Continue"), inlineTools([third])],
  };
  const expected = structuredClone([top, first, second, third]);
  assert.deepEqual(decodePortableHistory(body, "responses").tools, expected);
});

// Both fixture models accept these efforts in their catalogs.
for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
  // src/routing/request-adapter.ts:192-196 sets the route effort in Messages output_config.
  it(`sends Claude route effort ${effort} and preserves caller instructions, tools, and history`, () => {
    const body = {
      model: "work",
      max_tokens: 256,
      system: "Caller instruction",
      messages: [userTurn("Caller history")],
      tools: [{ name: "read", input_schema: { type: "object", properties: {} } }],
      output_config: { effort: "medium" },
    };
    const before = structuredClone(body);
    const { outbound } = adaptRequest(nativeRequest(body, "messages", effort));
    assert.deepEqual(outbound["output_config"], { effort });
    assert.deepEqual(outbound["system"], before.system);
    assert.deepEqual(outbound["tools"], before.tools);
    assert.deepEqual(outbound["messages"], before.messages);
    assert.deepEqual(body, before);
  });

  // src/routing/request-adapter.ts:190 sets the route effort in Responses reasoning.
  it(`sends Codex route effort ${effort} and preserves caller instructions, tools, and history`, () => {
    const body = {
      model: "work",
      instructions: "Caller instruction",
      input: [userTurn("Caller history"), toolCall(), toolResult()],
      tools: [functionTool("read")],
      reasoning: { effort: "none" },
    };
    const before = structuredClone(body);
    const { outbound } = adaptRequest(nativeRequest(body, "responses", effort));
    assert.deepEqual(outbound["reasoning"], { effort });
    assert.deepEqual(outbound["instructions"], before.instructions);
    assert.deepEqual(outbound["tools"], before.tools);
    assert.deepEqual(outbound["input"], before.input);
    assert.deepEqual(body, before);
  });
}
