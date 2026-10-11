/** Synthetic native passthrough regressions with unrelated explicit routes configured. */
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { describe, it } from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { CodexGateway } from "../../src/codex-gateway.js";
import { loadConfig } from "../../src/config.js";
import { noopLogger } from "../../src/logger.js";
import { SharedRouting } from "../../src/routing/shared-routing.js";
import type {
  ProviderAuth,
  ProviderCredential,
} from "../../src/provider-auth.js";
import type { Result } from "../../src/result.js";
import type { ProxyError } from "../../src/errors.js";

const credential = (
  token: string,
): Result<ProviderCredential<"codex">, ProxyError> => ({
  ok: true,
  value: {
    provider: "codex",
    authHeaders: {
      authorization: `Bearer ${token}`,
      "chatgpt-account-id": "synthetic-account",
    },
  },
});
async function listen(server: http.Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("missing_fixture_address");
  return `http://127.0.0.1:${address.port}`;
}
async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, "synthetic WS fixture timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
async function fixture(
  auth: ProviderAuth<"codex">,
  rejectEvery = false,
  status = 401,
  retryAfter?: string,
  bridge: "local" | "legacy" = "local",
) {
  const upstream = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  const headers: http.IncomingHttpHeaders[] = [];
  const requests: Record<string, unknown>[] = [];
  upstream.on("upgrade", (req, socket, head) => {
    headers.push(req.headers);
    if (rejectEvery || req.headers.authorization === "Bearer synthetic-stale") {
      socket.end(
        `HTTP/1.1 ${status} Fixture Rejection\r\n${retryAfter ? `Retry-After: ${retryAfter}\r\n` : ""}Content-Length: 0\r\nConnection: close\r\n\r\n`,
      );
      return;
    }
    wss.handleUpgrade(req, socket, head, (client) =>
      client.on("message", (data) => {
        requests.push(JSON.parse(data.toString()));
        client.send(
          JSON.stringify({
            type: "response.completed",
            response: { id: "resp_native", status: "completed", output: [] },
          }),
        );
      }),
    );
  });
  const base = await listen(upstream);
  const loaded = loadConfig({
    configPath: "/synthetic/config.json",
    env: {},
    readFile: () =>
      JSON.stringify({
        configVersion: 2,
        codexIngress: {
          enabled: true,
          subscriptionBaseUrl: base,
          claude: { enabled: bridge === "legacy" },
        },
        accessProfiles: {
          kimi: {
            provider: "kimi",
            product: "kimi-code",
            region: "global",
            billing: "subscription",
            account: "synthetic",
            credential: { kind: "env", name: "SYNTHETIC_KIMI_KEY" },
          },
        },
        routes:
          bridge === "local"
            ? {
                unrelated: {
                  clients: ["codex"],
                  primary: { profile: "kimi", model: "k3", effort: "high" },
                },
              }
            : {},
      }),
  });
  if (!loaded.ok) throw new Error(loaded.error.message);
  const sharedRouting = new SharedRouting(
    loaded.value.config,
    noopLogger,
    undefined,
    async () => {
      throw new Error("unexpected routed inference");
    },
    {},
  );
  const gateway = new CodexGateway({
    config: loaded.value.config,
    logger: noopLogger,
    parentAuth: auth,
    sharedRouting,
    resolveClaude: () => undefined,
    claudeAuth: {
      getCredentials: async () => ({
        ok: false,
        error: { kind: "auth", message: "unexpected Claude access" },
      }),
      forceRefresh: async () => ({
        ok: false,
        error: { kind: "auth", message: "unexpected Claude access" },
      }),
    },
  });
  const relay = http.createServer();
  let disconnected!: () => void;
  const inboundClosed = new Promise<void>((resolve) => {
    disconnected = resolve;
  });
  relay.on("upgrade", (req, socket, head) => {
    socket.once("close", disconnected);
    gateway.upgrade(req, socket, head, "subscription", "/responses");
  });
  const local = await listen(relay);
  const client = new WebSocket(
    local.replace("http:", "ws:"),
    ["synthetic-native-protocol"],
    {
      headers: { "chatgpt-account-id": "synthetic-account" },
    },
  );
  client.on("error", () => undefined);
  const events: Record<string, unknown>[] = [];
  client.on("message", (data) => events.push(JSON.parse(data.toString())));
  await once(client, "open");
  return {
    client,
    events,
    headers,
    requests,
    gateway,
    sharedRouting,
    inboundClosed,
    async close() {
      client.terminate();
      gateway.close();
      sharedRouting.close();
      for (const socket of wss.clients) socket.terminate();
      wss.close();
      await Promise.all(
        [relay, upstream].map(
          (server) =>
            new Promise<void>((resolve) => server.close(() => resolve())),
        ),
      );
    },
  };
}

