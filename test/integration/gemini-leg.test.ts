import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { loadConfig } from "../../src/config.js";
import { nativeCredential } from "../fixtures/native-profile.js";
import { messageFrames, nativeEvents } from "../fixtures/native-messages.js";
import {
  BOOTSTRAP, GENERATE, GEMINI_TEST_MODEL, geminiCandidate, geminiData, geminiTestProvider, startGeminiFake,
} from "../fixtures/gemini.js";
import { isPlainObject } from "../../src/plain-object.js";
import { TOGETHER_API_KEY_ENV } from "../../src/together-auth.js";
import { makeAccessToken, makeAuthFileContent, sseHandler, startFakeUpstream, startSubswitch, type UpstreamHandler } from "./fake-upstreams.js";

const hello = { role: "user", content: "hello" };
const textReply = sseHandler(geminiCandidate([{ text: "Hello, " }]) + geminiCandidate([{ text: "Claude." }], "STOP"));
const blocked = { type: "permission_error", message: "Gemini account access is blocked. Check your account, then restart Subswitch." };
const upstreamError = { type: "api_error", message: "Gemini did not complete the request. Retry later." };

const post = (url: string, body: Record<string, unknown> = {}) => fetch(`${url}/v1/messages`, {
  method: "POST",
  headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
  body: JSON.stringify({ model: GEMINI_TEST_MODEL, max_tokens: 16, stream: false, messages: [hello], ...body }),
  signal: AbortSignal.timeout(5_000),
});

const startRoute = async (t: TestContext, fake: Awaited<ReturnType<typeof startGeminiFake>>, active = true) => {
  const codes: string[] = [];
  const proxy = await startSubswitch({ anthropic: { baseUrl: fake.upstream.url },
    ...(active ? { providers: { gemini: geminiTestProvider } } : {}),
  }, {
    providerDeps: { gemini: fake.deps },
    logger: { log: (_level, _event, fields) => { if (fields?.errorCode !== undefined) codes.push(fields.errorCode); } },
  });
  t.after(proxy.close);
  return { send: (body?: Record<string, unknown>) => post(proxy.url, body), codes };
};

const assertError = async (reply: Response, status: number, error: { type: string; message: string }) => {
  assert.equal(reply.status, status);
  assert.deepEqual(await reply.json(), { type: "error", error });
};

const events = (body: string): unknown[] => body.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));

it("TP-28: maps Gemini text to Anthropic SSE and to one Messages reply", async (t) => {
  const fake = await startGeminiFake(t, textReply);
  const { send } = await startRoute(t, fake);
  const stream = await send({ stream: true });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get("content-type") ?? "", /^text\/event-stream/);
  const frames = events(await stream.text());
  assert.deepEqual(frames.slice(1), [
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello, " } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Claude." } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 0 } },
    { type: "message_stop" },
  ]);
  assert.equal(isPlainObject(frames[0]) && frames[0]["type"], "message_start");
  const reply = await send();
  assert.equal(reply.status, 200);
  assert.match(reply.headers.get("content-type") ?? "", /^application\/json/);
  const message: unknown = await reply.json();
  assert.ok(isPlainObject(message));
  assert.equal(message["type"], "message");
  assert.equal(message["role"], "assistant");
  assert.equal(message["stop_reason"], "end_turn");
  assert.deepEqual(message["content"], [{ type: "text", text: "Hello, Claude." }]);
  assert.deepEqual(fake.upstream.requests.map(({ url }) => url), [BOOTSTRAP, GENERATE, GENERATE]);
});

it("TP-29: refuses the same Gemini request before Keychain or Google unless the block exists", async (t) => {
  const fake = await startGeminiFake(t, textReply);
  const off = await startRoute(t, fake, false);
  await assertError(await off.send(), 400, {
    type: "invalid_request_error",
    message: 'Gemini is not turned on. Add a "providers.gemini" block to the user configuration, or to a file selected with SUBSWITCH_CONFIG, then restart subswitch.',
  });
  assert.deepEqual(fake.execs, []);
  assert.deepEqual(fake.fetches, []);
  assert.equal(fake.upstream.requests.length, 0);

  const on = await startRoute(t, fake);
  const reply = await on.send();
  assert.equal(reply.status, 200);
  await reply.text();
  assert.deepEqual(fake.execs, ["probe", "readSecret"]);
  assert.deepEqual(fake.upstream.requests.map(({ url }) => url), [BOOTSTRAP, GENERATE]);
});

