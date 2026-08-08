/**
 * Tests for the test-harness helpers in fake-upstreams.ts.
 *
 * H1: Verifies that an injected logger passed to startSubswitch is threaded
 * INTO buildDeps — not spread over its result — by asserting that
 * codex_upstream_error (emitted only by the handler, which closes over the
 * logger from buildDeps) appears in the captured records.  A spread-over-result
 * shape leaves every handler log on the original (console) logger, making the
 * captured set empty for handler-level events.
 *
 * Mutation that proves it: replace `buildDeps(config, options.logger)` with
 * `buildDeps(config)` in fake-upstreams.ts and spread the logger onto the
 * result.  The H1 codex_upstream_error assertion goes RED; request_complete
 * (emitted by the request loop, not the handler) stays green.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LogLevel, LogFields } from "../../src/logger.js";
import {
  startSubswitch,
  startFakeUpstream,
  makeAuthFileContent,
  makeAccessToken,
} from "./fake-upstreams.js";

const cleanups: (() => Promise<void>)[] = [];
after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

// ---------------------------------------------------------------------------
// H1 — injected logger is threaded through buildDeps, not spread over result
//
// The load-bearing check: codex_upstream_error is emitted only from inside the
// handler, which closes over the logger that buildDeps received.  Spreading a
// different logger onto buildDeps' result leaves the handler's logger unchanged,
// so codex_upstream_error never reaches the captured set.
// ---------------------------------------------------------------------------

describe("startSubswitch logger injection", () => {
  it("injected logger captures codex_upstream_error from a gpt-* request routed to a 502 upstream", async () => {
    // A codex upstream that always returns 502 — triggers codex_upstream_error
    // inside the handler, which is the event that only reaches the captured set
    // when the logger is passed INTO buildDeps rather than spread over its result.
    const fakeCodex = await startFakeUpstream((_req, res) => {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end("Bad Gateway");
    });
    const dir = await mkdtemp(join(tmpdir(), "harness-h1-"));
    const authFilePath = join(dir, "auth.json");
    await writeFile(authFilePath, makeAuthFileContent(makeAccessToken(Date.now() + 3_600_000)), "utf8");

    type Captured = { level: LogLevel; event: string; fields: LogFields | undefined };
    const captured: Captured[] = [];

    const subswitch = await startSubswitch(
      { providers: { codex: { baseUrl: fakeCodex.url, authFile: authFilePath } } },
      {
        logger: {
          log: (level, event, fields) => {
            captured.push({ level, event, fields });
          },
        },
      },
    );
    cleanups.push(subswitch.close, fakeCodex.close);

    const res = await fetch(`${subswitch.url}/v1/messages`, {
      method: "POST",
      headers: {
        authorization: "Bearer sk-ant-placeholder",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5.6-sol",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 16,
      }),
    });
    await res.text();

    assert.ok(
      captured.some((c) => c.event === "codex_upstream_error"),
      `injected logger must capture codex_upstream_error (a handler-level event); got: ${captured.map((c) => c.event).join(", ")}`,
    );
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
