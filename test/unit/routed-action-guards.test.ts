import assert from "node:assert/strict";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { it, type TestContext } from "node:test";
import { loadConfig } from "../../src/config.js";
import { noopLogger } from "../../src/logger.js";
import { ActionStore } from "../../src/routing/action-store.js";
import { systemClock, type RoutingClock } from "../../src/routing/clock.js";
import type { BoundCredential } from "../../src/routing/profile-auth.js";
import { RoutedAttempts, type AttemptRequest } from "../../src/routing/routed-attempt.js";
import {
  RoutingError,
  type AccessProfile,
  type ActionContext,
  type Item,
  type OriginatingClient,
  type RouteTarget,
} from "../../src/routing/routing-types.js";
import { SharedRouting } from "../../src/routing/shared-routing.js";
import { created, responsesSse, terminal } from "../helpers/responses-sse.js";

const route = "work";
const conversation = "synthetic-invocation";
const codexBody = { model: route, input: "synthetic" };
const messagesBody = {
  model: route,
  max_tokens: 128,
  messages: [{ role: "user", content: "synthetic" }],
};

function fixture(t: TestContext, client: OriginatingClient = "codex", clock: RoutingClock = systemClock) {
  const codex = client === "codex";
  const profile: AccessProfile = {
    provider: codex ? "codex" : "claude",
    product: codex ? "chatgpt-codex" : "claude-code",
    billing: "subscription",
    account: "synthetic",
    credential: { kind: "native-oauth", authFile: "/synthetic/unused.json" },
  };
  const target: RouteTarget = {
    profile: "fixture", model: codex ? "gpt-6.2-sol" : "claude-sonnet-5", effort: "high",
  };
  const loaded = loadConfig({
    configPath: "/synthetic/config.json", env: {},
    readFile: () => JSON.stringify({
      configVersion: 2,
      accessProfiles: { fixture: profile },
      routes: { [route]: { clients: [client], primary: target } },
      codexIngress: { enabled: true },
    }),
  });
  if (!loaded.ok) assert.fail(loaded.error.message);

  const fetchImpl = t.mock.fn(async () => new Response(
    responsesSse([created(target.model), terminal(target.model, [])]),
    { headers: { "content-type": "text/event-stream" } },
  ));
  const router = new SharedRouting(loaded.value.config, noopLogger, clock, fetchImpl);
  t.after(() => router.close());

  const { auth } = router.attempts;
  const credential: BoundCredential = {
    provider: profile.provider, profile: target.profile,
    generation: "initial-generation", binding: "synthetic-binding", authHeaders: {},
  };
  const has = t.mock.method(auth, "has", () => true);
  const get = t.mock.method(auth, "get", async () => credential);
  const validate = t.mock.method(auth, "validate", () => undefined);
  const scope = t.mock.method(auth, "scope");
  const refresh = t.mock.method(auth, "refresh", async () => assert.fail("unexpected credential refresh"));
  const usage = t.mock.method(router.usage, "refresh");
  const reserve = t.mock.method(router.quota, "reserve");
  const calls = () => ({
    has: has.mock.callCount(), get: get.mock.callCount(), validate: validate.mock.callCount(),
    scope: scope.mock.callCount(), refresh: refresh.mock.callCount(), usage: usage.mock.callCount(),
    reserve: reserve.mock.callCount(), fetch: fetchImpl.mock.callCount(),
  });
  const run = (body: Item, action?: ActionContext, receipt?: AbortSignal) =>
    router.events(body, client, route, new AbortController().signal, action, receipt);
  const request: AttemptRequest = {
    profile, target, body: codexBody, protocol: "responses", conversation, route,
    signal: new AbortController().signal, refreshes: new Set(),
  };
  return { router, auth, get, credential, fetchImpl, calls, run, request };
}

const noCalls = { has: 0, get: 0, validate: 0, scope: 0, refresh: 0, usage: 0, reserve: 0, fetch: 0 };
const isRoutingError = (code: string, status: number) => (error: unknown) =>
  error instanceof RoutingError && error.code === code && error.status === status;

async function rejectsRoute(events: AsyncIterable<Item>, code: string, status: number) {
  await assert.rejects(async () => {
    for await (const _event of events) assert.fail("rejected route emitted an event");
  }, isRoutingError(code, status));
}

function codexAction(actions: ActionStore) {
  return actions.context(actions.create("codex", conversation).id, "codex");
}

function admit(t: TestContext, actions: ActionStore, action: ActionContext): AbortSignal {
  const controller = new AbortController();
  t.after(actions.admit(action, controller));
  return controller.signal;
}

const identityChanges = [
  ["unknown", { actionId: "00000000-0000-0000-0000-000000000000" }],
  ["client", { client: "claude-code" }],
  ["namespace", { namespace: "other-namespace" }],
  ["conversation", { conversationId: "other-conversation" }],
  ["agent", { agentId: "other-agent" }],
  ["parent", { parentActionId: "other-parent" }],
] as const satisfies readonly (readonly [string, Partial<ActionContext>])[];

// A: src/routing/shared-routing.ts:204-214,253 rejects invalid action identity before target access.
for (const [kind, change] of identityChanges) {
  it(`rejects the ${kind} Codex action before target access`, async t => {
    const f = fixture(t);
    const { actions } = f.router;
    const action = codexAction(actions);
    const receipt = admit(t, actions, action);
    await rejectsRoute(f.run(codexBody, { ...action, ...change }, receipt), "action_state_lost", 409);
    assert.deepEqual(f.calls(), noCalls);
  });
}

