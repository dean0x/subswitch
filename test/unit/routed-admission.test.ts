/** Fabricated auth and in-memory SSE exercise the owning-store receipt at attempt boundaries. */
import assert from "node:assert/strict";
import { it } from "node:test";
import { noopLogger } from "../../src/logger.js";
import { systemClock } from "../../src/routing/clock.js";
import { RoutedAttempts, type AttemptRequest } from "../../src/routing/routed-attempt.js";
import { created, terminal } from "../helpers/kimi-responses-bridge.js";
import { fixture, profile, response, target, wire } from "../helpers/kimi-ordered-route.js";

for (const moment of ["forged", "auth", "dispatch", "commit"] as const)
  it(`rejects an unavailable ordinary attempt receipt at ${moment}`, async () => {
    const f = fixture({ action: false }), controller = new AbortController(),
      action = f.router.actions.create("codex", "owned-invocation"),
      context = f.router.actions.context(action.id, "codex"),
      release = f.router.actions.admit(context, controller);
    let sends = 0;
    const attempts = new RoutedAttempts(f.auth, noopLogger, async () => {
      sends++; return response(wire([created(), terminal([])]));
    }, systemClock, "subswitch", () => { if (moment === "dispatch") release(); }, undefined, f.router.actions);
    const request: AttemptRequest = { profile, target, protocol: "responses", conversation: "owned-invocation",
      route: "work", body: { model: "work", input: "synthetic" }, action: context,
      admissionSignal: moment === "forged" ? new AbortController().signal : controller.signal,
      signal: f.controller.signal, refreshes: new Set() };
    try {
      if (moment === "auth") {
        const get = f.auth.get.bind(f.auth);
        f.auth.get = async (...args) => { const credential = await get(...args); release(); return credential; };
      }
      f.router.actions.complete(action.id);
      if (moment !== "commit") {
        await assert.rejects(attempts.prepare(request), /action_state_lost/);
        assert.equal(sends, 0); assert.equal(f.auth.gets, moment === "forged" ? 0 : 1);
      } else {
        const ready = await attempts.prepare(request);
        try {
          for await (const _event of ready.events) { /* consume the validated synthetic terminal */ }
          release();
          assert.throws(() => ready.commit(), /action_state_lost/);
          assert.equal(sends, 1);
        } finally { await ready.cancel(); }
      }
    } finally { release(); f.router.close(); }
  });
