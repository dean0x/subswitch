/** Fabricated auth and in-memory SSE exercise the owning-store receipt at attempt boundaries. */
import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import { ClaudeCache } from "../../src/claude-cache.js";
import { noopLogger } from "../../src/logger.js";
import { ActionStore } from "../../src/routing/action-store.js";
import { systemClock } from "../../src/routing/clock.js";
import { ownerKey } from "../../src/routing/continuation-store.js";
import { ProfileAuth } from "../../src/routing/profile-auth.js";
import { RoutedAttempts, type AttemptRequest } from "../../src/routing/routed-attempt.js";
import { RoutingError, type AccessProfile } from "../../src/routing/routing-types.js";
import { nativeCredential } from "../fixtures/native-profile.js";
import { created, responsesSse, terminal } from "../helpers/responses-sse.js";

const target = { profile: "fixture", model: "gpt-6.2-sol", effort: "high" };
const profile: AccessProfile = {
  provider: "codex", product: "chatgpt-codex", billing: "subscription",
  account: "synthetic", credential: nativeCredential("codex"),
};

for (const moment of ["forged", "auth", "dispatch", "commit"] as const)
  it(`rejects an unavailable ordinary attempt receipt at ${moment}`, async t => {
    const actions = new ActionStore();
    const controller = new AbortController();
    const action = actions.create("codex", "owned-invocation");
    const context = actions.context(action.id, "codex");
    const release = actions.admit(context, controller);
    const auth = new ProfileAuth({ fixture: profile }, noopLogger);
    const get = auth.get.bind(auth);
    const observedGet = t.mock.method(auth, "get", async (...args: Parameters<ProfileAuth["get"]>) => {
      const credential = await get(...args);
      if (moment === "auth") release();
      return credential;
    });
    if (moment === "dispatch") {
      const validate = auth.validate.bind(auth);
      let validations = 0;
      t.mock.method(auth, "validate", (credential: Parameters<ProfileAuth["validate"]>[0]) => {
        validate(credential);
        // Release the receipt after the synchronous check, before fetch runs in a microtask.
        if (++validations === 2) queueMicrotask(release);
      });
    }
    let sends = 0;
    const attempts = new RoutedAttempts(auth, noopLogger, async () => {
      sends++;
      return new Response(responsesSse([created(target.model), terminal(target.model, [])]), {
        headers: { "content-type": "text/event-stream" },
      });
    }, systemClock, "subswitch", actions);
    const request: AttemptRequest = { profile, target, protocol: "responses", conversation: "owned-invocation",
      route: "work", body: { model: "work", input: "synthetic" }, action: context,
      admissionSignal: moment === "forged" ? new AbortController().signal : controller.signal,
      signal: new AbortController().signal, refreshes: new Set() };
    try {
      actions.complete(action.id);
      if (moment !== "commit") {
        await assert.rejects(attempts.prepare(request), /action_state_lost/);
        assert.equal(sends, 0);
        assert.equal(observedGet.mock.callCount(), moment === "forged" ? 0 : 1);
      } else {
        const ready = await attempts.prepare(request);
        try {
          for await (const _event of ready.events) { /* consume the validated synthetic terminal */ }
          release();
          assert.throws(() => ready.commit(), /action_state_lost/);
          assert.equal(sends, 1);
        } finally { await ready.cancel(); }
      }
    } finally { release(); actions.close(); }
  });

const opaque = { type: "reasoning", id: "rs_fixture", summary: [], encrypted_content: "fabricated-state" };