describe("Wave 1 unmatched native WS reliability", () => {
  it("keeps disabled legacy Claude routing native when unrelated explicit routes are configured", async () => {
    const rig = await fixture({
      refreshable: true,
      getCredentials: async () => credential("synthetic-fresh"),
      forceRefresh: async () => credential("synthetic-fresh"),
    });
    try {
      rig.client.send(
        JSON.stringify({
          type: "response.create",
          model: "claude-sonnet-5",
          input: "synthetic",
        }),
      );
      await until(() =>
        rig.events.some((event) => event["type"] === "response.completed"),
      );
      assert.equal(rig.requests[0]?.["model"], "claude-sonnet-5");
      assert.equal(rig.headers.length, 1);
    } finally {
      await rig.close();
    }
  });

  for (const bridge of ["local", "legacy"] as const) {
    it(`reports lost local continuation state without crashing the ${bridge} bridge`, async () => {
      const rig = await fixture(
        {
          refreshable: true,
          getCredentials: async () => credential("synthetic-fresh"),
          forceRefresh: async () => credential("synthetic-fresh"),
        },
        false,
        401,
        undefined,
        bridge,
      );
      const lost = "resp_subswitch_route_synthetic-lost-handle";
      try {
        rig.client.send(
          JSON.stringify({
            type: "response.create",
            previous_response_id: lost,
            input: "synthetic",
            stream_id: "invalid",
          }),
        );
        await until(() =>
          rig.events.some((event) => event["type"] === "error"),
        );
        const error = rig.events.find((event) => event["type"] === "error")!;
        assert.equal(error["status"], 409);
        assert.equal(error["code"], "continuation_state_lost");
        assert.equal(error["stream_id"], "invalid");
        assert.ok(!JSON.stringify(error).includes(lost));
        assert.equal(rig.client.readyState, WebSocket.OPEN);
        rig.client.send(
          JSON.stringify({
            type: "response.create",
            model: "native-unmatched",
            input: "synthetic",
          }),
        );
        await until(() =>
          rig.events.some((event) => event["type"] === "response.completed"),
        );
        assert.equal(
          rig.headers.length,
          1,
          "the invalid request must not open an additional native destination",
        );
      } finally {
        await rig.close();
      }
    });
  }

  it("reports a local continuation model mismatch and keeps the socket usable", async () => {
    const rig = await fixture({
      refreshable: true,
      getCredentials: async () => credential("synthetic-fresh"),
      forceRefresh: async () => credential("synthetic-fresh"),
    });
    const id = rig.sharedRouting.continuations.put({
      conversation: "synthetic",
      route: "unrelated",
      request: { model: "unrelated", input: [] },
      output: [],
      owner: "warmup",
      protocol: "responses",
      scope: "single-target",
    });
    try {
      rig.client.send(
        JSON.stringify({
          type: "response.create",
          previous_response_id: id,
          model: "synthetic-wrong-model",
          input: "synthetic",
          stream_id: "invalid",
        }),
      );
      await until(() => rig.events.some((event) => event["type"] === "error"));
      const error = rig.events.find((event) => event["type"] === "error")!;
      assert.equal(error["status"], 409);
      assert.equal(error["code"], "continuation_model_mismatch");
      assert.equal(error["stream_id"], "invalid");
      assert.ok(!JSON.stringify(error).includes(id));
      assert.equal(rig.headers.length, 0);
      assert.equal(rig.client.readyState, WebSocket.OPEN);
      rig.client.send(
        JSON.stringify({
          type: "response.create",
          model: "native-unmatched",
          input: "synthetic",
        }),
      );
      await until(() =>
        rig.events.some((event) => event["type"] === "response.completed"),
      );
      assert.equal(rig.headers.length, 1);
    } finally {
      await rig.close();
    }
  });

  it("refreshes a rejected native subscription upgrade once and preserves native protocols", async () => {
    let refreshes = 0;
    const rig = await fixture({
      refreshable: true,
      getCredentials: async () => credential("synthetic-stale"),
      forceRefresh: async () => {
        refreshes++;
        return credential("synthetic-fresh");
      },
    });
    try {
      rig.client.send(
        JSON.stringify({
          type: "response.create",
          model: "native-unmatched",
          input: "synthetic",
          stream_id: "native",
        }),
      );
      await until(() =>
        rig.events.some((event) => event["type"] === "response.completed"),
      );
      assert.equal(refreshes, 1);
      assert.deepEqual(
        rig.headers.map((headers) => headers.authorization),
        ["Bearer synthetic-stale", "Bearer synthetic-fresh"],
      );
      assert.deepEqual(
        rig.headers.map((headers) => headers["sec-websocket-protocol"]),
        ["synthetic-native-protocol", "synthetic-native-protocol"],
      );
    } finally {
      await rig.close();
    }
  });

  it("stops at one refresh for persistent native authentication rejection", async () => {
    let refreshes = 0;
    const rig = await fixture(
      {
        refreshable: true,
        getCredentials: async () => credential("synthetic-stale"),
        forceRefresh: async () => {
          refreshes++;
          return credential("synthetic-fresh");
        },
      },
      true,
    );
    try {
      rig.client.send(
        JSON.stringify({
          type: "response.create",
          model: "native-unmatched",
          stream_id: "native",
          input: "synthetic",
        }),
      );
      await until(() => rig.events.some((event) => event["type"] === "error"));
      assert.equal(refreshes, 1);
      assert.equal(rig.headers.length, 2);
      const error = rig.events.find((event) => event["type"] === "error")!;
      assert.equal(error["status"], 401);
      assert.equal(error["stream_id"], "native");
      assert.equal(error["code"], "openai_websocket_rejected");
    } finally {
      await rig.close();
    }
  });

  for (const retryAfter of ["19", "untrusted-fixture"] as const) {
    it(`preserves native rejection status and validates Retry-After (${retryAfter})`, async () => {
      let refreshes = 0;
      const rig = await fixture(
        {
          refreshable: true,
          getCredentials: async () => credential("synthetic-fresh"),
          forceRefresh: async () => {
            refreshes++;
            return credential("synthetic-fresh");
          },
        },
        true,
        429,
        retryAfter,
      );
      try {
        rig.client.send(
          JSON.stringify({
            type: "response.create",
            model: "native-unmatched",
            input: "synthetic",
            stream_id: "native",
          }),
        );
        await until(() =>
          rig.events.some((event) => event["type"] === "error"),
        );
        const error = rig.events.find((event) => event["type"] === "error")!;
        assert.equal(error["status"], 429);
        assert.equal(error["stream_id"], "native");
        assert.equal(
          error["retry_after"],
          retryAfter === "19" ? "19" : undefined,
        );
        assert.equal(refreshes, 0);
        assert.equal(rig.headers.length, 1);
      } finally {
        await rig.close();
      }
    });
  }

  for (const stop of ["client-close", "relay-shutdown"] as const) {
    it(`does not open a native destination after ${stop} during credential resolution`, async () => {
      let release!: (
        value: Result<ProviderCredential<"codex">, ProxyError>,
      ) => void;
      let started = false;
      const pending = new Promise<
        Result<ProviderCredential<"codex">, ProxyError>
      >((resolve) => {
        release = resolve;
      });
      const rig = await fixture({
        refreshable: true,
        getCredentials: () => {
          started = true;
          return pending;
        },
        forceRefresh: () => pending,
      });
      try {
        rig.client.send(
          JSON.stringify({
            type: "response.create",
            model: "native-unmatched",
            input: "synthetic",
          }),
        );
        await until(() => started);
        const closed = once(rig.client, "close");
        if (stop === "client-close") rig.client.terminate();
        else rig.gateway.close();
        await closed;
        await rig.inboundClosed;
        release(credential("synthetic-fresh"));
        await new Promise((resolve) => setTimeout(resolve, 25));
        assert.equal(rig.headers.length, 0);
      } finally {
        release(credential("synthetic-fresh"));
        await rig.close();
      }
    });
  }

  it("does not retry a rejected native upgrade after shutdown during refresh", async () => {
    let release!: (
      value: Result<ProviderCredential<"codex">, ProxyError>,
    ) => void;
    let refreshing = false;
    const pending = new Promise<
      Result<ProviderCredential<"codex">, ProxyError>
    >((resolve) => {
      release = resolve;
    });
    const rig = await fixture({
      refreshable: true,
      getCredentials: async () => credential("synthetic-stale"),
      forceRefresh: () => {
        refreshing = true;
        return pending;
      },
    });
    try {
      rig.client.send(
        JSON.stringify({
          type: "response.create",
          model: "native-unmatched",
          input: "synthetic",
        }),
      );
      await until(() => refreshing);
      const closed = once(rig.client, "close");
      rig.gateway.close();
      await closed;
      release(credential("synthetic-fresh"));
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(rig.headers.length, 1);
    } finally {
      release(credential("synthetic-fresh"));
      await rig.close();
    }
  });
});
