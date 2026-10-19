/** Synthetic upstreams and credentials exercise scoped native admission in production wiring. */
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { describe, it } from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { loadConfig } from "../../src/config.js";
import {
  buildDeps,
  createProxyServer,
  listenServer,
} from "../../src/server.js";
import { CodexGateway } from "../../src/codex-gateway.js";
import { noopLogger } from "../../src/logger.js";
import type {
  ProviderAuth,
  ProviderCredential,
} from "../../src/provider-auth.js";
import type { Result } from "../../src/result.js";
import type { ProxyError } from "../../src/errors.js";

const credential: Result<ProviderCredential<"codex">, ProxyError> = {
  ok: true,
  value: {
    provider: "codex",
    authHeaders: {
      authorization: "Bearer synthetic-native",
      "chatgpt-account-id": "synthetic-account",
    },
  },
};
async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, "native lifecycle fixture timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
async function fixture(
  options: {
    auth?: ProviderAuth<"codex">;
    http?: (req: http.IncomingMessage, res: http.ServerResponse) => void;
    websocket?: (socket: WebSocket, body: Record<string, unknown>) => void;
    routed?: boolean;
    routedPaused?: boolean;
    legacyClaude?: boolean;
  } = {},
) {
  let authCalls = 0,
    httpCalls = 0,
    wsCalls = 0,
    wsClosed = 0,
    generating = 0,
    warmups = 0,
    uploads = 0,
    routedCalls = 0,
    legacyCalls = 0,
    legacyCancelled = 0;
  const legacyStreams: ReadableStreamDefaultController<Uint8Array>[] = [];
  const routedStreams: {
    id: string;
    controller: ReadableStreamDefaultController<Uint8Array>;
  }[] = [];
  const backend = http.createServer((req, res) => {
    httpCalls++;
    req.resume();
    if (options.http) options.http(req, res);
    else res.end('{"synthetic":true}');
  });
  const wss = new WebSocketServer({ server: backend });
  const nativeSockets: WebSocket[] = [];
  wss.on("connection", (socket) => {
    wsCalls++;
    nativeSockets.push(socket);
    socket.on("error", () => undefined);
    socket.once("close", () => wsClosed++);
    socket.on("message", (data) => {
      const body = JSON.parse(data.toString()) as Record<string, unknown>;
      if (body["generate"] === false) warmups++;
      else if (body["type"] !== "response.cancel") generating++;
      if (options.websocket) options.websocket(socket, body);
    });
  });
  backend.listen(0, "127.0.0.1");
  await once(backend, "listening");
  const address = backend.address();
  if (!address || typeof address === "string") throw new Error();
  const upstream = `http://127.0.0.1:${address.port}`;
  const loaded = loadConfig({
    configPath: "/synthetic/config.json",
    env: {},
    readFile: () =>
      JSON.stringify({
        configVersion: 2,
        anthropic: { baseUrl: upstream, connectTimeoutMs: 20 },
        codexIngress: {
          enabled: true,
          apiBaseUrl: upstream,
          subscriptionBaseUrl: upstream,
          connectTimeoutMs: 20,
          ...(options.legacyClaude
            ? { claude: { enabled: true, baseUrl: upstream } }
            : {}),
        },
        ...(options.routed
          ? {
              accessProfiles: {
                code: {
                  provider: "kimi",
                  product: "kimi-code",
                  region: "global",
                  billing: "subscription",
                  account: "synthetic",
                  credential: { kind: "env", name: "SYNTHETIC_CODE_KEY" },
                },
              },
              routes: {
                work: {
                  clients: ["codex"],
                  primary: { profile: "code", model: "k3", effort: "high" },
                },
              },
            }
          : {}),
      }),
  });
  if (!loaded.ok) throw new Error(loaded.error.message);
  const built = buildDeps(
    loaded.value.config,
    noopLogger,
    options.routed
      ? {
          env: { SYNTHETIC_CODE_KEY: "synthetic-key" },
          fetchImpl: async () => {
            routedCalls++;
            if (options.routedPaused) {
              const id = `synthetic_${routedCalls}`;
              return new Response(
                new ReadableStream<Uint8Array>({
                  start(controller) {
                    routedStreams.push({ id, controller });
                    controller.enqueue(
                      Buffer.from(
                        `data: ${JSON.stringify({ type: "response.created", response: { id, status: "in_progress", output: [] } })}\n\n`,
                      ),
                    );
                  },
                }),
                { headers: { "content-type": "text/event-stream" } },
              );
            }
            return new Response(
              [
                {
                  type: "response.created",
                  response: {
                    id: "synthetic",
                    status: "in_progress",
                    output: [],
                  },
                },
                {
                  type: "response.completed",
                  response: {
                    id: "synthetic",
                    status: "completed",
                    output: [],
                  },
                },
              ]
                .map((event) => `data: ${JSON.stringify(event)}\n\n`)
                .join(""),
              { headers: { "content-type": "text/event-stream" } },
            );
          },
        }
      : {},
  );
  if (!built.ok) throw new Error(built.error);
  built.value.forwardOpenai?.close();
  const auth = options.auth ?? {
    refreshable: true,
    getCredentials: async () => credential,
    forceRefresh: async () => credential,
  };
  const gateway = new CodexGateway({
    config: loaded.value.config,
    logger: noopLogger,
    sharedRouting: built.value.sharedRouting!,
    parentAuth: {
      ...auth,
      getCredentials: () => {
        authCalls++;
        return auth.getCredentials();
      },
      forceRefresh: () => {
        authCalls++;
        return auth.forceRefresh();
      },
    },
    resolveClaude: (name) =>
      options.legacyClaude && name === "claude-sonnet-5" ? name : undefined,
    ...(options.legacyClaude
      ? {
          fetchImpl: async () => {
            legacyCalls++;
            return new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  legacyStreams.push(controller);
                  controller.enqueue(
                    Buffer.from(
                      `data: ${JSON.stringify({
                        type: "message_start",
                        message: {
                          id: `msg_legacy_${legacyCalls}`,
                          type: "message",
                          role: "assistant",
                          content: [],
                          usage: { input_tokens: 1, output_tokens: 0 },
                        },
                      })}\n\n`,
                    ),
                  );
                },
                cancel() {
                  legacyCancelled++;
                },
              }),
              { headers: { "content-type": "text/event-stream" } },
            );
          },
        }
      : {}),
    claudeAuth: {
      getCredentials: async () =>
        options.legacyClaude
          ? {
              ok: true,
              value: {
                provider: "claude",
                authHeaders: { authorization: "Bearer synthetic-claude" },
              },
            }
          : {
              ok: false,
              error: { kind: "auth", message: "unexpected Claude auth" },
            },
      forceRefresh: async () => ({
        ok: false,
        error: { kind: "auth", message: "unexpected Claude refresh" },
      }),
    },
  });
  const proxy = createProxyServer({ ...built.value, forwardOpenai: gateway });
  proxy.on("request", (req) => {
    if (req.headers["x-synthetic-paused-upload"] === "yes")
      req.once("data", () => {
        uploads++;
      });
  });
  await listenServer(proxy, 0, "127.0.0.1");
  const local = proxy.address();
  if (!local || typeof local === "string") throw new Error();
  const base = `http://127.0.0.1:${local.port}`,
    routing = built.value.sharedRouting!;
  const control = async (path: string, body: unknown = {}) =>
    fetch(`${base}/__subswitch/actions${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-subswitch-capability": routing.actions.capability,
      },
      body: JSON.stringify(body),
    });
  const action = async (client: "codex" | "claude-code" = "codex") => {
    const response = await control("", { client, conversationId: "synthetic" });
    assert.equal(response.status, 201);
    return (await response.json()) as { id: string; ingressPrefix: string };
  };
  const clients = new Set<WebSocket>();
  const connect = async (prefix: string) => {
    const socket = new WebSocket(
      `${base.replace("http:", "ws:")}${prefix}/codex/backend-api/codex/responses`,
      {
        headers: { "chatgpt-account-id": "synthetic-account" },
      },
    );
    clients.add(socket);
    socket.on("error", () => undefined);
    const events: Record<string, unknown>[] = [];
    socket.on("message", (data) => events.push(JSON.parse(data.toString())));
    await once(socket, "open");
    return { socket, events };
  };
  return {
    base,
    action,
    control,
    connect,
    routing,
    nativeSockets,
    get authCalls() {
      return authCalls;
    },
    get httpCalls() {
      return httpCalls;
    },
    get wsCalls() {
      return wsCalls;
    },
    get wsClosed() {
      return wsClosed;
    },
    get generating() {
      return generating;
    },
    get warmups() {
      return warmups;
    },
    get uploads() {
      return uploads;
    },
    get routedCalls() {
      return routedCalls;
    },
    get legacyCalls() {
      return legacyCalls;
    },
    get legacyCancelled() {
      return legacyCancelled;
    },
    legacyStreams,
    routedStreams,
    async close() {
      for (const socket of clients) socket.terminate();
      routing.close();
      gateway.close();
      proxy.closeAllConnections();
      for (const socket of wss.clients) socket.terminate();
      wss.close();
      backend.closeAllConnections();
      await Promise.all(
        [proxy, backend].map(
          (server) =>
            new Promise<void>((resolve) => server.close(() => resolve())),
        ),
      );
    },
  };
}
const post = (
  rig: Awaited<ReturnType<typeof fixture>>,
  prefix: string,
  client: "codex" | "claude-code" = "codex",
) =>
  fetch(
    `${rig.base}${prefix}${client === "codex" ? "/codex/backend-api/codex/responses" : "/v1/messages"}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "chatgpt-account-id": "synthetic-account",
      },
      body: JSON.stringify(
        client === "codex"
          ? { model: "native-unmatched", input: "synthetic" }
          : {
              model: "claude-sonnet-5",
              messages: [{ role: "user", content: "synthetic" }],
            },
      ),
    },
  );
