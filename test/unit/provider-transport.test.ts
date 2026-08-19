import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import type { ServerResponse } from "node:http";
import { createFrameWriter } from "../../src/provider-transport.js";

/**
 * Tests the real createFrameWriter, not a copy of it.
 *
 * Scenario: a client stops reading without closing (TCP window full). write()
 * returns false and 'drain' never fires, so the wait must be ended by the abort
 * signal or by 'close' — never left hanging past requestTimeoutMs.
 */

// Minimal ServerResponse lookalike: write() returns false (back-pressure),
// drain never fires, and close can be fired externally.
class BlockingResponse extends EventEmitter {
  public destroyed = false;
  public write(_data: string): boolean { return false; }
}

const makeWriteFrame = (
  res: BlockingResponse,
  signal: AbortSignal,
): ((frame: string) => Promise<void>) =>
  createFrameWriter(res as unknown as ServerResponse, signal);

describe("writeFrame abort-signal drain race", () => {
  it("resolves when the signal is ALREADY aborted before the call", async () => {
    const res = new BlockingResponse();
    const controller = new AbortController();
    // A total/idle timer can abort while an earlier frame is draining, so the very
    // next writeFrame sees an already-aborted signal. addEventListener never fires
    // on one, so without an explicit check this promise never settles — the request
    // cleanup never runs and resources associated with the request are held for the life of the process.
    controller.abort();
    const writeFrame = makeWriteFrame(res, controller.signal);

    const settled = await Promise.race([
      writeFrame("data: test\n\n").then(() => "resolved" as const),
      new Promise<"hung">((r) => setTimeout(() => r("hung"), 200).unref()),
    ]);
    assert.equal(settled, "resolved", "writeFrame must not hang on an already-aborted signal");
  });

  it("registers no listeners when the signal is already aborted", async () => {
    const res = new BlockingResponse();
    const controller = new AbortController();
    controller.abort();
    await makeWriteFrame(res, controller.signal)("data: test\n\n");
    assert.equal(res.listenerCount("drain"), 0, "no drain listener should remain");
    assert.equal(res.listenerCount("close"), 0, "no close listener should remain");
  });

  it("resolves immediately when res.write returns true (no drain needed)", async () => {
    const res = new BlockingResponse();
    const controller = new AbortController();
    // Patch write to succeed
    res.write = () => true;
    const writeFrame = makeWriteFrame(res, controller.signal);
    // Guarded with Promise.race so a broken fast path fails rather than hangs.
    const settled = await Promise.race([
      writeFrame("data: test\n\n").then(() => "resolved" as const),
      new Promise<"hung">((r) => setTimeout(() => r("hung"), 200).unref()),
    ]);
    assert.equal(settled, "resolved", "writeFrame must not hang when res.write returns true");
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