for (const source of ["generate", "stream", "bootstrap"] as const) {
  for (const bodyKind of ["reported TOS_VIOLATION", "unclassified"] as const) {
    it(`TP-35: latches a 403 from ${source} with ${bodyKind} detail before any later I/O`, async (t) => {
      let now = Date.now();
      t.mock.method(Date, "now", () => now);
      // Only the synthetic numeric status is read inside SSE. The reason layout is not qualified.
      const reason = bodyKind === "reported TOS_VIOLATION" ? { details: [{ reason: "TOS_VIOLATION" }] } : { details: "fixture-invalid" };
      const frame = { error: { code: 403, ...reason } };
      const refuse: UpstreamHandler = (_req, res) => {
        res.writeHead(403);
        res.end(bodyKind === "reported TOS_VIOLATION" ? JSON.stringify(frame) : "not JSON");
      };
      const fake = await startGeminiFake(t, source === "stream" ? sseHandler(geminiCandidate([{ text: "partial" }]) + geminiData(frame))
        : refuse, source === "bootstrap" ? refuse : undefined);
      const { send, codes } = await startRoute(t, fake);

      const first = await send({ stream: source === "stream" });
      if (source === "stream") {
        assert.equal(first.status, 200);
        const frames = events(await first.text());
        assert.deepEqual(frames.at(-1), { type: "error", error: blocked });
      } else if (source === "bootstrap") {
        await assertError(first, 500, { type: "api_error", message: "Gemini could not prepare the request. Check your account, then restart Subswitch." });
      } else {
        await assertError(first, 403, blocked);
      }
      assert.deepEqual(codes, [source === "bootstrap" ? "bootstrap_blocked" : "account_blocked"]);
      assert.deepEqual(fake.execs, ["probe", "readSecret"]);
      const paths = source === "bootstrap" ? [BOOTSTRAP] : [BOOTSTRAP, GENERATE];
      assert.deepEqual(fake.upstream.requests.map(({ url }) => url), paths);

      // Go past the sign-in probe interval so a warm credential cannot hide a missing latch.
      now += 120_000;
      await assertError(await send(), 403, blocked);
      assert.deepEqual(fake.execs, ["probe", "readSecret"]);
      assert.deepEqual(fake.fetches.map(({ url }) => url), paths);
      assert.deepEqual(fake.upstream.requests.map(({ url }) => url), paths);
    });
  }
}

it("TP-18: generate refuses redirects and reports a fixed code", async (t) => {
  const fake = await startGeminiFake(t, (_req, res) => {
    res.writeHead(302, { location: "/fixture-redirect-target" });
    res.end();
  });
  const { send, codes } = await startRoute(t, fake);
  const reply = await send();
  assert.equal(reply.headers.get("location"), null);
  await assertError(reply, 502, upstreamError);
  assert.deepEqual(fake.fetches, [{ url: BOOTSTRAP, redirect: "error" }, { url: GENERATE, redirect: "error" }]);
  assert.deepEqual(fake.upstream.requests.map(({ url }) => url), [BOOTSTRAP, GENERATE]);
  assert.deepEqual(codes, ["upstream_error"]);
});

it("TP-37: a Gemini failure never falls back to Anthropic, Codex or Together", async (t) => {
  const fake = await startGeminiFake(t, (_req, res) => { res.writeHead(503); res.end("fixture upstream detail"); });
  const startAlternative = async () => {
    const alternative = await startFakeUpstream((_req, res) => { res.writeHead(500); res.end(); });
    t.after(alternative.close);
    return alternative;
  };
  const [anthropic, codex, together] = await Promise.all([startAlternative(), startAlternative(), startAlternative()]);
  const dir = await mkdtemp(join(tmpdir(), "subswitch-test-gemini-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const authFile = join(dir, "auth.json");
  await writeFile(authFile, makeAuthFileContent(makeAccessToken(Date.now() + 3_600_000)), { mode: 0o600 });
  const proxy = await startSubswitch({ anthropic: { baseUrl: anthropic.url }, providers: {
    gemini: geminiTestProvider, codex: { baseUrl: codex.url, authFile }, together: { baseUrl: `${together.url}/v1` },
  } }, { providerDeps: { gemini: fake.deps, together: {
    env: { [TOGETHER_API_KEY_ENV]: "fixture-together-key-gemini-fallback" }, platform: "darwin", setTimer: () => () => {},
    exec: async () => assert.fail("Together should use its fixture key"),
  } } });
  t.after(proxy.close);

  await assertError(await post(proxy.url), 502, upstreamError);
  assert.deepEqual(fake.upstream.requests.map(({ url }) => url), [BOOTSTRAP, GENERATE]);
  assert.deepEqual([anthropic, codex, together].map(({ connectionCount }) => connectionCount), [0, 0, 0]);
  assert.deepEqual(proxy.refusedStoreCalls, []);
});

it("maps a Gemini function call to tool_use and replays its cached signature with the result", async (t) => {
  const functionCall = { id: "fixture-call", name: "Read", args: { path: "fixture.txt" } };
  const thoughtSignature = "fixture-tool-signature";
  const callReply = sseHandler(geminiCandidate([{ functionCall, thoughtSignature }], "STOP"));
  const fake = await startGeminiFake(t, (req, res, body, index) =>
    (index === 1 ? callReply : textReply)(req, res, body, index));
  const { send } = await startRoute(t, fake);
  const tools = [{ name: "Read", input_schema: { type: "object", properties: { path: { type: "string" } } } }];

  const first = await send({ tools });
  assert.equal(first.status, 200);
  const text = await first.text();
  assert.equal(text.includes(thoughtSignature), false);
  const message: unknown = JSON.parse(text);
  assert.ok(isPlainObject(message) && Array.isArray(message["content"]));
  const [tool] = message["content"] as unknown[];
  assert.ok(isPlainObject(tool) && typeof tool["id"] === "string");
  assert.deepEqual(message["content"], [{ type: "tool_use", id: tool["id"], name: "Read", input: { path: "fixture.txt" } }]);
  assert.equal(message["stop_reason"], "tool_use");

  const second = await send({ tools, messages: [hello, { role: "assistant", content: [tool] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: tool["id"], content: "fixture output" }] },
  ] });
  assert.equal(second.status, 200);
  await second.text();
  assert.deepEqual(fake.upstream.requests.map(({ url }) => url), [BOOTSTRAP, GENERATE, GENERATE]);
  const continuation: unknown = JSON.parse(fake.upstream.requests[2]?.body.toString() ?? "null");
  assert.ok(isPlainObject(continuation));
  assert.deepEqual(continuation["request"], { contents: [
    { role: "user", parts: [{ text: "hello" }] },
    { role: "model", parts: [{ functionCall, thoughtSignature }] },
    { role: "model", parts: [{ functionResponse: { id: "fixture-call", name: "Read", response: { output: "fixture output" } } }] },
  ] });
});

