import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { z } from "zod";
import { it, type TestContext } from "node:test";
import { toAnthropicErrorBody } from "../../src/errors.js";
import { TOGETHER_API_KEY_ENV } from "../../src/together-auth.js";
import { lateToolNames, repeatedToolIds } from "../fixtures/together/streams.js";
import { chatChunk, chatSse } from "../helpers/chat-sse.js";
import { rawHttpRequest, sseHandler, startFakeUpstream, startSubswitch, type UpstreamHandler } from "./fake-upstreams.js";

const MODEL = "fixture/explicit-route";
const KEY = "FAKE-TOGETHER-KEY-relay";
const BAD_KEY = "FAKE-TOGETHER-KEY-invalid value";
const REQUEST = { model: MODEL, messages: [{ role: "user", content: "Use a tool." }], max_tokens: 100 };
const HEADERS = { authorization: "Bearer fabricated-client-auth", "x-api-key": "fabricated-client-key",
  "anthropic-beta": "fabricated-client-beta", "user-agent": "fabricated-client-agent", session_id: "fabricated-client-session" };

const Tool = z.object({ id: z.string(), type: z.literal("tool_use"), name: z.string(), input: z.unknown() });
const Message = z.object({
  id: z.string(), stop_reason: z.string(), usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }),
  content: z.tuple([Tool]).rest(Tool),
});
const readMessage = async (response: Response) => Message.parse(await response.json());

const fixture = async (t: TestContext, handler: UpstreamHandler, key: string | null = KEY,
  options: { readonly requestTimeoutMs?: number; readonly streamIdleTimeoutMs?: number; readonly reasoningCache?: { readonly maxBytes: number } } = {}) => {
  const together = await startFakeUpstream(handler);
  t.after(together.close);
  const fallback = await startFakeUpstream((_req, res) => { res.writeHead(418); res.end(); });
  t.after(fallback.close);
  const logs: unknown[] = [];
  const exec = t.mock.fn(async () => ({ stdout: "" }));
  const proxy = await startSubswitch({ providers: { together: { baseUrl: `${together.url}/v1`, ...options } },
    anthropic: { baseUrl: fallback.url } }, {
    // A test-only canonical match exercises wiring while the production catalog is empty.
    resolve: (name) => name === MODEL ? { kind: "resolved", target: { id: MODEL, provider: "together" } } : { kind: "unresolved" },
    togetherKeyReader: { env: key === null ? {} : { [TOGETHER_API_KEY_ENV]: key }, platform: "linux", exec, setTimer: () => () => {} },
    logger: { log: (_level, event, fields) => logs.push({ event, fields }) },
  });
  t.after(proxy.close);
  const post = (body: object = REQUEST, suffix = "", signal?: AbortSignal) => fetch(`${proxy.url}/v1/messages${suffix}`, {
    method: "POST", headers: { "content-type": "application/json", ...HEADERS }, body: JSON.stringify(body), signal: signal ?? null,
  });
  return { together, fallback, post, logs, proxy, exec };
};

for (const [key, reason] of [[null, "missing"], [BAD_KEY, "malformed"]] as const) {
  it(`returns a local 401 for a ${reason} key without any upstream request`, async (t) => {
    const { post, together, fallback, logs } = await fixture(t, sseHandler(lateToolNames), key);
    const response = await post();
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("x-subswitch-synthesized"), "1");
    const body = await response.text();
    assert.match(body, new RegExp(`Together key is ${reason}.*TOGETHER_API_KEY.*Subswitch Together API key`));
    assert.ok(!(body + JSON.stringify(logs)).includes(BAD_KEY));
    assert.equal(together.requests.length + fallback.requests.length, 0);
  });
}

