/** Synthetic upstreams and credentials; review gates use the production HTTP/WS wiring. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { loadConfig } from "../../src/config.js";
import {
  buildDeps,
  createProxyServer,
  listenServer,
} from "../../src/server.js";
import { noopLogger } from "../../src/logger.js";
import { SharedRouting } from "../../src/routing/shared-routing.js";
import { RoutingError, type Item } from "../../src/routing/routing-types.js";

function config() {
  const loaded = loadConfig({
    configPath: "/synthetic/review.json",
    env: {},
    readFile: () =>
      JSON.stringify({
        configVersion: 2,
        codexIngress: {
          enabled: true,
          apiBaseUrl: "http://127.0.0.1:1",
          subscriptionBaseUrl: "http://127.0.0.1:1",
        },
        accessProfiles: {
          api: {
            provider: "codex",
            product: "openai-api",
            billing: "api",
            account: "review",
            credential: { kind: "env", name: "REVIEW_KEY" },
          },
        },
        routes: {
          work: {
            clients: ["codex", "claude-code"],
            primary: { profile: "api", model: "gpt-6-sol", effort: "high" },
          },
        },
      }),
  });
  if (!loaded.ok) throw new Error(loaded.error.message);
  return loaded.value.config;
}
const env = { REVIEW_KEY: "synthetic-review" };
const text = {
  type: "message",
  id: "message",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text: "synthetic answer" }],
};
function response(output: Item[] = [text]) {
  return new Response(
    [
      {
        type: "response.created",
        response: { id: "upstream", status: "in_progress", output: [] },
      },
      ...output
        .filter((item) => item.type === "function_call")
        .map((item) => ({ type: "response.output_item.done", item })),
      {
        type: "response.completed",
        response: { id: "upstream", status: "completed", output },
      },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}
async function collect(source: AsyncIterable<Item>) {
  const values: Item[] = [];
  for await (const value of source) values.push(value);
  return values;
}

describe("reviewed local continuation isolation", () => {
  it("does not mistake inherited record properties for configured routes", async () => {
    const base = config();
    const router = new SharedRouting(
      base,
      noopLogger,
      undefined,
      async () => response(),
      env,
    );
    try {
      for (const model of [
        "constructor",
        "toString",
        "hasOwnProperty",
        "__proto__",
      ]) {
        assert.equal(router.match({ model }, "codex"), undefined);
        await assert.rejects(
          collect(
            router.events(
              { model },
              "codex",
              model,
              new AbortController().signal,
            ),
          ),
          /unknown_route/,
        );
      }
    } finally {
      router.close();
    }
    const declared = new SharedRouting(
      { ...base, routes: { constructor: base.routes!["work"]! } },
      noopLogger,
      undefined,
      async () => response(),
      env,
    );
    try {
      assert.equal(
        declared.match({ model: "constructor" }, "codex"),
        "constructor",
      );
    } finally {
      declared.close();
    }
  });
  it("continues bare single-target HTTP history using the returned actual model and a model-less follow-up", async () => {
    const requests: Item[] = [];
    const deps = buildDeps(config(), noopLogger, {
      env,
      fetchImpl: async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return response();
      },
    });
    if (!deps.ok) throw new Error(deps.error);
    const server = createProxyServer(deps.value);
    await listenServer(server, 0, "127.0.0.1");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error();
    const send = async (body: Item) => {
      const result = await fetch(
        `http://127.0.0.1:${address.port}/codex/v1/responses`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      assert.equal(result.status, 200);
      return (await result.json()) as Item;
    };
    try {
      const first = await send({ model: "work", input: "first" });
      const second = await send({
        model: first.model,
        previous_response_id: first.id,
        input: "second",
      });
      await send({ previous_response_id: second.id, input: "third" });
      assert.equal(requests.length, 3);
      assert.equal(requests[2]!.previous_response_id, undefined);
      assert.deepEqual(
        (requests[2]!.input as Item[]).map((entry) => entry.content),
        ["first", text.content, "second", text.content, "third"],
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("continues bare WebSocket responses without native authentication or action scope", async () => {
    const requests: Item[] = [];
    const deps = buildDeps(config(), noopLogger, {
      env,
      fetchImpl: async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return response();
      },
    });
    if (!deps.ok) throw new Error(deps.error);
    const server = createProxyServer(deps.value);
    await listenServer(server, 0, "127.0.0.1");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error();
    const ws = new WebSocket(
      `ws://127.0.0.1:${address.port}/codex/v1/responses`,
    );
    try {
      await new Promise<void>((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
      });
      const send = (body: Item) =>
        new Promise<Item>((resolve, reject) => {
          const message = (data: import("ws").RawData) => {
            const event = JSON.parse(data.toString());
            if (event.type === "error") {
              ws.off("message", message);
              reject(new Error(event.code));
            }
            if (event.type === "response.completed") {
              ws.off("message", message);
              resolve(event.response);
            }
          };
          ws.on("message", message);
          ws.send(JSON.stringify({ ...body, type: "response.create" }));
        });
      const first = await send({ model: "work", input: "first" });
      await send({
        model: first.model,
        previous_response_id: first.id,
        input: "second",
      });
      assert.equal(requests.length, 2);
      assert.equal(requests[1]!.previous_response_id, undefined);
      assert.equal((requests[1]!.input as Item[])[0]!.content, "first");
    } finally {
      ws.terminate();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("keeps explicit, bare, originating protocol and child histories isolated, while allowing same-thread subsequent actions", async () => {
    let requests = 0;
    const router = new SharedRouting(
      config(),
      noopLogger,
      undefined,
      async () => {
        requests++;
        return response();
      },
      env,
    );
    const action = router.actions.create("codex", "thread");
    const context = router.actions.context(action.id, "codex");
    try {
      const first = await collect(
        router.events(
          { model: "work", input: "first", stream: true },
          "codex",
          "work",
          new AbortController().signal,
          context,
        ),
      );
      const id = (first.at(-1)!.response as Item).id;
      const body = {
        model: "work",
        previous_response_id: id,
        input: "second",
        stream: true,
      };
      await assert.rejects(
        collect(
          router.events(body, "codex", "work", new AbortController().signal),
        ),
        /continuation_scope_mismatch/,
      );
      await assert.rejects(
        collect(
          router.events(body, "codex", "work", new AbortController().signal, {
            ...context,
            agentId: "child",
          }),
        ),
        /continuation_scope_mismatch/,
      );
      const other = router.actions.create("codex", "other-thread");
      await assert.rejects(
        collect(
          router.events(
            body,
            "codex",
            "work",
            new AbortController().signal,
            router.actions.context(other.id, "codex"),
          ),
        ),
        /continuation_scope_mismatch/,
      );
      const same = router.actions.create("codex", "thread");
      await collect(
        router.events(
          body,
          "codex",
          "work",
          new AbortController().signal,
          router.actions.context(same.id, "codex"),
        ),
      );
      const bare = await collect(
        router.events(
          { model: "work", input: "bare", stream: true },
          "codex",
          "work",
          new AbortController().signal,
        ),
      );
      const bareId = (bare.at(-1)!.response as Item).id;
      await assert.rejects(
        collect(
          router.events(
            { ...body, previous_response_id: bareId },
            "codex",
            "work",
            new AbortController().signal,
            context,
          ),
        ),
        /continuation_scope_mismatch/,
      );
      await assert.rejects(
        collect(
          router.events(
            { ...body, previous_response_id: bareId },
            "claude-code",
            "work",
            new AbortController().signal,
          ),
        ),
        /continuation_scope_mismatch/,
      );
      assert.equal(requests, 3);
    } finally {
      router.close();
    }
  });

  it("expands a warmup handle without inference and preserves the logical conversation", async () => {
    const requests: Item[] = [];
    const router = new SharedRouting(
      config(),
      noopLogger,
      undefined,
      async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return response();
      },
      env,
    );
    try {
      const initial = await collect(
        router.events(
          { model: "work", input: "first", stream: true },
          "codex",
          "work",
          new AbortController().signal,
        ),
      );
      const warmup = await collect(
        router.events(
          {
            previous_response_id: (initial.at(-1)!.response as Item).id,
            generate: false,
          },
          "codex",
          "work",
          new AbortController().signal,
        ),
      );
      assert.equal(requests.length, 1);
      await collect(
        router.events(
          {
            model: "work",
            previous_response_id: (warmup.at(-1)!.response as Item).id,
            input: "second",
            stream: true,
          },
          "codex",
          "work",
          new AbortController().signal,
        ),
      );
      assert.equal(requests.length, 2);
      assert.equal((requests[1]!.input as Item[])[0]!.content, "first");
    } finally {
      router.close();
    }
  });

  for (const client of ["codex", "claude-code"] as const) {
    it(`withholds executable ${client} tools when state publication fails`, async () => {
      const tool = {
        type: "function_call",
        id: "tool",
        call_id: "read",
        name: "Read",
        arguments: "{}",
        status: "completed",
      };
      const router = new SharedRouting(
        config(),
        noopLogger,
        undefined,
        async () => response([tool]),
        env,
      );
      const prepare = router.attempts.prepare.bind(router.attempts);
      router.attempts.prepare = async (request) => {
        const prepared = await prepare(request);
        return {
          ...prepared,
          commit: () => {
            throw new RoutingError("continuation_store_full", 503);
          },
        };
      };
      const seen: Item[] = [];
      const body =
        client === "codex"
          ? { model: "work", input: "Read", stream: true }
          : {
              model: "work",
              messages: [{ role: "user", content: "Read" }],
              stream: true,
            };
      try {
        await assert.rejects(
          (async () => {
            for await (const event of router.events(
              body,
              client,
              "work",
              new AbortController().signal,
            ))
              seen.push(event);
          })(),
          /continuation_store_full/,
        );
        assert.ok(seen.length > 0);
        assert.equal(
          seen.some(
            (event) =>
              event.type === "response.output_item.done" ||
              event.type === "content_block_stop" ||
              event.type === "message_stop" ||
              event.type === "response.completed",
          ),
          false,
        );
      } finally {
        router.close();
      }
    });
  }
});
