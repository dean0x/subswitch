import { claudeResolver } from "../../src/claude-models.js";
import { ClaudeAuthManager, createClaudeCredentialStore } from "../../src/claude-auth.js";
import http from "node:http";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { startFakeUpstream, startSubswitch } from "./fake-upstreams.js";
import { reverseEvents, type Item } from "../../src/claude-adapter.js";
import { collaborationTools } from "../../e2e/gates/contracts.js";
import { CodexGateway } from "../../src/codex-gateway.js";
import { loadConfig } from "../../src/config.js";
import type { ProviderCredential } from "../../src/provider-auth.js";
import type { Result } from "../../src/result.js";
import type { ProxyError } from "../../src/errors.js";

const listen = (server: http.Server) => new Promise<string>(resolve => server.listen(0, "127.0.0.1", () => {
  const address = server.address(); if (!address || typeof address === "string") throw new Error(); resolve(`http://127.0.0.1:${address.port}`);
}));
const close = (server: http.Server) => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
const textStream = (text: string) => [
  { type: "message_start", message: { type: "message", usage: { input_tokens: 1 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  { type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }, { type: "message_stop" },
].map(event => `data: ${JSON.stringify(event)}\n\n`).join("");

describe("production reverse WebSockets", () => {
  it("routes each model on a reused connection and restores native collaboration names", async () => {
    const temp = await mkdtemp(join(tmpdir(), "subswitch-reverse-ws-"));
    const authFile = join(temp, "claude.json");
    await writeFile(authFile, JSON.stringify({ claudeAiOauth: { accessToken: "claude-ws-fixture", expiresAt: Date.now() + 3600000 } }));
    const claude = await startFakeUpstream((_req, res, _body, index) => {
      if (index === 2) { res.writeHead(429, { "content-type": "application/json", "retry-after": "23" }); res.end('{"error":{"type":"rate_limit_error","message":"Try later"}}'); return; }
      res.writeHead(200, { "content-type": "text/event-stream" }); res.end(textStream(index ? "second reply" : "first reply"));
    });
    const server = http.createServer(); const wss = new WebSocketServer({ server });
    const parentRequests: Item[] = []; let parentAuth: unknown;
    wss.on("connection", (ws, req) => {
      parentAuth = req.headers.authorization;
      ws.on("message", data => {
        parentRequests.push(JSON.parse(data.toString()));
        const output = [{ type: "function_call", id: "fc_parent", call_id: "call_parent", namespace: "subswitch_collaboration", name: "spawn_agent",
          arguments: '{"task_name":"worker","message":"read the fixture"}', status: "completed" }];
        for (const event of reverseEvents("resp_parent", "gpt-5.5", output)) ws.send(JSON.stringify(event));
      });
    });
    const upstream = await listen(server);
    const proxy = await startSubswitch({ codexIngress: { enabled: true, apiBaseUrl: `${upstream}/v1`, claude: { enabled: true, baseUrl: claude.url, authFile } } });
    const client = new WebSocket(`${proxy.url.replace("http:", "ws:")}/codex/v1/responses`, { headers: { authorization: "Bearer parent-ws-fixture" } });
    const events: Item[] = [];
    client.on("message", data => events.push(JSON.parse(data.toString())));
    const until = async (condition: () => boolean) => {
      const deadline = Date.now() + 3000;
      while (!condition()) { if (Date.now() > deadline) throw new Error("WebSocket response timed out"); await new Promise(resolve => setTimeout(resolve, 5)); }
    };
    try {
      await new Promise<void>((resolve, reject) => { client.once("open", resolve); client.once("error", reject); });
      client.send(JSON.stringify({ type: "response.create", model: "gpt-5.5", input: [], tools: [collaborationTools(false)] }));
      await until(() => events.some(event => event["type"] === "response.completed"));
      assert.equal(parentAuth, "Bearer parent-ws-fixture");
      assert.equal(((parentRequests[0]!["tools"] as Item[])[0]!)!["name"], "subswitch_collaboration");
      const call = events.find(event => event["type"] === "response.output_item.done")?.["item"] as Item;
      assert.equal(call["namespace"], "collaboration"); assert.deepEqual(call["encrypted_function_args"], []);
      client.send(JSON.stringify({ type: "response.create", model: "sonnet", input: "first question" }));
      await until(() => events.filter(event => event["type"] === "response.completed").length === 2);
      const response = events.filter(event => event["type"] === "response.completed").at(-1)?.["response"] as Item;
      client.send(JSON.stringify({ type: "response.create", previous_response_id: response["id"], input: [{ type: "message", role: "user", content: "second question" }] }));
      await until(() => events.filter(event => event["type"] === "response.completed").length === 3);
      assert.equal(parentRequests.length, 1); assert.equal(claude.requests.length, 2);
      assert.equal(claude.requests[0]?.headers.authorization, "Bearer claude-ws-fixture");
      assert.match(claude.requests[1]!.body.toString(), /first reply/); assert.match(claude.requests[1]!.body.toString(), /second question/);
      client.send(JSON.stringify({ type: "response.create", model: "sonnet", input: "third question" }));
      await until(() => events.some(event => event["type"] === "error" && event["code"] === "rate_limit_error"));
      const error = events.find(event => event["type"] === "error")!;
      assert.equal(error["status"], 429); assert.equal(error["retry_after"], "23"); assert.match(String(error["message"]), /Retry-After: 23/);
      assert.equal(parentRequests.length, 1, "Claude errors must not fall back to OpenAI");
    } finally {
      client.terminate(); await proxy.close(); for (const ws of wss.clients) ws.terminate(); wss.close(); await close(server); await claude.close(); await rm(temp, { recursive: true, force: true });
    }
  });

  it("answers an unregistered claude- model with a clear error event and never forwards it to OpenAI", async () => {
    const server = http.createServer(); const wss = new WebSocketServer({ server });
    const parentRequests: unknown[] = [];
    wss.on("connection", ws => ws.on("message", data => parentRequests.push(JSON.parse(data.toString()))));
    const upstream = await listen(server);
    const proxy = await startSubswitch({ codexIngress: { enabled: true, apiBaseUrl: `${upstream}/v1`, claude: { enabled: true } } });
    const client = new WebSocket(`${proxy.url.replace("http:", "ws:")}/codex/v1/responses`);
    const events: Item[] = [];
    client.on("message", data => events.push(JSON.parse(data.toString())));
    try {
      await new Promise<void>((resolve, reject) => { client.once("open", resolve); client.once("error", reject); });
      client.send(JSON.stringify({ type: "response.create", model: "claude-sonnet-future", input: "hello", stream_id: "s1" }));
      const deadline = Date.now() + 3000;
      while (!events.some(event => event["type"] === "error")) {
        if (Date.now() > deadline) throw new Error("WebSocket error event timed out");
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      const error = events.find(event => event["type"] === "error")!;
      assert.equal(error["code"], "unregistered_claude_model"); assert.equal(error["status"], 400); assert.equal(error["stream_id"], "s1");
      assert.equal(error["message"], "`claude-sonnet-future` is not a registered Claude model; add a `codexIngress.claude.aliases` entry to route it");
      assert.equal(parentRequests.length, 0);
    } finally {
      client.terminate(); await proxy.close(); for (const ws of wss.clients) ws.terminate(); wss.close(); await close(server);
    }
  });

  it("relays rejected upgrades and remains usable after the upstream closes", async () => {
    const server = http.createServer();
    server.on("upgrade", (_req, socket) => socket.end('HTTP/1.1 429 Too Many Requests\r\nContent-Type: application/json\r\nRetry-After: 19\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}'));
    const upstream = await listen(server);
    const proxy = await startSubswitch({ codexIngress: { enabled: true, apiBaseUrl: upstream, claude: { enabled: true } } });
    const client = new WebSocket(`${proxy.url.replace("http:", "ws:")}/codex/v1/responses`);
    try {
      const result = await new Promise<{ status: number | undefined; retry: unknown }>((resolve, reject) => {
        client.on("error", () => undefined);
        client.once("open", () => reject(new Error("upgrade unexpectedly succeeded")));
        client.once("unexpected-response", (_req, response) => { response.resume(); response.once("end", () => resolve({ status: response.statusCode, retry: response.headers["retry-after"] })); });
      });
      assert.deepEqual(result, { status: 429, retry: "19" });
      assert.equal((await fetch(`${proxy.url}/__subswitch/health`)).status, 200);
    } finally { client.terminate(); await proxy.close(); await close(server); }
  });
  it("closes pending credential-bound upgrades without opening an upstream after shutdown", async () => {
    const backend = http.createServer(); let connections = 0;
    backend.on("connection", () => connections++);
    const url = await listen(backend);
    const config = loadConfig({ configPath: "fixture", readFile: () => JSON.stringify({ codexIngress: { enabled: true, subscriptionBaseUrl: url, claude: { enabled: true } } }) });
    assert.ok(config.ok);
    let release!: (value: Result<ProviderCredential<"codex">, ProxyError>) => void, started!: () => void;
    const requested = new Promise<void>(resolve => { started = resolve; });
    const credentials = new Promise<Result<ProviderCredential<"codex">, ProxyError>>(resolve => { release = resolve; });
    const auth = { refreshable: true, getCredentials: () => { started(); return credentials; }, forceRefresh: () => credentials };
    const gateway = new CodexGateway({ config: config.value.config, logger: { log() {} }, parentAuth: auth, resolveClaude: claudeResolver(config.value.config.codexIngress.claude.aliases),
      claudeAuth: new ClaudeAuthManager({ store: createClaudeCredentialStore(config.value.config.codexIngress.claude),
        oauthTokenUrl: config.value.config.codexIngress.claude.oauthTokenUrl, logger: { log() {} } }),
    });
    const server = http.createServer();
    server.on("upgrade", (req, socket, head) => gateway.upgrade(req, socket, head, "subscription", "/responses"));
    const local = await listen(server);
    const client = new WebSocket(local.replace("http:", "ws:"), { headers: { "chatgpt-account-id": "fixture-account" } });
    client.on("error", () => undefined);
    const ended = new Promise<void>(resolve => client.once("close", () => resolve()));
    try {
      await requested; gateway.close();
      release({ ok: true, value: { provider: "codex", authHeaders: { authorization: "Bearer fixture-only", "chatgpt-account-id": "fixture-account" } } });
      await ended; assert.equal(connections, 0);
    } finally { client.terminate(); gateway.close(); await close(server); await close(backend); }
  });
});