const claudeProfile = {
  provider: "claude", product: "claude-code", billing: "subscription", account: "fixture",
  baseUrl: "https://api.anthropic.com", credential: nativeCredential("claude", "fixture-claude-route"),
};
const explicitRoute = {
  configVersion: 2,
  routes: { work: { clients: ["claude-code"], primary: { profile: "native", model: "claude-sonnet-5", effort: "high" } } },
};

it("TP-39: an explicit route cannot make Gemini a replay-cache owner", () => {
  const loaded = loadConfig({ configPath: "fixture-route.json", globalConfigPath: false, env: {}, readFile: () => JSON.stringify({
    ...explicitRoute, providers: { gemini: geminiTestProvider },
    accessProfiles: { native: { ...claudeProfile, provider: "gemini" } },
  }) });
  assert.ok(!loaded.ok);
  assert.match(loaded.error.message, /unsupported provider: gemini/);
});

it("TP-39: a Gemini turn contributes no signed thinking to a first-party Claude route", async (t) => {
  const signature = "fixture-gemini-thinking-signature";
  const thinking = "fixture-gemini-thought";
  const fake = await startGeminiFake(t, sseHandler(geminiCandidate([
    { text: thinking, thought: true, thoughtSignature: signature }, { text: "visible Gemini response" },
  ], "STOP")));
  const routedBodies: string[] = [];
  const claudeThinking = { type: "thinking", thinking: "fixture Claude thought", signature: "fixture-claude-signature" };
  const claudeText = { type: "text", text: "Claude response" };
  const proxy = await startSubswitch({ ...explicitRoute, accessProfiles: { native: claudeProfile },
    anthropic: { baseUrl: fake.upstream.url }, providers: { gemini: geminiTestProvider },
  }, { providerDeps: { gemini: fake.deps }, fetchImpl: async (url, init) => {
    assert.equal(String(url), "https://api.anthropic.com/v1/messages");
    routedBodies.push(String(init?.body));
    const content = routedBodies.length === 1 ? [claudeThinking, claudeText] : [claudeText];
    return new Response(messageFrames(nativeEvents(content)).join(""), { headers: { "content-type": "text/event-stream" } });
  } });
  t.after(proxy.close);
  const first = await post(proxy.url, { model: "work" });
  assert.equal(first.status, 200);
  const claude: unknown = await first.json();
  assert.ok(isPlainObject(claude));
  assert.deepEqual(claude["content"], [claudeThinking, claudeText]);
  const history = [hello, { role: "assistant", content: claude["content"] }, { role: "user", content: "ask Gemini" }];

  const reply = await post(proxy.url, { messages: history });
  assert.equal(reply.status, 200);
  const message: unknown = await reply.json();
  assert.ok(isPlainObject(message));
  assert.deepEqual(message["content"], [{ type: "text", text: "visible Gemini response" }]);
  assert.equal(fake.upstream.requests[1]?.body.toString().includes(claudeThinking.signature), false);

  const next = await post(proxy.url, { model: "work", messages: [...history,
    { role: "assistant", content: message["content"] }, { role: "user", content: "back to Claude" },
  ] });
  assert.equal(next.status, 200);
  await next.text();
  assert.equal(routedBodies.length, 2);
  const continuation = routedBodies[1] ?? "";
  assert.equal(continuation.includes(claudeThinking.signature), true, "the first-party signature survives the switch");
  assert.equal(continuation.includes("visible Gemini response"), true);
  assert.equal(continuation.includes(signature) || continuation.includes(thinking), false);
  assert.deepEqual(fake.upstream.requests.map(({ url }) => url), [BOOTSTRAP, GENERATE]);
});