it("sends only the Together credential and fixed transport headers", async (t) => {
  const { post, together, fallback, logs } = await fixture(t, sseHandler(lateToolNames));
  const response = await post({ ...REQUEST, max_tokens: 100_000, n: 50, metadata: { tag: "local" } });
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.ok(!(body + JSON.stringify(logs)).includes(KEY));
  assert.equal(fallback.requests.length, 0);
  const [call] = together.requests;
  assert.ok(call);
  assert.equal(call.url, "/v1/chat/completions");
  assert.equal(call.headers.authorization, `Bearer ${KEY}`);
  assert.equal(call.headers["user-agent"], "subswitch");
  assert.equal(call.headers.accept, "text/event-stream");
  assert.equal(call.headers["content-type"], "application/json");
  for (const header of ["x-api-key", "anthropic-beta", "session_id"]) assert.equal(call.headers[header], undefined);
  const wire = JSON.parse(call.body.toString());
  assert.equal(wire.max_tokens, 16_384);
  assert.equal(wire.n, undefined);
  assert.equal(wire.metadata, undefined);
  assert.deepEqual(logs.filter((log) => JSON.stringify(log).includes("output_cap_clamped")), [
    { event: "output_cap_clamped", fields: { model: MODEL, requestedTokens: 100_000, appliedTokens: 16_384 } },
  ]);
});

it("folds tool turns, reports usage, and uses unique message and tool IDs", async (t) => {
  const { post, logs } = await fixture(t, (_req, res, _body, index) =>
    sseHandler(index === 0 ? lateToolNames : repeatedToolIds)(_req, res, _body, index));
  const first = await readMessage(await post());
  const second = await readMessage(await post());
  assert.deepEqual([first.usage.input_tokens, first.usage.output_tokens], [37, 11]);
  assert.equal(first.stop_reason, "tool_use");
  assert.deepEqual(first.content.map((block: { input: unknown }) => block.input), [{ a: 1 }, { b: 2 }]);
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.content[0].id, second.content[0].id);
  assert.equal(new Set(second.content.map((block: { id: string }) => block.id)).size, 4);
  assert.doesNotMatch(JSON.stringify(second), /repeated_upstream_id|upstream\|invalid/);
  assert.match(JSON.stringify(logs), /usage_missing/);
});

for (const maxBytes of [16 * 1024 * 1024, 8]) {
  it(`handles tool reasoning at a cache capacity of ${maxBytes} bytes without exposing it`, async (t) => {
    const thought = "First line.\nSecond line.";
    const stream = chatSse([chatChunk({ reasoning_content: thought, tool_calls: [{ index: 0, function: { name: "read", arguments: "{}" } }] }, "tool_calls"), "[DONE]"]);
    const { post, together } = await fixture(t, sseHandler(stream), KEY, { reasoningCache: { maxBytes } });
    const first = await readMessage(await post());
    assert.equal(first.content.length, 1);
    assert.equal(first.content[0].type, "tool_use");
    assert.doesNotMatch(JSON.stringify(first), /First line/);
    await (await post({ ...REQUEST, messages: [...REQUEST.messages, { role: "assistant", content: first.content },
      { role: "user", content: [{ type: "tool_result", tool_use_id: first.content[0].id, content: "done" }] }] })).text();
    const replay = JSON.parse(together.requests[1]?.body.toString() ?? "{}");
    assert.equal(replay.messages[1].reasoning_content, maxBytes >= 32 ? thought : undefined);
  });
}

it("scrubs the loaded exact key at the shared error renderer", async (t) => {
  const { post } = await fixture(t, sseHandler(lateToolNames));
  assert.equal((await post()).status, 200);
  assert.equal(JSON.parse(toAnthropicErrorBody("api_error", `A ${KEY} B`)).error.message, "A <redacted> B");
});

for (const [status, code, retryAfter, expectedStatus, expectedBody, noRetry] of [
  [401, "auth_denied", "abc", 401, /\(auth_denied\)/, null],
  [400, KEY, "25", 400, /Together upstream error/, null],
  [402, "bad_balance", "25", 402, /balance is insufficient/, "false"],
  [504, "expired", "", 504, /\(expired\)/, "false"],
  [524, "expired", "", 524, /\(expired\)/, "false"],
  [200, "bad_response", "", 502, /\(bad_response\)/, null],
] as const) {
  it(`renders a fixed error for upstream HTTP ${status} with code ${status === 400 ? "invalid" : code}`, async (t) => {
    const { post, together, fallback, logs } = await fixture(t, (_req, res) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", "retry-after": retryAfter });
      res.end(JSON.stringify({ error: { code, message: KEY } }));
    });
    const response = await post();
    assert.equal(response.status, expectedStatus);
    assert.equal(response.headers.get("x-should-retry"), noRetry);
    assert.equal(response.headers.get("retry-after"), status === 400 ? "25" : null);
    const text = await response.text();
    assert.match(text, expectedBody);
    assert.ok(!(text + JSON.stringify(logs)).includes(KEY));
    assert.equal(together.requests.length, 1);
    assert.equal(fallback.requests.length, 0);
  });
}

