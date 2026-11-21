import assert from "node:assert/strict";
import { describe, it, after } from "node:test";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { gzipSync, brotliCompressSync, deflateSync } from "node:zlib";
import type { AddressInfo } from "node:net";
import { codexIngressRoute } from "../../src/codex-ingress.js";
import { loadConfig } from "../../src/config.js";
import { MODEL_REGISTRY, PROVIDER_IDS } from "../../src/models.js";
import { buildTestDeps } from "../helpers/server-deps.js";
import { GEMINI_TEST_MODEL, geminiTestProvider, startGeminiFake } from "../fixtures/gemini.js";
import { startFakeUpstream, startSubswitch, rawHttpRequest } from "./fake-upstreams.js";

const cleanups: (() => Promise<unknown>)[] = [];
after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); });

type ProxyOptions = NonNullable<Parameters<typeof startSubswitch>[1]>;
async function setup(handler: Parameters<typeof startFakeUpstream>[0], config: Record<string, unknown> = {},
  providers: Record<string, unknown> = {}, providerDeps?: ProxyOptions["providerDeps"]) {
  const anthropic = await startFakeUpstream((_req, res) => res.end("anthropic"));
  const subscription = await startFakeUpstream(handler);
  const api = await startFakeUpstream(handler);
  const logs: unknown[] = [];
  const proxy = await startSubswitch({
    anthropic: { baseUrl: anthropic.url }, providers,
    codexIngress: { enabled: true, subscriptionBaseUrl: `${subscription.url}/backend-api/codex`, apiBaseUrl: `${api.url}/v1`, ...config },
    limits: { maxBufferedBodyBytes: 16 },
  }, { logger: { log: (level, event, fields) => logs.push({ level, event, fields }) },
    ...(providerDeps === undefined ? {} : { providerDeps }),
  });
  cleanups.push(anthropic.close, subscription.close, api.close, proxy.close);
  return { anthropic, subscription, api, proxy, logs };
}

