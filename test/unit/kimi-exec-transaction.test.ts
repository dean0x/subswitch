/** Disabled transaction helpers only; fabricated data, no transport or credentials. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { ClaudeCache } from "../../src/claude-cache.js";
import { StagedCache } from "../../src/routing/replay-cache.js";
import { KIMI_EXEC_GRAMMAR } from "../../src/routing/kimi-exec-codec.js";
import { prepareKimiExecTransaction } from "../../src/routing/kimi-exec-transaction.js";
import { RoutingError, type AccessProfile, type Item } from "../../src/routing/routing-types.js";

const profile: AccessProfile = { provider: "kimi", product: "kimi-code", region: "global", billing: "subscription",
  account: "fabricated", credential: { kind: "native-oauth", authFile: "/fabricated/never-read" } };
const declaration = () => ({ type: "custom", name: "exec", description: "Caller owns tools and history.",
  format: { type: "grammar", syntax: "lark", definition: KIMI_EXEC_GRAMMAR } });
const call = (callId = "call1"): Item => ({ type: "custom_tool_call", id: "id-" + callId,
  call_id: callId, name: "exec", status: "completed", input: "// @exec: caller-owned\r\n\u{1f600}\0" });
const body = (): Item => ({ tools: [{ type: "function", name: "wait" }, declaration()],
  instructions: "Caller", input: [{ role: "user", content: "continue" }] });
const options = (stage = new StagedCache(new ClaudeCache())) => ({ body: body(), profile,
  target: { profile: "fixture", model: "kimi-for-coding", effort: "high" as const },
  ingress: "responses" as const, protocol: "responses" as const, stage,
  owner: "owner-generation-bound", conversation: "conversation", credentialGeneration: "generation1", attempt: "attempt1" });
const failContinuity = (fn: () => unknown) => assert.throws(fn,
  (error: unknown) => error instanceof RoutingError && error.code === "continuity_unavailable" && error.status === 409);

test("request helper replaces exact declaration in place, preserving caller instructions/tools/inline/history", () => {
  const original = body();
  (original["input"] as Item[]).push({ type: "additional_tools", role: "developer", tools: [{ type: "function", name: "later" }] });
  const before = structuredClone(original), result = prepareKimiExecTransaction({ ...options(), body: original })!;
  assert.deepEqual(original, before);
  assert.deepEqual(result.outbound["instructions"], original["instructions"]);
  assert.deepEqual(result.outbound["input"], original["input"]);
  const tools = result.outbound["tools"] as Item[];
  assert.deepEqual(tools[0], (original["tools"] as Item[])[0]);
  assert.deepEqual(tools[1], { type: "function", name: "exec", description: declaration().description, strict: true,
    parameters: { type: "object", properties: { input: { type: "string", description: "Exact caller-owned source, including any pragma." } },
      required: ["input"], additionalProperties: false } });
});
for (const toolChoice of [undefined, "auto", "none", "required", { type: "custom", name: "exec" }, { type: "function", name: "wait" }]) {
  test(`supported tool choice ${JSON.stringify(toolChoice)}`, () => {
    const original = { ...body(), ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }) };
    const result = prepareKimiExecTransaction({ ...options(), body: original })!;
    assert.deepEqual(result.outbound["tool_choice"], typeof toolChoice === "object" && toolChoice.name === "exec"
      ? { type: "function", name: "exec" } : toolChoice);
  });
}
for (const toolChoice of [{ type: "function", name: "exec" }, { type: "custom", name: "exec", namespace: "" },
  { type: "allowed_tools", tools: [{ type: "custom", name: "exec" }] }, "unknown", null]) {
  test(`unsupported tool choice refuses ${JSON.stringify(toolChoice)}`, () => {
    assert.throws(() => prepareKimiExecTransaction({ ...options(), body: { ...body(), tool_choice: toolChoice } }));
  });
}
test("exact selected binding only; no opt-in or routing entrypoint is introduced", () => {
  const base = options();
  for (const change of [{ profile: { ...profile, region: "mainland-cn" as const } },
    { profile: { ...profile, credential: { kind: "env" as const, name: "FABRICATED" } } },
    { profile: { ...profile, billing: "api" as const } }, { target: { ...base.target, model: "other" } },
    { ingress: "messages" as const }, { protocol: "messages" as const }]) {
    assert.equal(prepareKimiExecTransaction({ ...base, ...change }), undefined);
  }
  assert.equal(prepareKimiExecTransaction({ ...base, body: { tools: [{ type: "function", name: "read" }] } }), undefined);
});

function committed() {
  const shared = new ClaudeCache(), stage = new StagedCache(shared), first = options(stage);
  const result = prepareKimiExecTransaction(first)!;
  result.transaction.stageValidatedCalls([call()]);
  assert.equal(shared.size, 0, "associations remain attempt-local until commit");
  stage.commit();
  const replay = { ...options(new StagedCache(shared)), attempt: "attempt2", body: { ...body(), input: [call(),
    { type: "custom_tool_call_output", call_id: "call1", id: "result", output: [{ type: "text", text: "done" }], is_error: true }] } };
  return { shared, stage, first, replay };
}
test("committed exact association maps history and result without mutating native originals", () => {
  const { replay } = committed(), before = structuredClone(replay.body);
  const result = prepareKimiExecTransaction(replay)!;
  const entries = result.outbound["input"] as Item[];
  assert.equal(entries[0]?.["type"], "function_call");
  assert.equal(entries[0]?.["arguments"], JSON.stringify({ input: call()["input"] }));
  assert(!Object.hasOwn(entries[0]!, "input"));
  assert.deepEqual(entries[1], { ...before["input"][1], type: "function_call_output" });
  assert.deepEqual(replay.body, before);
});
test("optional original id/status may be absent, while source/call identity must still match", () => {
  const { replay } = committed();
  const entries = replay.body["input"] as Item[]; delete entries[0]!["id"]; delete entries[0]!["status"];
  assert.equal((prepareKimiExecTransaction(replay)!.outbound["input"] as Item[])[0]?.["type"], "function_call");
});
for (const mutation of [{ input: "changed" }, { id: "changed" }, { status: "in_progress" }, { call_id: "foreign" },
  { namespace: "" }, { name: "other" }, { type: "function_call" }, { encrypted_function_args: ["opaque"] }]) {
  test(`history refuses conflicting semantic identity ${JSON.stringify(mutation)}`, () => {
    const { replay } = committed(); Object.assign((replay.body["input"] as Item[])[0]!, mutation);
    failContinuity(() => prepareKimiExecTransaction(replay));
  });
}
test("current fingerprint, owner, conversation, generation and cold cache are required at each replay", () => {
  for (const field of ["owner", "conversation", "credentialGeneration"] as const) {
    const { replay } = committed(); failContinuity(() => prepareKimiExecTransaction({ ...replay, [field]: "changed" }));
  }
  const { replay } = committed(); (((replay.body as Item)["tools"] as Item[])[1]!)["description"] = "changed description";
  failContinuity(() => prepareKimiExecTransaction(replay));
  failContinuity(() => prepareKimiExecTransaction({ ...committed().replay, stage: new StagedCache(new ClaudeCache()) }));
});
test("pending or abandoned attempt associations are unavailable to a different attempt", () => {
  const shared = new ClaudeCache(), stage = new StagedCache(shared);
  prepareKimiExecTransaction(options(stage))!.transaction.stageValidatedCalls([call()]);
  failContinuity(() => prepareKimiExecTransaction({ ...options(new StagedCache(shared)), body: { ...body(), input: [call()] } }));
  assert.equal(shared.size, 0);
});
test("conflicting or repeated call ids refuse rather than overwrite a committed association", () => {
  const { replay, shared } = committed();
  const txn = prepareKimiExecTransaction({ ...replay, body: body() })!.transaction;
  failContinuity(() => txn.stageValidatedCalls([call()]));
  assert.equal(shared.size, 1);
  const fresh = prepareKimiExecTransaction(options())!.transaction;
  failContinuity(() => fresh.stageValidatedCalls([call(), call()]));
});
test("association snapshots survive caller mutation without acquiring new semantic identity", () => {
  const shared = new ClaudeCache(), stage = new StagedCache(shared), original = call();
  prepareKimiExecTransaction(options(stage))!.transaction.stageValidatedCalls([original]);
  original["input"] = "changed after staging"; stage.commit();
  const replay = { ...options(new StagedCache(shared)), body: { ...body(), input: [call()] } };
  assert.equal((prepareKimiExecTransaction(replay)!.outbound["input"] as Item[])[0]?.["type"], "function_call");
});
test("failed shared cache preflight publishes no partial associations", () => {
  const shared = new ClaudeCache({ maxEntries: 1, maxBytes: 100000 }), stage = new StagedCache(shared);
  prepareKimiExecTransaction(options(stage))!.transaction.stageValidatedCalls([call("a"), call("b")]);
  assert.throws(() => stage.commit(), (error: unknown) =>
    error instanceof RoutingError && error.code === "continuation_store_full" && error.status === 503);
  assert.equal(shared.size, 0);
});
for (const sameSource of [false, true]) {
  test(`competing staged commits preserve the first identity and reject the whole second batch (sameSource=${sameSource})`, () => {
    const shared = new ClaudeCache(), a = new StagedCache(shared), b = new StagedCache(shared);
    const originalSnapshot = { request: { text: "original" }, input: [] };
    shared.put("snapshot", "existing", originalSnapshot);
    const first = options(a), firstCall = call("overlap");
    const secondCall = { ...firstCall, input: sameSource ? firstCall["input"] : "conflicting source" };
    const second = { ...options(b), attempt: "attempt2" };
    prepareKimiExecTransaction(first)!.transaction.stageValidatedCalls([firstCall]);
    b.put("snapshot", "existing", { request: { text: "unpublished" }, input: [] });
    b.put("adapted", "unpublished", true);
    b.put("replay", "unpublished", { content: [], output: [] });
    prepareKimiExecTransaction(second)!.transaction.stageValidatedCalls([call("fresh"), secondCall]);
    a.commit();
    const id = createHash("sha256").update("subswitch.kimi-exec-association\0")
      .update(JSON.stringify([first.owner, first.conversation, firstCall["call_id"]])).digest("hex");
    const original = shared.get("kimiExec", id), bytes = shared.byteSize;
    assert.equal(original?.attempt, "attempt1");
    failContinuity(() => b.commit());
    assert.equal(shared.get("kimiExec", id), original);
    assert.equal(shared.get("snapshot", "existing"), originalSnapshot);
    assert.equal(shared.get("adapted", "unpublished"), undefined);
    assert.equal(shared.get("replay", "unpublished"), undefined);
    assert.equal(shared.size, 2);
    assert.equal(shared.byteSize, bytes);
    const replay = (entry: Item) => prepareKimiExecTransaction({ ...options(new StagedCache(shared)),
      attempt: "later-replay", body: { ...body(), input: [entry] } });
    assert.equal((replay(firstCall)!.outbound["input"] as Item[])[0]?.["arguments"], JSON.stringify({ input: firstCall["input"] }));
    if (!sameSource) failContinuity(() => replay(secondCall));
    failContinuity(() => replay(call("fresh")));
  });
}
test("a rejected local duplicate batch records no writes for later shared publication", () => {
  const shared = new ClaudeCache(), stage = new StagedCache(shared), value = {
    codecVersion: "kimi-exec-v1", declarationFingerprint: "fixture", owner: "owner", conversation: "conversation",
    credentialGeneration: "generation", attempt: "attempt", callId: "call", item: call(),
  };
  stage.put("adapted", "prior", true);
  const bytes = stage.byteSize;
  assert.throws(() => stage.putBatch([
    { kind: "snapshot", id: "unpublished", value: { request: {}, input: [] } },
    { kind: "kimiExec", id: "duplicate", value },
    { kind: "kimiExec", id: "duplicate", value },
  ]), /continuity_unavailable/);
  assert.equal(stage.size, 1);
  assert.equal(stage.byteSize, bytes);
  assert.equal(stage.get("kimiExec", "duplicate"), undefined);
  assert.equal(stage.get("snapshot", "unpublished"), undefined);
  stage.commit();
  assert.equal(shared.size, 1);
  assert.equal(shared.byteSize, bytes);
  assert.equal(shared.get("adapted", "prior"), true);
});
test("local batch preflight failure records neither values nor later shared writes", () => {
  const shared = new ClaudeCache(), stage = new StagedCache(shared), cycle: Item = {}; cycle["self"] = cycle;
  assert.throws(() => stage.putBatch([
    { kind: "snapshot", id: "first", value: { request: {}, input: [] } },
    { kind: "snapshot", id: "second", value: { request: cycle, input: [] } },
  ]));
  assert.equal(stage.get("snapshot", "first"), undefined);
  stage.commit(); assert.equal(shared.size, 0);
});
test("unrelated histories and custom outputs retain their types and values", () => {
  const input = [{ type: "custom_tool_call", call_id: "patch", name: "apply_patch", input: "caller patch" },
    { type: "custom_tool_call_output", call_id: "patch", output: "done" }];
  const result = prepareKimiExecTransaction({ ...options(), body: { ...body(), input } })!;
  assert.deepEqual(result.outbound["input"], input);
});