it("maps an upstream SSE error without copying its text", async (t) => {
  const stream = chatSse([chatChunk({ content: "Partial text" }), { error: { code: "bad_chunk", message: KEY } }]);
  const { post, logs } = await fixture(t, sseHandler(stream));
  const response = await post({ ...REQUEST, stream: true });
  const text = await response.text();
  assert.match(text, /event: error.*\(bad_chunk\)/s);
  assert.ok(!(text + JSON.stringify(logs)).includes(KEY));
});

for (const [phase, timers] of [["total", { requestTimeoutMs: 500 }], ["idle", { streamIdleTimeoutMs: 50 }]] as const) {
  it(`returns a non-retryable 504 at the ${phase} time limit`, async (t) => {
    const { post, together } = await fixture(t, (_req, res) => {
      if (phase === "idle") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(chatSse([chatChunk({ content: "Partial text" })]));
      }
    }, KEY, timers);
    const response = await post();
    assert.equal(response.status, 504);
    assert.equal(response.headers.get("x-should-retry"), "false");
    await response.text();
    assert.equal(together.requests.length, 1);
  });
}

it("does not follow a Together redirect to a different origin", async (t) => {
  const other = await startFakeUpstream(sseHandler(lateToolNames));
  t.after(other.close);
  const { post, together, fallback } = await fixture(t, (_req, res) => { res.writeHead(307, { location: `${other.url}/redirected` }); res.end(); });
  const response = await post();
  assert.equal(response.status, 502);
  assert.match(await response.text(), /Together upstream unreachable/);
  assert.equal(together.requests.length, 1);
  assert.equal(other.requests.length + fallback.requests.length, 0);
});

it("computes count_tokens locally without a credential or upstream call", async (t) => {
  const { post, together, fallback, exec } = await fixture(t, sseHandler(lateToolNames), null);
  const response = await post(REQUEST, "/count_tokens");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { input_tokens: Math.ceil(Buffer.byteLength(JSON.stringify(REQUEST)) / 4) });
  assert.equal(together.requests.length + fallback.requests.length + exec.mock.callCount(), 0);
});

it("reports only the key source in health and does not call Keychain", async (t) => {
  const { proxy, together, exec } = await fixture(t, sseHandler(lateToolNames));
  const text = await (await fetch(`${proxy.url}/__subswitch/health`)).text();
  assert.ok(!text.includes(KEY));
  assert.deepEqual(JSON.parse(text).providers.find((row: { id: string }) => row.id === "together"),
    { id: "together", configured: true, keySource: "env", modelCount: 0 });
  assert.equal(together.requests.length + exec.mock.callCount(), 0);
});

it("refuses a foreign Host before it sends a Together request", async (t) => {
  const { proxy, together, fallback } = await fixture(t, sseHandler(lateToolNames));
  const response = await rawHttpRequest(`${proxy.url}/v1/messages`, {
    method: "POST", rawHeaders: ["Host", "foreign.invalid", "Content-Type", "application/json"],
    body: Buffer.from(JSON.stringify(REQUEST)),
  });
  assert.equal(response.status, 403);
  assert.equal(together.requests.length + fallback.requests.length, 0);
});

it("cancels the Together fetch when a streaming client closes", { timeout: 3000 }, async (t) => {
  const events = new EventEmitter();
  const upstreamClose = once(events, "close", { signal: AbortSignal.timeout(2000) });
  const { post, together } = await fixture(t, (_req, res) => {
    res.once("close", () => events.emit("close"));
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(chatSse([chatChunk({ content: "Partial text" })]));
  });
  const controller = new AbortController();
  const response = await post({ ...REQUEST, stream: true }, "", controller.signal);
  assert.equal(response.status, 200);
  controller.abort();
  await upstreamClose;
  assert.equal(together.requests.length, 1);
});