async function rawUpgrade(url: string, options: { origin?: string; path?: string; head?: Buffer } = {}) {
  const parsed = new URL(url);
  const socket = net.createConnection({ host: parsed.hostname, port: Number(parsed.port) });
  let bytes = Buffer.alloc(0);
  socket.on("data", (chunk) => { bytes = Buffer.concat([bytes, chunk]); });
  socket.on("error", () => undefined);
  await once(socket, "connect");
  const request = Buffer.from([
    `GET ${options.path ?? "/codex/v1/responses?probe=yes"} HTTP/1.1`, `Host: ${parsed.host}`,
    "Connection: Upgrade", "Upgrade: websocket", "Sec-WebSocket-Version: 13",
    "Sec-WebSocket-Key: ZmFrZS1wcm9iZS1rZXktMQ==", "Authorization: Bearer native-credential",
    ...(options.origin ? [`Origin: ${options.origin}`] : []), "", "",
  ].join("\r\n"));
  socket.write(Buffer.concat([request, options.head ?? Buffer.alloc(0)]));
  const waitFor = async (predicate: (bytes: Buffer) => boolean) => {
    const deadline = Date.now() + 3000;
    while (!predicate(bytes)) {
      assert.ok(Date.now() < deadline, "timed out reading raw upgrade");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return bytes;
  };
  cleanups.push(async () => { socket.destroy(); });
  await waitFor((data) => data.includes("\r\n\r\n"));
  return { socket, waitFor, bytes: () => bytes };
}

describe("Codex namespace and raw HTTP ingress", () => {
  it("uses exact namespace boundaries and preserves path/query bytes", () => {
    assert.deepEqual(codexIngressRoute("/codex/v1/responses?x=%2f&x=two"), {
      kind: "codex", mode: "api", path: "/responses?x=%2f&x=two",
    });
    assert.deepEqual(codexIngressRoute("/codex/backend-api/codex?x=1"), { kind: "codex", mode: "subscription", path: "?x=1" });
    for (const path of ["/codex", "/codex/nope", "/codex/v10/responses", "/codex/backend-api/codexx/responses"]) {
      assert.equal(codexIngressRoute(path).kind, "reserved");
    }
    for (const path of ["/v1/messages", "/codex-other"]) assert.equal(codexIngressRoute(path).kind, "other");
  });

  it("uses the originating error envelope for non-Codex upgrades", async () => {
    const { proxy } = await setup((_req, res) => res.end());
    const rejected = await rawUpgrade(proxy.url, { path: "/v1/messages", origin: "https://foreign.example" });
    assert.match(rejected.bytes().toString(), /403/);
    assert.match(rejected.bytes().toString(), /"type":"error","error":\{"type":"permission_error"/);
    const missing = await rawUpgrade(proxy.url, { path: "/v1/messages" });
    assert.match(missing.bytes().toString(), /404/);
    assert.match(missing.bytes().toString(), /"type":"not_found_error"/);
  });

  it("keeps disabled and unknown Codex paths away from Anthropic", async () => {
    const { proxy, anthropic, subscription, api } = await setup((_req, res) => res.end(), { enabled: false });
    for (const [path, status] of [["/codex/v1/responses", 503], ["/codex/unknown", 404]] as const) {
      const response = await fetch(`${proxy.url}${path}`, { method: "POST", body: "unread upload" });
      assert.equal(response.status, status);
      const body = await response.json() as Record<string, unknown>;
      assert.ok(body["error"]);
      assert.equal(body["type"], undefined, "must be Responses-shaped, not Anthropic-shaped");
    }
    assert.equal(anthropic.requests.length + subscription.requests.length + api.requests.length, 0);
  });

  it("forwards each namespace only to its selected upstream with native credentials", async () => {
    const { proxy, api, subscription, anthropic } = await setup((_req, res, body) => res.end(body));
    for (const [prefix, auth, destination, expected] of [
      ["/codex/backend-api/codex", "Bearer subscription-fake", subscription, "/backend-api/codex"],
      ["/codex/v1", "Bearer api-fake", api, "/v1"],
    ] as const) {
      const body = '{ "model": "future-native-model", "stream": false, "input": "untouched" }';
      const response = await fetch(`${proxy.url}${prefix}/responses?q=%2f&q=two`, {
        method: "POST", headers: { authorization: auth, "chatgpt-account-id": "native-account", "content-type": "application/json" }, body,
      });
      assert.equal(await response.text(), body);
      assert.equal(destination.requests[0]?.url, `${expected}/responses?q=%2f&q=two`);
      assert.equal(destination.requests[0]?.headers["authorization"], auth);
      assert.equal(destination.requests[0]?.headers["chatgpt-account-id"], "native-account");
      assert.equal(destination.requests[0]?.headers["anthropic-version"], undefined);
      assert.equal(destination.requests[0]?.body.toString(), body);
    }
    assert.equal(anthropic.requests.length, 0);
    const root = await fetch(`${proxy.url}/codex/v1?probe=1`);
    await root.text();
    assert.equal(api.requests.at(-1)?.url, "/v1?probe=1", "do not invent a trailing slash at the base path");
  });

  for (const claude of [false, true]) {
    it(`TP-38: sends a model of each other registry provider to OpenAI only, with Claude translation ${claude ? "on" : "off"}`,
      async (t) => {
        const gemini = await startGeminiFake(t, (_req, res) => res.end());
        const { proxy, api, subscription, anthropic } = await setup((_req, res) => {
          res.writeHead(400, { "content-type": "application/json" });
          res.end('{"error":{"message":"The model does not exist","code":"model_not_found"}}');
        }, { claude: { enabled: claude } }, { gemini: geminiTestProvider }, { gemini: gemini.deps });
        const names = PROVIDER_IDS.filter((id) => id !== "codex").flatMap((id) => {
          const entry = MODEL_REGISTRY.find((model) => model.provider === id);
          if (id === "gemini") return [GEMINI_TEST_MODEL, ...(entry === undefined ? [] : [entry.id, `${id}:${entry.id}`])];
          return entry === undefined ? [`${id}:fixture/model`] : [entry.id, `${id}:${entry.id}`];
        });
        for (const model of names) {
          const body = JSON.stringify({ model, stream: false, input: "untouched" });
          const response = await fetch(`${proxy.url}/codex/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body });
          assert.equal(response.status, 400, `the OpenAI upstream answers ${model}`);
          await response.text();
          assert.equal(api.requests.at(-1)?.body.toString(), body);
        }
        assert.equal(api.requests.length, names.length);
        assert.equal(subscription.requests.length + anthropic.requests.length, 0);
        assert.deepEqual(gemini.execs, []);
        assert.deepEqual(gemini.fetches, []);
        assert.equal(gemini.upstream.connectionCount, 0);
        assert.deepEqual(proxy.refusedStoreCalls, [], "no provider credential store is used");
      });
  }

  it("does not parse, decompress, impose the translation body bound, or replace models", async () => {
    const { proxy, api } = await setup((_req, res) => res.end("ok"));
    const body = Buffer.from('{ "model": "claude-sonnet-5", "input": "' + "x".repeat(200_000) + '" }');
    const inputs: [string, Buffer][] = [
      ["gzip", gzipSync(body)], ["br", brotliCompressSync(body)], ["deflate", deflateSync(body)],
      ["zstd", Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 1, 2, 3])], ["identity", Buffer.from("{malformed-json")],
    ];
    for (const [encoding, payload] of inputs) {
      const response = await fetch(`${proxy.url}/codex/v1/responses`, {
        method: "POST", headers: { "content-encoding": encoding }, body: payload,
      });
      await response.text();
      assert.deepEqual(api.requests.at(-1)?.body, payload);
      assert.equal(api.requests.at(-1)?.headers["content-encoding"], encoding);
    }
    // Includes a Claude-looking model: this slice is intentionally passthrough only.
    assert.equal(api.requests.length, inputs.length);
  });

  it("preserves errors, redirects, Retry-After, and native discovery/compaction responses", async () => {
    const payload = '{"error":{"type":"rate_limit_error","message":"native limit"}}';
    const { proxy, api, anthropic } = await setup((req, res) => {
      if (req.url?.includes("redirect")) {
        res.writeHead(307, { location: "https://example.invalid/credential-target" }); res.end();
      } else if (req.url?.includes("responses")) {
        res.writeHead(429, { "retry-after": "123", "x-request-id": "native-id", "x-subswitch-synthesized": "1" });
        res.end(payload);
      } else { res.end('{"models":[{"slug":"native","future_metadata":true}]}'); }
    });
    const response = await fetch(`${proxy.url}/codex/v1/responses/compact`, { method: "POST", body: "opaque" });
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), "123");
    assert.equal(response.headers.get("x-subswitch-synthesized"), null);
    assert.equal(await response.text(), payload);
    const redirect = await fetch(`${proxy.url}/codex/v1/redirect`, { redirect: "manual" });
    assert.equal(redirect.status, 307);
    await redirect.text();
    const models = await fetch(`${proxy.url}/codex/v1/models?client_version=future`);
    assert.equal(await models.text(), '{"models":[{"slug":"native","future_metadata":true}]}');
    assert.equal(api.requests.length, 3);
    assert.equal(anthropic.requests.length, 0);
  });

  it("preserves streaming responses beyond the connect budget and logs no payload/query", async () => {
    const sse = 'data: {"type":"response.completed","secret":"payload"}\n\n';
    const { proxy, logs } = await setup((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sse.slice(0, 9));
      setTimeout(() => res.end(sse.slice(9)), 60);
    }, { connectTimeoutMs: 10 });
    const response = await fetch(`${proxy.url}/codex/v1/responses?token=private-query`, {
      method: "POST", headers: { authorization: "Bearer private-credential" }, body: "private-prompt",
    });
    assert.equal(await response.text(), sse);
    const logged = JSON.stringify(logs);
    for (const secret of ["private-query", "private-credential", "private-prompt", "payload"]) assert.ok(!logged.includes(secret));
    assert.ok(logged.includes("codex_ingress:api:passthrough"));
  });

  it("returns a Responses error when connecting fails", async () => {
    const { proxy, api } = await setup((_req, res) => res.end());
    await api.close();
    const response = await fetch(`${proxy.url}/codex/v1/responses`, { method: "POST", body: "upload" });
    assert.equal(response.status, 502);
    assert.equal(response.headers.get("x-subswitch-synthesized"), "1");
    assert.deepEqual(await response.json(), { error: {
      message: "upstream connection failed", type: "api_error", param: null, code: "subswitch_upstream_error",
    } });
  });

  it("strips headers nominated by Connection and preserves duplicate end-to-end headers", async () => {
    const { proxy, api } = await setup((_req, res) => {
      res.writeHead(200, ["Connection", "X-Internal", "X-Internal", "hop-only", "X-Native", "one", "X-Native", "two"]);
      res.end("ok");
    });
    const response = await rawHttpRequest(`${proxy.url}/codex/v1/responses`, {
      method: "POST", body: Buffer.from("test"), rawHeaders: [
        "Connection", "keep-alive, X-Local", "X-Local", "hop-only", "X-Native", "one", "X-Native", "two",
      ],
    });
    assert.equal(api.requests[0]?.headers["x-local"], undefined);
    assert.equal(api.requests[0]?.headers["x-native"], "one, two");
    assert.ok(!response.rawHeaders.some((value) => value.toLowerCase() === "x-internal"));
    const values: string[] = [];
    for (let i = 0; i < response.rawHeaders.length; i += 2) {
      if (response.rawHeaders[i]?.toLowerCase() === "x-native") values.push(response.rawHeaders[i + 1]!);
    }
    assert.deepEqual(values, ["one", "two"]);
  });

  it("reports enabled passthrough as distinct from unavailable translation", async () => {
    const { proxy } = await setup((_req, res) => res.end());
    const response = await fetch(`${proxy.url}/__subswitch/health`);
    const health = await response.json() as { codexIngress: unknown };
    assert.deepEqual(health.codexIngress, {
      schemaVersion: 1, enabled: true, mode: "passthrough", translationAvailable: false,
      credentials: "client", transports: ["http", "websocket"],
    });
  });

  it("applies Host/Origin protection to Codex HTTP requests", async () => {
    const { proxy, api, subscription, anthropic } = await setup((_req, res) => res.end());
    const response = await fetch(`${proxy.url}/codex/v1/responses`, { headers: { origin: "https://foreign.example" } });
    assert.equal(response.status, 403);
    const body = await response.json() as { error: { code: string } };
    assert.equal(body.error.code, "subswitch_host_rejected");
    assert.equal(api.requests.length + subscription.requests.length + anthropic.requests.length, 0);
  });

  it("validates credential destinations and defaults to disabled", () => {
    const parse = (codexIngress: unknown) => loadConfig({ configPath: "inline.json", readFile: () => JSON.stringify({ codexIngress }) });
    const defaults = parse({});
    assert.ok(defaults.ok);
    assert.equal(defaults.value.config.codexIngress.enabled, false);
    for (const url of ["http://foreign.example", "https://user:key@api.openai.com/v1", "https://api.openai.com/v1?q=1", "ftp://localhost/path"]) {
      assert.equal(parse({ apiBaseUrl: url }).ok, false);
    }
    for (const url of ["https://foreign.example/v1", "https://api.openai.com:444/v1"]) {
      const result = parse({ enabled: true, apiBaseUrl: url });
      assert.ok(result.ok);
      assert.equal(buildTestDeps(result.value.config).ok, false);
      const explicit = parse({ enabled: true, apiBaseUrl: url, allowInsecureBaseUrl: true });
      assert.ok(explicit.ok);
      const deps = buildTestDeps(explicit.value.config);
      assert.ok(deps.ok);
      deps.value.forwardOpenai?.close();
    }
  });
});

describe("Codex raw upgrade transport", () => {
  it("tunnels client/upstream handshake head bytes, continuation frames, and connection reuse", async () => {
    const upstream = http.createServer();
    let received = Buffer.alloc(0);
    let requests = 0;
    const upstreamHead = Buffer.from([0x81, 0x02, 0x6f, 0x6b]);
    const clientHead = Buffer.from([0x89, 0x80, 1, 2, 3, 4]);
    upstream.on("upgrade", (req, socket, head) => {
      requests++;
      assert.equal(req.url, "/v1/responses?probe=yes");
      assert.equal(req.headers.authorization, "Bearer native-credential");
      socket.on("error", () => undefined);
      socket.on("end", () => socket.end());
      socket.write(Buffer.concat([Buffer.from("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: native-value\r\n\r\n"), upstreamHead]));
      received = Buffer.concat([received, head]);
      if (head.length) socket.write(head);
      socket.on("data", (data) => { received = Buffer.concat([received, data]); socket.write(data); });
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    const proxy = await startSubswitch({ codexIngress: { enabled: true, apiBaseUrl: `${url}/v1` } });
    cleanups.push(async () => { upstream.closeAllConnections(); await new Promise<void>((resolve) => upstream.close(() => resolve())); }, proxy.close);
    const raw = await rawUpgrade(proxy.url, { head: clientHead });
    await raw.waitFor((bytes) => bytes.includes(upstreamHead) && bytes.includes(clientHead));
    const warmupAndContinuation = Buffer.from('response.create generate=false; response.create previous_response_id=resp_fixed; incremental input');
    raw.socket.write(warmupAndContinuation);
    await raw.waitFor((bytes) => bytes.includes(warmupAndContinuation));
    assert.deepEqual(received, Buffer.concat([clientHead, warmupAndContinuation]));
    assert.equal(requests, 1, "continuation stays on the original upstream connection");
    // Shutdown must close upgraded sockets too, without waiting for a stream deadline.
    const closed = once(raw.socket, "close");
    await proxy.close();
    await closed;
  });

  it("preserves upstream upgrade rejection status, headers and body", async () => {
    const { proxy, api } = await setup((_req, res) => {
      res.writeHead(429, { "retry-after": "77", "content-type": "application/json" });
      res.end('{"error":{"message":"native limit"}}');
    });
    const raw = await rawUpgrade(proxy.url);
    await raw.waitFor((bytes) => bytes.includes("native limit"));
    const wire = raw.bytes().toString();
    assert.match(wire, /^HTTP\/1.1 429/);
    assert.match(wire, /retry-after: 77/i);
    assert.equal(api.requests.length, 1);
  });

  it("rejects foreign origins and unknown/disabled namespaces before connecting", async () => {
    const { proxy, api, subscription, anthropic } = await setup((_req, res) => res.end(), { enabled: false });
    for (const [options, status] of [
      [{ origin: "https://foreign.example" }, 403], [{ path: "/codex/nope" }, 404], [{}, 503],
    ] as const) {
      const raw = await rawUpgrade(proxy.url, options);
      assert.ok(raw.bytes().toString().startsWith(`HTTP/1.1 ${status}`));
    }
    assert.equal(api.requests.length + subscription.requests.length + anthropic.requests.length, 0);
  });
});
