/** Fabricated auth and in-memory SSE exercise the owning-store receipt at attempt boundaries. */
import assert from "node:assert/strict";
import { it } from "node:test";
import { noopLogger } from "../../src/logger.js";
import { ActionStore } from "../../src/routing/action-store.js";
import { systemClock } from "../../src/routing/clock.js";
import { ProfileAuth } from "../../src/routing/profile-auth.js";
import { RoutedAttempts, type AttemptRequest } from "../../src/routing/routed-attempt.js";
import type { AccessProfile } from "../../src/routing/routing-types.js";
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
    let sends = 0;
    const attempts = new RoutedAttempts(auth, noopLogger, async () => {
      sends++;
      return new Response(responsesSse([created(target.model), terminal(target.model, [])]), {
        headers: { "content-type": "text/event-stream" },
      });
    }, systemClock, "subswitch", () => { if (moment === "dispatch") release(); }, undefined, actions);
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
