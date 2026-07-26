import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSubswitch, startFakeUpstream, makeAccessToken, makeAuthFileContent } from "./fake-upstreams.js";

/**
 * Credential-leak matrix — the two rows gradable today.
 *
 * Row 1 (sk-ant-* never reaches Codex) is already pinned in codex-leg.test.ts:108-110.
 * That file is a frozen oracle — no test is added or moved here for Row 1.
 *
 * Row 5 (Codex credential never reaches Anthropic) is added below.
 * The full 6-row matrix requires a second provider and is completed in Phase F.
 */

const FAR_FUTURE_MS = Date.now() + 24 * 3600 * 1000;

const cleanups: (() => Promise<void>)[] = [];
after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

describe("credential leak matrix", () => {
  /**
   * Row 5: a Codex OAuth credential (Bearer ey… JWT) must never appear in a request
   * forwarded to the Anthropic leg.
   *
   * The Codex handler builds its own auth headers inside buildHeaders() and only sends
   * them to the Codex upstream. The Anthropic passthrough forwards the original client
   * headers verbatim. This test verifies the two paths stay disjoint.
   *
   * Setup: configure subswitch with a real Codex auth file (so credentials exist) and a
   * fake Anthropic upstream. Send a claude-* model request — routed to Anthropic.
   * Assert that no Codex-specific header appears in the Anthropic upstream request.
   */
  it("Row 5: Codex OAuth credential never reaches the Anthropic leg", async () => {
    // Set up a Codex auth file so credentials exist in the process.
    // Even though this request routes to Anthropic, we want to ensure credentials
    // don't leak even when the Codex provider is fully wired.
    const dir = await mkdtemp(join(tmpdir(), "cred-leak-"));
    const authFilePath = join(dir, "auth.json");
    await writeFile(authFilePath, makeAuthFileContent(makeAccessToken(FAR_FUTURE_MS)));

    const anthropic = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "msg_anthropic_ok", type: "message" }));
    });
    const subswitch = await startSubswitch({
      anthropic: { baseUrl: anthropic.url },
      codex: { authFile: authFilePath },
    });
    cleanups.push(subswitch.close, anthropic.close);

    // Send a Claude-model request — decideRoute routes it to Anthropic, never to Codex.
    const clientToken = "Bearer sk-ant-oat-CLIENT-CREDENTIAL-FIXTURE";
    const response = await fetch(`${subswitch.url}/v1/messages`, {
      method: "POST",
      headers: {
        authorization: clientToken,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 10,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    assert.equal(response.status, 200);
    await response.json();

    assert.equal(anthropic.requests.length, 1, "Anthropic must have received exactly one request");
    const anthropicReq = anthropic.requests[0]!;

    // Codex-specific auth headers must not appear in the Anthropic request.
    assert.equal(
      "chatgpt-account-id" in anthropicReq.headers,
      false,
      "chatgpt-account-id must not reach Anthropic",
    );
    assert.equal(
      "openai-beta" in anthropicReq.headers,
      false,
      "openai-beta must not reach Anthropic",
    );
    assert.equal(
      "originator" in anthropicReq.headers,
      false,
      "originator (codex_cli_rs) must not reach Anthropic",
    );
    assert.equal(
      "session_id" in anthropicReq.headers,
      false,
      "session_id must not reach Anthropic",
    );

    // The authorization header must be the client's sk-ant-* token forwarded verbatim,
    // not a Codex JWT. Codex JWTs are base64url-encoded and start with "Bearer ey".
    const authHeader = String(anthropicReq.headers["authorization"] ?? "");
    assert.equal(
      authHeader.startsWith("Bearer ey"),
      false,
      "authorization must not be a Codex JWT in the Anthropic request",
    );
    assert.equal(
      authHeader,
      clientToken,
      "authorization must be the client's token forwarded verbatim",
    );
  });
});
