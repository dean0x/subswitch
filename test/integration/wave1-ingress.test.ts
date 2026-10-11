/** SYNTHETIC production wiring gates. Every upstream response and credential is fabricated. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { loadConfig } from "../../src/config.js";
import {
  buildDeps,
  createProxyServer,
  listenServer,
} from "../../src/server.js";
import { SharedRouting } from "../../src/routing/shared-routing.js";
import { noopLogger } from "../../src/logger.js";
import type { Item } from "../../src/routing/routing-types.js";

async function collect(source: AsyncIterable<Item>) {
  const result: Item[] = [];
  for await (const value of source) result.push(value);
  return result;
}
function sse(events: Item[]): Response {
  return new Response(
    events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}
const message = (content = "ready") => [
  {
    type: "message_start",
    message: {
      id: "same",
      type: "message",
      role: "assistant",
      content: [],
      model: "k3",
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  },
  {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: content },
  },
  { type: "content_block_stop", index: 0 },
  {
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { output_tokens: 1 },
  },
  { type: "message_stop" },
];
const completed = (tool = false) => {
  const item: Item = tool
    ? {
        type: "function_call",
        id: "fc_same",
        call_id: "read-once",
        name: "Read",
        arguments: '{"path":"check.txt"}',
        status: "completed",
      }
    : {
        type: "message",
        id: "msg_same",
        role: "assistant",
        content: [
          { type: "output_text", text: "fallback-complete", annotations: [] },
        ],
        status: "completed",
      };
  return [
    {
      type: "response.created",
      response: { id: "same", status: "in_progress", output: [] },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress" },
    },
    ...(tool
      ? [
          {
            type: "response.function_call_arguments.delta",
            output_index: 0,
            item_id: item.id,
            delta: item.arguments,
          },
        ]
      : [
          {
            type: "response.output_text.delta",
            output_index: 0,
            item_id: item.id,
            content_index: 0,
            delta: "fallback-complete",
          },
        ]),
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "same",
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
  ];
};
function config() {
  const result = loadConfig({
    configPath: "/synthetic/config.json",
    env: {},
    readFile: () =>
      JSON.stringify({
        configVersion: 2,
        codexIngress: {
          enabled: true,
          subscriptionBaseUrl: "http://127.0.0.1:1",
          apiBaseUrl: "http://127.0.0.1:1",
        },
        accessProfiles: {
          code: {
            provider: "kimi",
            product: "kimi-code",
            region: "global",
            billing: "subscription",
            account: "one",
            credential: { kind: "env", name: "CODE_KEY" },
          },
          api: {
            provider: "codex",
            product: "openai-api",
            billing: "api",
            account: "two",
            credential: { kind: "env", name: "API_KEY" },
          },
        },
        routes: {
          work: {
            clients: ["codex", "claude-code"],
            primary: { profile: "code", model: "k3", effort: "high" },
            fallbacks: [{ profile: "api", model: "gpt-6-sol", effort: "high" }],
          },
        },
      }),
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value.config;
}
const env = { CODE_KEY: "synthetic-code", API_KEY: "synthetic-api" };
describe("Wave 1 production ingress (synthetic)", () => {
  it("routes HTTP for both clients, strips the action prefix and isolates outbound credentials", async () => {
    const calls: { url: string; headers: Headers; body: Item }[] = [];
    const deps = buildDeps(config(), noopLogger, {
      env,
      fetchImpl: async (url, init) => {
        calls.push({
          url: String(url),
          headers: new Headers(init?.headers),
          body: JSON.parse(String(init?.body)),
        });
        return sse(String(url).endsWith("/messages") ? message() : completed());
      },
    });
    if (!deps.ok) throw new Error(deps.error);
    const server = createProxyServer(deps.value);
    let observedBytes = 0;
    // The native compatibility harness observes uploads before the relay. Body
    // readers must attach synchronously on ordinary paths even with that observer.
    server.prependListener("request", (req) =>
      req.on("data", (chunk) => {
        observedBytes += chunk.length;
      }),
    );
    await listenServer(server, 0, "127.0.0.1");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error();
    const base = `http://127.0.0.1:${address.port}`;
    try {
      for (const client of ["claude-code", "codex"] as const) {
        const action = deps.value.sharedRouting!.actions.create(
          client,
          "thread",
        );
        const path =
          client === "codex" ? "/codex/v1/responses" : "/v1/messages";
        const response = await fetch(`${base}${action.ingressPrefix}${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer unrelated-client-secret",
          },
          body: JSON.stringify({
            model: "work",
            stream: false,
            ...(client === "codex"
              ? { input: [{ role: "user", content: "ready" }] }
              : { messages: [{ role: "user", content: "ready" }] }),
          }),
        });
        assert.equal(response.status, 200);
        assert.ok(await response.json());
      }
      assert.equal(calls.length, 2);
      assert.ok(observedBytes > 0);
      for (const call of calls) {
        assert.equal(
          call.headers.get("authorization"),
          "Bearer synthetic-code",
        );
        assert.equal(call.headers.get("chatgpt-account-id"), null);
        assert.equal(call.headers.get("x-subswitch-capability"), null);
        assert.equal(call.headers.get("anthropic-beta"), null);
        assert.doesNotMatch(call.url, /__subswitch/);
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it("bridges routed WS to HTTP without an OpenAI connection or incoming key", async () => {
    let calls = 0;
    const deps = buildDeps(config(), noopLogger, {
      env,
      fetchImpl: async () => {
        calls++;
        return sse(completed());
      },
    });
    if (!deps.ok) throw new Error(deps.error);
    const server = createProxyServer(deps.value);
    await listenServer(server, 0, "127.0.0.1");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error();
    const action = deps.value.sharedRouting!.actions.create("codex", "thread");
    const ws = new WebSocket(
      `ws://127.0.0.1:${address.port}${action.ingressPrefix}/codex/v1/responses`,
    );
    try {
      await new Promise<void>((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
      });
      const complete = new Promise<Item>((resolve, reject) => {
        ws.on("message", (data) => {
          const event = JSON.parse(data.toString());
          if (event.type === "response.completed") resolve(event);
          if (event.type === "error") reject(new Error("routed_ws_error"));
        });
      });
      ws.send(
        JSON.stringify({
          type: "response.create",
          model: "work",
          input: [{ role: "user", content: "ready" }],
          stream: true,
        }),
      );
      const event = await complete;
      assert.match(
        String((event.response as Item).id),
        /^resp_subswitch_route_/,
      );
      assert.equal(calls, 1);
    } finally {
      ws.terminate();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it("preserves the final classified failure over routed WebSocket", async () => {
    let calls = 0;
    const deps = buildDeps(config(), noopLogger, {
      env,
      fetchImpl: async () => {
        calls++;
        return new Response(
          JSON.stringify({ error: { type: "invalid_request_error" } }),
          { status: 400 },
        );
      },
    });
    if (!deps.ok) throw new Error(deps.error);
    const server = createProxyServer(deps.value);
    await listenServer(server, 0, "127.0.0.1");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error();
    const action = deps.value.sharedRouting!.actions.create("codex", "thread");
    const ws = new WebSocket(
      `ws://127.0.0.1:${address.port}${action.ingressPrefix}/codex/v1/responses`,
    );
    try {
      await new Promise<void>((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
      });
      const failed = new Promise<Item>((resolve, reject) => {
        ws.on("message", (data) => {
          const event = JSON.parse(data.toString());
          if (event.type === "error") resolve(event);
        });
        ws.once("error", reject);
      });
      ws.send(
        JSON.stringify({
          type: "response.create",
          model: "work",
          input: [{ role: "user", content: "ready" }],
        }),
      );
      const event = await failed;
      assert.equal(event.code, "route_unknown");
      assert.equal(event.status, 400);
      assert.equal(calls, 1);
    } finally {
      ws.terminate();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it("parks a Messages tool continuation on fallback while a same-thread subsequent action re-enters primary", async () => {
    let now = 1000,
      primary = 0,
      fallback = 0;
    const calls: Item[] = [];
    const router = new SharedRouting(
      config(),
      noopLogger,
      { now: () => now, monotonic: () => now, random: () => 0.5 },
      async (url, init) => {
        calls.push(JSON.parse(String(init?.body)));
        if (String(url).includes("kimi")) {
          if (++primary === 1)
            return new Response(
              JSON.stringify({
                error: {
                  message:
                    "You've reached your 5-hour usage limit. Synthetic gate.",
                },
              }),
              { status: 403 },
            );
          return sse(message("primary-B"));
        }
        return sse(completed(++fallback === 1));
      },
      env,
    );
    const a = router.actions.create("claude-code", "thread"),
      ac = router.actions.context(a.id, "claude-code");
    const initial = {
      model: "work",
      stream: true,
      messages: [{ role: "user", content: "Read check.txt exactly once." }],
      tools: [
        {
          name: "Read",
          input_schema: {
            type: "object",
            properties: { path: { type: "string" } },
          },
        },
      ],
    };
    const first = await collect(
      router.events(
        initial,
        "claude-code",
        "work",
        new AbortController().signal,
        ac,
      ),
    );
    assert.ok(
      first.some(
        (e) => (e.content_block as Item | undefined)?.type === "tool_use",
      ),
    );
    now += 61000;
    const b = router.actions.create("claude-code", "thread");
    await collect(
      router.events(
        initial,
        "claude-code",
        "work",
        new AbortController().signal,
        router.actions.context(b.id, "claude-code"),
      ),
    );
    const resumed = await collect(
      router.events(
        {
          ...initial,
          messages: [
            ...initial.messages,
            {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: "read-once",
                  name: "Read",
                  input: { path: "check.txt" },
                },
              ],
            },
            {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "read-once",
                  content: "unpredictable-result",
                  is_error: true,
                },
              ],
            },
          ],
        },
        "claude-code",
        "work",
        new AbortController().signal,
        ac,
      ),
    );
    assert.equal(primary, 2);
    assert.equal(fallback, 2);
    assert.equal(resumed.at(-1)?.type, "message_stop");
    assert.equal(
      (calls[3]!.input as Item[]).filter((i) => i.type === "function_call")
        .length,
      1,
    );
    assert.match(
      String(
        (calls[3]!.input as Item[]).find(
          (i) => i.type === "function_call_output",
        )?.output,
      ),
      /Tool execution failed/,
    );
    assert.equal(router.actions.affinity(ac, "work").chainIndex, 1);
    router.close();
  });
  it("rejects unauthenticated control calls and closes admission with a valid capability", async () => {
    const deps = buildDeps(config(), noopLogger);
    if (!deps.ok) throw new Error(deps.error);
    const server = createProxyServer(deps.value);
    await listenServer(server, 0, "127.0.0.1");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error();
    const base = `http://127.0.0.1:${address.port}/__subswitch/actions`;
    try {
      const denied = await fetch(base, { method: "POST", body: "{}" });
      assert.equal(denied.status, 403);
      await denied.text();
      const created = await fetch(base, {
        method: "POST",
        headers: {
          "x-subswitch-capability":
            deps.value.sharedRouting!.actions.capability,
        },
        body: JSON.stringify({ client: "codex", conversationId: "thread" }),
      });
      assert.equal(created.status, 201);
      const action = (await created.json()) as { id: string };
      const completed = await fetch(`${base}/${action.id}/complete`, {
        method: "POST",
        headers: {
          "x-subswitch-capability":
            deps.value.sharedRouting!.actions.capability,
        },
      });
      assert.equal(completed.status, 200);
      await completed.text();
      assert.throws(
        () => deps.value.sharedRouting!.actions.context(action.id, "codex"),
        /action_state_lost/,
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