function refreshAttempt(t: TestContext, reply: () => Response, rotate = false) {
  const actions = new ActionStore();
  const action = actions.create("codex", "refresh-invocation");
  const context = actions.context(action.id, "codex");
  const receipt = new AbortController();
  const release = actions.admit(context, receipt);
  t.after(() => { release(); actions.close(); });
  const caller = new AbortController();
  const profiles = { fixture: profile };
  const auth = new ProfileAuth(profiles, noopLogger);
  const refresh = t.mock.method(auth, "refresh", async (id: string, signal: AbortSignal) => {
    if (rotate) profiles.fixture = { ...profile, credential: nativeCredential("codex", "different-owner") };
    return auth.get(id, signal);
  });
  const sends: { url: string; body: RequestInit["body"] }[] = [];
  const attempts = new RoutedAttempts(auth, noopLogger, async (url, init) => {
    sends.push({ url: String(url), body: init?.body });
    return sends.length === 1 ? reply() : new Response(
      responsesSse([created(target.model), terminal(target.model, [opaque])]),
      { headers: { "content-type": "text/event-stream" } },
    );
  }, systemClock, "subswitch", actions);
  const cache = new ClaudeCache();
  Object.defineProperty(attempts, "replay", { value: cache });
  const writes = t.mock.method(cache, "putBatch");
  const request: AttemptRequest = { profile, target, protocol: "responses", conversation: context.conversationId,
    route: "work", body: { model: "work", input: "synthetic" }, action: context,
    admissionSignal: receipt.signal, signal: caller.signal, refreshes: new Set() };
  return { actions, action, release, caller, auth, refresh, sends, attempts, request, cache, writes };
}

for (const [moment, ending, status, code] of [
  ["response", "close", 409, "action_state_lost"],
  ["body EOF", "close", 409, "action_state_lost"],
  ["response", "cancel", 499, "action_cancelled"],
  ["body EOF", "cancel", 499, "action_cancelled"],
  ["body EOF", "caller abort", 499, "request_cancelled"],
  ["body EOF", "deadline", 504, "request_timeout"],
] as const) {
  it(`does not refresh after ${ending} at 401 ${moment}`, async t => {
    let drained = false;
    let sent = false;
    const stop = () => {
      if (ending === "close") { f.actions.complete(f.action.id); f.release(); }
      else if (ending === "cancel") f.actions.cancel(f.action.id);
      else f.caller.abort(new RoutingError(code, status));
    };
    const f = refreshAttempt(t, () => {
      if (moment === "response") {
        const response = new Response(null, { status: 401 });
        // Stop after fetch resolves, before the retry path reads the status.
        Object.defineProperty(response, "status", { get: () => { stop(); return 401; } });
        return response;
      }
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!sent) {
            sent = true;
            controller.enqueue(Buffer.from("unauthorized"));
          } else {
            drained = true;
            controller.close();
            stop();
          }
        },
      }, { highWaterMark: 0 }), { status: 401 });
    });
    await assert.rejects(f.attempts.prepare(f.request), { code, status });
    assert.equal(drained, moment === "body EOF");
    assert.equal(f.refresh.mock.callCount(), 0);
    assert.deepEqual(f.sends.map(send => send.url), ["https://chatgpt.com/backend-api/codex/responses"]);
    assert.equal(f.writes.mock.callCount(), 0);
    assert.equal(f.cache.size, 0);
  });
}

for (const rotate of [false, true]) {
  it(`retries a 401 only with unchanged credential lineage (rotate=${rotate})`, async t => {
    const f = refreshAttempt(t, () => new Response("unauthorized", { status: 401 }), rotate);
    const credential = await f.auth.get(target.profile, f.caller.signal);
    const attempt = f.attempts.prepare({ ...f.request, credential });
    if (rotate) await assert.rejects(attempt, { code: "credential_owner_changed", status: 409 });
    else {
      const ready = await attempt;
      try {
        const types: unknown[] = [];
        for await (const event of ready.events) types.push(event.payload.type);
        assert.equal(types.at(-1), "response.completed");
        assert.equal(ready.owner, ownerKey(profile, target, "responses", credential.generation));
        assert.equal(f.cache.size, 0, "output is not published before commit");
        ready.commit();
        const key = `opaque:${ready.owner}:${f.request.conversation}:${opaque.encrypted_content}`;
        assert.deepEqual(f.cache.get("snapshot", key)?.input, [opaque]);
        assert.equal(f.sends[0]?.body, f.sends[1]?.body);
      } finally { await ready.cancel(); }
    }
    assert.equal(f.refresh.mock.callCount(), 1);
    assert.equal(f.sends.length, rotate ? 1 : 2);
    assert.ok(f.sends.every(send => send.url === "https://chatgpt.com/backend-api/codex/responses"));
    assert.equal(f.writes.mock.callCount(), rotate ? 0 : 1);
    assert.equal(f.cache.size, rotate ? 0 : 1);
  });
}
