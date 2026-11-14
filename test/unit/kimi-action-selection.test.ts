/** Genuine production action admission + HTTP facades; fabricated auth/SSE, no sockets. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { aggregateFrames } from "../../src/codex-response.js";
import { ClaudeCache, type CacheWrite, type KimiOrderedAssociation } from "../../src/claude-cache.js";
import { noopLogger } from "../../src/logger.js";
import { systemClock } from "../../src/routing/clock.js";
import { ownerKey } from "../../src/routing/continuation-store.js";
import { resolveDestination } from "../../src/routing/destination-catalog.js";
import { orderedAssociationId, orderedCanonical } from "../../src/routing/kimi-ordered-replay.js";
import type { KimiExecPending } from "../../src/routing/kimi-exec-pending.js";
import { writeRoutedHttp } from "../../src/routing/http-ingress.js";
import { RoutedAttempts, type AttemptRequest, type RoutedPrepared } from "../../src/routing/routed-attempt.js";
import { RoutingError, type AccessProfile, type ActionContext, type Item, type OriginatingClient } from "../../src/routing/routing-types.js";
import { added, created, done, terminal, textItem } from "../helpers/kimi-responses-bridge.js";
import { fixture, profile, target, ordered, output, nativeMessages, response, wire } from "../helpers/kimi-ordered-route.js";

type Fixture = ReturnType<typeof fixture>;
class Reply extends EventEmitter {
  headersSent = false; writableFinished = false; writableEnded = false; destroyed = false; statusCode = 0; data = "";
  writeHead(status: number) { this.statusCode = status; this.headersSent = true; return this; }
  write(text: string) { this.data += text; this.emit("write"); return true; }
  end(text = "") { this.data += text; this.writableFinished = this.writableEnded = true; this.emit("finish"); }
  destroy() { this.destroyed = true; this.emit("close"); }
  asHttp() { return this as unknown as ServerResponse; }
}
function request(url: string, body: Item = {}, headers: Record<string, string> = {}): IncomingMessage {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as IncomingMessage;
  req.method = "POST"; req.url = url; req.headers = headers; return req;
}
async function action(f: Fixture, client: OriginatingClient = "claude-code") {
  const res = new Reply();
  await f.router.control(request("/__subswitch/actions", { client, conversationId: "fabricated-invocation" },
    { "x-subswitch-capability": f.router.actions.capability }), res.asHttp());
  assert.equal(res.statusCode, 201);
  return JSON.parse(res.data) as { id: string; ingressPrefix: string };
}
async function finish(f: Fixture, id: string, operation = "complete") {
  const res = new Reply();
  await f.router.control(request(`/__subswitch/actions/${id}/${operation}`, {},
    { "x-subswitch-capability": f.router.actions.capability }), res.asHttp());
  assert.equal(res.statusCode, 200);
}
async function send(f: Fixture, body: Item, prefix = "", client: OriginatingClient = "claude-code", headers: Record<string, string> = {}) {
  const req = request(prefix + (client === "codex" ? "/codex/backend-api/codex/responses" : "/v1/messages"), body, headers), res = new Reply();
  res.on("write", () => { if (res.statusCode === 200) assert(f.stats().commits > 0); });
  f.router.stripPrefix(req); f.router.admitHttp(req, res.asHttp(), client);
  const context = f.router.context(req, client, body);
  await writeRoutedHttp(f.router, noopLogger, systemClock, req, res.asHttp(), body, client, "work");
  assert(res.writableFinished || res.destroyed); return { res, context };
}
function assistant(reply: Reply, streaming: boolean): Item {
  if (!streaming) return { role: "assistant", content: JSON.parse(reply.data).content };
  const parsed = aggregateFrames(reply.data.split("\n\n").filter(Boolean), "codex"); assert(parsed.ok && parsed.value.kind === "message");
  return { role: "assistant", content: parsed.value.message.content };
}
function seed(shape = "leading", stream = false): Item {
  const body: Item = { ...ordered(), stream, system: [{ type: "text", text: "top", cache_control: { type: "ephemeral", ttl: "1h" } }],
    metadata: { user_id: "fabricated-attribution" }, thinking: { type: "adaptive", display: "omitted" }, context_management: { edits: [] },
    cache_control: { type: "ephemeral", ttl: "5m" }, tool_choice: { type: "auto" }, output_config: { effort: "high" },
    messages: shape === "late" ? ordered()["messages"] : shape === "leading" ?
      [{ role: "system", content: "leading" }, { role: "user", content: "first" }] : [{ role: "user", content: "first" }],
  };
  if (shape === "user-only") delete body["system"];
  return body;
}
const textOutput = () => {
  const m = textItem("msg", ["שלום 🦊", "separate"]);
  return [created(), added(0, { ...m, content: [], status: "in_progress" }), done(0, m), terminal([m])];
};
const code = (error: unknown, expected: string) => { assert(error instanceof RoutingError, String(error)); assert.equal(error.code, expected); };
async function collect(f: Fixture, body: Item, context?: ActionContext, admissionSignal?: AbortSignal) {
  const seen: Item[] = []; let error: unknown;
  try { for await (const e of f.router.events(body, "claude-code", "work", f.controller.signal, context, admissionSignal)) seen.push(e); }
  catch (caught) { error = caught; }
  return { seen, error };
}
function observeAdmission(f: Fixture) {
  let has = 0, usage = 0;
  f.auth.has = () => { has++; return true; };
  f.router.usage.refresh = async () => { usage++; return false; };
  return () => ({ has, gets: f.auth.gets, usage, reserves: f.stats().reserves, physical: f.sent.length });
}

for (const shape of ["leading", "top", "user-only", "late"]) for (const tools of [false, true]) for (const stream of [false, true])
  test(`C1/C2 scoped ${shape} first owner and exact ${tools ? "tool" : "text"} continuation stream${stream}`, async () => {
    const owners: string[] = [], ledgers: RoutedPrepared["atomicPending"][] = [];
    const firstOutput = tools ? output() : textOutput();
    // Preserve the exact private provider argument spelling, not a re-encoded approximation.
    if (tools) for (const e of firstOutput) {
      const item = e["type"] === "response.output_item.done" ? e["item"] as Item : e["type"] === "response.completed" ? ((e["response"] as Item)["output"] as Item[])[1] : undefined;
      if (item?.["type"] === "function_call") item["arguments"] = ' { "n" : 7 } ';
    }
    const f = fixture({ action: false, reply: i => response(wire(i === 1 ? firstOutput : textOutput()), 3), prepared(r) {
      assert.equal(r.atomicMessages, true); owners.push(r.owner); ledgers.push(r.atomicPending);
    } });
    try {
      const a = await action(f), one = seed(shape, stream), before = structuredClone(one);
      const first = await send(f, one, a.ingressPrefix); assert.equal(first.res.statusCode, 200); assert.deepEqual(one, before);
      assert.equal(first.context!.actionId, a.id); assert.equal(owners[0], ownerKey(profile, target, "responses", "generation1", "kimi-ordered-messages-v4"));
      assert.equal(f.router.actions.affinity(first.context!, "work").selectedOwner, owners[0]);
      const suffix: Item[] = [{ role: "system", content: "new instruction" }, { role: "user", content: tools ?
        [{ type: "text", text: "before" }, { type: "tool_result", tool_use_id: "caller-id", content: "caller result" }, { type: "text", text: "after" }] : "next" }];
      const two: Item = { ...one, messages: [...one["messages"] as Item[], assistant(first.res, stream), ...suffix] }, secondBefore = structuredClone(two);
      const second = await send(f, two, a.ingressPrefix); assert.equal(second.res.statusCode, 200); assert.deepEqual(two, secondBefore);
      const expectedSuffix = [{ type: "message", role: "system", content: [{ type: "input_text", text: "new instruction" }] }, ...(tools ? [
        { type: "message", role: "user", content: [{ type: "input_text", text: "before" }] },
        { type: "function_call_output", call_id: "caller-id", output: "caller result" },
        { type: "message", role: "user", content: [{ type: "input_text", text: "after" }] },
      ] : [{ type: "message", role: "user", content: [{ type: "input_text", text: "next" }] }])];
      assert.deepEqual(f.sent[1]!.body["input"], [...f.sent[0]!.body["input"] as Item[], ...(firstOutput.at(-1)!["response"] as Item)["output"] as Item[], ...expectedSuffix]);
      assert.equal(f.sent.length, 2); assert(f.sent.every(s => s.url === "https://api.kimi.ai/coding/v1/responses"));
      assert.deepEqual(owners, [owners[0], owners[0]]);
      assert.equal(f.router.actions.affinity(second.context!, "work").selectedOwner, owners[0]);
      for (const s of f.sent) {
        assert.deepEqual(s.body["tools"], [{ type: "function", name: "inspect", description: "Caller tool", parameters: { type: "object" }, strict: false }]);
        assert.equal(s.body["max_output_tokens"], one["max_tokens"]); assert.deepEqual(s.body["reasoning"], { effort: "high" });
        assert.equal(s.body["store"], false); assert.deepEqual(s.body["include"], ["reasoning.encrypted_content"]);
      }
      assert.equal(f.stats().commits, 2); assert.equal(f.stats().successes, 2); assert.equal(f.cache.size, 2);
      assert(ledgers.every(p => p!.byteSize === 0));
      assert.equal(f.router.actions.context(a.id, "claude-code").actionId, a.id);
      await finish(f, a.id, tools ? "cancel" : "complete"); assert.throws(() => f.router.actions.context(a.id, "claude-code"));
    } finally { f.router.close(); }
  });

test("C2 direct leading Messages stays native; action-like metadata/headers cannot authorize a late-system body", async () => {
  const f = fixture({ action: false, reply: () => response(wire(nativeMessages())) }), effects = observeAdmission(f);
  try {
    const a = await action(f), one = { model: "work", stream: false, max_tokens: 128, messages: [{ role: "system", content: "leading" }, { role: "user", content: "first" }],
      client_metadata: { actionId: a.id, thread_id: "synthetic" }, metadata: { user_id: a.id } };
    const headers = { "x-subswitch-action": a.id, "thread-id": a.id, "x-subswitch-capability": f.router.actions.capability };
    const first = await send(f, one, "", "claude-code", headers); assert.equal(first.res.statusCode, 200); assert.equal(first.context, undefined);
    assert(f.sent[0]!.url.endsWith("/v1/messages?beta=true"));
    const before = effects(), second = await send(f, { ...one, messages: [...one.messages, { role: "system", content: "later" }] }, "", "claude-code", headers);
    assert.equal(second.res.statusCode, 409); assert.equal(JSON.parse(second.res.data).error.message, "action_identity_required"); assert.deepEqual(effects(), before);
  } finally { f.router.close(); }
});

for (const kind of ["unknown", "foreign-store", "expired", "closing", "cancelled", "client", "namespace", "conversation", "agent", "parent"])
  test(`C3 ${kind} action cannot reach target auth/usage/quota`, async () => {
    const f = fixture({ action: false }), effects = observeAdmission(f); let release = () => {};
    try {
      const a = await action(f); let ctx = f.router.actions.context(a.id, "claude-code");
      if (kind === "unknown") ctx.actionId = "00000000-0000-0000-0000-000000000000";
      if (kind === "foreign-store") {
        const foreign = fixture({ action: false });
        try { ctx = foreign.router.actions.context((await action(foreign)).id, "claude-code"); } finally { foreign.router.close(); }
      }
      if (["expired", "closing", "cancelled"].includes(kind)) {
        if (kind !== "expired") release = f.router.actions.admit(ctx, new AbortController());
        if (kind === "cancelled") f.router.actions.cancel(a.id); else f.router.actions.complete(a.id);
      }
      if (kind === "client") ctx.client = "codex";
      if (kind === "namespace") ctx.namespace = "invented";
      if (kind === "conversation") ctx.conversationId = "invented";
      if (kind === "agent") ctx.agentId = "invented";
      if (kind === "parent") ctx.parentActionId = "invented";
      // A caller-shaped admission signal cannot bypass the store validation.
      const r = await collect(f, seed(), ctx, new AbortController().signal);
      assert(r.error instanceof RoutingError); assert.deepEqual(r.seen, []);
      assert.deepEqual(effects(), { has: 0, gets: 0, usage: 0, reserves: 0, physical: 0 });
    } finally { release(); f.router.close(); }
  });

for (const kind of ["no-store/no-op", "no-action", "wrong-protocol", "wrong-codec", "changed-client", "changed-namespace", "no-route"])
  test(`C3 attempt rejects ${kind} scoped selection before auth it initiates`, async () => {
    const f = fixture({ action: false });
    try {
      const a = await action(f), ctx = f.router.actions.context(a.id, "claude-code");
      const r: AttemptRequest = { profile, target, body: seed(), protocol: "messages", conversation: "fabricated-invocation", action: ctx,
        selection: Object.freeze({ protocol: "responses", codec: "kimi-ordered-messages-v4" }), route: "work", signal: f.controller.signal, refreshes: new Set() };
      let attempts = f.attempts;
      if (kind === "no-store/no-op") {
        attempts = new RoutedAttempts(f.auth, noopLogger, async () => { throw Error("unreachable"); });
        Object.assign(r, { validateAction: () => {} });
      }
      if (kind === "no-action") delete r.action;
      if (kind === "wrong-protocol") r.selection = { protocol: "messages" };
      if (kind === "wrong-codec") r.selection = { protocol: "responses" };
      if (kind === "changed-client") r.action = { ...ctx, client: "codex" };
      if (kind === "changed-namespace") r.action = { ...ctx, namespace: "foreign" };
      if (kind === "no-route") delete r.route;
      await assert.rejects(attempts.prepare(r), RoutingError);
      assert.equal(f.auth.gets, 0); assert.deepEqual(f.sent, []); assert.equal(f.cache.size, 0);
    } finally { f.router.close(); }
  });

for (const old of [undefined, "kimi-ordered-messages-v2"] as const) test(`C4 retained ${old ?? "legacy"} owner is not adopted or dispatched`, async () => {
  const f = fixture({ action: false });
  try {
    const a = await action(f), ctx = f.router.actions.context(a.id, "claude-code"), affinity = f.router.actions.affinity(ctx, "work");
    Object.assign(affinity, { selectedTarget: target, selectedOwner: ownerKey(profile, target, old ? "responses" : "messages", "generation1", old) });
    const before = structuredClone(affinity), r = await send(f, seed(), a.ingressPrefix);
    assert.equal(r.res.statusCode, 409); assert.equal(JSON.parse(r.res.data).error.message, "credential_owner_changed");
    assert.deepEqual(affinity, before); assert.equal(f.sent.length, 0); assert.equal(f.cache.size, 0); assert.equal(f.stats().successes, 0);
  } finally { f.router.close(); }
});

const controlMutations: Record<string, unknown> = {
  system: "changed", model: "another-route", tools: [{ name: "inspect", description: "changed", input_schema: { type: "object" } }],
  tool_choice: { type: "any" }, max_tokens: 127, stream: true, metadata: { user_id: "changed" },
  thinking: { type: "enabled", budget_tokens: 1024, display: "omitted" }, context_management: {},
  output_config: { effort: "low" },
};
for (const [field, value] of Object.entries(controlMutations)) test(`C5 full original ${field} remains bound after first leading seed`, async () => {
  const f = fixture({ action: false, reply: () => response(wire(textOutput())) });
  try {
    const a = await action(f), one = seed(), first = await send(f, one, a.ingressPrefix); assert.equal(first.res.statusCode, 200);
    const r = await collect(f, { ...one, [field]: value, messages: [...one["messages"] as Item[], assistant(first.res, false), { role: "user", content: "next" }] },
      f.router.actions.context(a.id, "claude-code"));
    code(r.error, "continuity_unavailable"); assert.deepEqual(r.seen, []); assert.equal(f.sent.length, 1); assert.equal(f.stats().commits, 1); assert.equal(f.stats().successes, 1);
  } finally { f.router.close(); }
});

test("C5 validated request cache hint TTL may change after first leading seed", async () => {
  const raw = textOutput(), f = fixture({ action: false, reply: () => response(wire(raw)) });
  try {
    const a = await action(f), one = seed(), first = await send(f, one, a.ingressPrefix); assert.equal(first.res.statusCode, 200);
    const next: Item = { ...one, cache_control: { type: "ephemeral", ttl: "1h" },
      messages: [...one["messages"] as Item[], assistant(first.res, false), { role: "user", content: "next" }] };
    const unchanged = structuredClone(next), r = await collect(f, next, f.router.actions.context(a.id, "claude-code"));
    assert.equal(r.error, undefined); assert(r.seen.length > 0); assert.deepEqual(next, unchanged);
    assert.equal(f.sent.length, 2); assert.equal(f.stats().commits, 2); assert.equal(f.stats().successes, 2);
    const retained = [...f.sent[0]!.body["input"] as Item[], ...(raw.at(-1)!["response"] as Item)["output"] as Item[]];
    assert.deepEqual((f.sent[1]!.body["input"] as Item[]).slice(0, retained.length), retained);
  } finally { f.router.close(); }
});

for (const isolate of ["action", "branch", "route", "profile", "target", "loss", "generation"])
  test(`C3/C4 same published prefix cannot cross ${isolate}`, async () => {
    const f = fixture({ action: false, reply: () => response(wire(textOutput())) });
    try {
      const a = await action(f), one = seed(), first = await send(f, one, a.ingressPrefix); assert.equal(first.res.statusCode, 200);
      const two: Item = { ...one, messages: [...one["messages"] as Item[], assistant(first.res, false), { role: "user", content: "next" }] };
      let ctx = f.router.actions.context(a.id, "claude-code"), route = "work";
      if (isolate === "action") ctx = f.router.actions.context((await action(f)).id, "claude-code");
      if (isolate === "branch") ctx = f.router.context((() => {
        const req = request(a.ingressPrefix + "/v1/messages", two, { "thread-id": "other-branch" }); f.router.stripPrefix(req); return req;
      })(), "claude-code", two)!;
      if (isolate === "route") { route = "other"; Object.defineProperty(f.router.config.routes, route, { value: f.router.config.routes!["work"] }); }
      if (isolate === "profile") f.router.config.routes!["work"]!.primary.profile = "backup";
      if (isolate === "target") f.router.config.routes!["work"]!.primary.model = "k3";
      if (isolate === "loss") Object.defineProperty(f.attempts, "replay", { value: new ClaudeCache() });
      if (isolate === "generation") f.auth.generation = "generation2";
      const seen: Item[] = []; let error: unknown;
      try { for await (const e of f.router.events(two, "claude-code", route, f.controller.signal, ctx)) seen.push(e); } catch (caught) { error = caught; }
      code(error, ["generation", "profile", "target"].includes(isolate) ? "credential_owner_changed" : "continuity_unavailable");
      assert.deepEqual(seen, []); assert.equal(f.sent.length, 1); assert.equal(f.stats().commits, 1);
    } finally { f.router.close(); }
  });

test("C6 genuine Codex action remains codecless Responses through previous_response_id and caller tool result", async () => {
  const owners: string[] = [], f = fixture({ action: false, reply: () => response(wire(output())), prepared(r) {
    assert.equal(r.atomicMessages, undefined); owners.push(r.owner);
  } });
  try {
    const a = await action(f, "codex"), one = { model: "work", stream: false, input: [{ role: "user", content: "first" }], tools: [{ type: "function", name: "inspect", parameters: { type: "object" } }] };
    const first = await send(f, one, a.ingressPrefix, "codex"); assert.equal(first.res.statusCode, 200);
    const second = await send(f, { ...one, previous_response_id: JSON.parse(first.res.data).id,
      input: [{ type: "function_call_output", call_id: "caller-id", output: "result" }, { role: "developer", content: "later" }] }, a.ingressPrefix, "codex");
    assert.equal(second.res.statusCode, 200); assert.equal(f.sent.length, 2);
    assert.deepEqual(owners, [ownerKey(profile, target, "responses", "generation1"), owners[0]]);
    assert(f.sent.every(s => s.url.endsWith("/v1/responses"))); assert.equal(f.stats().commits, 2);
    assert.deepEqual(f.sent[1]!.body["input"], [...one.input, ...(output().at(-1)!["response"] as Item)["output"] as Item[],
      { type: "function_call_output", call_id: "caller-id", output: "result" }, { role: "developer", content: "later" }]);
  } finally { f.router.close(); }
});

for (const change of [{ region: "mainland-cn" }, { credential: { kind: "env", name: "FABRICATED_KEY" } },
  { provider: "claude", product: "claude-code", region: undefined }, { product: "kimi-platform", billing: "api", credential: { kind: "env", name: "FABRICATED_KEY" } }])
  test(`C6 scoped noneligible ${JSON.stringify(change)} remains codecless`, async () => {
    const p = { ...profile, ...change } as AccessProfile;
    const selected = { ...target, model: p.product === "kimi-platform" ? "kimi-k3" : p.provider === "claude" ? "claude-sonnet-5-5" : target.model };
    const f = fixture({ action: false, profile: p, model: selected.model, reply: () => response(wire(nativeMessages())), prepared(r) {
      assert.equal(r.atomicMessages, undefined); assert.equal(r.owner, ownerKey(p, selected, "messages", "generation1"));
    } });
    try {
      const a = await action(f), r = await send(f, { model: "work", max_tokens: 128, messages: [{ role: "user", content: "hello" }], stream: false }, a.ingressPrefix);
      assert.equal(r.res.statusCode, 200); assert.equal(f.sent.length, 1); assert(f.sent[0]!.url.includes("/messages"));
      assert.equal(resolveDestination(p, "messages", seed(), true).codec, undefined);
    } finally { f.router.close(); }
  });

for (const retainId of [false, true]) test(`C4 v2 association layout1 cannot be adopted with v3 lookup retainId${retainId}`, async () => {
  class RecordingCache extends ClaudeCache {
    last?: { id: string; value: Readonly<KimiOrderedAssociation> };
    override putBatch(writes: readonly CacheWrite[], pending?: KimiExecPending) {
      super.putBatch(writes, pending);
      for (const w of writes) if (w.kind === "kimiOrdered") this.last = { id: w.id, value: w.value };
    }
  }
  const cache = new RecordingCache(), f = fixture({ action: false, cache, reply: () => response(wire(textOutput())) });
  try {
    const a = await action(f), one = seed(), first = await send(f, one, a.ingressPrefix); assert.equal(first.res.statusCode, 200); assert(cache.last);
    const oldScope = { ...JSON.parse(cache.last.value.scopeCanonical), codecVersion: "kimi-ordered-messages-v2" };
    const old = { ...cache.last.value, scopeCanonical: orderedCanonical(oldScope) };
    const replacement = new ClaudeCache();
    replacement.put("kimiOrdered", retainId ? cache.last.id : orderedAssociationId(old.scopeCanonical, old.prefixCanonical), old);
    Object.defineProperty(f.attempts, "replay", { value: replacement });
    const r = await collect(f, { ...one, messages: [...one["messages"] as Item[], assistant(first.res, false), { role: "user", content: "next" }] },
      f.router.actions.context(a.id, "claude-code"));
    code(r.error, "continuity_unavailable"); assert.deepEqual(r.seen, []); assert.equal(f.sent.length, 1); assert.equal(replacement.size, 1);
    assert.equal(f.stats().commits, 1); assert.equal(f.stats().successes, 1);
  } finally { f.router.close(); }
});

for (const moment of ["auth", "usage", "dispatch", "eof"] as const) for (const operation of ["complete", "cancel"] as const)
  test(`C4 action ${operation} during ${moment} cannot publish selected frames`, async () => {
    let id = "", ledger: KimiExecPending | undefined;
    const close = () => { if (operation === "cancel") f.router.actions.cancel(id); else f.router.actions.complete(id); };
    const f = fixture({ action: false, prepared(r) { ledger = r.atomicPending; },
      reply: () => {
        if (moment === "dispatch") close();
        return response(wire(textOutput()), 3, () => { if (moment === "eof") close(); });
      } });
    try {
      const a = await action(f); id = a.id;
      if (moment === "auth") {
        const get = f.auth.get.bind(f.auth); f.auth.get = async (...args) => { const c = await get(...args); close(); return c; };
      }
      if (moment === "usage") f.router.usage.refresh = async () => { close(); return false; };
      const r = await send(f, seed(), a.ingressPrefix);
      assert.notEqual(r.res.statusCode, 200); assert(!r.res.data.includes("content_block_start")); assert(!r.res.data.includes("message_stop"));
      assert.equal(f.stats().commits, 0); assert.equal(f.stats().successes, 0); assert.equal(f.cache.size, 0);
      assert.equal(f.sent.length, moment === "dispatch" || moment === "eof" ? 1 : 0); assert.equal(ledger?.byteSize ?? 0, 0);
    } finally { f.router.close(); }
  });

test("C4 cancelled queued waiter never authenticates; cancelled predecessor cannot publish", async () => {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { release = r; });
  const f = fixture({ action: false }); let id = "";
  const get = f.auth.get.bind(f.auth);
  f.auth.get = async (...args) => { const c = await get(...args); entered(); await gate; return c; };
  try {
    const a = await action(f); id = a.id; const ctx = f.router.actions.context(a.id, "claude-code"), first = collect(f, seed(), ctx);
    await started;
    const second = collect(f, seed(), ctx); f.controller.abort(); release();
    const results = await Promise.all([first, second]);
    assert(results.every(r => r.error && r.seen.length === 0)); assert.equal(f.auth.gets, 1); assert.equal(f.sent.length, 0);
    assert.equal(f.cache.size, 0); assert.equal(f.stats().successes, 0);
    f.router.actions.complete(id);
  } finally { release(); f.router.close(); }
});

test("C4 request deadline after auth wait prevents quota and physical dispatch", async () => {
  let now = 0;
  const f = fixture({ action: false, clock: { now: () => now, monotonic: () => now, random: () => 0 } });
  const get = f.auth.get.bind(f.auth);
  f.auth.get = async (...args) => { const c = await get(...args); now = 600001; return c; };
  try {
    const a = await action(f), r = await collect(f, seed(), f.router.actions.context(a.id, "claude-code"));
    code(r.error, "request_timeout"); assert.deepEqual(r.seen, []); assert.equal(f.stats().reserves, 0); assert.equal(f.sent.length, 0);
  } finally { f.router.close(); }
});

// Invalid billing is rejected by configuration; the pure resolver must not widen it either.
test("C6 resolver does not select ordered codec for API billing or Codex ingress", () => {
  assert.equal(resolveDestination({ ...profile, billing: "api" }, "messages", seed(), true).codec, undefined);
  assert.deepEqual(resolveDestination(profile, "responses", { input: "hello" }, true), { protocol: "responses" });
});

for (const mutation of ["segmentation", "text", "tool-id", "arguments", "history"]) test(`C5 exact published tool prefix rejects ${mutation} without another dispatch`, async () => {
  const f = fixture({ action: false, reply: () => response(wire(output())) });
  try {
    const a = await action(f), one = seed(), first = await send(f, one, a.ingressPrefix); assert.equal(first.res.statusCode, 200);
    const published = assistant(first.res, false), blocks = published["content"] as Item[];
    if (mutation === "segmentation") blocks.splice(0, 2, { type: "text", text: String(blocks[0]!["text"]) + String(blocks[1]!["text"]) });
    if (mutation === "text") blocks[0]!["text"] = "changed";
    if (mutation === "tool-id") blocks[2]!["id"] = "changed-id";
    if (mutation === "arguments") blocks[2]!["input"] = { n: 8 };
    const two = { ...one, messages: [...one["messages"] as Item[], published,
      { role: "user", content: [{ type: "tool_result", tool_use_id: mutation === "tool-id" ? "changed-id" : "caller-id", content: "result" }] }] };
    if (mutation === "history") two.messages[0] = { role: "system", content: "changed history" };
    const r = await collect(f, two, f.router.actions.context(a.id, "claude-code"));
    code(r.error, "continuity_unavailable"); assert.deepEqual(r.seen, []); assert.equal(f.sent.length, 1); assert.equal(f.stats().commits, 1);
  } finally { f.router.close(); }
});

test("C4 credential generation is checked inside the selected physical-dispatch microtask", async () => {
  const f = fixture({ action: false });
  f.auth.identity = () => { queueMicrotask(() => { f.auth.generation = "generation2"; }); return { "user-agent": "subswitch/synthetic" }; };
  try {
    const a = await action(f), r = await collect(f, seed(), f.router.actions.context(a.id, "claude-code"));
    code(r.error, "credential_owner_changed"); assert.deepEqual(r.seen, []); assert.equal(f.sent.length, 0); assert.equal(f.stats().commits, 0); assert.equal(f.cache.size, 0);
  } finally { f.router.close(); }
});

for (const moment of ["response", "body-eof"] as const) for (const operation of ["complete", "cancel"] as const)
  test(`KVS-1 action ${operation} at 401 ${moment} cannot initiate credential refresh`, async () => {
    let id = "", drained = false;
    const close = () => { f.router.actions[operation](id); };
    const f = fixture({ action: false, reply: () => {
      if (moment === "response") { close(); return new Response("unauthorized", { status: 401 }); }
      let sent = false;
      return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
        if (!sent) { sent = true; controller.enqueue(Buffer.from("unauthorized")); }
        else { drained = true; controller.close(); close(); }
      } }), { status: 401 });
    } });
    try {
      const a = await action(f); id = a.id;
      const r = await send(f, seed("leading", true), a.ingressPrefix);
      if (operation === "complete") {
        assert.equal(r.res.statusCode, 409); assert.equal(JSON.parse(r.res.data).error.message, "action_admission_closed");
      } else {
        assert(r.res.destroyed); assert.equal(r.res.statusCode, 0); assert.equal(r.res.data, "");
      }
      assert.equal(drained, moment === "body-eof");
      assert(!r.res.data.includes("content_block_start")); assert(!r.res.data.includes("message_stop"));
      assert.equal(f.auth.refreshCount, 0, "a closed action must not initiate target credential refresh");
      assert.equal(f.sent.length, 1); assert(f.sent[0]!.url.endsWith("/v1/responses"));
      assert.equal(f.effects().physicalAdmissions, 1); assert.equal(f.effects().cacheWriteCalls, 0);
      assert.equal(f.stats().commits, 0); assert.equal(f.stats().successes, 0); assert.equal(f.cache.size, 0);
      assert.equal(f.stats().releases, 1);
    } finally { f.router.close(); }
  });

for (const reason of ["request_cancelled", "request_timeout"] as const)
  test(`KVS-1 ${reason} at 401 body EOF cannot initiate credential refresh`, async () => {
    let deadline: (() => void) | undefined, drained = false;
    const f = fixture({ action: false,
      clock: { now: () => 0, monotonic: () => 0, random: () => 0, schedule(callback, delay) {
        if (delay === 600000) deadline = callback;
        return () => {};
      } },
      reply: () => {
        let sent = false;
        return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
          if (!sent) { sent = true; controller.enqueue(Buffer.from("unauthorized")); }
          else {
            drained = true; controller.close();
            if (reason === "request_timeout") { assert(deadline); deadline(); }
            else f.controller.abort(new RoutingError(reason, 499));
          }
        } }), { status: 401 });
      } });
    try {
      const a = await action(f), context = f.router.actions.context(a.id, "claude-code");
      const r = await collect(f, seed(), context);
      code(r.error, reason); assert(drained); assert.deepEqual(r.seen, []);
      assert.equal(f.auth.refreshCount, 0); assert.equal(f.sent.length, 1);
      assert.equal(f.effects().physicalAdmissions, 1); assert.equal(f.effects().cacheWriteCalls, 0);
      assert.equal(f.stats().commits, 0); assert.equal(f.stats().successes, 0); assert.equal(f.cache.size, 0);
      assert.equal(f.stats().releases, 1);
      f.router.actions.complete(a.id);
    } finally { f.router.close(); }
  });

for (const rotate of [false, true]) test(`KVS-1 active action 401 retains refresh lineage rotate${rotate}`, async () => {
  const f = fixture({ action: false, reply: n => n === 1 ? new Response("unauthorized", { status: 401 }) : response(wire(output())) });
  f.auth.rotateOnRefresh = rotate;
  try {
    const a = await action(f), r = await send(f, seed("leading", true), a.ingressPrefix);
    assert.equal(f.auth.refreshCount, 1); assert.equal(f.sent.length, rotate ? 1 : 2);
    assert.equal(f.effects().physicalAdmissions, f.sent.length); assert(f.sent.every(s => s.url.endsWith("/v1/responses")));
    assert.equal(f.stats().commits, rotate ? 0 : 1); assert.equal(f.stats().successes, rotate ? 0 : 1);
    assert.equal(f.cache.size, rotate ? 0 : 1);
    if (rotate) {
      assert.equal(r.res.statusCode, 409); assert.equal(JSON.parse(r.res.data).error.message, "credential_owner_changed");
      assert(!r.res.data.includes("content_block_start")); assert(!r.res.data.includes("message_stop"));
      assert.equal(f.effects().cacheWriteCalls, 0);
    } else {
      assert.equal(r.res.statusCode, 200); assert(r.res.data.includes("message_stop"));
      assert.deepEqual(f.sent[0]!.body, f.sent[1]!.body);
      assert.equal(f.router.actions.affinity(f.router.actions.context(a.id, "claude-code"), "work").selectedOwner,
        ownerKey(profile, target, "responses", "generation1", "kimi-ordered-messages-v4"));
    }
    await finish(f, a.id);
  } finally { f.router.close(); }
});
