/** Offline regressions: fabricated native Claude history, credentials and upstreams. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import http from "node:http";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config.js";
import { noopLogger } from "../../src/logger.js";
import { SharedRouting } from "../../src/routing/shared-routing.js";
import type { Item } from "../../src/routing/routing-types.js";
import { buildDeps, createProxyServer, listenServer } from "../../src/server.js";

const thought = {
  type: "thinking",
  thinking: "Fabricated thought from before the proxy started",
  signature: "fabricated-native-signature",
};
const hiddenThought = { type: "redacted_thinking", data: "fabricated-native-redacted" };
const history: Item[] = [
  { role: "user", content: "Read the fabricated fixture" },
  {
    role: "assistant",
    content: [
      thought,
      hiddenThought,
      { type: "tool_use", id: "toolu_original", name: "Read", input: { path: "fixture" } },
    ],
  },
  {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "toolu_original", content: "fabricated result" },
      { type: "text", text: "Continue" },
    ],
  },
];

const injectedOrigin = "http://127.0.0.1:1"; // No socket is used by the injected-fetch tests.

function config(root: string, origin = injectedOrigin) {
  const loaded = loadConfig({
    configPath: join(root, "continuity.json"),
    env: {},
    readFile: () => JSON.stringify({
      configVersion: 2,
      anthropic: { baseUrl: `${origin}/unexpected/anthropic` },
      providers: { codex: {
        kind: "codex", baseUrl: `${origin}/unexpected/codex`,
        oauthTokenUrl: `${origin}/unexpected/codex-refresh`, authFile: join(root, "absent-codex.json"),
      } },
      codexIngress: {
        subscriptionBaseUrl: `${origin}/unexpected/subscription`, apiBaseUrl: `${origin}/unexpected/openai-api`,
        claude: {
          baseUrl: `${origin}/unexpected/claude`, oauthTokenUrl: `${origin}/unexpected/claude-refresh`,
          authFile: join(root, "absent-claude.json"), configDir: join(root, "absent-claude-config"),
        },
      },
      accessProfiles: {
        native: {
          provider: "claude", product: "anthropic-api", billing: "api", account: "original",
          baseUrl: `${origin}/native`,
          credential: { kind: "env", name: "FABRICATED_CLAUDE_KEY" },
        },
        other: {
          provider: "claude", product: "anthropic-api", billing: "api", account: "other",
          baseUrl: `${origin}/other`,
          credential: { kind: "env", name: "FABRICATED_OTHER_KEY" },
        },
      },
      routes: {
        work: { clients: ["claude-code"], primary: { profile: "native", model: "claude-sonnet-5", effort: "high" } },
        other: { clients: ["claude-code"], primary: { profile: "other", model: "claude-sonnet-5", effort: "high" } },
      },
    }),
  });
  if (!loaded.ok) throw new Error(loaded.error.message);
  return loaded.value.config;
}

function restrictedFetch(origin: string, implementation: typeof fetch): typeof fetch {
  const allowed = new Set([`${origin}/native/v1/messages`, `${origin}/other/v1/messages`]);
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    assert.ok(allowed.has(url), `offline fixture blocked unexpected fetch: ${url}`);
    assert.equal(init?.redirect, "error", "offline fixture must not follow redirects");
    return implementation(input, init);
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function reply(): Response {
  const events: Item[] = [
    { type: "message_start", message: { id: "msg_fabricated", type: "message", role: "assistant", model: "claude-sonnet-5", content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Fabricated answer" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

function rig(response: (request: Item, number: number, signal: AbortSignal) => Response | Promise<Response> = () => reply()) {
  const root = mkdtempSync(join(tmpdir(), "subswitch-continuity-"));
  const requests: Item[] = [];
  const auth: string[] = [];
  const routing = new SharedRouting(config(root), noopLogger, undefined, restrictedFetch(injectedOrigin, async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    auth.push(new Headers(init?.headers).get("x-api-key") ?? "");
    return response(requests.at(-1)!, requests.length, init!.signal!);
  }), { FABRICATED_CLAUDE_KEY: "fabricated-original", FABRICATED_OTHER_KEY: "fabricated-other" });
  return { routing, requests, auth, close() { routing.close(); rmSync(root, { recursive: true, force: true }); } };
}

async function run(routing: SharedRouting, messages: Item[] = history, route = "work", signal = new AbortController().signal) {
  const events: Item[] = [];
  for await (const event of routing.events(
    { model: route, messages: structuredClone(messages) }, "claude-code", route, signal,
  )) events.push(event);
  assert.equal(events.at(-1)?.type, "message_stop");
}

describe("native Claude full-history continuity (offline)", () => {
  it("isolates every configured endpoint and native auth path and blocks unexpected injected fetches", async () => {
    const root = mkdtempSync(join(tmpdir(), "subswitch-continuity-isolation-"));
    try {
      const fixture = config(root);
      const claude = fixture.codexIngress.claude;
      for (const endpoint of [
        fixture.anthropic.baseUrl, fixture.providers.codex.baseUrl, fixture.providers.codex.oauthTokenUrl,
        fixture.codexIngress.subscriptionBaseUrl, fixture.codexIngress.apiBaseUrl,
        claude.baseUrl, claude.oauthTokenUrl,
        ...Object.values(fixture.accessProfiles!).map(profile => profile.baseUrl!),
      ]) assert.equal(new URL(endpoint).origin, injectedOrigin);
      for (const path of [fixture.providers.codex.authFile, claude.authFile!, claude.configDir!]) {
        assert.equal(path.startsWith(`${root}/`), true);
        assert.equal(existsSync(path), false);
      }
      for (const profile of Object.values(fixture.accessProfiles!)) assert.equal(profile.credential.kind, "env");
      let calls = 0;
      const allowed = restrictedFetch(injectedOrigin, async () => { calls++; return reply(); });
      for (const url of ["https://api.anthropic.com/v1/messages", `${injectedOrigin}/unexpected/anthropic/v1/messages`])
        await assert.rejects(allowed(url, { redirect: "error" }), /blocked unexpected fetch/);
      await assert.rejects(allowed(`${injectedOrigin}/native/v1/messages`, { redirect: "follow" }), /must not follow redirects/);
      assert.equal(calls, 0);
      await allowed(`${injectedOrigin}/native/v1/messages`, { redirect: "error" });
      assert.equal(calls, 1);
      const deps = buildDeps(fixture, noopLogger, { fetchImpl: allowed, env: {} });
      assert.ok(deps.ok);
      deps.value.sharedRouting?.close();
      deps.value.forwardOpenai?.close();
      deps.value.forwardAnthropic.close?.();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("imports an existing conversation before startup and follows up in the same process without changing signed history or tools", async () => {
    const { routing, requests, auth, close } = rig();
    try {
      await run(routing);
      const followup = [...history,
        { role: "assistant", content: [{ type: "text", text: "Fabricated answer" }] },
        { role: "user", content: "Continue again" },
      ];
      await run(routing, followup);
      assert.equal(requests.length, 2);
      assert.deepEqual(requests[0]?.messages, history);
      assert.deepEqual(requests[1]?.messages, followup);
      assert.deepEqual(auth, ["fabricated-original", "fabricated-original"]);
    } finally { close(); }
  });

  it("replays the same complete signed history after constructing a fresh proxy instance", async () => {
    for (let restart = 0; restart < 2; restart++) {
      const { routing, requests, close } = rig();
      try {
        await run(routing);
        assert.deepEqual(requests[0]?.messages, history);
      } finally { close(); }
    }
  });

  it("retains rejection of recorded tampering and known other-owner replay before upstream", async () => {
    const { routing, requests, close } = rig();
    try {
      await run(routing);
      const changed = structuredClone(history);
      ((changed[1]!.content as Item[])[0]!).thinking = "tampered";
      await assert.rejects(run(routing, changed), /foreign_opaque_state/);
      await assert.rejects(run(routing, history, "other"), /foreign_opaque_state/);
      assert.equal(requests.length, 1);
    } finally { close(); }
  });

  for (const failure of ["rejection", "missing terminal"] as const) {
    it(`does not adopt unvalidated imports after an upstream ${failure}`, async () => {
      const { routing, requests, close } = rig((_request, number) => {
        if (number !== 1) return reply();
        if (failure === "rejection") return new Response(
          '{"error":{"type":"invalid_request_error","message":"fabricated invalid signature"}}', { status: 400 },
        );
        return new Response(
          'event: message_start\ndata: {"type":"message_start","message":{"id":"fabricated-partial","type":"message","role":"assistant","content":[]}}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        );
      });
      try {
        await assert.rejects(run(routing), failure === "rejection" ? /invalid_request/ : /missing_provider_terminal/);
        // Failed/unfinished attempts must not bind imported signatures to their owner.
        await run(routing, history, "other");
        assert.equal(requests.length, 2);
      } finally { close(); }
    });
  }

  for (const scope of ["owner", "conversation"] as const) {
    it(`reserves cold imports against a concurrent different ${scope} before dispatch and after publication`, async () => {
      const entered = deferred<void>();
      const upstream = deferred<Response>();
      const { routing, requests, close } = rig((_request, number) => {
        if (number !== 1) return reply();
        entered.resolve();
        return upstream.promise;
      });
      const competingHistory = scope === "conversation"
        ? [{ role: "user", content: "Different fabricated conversation" }, ...history.slice(1)] : history;
      const competingRoute = scope === "owner" ? "other" : "work";
      const first = run(routing);
      try {
        await entered.promise;
        await assert.rejects(run(routing, competingHistory, competingRoute), /foreign_opaque_state/);
        assert.equal(requests.length, 1, "conflicting history must not reach another upstream");
        upstream.resolve(reply());
        await first;
        await assert.rejects(run(routing, competingHistory, competingRoute), /foreign_opaque_state/);
        assert.equal(requests.length, 1);
        await run(routing);
        assert.equal(requests.length, 2, "successful original scope keeps exact replay");
      } finally { upstream.resolve(reply()); await first.catch(() => {}); close(); }
    });
  }

  for (const ending of ["rejection", "cancellation"] as const) {
    it(`releases concurrent import reservations after ${ending}`, async () => {
      const entered = deferred<void>();
      const upstream = deferred<Response>();
      const { routing, requests, close } = rig((_request, number, signal) => {
        if (number !== 1) return reply();
        entered.resolve();
        signal.addEventListener("abort", () => upstream.reject(signal.reason), { once: true });
        return upstream.promise;
      });
      const abort = new AbortController();
      const first = assert.rejects(run(routing, history, "work", abort.signal),
        ending === "rejection" ? /invalid_request/ : /request_cancelled/);
      try {
        await entered.promise;
        await assert.rejects(run(routing, history, "other"), /foreign_opaque_state/);
        assert.equal(requests.length, 1);
        if (ending === "rejection") upstream.resolve(new Response('{"error":{"type":"invalid_request_error"}}', { status: 400 }));
        else abort.abort();
        await first;
        await run(routing, history, "other");
        await assert.rejects(run(routing), /foreign_opaque_state/);
        assert.equal(requests.length, 2, "only the released reservation may be adopted by another scope");
      } finally { abort.abort(); await first; close(); }
    });
  }

  it("releases partially adapted imports before any upstream dispatch", async () => {
    const { routing, requests, close } = rig();
    try {
      const malformed = structuredClone(history);
      ((malformed[1]!.content as Item[])[1]!).data = "";
      await assert.rejects(run(routing, malformed), /foreign_opaque_state/);
      assert.equal(requests.length, 0);
      await run(routing, history, "other");
      assert.equal(requests.length, 1);
    } finally { close(); }
  });

  it("releases imports when the consumer cancels after the provider starts streaming", async () => {
    const { routing, requests, close } = rig();
    const events = routing.events({ model: "work", messages: structuredClone(history) },
      "claude-code", "work", new AbortController().signal);
    try {
      assert.equal((await events.next()).value?.type, "message_start");
      await assert.rejects(run(routing, history, "other"), /foreign_opaque_state/);
      await events.return(undefined);
      await run(routing, history, "other");
      assert.equal(requests.length, 2);
    } finally { await events.return(undefined); close(); }
  });

  for (const streaming of [false, true]) {
    it(`preserves native history through HTTP startup, follow-up and restart with stream=${streaming}`, async (t) => {
      const root = mkdtempSync(join(tmpdir(), "subswitch-continuity-http-"));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const received: { body: Item; key: string | undefined; authorization: string | undefined }[] = [];
      const rejected: string[] = [];
      const origin = http.createServer(async (req, res) => {
        if (req.url !== "/native/v1/messages") {
          rejected.push(req.url ?? "");
          req.resume();
          res.writeHead(502, { "content-type": "application/json" });
          res.end('{"error":{"type":"offline_unexpected_upstream"}}');
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk);
        received.push({
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
          key: req.headers["x-api-key"] as string | undefined,
          authorization: req.headers.authorization,
        });
        const response = reply();
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(await response.text());
      });
      const listening = await listenServer(origin, 0, "127.0.0.1");
      assert.ok(listening.ok, JSON.stringify(listening));
      const address = origin.address();
      assert.ok(address && typeof address !== "string");
      const originUrl = `http://127.0.0.1:${address.port}`;
      try {
        for (let restart = 0; restart < 2; restart++) {
          const deps = buildDeps(config(root, originUrl), noopLogger, {
            env: { FABRICATED_CLAUDE_KEY: "fabricated-original" },
            fetchImpl: restrictedFetch(originUrl, fetch),
          });
          assert.ok(deps.ok);
          const proxy = createProxyServer(deps.value);
          const listening = await listenServer(proxy, 0, "127.0.0.1");
          assert.ok(listening.ok, JSON.stringify(listening));
          const proxyAddress = proxy.address();
          assert.ok(proxyAddress && typeof proxyAddress !== "string");
          try {
            for (const messages of [history, [...history,
              { role: "assistant", content: "Fabricated answer" },
              { role: "user", content: "Continue again" },
            ]]) {
              const response = await fetch(`http://127.0.0.1:${proxyAddress.port}/v1/messages`, {
                method: "POST",
                headers: { "content-type": "application/json", authorization: "Bearer fabricated-incoming-not-for-upstream" },
                body: JSON.stringify({ model: "work", stream: streaming, messages }),
              });
              assert.equal(response.status, 200);
              if (streaming) assert.match(await response.text(), /event: message_stop/);
              else assert.equal((await response.json() as Item).stop_reason, "end_turn");
              assert.deepEqual(received.at(-1)?.body.messages, messages);
              assert.equal(received.at(-1)?.key, "fabricated-original");
              assert.equal(received.at(-1)?.authorization, undefined);
            }
            assert.equal(rejected.length, restart, "explicit routes never reach legacy endpoints");
            // Deliberately exercise the production route-miss branch. It must reject
            // at the owned fixture, even if explicit matching regresses in the future.
            const unmatched = await fetch(`http://127.0.0.1:${proxyAddress.port}/v1/messages`, {
              method: "POST", headers: { "content-type": "application/json" },
              body: JSON.stringify({ model: "fabricated-unmatched", stream: streaming, messages: history }),
            });
            assert.equal(unmatched.status, 502);
            assert.match(await unmatched.text(), /offline_unexpected_upstream/);
            assert.equal(rejected.at(-1), "/unexpected/anthropic/v1/messages");
          } finally {
            proxy.closeAllConnections();
            await new Promise<void>(resolve => proxy.close(() => resolve()));
          }
        }
        assert.equal(received.length, 4, "one upstream call per turn, with no retries or fallback");
        assert.deepEqual(rejected, Array(2).fill("/unexpected/anthropic/v1/messages"));
      } finally {
        origin.closeAllConnections();
        await new Promise<void>(resolve => origin.close(() => resolve()));
      }
    });
  }
});
