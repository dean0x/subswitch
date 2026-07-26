/**
 * Tests for the test-harness helpers in fake-upstreams.ts.
 *
 * H1: Verifies that an injected logger passed to startSubswitch receives
 * request_complete events.  With the default logLevel:"error" the harness
 * swallows routing logs, so later phases that assert on route= and model=
 * fields need logger injection to make those fields observable.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import type { LogLevel, LogFields } from "../../src/logger.js";
import { startSubswitch, startFakeUpstream } from "./fake-upstreams.js";

const cleanups: (() => Promise<void>)[] = [];
after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

// ---------------------------------------------------------------------------
// H1 — injected logger receives request_complete
// ---------------------------------------------------------------------------

describe("startSubswitch logger injection", () => {
  it("injected logger receives a request_complete event for every request", async () => {
    const anthropic = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });

    type Captured = { level: LogLevel; event: string; fields: LogFields | undefined };
    const captured: Captured[] = [];

    const subswitch = await startSubswitch(
      { anthropic: { baseUrl: anthropic.url } },
      {
        logger: {
          log: (level, event, fields) => {
            captured.push({ level, event, fields });
          },
        },
      },
    );
    cleanups.push(subswitch.close, anthropic.close);

    // A health request is handled locally (no upstream) and still fires
    // request_complete via the res.on("close") handler in createProxyServer.
    const response = await fetch(`${subswitch.url}/__subswitch/health`);
    assert.equal(response.status, 200);

    // Give the close event a tick to fire before asserting.
    await new Promise<void>((resolve) => setImmediate(resolve));

    const completions = captured.filter((c) => c.event === "request_complete");
    assert.ok(completions.length >= 1, "injected logger must receive at least one request_complete event");

    const completion = completions[0]!;
    assert.equal(completion.level, "info");
    assert.equal(completion.fields?.path, "/__subswitch/health");
    assert.equal(completion.fields?.status, 200);
  });

  it("default (no logger option) still works — no regression from signature change", async () => {
    const anthropic = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    // Signature unchanged for existing callers: second arg defaults to {}
    const subswitch = await startSubswitch({ anthropic: { baseUrl: anthropic.url } });
    cleanups.push(subswitch.close, anthropic.close);

    const response = await fetch(`${subswitch.url}/__subswitch/health`);
    assert.equal(response.status, 200);
  });
});
