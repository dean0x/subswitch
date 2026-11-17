import assert from "node:assert/strict";
import { it } from "node:test";
import { PassThrough } from "node:stream";
import { ActionStore } from "../../src/routing/action-store.js";
import { ScopedSocket } from "../../src/routing/scoped-lifecycle.js";

it("keeps affinity capacity exact when a finished request's release is reused", () => {
  const store = new ActionStore(),
    old = store.create("codex", "old"),
    context = store.context(old.id, "codex");
  store.affinity(context, "work");
  const release = store.admit(context, new AbortController());
  store.complete(old.id);
  release();
  release();
  let first = context;
  for (let i = 0; i < 4096; i++) {
    const action = store.create("codex", `new-${i}`),
      current = store.context(action.id, "codex");
    store.affinity(current, "work");
    if (i === 0) first = current;
  }
  assert.throws(
    () => store.affinity({ ...first, agentId: "overflow" }, "work"),
    /affinity_store_full/,
  );
  store.close();
});

it("keeps only an unreleased request admitted before completion eligible to drain", () => {
  const store = new ActionStore(), action = store.create("codex", "invocation"),
    context = store.context(action.id, "codex"), controller = new AbortController(),
    release = store.admit(context, controller), keep = store.admit(context, new AbortController());
  try {
    store.complete(action.id);
    assert.throws(() => store.context(action.id, "codex"), /action_admission_closed/);
    assert.throws(() => store.admit(context, new AbortController()), /action_admission_closed/);
    assert.throws(() => store.validateContext(context, "codex"), /action_admission_closed/);
    assert.doesNotThrow(() => store.validateContext(context, "codex", controller.signal));
    release();
    assert.throws(() => store.validateContext(context, "codex", controller.signal), /action_state_lost/);
  } finally { release(); keep(); store.close(); }
});

for (const phase of ["active", "closing"] as const)
  it(`rejects forged or foreign request identity while ${phase}`, () => {
    const store = new ActionStore(), foreign = new ActionStore(),
      action = store.create("codex", "invocation"), context = store.context(action.id, "codex"),
      other = store.context(store.create("codex", "other").id, "codex"),
      controller = new AbortController(), release = store.admit(context, controller);
    try {
      if (phase === "closing") store.complete(action.id);
      for (const changed of [
        { ...context, client: "claude-code" as const }, { ...context, namespace: "foreign" },
        { ...context, conversationId: "foreign" }, { ...context, parentActionId: "foreign" },
        { ...context, agentId: "invalid" }, other,
      ]) assert.throws(() => store.validateContext(changed, "codex", controller.signal), /action_state_lost/);
      assert.throws(() => store.validateContext(context, "claude-code", controller.signal), /action_state_lost/);
      assert.throws(() => store.validateContext(context, "codex", new AbortController().signal), /action_state_lost/);
      assert.throws(() => foreign.validateContext(context, "codex", controller.signal), /action_state_lost/);
      assert.doesNotThrow(() => store.validateContext(context, "codex", controller.signal));
    } finally { release(); store.close(); foreign.close(); }
  });

it("binds a body-derived child once after upload and prevents the receipt switching agents", () => {
  const store = new ActionStore(), context = store.context(store.create("codex", "invocation").id, "codex"),
    controller = new AbortController(), release = store.admit(context, controller),
    child = { ...context, agentId: "a".repeat(64) };
  try {
    store.complete(context.actionId);
    assert.doesNotThrow(() => store.validateContext(child, "codex", controller.signal));
    assert.doesNotThrow(() => store.validateContext({ ...child }, "codex", controller.signal));
    assert.throws(() => store.validateContext(context, "codex", controller.signal), /action_state_lost/);
    assert.throws(() => store.validateContext({ ...child, agentId: "b".repeat(64) }, "codex", controller.signal), /action_state_lost/);
  } finally { release(); store.close(); }
});

for (const operation of ["abort", "cancel"] as const)
  it(`does not accept an admitted receipt after ${operation}`, () => {
    const store = new ActionStore(), context = store.context(store.create("codex", "invocation").id, "codex"),
      controller = new AbortController(), release = store.admit(context, controller);
    try {
      if (operation === "abort") controller.abort(); else store.cancel(context.actionId);
      assert.throws(() => store.validateContext(context, "codex", controller.signal), /action_state_lost/);
    } finally { release(); store.close(); }
  });

it("uses a scoped socket request receipt rather than transport ownership to drain", () => {
  const store = new ActionStore(), context = store.context(store.create("codex", "invocation").id, "codex"),
    socket = new PassThrough(), scoped = new ScopedSocket(store, context, socket),
    receipt = scoped.admit();
  try {
    store.complete(context.actionId);
    assert.throws(() => store.validateContext(context, "codex", scoped.signal), /action_state_lost/);
    assert.doesNotThrow(() => store.validateContext(context, "codex", receipt.signal));
  } finally { receipt.release(); socket.destroy(); store.close(); }
});
