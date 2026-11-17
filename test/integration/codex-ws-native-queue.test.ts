/** Synthetic native WebSocket regressions. No live provider access. */
import assert from "node:assert/strict";
import http from "node:http";
import type { Duplex } from "node:stream";
import { once } from "node:events";
import { describe, it } from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { CodexGateway } from "../../src/codex-gateway.js";
import { loadConfig } from "../../src/config.js";
import { noopLogger } from "../../src/logger.js";
import { SharedRouting } from "../../src/routing/shared-routing.js";

type Event = Record<string, unknown>;

async function listen(server: http.Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

async function waitUntil(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400 && !condition(); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

/** Write complete, unmasked server frames in one TCP write, without ws batching assumptions. */
function textFrame(event: Event): Buffer {
  const payload = Buffer.from(JSON.stringify(event));
  assert.ok(payload.length < 126, "fixture requires small frames");
  return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
}

async function fixture(onRequest?: (socket: WebSocket, body: Event) => void, scoped = true) {
  const upstream = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  let transport: Duplex | undefined;
  const requests: Event[] = [];
  upstream.on("upgrade", (req, socket, head) => {
    transport = socket;
    wss.handleUpgrade(req, socket, head, peer => {
      peer.on("message", data => {
        const body = JSON.parse(data.toString()) as Event;
        requests.push(body);
        onRequest?.(peer, body);
      });
    });
  });
  const base = await listen(upstream);
  const loaded = loadConfig({
    configPath: "/synthetic/config.json",
    env: {},
    readFile: () => JSON.stringify({
      configVersion: 2,
      codexIngress: { enabled: true, subscriptionBaseUrl: base },
      accessProfiles: {
        kimi: {
          provider: "kimi", product: "kimi-code", region: "global", billing: "subscription",
          account: "synthetic", credential: { kind: "env", name: "SYNTHETIC_KIMI_KEY" },
        },
      },
      routes: { unrelated: { clients: ["codex"], primary: { profile: "kimi", model: "k3", effort: "high" } } },
    }),
  });
  assert.ok(loaded.ok);
  const routing = new SharedRouting(loaded.value.config, noopLogger, undefined, async () => {
    throw new Error("unexpected routed inference");
  }, {});
  const gateway = new CodexGateway({
    config: loaded.value.config,
    logger: noopLogger,
    sharedRouting: routing,
    resolveClaude: () => undefined,
    parentAuth: {
      refreshable: false,
      getCredentials: async () => ({ ok: true, value: { provider: "codex", authHeaders: { authorization: "Bearer synthetic" } } }),
      forceRefresh: async () => { throw new Error("unexpected refresh"); },
    },
    claudeAuth: {
      getCredentials: async () => { throw new Error("unexpected Claude access"); },
      forceRefresh: async () => { throw new Error("unexpected Claude access"); },
    },
  });
  const relay = http.createServer();
  relay.on("upgrade", (req, socket, head) => {
    routing.stripPrefix(req);
    gateway.upgrade(req, socket, head, "subscription", "/responses");
  });
  const local = await listen(relay);
  const action = routing.actions.create("codex", "synthetic-native-queue");
  const client = new WebSocket(`${local.replace("http:", "ws:")}${scoped ? action.ingressPrefix : ""}/responses`);
  const events: Event[] = [];
  let closed = false;
  client.on("error", () => undefined);
  client.on("message", data => events.push(JSON.parse(data.toString()) as Event));
  client.on("close", () => { closed = true; });
  await once(client, "open");
  return {
    client, events, requests,
    create(streamId: string) {
      client.send(JSON.stringify({ type: "response.create", model: "native-unmatched", input: "synthetic", stream_id: streamId }));
    },
    writeFrames(items: Event[]) {
      assert.ok(transport, "native request must open the upstream");
      transport.write(Buffer.concat(items.map(textFrame)));
    },
    complete() { routing.actions.complete(action.id); },
    isClosed: () => closed,
    async waitEvents(count: number) { await waitUntil(() => events.length >= count || closed); },
    async close() {
      client.terminate();
      gateway.close();
      routing.close();
      for (const peer of wss.clients) peer.terminate();
      wss.close();
      await Promise.all([relay, upstream].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    },
  };
}

const terminal = (id: string): Event => ({ type: "response.completed", response: { id } });
const created = (id: string): Event => ({ type: "response.created", response: { id } });

describe("native Codex WebSocket queue and admission", () => {
  it("delivers all 64 small frames from one TCP write without a reconnect", async () => {
    const rig = await fixture(undefined, false);
    try {
      rig.create("burst");
      await waitUntil(() => rig.requests.length === 1);
      const frames: Event[] = Array.from({ length: 63 }, (_, sequence) => ({
        type: "response.output_text.delta", delta: String(sequence),
      }));
      frames.push(terminal("resp_burst"));
      rig.writeFrames(frames);
      await rig.waitEvents(64);
      assert.deepEqual(rig.events, frames, "one healthy read must preserve every frame in order");
      assert.equal(rig.client.readyState, WebSocket.OPEN);
    } finally { await rig.close(); }
  });

  it("releases a named admission when the terminal has no stream_id echo", async () => {
    const rig = await fixture((socket, body) => socket.send(JSON.stringify(terminal(`resp_${body["stream_id"]}`))));
    try {
      rig.create("reuse");
      await rig.waitEvents(1);
      rig.create("reuse");
      await rig.waitEvents(2);
      assert.deepEqual(rig.events.map(event => event["type"]), ["response.completed", "response.completed"]);
      rig.complete();
      await waitUntil(rig.isClosed);
      assert.equal(rig.isClosed(), true, "released admissions must let action completion close the idle transport");
    } finally { await rig.close(); }
  });

  it("retains concurrent admissions when a terminal has no identifiers", async () => {
    const rig = await fixture();
    try {
      rig.create("one");
      rig.create("two");
      await waitUntil(() => rig.requests.length === 2);
      rig.writeFrames([{ type: "error", error: { message: "unidentified upstream error" } }]);
      await rig.waitEvents(1);
      rig.create("one");
      await waitUntil(() => rig.events.length >= 2 || rig.requests.length > 2);
      assert.equal(rig.requests.length, 2, "an ambiguous terminal must not permit another inference for the same stream");
      assert.equal(rig.events[1]?.["type"], "error");
    } finally { await rig.close(); }
  });

  for (const unknown of [
    { ...terminal("resp_known"), stream_id: "unknown" },
    terminal("resp_unknown"),
  ]) {
    it(`retains admission for an unmatched ${unknown["stream_id"] ? "stream" : "response"} identifier`, async () => {
      const rig = await fixture((socket, body) => socket.send(JSON.stringify({
        ...created("resp_known"), stream_id: body["stream_id"],
      })));
      try {
        rig.create("known");
        await rig.waitEvents(1);
        rig.writeFrames([unknown]);
        await rig.waitEvents(2);
        rig.create("known");
        await rig.waitEvents(3);
        assert.equal(rig.events[2]?.["type"], "error", "an unrelated terminal must not release the active response");
        rig.complete();
        rig.writeFrames([terminal("resp_known")]);
        await waitUntil(rig.isClosed);
        assert.equal(rig.isClosed(), true, "the matching response ID must release admission without a stream echo");
      } finally { await rig.close(); }
    });
  }

  it("correlates streamless response IDs before out-of-order terminals", async () => {
    const rig = await fixture((socket, body) => socket.send(JSON.stringify(created(`resp_${body["stream_id"]}`))));
    try {
      rig.create("one");
      rig.create("two");
      await rig.waitEvents(2);
      rig.writeFrames([{ type: "response.completed", response_id: "resp_two" }]);
      await rig.waitEvents(3);
      rig.create("two");
      await rig.waitEvents(4);
      assert.equal(rig.events[3]?.["type"], "response.created", "only the terminal's admission must be reusable");
      rig.create("one");
      await rig.waitEvents(5);
      assert.equal(rig.events[4]?.["type"], "error", "the other response must retain admission");
      rig.complete();
      rig.writeFrames([terminal("resp_one"), terminal("resp_two")]);
      await waitUntil(rig.isClosed);
      assert.equal(rig.isClosed(), true);
    } finally { await rig.close(); }
  });
});
