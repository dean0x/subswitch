import assert from "node:assert/strict";
import { it } from "node:test";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";
import { coordinateNativeRefresh, settleNativeRefreshes } from "../../src/native-auth-coordination.js";

const gate = () => {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => { open = resolve; });
  return { open, wait };
};

it("waits for all renewals, including one queued during the wait", { timeout: 2000 }, async () => {
  const writeback = gate();
  const nextWriteback = gate();
  const first = coordinateNativeRefresh("kimi", "fixture-store", "first-grant", () => writeback.wait);
  let settled = false;
  const wait = settleNativeRefreshes(1000).then(() => { settled = true; });
  try {
    await nextTurn();
    assert.equal(settled, false, "the first renewal still has work to do");
    const second = coordinateNativeRefresh("kimi", "fixture-store", "second-grant", () => nextWriteback.wait);
    writeback.open();
    await first;
    await nextTurn();
    assert.equal(settled, false, "the queued renewal still has work to do");
    nextWriteback.open();
    await second;
    assert.equal(await Promise.race([wait.then(() => "settled"), delay(100, "still waiting", { ref: false })]), "settled");
  } finally {
    writeback.open();
    nextWriteback.open();
    await wait;
  }
});

it("ends its wait at the bound while a renewal remains open", { timeout: 2000 }, async () => {
  const writeback = gate();
  const renewal = coordinateNativeRefresh("kimi", "fixture-stalled-store", "grant", () => writeback.wait);
  try {
    const wait = settleNativeRefreshes(20).then(() => "bound reached");
    assert.equal(await Promise.race([wait, delay(200, "still waiting")]), "bound reached");
  } finally {
    writeback.open();
    await renewal;
  }
});
