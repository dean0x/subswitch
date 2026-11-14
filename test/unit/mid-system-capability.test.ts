/** Fabricated local errors only; no native client, auth or provider calls. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { ClaudeCache } from "../../src/claude-cache.js";
import { ReverseState } from "../../src/claude-state.js";
import { noopLogger } from "../../src/logger.js";
import { adaptRequest } from "../../src/routing/request-adapter.js";
import { decodePortableHistory } from "../../src/routing/portable-history.js";
import { writeRoutingError, writeRoutedHttp } from "../../src/routing/http-ingress.js";
import { systemClock } from "../../src/routing/clock.js";
import {
  MidConversationSystemError, RoutingError,
  type AccessProfile, type Item, type WireProtocol,
} from "../../src/routing/routing-types.js";

const profile: AccessProfile = {
  provider: "kimi", product: "kimi-code", region: "global", billing: "subscription",
  account: "fabricated", credential: { kind: "env", name: "FABRICATED_ONLY" },
};
function adapt(body: Item, priorOwner?: string, stage = new ClaudeCache()) {
  return adaptRequest({
    profile, target: { profile: "fixture", model: "kimi-for-coding", effort: "high" },
    body, ingress: "messages", protocol: "messages",
    transcript: decodePortableHistory(body, "messages"), stage,
    state: new ReverseState(undefined, undefined, stage),
    owner: "owner", conversation: "conversation", sessionId: "session", priorOwner,
  }).outbound;
}

test("only actual later-system placement has the typed capability cause without editing the caller", () => {
  const body = {
    system: "Initial instruction",
    messages: [{ role: "user", content: "History" }, { role: "system", content: "Later instruction" }],
    tools: [{ name: "Read", input_schema: { type: "object" } }],
  };
  const before = structuredClone(body);
  assert.throws(() => adapt(body), (error: unknown) =>
    error instanceof MidConversationSystemError && error.status === 400 &&
    error.code === "unsupported_mid_conversation_system");
  assert.deepEqual(body, before);
  const transcript = decodePortableHistory(body, "messages");
  assert.deepEqual(transcript.entries.map(entry => entry.role), ["user", "system"]);
  assert.equal(transcript.instructions, body.system);
});

test("top-level and leading system instructions preserve order, tools and history", () => {
  const body = {
    system: "Initial instruction", tools: [{ name: "Read", input_schema: { type: "object" } }],
    messages: [{ role: "system", content: "Leading instruction" }, { role: "user", content: "History" }],
  };
  const before = structuredClone(body), outbound = adapt(body);
  assert.deepEqual(outbound.system, [{ type: "text", text: body.system }, { type: "text", text: "Leading instruction" }]);
  assert.deepEqual(outbound.messages, [body.messages[1]]);
  assert.deepEqual(outbound.tools, body.tools);
  assert.deepEqual(body, before);
  const compatible = { ...body, messages: [body.messages[1]] };
  assert.deepEqual(adapt(compatible).messages, compatible.messages);
});

test("unowned thinking and generic incomplete tool continuity retain their original failures", () => {
  const cases: [Item, string][] = [
    [{ messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "fabricated", signature: "fabricated" }] }] }, "foreign_opaque_state"],
    [{ messages: [{ role: "assistant", content: [{ type: "tool_use", id: "unanswered", name: "Read", input: {} }] }] }, "continuity_unavailable"],
  ];
  for (const [body, code] of cases) assert.throws(() => adapt(body), (error: unknown) =>
    error instanceof RoutingError && !(error instanceof MidConversationSystemError) &&
    error.code === code && error.status === 409);
});

test("later system instructions cannot hide unowned or tampered thinking", () => {
  for (const recorded of [
    { type: "thinking", thinking: "fabricated", signature: "fabricated" },
    { type: "redacted_thinking", data: "fabricated" },
  ]) for (const tampered of [false, true]) {
    const stage = new ClaudeCache();
    if (tampered) stage.put("snapshot", "signature:owner:conversation:fabricated", { request: {}, input: [recorded] });
    const block = tampered ? { ...recorded, thinking: "tampered" } : recorded;
    const body = { messages: [
      { role: "assistant", content: [block] },
      { role: "user", content: "continue" },
      { role: "system", content: "Later instruction" },
    ] };
    const before = structuredClone(body);
    assert.throws(() => adapt(body, undefined, stage), (error: unknown) =>
      error instanceof RoutingError && !(error instanceof MidConversationSystemError) &&
      error.code === "foreign_opaque_state" && error.status === 409);
    assert.deepEqual(body, before);
    if (tampered) assert.deepEqual(stage.get("snapshot", "signature:owner:conversation:fabricated")?.input, [recorded]);
  }
});

test("recorded thinking owner switches retain continuity refusal even with a later system instruction", () => {
  const block = { type: "thinking", thinking: "fabricated", signature: "fabricated" };
  const stage = new ClaudeCache();
  stage.put("snapshot", "signature:owner:conversation:fabricated", { request: {}, input: [block] });
  for (const laterSystem of [false, true]) {
    const body = { messages: [
      { role: "assistant", content: [block] }, { role: "user", content: "continue" },
      ...(laterSystem ? [{ role: "system", content: "Later instruction" }] : []),
    ] };
    const before = structuredClone(body);
    assert.throws(() => adapt(body, "other-owner", stage), (error: unknown) =>
      error instanceof RoutingError && !(error instanceof MidConversationSystemError) &&
      error.code === "continuity_unavailable" && error.status === 409);
    assert.deepEqual(body, before);
    if (laterSystem) assert.throws(() => adapt(body, "owner", stage), (error: unknown) =>
      error instanceof MidConversationSystemError && error.status === 400);
    else assert.deepEqual(adapt(body, "owner", stage).messages, body.messages);
    assert.deepEqual(body, before);
  }
});

async function serialized(error: unknown, protocol: WireProtocol, committed = false) {
  const server = createServer((req, res) => {
    if (!committed) writeRoutingError(res, protocol, error, noopLogger, systemClock);
    else void writeRoutedHttp({
      context: () => undefined,
      async *events() { yield { type: "message_start", message: {} }; throw error; },
    }, noopLogger, systemClock, req, res, { stream: true }, "claude-code", "fixture");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}`);
    return { status: response.status, text: await response.text() };
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

test("continuity, owner, credential and lookalike codes never acquire the capability token", async () => {
  for (const code of ["continuity_unavailable", "foreign_opaque_state", "credential_owner_changed", "credential_binding_mismatch", "unsupported_mid_conversation_system"]) {
    const response = await serialized(new RoutingError(code, 409), "messages");
    assert.equal(response.status, 409);
    assert.deepEqual(JSON.parse(response.text), { type: "error", error: { type: "api_error", message: code } });
  }
  const codex = await serialized(new MidConversationSystemError(), "responses");
  assert.equal(codex.status, 400);
  assert.doesNotMatch(codex.text, /capability_rejected/);
});

test("a committed Messages stream retains ordinary failure rather than inviting capability replay", async () => {
  const response = await serialized(new MidConversationSystemError(), "messages", true);
  assert.equal(response.status, 200);
  assert.match(response.text, /"type":"api_error","message":"unsupported_mid_conversation_system"/);
  assert.doesNotMatch(response.text, /capability_rejected/);
});
