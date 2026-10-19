/** Production HTTP routing with fixture-only endpoints and fabricated OAuth material. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../../src/config.js";
import { buildDeps, createProxyServer, listenServer } from "../../src/server.js";
import { noopLogger } from "../../src/logger.js";
import { makeAccessToken, makeAuthFileContent, startFakeUpstream } from "./fake-upstreams.js";

const future = "gpt-fixture-next-sol";

async function rig(rejectModel = false) {
  const root = await mkdtemp(join(tmpdir(), "subswitch-future-http-"));
  const token = makeAccessToken(Date.now() + 3600000, "acct_fabricated_future");
  const authFile = join(root, "fabricated-auth.json");
  await writeFile(authFile, makeAuthFileContent(token), "utf8");
  const origin = await startFakeUpstream((req, res, body) => {
    if (req.url !== "/codex/responses" || rejectModel) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "invalid_request_error", message: "fabricated upstream model unavailable" } }));
      return;
    }
    const model = (JSON.parse(body.toString()) as { model: string }).model;
    const response = { id: "resp_fixture_future", model, output: [], usage: { input_tokens: 1, output_tokens: 0 } };
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const [type, status] of [["response.created", "in_progress"], ["response.completed", "completed"]])
      res.write(`event: ${type}\ndata: ${JSON.stringify({ type, response: { ...response, status } })}\n\n`);
    res.end();
  });
  try {
    const loaded = loadConfig({
      configPath: join(root, "config.json"), env: {},
      readFile: () => JSON.stringify({
        anthropic: { baseUrl: `${origin.url}/anthropic` },
        providers: { codex: {
          aliases: { sol: future, worker: future }, authFile,
          baseUrl: `${origin.url}/codex`, oauthTokenUrl: `${origin.url}/unexpected-refresh`,
        } },
        codexIngress: {
          subscriptionBaseUrl: `${origin.url}/unexpected-subscription`, apiBaseUrl: `${origin.url}/unexpected-api`,
          claude: {
            baseUrl: `${origin.url}/unexpected-claude`, oauthTokenUrl: `${origin.url}/unexpected-claude-refresh`,
            authFile: join(root, "absent-claude.json"), configDir: join(root, "absent-claude-config"),
          },
        },
      }),
    });
    assert.ok(loaded.ok);
    const config = loaded.value.config;
    for (const endpoint of [config.anthropic.baseUrl, config.providers.codex.baseUrl,
      config.providers.codex.oauthTokenUrl, config.codexIngress.subscriptionBaseUrl,
      config.codexIngress.apiBaseUrl, config.codexIngress.claude.baseUrl, config.codexIngress.claude.oauthTokenUrl])
      assert.equal(new URL(endpoint).origin, origin.url);
    for (const path of [config.providers.codex.authFile, config.codexIngress.claude.authFile!, config.codexIngress.claude.configDir!])
      assert.ok(path.startsWith(`${root}/`));
    const deps = buildDeps(loaded.value.config, noopLogger);
    assert.ok(deps.ok);
    const proxy = createProxyServer(deps.value);
    const listening = await listenServer(proxy, 0, "127.0.0.1");
    assert.ok(listening.ok);
    return {
      origin, token, url: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
      async close() {
        proxy.closeAllConnections();
        await new Promise<void>(resolve => proxy.close(() => resolve()));
        await origin.close();
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await origin.close();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function send(url: string, model: string, stream: boolean) {
  return fetch(`${url}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer fabricated-incoming-not-for-codex" },
    body: JSON.stringify({ model, stream, max_tokens: 16, messages: [{ role: "user", content: "fabricated prompt" }] }),
  });
}

describe("future-model overrides through production HTTP", () => {
  for (const stream of [false, true]) {
    it(`starts and routes declared aliases/full/qualified IDs to the future model with stream=${stream}`, async () => {
      const fixture = await rig();
      try {
        for (const requested of ["sol", "worker", "codex:sol", "codex:worker", future, `codex:${future}`]) {
          const response = await send(fixture.url, requested, stream);
          assert.equal(response.status, 200, requested);
          if (stream) assert.match(await response.text(), /event: message_stop/);
          else assert.equal((await response.json() as { stop_reason: string }).stop_reason, "end_turn");
          const upstream = fixture.origin.requests.at(-1)!;
          assert.equal(upstream.url, "/codex/responses");
          assert.equal((JSON.parse(upstream.body.toString()) as { model: string }).model, future, requested);
          assert.equal(upstream.headers.authorization, `Bearer ${fixture.token}`);
          assert.notEqual(upstream.headers.authorization, "Bearer fabricated-incoming-not-for-codex");
        }
        assert.equal(fixture.origin.requests.length, 6, "one Codex call per declared spelling, no retries/fallback");
        for (const requested of ["gpt-fixture-undeclared", "typo:sol"]) {
          const response = await send(fixture.url, requested, stream);
          assert.equal(response.status, 400);
          assert.match(await response.text(), /fabricated upstream model unavailable/);
          assert.equal(fixture.origin.requests.at(-1)!.url, "/anthropic/v1/messages");
          assert.equal((JSON.parse(fixture.origin.requests.at(-1)!.body.toString()) as { model: string }).model, requested);
        }
        assert.equal(fixture.origin.requests.filter(req => req.url === "/codex/responses").length, 6);
      } finally { await fixture.close(); }
    });
  }

  it("keeps provider rejection authoritative for a declared but unavailable model", async () => {
    const fixture = await rig(true);
    try {
      const response = await send(fixture.url, future, false);
      assert.equal(response.status, 400);
      assert.match(await response.text(), /fabricated upstream model unavailable/);
      assert.equal(fixture.origin.requests.length, 1);
      assert.equal(fixture.origin.requests[0]!.url, "/codex/responses");
      assert.equal((JSON.parse(fixture.origin.requests[0]!.body.toString()) as { model: string }).model, future);
    } finally { await fixture.close(); }
  });
});
