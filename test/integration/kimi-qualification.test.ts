/** OFFLINE: real ephemeral loopback sockets, fabricated providers/clients/keys only.
 * This qualifies Subswitch plumbing, not the live Kimi contract or native CLI.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadConfig } from "../../src/config.js";
import { noopLogger } from "../../src/logger.js";
import { buildDeps, createProxyServer, listenServer } from "../../src/server.js";
import { defaultBase } from "../../src/routing/destination-catalog.js";
import { SharedRouting } from "../../src/routing/shared-routing.js";
import { ProfileAuth } from "../../src/routing/profile-auth.js";
import type { RoutingClock } from "../../src/routing/clock.js";
import { KimiAuthManager } from "../../src/kimi-auth.js";
import { createKimiAuthStore, type KimiAuthRecord } from "../../src/kimi-auth-store.js";
import type { AccessProfile, Item, OriginatingClient, WireProtocol } from "../../src/routing/routing-types.js";
import { added, created, delta, done, terminal, textItem as kimiTextItem } from "../helpers/kimi-responses-bridge.js";
import { wire } from "../helpers/kimi-ordered-route.js";

interface Call {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: Item;
}
type Handler = (call: Call, res: http.ServerResponse) => void;
const key = "fabricated-kimi-key";
const primaryKey = "fabricated-primary-key";
const env = { SYNTHETIC_KIMI_KEY: key, SYNTHETIC_PRIMARY_KEY: primaryKey };
const signal = () => AbortSignal.timeout(5000);
const protocolFor = (client: OriginatingClient): WireProtocol => client === "codex" ? "responses" : "messages";
const textItem = (text: string): Item => ({
  type: "message", id: "fake-message", role: "assistant", status: "completed",
  content: [{ type: "output_text", text, annotations: [] }],
});

function events(protocol: WireProtocol, toolPath?: string, text = "offline-ready"): Item[] {
  if (protocol === "messages") {
    const block = toolPath
      ? { type: "tool_use", id: "fake-call", name: "Read", input: {} }
      : { type: "text", text: "" };
    return [
      { type: "message_start", message: { id: "fake-response", type: "message", role: "assistant", content: [], model: "k3" } },
      { type: "content_block_start", index: 0, content_block: block },
      { type: "content_block_delta", index: 0, delta: toolPath
        ? { type: "input_json_delta", partial_json: JSON.stringify({ path: toolPath }) }
        : { type: "text_delta", text } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: toolPath ? "tool_use" : "end_turn" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ];
  }
  const item: Item = toolPath
    ? { type: "function_call", id: "fake-tool", call_id: "fake-call", name: "Read", arguments: JSON.stringify({ path: toolPath }), status: "completed" }
    : textItem(text);
  return [
    { type: "response.created", response: { id: "fake-response", status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, ...(toolPath ? { arguments: "" } : { content: [] }), status: "in_progress" } },
    ...(toolPath ? [{ type: "response.function_call_arguments.delta", output_index: 0, item_id: "fake-tool", delta: item["arguments"] }]
      : [{ type: "response.output_text.delta", output_index: 0, item_id: "fake-message", content_index: 0, delta: text }]),
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "fake-response", status: "completed", output: [item] } },
  ];
}
function send(res: http.ServerResponse, values: Item[]): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(values.map((value) => `data: ${JSON.stringify(value)}\n\n`).join(""));
}
async function listen(server: http.Server): Promise<string> {
  const result = await listenServer(server, 0, "127.0.0.1");
  assert.ok(result.ok);
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: http.Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function fixture(
  options: { product?: "kimi-code" | "kimi-platform"; region?: "global" | "mainland-cn"; fallback?: boolean;
    managedRecovery?: { clock: RoutingClock } },
  handle: Handler,
) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "subswitch-kimi-offline-")));
  const calls: Call[] = [], errors: unknown[] = [], violations: string[] = [];
  const upstream = http.createServer((req, res) => {
    void (async () => {
      const parts: Buffer[] = [];
      for await (const chunk of req) parts.push(Buffer.from(chunk));
      const call = { path: req.url!, headers: req.headers, body: JSON.parse(Buffer.concat(parts).toString("utf8")) as Item };
      calls.push(call);
      handle(call, res);
    })().catch((error: unknown) => {
      errors.push(error);
      res.writeHead(500).end();
    });
  });
  let relay: http.Server | undefined;
  let routing: SharedRouting | undefined;
  try {
    const upstreamBase = await listen(upstream);
    const product = options.product ?? "kimi-code";
    const profile: AccessProfile = {
      provider: "kimi", product, region: options.region ?? "global",
      billing: product === "kimi-code" ? "subscription" : "api", account: "offline-kimi",
      credential: options.managedRecovery
        ? { kind: "native-oauth", authFile: join(directory, "managed-auth.json") }
        : { kind: "env", name: "SYNTHETIC_KIMI_KEY" },
      ...(options.managedRecovery ? {} : { baseUrl: upstreamBase + (product === "kimi-code" ? "/coding" : "") }),
    };
    const target = { profile: "kimi", model: options.managedRecovery ? "kimi-for-coding" : product === "kimi-code" ? "k3" : "kimi-k3", effort: "high" };
    const existingTarget = { profile: "primary", model: "gpt-6.1-sol", effort: "high" };
    const loaded = loadConfig({
      configPath: join(directory, "config.json"), env: {},
      readFile: () => JSON.stringify({
        configVersion: 2,
        anthropic: { baseUrl: upstreamBase + "/unused-anthropic" },
        providers: { codex: { baseUrl: upstreamBase + "/unused-codex", oauthTokenUrl: upstreamBase + "/unused-oauth", authFile: join(directory, "unused-codex-auth.json") } },
        codexIngress: {
          enabled: true, subscriptionBaseUrl: upstreamBase + "/unused-subscription", apiBaseUrl: upstreamBase + "/unused-api",
          claude: { authFile: join(directory, "unused-claude-auth.json"), baseUrl: upstreamBase + "/unused-claude", oauthTokenUrl: upstreamBase + "/unused-claude-oauth" },
        },
        accessProfiles: {
          kimi: profile,
          primary: { provider: "codex", product: "openai-api", billing: "api", account: "offline-primary", credential: { kind: "env", name: "SYNTHETIC_PRIMARY_KEY" }, baseUrl: upstreamBase + "/primary" },
        },
        routes: {
          offline: {
            clients: ["codex", "claude-code"],
            primary: options.fallback ? existingTarget : target,
            fallbacks: options.fallback ? [target] : options.managedRecovery ? [existingTarget] : [],
          },
        },
      }),
    });
    assert.ok(loaded.ok, loaded.ok ? "" : loaded.error.message);
    const fetchImpl: typeof fetch = async (url, init) => {
      const parsed = new URL(String(url));
      const managedKimi = options.managedRecovery && parsed.origin === "https://api.kimi.ai"
        && parsed.pathname === "/coding/v1/responses" && parsed.search === "";
      if (!managedKimi && parsed.origin !== upstreamBase) {
        violations.push("non-fixture upstream requested");
        throw new Error("offline_network_boundary");
      }
      return fetch(managedKimi ? upstreamBase + parsed.pathname : url,
        { ...init, signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), signal()]) });
    };
    const deps = buildDeps(loaded.value.config, noopLogger, { fetchImpl, env });
    assert.ok(deps.ok, deps.ok ? "" : deps.error);
    routing = deps.value.sharedRouting!;
    if (options.managedRecovery) {
      assert.ok(profile.credential.kind === "native-oauth");
      const store = createKimiAuthStore(profile.credential.authFile);
      const record: KimiAuthRecord = { version: 1, revision: "synthetic-recovery", generation: randomUUID(),
        deviceId: "fabricated-managed-device", region: "global", tokens: { access_token: "fabricated-managed-access",
          refresh_token: "fabricated-managed-refresh", token_type: "Bearer", expires_at: Math.floor(Date.now() / 1000) + 3600 } };
      await store.withLock(() => store.write(record, signal()), signal());
      routing.close();
      routing = new SharedRouting(loaded.value.config, noopLogger, options.managedRecovery.clock, fetchImpl, env);
      // Existing dependency seams keep authentication and any unexpected refresh on owned fixtures.
      Object.defineProperty(routing.attempts, "auth", { value: new ProfileAuth(loaded.value.config.accessProfiles!, noopLogger, env,
        () => new KimiAuthManager({ store, region: "global", fixtureOrigin: upstreamBase })) });
    }
    relay = createProxyServer({ ...deps.value, sharedRouting: routing });
    const base = await listen(relay);
    return {
      directory, calls, profile, target, routing, config: loaded.value.config, fetchImpl,
      async action(client: OriginatingClient) {
        const response = await fetch(`${base}/__subswitch/actions`, {
          method: "POST", signal: signal(),
          headers: { "x-subswitch-capability": routing!.actions.capability, "content-type": "application/json" },
          body: JSON.stringify({ client, conversationId: "offline-thread" }),
        });
        assert.equal(response.status, 201);
        return await response.json() as { id: string; ingressPrefix: string };
      },
      request(client: OriginatingClient, prefix: string, body: Item) {
        const path = client === "codex" ? "/codex/v1/responses" : "/v1/messages";
        return fetch(`${base}${prefix}${path}`, {
          method: "POST", signal: signal(),
          headers: { "content-type": "application/json", authorization: "Bearer fabricated-parent-key", "x-api-key": "fabricated-parent-api-key" },
          body: JSON.stringify(body),
        });
      },
      async complete(id: string) {
        const response = await fetch(`${base}/__subswitch/actions/${id}/complete`, {
          method: "POST", signal: signal(), headers: { "x-subswitch-capability": routing!.actions.capability },
        });
        assert.equal(response.status, 200);
        await response.text();
      },
      async close() {
        routing!.close();
        await close(relay!);
        await close(upstream);
        await rm(directory, { recursive: true, force: true });
        assert.deepEqual(errors, [], "fake upstream handler failed");
        assert.deepEqual(violations, [], "offline network boundary was crossed");
      },
    };
  } catch (error) {
    routing?.close();
    if (relay) await close(relay);
    await close(upstream);
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

function initial(client: OriginatingClient): Item {
  return {
    model: "offline", stream: false,
    ...(client === "codex"
      ? { input: [{ role: "user", content: "Read the isolated fixture once." }], tools: [{ type: "function", name: "Read", parameters: { type: "object", properties: { path: { type: "string" } } } }] }
      : { max_tokens: 128, messages: [{ role: "user", content: "Read the isolated fixture once." }], tools: [{ name: "Read", input_schema: { type: "object", properties: { path: { type: "string" } } } }] }),
  };
}
function resumed(client: OriginatingClient, body: Item, reply: Item, value: string): Item {
  if (client === "codex") {
    const tool = (reply["output"] as Item[]).find((item) => item["type"] === "function_call")!;
    assert.equal(tool["call_id"], "fake-call");
    return { ...body, previous_response_id: reply["id"], input: [{ type: "function_call_output", call_id: tool["call_id"], output: value }] };
  }
  const tool = (reply["content"] as Item[]).find((item) => item["type"] === "tool_use")!;
  assert.equal(tool["id"], "fake-call");
  return { ...body, messages: [
    ...(body["messages"] as Item[]), { role: "assistant", content: reply["content"] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: tool["id"], content: value }] },
  ] };
}
function assertCredentialIsolation(call: Call, expected: string): void {
  assert.equal(call.headers.authorization, `Bearer ${expected}`);
  for (const name of ["x-api-key", "chatgpt-account-id", "anthropic-beta", "x-subswitch-capability"])
    assert.equal(call.headers[name], undefined, `${name} crossed the profile boundary`);
  assert.doesNotMatch(call.path, /__subswitch/);
}

describe("Kimi qualification through isolated loopback Subswitch (synthetic)", () => {
  for (const product of ["kimi-code", "kimi-platform"] as const)
    for (const region of ["global", "mainland-cn"] as const)
      for (const client of ["claude-code", "codex"] as const) {
        it(`binds ${product}/${region}/${client} to its key, protocol and product path`, async () => {
          const protocol = protocolFor(client);
          const rig = await fixture({ product, region }, (_call, res) => send(res, events(protocol)));
          try {
            const action = await rig.action(client);
            const response = await rig.request(client, action.ingressPrefix, initial(client));
            assert.equal(response.status, 200);
            assert.ok(await response.json());
            assert.equal(rig.calls.length, 1);
            const call = rig.calls[0]!;
            assertCredentialIsolation(call, key);
            assert.equal(call.path, product === "kimi-code"
              ? `/coding/v1/${protocol}`
              : protocol === "messages" ? "/anthropic/v1/messages" : "/v1/responses");
            assert.equal(call.body["model"], rig.target.model);
            assert.equal(call.body["stream"], true);
            assert.equal((call.body[protocol === "messages" ? "output_config" : "reasoning"] as Item)["effort"], "high");
            assert.equal(call.headers["anthropic-version"], protocol === "messages" ? "2023-06-01" : undefined);
            if (protocol === "responses") assert.equal(call.body["store"], false);
            const domain = product === "kimi-code" ? `api.kimi.${region === "global" ? "ai" : "com"}/coding`
              : `api.moonshot.${region === "global" ? "ai" : "cn"}`;
            assert.equal(defaultBase(rig.profile), `https://${domain}`);
          } finally { await rig.close(); }
        });
      }

  for (const client of ["claude-code", "codex"] as const) {
    it(`preserves a ${client} tool result on Kimi after an eligible primary failure`, async () => {
      let toolPath = "", nonce = "", kimiCalls = 0;
      const rig = await fixture({ fallback: true }, (call, res) => {
        if (call.path.startsWith("/primary/")) {
          res.writeHead(429, { "content-type": "application/json" });
          res.end('{"error":{"code":"insufficient_quota"}}');
        } else {
          kimiCalls++;
          if (kimiCalls === 1) send(res, events(protocolFor(client), toolPath));
          else {
            const input = client === "codex" ? call.body["input"] as Item[] : call.body["messages"] as Item[];
            const value = client === "codex"
              ? input.find((item) => item["type"] === "function_call_output")?.["output"]
              : (input.at(-1)?.["content"] as Item[])[0]?.["content"];
            assert.equal(value, nonce, "fake Kimi did not receive the executed tool result");
            send(res, events(protocolFor(client), undefined, String(value)));
          }
        }
      });
      try {
        toolPath = join(rig.directory, "fixture.txt");
        nonce = randomUUID();
        await writeFile(toolPath, nonce, { mode: 0o600 });
        const action = await rig.action(client), body = initial(client);
        const first = await rig.request(client, action.ingressPrefix, body);
        assert.equal(first.status, 200);
        const reply = await first.json() as Item;
        const tools = ((client === "codex" ? reply["output"] : reply["content"]) as Item[])
          .filter((item) => item["type"] === (client === "codex" ? "function_call" : "tool_use"));
        assert.equal(tools.length, 1, "completed tool was duplicated or omitted");
        const tool = tools[0]!;
        assert.equal(tool["name"], "Read");
        const args = client === "codex" ? JSON.parse(String(tool["arguments"])) as Item : tool["input"] as Item;
        assert.equal(args["path"], toolPath);
        const value = await readFile(String(args["path"]), "utf8");
        await writeFile(join(rig.directory, "client-state.json"), JSON.stringify({ response: reply, toolResult: value }), { mode: 0o600 });
        const response = await rig.request(client, action.ingressPrefix, resumed(client, body, reply, value));
        assert.equal(response.status, 200);
        assert.match(JSON.stringify(await response.json()), new RegExp(nonce));
        assert.deepEqual(rig.calls.map((call) => call.path.startsWith("/primary/") ? "primary" : "kimi"), ["primary", "kimi", "kimi"]);
        assertCredentialIsolation(rig.calls[0]!, primaryKey);
        for (const call of rig.calls.slice(1)) assertCredentialIsolation(call, key);
        const continuation = rig.calls[2]!.body;
        assert.match(JSON.stringify(continuation), new RegExp(nonce));
        if (client === "codex") {
          assert.equal(continuation["previous_response_id"], undefined);
          assert.equal((continuation["input"] as Item[]).filter((item) => item["type"] === "function_call").length, 1);
        }
        assert.equal(rig.routing.actions.affinity(rig.routing.actions.context(action.id, client), "offline").chainIndex, 1);
      } finally { await rig.close(); }
    });
  }

  it("recovers primary preference for a later action while an active Kimi tool turn stays pinned", async () => {
    let primaryCalls = 0, kimiCalls = 0, now = 1000;
    const rig = await fixture({ fallback: true }, (call, res) => {
      if (call.path.startsWith("/primary/") && ++primaryCalls === 1) {
        res.writeHead(429, { "content-type": "application/json" });
        res.end('{"error":{"code":"insufficient_quota"}}');
      } else send(res, events("responses", call.path.startsWith("/coding/") && ++kimiCalls === 1 ? "fixture.txt" : undefined));
    });
    const routing = new SharedRouting(rig.config, noopLogger,
      { now: () => now, monotonic: () => now, random: () => 0.5 }, rig.fetchImpl, env);
    const collect = async (body: Item, context: ReturnType<typeof routing.actions.context>) => {
      const result: Item[] = [];
      for await (const event of routing.events(body, "codex", "offline", signal(), context)) result.push(event);
      return result.at(-1)!["response"] as Item;
    };
    try {
      const a = routing.actions.create("codex", "offline-thread"), context = routing.actions.context(a.id, "codex"), body = initial("codex");
      const reply = await collect(body, context);
      now += 61000;
      const b = routing.actions.create("codex", "offline-thread");
      await collect(body, routing.actions.context(b.id, "codex"));
      await collect(resumed("codex", body, reply, "fabricated-tool-result"), context);
      assert.deepEqual(rig.calls.map((call) => call.path.startsWith("/primary/") ? "primary" : "kimi"), ["primary", "kimi", "primary", "kimi"]);
      assert.equal(routing.actions.affinity(context, "offline").selectedTarget?.profile, "kimi");
      assert.equal(routing.actions.affinity(routing.actions.context(b.id, "codex"), "offline").selectedTarget?.profile, "primary");
    } finally { routing.close(); await rig.close(); }
  });

  it("keeps a Claude Messages fallback tool turn pinned while a later action recovers managed Kimi OAuth (synthetic)", async () => {
    let now = 1000, toolPath = "", nonce = "", fallbackCalls = 0, fileReads = 0;
    const clock = { now: () => now, monotonic: () => now, random: () => 0.5 };
    const rig = await fixture({ managedRecovery: { clock } }, (call, res) => {
      if (call.path === "/primary/v1/responses") {
        assertCredentialIsolation(call, primaryKey);
        assert.equal(call.headers["x-msh-platform"], undefined);
        if (++fallbackCalls === 1) send(res, events("responses", toolPath));
        else {
          const results = (call.body["input"] as Item[]).filter(item => item["type"] === "function_call_output");
          assert.deepEqual(results, [{ type: "function_call_output", call_id: "fake-call", output: nonce }]);
          send(res, events("responses", undefined, nonce));
        }
      } else {
        assert.equal(call.path, "/coding/v1/responses");
        assertCredentialIsolation(call, "fabricated-managed-access");
        assert.match(call.headers["user-agent"]!, /^subswitch\//);
        assert.equal(call.headers["x-msh-platform"], "subswitch");
        assert.equal(call.body["model"], "kimi-for-coding");
        const answer = kimiTextItem("recovered-message", ["recovered-kimi"]);
        res.writeHead(200, { "content-type": "text/event-stream" }).end(wire([
          created(), added(0, { ...answer, status: "in_progress", content: [] }),
          delta(answer.id, 0, "recovered-kimi"), done(0, answer), terminal([answer]),
        ]));
      }
    });
    try {
      toolPath = join(rig.directory, "recovery.txt"); nonce = randomUUID();
      await writeFile(toolPath, nonce, { mode: 0o600 });
      const credential = await rig.routing.attempts.auth.get("kimi", signal());
      const scope = rig.routing.attempts.auth.scope(credential);
      // Inject already-classified synthetic quota state, not a recording of a Kimi error.
      rig.routing.quota.fail({ kind: "quota", evidence: "unknown", scope, windows: [],
        bodyTruncated: false, responseCommitted: false });
      assert.equal(rig.routing.quota.readiness(scope), "exhausted");
      const a = await rig.action("claude-code"), body = initial("claude-code");
      const first = await rig.request("claude-code", a.ingressPrefix, body);
      assert.equal(first.status, 200);
      const reply = await first.json() as Item;
      const tools = (reply["content"] as Item[]).filter(item => item["type"] === "tool_use");
      assert.deepEqual(tools, [{ type: "tool_use", id: "fake-call", name: "Read", input: { path: toolPath } }]);
      const contextA = rig.routing.actions.context(a.id, "claude-code");
      const ownerA = rig.routing.actions.affinity(contextA, "offline").selectedOwner;
      assert.ok(ownerA);
      assert.equal(rig.routing.actions.affinity(contextA, "offline").selectedTarget?.profile, "primary");
      assert.equal(rig.routing.quota.readiness(scope), "exhausted");

      // The test owns the pending tool result; no native client is paused or launched.
      now += 61000;
      assert.equal(rig.routing.quota.readiness(scope), "eligible-for-retry");
      const b = await rig.action("claude-code"); assert.notEqual(b.id, a.id);
      const recovered = await rig.request("claude-code", b.ingressPrefix, body);
      const recoveredBody = await recovered.json() as Item;
      assert.equal(recovered.status, 200, JSON.stringify(recoveredBody));
      assert.deepEqual(recoveredBody["content"], [{ type: "text", text: "recovered-kimi" }]);
      const contextB = rig.routing.actions.context(b.id, "claude-code");
      assert.equal(rig.routing.actions.affinity(contextB, "offline").selectedTarget?.profile, "kimi");
      assert.notEqual(rig.routing.actions.affinity(contextB, "offline").selectedOwner, ownerA);
      assert.equal(rig.routing.quota.readiness(scope), "available");
      await rig.complete(b.id);

      const value = await readFile(toolPath, "utf8"); fileReads++;
      const last = await rig.request("claude-code", a.ingressPrefix, resumed("claude-code", body, reply, value));
      assert.equal(last.status, 200);
      assert.deepEqual((await last.json() as Item)["content"], [{ type: "text", text: nonce }]);
      assert.equal(rig.routing.actions.affinity(contextA, "offline").selectedOwner, ownerA);
      assert.equal(rig.routing.actions.affinity(contextA, "offline").selectedTarget?.profile, "primary");
      assert.deepEqual(rig.calls.map(call => call.path), ["/primary/v1/responses", "/coding/v1/responses", "/primary/v1/responses"]);
      assert.equal(fileReads, 1); assert.equal(fallbackCalls, 2);
      await rig.complete(a.id);
      assert.throws(() => rig.routing.actions.context(a.id, "claude-code"));
      assert.throws(() => rig.routing.actions.context(b.id, "claude-code"));
    } finally { await rig.close(); }
  });

  for (const { status, code } of [
    { status: 401, code: "authentication_error" },
    { status: 403, code: "unrecognized_business_error" },
    { status: 429, code: "usage_limit_reached" },
  ]) {
    it(`does not treat a primary HTTP ${status} ${code} failure as permission to use Kimi`, async () => {
      const rig = await fixture({ fallback: true }, (_call, res) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code } }));
      });
      try {
        const action = await rig.action("codex");
        const response = await rig.request("codex", action.ingressPrefix, initial("codex"));
        assert.ok(response.status >= 400);
        await response.text();
        assert.equal(rig.calls.length, 1);
        assert.ok(rig.calls[0]!.path.startsWith("/primary/"));
      } finally { await rig.close(); }
    });
  }

  it("does not follow a credential-bearing Kimi redirect to a second loopback origin", async () => {
    let redirected = 0;
    const trap = http.createServer((_req, res) => { redirected++; res.end("unexpected redirect"); });
    const target = await listen(trap);
    let rig: Awaited<ReturnType<typeof fixture>> | undefined;
    try {
      rig = await fixture({}, (_call, res) => res.writeHead(307, { location: target }).end());
      const action = await rig.action("codex");
      const response = await rig.request("codex", action.ingressPrefix, initial("codex"));
      assert.ok(response.status >= 400);
      await response.text();
      assert.equal(rig.calls.length, 1);
      assert.equal(redirected, 0);
    } finally { await rig?.close(); await close(trap); }
  });

  it("does not switch to Kimi after a primary response has committed", async () => {
    const rig = await fixture({ fallback: true }, (_call, res) => send(res, [
      { type: "response.created", response: { id: "fake-response", status: "in_progress", output: [] } },
      { type: "error", error: { code: "insufficient_quota", status: 429 } },
    ]));
    try {
      const action = await rig.action("codex");
      const response = await rig.request("codex", action.ingressPrefix, { ...initial("codex"), stream: true });
      assert.equal(response.status, 200);
      const output = await response.text();
      assert.match(output, /response.created/);
      assert.match(output, /response.failed/);
      assert.equal(rig.calls.length, 1);
      assert.ok(rig.calls[0]!.path.startsWith("/primary/"));
    } finally { await rig.close(); }
  });

  it("cancels an unfinished Kimi upstream when the isolated HTTP client disconnects", async () => {
    let ended!: () => void;
    const disconnected = new Promise<void>((resolve) => { ended = resolve; });
    const rig = await fixture({}, (_call, res) => {
      res.once("close", ended);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"type":"response.created","response":{"id":"fake-response","status":"in_progress","output":[]}}\n\n');
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const action = await rig.action("codex");
      const response = await rig.request("codex", action.ingressPrefix, { ...initial("codex"), stream: true });
      const reader = response.body!.getReader();
      assert.match(Buffer.from((await reader.read()).value!).toString(), /response.created/);
      await reader.cancel();
      await Promise.race([
        disconnected,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("client cancellation did not close fake Kimi within 2s")), 2000);
        }),
      ]);
      assert.equal(rig.calls.length, 1);
    } finally { clearTimeout(timer); await rig.close(); }
  });
});