// A: src/routing/shared-routing.ts:204-214,253 requires a live action and a receipt from its store.
for (const kind of ["foreign-store", "expired", "closing", "cancelled"] as const) {
  it(`rejects the ${kind} Codex action before target access`, async t => {
    const f = fixture(t);
    const { actions } = f.router;
    const store = kind === "foreign-store" ? new ActionStore() : actions;
    if (store !== actions) t.after(() => store.close());
    const action = codexAction(store);
    const receipt = kind === "expired" ? undefined : admit(t, store, action);
    if (kind === "expired" || kind === "closing") actions.complete(action.actionId);
    if (kind === "cancelled") actions.cancel(action.actionId);

    if (kind === "closing") {
      await rejectsRoute(f.run(codexBody, action), "action_admission_closed", 409);
    } else if (kind === "cancelled") {
      await rejectsRoute(f.run(codexBody, action, receipt), "action_cancelled", 499);
    }
    // A different signal does not give access to a closed action.
    const signal = kind === "closing" || kind === "cancelled" ? new AbortController().signal : receipt;
    await rejectsRoute(f.run(codexBody, action, signal), "action_state_lost", 409);
    assert.deepEqual(f.calls(), noCalls);
  });
}

// B: src/routing/action-ingress.ts:58-59 requires an ingress prefix for action context.
it("ignores action headers and metadata without an ingress prefix", t => {
  const { router } = fixture(t, "claude-code");
  const action = router.actions.create("claude-code", conversation);
  const req = new IncomingMessage(new Socket());
  req.method = "POST";
  req.url = "/v1/messages";
  req.headers = { "x-subswitch-action": action.id, "thread-id": action.id };
  const body = { ...messagesBody, client_metadata: { actionId: action.id } };

  router.stripPrefix(req);
  assert.equal(router.admitHttp(req, new ServerResponse(req), "claude-code"), undefined);
  assert.equal(router.context(req, "claude-code", body), undefined);
});

// C: src/routing/routed-attempt.ts:91-93,102 rejects action context without its store.
it("requires an action store before attempt auth", async t => {
  const f = fixture(t);
  const action = codexAction(f.router.actions);
  const admissionSignal = admit(t, f.router.actions, action);
  const attempts = new RoutedAttempts(f.auth, noopLogger, f.fetchImpl, systemClock, "subswitch");

  await assert.rejects(attempts.prepare({ ...f.request, action, admissionSignal }),
    isRoutingError("action_identity_required", 409));
  assert.deepEqual(f.calls(), noCalls);
});

// D: src/routing/shared-routing.ts:361-363 passes the pinned owner to the attempt.
it("rejects a changed credential owner after a Codex action commits", async t => {
  const f = fixture(t);
  const { actions } = f.router;
  const action = codexAction(actions);
  let last: unknown;
  for await (const event of f.run(codexBody, action)) last = event["type"];
  assert.equal(last, "response.completed");
  assert.equal(f.calls().fetch, 1);
  const before = structuredClone(actions.affinity(action, route));
  assert.deepEqual(before.selectedTarget, f.request.target);
  assert.ok(before.selectedOwner);

  f.get.mock.mockImplementation(async () => ({ ...f.credential, generation: "next-generation" }));
  await rejectsRoute(f.run(codexBody, action), "credential_owner_changed", 409);
  assert.equal(f.calls().get, 2);
  assert.equal(f.calls().fetch, 1);
  assert.deepEqual(actions.affinity(action, route), before);
});

// D: src/routing/routed-attempt.ts:111-112 rejects a different owner before dispatch.
it("rejects a foreign expected owner before attempt dispatch", async t => {
  const f = fixture(t);
  await assert.rejects(f.router.attempts.prepare({ ...f.request, expectedOwner: "foreign-owner" }),
    isRoutingError("credential_owner_changed", 409));
  assert.equal(f.calls().get, 1);
  assert.equal(f.calls().fetch, 0);
});

// E: src/routing/shared-routing.ts:303 checks the deadline after credential lookup.
it("rejects a route whose deadline passes during credential lookup", async t => {
  let now = 0;
  const clock: RoutingClock = { now: () => now, monotonic: () => now, random: () => 0.5 };
  const f = fixture(t, "codex", clock);
  f.get.mock.mockImplementation(async () => {
    now += 600_001;
    return f.credential;
  });

  await rejectsRoute(f.run(codexBody, codexAction(f.router.actions)), "request_timeout", 504);
  assert.deepEqual(f.calls(), { ...noCalls, has: 1, get: 1 });
});

// F: src/routing/shared-routing.ts:225-226 caps the reconstructed request size.
it("rejects an oversized reconstructed Messages request before credential lookup", async t => {
  const f = fixture(t, "claude-code");
  const body = { ...messagesBody, metadata: "x".repeat(32 * 1024 * 1024 + 1) };

  await rejectsRoute(f.run(body), "reconstructed_request_too_large", 413);
  assert.deepEqual(f.calls(), noCalls);
});

// G: src/routing/target-capabilities.ts:21-28 rejects invalid output caps at src/routing/shared-routing.ts:273.
for (const maxTokens of [null, 0, -1, Number.MAX_SAFE_INTEGER + 1]) {
  it(`rejects Messages max_tokens=${maxTokens} before credential lookup`, async t => {
    const f = fixture(t, "claude-code");
    await rejectsRoute(f.run({ ...messagesBody, max_tokens: maxTokens }), "invalid_output_limit", 400);
    assert.equal(f.calls().get, 0);
    assert.equal(f.calls().reserve, 0);
    assert.equal(f.calls().fetch, 0);
  });
}