const completed = {
  type: "response.completed",
  response: { id: "resp_native", status: "completed", output: [] },
};

describe("Wave 1 native action lifecycle", () => {
  for (const client of ["codex", "claude-code"] as const) {
    for (const operation of ["complete", "cancel"] as const) {
      it(`rejects ${client} native HTTP on a ${operation}d prefix before authentication or inference`, async () => {
        const rig = await fixture();
        try {
          const action = await rig.action(client);
          assert.equal(
            (await rig.control(`/${action.id}/${operation}`)).status,
            200,
          );
          const response = await post(rig, action.ingressPrefix, client);
          assert.equal(response.status, 409);
          await response.body?.cancel();
          assert.equal(rig.authCalls, 0);
          assert.equal(rig.httpCalls, 0);
        } finally {
          await rig.close();
        }
      });
    }
    it(`cancels active ${client} native HTTP IO`, async () => {
      let upstreamClosed = false;
      const rig = await fixture({
        http: (_req, res) => {
          res.once("close", () => {
            upstreamClosed = true;
          });
          res.writeHead(200);
          res.write("first");
        },
      });
      try {
        const action = await rig.action(client),
          response = await post(rig, action.ingressPrefix, client),
          reader = response.body!.getReader();
        assert.equal(
          Buffer.from((await reader.read()).value!).toString(),
          "first",
        );
        assert.equal((await rig.control(`/${action.id}/cancel`)).status, 200);
        await assert.rejects(reader.read());
        await until(() => upstreamClosed);
      } finally {
        await rig.close();
      }
    });
    it(`closes ${client} native HTTP admission while draining its already admitted response`, async () => {
      let upstream: http.ServerResponse | undefined;
      const rig = await fixture({
        http: (_req, res) => {
          upstream = res;
          res.writeHead(200);
          res.write("first");
        },
      });
      try {
        const action = await rig.action(client),
          response = await post(rig, action.ingressPrefix, client),
          reader = response.body!.getReader();
        await reader.read();
        assert.equal((await rig.control(`/${action.id}/complete`)).status, 200);
        const rejected = await post(rig, action.ingressPrefix, client);
        assert.equal(rejected.status, 409);
        await rejected.body?.cancel();
        assert.equal(rig.httpCalls, 1);
        await new Promise((resolve) => setTimeout(resolve, 40));
        upstream!.end("last");
        assert.equal(
          Buffer.from((await reader.read()).value!).toString(),
          "last",
        );
        assert.equal((await reader.read()).done, true);
      } finally {
        await rig.close();
      }
    });
  }

  it("cancels native HTTP credential waiting without opening upstream IO afterwards", async () => {
    let release!: (
      value: Result<ProviderCredential<"codex">, ProxyError>,
    ) => void;
    const pending = new Promise<
      Result<ProviderCredential<"codex">, ProxyError>
    >((resolve) => {
      release = resolve;
    });
    const rig = await fixture({
      auth: {
        refreshable: true,
        getCredentials: () => pending,
        forceRefresh: () => pending,
      },
    });
    try {
      const action = await rig.action(),
        request = post(rig, action.ingressPrefix);
      const rejected = assert.rejects(request);
      await until(() => rig.authCalls === 1);
      assert.equal((await rig.control(`/${action.id}/cancel`)).status, 200);
      await rejected;
      release(credential);
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(rig.httpCalls, 0);
    } finally {
      release(credential);
      await rig.close();
    }
  });

  it("lets an already admitted translated upload finish after completion closes admission", async () => {
    const rig = await fixture({ routed: true });
    let request: http.ClientRequest | undefined;
    try {
      const action = await rig.action(),
        body = JSON.stringify({
          model: "work",
          input: "synthetic",
          stream: false,
        });
      const received = new Promise<{
        status: number | undefined;
        body: string;
      }>((resolve, reject) => {
        request = http.request(
          `${rig.base}${action.ingressPrefix}/codex/v1/responses`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "content-length": String(Buffer.byteLength(body)),
              "x-synthetic-paused-upload": "yes",
            },
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk) => chunks.push(chunk));
            response.once("end", () =>
              resolve({
                status: response.statusCode,
                body: Buffer.concat(chunks).toString(),
              }),
            );
            response.once("error", reject);
          },
        );
        request.once("error", reject);
        request.write(body.slice(0, 10));
      });
      await until(() => rig.uploads === 1);
      assert.equal((await rig.control(`/${action.id}/complete`)).status, 200);
      const late = await post(rig, action.ingressPrefix);
      assert.equal(late.status, 409);
      await late.body?.cancel();
      request!.end(body.slice(10));
      const response = await received;
      assert.equal(response.status, 200);
      assert.equal(JSON.parse(response.body).status, "completed");
      assert.equal(rig.routedCalls, 1);
      assert.equal(rig.httpCalls, 0);
    } finally {
      request?.destroy();
      await rig.close();
    }
  });

  it("closes an idle scoped WebSocket on completion without native auth or inference", async () => {
    const rig = await fixture();
    try {
      const action = await rig.action(),
        { socket } = await rig.connect(action.ingressPrefix),
        closed = once(socket, "close");
      assert.equal((await rig.control(`/${action.id}/complete`)).status, 200);
      await closed;
      assert.equal(rig.authCalls, 0);
      assert.equal(rig.wsCalls, 0);
      const old = new WebSocket(
        `${rig.base.replace("http:", "ws:")}${action.ingressPrefix}/codex/backend-api/codex/responses`,
        { headers: { "chatgpt-account-id": "synthetic-account" } },
      );
      old.on("error", () => undefined);
      const response = await new Promise<http.IncomingMessage>((resolve) =>
        old.once("unexpected-response", (_request, response) => {
          response.resume();
          resolve(response);
        }),
      );
      assert.equal(response.statusCode, 409);
      old.terminate();
      assert.equal(rig.authCalls, 0);
    } finally {
      await rig.close();
    }
  });

  it("cancels native WS credential waiting before any upstream transport opens", async () => {
    let release!: (
      value: Result<ProviderCredential<"codex">, ProxyError>,
    ) => void;
    const pending = new Promise<
      Result<ProviderCredential<"codex">, ProxyError>
    >((resolve) => {
      release = resolve;
    });
    const rig = await fixture({
      auth: {
        refreshable: true,
        getCredentials: () => pending,
        forceRefresh: () => pending,
      },
    });
    try {
      const action = await rig.action(),
        { socket } = await rig.connect(action.ingressPrefix);
      socket.send(
        JSON.stringify({
          type: "response.create",
          model: "native-unmatched",
          input: "synthetic",
        }),
      );
      await until(() => rig.authCalls === 1);
      const closed = once(socket, "close");
      assert.equal((await rig.control(`/${action.id}/cancel`)).status, 200);
      await closed;
      release(credential);
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(rig.wsCalls, 0);
    } finally {
      release(credential);
      await rig.close();
    }
  });

  it("lets admitted native WS authentication finish while completion drains the invocation", async () => {
    let release!: (
      value: Result<ProviderCredential<"codex">, ProxyError>,
    ) => void;
    const pending = new Promise<
      Result<ProviderCredential<"codex">, ProxyError>
    >((resolve) => {
      release = resolve;
    });
    const rig = await fixture({
      auth: {
        refreshable: true,
        getCredentials: () => pending,
        forceRefresh: () => pending,
      },
      websocket: (socket) => socket.send(JSON.stringify(completed)),
    });
    try {
      const action = await rig.action(),
        { socket, events } = await rig.connect(action.ingressPrefix);
      socket.send(
        JSON.stringify({
          type: "response.create",
          model: "native-unmatched",
          input: "synthetic",
          stream_id: "",
        }),
      );
      await until(() => rig.authCalls === 1);
      assert.equal((await rig.control(`/${action.id}/complete`)).status, 200);
      assert.equal(socket.readyState, WebSocket.OPEN);
      const closed = once(socket, "close");
      release(credential);
      await closed;
      assert.equal(rig.generating, 1);
      assert.ok(events.some((event) => event["type"] === "response.completed"));
    } finally {
      release(credential);
      await rig.close();
    }
  });

  it("drains an admitted native WS response, rejects new admission, then closes its transport", async () => {
    const rig = await fixture({
      websocket: (socket) =>
        socket.send(
          JSON.stringify({
            type: "response.created",
            response: { id: "resp_native", status: "in_progress", output: [] },
          }),
        ),
    });
    try {
      const action = await rig.action(),
        { socket, events } = await rig.connect(action.ingressPrefix);
      socket.send(
        JSON.stringify({
          type: "response.create",
          model: "native-unmatched",
          input: "synthetic",
        }),
      );
      await until(() =>
        events.some((event) => event["type"] === "response.created"),
      );
      assert.equal((await rig.control(`/${action.id}/complete`)).status, 200);
      assert.equal(socket.readyState, WebSocket.OPEN);
      socket.send(
        JSON.stringify({
          type: "response.create",
          model: "native-unmatched",
          stream_id: "late",
          input: "synthetic",
        }),
      );
      await until(() =>
        events.some(
          (event) => event["type"] === "error" && event["stream_id"] === "late",
        ),
      );
      assert.equal(rig.generating, 1);
      const closed = once(socket, "close");
      rig.nativeSockets[0]!.send(JSON.stringify(completed));
      await closed;
      assert.ok(events.some((event) => event["type"] === "response.completed"));
      await until(() => rig.wsClosed === 1);
    } finally {
      await rig.close();
    }
  });

  it("cancels an active native WS request and its transport", async () => {
    const rig = await fixture({
      websocket: (socket) =>
        socket.send(
          JSON.stringify({
            type: "response.created",
            response: { id: "resp_native", status: "in_progress", output: [] },
          }),
        ),
    });
    try {
      const action = await rig.action(),
        { socket, events } = await rig.connect(action.ingressPrefix);
      socket.send(
        JSON.stringify({
          type: "response.create",
          model: "native-unmatched",
          input: "synthetic",
        }),
      );
      await until(() =>
        events.some((event) => event["type"] === "response.created"),
      );
      const closed = once(socket, "close");
      assert.equal((await rig.control(`/${action.id}/cancel`)).status, 200);
      await closed;
      await until(() => rig.wsClosed === 1);
    } finally {
      await rig.close();
    }
  });

  it("drains multiple native WS stream IDs before closing the completed invocation", async () => {
    const rig = await fixture({
      websocket: (socket, body) =>
        socket.send(
          JSON.stringify({
            type: "response.created",
            stream_id: body["stream_id"],
            response: {
              id: `resp_${body["stream_id"]}`,
              status: "in_progress",
              output: [],
            },
          }),
        ),
    });
    try {
      const action = await rig.action(),
        { socket, events } = await rig.connect(action.ingressPrefix);
      for (const stream_id of ["one", "two"])
        socket.send(
          JSON.stringify({
            type: "response.create",
            model: "native-unmatched",
            input: "synthetic",
            stream_id,
          }),
        );
      await until(
        () =>
          events.filter((event) => event["type"] === "response.created")
            .length === 2,
      );
      assert.equal((await rig.control(`/${action.id}/complete`)).status, 200);
      rig.nativeSockets[0]!.send(
        JSON.stringify({
          ...completed,
          stream_id: "one",
          response: { ...completed.response, id: "resp_one" },
        }),
      );
      await until(() =>
        events.some(
          (event) =>
            event["type"] === "response.completed" &&
            event["stream_id"] === "one",
        ),
      );
      assert.equal(
        socket.readyState,
        WebSocket.OPEN,
        "the second generating response still holds admission",
      );
      const closed = once(socket, "close");
      rig.nativeSockets[0]!.send(
        JSON.stringify({
          ...completed,
          stream_id: "two",
          response: { ...completed.response, id: "resp_two" },
        }),
      );
      await closed;
      assert.equal(
        events.filter((event) => event["type"] === "response.completed").length,
        2,
      );
      assert.equal(rig.generating, 2);
    } finally {
      await rig.close();
    }
  });

  it("rejects a new legacy Claude child after completion closes scoped WS admission", async () => {
    const rig = await fixture({
      legacyClaude: true,
      websocket: (socket, body) =>
        socket.send(
          JSON.stringify({
            type: "response.created",
            stream_id: body["stream_id"],
            response: { id: "resp_parent", status: "in_progress", output: [] },
          }),
        ),
    });
    try {
      const action = await rig.action(),
        { socket, events } = await rig.connect(action.ingressPrefix);
      socket.send(
        JSON.stringify({
          type: "response.create",
          model: "native-unmatched",
          stream_id: "parent",
          input: "synthetic",
        }),
      );
      await until(() =>
        events.some((event) => event["type"] === "response.created"),
      );
      assert.equal((await rig.control(`/${action.id}/complete`)).status, 200);
      socket.send(
        JSON.stringify({
          type: "response.create",
          model: "claude-sonnet-5",
          stream_id: "late-child",
          input: "synthetic",
        }),
      );
      await until(() =>
        events.some(
          (event) =>
            event["type"] === "error" && event["stream_id"] === "late-child",
        ),
      );
      assert.equal(rig.legacyCalls, 0);
      assert.equal(
        events.find((event) => event["stream_id"] === "late-child")?.["code"],
        "action_admission_closed",
      );
      const closed = once(socket, "close");
      rig.nativeSockets[0]!.send(
        JSON.stringify({
          ...completed,
          stream_id: "parent",
          response: { ...completed.response, id: "resp_parent" },
        }),
      );
      await closed;
    } finally {
      await rig.close();
    }
  });

  it("drains an already admitted legacy Claude response before closing scoped WS", async () => {
    const rig = await fixture({ legacyClaude: true });
    try {
      const action = await rig.action(),
        { socket, events } = await rig.connect(action.ingressPrefix);
      socket.send(
        JSON.stringify({
          type: "response.create",
          model: "claude-sonnet-5",
          stream_id: "child",
          input: "synthetic",
        }),
      );
      await until(() =>
        events.some((event) => event["type"] === "response.created"),
      );
      assert.equal((await rig.control(`/${action.id}/complete`)).status, 200);
      assert.equal(socket.readyState, WebSocket.OPEN);
      const closed = once(socket, "close"),
        stream = rig.legacyStreams[0]!;
      stream.enqueue(
        Buffer.from(
          `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 } })}\n\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
        ),
      );
      stream.close();
      await closed;
      assert.ok(
        events.some(
          (event) =>
            event["type"] === "response.completed" &&
            event["stream_id"] === "child",
        ),
      );
      assert.equal(rig.legacyCalls, 1);
    } finally {
      await rig.close();
    }
  });

  it("cancels an already admitted legacy Claude stream and scoped transport", async () => {
    const rig = await fixture({ legacyClaude: true });
    try {
      const action = await rig.action(),
        { socket, events } = await rig.connect(action.ingressPrefix);
      socket.send(
        JSON.stringify({
          type: "response.create",
          model: "claude-sonnet-5",
          stream_id: "child",
          input: "synthetic",
        }),
      );
      await until(() =>
        events.some((event) => event["type"] === "response.created"),
      );
      const closed = once(socket, "close");
      assert.equal((await rig.control(`/${action.id}/cancel`)).status, 200);
      await closed;
      await until(() => rig.legacyCancelled === 1);
      assert.equal(rig.legacyCalls, 1);
    } finally {
      await rig.close();
    }
  });

  it("counts each explicit routed WS request once across sixteen active branches", async () => {
    const rig = await fixture({ routed: true, routedPaused: true });
    try {
      const action = await rig.action(),
        { socket, events } = await rig.connect(action.ingressPrefix);
      for (let i = 0; i < 16; i++)
        socket.send(
          JSON.stringify({
            type: "response.create",
            model: "work",
            stream_id: `branch_${i}`,
            client_metadata: { thread_id: `synthetic_branch_${i}` },
            input: "synthetic",
          }),
        );
      await until(
        () =>
          events.filter((event) => event["type"] === "response.created")
            .length === 16,
      );
      assert.equal(rig.routedCalls, 16);
      assert.equal(
        events.filter((event) => event["type"] === "error").length,
        0,
      );
      assert.equal((await rig.control(`/${action.id}/complete`)).status, 200);
      const closed = once(socket, "close");
      for (const { id, controller } of rig.routedStreams) {
        controller.enqueue(
          Buffer.from(
            `data: ${JSON.stringify({ ...completed, response: { ...completed.response, id } })}\n\n`,
          ),
        );
        controller.close();
      }
      await closed;
      assert.equal(
        events.filter((event) => event["type"] === "response.completed").length,
        16,
      );
    } finally {
      await rig.close();
    }
  });

  it("does not let native warmup hold completion open or publish action affinity", async () => {
    const rig = await fixture({ websocket: () => undefined });
    try {
      const action = await rig.action(),
        { socket } = await rig.connect(action.ingressPrefix);
      socket.send(
        JSON.stringify({
          type: "response.create",
          model: "native-unmatched",
          input: [],
          generate: false,
        }),
      );
      await until(() => rig.warmups === 1);
      const closed = once(socket, "close");
      assert.equal((await rig.control(`/${action.id}/complete`)).status, 200);
      await closed;
      assert.equal(rig.generating, 0);
      assert.throws(
        () => rig.routing.actions.context(action.id, "codex"),
        /action_state_lost/,
      );
    } finally {
      await rig.close();
    }
  });
});
