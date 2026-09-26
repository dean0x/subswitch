import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { PassThrough } from "node:stream";
import { once } from "node:events";
import { CodexNativeAuth } from "../../src/codex-native-auth.js";
import { claudeFailure, ReverseContractError } from "../../src/claude-errors.js";
import { ClaudeCache } from "../../src/claude-cache.js";
import { WebSocketBudget } from "../../src/websocket-budget.js";
import { namespaceRequest } from "../../src/collaboration-compat.js";
import { replayIdentity } from "../../src/claude-state.js";
import { openaiErrorBody, openaiFailureEvent, openaiWebSocketError } from "../../src/errors.js";
import { claudeResolver, augmentCodexModels } from "../../src/claude-models.js";
import { decideCodexRoute } from "../../src/codex-route.js";
import { ok } from "../../src/result.js";

describe("reverse ingress review controls", () => {
  it("keeps client, state, relay, and upstream failures in their explicit status buckets", () => {
    for (const [code, status] of [
      ["invalid_state_key", 500], ["claude_retry_bound", 502], ["claude_response_too_large", 502],
      ["duplicate_claude_start", 502], ["unsupported_claude_output", 502], ["invalid_claude_tool_arguments", 502],
      ["request_too_large", 413], ["unsupported_content_encoding", 415], ["invalid_input_item", 400],
      ["missing_continuation_state", 409],
    ] as const) assert.equal(claudeFailure(new ReverseContractError(code)).status, status, code);
  });

  it("redacts error messages at every OpenAI render boundary", () => {
    const secret = "Bearer this-is-a-private-token";
    const failure = { status: 502, code: "fixture", message: secret, retryAfter: secret };
    for (const wire of [openaiErrorBody(secret), JSON.stringify(openaiFailureEvent(secret, "fixture", { id: "r", model: "m", sequence: 1 })),
      JSON.stringify(openaiWebSocketError(failure))]) {
      assert.ok(!wire.includes("this-is-a-private-token")); assert.match(wire, /redacted/);
    }
  });

  // MUTATION CHECK: removing exact endpoint membership makes the first auth read fail.
  it("never reads operator credentials for arbitrary, escaped, or encoded native paths", async () => {
    let reads = 0, refreshes = 0;
    const credentials = ok({ provider: "codex" as const, authHeaders: { authorization: "Bearer operator-token", "chatgpt-account-id": "account" } });
    const auth = new CodexNativeAuth({ refreshable: true, getCredentials: async () => { reads++; return credentials; }, forceRefresh: async () => { refreshes++; return credentials; } });
    const req = new IncomingMessage(new Socket());
    req.headers = { "chatgpt-account-id": "account" }; req.rawHeaders = ["chatgpt-account-id", "account"];
    for (const path of ["/../../../backend-api/accounts/check", "/responses/../accounts", "/%72esponses", "/responses/", "/models/extra"]) {
      assert.equal(await auth.headers(req, "subscription", path), req.rawHeaders);
      assert.equal(await auth.headers(req, "subscription", path, true), req.rawHeaders);
    }
    assert.equal(reads + refreshes, 0);
    assert.deepEqual((await auth.headers(req, "subscription", "/responses?native=1")).slice(-2), ["authorization", "Bearer operator-token"]);
    assert.equal(reads, 1);
    req.headers["chatgpt-account-id"] = "other-account";
    await assert.rejects(auth.headers(req, "subscription", "/models"), /account does not match/);
    await assert.rejects(auth.headers(req, "subscription", "/models", true), /account does not match/);
    req.headers.authorization = "Bearer client-token";
    assert.equal(await auth.headers(req, "subscription", "/responses"), req.rawHeaders);
  });

  it("shares one strict cache budget across Unicode snapshots, replay, and adaptation", () => {
    const cache = new ClaudeCache({ maxEntries: 2, maxBytes: 160 });
    cache.put("adapted", "one", true);
    cache.put("snapshot", "two", { request: {}, input: [] });
    cache.put("replay", "three", { content: [], output: [] });
    assert.equal(cache.get("adapted", "one"), undefined);
    assert.equal(cache.size, 2);
    cache.put("snapshot", "oversized", { request: { text: "😀".repeat(100) }, input: [] });
    assert.equal(cache.get("snapshot", "oversized"), undefined);
    assert.ok(cache.byteSize <= 160);
  });

  it("holds capacity until upgraded sockets close and removes queued disconnects", async () => {
    const budget = new WebSocketBudget(1);
    const a = new PassThrough(), b = new PassThrough(), c = new PassThrough();
    const started: string[] = [];
    budget.run(a, () => started.push("a"));
    budget.run(b, () => started.push("b"));
    budget.run(c, () => started.push("c"));
    assert.deepEqual(started, ["a"]);
    const bClosed = once(b, "close"); b.destroy(); await bClosed;
    const aClosed = once(a, "close"); a.destroy(); await aClosed;
    assert.deepEqual(started, ["a", "c"]);
    budget.close(); assert.equal(c.destroyed, true);
  });

  it("preserves unchanged request identity and rejects deeply nested structured choices", () => {
    const request = { model: "gpt-fixture", tools: [], input: [{ type: "message", content: "unchanged" }] };
    assert.equal(namespaceRequest(request), request);
    let choice: unknown = { type: "function", name: "read" };
    for (let i = 0; i < 140; i++) choice = { type: "allowed_tools", tools: [choice] };
    assert.throws(() => namespaceRequest({ tool_choice: choice }), /json_nesting_too_deep/);
    assert.throws(() => replayIdentity({ type: "function_call", arguments: "[".repeat(140) + "0" + "]".repeat(140) }), /json_nesting_too_deep/);
  });

  it("reports invalid aliases without throwing and keeps malformed catalog rows opaque", () => {
    const resolve = claudeResolver({ worker: "claude-future", "gpt-claimed": "claude-future", invalid: "gpt-foreign" });
    assert.equal(resolve("worker"), "claude-future"); assert.equal(resolve("gpt-claimed"), undefined);
    assert.deepEqual(resolve.rejectedAliases, ["gpt-claimed", "invalid"]);
    const body = { models: [null, 42] }; assert.equal(augmentCodexModels(body, {}), body);
    assert.deepEqual(decideCodexRoute("/responses", { kind: "claude", model: "claude-future" }), { kind: "claude", model: "claude-future" });
    assert.deepEqual(decideCodexRoute("/responses/compact", { kind: "claude", model: "claude-future" }), { kind: "rejected", code: "translated_compaction_unavailable" });
    assert.deepEqual(decideCodexRoute("/responses", { kind: "foreign" }), { kind: "parent" });
    const unregistered = { kind: "rejected", code: "unregistered_claude_model",
      message: "`claude-next` is not a registered Claude model; add a `codexIngress.claude.aliases` entry to route it" };
    assert.deepEqual(decideCodexRoute("/responses", { kind: "unregistered", name: "claude-next" }), unregistered);
    assert.deepEqual(decideCodexRoute("/responses/compact", { kind: "unregistered", name: "claude-next" }), unregistered);
  });
});
