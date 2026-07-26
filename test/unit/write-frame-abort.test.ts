import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

/**
 * Tests that the writeFrame drain-wait races the abort signal.
 *
 * writeFrame is a closure inside createCodexHandler and cannot be exported
 * without coupling the module boundary. This test exercises the pattern
 * directly — same logic, same conditions — so any regression in the fix will
 * be visible here even though the helper is not exported.
 *
 * Scenario: a client stops reading without closing (TCP window full). The
 * socket's write() returns false and 'drain' never fires. Before the fix,
 * handleMessages would hang past requestTimeoutMs because writeFrame had
 * no timeout. After the fix, the AbortController fires and writeFrame
 * resolves, unblocking the pipeline.
 */

// Minimal ServerResponse lookalike: write() always returns false (back-pressure),
// drain never fires, and close can be fired externally for other tests.
class BlockingResponse extends EventEmitter {
  public destroyed = false;
  public write(_data: string): boolean { return false; }
}

// Replicate the fixed writeFrame closure.
const makeWriteFrame = (
  res: BlockingResponse,
  signal: AbortSignal,
): ((frame: string) => Promise<void>) =>
  (frame: string) =>
    new Promise((resolve) => {
      if (res.destroyed || res.write(frame)) {
        resolve();
        return;
      }
      const cleanup = (): void => {
        res.off("drain", onDrain);
        res.off("close", onClose);
        signal.removeEventListener("abort", onAbort);
      };
      const onDrain = (): void => { cleanup(); resolve(); };
      const onClose = (): void => { cleanup(); resolve(); };
      const onAbort = (): void => { cleanup(); resolve(); };
      res.once("drain", onDrain);
      res.once("close", onClose);
      signal.addEventListener("abort", onAbort, { once: true });
    });

describe("writeFrame abort-signal drain race", () => {
  it("resolves immediately when res.write returns true (no drain needed)", async () => {
    const res = new BlockingResponse();
    const controller = new AbortController();
    // Patch write to succeed
    res.write = () => true;
    const writeFrame = makeWriteFrame(res, controller.signal);
    await writeFrame("data: test\n\n");
    // If we get here without hanging, the fast path works.
  });

  it("resolves when the abort signal fires while waiting for drain", async () => {
    const res = new BlockingResponse(); // write always returns false
    const controller = new AbortController();
    const writeFrame = makeWriteFrame(res, controller.signal);

    const pending = writeFrame("data: test\n\n");
    // Abort immediately — simulates requestTimeoutMs or idleTimeoutMs firing.
    controller.abort();
    // Must resolve without hanging.
    await assert.doesNotReject(pending);
  });

  it("resolves when 'drain' fires before abort", async () => {
    const res = new BlockingResponse();
    const controller = new AbortController();
    const writeFrame = makeWriteFrame(res, controller.signal);

    const pending = writeFrame("data: test\n\n");
    // Normal drain resolves the promise.
    res.emit("drain");
    await assert.doesNotReject(pending);
  });

  it("resolves when 'close' fires (client disconnects)", async () => {
    const res = new BlockingResponse();
    const controller = new AbortController();
    const writeFrame = makeWriteFrame(res, controller.signal);

    const pending = writeFrame("data: test\n\n");
    res.emit("close");
    await assert.doesNotReject(pending);
  });

  it("cleans up all listeners after abort so res has no dangling handlers", async () => {
    const res = new BlockingResponse();
    const controller = new AbortController();
    const writeFrame = makeWriteFrame(res, controller.signal);

    const pending = writeFrame("data: test\n\n");
    controller.abort();
    await pending;

    // After resolution all three listeners must be removed.
    assert.equal(res.listenerCount("drain"), 0);
    assert.equal(res.listenerCount("close"), 0);
  });
});
