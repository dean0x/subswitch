import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { loadConfig } from "../../src/config.js";
import { noopLogger } from "../../src/logger.js";
import { buildDeps, createProxyServer, listenServer } from "../../src/server.js";
import { nativeCredential } from "../fixtures/native-profile.js";

const loopback = "127.0.0.1";
const model = "gpt-6.2-sol";

async function listen(server: Server) {
  const result = await listenServer(server, 0, loopback);
  assert.ok(result.ok, result.ok ? undefined : result.error.message);
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://${loopback}:${address.port}`;
}

async function close(server: Server | undefined) {
  if (!server?.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

function proxyDeps(upstream: string) {
  const result = loadConfig({ env: {}, configPath: "/synthetic/config.json", readFile: () => JSON.stringify({
    configVersion: 2,
    codexIngress: { enabled: true },
    accessProfiles: { fixture: {
      provider: "codex", product: "chatgpt-codex", billing: "subscription", account: "synthetic",
      credential: nativeCredential("codex", "disconnect-fixture"),
    } },
    routes: { work: { clients: ["codex", "claude-code"], primary: { profile: "fixture", model, effort: "high" } } },
  }) });
  assert.ok(result.ok, result.ok ? undefined : result.error.message);
  const deps = buildDeps(result.value.config, noopLogger, {
    fetchImpl: (url, init) => {
      assert.equal(String(url), "https://chatgpt.com/backend-api/codex/responses");
      return fetch(`${upstream}/responses`, init);
    },
  });
  assert.ok(deps.ok, deps.ok ? undefined : deps.error);
  return deps.value;
}

async function readOpening(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const decoder = new TextDecoder();
  let wire = "";
  for (let reads = 0; reads < 8; reads++) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false, "the unfinished response ended before its opening event");
    wire += decoder.decode(chunk.value, { stream: true });
    const end = wire.indexOf("\n\n");
    if (end !== -1) {
      const line = wire.slice(0, end).split("\n").find(value => value.startsWith("data: "));
      assert.ok(line, "the opening event has no SSE data");
      const payload: unknown = JSON.parse(line.slice("data: ".length));
      assert.ok(payload && typeof payload === "object" && "type" in payload);
      return payload.type;
    }
  }
  assert.fail("no complete opening event in the first eight reads");
}

// src/routing/http-ingress.ts:60-63 and src/codex-gateway.ts:305 — a routed HTTP close aborts dispatch.
for (const { client, path, opening, input } of [
  { client: "codex", path: "/codex/v1/responses", opening: "response.created", input: { input: "synthetic" } },
  { client: "claude-code", path: "/v1/messages", opening: "message_start", input: {
    max_tokens: 64, messages: [{ role: "user", content: "synthetic" }],
  } },
] as const) {
  it(`${opening}: cancels the unfinished upstream on routed HTTP client disconnect`, async () => {
    let signalUpstreamClosed: () => void;
    const upstreamClosed = new Promise<void>(resolve => { signalUpstreamClosed = resolve; });
    const caller = new AbortController();
    const timer = new AbortController();
    const calls: (string | undefined)[] = [];
    let closed = false;
    const upstream = createServer((req, res) => {
      calls.push(req.url);
      req.resume();
      res.once("close", () => {
        closed = true;
        if (!res.writableFinished) signalUpstreamClosed();
      });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({
        type: "response.created",
        response: { id: "resp_fixture", model, status: "in_progress", output: [] },
      })}\n\n`);
    });
    let proxy: Server | undefined;
    const openingDeadline = setTimeout(() => caller.abort(), 5000);
    try {
      const deps = proxyDeps(await listen(upstream));
      proxy = createProxyServer(deps);
      const proxyUrl = await listen(proxy);
      assert.ok(deps.sharedRouting);
      const action = deps.sharedRouting.actions.create(client, "http-disconnect-fixture");
      const response = await fetch(`${proxyUrl}${action.ingressPrefix}${path}`, {
        method: "POST", headers: { "content-type": "application/json" }, signal: caller.signal,
        body: JSON.stringify({ model: "work", stream: true, ...input }),
      });
      assert.equal(response.status, 200);
      assert.ok(response.body);
      const reader = response.body.getReader();
      assert.equal(await readOpening(reader), opening);
      assert.equal(closed, false, "the upstream closed before the client disconnected");
      clearTimeout(openingDeadline);

      const deadline = delay(2000, undefined, { signal: timer.signal })
        .then(() => assert.fail("client disconnect did not close the unfinished upstream within 2 s"));
      await Promise.race([Promise.all([reader.cancel(), upstreamClosed]), deadline]);

      assert.deepEqual(calls, ["/responses"]);
    } finally {
      clearTimeout(openingDeadline);
      timer.abort();
      caller.abort();
      await Promise.all([close(proxy), close(upstream)]);
    }
  });
}
