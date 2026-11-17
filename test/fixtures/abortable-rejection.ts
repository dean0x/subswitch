/** Child-process probe: unobserved rejections must retain Node's default fatal behavior. */
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { abortable } from "../../src/abortable.js";
import { noopLogger } from "../../src/logger.js";
import { ProfileAuth, type BoundCredential } from "../../src/routing/profile-auth.js";
import { deliverResponse } from "../../src/routing/response-delivery.js";
import type { ClientEvent } from "../../src/routing/routing-types.js";

const scenario = process.argv[2];
const reason = new Error("synthetic_cancel");
const signal = AbortSignal.abort(reason);

switch (scenario) {
  case "rejected-input":
  case "pending-input": {
    const input = scenario === "rejected-input"
      ? Promise.reject(new Error("synthetic_input_failure"))
      : setImmediate().then(() => { throw new Error("synthetic_input_failure"); });
    // Normalize synchronous throws here to isolate observation of the input promise.
    await assert.rejects(async () => abortable(input, signal), error => error === reason);
    break;
  }
  case "suspended-yield": {
    const controller = new AbortController();
    let advances = 0;
    const events = (async function* (): AsyncGenerator<ClientEvent> {
      advances++;
      yield { protocol: "responses", payload: { type: "response.output_text.delta", delta: "synthetic" } };
      advances++;
      controller.signal.throwIfAborted();
    })();
    const response = deliverResponse({
      events, owner: "synthetic", protocol: "responses", commit() {}, async cancel() {},
    }, {
      protocol: "responses", responseId: "synthetic", model: "synthetic", streaming: true,
      signal: controller.signal, checkDeadline() {}, onCommit() {}, onTerminal() {},
    });
    assert.equal((await response.next()).value?.["type"], "response.output_text.delta");
    controller.abort(reason);
    await assert.rejects(response.next(), error => error === reason);
    await setImmediate();
    assert.equal(advances, 1);
    break;
  }
  case "failed-refresh": {
    class FailedRefresh extends ProfileAuth {
      override async get(): Promise<BoundCredential> {
        await setImmediate();
        throw new Error("synthetic_refresh_failure");
      }
    }
    const auth = new FailedRefresh({
      native: {
        provider: "claude", product: "claude-code", billing: "subscription", account: "synthetic",
        credential: { kind: "native-oauth", authFile: "/fabricated/never-read.json" },
      },
    }, noopLogger, {});
    await assert.rejects(async () => auth.refresh("native", signal), error => error === reason);
    break;
  }
  default:
    assert.fail("unknown rejection probe");
}

// Cross an event-loop turn so Node reports any abandoned rejection before exit.
await setImmediate();
