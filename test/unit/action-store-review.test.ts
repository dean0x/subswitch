import assert from "node:assert/strict";
import { it } from "node:test";
import { ActionStore } from "../../src/routing/action-store.js";

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
