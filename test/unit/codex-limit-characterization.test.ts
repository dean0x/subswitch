import assert from "node:assert/strict";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { it } from "node:test";
import { createCodexHandler } from "../../src/codex-handler.js";
import { loadConfig, providerConfigFor } from "../../src/config.js";
import type { LimitObservation } from "../../src/limit-observation.js";
import { ReasoningCache } from "../../src/reasoning-cache.js";
import { ok } from "../../src/result.js";
import { created, responsesSse, terminal } from "../helpers/responses-sse.js";

const model = "gpt-5.5";
const context = { provider: "codex", product: "chatgpt-codex", protocol: "responses" };

async function deliver(upstream: Response) {
  const loaded = loadConfig({ configPath: "inline.json", readFile: () => "{}" });
  assert.ok(loaded.ok);
  const { config } = loaded.value;
  const records: LimitObservation[] = [];
  const credential = { provider: "codex", authHeaders: {} } as const;
  const handler = createCodexHandler({
    providerId: "codex",
    provider: config.providers.codex,
    pingIntervalMs: config.limits.pingIntervalMs,
    loginCommand: providerConfigFor(config, "codex").loginCommand,
    logger: { log() {}, recordLimit: (record) => records.push(record) },
    auth: {
      refreshable: false,
      getCredentials: async () => ok(credential),
      forceRefresh: async () => assert.fail("Unexpected refresh"),
    },
    cache: new ReasoningCache(4, 1024),
    fetchImpl: async () => upstream,
  });
  const parsed = { model, max_tokens: 10, stream: true, messages: [{ role: "user", content: "Hi" }] };
  const req = new IncomingMessage(new Socket());
  const res = new ServerResponse(req);
  await handler.handleMessages(req, res, Buffer.from(JSON.stringify(parsed)), parsed, model);
  return { res, records };
}

it("records one HTTP limit failure under the Codex key", async () => {
  const { res, records } = await deliver(new Response('{"error":{"code":"rate_limit_exceeded"}}', {
    status: 429, headers: { "retry-after": "7" },
  }));

  assert.equal(res.statusCode, 429);
  assert.deepEqual(records.map((record) => ({
    context: record.context, transport: record.transport, status: record.status,
    candidate: record.candidate, headers: record.headers,
  })), [{ context, transport: "http", status: 429, candidate: "limit", headers: { "retry-after": "7" } }]);
});

it("observes a limit event in an HTTP 200 Codex stream", async () => {
  const sse = responsesSse([
    created(model),
    { type: "error", error: { code: "rate_limit_exceeded", status: 429 } },
    terminal(model, []),
  ]);
  const { res, records } = await deliver(new Response(sse, { headers: { "content-type": "text/event-stream" } }));

  assert.equal(res.statusCode, 200);
  assert.ok(res.writableEnded);
  assert.deepEqual(records.map((record) => ({
    context: record.context, transport: record.transport, candidate: record.candidate,
    providerStartSeen: record.providerStartSeen,
  })), [{ context, transport: "sse", candidate: "limit", providerStartSeen: true }]);
});
