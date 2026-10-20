import assert from "node:assert/strict";
import { test } from "node:test";
import { createKimiSubscription, type KimiSubscriptionFixtureOptions } from "../../src/kimi-subscription.js";
import { SUBSWITCH_VERSION } from "../../src/version.js";
import { RoutingError } from "../../src/routing/routing-types.js";
import { fixtureStore, fixtureOptions, fixtureBody, refreshResponse, fixtureScope } from "../fixtures/kimi-subscription.js";

const signal = () => new AbortController().signal;
test("production gate rejects before reading a store, endpoint or transport", () => {
  assert.throws(() => createKimiSubscription(), /contract_unverified/);
  const options = new Proxy({}, { get(_object, key) { if (key === "mode") return "production"; return assert.fail("production options accessed"); } });
  assert.throws(() => createKimiSubscription(options as KimiSubscriptionFixtureOptions), /contract_unverified/);
});
test("fixture refuses wrong product, region, service origin and native client registration before store use", () => {
  const f = fixtureStore(); const opts = fixtureOptions(f.store, async () => assert.fail("transport called"));
  for (const changes of [{ scope: { ...fixtureScope, product: "kimi-platform" } }, { scope: { ...fixtureScope, region: "unknown" } },
    { origin: "https://api.kimi.ai" }, { origin: "http://127.0.0.1:1/other" }, { clientId: "17e5f671-d194-4dfb-9706-5516cb48c098" }]) {
    assert.throws(() => createKimiSubscription({ ...opts, ...changes } as KimiSubscriptionFixtureOptions));
  }
  assert.equal(f.stats.reads, 0);
});
test("expired fixture refresh carries true Subswitch identity and preserves unknown native fields", async () => {
  const f = fixtureStore(true); let authCalls = 0;
  const native = createKimiSubscription(fixtureOptions(f.store, async (url, init) => {
    authCalls++; assert.equal(String(url), "http://127.0.0.1:1/fixture/oauth/token");
    assert.equal(init?.redirect, "error"); const headers = new Headers(init?.headers);
    assert.equal(headers.get("user-agent"), `subswitch/${SUBSWITCH_VERSION}`); assert.equal(headers.get("x-msh-platform"), "subswitch");
    assert.equal(headers.get("x-msh-version"), SUBSWITCH_VERSION); assert.equal(headers.get("authorization"), null);
    const body = init?.body as URLSearchParams; assert.equal(body.get("client_id"), "subswitch-offline-fixture");
    assert.equal(body.get("grant_type"), "refresh_token"); assert.equal(body.get("refresh_token"), "fabricated-refresh-token");
    return refreshResponse();
  }));
  const credential = await native.getCredentials(); assert.equal(credential.ok, true);
  if (credential.ok) assert.equal(credential.value.authHeaders.authorization, "Bearer fabricated-new-access-token");
  assert.equal(f.inspect().tokens.unknown_native_field, "preserved"); assert.equal(authCalls, 1); assert.equal(f.stats.writes, 1);
  assert.deepEqual(native.budget(), { attempts: 0, tokens: 0, refreshes: 1 });
});
test("shared store lock coalesces two managers' refresh and preserves the uncancelled waiter", async () => {
  const f = fixtureStore(true); let started!: () => void, finish!: () => void, calls = 0;
  const began = new Promise<void>(r => { started = r; }); const parked = new Promise<void>(r => { finish = r; });
  const transport: typeof fetch = async () => { calls++; started(); await parked; return refreshResponse(); };
  const a = createKimiSubscription(fixtureOptions(f.store, transport)), b = createKimiSubscription(fixtureOptions(f.store, transport));
  const controller = new AbortController(); const first = a.credentials(controller.signal); const rejected = assert.rejects(first, /cancelled/);
  await began; const second = b.credentials(signal()); controller.abort(); await rejected; finish();
  assert.equal((await second).authHeaders.authorization, "Bearer fabricated-new-access-token");
  assert.equal(calls, 1); assert.equal(f.stats.maxLocks, 1); assert.equal(f.stats.writes, 1);
});
test("native replacement during refresh cannot be overwritten or adopted as the parked owner", async () => {
  const f = fixtureStore(true);
  const native = createKimiSubscription(fixtureOptions(f.store, async () => { f.replace({ ...fixtureScope, generation: "different-login" }); return refreshResponse(); }));
  await assert.rejects(native.credentials(signal()), /owner_changed/); assert.equal(f.stats.writes, 0);
  assert.equal(f.inspect().scope.generation, "different-login");
});
test("store scope validates independently of key order and refuses a different region before refresh", async () => {
  const f = fixtureStore(); let calls = 0;
  const native = createKimiSubscription(fixtureOptions(f.store, async () => { calls++; return refreshResponse(); }));
  f.replace({ generation: fixtureScope.generation, account: fixtureScope.account, region: fixtureScope.region, product: fixtureScope.product });
  await native.credentials(signal());
  f.replace({ ...fixtureScope, region: "mainland-cn" });
  await assert.rejects(native.credentials(signal()), /owner_changed/); assert.equal(calls, 0);
});
test("failed refresh is not retried automatically and the global refresh allowance cannot be reset", async () => {
  const f = fixtureStore(true); let calls = 0;
  const native = createKimiSubscription({ ...fixtureOptions(f.store, async () => { calls++; return new Response("fabricated-secret", { status: 500 }); }), limits: { refreshes: 1 } });
  await assert.rejects(native.credentials(signal()), /refresh_failed/);
  await assert.rejects(native.credentials(signal()), /refresh_budget/);
  assert.equal(calls, 1); assert.equal(f.stats.writes, 0);
});
test("concurrent forced refreshes adopt the winning revision without changing action generation", async () => {
  const f = fixtureStore(); let calls = 0;
  const transport: typeof fetch = async () => { calls++; return refreshResponse(); };
  const a = createKimiSubscription(fixtureOptions(f.store, transport)), b = createKimiSubscription(fixtureOptions(f.store, transport));
  const original = (await a.credentials(signal())).generation;
  const results = await Promise.all([a.credentials(signal(), true), b.credentials(signal(), true)]);
  assert.equal(calls, 1); assert.ok(results.every(value => value.generation === original));
});
test("401 retry is explicit, bounded and charged as another inference; no transient automatic retry", async () => {
  const f = fixtureStore(); let models = 0;
  const native = createKimiSubscription(fixtureOptions(f.store, async (url) => {
    if (String(url).endsWith("/token")) return refreshResponse();
    return ++models === 1 ? new Response("fabricated auth error", { status: 401 }) : new Response("data: ready\n\n");
  }));
  const response = await native.request("messages", fixtureBody("messages"), signal());
  assert.match(response.headers.get("content-type")!, /^text\/plain/, "auth boundary must not manufacture an SSE content type");
  await response.text();
  assert.deepEqual(native.budget(), { attempts: 2, tokens: 512, refreshes: 1 });
  const limited = createKimiSubscription({ ...fixtureOptions(f.store, async () => new Response("quota", { status: 429 })), limits: { attempts: 1 } });
  await assert.rejects(limited.request("messages", fixtureBody("messages"), signal()), /upstream_failed/);
  await assert.rejects(limited.request("messages", fixtureBody("messages"), signal()), /inference_budget/);
  assert.equal(limited.budget().attempts, 1);
});
test("caps refuse before auth/dispatch, and a seventh admitted inference cannot reset the token budget", async () => {
  const f = fixtureStore(); let calls = 0;
  const native = createKimiSubscription(fixtureOptions(f.store, async () => { calls++; return new Response("ready"); }));
  for (const cap of [undefined, 257, 0]) await assert.rejects(native.request("messages", { ...fixtureBody("messages"), max_tokens: cap }, signal()), /request_boundary/);
  assert.equal(f.stats.reads, 0); assert.equal(calls, 0);
  for (let i = 0; i < 6; i++) await (await native.request("messages", fixtureBody("messages"), signal())).text();
  const readsBeforeExhaustion = f.stats.reads;
  await assert.rejects(native.request("messages", fixtureBody("messages"), signal()), /inference_budget/);
  assert.equal(f.stats.reads, readsBeforeExhaustion, "known exhausted inference must not start more auth work");
  assert.deepEqual(native.budget(), { attempts: 6, tokens: 1536, refreshes: 0 }); assert.equal(calls, 6);
});
test("refresh errors and thrown store/transport errors cannot disclose token-shaped details", async () => {
  for (const mode of ["throw", "response"] as const) {
    const f = fixtureStore(true);
    const native = createKimiSubscription(fixtureOptions(f.store, async () => {
      if (mode === "throw") throw new RoutingError("fabricated-refresh-token fabricated-access-token");
      return new Response("fabricated-refresh-token fabricated-access-token", { status: 401 });
    }));
    const result = await native.getCredentials(); assert.equal(result.ok, false);
    assert.doesNotMatch(JSON.stringify(result), /fabricated-(refresh|access)-token/);
  }
});
test("request deadline covers stalled headers and body; abort cancels the owned stream", async () => {
  for (const mode of ["headers", "body"] as const) {
    const f = fixtureStore(); let cancelled = false;
    const native = createKimiSubscription({ ...fixtureOptions(f.store, async (_url, init) => {
      if (mode === "headers") return new Promise<Response>((_yes, no) => init?.signal?.addEventListener("abort", () => no(new Error("fabricated secret")), { once: true }));
      return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("partial")); }, cancel() { cancelled = true; } }));
    }), limits: { requestMs: 50 } });
    const keepAlive = setTimeout(() => {}, 200);
    try { await assert.rejects((async () => (await native.request("responses", fixtureBody("responses"), signal())).text())(), /cancelled/); }
    finally { clearTimeout(keepAlive); }
    if (mode === "body") assert.equal(cancelled, true);
    assert.equal(native.budget().attempts, 1);
  }
});
test("refresh deadline bounds a stalled auth response and never publishes after failure", async () => {
  const f = fixtureStore(true);
  const native = createKimiSubscription({ ...fixtureOptions(f.store, async (_url, init) => new Promise<Response>((_yes, no) => {
    init?.signal?.addEventListener("abort", () => no(new Error("fabricated token")), { once: true });
  })), limits: { requestMs: 40 } });
  const keepAlive = setTimeout(() => {}, 200);
  try { await assert.rejects(native.credentials(signal()), /cancelled|auth_failed/); }
  finally { clearTimeout(keepAlive); }
  assert.equal(f.stats.writes, 0); assert.equal(native.budget().refreshes, 1);
});
test("phase deadline stops later admission before storage or transport", async () => {
  const f = fixtureStore();
  const native = createKimiSubscription({ ...fixtureOptions(f.store, async () => assert.fail("transport called")), limits: { phaseMs: 1 } });
  await new Promise(resolve => setTimeout(resolve, 10));
  await assert.rejects(native.request("messages", fixtureBody("messages"), signal()), /phase_deadline/);
  assert.equal(f.stats.reads, 0); assert.deepEqual(native.budget(), { attempts: 0, tokens: 0, refreshes: 0 });
});
test("upstream stream failure remains a transport error and never exposes its raw error", async () => {
  const f = fixtureStore();
  const native = createKimiSubscription(fixtureOptions(f.store, async () => new Response(new ReadableStream({
    start(controller) { controller.error(new Error("fabricated-access-token")); },
  }))));
  await assert.rejects((await native.request("messages", fixtureBody("messages"), signal())).text(), error => {
    assert.ok(error instanceof RoutingError); assert.equal(error.status, 502); assert.match(error.message, /transport_failed/);
    assert.doesNotMatch(error.message, /fabricated-access-token/); return true;
  });
});
test("pre-aborted credentials and requests reject without starting store or transport work", async () => {
  const f = fixtureStore();
  const native = createKimiSubscription(fixtureOptions(f.store, async () => assert.fail("transport called")));
  const caller = AbortSignal.abort();
  await assert.rejects(native.credentials(caller), /cancelled/);
  for (const protocol of ["messages", "responses"] as const) {
    await assert.rejects(native.request(protocol, fixtureBody(protocol), caller), /cancelled/);
  }
  // Let Node report any orphan rejection after the caught request errors.
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.stats.reads, 0);
  assert.equal(f.stats.writes, 0);
  assert.deepEqual(native.budget(), { attempts: 0, tokens: 0, refreshes: 0 });
});
test("cancellation from a supplied operation still observes that operation's rejection", async () => {
  const f = fixtureStore(); const caller = new AbortController(); let reads = 0;
  const native = createKimiSubscription(fixtureOptions({ ...f.store, async read(wait) {
    reads++; caller.abort(); wait.throwIfAborted(); return f.store.read(wait);
  } }, async () => assert.fail("transport called")));
  await assert.rejects(native.credentials(caller.signal), /cancelled/);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(reads, 1);
  assert.deepEqual(native.budget(), { attempts: 0, tokens: 0, refreshes: 0 });
});
test("serialized request boundaries reject toJSON cap, model and stream changes before authentication", async () => {
  for (const protocol of ["messages", "responses"] as const) {
    const f = fixtureStore();
    const native = createKimiSubscription(fixtureOptions(f.store, async () => assert.fail("transport called")));
    const cap = protocol === "messages" ? "max_tokens" : "max_output_tokens";
    for (const snapshot of [{ ...fixtureBody(protocol), [cap]: 4096 },
      { ...fixtureBody(protocol), model: "other-model" }, { ...fixtureBody(protocol), stream: false },
      null, [], undefined, 17]) {
      await assert.rejects(native.request(protocol, { ...fixtureBody(protocol), [cap]: 1,
        toJSON: () => snapshot }, signal()), /request_boundary/);
    }
    assert.equal(f.stats.reads, 0);
    assert.deepEqual(native.budget(), { attempts: 0, tokens: 0, refreshes: 0 });
  }
});
test("request accounting uses the single serialized snapshot for toJSON and changing accessors", async () => {
  for (const protocol of ["messages", "responses"] as const) {
    const f = fixtureStore(); const cap = protocol === "messages" ? "max_tokens" : "max_output_tokens";
    let serialized = 0, accesses = 0; const sent: string[] = [];
    const native = createKimiSubscription(fixtureOptions(f.store, async (_url, init) => {
      sent.push(init!.body as string); return new Response("ready");
    }));
    const snapshot = fixtureBody(protocol);
    await (await native.request(protocol, { ...fixtureBody(protocol), [cap]: 1,
      toJSON() { serialized++; return snapshot; } }, signal())).text();
    const accessorBody = { ...fixtureBody(protocol) };
    Object.defineProperty(accessorBody, cap, { enumerable: true, get() { return ++accesses === 1 ? 1 : 4096; } });
    await (await native.request(protocol, accessorBody, signal())).text();
    assert.equal(serialized, 1); assert.equal(accesses, 1);
    assert.equal(sent[0], JSON.stringify(snapshot));
    assert.equal(JSON.parse(sent[1]!)[cap], 1);
    assert.deepEqual(native.budget(), { attempts: 2, tokens: 257, refreshes: 0 });
  }
});
