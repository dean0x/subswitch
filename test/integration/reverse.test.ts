import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { startFakeUpstream, startSubswitch, makeAccessToken, makeAuthFileContent, type UpstreamHandler } from "./fake-upstreams.js";
import type { Item } from "../../src/claude-adapter.js";

const sse = (content: Item[], stop = "end_turn") => {
  const frames: Item[] = [{ type: "message_start", message: { type: "message", usage: { input_tokens: 10 } } }];
  content.forEach((block, index) => {
    frames.push({ type: "content_block_start", index, content_block: block });
    frames.push({ type: "content_block_stop", index });
  });
  frames.push({ type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 5 } }, { type: "message_stop" });
  return frames.map(frame => `event: ${frame["type"]}\ndata: ${JSON.stringify(frame)}\n\n`).join("");
};

async function setup(handler: UpstreamHandler, openaiHandler: UpstreamHandler = (_req, res, body) => res.end(body), overrides: Record<string, unknown> = {}) {
  const temp = await mkdtemp(join(tmpdir(), "subswitch-reverse-test-"));
  const authFile = join(temp, "claude.json");
  await writeFile(authFile, JSON.stringify({ claudeAiOauth: { accessToken: "claude-private-fixture", expiresAt: Date.now() + 3600000 } }), { mode: 0o600 });
  const claude = await startFakeUpstream(handler), openai = await startFakeUpstream(openaiHandler);
  const logs: unknown[] = [];
  const proxy = await startSubswitch({ ...overrides, codexIngress: { enabled: true, apiBaseUrl: `${openai.url}/v1`, subscriptionBaseUrl: `${openai.url}/backend-api/codex`,
    claude: { enabled: true, baseUrl: claude.url, authFile } } }, { logger: { log: (level, event, fields) => logs.push({ level, event, fields }) } });
  return { proxy, claude, openai, logs, close: async () => { await proxy.close(); await claude.close(); await openai.close(); await rm(temp, { recursive: true, force: true }); } };
}
const readTool = { type: "function", name: "read", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } };

describe("production reverse HTTP ingress", () => {
  it("routes Claude aliases, preserves thinking/tool results, and isolates credentials", async () => {
    const fixture = await setup((_req, res, raw, index) => {
      const body = JSON.parse(raw.toString());
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(index === 0 ? sse([
        { type: "thinking", thinking: "", signature: "signed-private-fixture" },
        { type: "tool_use", id: "toolu_read", name: body.tools[0].name, input: { path: "check.txt" } },
      ], "tool_use") : sse([{ type: "text", text: "read-value" }]));
    });
    try {
      const first = await fetch(`${fixture.proxy.url}/codex/v1/responses`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer native-openai-fixture", "x-api-key": "incoming-other-secret" },
        body: JSON.stringify({ model: "sonnet", input: "Read check.txt", tools: [readTool], stream: false }) });
      assert.equal(first.status, 200);
      const response = await first.json() as { id: string; output: Item[] };
      assert.equal(response.output[0]?.["type"], "reasoning"); assert.equal(response.output[1]?.["type"], "function_call");
      const second = await fetch(`${fixture.proxy.url}/codex/v1/responses`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "sonnet", previous_response_id: response.id, input: [{ type: "function_call_output", call_id: "toolu_read", output: "read-value" }], stream: false }) });
      assert.equal(second.status, 200); assert.match(await second.text(), /read-value/);
      assert.equal(fixture.openai.requests.length, 0); assert.equal(fixture.claude.requests.length, 2);
      for (const request of fixture.claude.requests) {
        assert.equal(request.headers.authorization, "Bearer claude-private-fixture"); assert.equal(request.headers["x-api-key"], undefined);
        assert.equal(JSON.parse(request.body.toString()).model, "claude-sonnet-5");
        // MUTATION CHECK: deleting either identity field must fail this independent literal pin.
        assert.equal(request.headers["anthropic-beta"], "claude-code-20250219,oauth-2025-04-20");
        assert.equal(JSON.parse(request.body.toString()).system[0].text, "You are Claude Code, Anthropic's official CLI for Claude.");
      }
      const continuation = JSON.parse(fixture.claude.requests[1]!.body.toString());
      assert.match(JSON.stringify(continuation.messages), /signed-private-fixture/);
      assert.match(JSON.stringify(continuation.messages), /tool_result/);
      assert.ok(!JSON.stringify(fixture.logs).includes("claude-private-fixture")); assert.ok(!JSON.stringify(fixture.logs).includes("signed-private-fixture"));
    } finally { await fixture.close(); }
  });

  it("rejects null translated history items as client errors without contacting either upstream", async () => {
    const fixture = await setup((_req, res) => res.end());
    try {
      const response = await fetch(`${fixture.proxy.url}/codex/v1/responses`, {
        method: "POST", body: JSON.stringify({ model: "sonnet", input: [null] }),
      });
      assert.equal(response.status, 400); assert.match(await response.text(), /invalid_input_item/);
      assert.equal(fixture.claude.requests.length + fixture.openai.requests.length, 0);
    } finally { await fixture.close(); }
  });

  it("keeps compressed ordinary OpenAI requests byte-identical", async () => {
    const fixture = await setup((_req, res) => { res.writeHead(500); res.end(); });
    try {
      const raw = gzipSync('{ "model": "gpt-5.5", "input": "unchanged", "stream":false }');
      const response = await fetch(`${fixture.proxy.url}/codex/v1/responses?x=%2f`, { method: "POST", headers: { "content-encoding": "gzip", authorization: "Bearer native-fixture" }, body: raw });
      assert.equal(response.status, 200); await response.arrayBuffer();
      assert.deepEqual(fixture.openai.requests[0]?.body, raw); assert.equal(fixture.openai.requests[0]?.headers["content-encoding"], "gzip");
      assert.equal(fixture.openai.requests[0]?.url, "/v1/responses?x=%2f"); assert.equal(fixture.claude.requests.length, 0);
    } finally { await fixture.close(); }
  });

  it("preserves upstream 429 and Retry-After without billing or model fallback", async () => {
    const fixture = await setup((_req, res) => { res.writeHead(429, { "content-type": "application/json", "retry-after": "17" }); res.end('{"error":{"type":"rate_limit_error","message":"Try later"}}'); });
    try {
      const response = await fetch(`${fixture.proxy.url}/codex/v1/responses`, { method: "POST", body: JSON.stringify({ model: "opus", input: "Hello" }) });
      assert.equal(response.status, 429); assert.equal(response.headers.get("retry-after"), "17");
      assert.match(await response.text(), /rate_limit_error/); assert.equal(fixture.claude.requests.length, 1); assert.equal(fixture.openai.requests.length, 0);
    } finally { await fixture.close(); }
  });

  it("adds Claude discovery while preserving native catalog metadata", async () => {
    const original = { slug: "gpt-5.5", custom_native_field: { preserve: true }, tool_mode: "code_mode_only", multi_agent_version: "v2" };
    const fixture = await setup((_req, res) => res.end(), (_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ models: [original], etag_hint: "unchanged" })); });
    try {
      const response = await fetch(`${fixture.proxy.url}/codex/v1/models`);
      const body = await response.json() as { models: Item[]; etag_hint: string };
      assert.deepEqual(body.models[0], original); assert.equal(body.etag_hint, "unchanged");
      assert.ok(body.models.some(model => model["slug"] === "sonnet")); assert.ok(body.models.some(model => model["slug"] === "claude-opus-5"));
      assert.ok(body.models.some(model => model["slug"] === "claude-opus-5-5"));
      assert.equal(body.models.find(model => model["slug"] === "opus")?.["default_reasoning_level"], "medium");
      assert.equal(body.models.find(model => model["slug"] === "sonnet")?.["default_reasoning_level"], "high");
      assert.equal(fixture.claude.requests.length, 0);
    } finally { await fixture.close(); }
  });

  it("fails missing continuation and translated compaction explicitly", async () => {
    const fixture = await setup((_req, res) => res.end());
    try {
      const missing = await fetch(`${fixture.proxy.url}/codex/v1/responses`, { method: "POST", body: JSON.stringify({ model: "sonnet", input: [], previous_response_id: "unavailable" }) });
      assert.equal(missing.status, 409); assert.match(await missing.text(), /missing_continuation_state/);
      const compact = await fetch(`${fixture.proxy.url}/codex/v1/responses/compact`, { method: "POST", body: JSON.stringify({ model: "sonnet", input: [] }) });
      assert.equal(compact.status, 400); assert.match(await compact.text(), /translated_compaction_unavailable/);
      assert.equal(fixture.claude.requests.length + fixture.openai.requests.length, 0);
    } finally { await fixture.close(); }
  });

  it("rejects effort none on a thinking-always-on model before contacting Claude", async () => {
    const fixture = await setup((_req, res) => res.end());
    try {
      const response = await fetch(`${fixture.proxy.url}/codex/v1/responses`, { method: "POST", body: JSON.stringify({ model: "fable", input: "hello", reasoning: { effort: "none" } }) });
      assert.equal(response.status, 400);
      const { error } = await response.json() as { error: { code: string; message: string } };
      assert.equal(error.code, "reasoning_effort_unsupported_by_model");
      assert.match(error.message, /`claude-fable-5-1`/);
      assert.equal(fixture.openai.requests.length + fixture.claude.requests.length, 0);
    } finally { await fixture.close(); }
  });

  it("clamps the outgoing max_tokens to the model's output ceiling and keeps the relay default below it", async () => {
    const fixture = await setup((_req, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.end(sse([{ type: "text", text: "ok" }])); });
    try {
      for (const body of [{ model: "opus", input: "hello", max_output_tokens: 300_000 }, { model: "opus", input: "hello" }]) {
        const response = await fetch(`${fixture.proxy.url}/codex/v1/responses`, { method: "POST", body: JSON.stringify(body) });
        assert.equal(response.status, 200); await response.text();
      }
      const sent = fixture.claude.requests.map(request => JSON.parse(request.body.toString()) as { model: string; max_tokens: number });
      assert.deepEqual(sent.map(body => [body.model, body.max_tokens]), [["claude-opus-5-5", 128_000], ["claude-opus-5-5", 64_000]]);
    } finally { await fixture.close(); }
  });

  it("streams over-window OpenAI uploads while bounding translated Claude uploads", async () => {
    const fixture = await setup((_req, res) => res.end(), undefined, { limits: { maxBufferedBodyBytes: 1024 } });
    try {
      const raw = JSON.stringify({ model: "gpt-5.5", input: "x".repeat(8192) });
      const openai = await fetch(`${fixture.proxy.url}/codex/v1/responses`, { method: "POST", body: raw });
      assert.equal(openai.status, 200); assert.equal(await openai.text(), raw);
      assert.equal(fixture.openai.requests[0]?.body.toString(), raw);
      const claude = await fetch(`${fixture.proxy.url}/codex/v1/responses`, { method: "POST", body: JSON.stringify({ model: "sonnet", input: "x".repeat(8192) }) });
      assert.equal(claude.status, 413); await claude.text(); assert.equal(fixture.claude.requests.length, 0);
    } finally { await fixture.close(); }
  });

  it("cancels the Claude upstream when the native HTTP client disconnects", async () => {
    let closed!: () => void;
    const disconnected = new Promise<void>(resolve => { closed = resolve; });
    const fixture = await setup((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('event: message_start\ndata: {"type":"message_start","message":{"type":"message","usage":{"input_tokens":1}}}\n\n');
      res.once("close", closed);
    });
    try {
      const controller = new AbortController();
      const response = await fetch(`${fixture.proxy.url}/codex/v1/responses`, { method: "POST", body: JSON.stringify({ model: "sonnet", input: "test", stream: true }), signal: controller.signal });
      const reader = response.body!.getReader(); await reader.read(); controller.abort(); await reader.cancel().catch(() => undefined);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([disconnected, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("upstream was not cancelled")), 2000); })]); }
      finally { clearTimeout(timer); }
    } finally { await fixture.close(); }
  });

  it("binds locally supplied Codex credentials to the native account and refreshes once", async () => {
    const temp = await mkdtemp(join(tmpdir(), "subswitch-native-auth-test-"));
    const authFile = join(temp, "codex.json"), account = "acct_integration_1";
    const oldToken = makeAccessToken(Date.now() + 3600000, account), newToken = makeAccessToken(Date.now() + 7200000, account);
    await writeFile(authFile, makeAuthFileContent(oldToken), { mode: 0o600 });
    const upstream = await startFakeUpstream((req, res, body) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/token") { res.end(JSON.stringify({ access_token: newToken, refresh_token: "new-fixture-refresh" })); return; }
      if (req.headers.authorization === `Bearer ${oldToken}`) { res.writeHead(401); res.end('{"error":{"message":"expired"}}'); return; }
      res.end(body);
    });
    const proxy = await startSubswitch({ providers: { codex: { authFile, oauthTokenUrl: `${upstream.url}/token` } },
      codexIngress: { enabled: true, subscriptionBaseUrl: `${upstream.url}/v1`, apiBaseUrl: `${upstream.url}/v1`, claude: { enabled: true } } });
    try {
      const response = await fetch(`${proxy.url}/codex/backend-api/codex/responses`, { method: "POST", headers: { "chatgpt-account-id": account }, body: '{"model":"gpt-5.5","input":"hello"}' });
      assert.equal(response.status, 200); await response.text();
      const inference = upstream.requests.filter(request => request.url === "/v1/responses");
      assert.equal(inference.length, 2); assert.equal(inference[1]?.headers.authorization, `Bearer ${newToken}`);
      assert.deepEqual(inference[0]?.body, inference[1]?.body);
      const count = upstream.requests.length;
      const mismatch = await fetch(`${proxy.url}/codex/backend-api/codex/responses`, { method: "POST", headers: { "chatgpt-account-id": "different-account" }, body: '{"model":"gpt-5.5","input":"hello"}' });
      assert.equal(mismatch.status, 401); assert.match(await mismatch.text(), /codex_account_mismatch/); assert.equal(upstream.requests.length, count);
      const api = await fetch(`${proxy.url}/codex/v1/responses`, { method: "POST", headers: { "chatgpt-account-id": account }, body: '{"model":"gpt-5.5","input":"hello"}' });
      await api.text(); assert.equal(upstream.requests.at(-1)?.headers.authorization, undefined, "API mode must not use a subscription credential");
    } finally { await proxy.close(); await upstream.close(); await rm(temp, { recursive: true, force: true }); }
  });
});
