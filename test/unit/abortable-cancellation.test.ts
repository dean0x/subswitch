/** Offline cancellation regressions; all events, profiles and failures are synthetic. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { getEventListeners } from "node:events";
import { describe, it } from "node:test";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { abortable } from "../../src/abortable.js";
import { deliverResponse } from "../../src/routing/response-delivery.js";
import type { ClientEvent } from "../../src/routing/routing-types.js";

function delivery(events: AsyncIterable<ClientEvent>, signal: AbortSignal, checkDeadline = () => {}) {
  return deliverResponse({
    events, owner: "synthetic", protocol: "responses", commit() {}, async cancel() {},
  }, {
    protocol: "responses", responseId: "synthetic", model: "synthetic", streaming: true,
    signal, checkDeadline, onCommit() {}, onTerminal() {},
  });
}

const delta: ClientEvent = {
  protocol: "responses", payload: { type: "response.output_text.delta", delta: "synthetic" },
};

describe("abortable cancellation", () => {
  it("returns a rejected promise for an already-aborted signal without a synchronous throw", async () => {
    const reason = new Error("synthetic_cancel");
    const signal = AbortSignal.abort(reason);
    let result = Promise.resolve();
    assert.doesNotThrow(() => { result = abortable(Promise.resolve(), signal); });
    await assert.rejects(result, error => error === reason);
    assert.equal(getEventListeners(signal, "abort").length, 0);
  });

  it("rejects an already-aborted wait even when the input never settles", async () => {
    const reason = new Error("synthetic_cancel");
    const outcome = Promise.resolve()
      .then(() => abortable(new Promise<void>(() => {}), AbortSignal.abort(reason)))
      .then(() => "resolved", (error: unknown) => error);
    assert.equal(await Promise.race([outcome, setImmediate("still_waits")]), reason);
  });

  for (const [scenario, description] of [
    ["rejected-input", "observes an input that has already rejected when the caller has cancelled"],
    ["pending-input", "observes an input that rejects after the caller has cancelled"],
    ["failed-refresh", "observes a failed shared refresh after an already-cancelled waiter leaves"],
    ["suspended-yield", "resumes a cancelled yield without an unhandled provider rejection"],
  ] as const) {
    it(description, async () => {
      const { error, stderr } = await new Promise<{ error: Error | null; stderr: string }>(resolve => {
        execFile(process.execPath, [
          "--unhandled-rejections=strict", "--import", "tsx",
          fileURLToPath(new URL("../fixtures/abortable-rejection.ts", import.meta.url)), scenario,
        ], {
          cwd: fileURLToPath(new URL("../../", import.meta.url)), timeout: 5000, maxBuffer: 64 * 1024,
        }, (error, _stdout, stderr) => resolve({ error, stderr }));
      });
      assert.equal(error, null, stderr);
    });
  }
});

describe("response delivery cancellation", () => {
  it("does not start the provider iterator after the deadline check cancels delivery", async () => {
    const controller = new AbortController();
    const reason = new Error("synthetic_deadline");
    let advances = 0;
    const events = (async function* () { advances++; yield delta; })();
    const response = delivery(events, controller.signal, () => controller.abort(reason));

    await assert.rejects(response.next(), error => error === reason);
    assert.equal(advances, 0);
  });

  it("does not advance the provider iterator after cancel across a suspended yield", async () => {
    const controller = new AbortController();
    const reason = new Error("synthetic_cancel");
    let advances = 0;
    const events = (async function* () {
      advances++;
      yield delta;
      advances++;
    })();
    const response = delivery(events, controller.signal);
    assert.deepEqual((await response.next()).value, delta.payload);

    controller.abort(reason);
    await assert.rejects(response.next(), error => error === reason);
    assert.equal(advances, 1);
  });
});
