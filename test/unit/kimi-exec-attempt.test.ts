/** Fabricated transports/auth only. No credentials, sockets, native clients or tools. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ClaudeCache } from "../../src/claude-cache.js";
import { StagedCache } from "../../src/routing/replay-cache.js";
import { KimiExecPending } from "../../src/routing/kimi-exec-pending.js";
import { KIMI_EXEC_GRAMMAR } from "../../src/routing/kimi-exec-codec.js";
import { RoutedAttempts, AttemptFailure, type RoutedPrepared } from "../../src/routing/routed-attempt.js";
import { ProfileAuth, type BoundCredential } from "../../src/routing/profile-auth.js";
import { SharedRouting } from "../../src/routing/shared-routing.js";
import { loadConfig } from "../../src/config.js";
import { noopLogger } from "../../src/logger.js";
import { systemClock } from "../../src/routing/clock.js";
import { allowanceScope, RoutingError, type AccessProfile, type Item } from "../../src/routing/routing-types.js";

const profile: AccessProfile = { provider: "kimi", product: "kimi-code", region: "global", billing: "subscription",
  account: "fabricated", credential: { kind: "native-oauth", authFile: "/fabricated/never-read" } };
const target = { profile: "fixture", model: "kimi-for-coding", effort: "high" as const };
const declaration = () => ({ type: "custom", name: "exec", description: "Caller owns ALL_TOOLS.\r\n",
  format: { type: "grammar", syntax: "lark", definition: KIMI_EXEC_GRAMMAR } });
const body = (): Item => ({ model: "work", tools: [declaration(), { type: "function", name: "wait" }],
  instructions: "Caller instructions", input: [{ role: "user", content: "work" }] });
const source = "// @exec: caller data\r\n\u{1f600}e\u0301\0 ";
const call = (id = "one", input = source): Item => ({ type: "function_call", id, call_id: "call-" + id,
  name: "exec", status: "completed", arguments: JSON.stringify({ input }) });
function events(output: Item[] = [call()]): Item[] {
  return [{ type: "response.created", sequence_number: 999, response: { id: "provider", status: "in_progress", output: [] } },
    ...output.flatMap((item, index) => item["type"] === "function_call" ? [
      { type: "response.output_item.added", output_index: index, item: { ...item, status: "in_progress", arguments: "" } },
      { type: "response.function_call_arguments.done", item_id: item["id"], output_index: index, arguments: item["arguments"] },
      { type: "response.output_item.done", output_index: index, item },
    ] : []),
    { type: "response.completed", response: { id: "provider", status: "completed", output } }];
}
const response = (items: Item[]) => new Response(items.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""),
  { headers: { "content-type": "text/event-stream" } });
class FabricatedAuth extends ProfileAuth {
  generation = "generation1";
  refreshCount = 0;
  changeOnRefresh = false;
  refuse = false;
  constructor() { super({ fixture: profile }, noopLogger, {}); }
  override has() { return true; }
  override async get(name = "fixture"): Promise<BoundCredential> { return { provider: "kimi", profile: name, generation: this.generation,
    binding: "fabricated", authHeaders: { authorization: "Bearer fabricated-not-a-credential" } }; }
  override validate() { if (this.refuse) throw new RoutingError("credential_binding_mismatch", 503); }
  override identity() { return { "user-agent": "subswitch/fabricated" }; }
  override scope(credential: BoundCredential) { return allowanceScope({ ...profile, account: credential.profile }); }
  override async refresh() { this.refreshCount++; if (this.changeOnRefresh) this.generation = "generation2"; return this.get(); }
}
function fixture(options: { disabled?: boolean; reply?: (body: Item, index: number) => Response;
  cache?: ClaudeCache; prepare?: (request: Parameters<RoutedAttempts["prepare"]>[0]) => void;
  prepared?: (ready: RoutedPrepared) => void; pending?: () => KimiExecPending;
  beforeDispatch?: ConstructorParameters<typeof RoutedAttempts>[5]; fallback?: boolean; allowTransport?: boolean } = {}) {
  const auth = new FabricatedAuth(), pendings: KimiExecPending[] = [], sent: Item[] = [];
  const loaded = loadConfig({ configPath: "/fabricated/config.json", env: {}, readFile: () => JSON.stringify({
    configVersion: 2, accessProfiles: { fixture: profile, backup: { ...profile, account: "fabricated-backup" } },
    routes: { work: { clients: ["codex"], primary: target,
      fallbacks: options.fallback ? [{ ...target, profile: "backup" }] : [], affinity: "native-or-explicit",
      transientTriggers: options.allowTransport ? ["transport"] : [] } }, codexIngress: { enabled: true } }) });
  if (!loaded.ok) throw new Error(loaded.error.message);
  const fetchImpl: typeof fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as Item; sent.push(request);
    assert.equal(init?.redirect, "error");
    assert.equal((init?.headers as Record<string, string>)["user-agent"], "subswitch/fabricated");
    return options.reply?.(request, sent.length) ?? response(events());
  };
  const router = new SharedRouting(loaded.value.config, noopLogger, systemClock, fetchImpl, {});
  const attempts = new RoutedAttempts(auth, noopLogger, fetchImpl, systemClock, "subswitch", options.beforeDispatch,
    options.disabled ? undefined : () => { const pending = options.pending?.() ?? new KimiExecPending(); pendings.push(pending); return pending; }, router.actions);
  if (options.cache) Object.defineProperty(attempts, "replay", { value: options.cache });
  Object.defineProperty(router, "attempts", { value: attempts });
  const prepare = attempts.prepare.bind(attempts);
  attempts.prepare = async request => { options.prepare?.(request); const ready = await prepare(request); options.prepared?.(ready); return ready; };
  const controller = new AbortController();
  const context = options.fallback ? router.actions.context(router.actions.create("codex", "fabricated-thread").id, "codex") : undefined;
  const iterate = (request = body()) => router.events(request, "codex", "work", controller.signal, context);
  return { router, attempts, auth, sent, pendings, controller, iterate, async run(request = body()) {
    const seen: Item[] = []; let error: unknown;
    try { for await (const event of iterate(request)) seen.push(event); }
    catch (caught) { error = caught; }
    return { seen, error };
  } };
}
function code(error: unknown, expected: string) { assert(error instanceof RoutingError, String(error)); assert.equal(error.code, expected); }

const ordinaryHistory = (length: number): Item[] => Array.from({ length }, () => ({ role: "user", content: "ordinary" }));
const inlineTools = (tools: Item[]): Item => ({ type: "additional_tools", role: "developer", tools });
const toolNamespace = (tools: Item[]): Item => ({ type: "namespace", name: "functions", description: "Caller tools", tools });
for (const [label, extra] of Object.entries({
  "1024 ordinary entries": { input: ordinaryHistory(1024) },
  "1025 ordinary entries": { input: ordinaryHistory(1025) },
  "8192 ordinary entries and empty tools": { tools: [], input: ordinaryHistory(8192) },
  "late unrelated inline declaration": { input: [...ordinaryHistory(1024), inlineTools([{ type: "function", name: "read" }])] },
  "1025 empty temporal declarations": { input: Array.from({ length: 1025 }, () => inlineTools([])) },
  "nested unrelated inventory beyond codec total limit": { tools: [
    toolNamespace(Array.from({ length: 1024 }, () => ({ type: "function", name: "read" }))),
    { ...toolNamespace([{ type: "function", name: "wait" }]), name: "other" },
  ], input: ordinaryHistory(1) },
})) test(`KI-1 actual noexec default and optin preserve ${label}`, async () => {
  const request: Item = { model: "work", stream: true, ...extra }, before = structuredClone(request);
  const disabled = fixture({ disabled: true, reply: () => response(events([])) });
  const enabled = fixture({ reply: () => response(events([])), prepared(ready) { assert.equal(ready.orderedResponsesSuffix, undefined); } });
  try {
    const original = await disabled.run(request), opted = await enabled.run(request);
    assert.equal(original.error, undefined); assert.equal(disabled.sent.length, 1);
    assert.equal(opted.error, undefined); assert.equal(enabled.sent.length, 1);
    assert.deepEqual(enabled.sent, disabled.sent);
    assert.deepEqual(opted.seen.map(e => e["type"]), original.seen.map(e => e["type"]));
    assert.deepEqual((opted.seen.at(-1)!["response"] as Item)["output"], []);
    assert.deepEqual(request, before); assert(enabled.pendings.every(p => p.byteSize === 0));
  } finally { disabled.router.close(); enabled.router.close(); }
});
for (const [label, extra] of Object.entries({
  "late inline-only exec": { input: [...ordinaryHistory(1024), inlineTools([{ type: "function", name: "exec" }])] },
  "late namespaced inline exec": { input: [...ordinaryHistory(1024), inlineTools([toolNamespace([{ type: "function", name: "exec" }])])] },
  "late inline exec collision": { tools: [declaration()], input: [...ordinaryHistory(1024), inlineTools([{ type: "function", name: "exec" }])] },
  "late top-level collision beyond declaration limit": { tools: [
    toolNamespace(Array.from({ length: 1024 }, () => ({ type: "function", name: "read" }))), declaration(), { type: "function", name: "exec" },
  ], input: ordinaryHistory(1) },
  "exec with 1025 ordinary entries": { tools: [declaration()], input: ordinaryHistory(1025) },
})) test(`KI-1 actual potential ${label} still refuses before dispatch`, async () => {
  const request: Item = { model: "work", ...extra }, before = structuredClone(request);
  const disabled = fixture({ disabled: true, reply: () => response(events([])) }), enabled = fixture({ reply: () => response(events([])) });
  try {
    const original = await disabled.run(request); assert.equal(original.error, undefined); assert.equal(disabled.sent.length, 1);
    const opted = await enabled.run(request); code(opted.error, "unsupported_routed_content");
    assert.deepEqual(enabled.sent, []); assert.deepEqual(opted.seen, []);
    assert.deepEqual(request, before); assert(enabled.pendings.every(p => p.byteSize === 0));
  } finally { disabled.router.close(); enabled.router.close(); }
});

for (const streaming of [true, false]) test(`actual SharedRouting exec publication and previous_response_id remain native streaming${streaming}`, async () => {
  const shared = new ClaudeCache(), f = fixture({ cache: shared, reply: (_request, index) => response(events(index === 1 ? [call()] : [])) });
  try {
    const original = { ...body(), stream: streaming }, before = structuredClone(original);
    const first = await f.run(original); assert.equal(first.error, undefined); assert.deepEqual(original, before);
    assert.deepEqual(first.seen.map(e => e["sequence_number"]), first.seen.map((_, i) => i));
    const terminal = first.seen.at(-1)!["response"] as Item, native = (terminal["output"] as Item[])[0]!;
    assert.equal(native["type"], "custom_tool_call"); assert.equal(native["input"], source);
    assert.equal((f.sent[0]!["tools"] as Item[])[0]!["type"], "function");
    assert.equal((f.sent[0]!["tools"] as Item[])[0]!["description"], declaration().description);
    const saved = f.router.continuations.get(String(terminal["id"]), undefined, "work", "responses");
    assert.deepEqual(saved.request, original); assert.equal(saved.output[0]!["type"], "custom_tool_call");
    assert(shared.size > 0, "association committed before executable suffix");
    const next = await f.run({ model: "work", stream: streaming, previous_response_id: terminal["id"],
      input: [{ type: "custom_tool_call_output", call_id: native["call_id"], output: "caller-owned result" }] });
    assert.equal(next.error, undefined);
    const history = f.sent[1]!["input"] as Item[];
    assert.equal(history.find(i => i["type"] === "function_call")!["arguments"], JSON.stringify({ input: source }));
    assert.equal(history.at(-1)!["type"], "function_call_output");
    assert.equal(f.sent[1]!["previous_response_id"], undefined);
    assert(f.pendings.every(p => p.byteSize === 0));
  } finally { f.router.close(); }
});
test("real entrypoint default does not map the declaration or construct pending context", async () => {
  const f = fixture({ disabled: true });
  try { const result = await f.run(); assert.equal(result.error, undefined);
    assert.equal((f.sent[0]!["tools"] as Item[])[0]!["type"], "custom"); assert.deepEqual(f.pendings, []);
  } finally { f.router.close(); }
});
for (const guard of ["opaque", "encrypted", "credential", "owner", "capability"] as const)
  test(`actual attempt original ${guard} guard precedes pending creation and dispatch`, async () => {
    const f = fixture(); const request = body();
    if (guard === "opaque") request["input"] = [{ type: "reasoning", encrypted_content: "foreign" }];
    if (guard === "encrypted") request["input"] = [{ ...call(), encrypted_function_args: ["foreign"] }];
    if (guard === "capability") request["max_output_tokens"] = 0;
    if (guard === "credential") f.auth.refuse = true;
    try {
      await assert.rejects(f.attempts.prepare({ profile, target, body: request, protocol: "responses", conversation: "conversation",
        signal: f.controller.signal, refreshes: new Set(), ...(guard === "owner" ? { expectedOwner: "foreign-owner" } : {}) }));
      assert.deepEqual(f.sent, []); assert.deepEqual(f.pendings, []);
    } finally { f.router.close(); }
  });
for (const fail of ["cache", "continuation", "association"] as const)
  test(`actual route ${fail} failure emits no held suffix or partial association`, async () => {
    const shared = new ClaudeCache({ maxEntries: 10, maxBytes: fail === "cache" ? 1 : 1000000 }, true);
    const f = fixture({ cache: shared });
    if (fail === "continuation") f.router.continuations.preparePut = () => { throw new RoutingError("continuation_store_full", 503); };
    let first: Awaited<ReturnType<typeof f.run>> | undefined;
    try {
      if (fail === "association") { first = await f.run(); assert.equal(first.error, undefined); }
      const before = shared.size, result = await f.run();
      assert(result.error); assert.deepEqual(result.seen.map(e => e["type"]), ["response.created"]);
      assert.equal(shared.size, before); assert(f.pendings.every(p => p.byteSize === 0));
      if (fail === "association") code(result.error, "continuity_unavailable");
    } finally { f.router.close(); }
  });
for (const change of [false, true]) test(`actual nativeOAuth401 preserves dispatch count and lineage change${change}`, async () => {
  const f = fixture({ reply: (_request, index) => index === 1 ? new Response("{}", { status: 401 }) : response(events()) });
  f.auth.changeOnRefresh = change;
  try { const result = await f.run(); assert.equal(f.auth.refreshCount, 1);
    if (change) { code(result.error, "credential_owner_changed"); assert.equal(f.sent.length, 1); }
    else { assert.equal(result.error, undefined); assert.equal(f.sent.length, 2); assert.deepEqual(f.sent[0], f.sent[1]); }
    assert(f.pendings.every(p => p.byteSize === 0));
  } finally { f.router.close(); }
});
test("actual route malformed arguments fails after prefix without publishing or retry", async () => {
  const invalid = call(); invalid["arguments"] = '{"input":"a","input":"b"}';
  const shared = new ClaudeCache(), f = fixture({ cache: shared, reply: () => response(events([invalid])) });
  try { const result = await f.run(); assert(result.error); assert.deepEqual(result.seen.map(e => e["type"]), ["response.created"]);
    assert.equal(f.sent.length, 1); assert.equal(shared.size, 0); assert.equal(f.pendings[0]!.byteSize, 0);
  } finally { f.router.close(); }
});

test("staged accounting retains actual entries and write envelopes until disposal", () => {
  const shared = new ClaudeCache(), stage = new StagedCache(shared), pending = new KimiExecPending(), other = pending.reserve(73);
  const value = { request: {}, input: [{ type: "reasoning", encrypted_content: "fabricated-opaque" }] };
  stage.put("snapshot", "id", value); stage.attachPending(pending);
  const key = "snapshot:id", size = (v: unknown) => Buffer.byteLength(JSON.stringify(v)) + 1;
  const bytes = Buffer.byteLength(JSON.stringify(value)) + Buffer.byteLength(key);
  assert.equal(pending.byteSize, 73 + size([key, { kind: "snapshot", value, bytes }]) + size([key, { kind: "snapshot", id: "id", value }]));
  stage.dispose(); assert.equal(stage.size, 0); assert.equal(stage.byteSize, 0); assert.equal(pending.byteSize, 73);
  assert.equal(shared.size, 0); stage.dispose(); assert.equal(pending.byteSize, 73); other.release();
});
test("staged overwrite releases old references, commit clears local ownership but preserves shared values", () => {
  const shared = new ClaudeCache(), stage = new StagedCache(shared), pending = new KimiExecPending(); stage.attachPending(pending);
  stage.put("snapshot", "id", { request: {}, input: [{ text: "a".repeat(1000) }] }); const before = pending.byteSize;
  const value = { request: {}, input: [] }; stage.put("snapshot", "id", value); assert(pending.byteSize < before);
  stage.commit(); assert.equal(stage.size, 0); assert.equal(pending.byteSize, 0); assert.deepEqual(shared.get("snapshot", "id"), value);
});
test("failed staged attachment releases only acquired leases and preserves local values", () => {
  const stage = new StagedCache(new ClaudeCache()), pending = new KimiExecPending(); stage.put("adapted", "id", true);
  const other = pending.reserve(pending.limit - 1); assert.throws(() => stage.attachPending(pending));
  assert.equal(pending.byteSize, pending.limit - 1); assert.equal(stage.get("adapted", "id"), true); other.release(); stage.dispose();
});
for (const operation of ["put", "batch", "commit"] as const) test(`staged pending ${operation} overflow never publishes or clears foreign leases`, () => {
  const shared = new ClaudeCache(), stage = new StagedCache(shared), pending = new KimiExecPending(); stage.attachPending(pending);
  stage.put("adapted", "existing", true); const baseline = pending.byteSize, other = pending.reserve(pending.limit - baseline - 1);
  assert.throws(() => operation === "put" ? stage.put("adapted", "new", true) : operation === "batch"
    ? stage.putBatch([{ kind: "adapted", id: "new", value: true }]) : stage.commit(),
    (e: unknown) => e instanceof RoutingError && e.code === "provider_state_too_large");
  assert.equal(stage.get("adapted", "new"), undefined); assert.equal(stage.get("adapted", "existing"), true);
  assert.equal(shared.size, 0); assert.equal(pending.byteSize, pending.limit - 1);
  other.release(); stage.dispose(); assert.equal(pending.byteSize, 0);
});

function interleaved(): Item[] {
  const one = call(), two = call("two", " \t"), other = { ...call("patch", "{}"), name: "apply_patch", arguments: '{"path":"literal"}' };
  const message = { type: "message", id: "message", status: "completed", role: "assistant", content: [] };
  const reasoning = { type: "reasoning", id: "reasoning", status: "completed", summary: [], encrypted_content: "fabricated-opaque" };
  const added = (item: Item, output_index: number) => ({ type: "response.output_item.added", output_index,
    item: { ...item, status: "in_progress", ...(item["type"] === "function_call" ? { arguments: "" } : {}) } });
  const args = (item: Item, output_index: number) => ({ type: "response.function_call_arguments.done", output_index, item_id: item["id"], arguments: item["arguments"] });
  const done = (item: Item, output_index: number) => ({ type: "response.output_item.done", output_index, item });
  return [events([])[0]!, { type: "response.in_progress", sequence_number: -5, response: { id: "provider", status: "in_progress", output: [] } },
    added(one, 0), added(other, 2), added(two, 1), added(message, 3), added(reasoning, 4),
    { type: "response.function_call_arguments.delta", item_id: "one", delta: one["arguments"] }, args(one, 0),
    { type: "response.output_text.delta", item_id: "message", output_index: 3, delta: "after input.done" }, args(other, 2), done(other, 2),
    args(two, 1), done(one, 0), { type: "response.reasoning_summary_text.delta", item_id: "reasoning", output_index: 4, delta: "caller reasoning" },
    { type: "response.output_text.delta", item_id: "message", output_index: 3, delta: "after executable done" },
    done(two, 1), done(message, 3), done(reasoning, 4),
    { type: "response.completed", sequence_number: 1e100, response: { id: "provider", status: "completed", output: [one, two, other, message, reasoning] } }];
}
function chunked(items: Item[], size: number): Response {
  const bytes = Buffer.from(items.map(e => `data: ${JSON.stringify(e)}\r\n\r\n`).join("")); let offset = 0;
  return new Response(new ReadableStream<Uint8Array>({ pull(c) {
    if (offset === bytes.length) { c.close(); return; }
    c.enqueue(bytes.subarray(offset, offset + size)); offset = Math.min(bytes.length, offset + size);
  } }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });
}
for (const streaming of [true, false]) test(`actual interleaved twoexec/unmapped/text/reasoning publishes in total order streaming${streaming}`, async () => {
  const raw = interleaved(), shared = new ClaudeCache(), order: string[] = [];
  const f = fixture({ cache: shared, reply: () => chunked(raw, 31), prepared(ready) {
    const context = ready.orderedResponsesSuffix!, stage = context.beforePublication.bind(context), commit = ready.commit;
    context.beforePublication = () => { order.push("stage"); return stage(); };
    ready.commit = () => { order.push("cache-commit"); commit(); };
  } });
  const preparePut = f.router.continuations.preparePut.bind(f.router.continuations);
  f.router.continuations.preparePut = (...args) => { order.push("continuation-preflight"); const publish = preparePut(...args);
    return () => { order.push("continuation-publish"); publish(); }; };
  const success = f.router.quota.success.bind(f.router.quota);
  f.router.quota.success = (...args) => { order.push("quota-success"); return success(...args); };
  const seen: Item[] = [];
  try {
    for await (const item of f.iterate({ ...body(), stream: streaming })) {
      if (!streaming || seen.length >= 2) assert.deepEqual(order, ["stage", "continuation-preflight", "cache-commit", "continuation-publish", "quota-success"]);
      else assert.deepEqual(order, []);
      seen.push(item);
    }
    const projected = raw.filter(e => !(e["type"] === "response.function_call_arguments.delta" && e["item_id"] === "one")).map(e => {
      const result = structuredClone(e), item = result["item"] as Item | undefined;
      if (item?.["name"] === "exec") { const input = item["status"] === "in_progress" ? "" : JSON.parse(String(item["arguments"]))["input"];
        delete item["arguments"]; Object.assign(item, { type: "custom_tool_call", input }); }
      if (result["type"] === "response.function_call_arguments.done" && ["one", "two"].includes(String(result["item_id"]))) {
        result["type"] = "response.custom_tool_call_input.done"; result["input"] = JSON.parse(String(result["arguments"]))["input"]; delete result["arguments"];
      }
      return result;
    });
    assert.deepEqual(seen.map(e => e["type"]), projected.map(e => e["type"]));
    for (let i = 0; i < seen.length - 1; i++) {
      const expected: Item = { ...projected[i], sequence_number: i };
      if (expected["response"]) expected["response"] = (seen[i]!["response"]);
      assert.deepEqual(seen[i], expected);
    }
    assert.deepEqual(seen.map(e => e["sequence_number"]), seen.map((_, i) => i));
    const final = seen.at(-1)!["response"] as Item, output = final["output"] as Item[];
    assert.deepEqual(output.map(i => [i["type"], i["id"]]), [["custom_tool_call", "one"], ["custom_tool_call", "two"],
      ["function_call", "patch"], ["message", "message"], ["reasoning", "reasoning"]]);
    assert.equal(output[0]!["input"], source); assert.equal(output[1]!["input"], " \t");
    assert.deepEqual(output.slice(2), ((raw.at(-1)!["response"] as Item)["output"] as Item[]).slice(2));
    assert(shared.size >= 6, "associations plus reasoning/opaque snapshots committed"); assert.equal(f.pendings[0]!.byteSize, 0);
  } finally { f.router.close(); }
});

for (const streaming of [true, false]) for (const failure of ["cache", "continuation"] as const)
  test(`actual interleaved ${failure} failure withholds every suffix streaming${streaming}`, async () => {
    const shared = new ClaudeCache({ maxEntries: 10, maxBytes: failure === "cache" ? 1 : 1000000 }, true);
    const f = fixture({ cache: shared, reply: () => chunked(interleaved(), 31) }); let prepared = 0, published = 0;
    const original = f.router.continuations.preparePut.bind(f.router.continuations);
    f.router.continuations.preparePut = (...args) => { prepared++; if (failure === "continuation") throw new RoutingError("continuation_store_full", 503);
      const publish = original(...args); return () => { published++; publish(); }; };
    try { const result = await f.run({ ...body(), stream: streaming }); code(result.error, "continuation_store_full");
      assert.deepEqual(result.seen.map(e => e["type"]), streaming ? ["response.created", "response.in_progress"] : []);
      assert.equal(prepared, 1); assert.equal(published, 0); assert.equal(shared.size, 0); assert.equal(f.pendings[0]!.byteSize, 0);
    } finally { f.router.close(); }
  });

for (const mutation of ["source", "name", "namespace", "id", "raw-function", "description", "inline-exec", "generation", "conversation", "cold", "duplicate-call", "missing-result", "duplicate-result", "result-before-call"] as const)
  test(`actual fullhistory refuses ${mutation} before another physical dispatch`, async () => {
    const f = fixture({ reply: (_request, index) => response(events(index === 1 ? [call()] : [])) });
    try {
      const first = await f.run(); assert.equal(first.error, undefined);
      const native = structuredClone(((first.seen.at(-1)!["response"] as Item)["output"] as Item[])[0]!);
      const result: Item = { type: "custom_tool_call_output", call_id: native["call_id"], output: "caller result" };
      const request = body(), input = request["input"] as Item[]; input.push(native, result);
      if (mutation === "source") native["input"] = "changed";
      if (mutation === "name") native["name"] = "renamed";
      if (mutation === "namespace") native["namespace"] = "";
      if (mutation === "id") native["id"] = "changed";
      if (mutation === "raw-function") { native["type"] = "function_call"; native["arguments"] = JSON.stringify({ input: native["input"] }); delete native["input"]; }
      if (mutation === "description") (request["tools"] as Item[])[0]!["description"] = "new description";
      if (mutation === "inline-exec") input.unshift({ type: "additional_tools", role: "developer", tools: [{ type: "function", name: "exec" }] });
      if (mutation === "generation") f.auth.generation = "different";
      if (mutation === "conversation") input[0] = { role: "user", content: "different conversation" };
      if (mutation === "cold") Object.defineProperty(f.attempts, "replay", { value: new ClaudeCache() });
      if (mutation === "duplicate-call") input.push(structuredClone(native), structuredClone(result));
      if (mutation === "missing-result") input.pop();
      if (mutation === "duplicate-result") input.push(structuredClone(result));
      if (mutation === "result-before-call") input.splice(1, 2, result, native);
      const next = await f.run(request); assert(next.error, mutation); assert.equal(f.sent.length, 1);
      assert(f.pendings.every(p => p.byteSize === 0));
    } finally { f.router.close(); }
  });

for (const change of [false, true]) test(`actual401 invokes physical-dispatch hook exactly change${change}`, async () => {
  const hooks: unknown[] = [], f = fixture({ beforeDispatch: e => hooks.push(e),
    reply: (_request, index) => index === 1 ? new Response("{}", { status: 401 }) : response(events()) });
  f.auth.changeOnRefresh = change;
  try { const result = await f.run({ ...body(), max_output_tokens: 37 });
    assert.equal(f.auth.refreshCount, 1); assert.equal(f.sent.length, change ? 1 : 2); assert.equal(hooks.length, f.sent.length);
    assert.deepEqual(hooks, f.sent.map(() => ({ profile: "fixture", protocol: "responses", requestedOutputTokens: 37 })));
    if (change) code(result.error, "credential_owner_changed"); else { assert.equal(result.error, undefined); assert.deepEqual(f.sent[0], f.sent[1]); }
    assert(f.pendings.every(p => p.byteSize === 0));
  } finally { f.router.close(); }
});

for (const [allowTransport, afterPrefix] of [[false, false], [true, false], [true, true]] as const)
  test(`actual codec fallback uses existing policy transport${allowTransport} committed${afterPrefix}`, async () => {
    let pulls = 0, hooks = 0;
    const f = fixture({ fallback: true, allowTransport, beforeDispatch() { hooks++; }, reply: (_request, index) => {
      if (index > 1) return chunked(events(), 31);
      return new Response(new ReadableStream<Uint8Array>({ pull(c) {
        if (afterPrefix && pulls++ === 0) c.enqueue(Buffer.from([events([])[0],
          { type: "response.output_text.delta", delta: "visible prefix" }].map(e => `data: ${JSON.stringify(e)}\n\n`).join("")));
        else c.error(new Error("fabricated source read failure"));
      } }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });
    } });
    try { const result = await f.run();
      if (allowTransport && !afterPrefix) { assert.equal(result.error, undefined); assert.equal(f.sent.length, 2); assert.equal(result.seen.at(-1)!["type"], "response.completed"); }
      else { assert(result.error instanceof AttemptFailure); assert.equal(result.error.failure.kind, "transport"); assert.equal(f.sent.length, 1);
        assert.deepEqual(result.seen.map(e => e["type"]), afterPrefix ? ["response.created", "response.output_text.delta"] : []); }
      assert.equal(hooks, f.sent.length); assert(f.pendings.every(p => p.byteSize === 0));
    } finally { f.router.close(); }
  });

for (const when of ["prefix", "suffix"] as const) for (const cancel of ["return", "abort"] as const)
  test(`actual consumer ${cancel} parked at ${when} preserves publication boundary`, async () => {
    const shared = new ClaudeCache(), f = fixture({ cache: shared }), iterator = f.iterate();
    try {
      const first = (await iterator.next()).value!; assert.equal(first["type"], "response.created");
      const id = String((first["response"] as Item)["id"]);
      if (when === "suffix") assert.equal((await iterator.next()).value!["type"], "response.output_item.added");
      assert(f.pendings[0]!.byteSize > 0); const before = shared.size;
      assert.equal(before > 0, when === "suffix");
      if (cancel === "return") await iterator.return(undefined);
      else { f.controller.abort(); await assert.rejects(iterator.next()); }
      assert.equal(shared.size, before); assert.equal(f.sent.length, 1); assert.equal(f.pendings[0]!.byteSize, 0);
      if (when === "suffix") assert.equal(f.router.continuations.get(id, undefined, "work", "responses").output[0]!["type"], "custom_tool_call");
      else assert.throws(() => f.router.continuations.get(id, undefined, "work", "responses"));
    } finally { await iterator.return(undefined); f.router.close(); }
  });

test("actual fullhistory accepts exact native call/result and retains unrelated inline declarations", async () => {
  const f = fixture({ reply: (_request, index) => response(events(index === 1 ? [call()] : [])) });
  try {
    const first = await f.run(); assert.equal(first.error, undefined);
    const native = ((first.seen.at(-1)!["response"] as Item)["output"] as Item[])[0]!;
    const request = body(), input = request["input"] as Item[];
    (request["tools"] as Item[]).push({ type: "namespace", name: "functions", description: "Caller owns deferred tools", tools: [
      { type: "function", name: "read" }, { type: "custom", name: "apply_patch", format: { type: "grammar", syntax: "lark", definition: "start: /.+/" } }] });
    const inline = { type: "additional_tools", role: "developer", id: "later", tools: [{ type: "function", name: "read" }] };
    input.push(inline, native, { type: "custom_tool_call_output", call_id: native["call_id"], output: "exact result", is_error: true });
    const before = structuredClone(request), next = await f.run(request); assert.equal(next.error, undefined); assert.deepEqual(request, before);
    const sent = f.sent[1]!["input"] as Item[];
    assert.deepEqual(sent[1], inline); assert.equal(sent[2]!["type"], "function_call");
    assert.equal(sent[2]!["arguments"], JSON.stringify({ input: source }));
    assert.deepEqual(sent[3], { ...input[3], type: "function_call_output" });
    assert.deepEqual((f.sent[1]!["tools"] as Item[]).slice(1), (request["tools"] as Item[]).slice(1));
  } finally { f.router.close(); }
});

test("actual recognition refuses invalid and colliding exec declarations before dispatch", async () => {
  const inline = (tools: Item[]): Item => ({ type: "additional_tools", role: "developer", tools });
  const variants: Item[] = [
    { tools: [{ ...declaration(), format: { type: "text" } }] },
    { tools: [{ ...declaration(), format: { ...declaration().format, definition: "start: /.+/" } }] },
    { tools: [{ ...declaration(), namespace: "" }] }, { tools: [{ ...declaration(), defer_loading: false }] },
    { tools: [declaration(), { type: "function", name: "exec" }] },
    { input: [inline([{ type: "function", name: "exec" }]), { role: "user", content: "work" }] },
    { tool_choice: { type: "function", name: "exec" } },
    { tool_choice: { type: "allowed_tools", tools: [{ type: "custom", name: "exec" }] } },
  ];
  for (const variant of variants) {
    const f = fixture();
    try { const request = { ...body(), ...variant }, before = structuredClone(request), result = await f.run(request);
      assert(result.error); assert.deepEqual(f.sent, []); assert.deepEqual(result.seen, []); assert.deepEqual(request, before);
      assert(f.pendings.every(p => p.byteSize === 0));
    } finally { f.router.close(); }
  }
});
test("actual exact tool choice maps while unrelated caller tool metadata stays intact", async () => {
  const f = fixture();
  try { const request: Item = { ...body(), tool_choice: { type: "custom", name: "exec" } }, before = structuredClone(request);
    const result = await f.run(request); assert.equal(result.error, undefined); assert.deepEqual(request, before);
    assert.deepEqual(f.sent[0]!["tool_choice"], { type: "function", name: "exec" });
    assert.deepEqual((f.sent[0]!["tools"] as Item[]).slice(1), (request["tools"] as Item[]).slice(1));
  } finally { f.router.close(); }
});
for (const top of [undefined, []]) test(`actual noexec retains top-level ${top ? "empty" : "absent"} tools and temporal inline positions`, async () => {
  const f = fixture({ reply: () => response(events([])) });
  const request: Item = { model: "work", ...(top ? { tools: top } : {}), input: [
    { role: "user", content: "before" }, { type: "additional_tools", role: "developer", tools: [{ type: "function", name: "read" }] },
    { type: "additional_tools", role: "developer", tools: [] }, { role: "user", content: "after" }] };
  try { const before = structuredClone(request), result = await f.run(request); assert.equal(result.error, undefined);
    assert.equal(Object.hasOwn(f.sent[0]!, "tools"), Object.hasOwn(request, "tools")); assert.deepEqual(f.sent[0]!["input"], request["input"]);
    assert.deepEqual(request, before); assert(f.pendings.every(p => p.byteSize === 0));
  } finally { f.router.close(); }
});

class ObservedPending extends KimiExecPending {
  peak = 0;
  readonly representations = new Set<string>();
  override reserve(bytes: number) { const lease = super.reserve(bytes); this.peak = Math.max(this.peak, this.byteSize); return lease; }
  override retain(value: unknown) {
    const lease = super.retain(value);
    if (Array.isArray(value)) {
      if (typeof value[0] === "string" && value[0].startsWith("snapshot:")) this.representations.add("staged-snapshot");
      if (typeof value[0] === "string" && value[0].startsWith("kimiExec:")) this.representations.add("staged-association");
      if (value[0]?.kind === "kimiExec") this.representations.add("temporary-association");
      if (typeof value[0]?.sequence_number === "number") this.representations.add("final-delivery");
    } else if (value && typeof value === "object" && "final" in value && "calls" in value) this.representations.add("completion-observer");
    return lease;
  }
}
for (const pressure of [false, true]) test(`actual nativefinal/staged/reasoning/opaque/association/delivery share one allowance pressure${pressure}`, async () => {
  const pending = new ObservedPending(), foreign = pending.reserve(73), shared = new ClaudeCache();
  let pressureLease: ReturnType<KimiExecPending["reserve"]> | undefined, pressureBytes = 0, beforeStage = 0, afterStage = 0;
  const f = fixture({ cache: shared, pending: () => pending, reply: () => chunked(interleaved(), 31), prepared(ready) {
    const context = ready.orderedResponsesSuffix!, stage = context.beforePublication.bind(context);
    context.beforePublication = () => {
      assert.equal(context.pending, pending); beforeStage = pending.byteSize;
      assert(pending.representations.has("completion-observer")); assert(pending.representations.has("final-delivery"));
      if (pressure) { pressureBytes = pending.limit - pending.byteSize - 1; pressureLease = pending.reserve(pressureBytes); }
      const result = stage(); afterStage = pending.byteSize; return result;
    };
  } });
  try { const result = await f.run();
    if (pressure) { code(result.error, "provider_state_too_large"); assert.equal(shared.size, 0);
      assert.deepEqual(result.seen.map(e => e["type"]), ["response.created", "response.in_progress"]); }
    else { assert.equal(result.error, undefined); assert(beforeStage > 73 && afterStage > 73);
      assert.deepEqual([...pending.representations].sort(), ["completion-observer", "final-delivery", "staged-association", "staged-snapshot", "temporary-association"]);
      assert(shared.size >= 6); }
    assert(pending.peak <= pending.limit); assert.equal(pending.byteSize, 73 + pressureBytes);
  } finally { pressureLease?.release(); foreign.release(); f.router.close(); }
  assert.equal(pending.byteSize, 0);
});

test("actual near-frame terminal hits simultaneous shared allowance before publication", async () => {
  const raw = events();
  // Provider framing fits. The full path's simultaneous retained forms reach
  // the shared limit before delivery's later local-identity frame preflight.
  const terminal = raw.at(-1)!, final = terminal["response"] as Item;
  final["padding"] = "";
  terminal["sequence_number"] = 0;
  const cap = 4 * 1024 * 1024;
  final["padding"] = "x".repeat(cap - 8 - Buffer.byteLength(JSON.stringify(terminal)));
  assert.equal(Buffer.byteLength(`data: ${JSON.stringify(terminal)}\n\n`), cap);
  const shared = new ClaudeCache(), f = fixture({ cache: shared, reply: () => chunked(raw, 16384) });
  try { const result = await f.run(); code(result.error, "provider_state_too_large"); assert.equal(shared.size, 0);
    assert.deepEqual(result.seen.map(e => e["type"]), ["response.created"]); assert.equal(f.pendings[0]!.byteSize, 0);
  } finally { f.router.close(); }
});

test("actual pending read abort has finite own cleanup even when body cancel never settles", async () => {
  let pulls = 0, cancelCount = 0, entered: (() => void) | undefined;
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const f = fixture({ reply: () => new Response(new ReadableStream<Uint8Array>({ pull(c) {
    if (pulls++ === 0) { c.enqueue(Buffer.from(`data: ${JSON.stringify(events([])[0])}\n\n`)); return; }
    entered!(); return new Promise<void>(() => {});
  }, cancel() { cancelCount++; return new Promise<void>(() => {}); } }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } }) });
  const iterator = f.iterate();
  try {
    await iterator.next(); const next = iterator.next(); await reading; f.controller.abort();
    await assert.rejects(next, e => e instanceof RoutingError && e.code === "request_cancelled");
    assert.equal(cancelCount, 1); assert.equal(f.sent.length, 1); assert.equal(f.pendings[0]!.byteSize, 0);
  } finally { await iterator.return(undefined); f.router.close(); }
});

for (const reason of ["request_cancelled", "request_timeout"] as const)
test(`actual ${reason} after local staging but before publication publishes no store`, async () => {
  const shared = new ClaudeCache(), f = fixture({ cache: shared, prepared(ready) {
    const context = ready.orderedResponsesSuffix!, stage = context.beforePublication.bind(context);
    context.beforePublication = () => { const result = stage(); f.controller.abort(new RoutingError(reason, reason === "request_timeout" ? 504 : 499)); return result; };
  } });
  try { const result = await f.run(); code(result.error, reason); assert.equal(shared.size, 0);
    assert.deepEqual(result.seen.map(e => e["type"]), ["response.created"]);
    const id = String((result.seen[0]!["response"] as Item)["id"]);
    assert.throws(() => f.router.continuations.get(id, undefined, "work", "responses"));
    assert.equal(f.pendings[0]!.byteSize, 0); assert.equal(f.sent.length, 1);
  } finally { f.router.close(); }
});

test("actual codec retains start/MIME/unknown-event guards before executable publication", async () => {
  const variants: [string, () => Response][] = [
    ["missing start", () => response(events().slice(1))],
    ["duplicate start", () => response([events()[0]!, ...events()])],
    ["nonempty opening output", () => { const values = events(); (values[0]!["response"] as Item)["output"] = [call()]; return response(values); }],
    ["foreign MIME", () => new Response("{}", { headers: { "content-type": "application/json" } })],
    ["unknown event", () => response([events()[0]!, { type: "response.unknown" }, ...events().slice(1)])],
  ];
  for (const [label, reply] of variants) {
    const shared = new ClaudeCache(), f = fixture({ cache: shared, reply });
    try { const result = await f.run(); assert(result.error, label); assert.equal(shared.size, 0); assert.equal(f.sent.length, 1);
      assert(result.seen.every(e => e["type"] === "response.created"), label); assert(f.pendings.every(p => p.byteSize === 0));
    } finally { f.router.close(); }
  }
});
test("actual partial tool EOF/incomplete/refusal/error never publishes an executable suffix or retries", async () => {
  for (const kind of ["eof", "incomplete", "refusal", "error"] as const) {
    const raw = events().slice(0, 3);
    if (kind === "incomplete") raw.push({ type: "response.incomplete", response: { id: "provider", status: "incomplete", output: [call()] } });
    if (kind === "refusal") raw.push({ type: "response.refusal.delta", delta: "declined" });
    if (kind === "error") raw.push({ type: "error", error: { type: "server_error", status: 503 } });
    const shared = new ClaudeCache(), f = fixture({ cache: shared, reply: () => response(raw) });
    try { const result = await f.run(); assert(result.error, kind); assert.equal(shared.size, 0); assert.equal(f.sent.length, 1);
      assert.deepEqual(result.seen.map(e => e["type"]), ["response.created"]); assert.equal(f.pendings[0]!.byteSize, 0);
    } finally { f.router.close(); }
  }
});
test("actual replay refuses a committed association from another codec version before dispatch", async () => {
  class OtherCodecCache extends ClaudeCache {
    override get<K extends keyof import("../../src/claude-cache.js").ClaudeCacheValues>(kind: K, id: string) {
      const value = super.get(kind, id);
      return (kind === "kimiExec" && value && typeof value === "object" ? { ...value, codecVersion: "kimi-exec-future" } : value) as typeof value;
    }
  }
  const f = fixture({ cache: new OtherCodecCache(), reply: (_request, index) => response(events(index === 1 ? [call()] : [])) });
  try { const first = await f.run(); assert.equal(first.error, undefined);
    const native = ((first.seen.at(-1)!["response"] as Item)["output"] as Item[])[0]!;
    const request = body(); (request["input"] as Item[]).push(native, { type: "custom_tool_call_output", call_id: native["call_id"], output: "done" });
    const result = await f.run(request); code(result.error, "continuity_unavailable"); assert.equal(f.sent.length, 1);
    assert(f.pendings.every(p => p.byteSize === 0));
  } finally { f.router.close(); }
});
