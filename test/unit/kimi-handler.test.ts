import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { it } from "node:test";
import type { KimiProviderConfig } from "../../src/config.js";
import { createKimiHandler } from "../../src/kimi-handler.js";
import type { KimiAuth } from "../../src/kimi-native-auth.js";
import type { ProviderCredential } from "../../src/provider-auth.js";
import { ReasoningCache } from "../../src/reasoning-cache.js";
import { err, ok } from "../../src/result.js";
import { SUBSWITCH_VERSION } from "../../src/version.js";

const KIMI_URL = "https://api.kimi.ai/coding/v1/messages?beta=true";
const ACCESS = "FAKE-KIMI-ACCESS-TOKEN-0001";
const RENEWED = "FAKE-KIMI-ACCESS-TOKEN-0002";
const DEVICE_ID = "00000000-0000-4000-8000-00000000d001";
const CLIENT_SIGN_IN = "FAKE-CLIENT-CLAUDE-SIGN-IN";

const provider: KimiProviderConfig = {
  optedIn: true, region: "global", authFile: "/fixture-home/.kimi-code/credentials/kimi-code-env-fixture.json",
  baseUrl: "https://api.kimi.ai/coding/v1/", oauthTokenUrl: "https://auth.kimi.ai/api/oauth/token", aliases: {},
  requestTimeoutMs: 5_000, streamIdleTimeoutMs: 5_000, maxSseEventBytes: 1024 * 1024, maxAggregateBytes: 1024 * 1024,
  reasoningCache: { maxEntries: 8, maxBytes: 64 * 1024, maxTurnBytes: 16 * 1024 },
};

const credential = (token: string): ProviderCredential<"kimi"> => ({ provider: "kimi", authHeaders: { authorization: `Bearer ${token}` } });

/** A response stub that keeps the status and every byte the handler writes. */
class StubResponse extends EventEmitter {
  statusCode = 0;
  headers: Record<string, string> = {};
  writableEnded = false;
  writableFinished = false;
  destroyed = false;
  headersSent = false;
  socket = { setNoDelay: () => undefined };
  body = "";

  writeHead(status: number, headers: Record<string, string> = {}): this {
    this.statusCode = status;
    this.headers = headers;
    this.headersSent = true;
    return this;
  }

  write(data: unknown): boolean {
    if (typeof data === "string") this.body += data;
    return true;
  }

  end(data?: unknown): this {
    if (typeof data === "string") this.body += data;
    this.writableEnded = true;
    return this;
  }
}

/** A client request that carries the client's own Claude sign-in and beta values. */
const clientRequest = {
  headers: { authorization: `Bearer ${CLIENT_SIGN_IN}`, "x-api-key": CLIENT_SIGN_IN, "anthropic-beta": "oauth-2025-04-20", cookie: "c=1" },
  rawHeaders: ["authorization", `Bearer ${CLIENT_SIGN_IN}`, "x-api-key", CLIENT_SIGN_IN, "anthropic-beta", "oauth-2025-04-20"],
} as unknown as IncomingMessage;

type Sent = { readonly url: string; readonly init: RequestInit; readonly body: Record<string, unknown> };
type Event = Record<string, unknown> & { readonly type: string };
const sse = (events: readonly Event[]): string =>
  events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
const start: Event = { type: "message_start", message: {
  id: "msg_kimi_1", type: "message", role: "assistant", model: "kimi-upstream-name", content: [],
  stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 },
} };
const textReply = sse([start,
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } },
  { type: "message_stop" }]);
const toolReply = sse([start,
  { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "kimi thought fixture" } },
  { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "KIMI-SIGNATURE-FIXTURE" } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_kimi_1", name: "Read", input: {} } },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":"a"}' } },
  { type: "content_block_stop", index: 1 },
  { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 9 } },
  { type: "message_stop" }]);
const sseResponse = (body: string) => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });

const rig = (replies: readonly (() => Response)[], authOverrides: Partial<KimiAuth> = {}) => {
  const sent: Sent[] = [];
  const logs: unknown[] = [];
  const refreshes: unknown[] = [];
  let credentialCalls = 0;
  const auth: KimiAuth = {
    refreshable: true, deviceId: DEVICE_ID,
    getCredentials: async () => { credentialCalls++; return ok(credential(ACCESS)); },
    forceRefresh: async (_signal, failed) => { refreshes.push(failed); return ok(credential(RENEWED)); },
    ...authOverrides,
  };
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), init: init ?? {}, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    const reply = replies[sent.length - 1];
    return reply === undefined ? assert.fail("Unexpected upstream request") : reply();
  }) as typeof fetch;
  const handler = createKimiHandler({
    provider, auth, fetchImpl, cache: new ReasoningCache(8, 64 * 1024, true),
    logger: { log: (level, event, fields) => logs.push({ level, event, fields }) },
  });
  const send = async (body: Record<string, unknown>) => {
    const res = new StubResponse();
    await handler.handleMessages(clientRequest, res as unknown as ServerResponse, Buffer.from(JSON.stringify(body)), body, "kimi-for-coding");
    return res;
  };
  return { handler, send, sent, logs, refreshes, credentialCalls: () => credentialCalls };
};

const request = (fields: Record<string, unknown> = {}) => ({
  model: "kimi:kimi-for-coding", max_tokens: 256, messages: [{ role: "user", content: "read the file" }], ...fields,
});

it("sends only the Kimi bearer, the fixed identity headers and the protocol headers", async () => {
  const { send, sent } = rig([() => sseResponse(textReply)]);
  await send(request({ stream: true }));

  assert.equal(sent.length, 1);
  const [call] = sent;
  assert.equal(call?.url, KIMI_URL);
  assert.equal(call?.init.method, "POST");
  assert.equal(call?.init.redirect, "error");
  assert.deepEqual(call?.init.headers, {
    authorization: `Bearer ${ACCESS}`,
    "user-agent": `subswitch/${SUBSWITCH_VERSION}`,
    "x-msh-platform": "subswitch",
    "x-msh-version": SUBSWITCH_VERSION,
    "x-msh-device-id": DEVICE_ID,
    "content-type": "application/json",
    accept: "text/event-stream",
    "anthropic-version": "2023-06-01",
  });
  assert.equal(JSON.stringify(call).includes(CLIENT_SIGN_IN), false, "the client sign-in must not reach Kimi");
});

it("streams Anthropic frames that name the canonical model", async () => {
  const { send, sent } = rig([() => sseResponse(textReply)]);
  const res = await send(request({ stream: true }));

  assert.equal(res.statusCode, 200);
  assert.match(res.headers["content-type"] ?? "", /^text\/event-stream/);
  assert.match(res.body, /^event: message_start\ndata: \{"type":"message_start","message":\{"id":"msg_kimi_1","type":"message","role":"assistant","model":"kimi-for-coding",/);
  assert.match(res.body, /"text_delta","text":"hello"/);
  assert.equal(sent[0]?.body["model"], "kimi-for-coding");
  assert.equal(sent[0]?.body["stream"], true);
});

it("asks Kimi for a stream and folds it to one JSON reply when the client sends stream false", async () => {
  const { send, sent } = rig([() => sseResponse(textReply)]);
  const res = await send(request({ stream: false }));

  assert.equal(sent[0]?.body["stream"], true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), {
    id: "msg_kimi_1", type: "message", role: "assistant", model: "kimi-for-coding",
    content: [{ type: "text", text: "hello" }], stop_reason: "end_turn", stop_sequence: null,
    usage: { input_tokens: 5, output_tokens: 2 },
  });
});

it("keeps Kimi thinking from the client and replays it to Kimi on the tool result turn", async () => {
  const { send, sent } = rig([() => sseResponse(toolReply), () => sseResponse(textReply)]);
  const first = await send(request({ stream: true }));
  assert.equal(first.body.includes("KIMI-SIGNATURE-FIXTURE"), false);
  assert.equal(first.body.includes("kimi thought fixture"), false);
  assert.match(first.body, /"content_block_start","index":0,"content_block":\{"type":"tool_use","id":"toolu_kimi_1"/);

  const toolUse = { type: "tool_use", id: "toolu_kimi_1", name: "Read", input: { path: "a" } };
  const toolResult = { type: "tool_result", tool_use_id: "toolu_kimi_1", content: "file text" };
  await send(request({ stream: true, messages: [
    { role: "user", content: "read the file" },
    { role: "assistant", content: [toolUse] },
    { role: "user", content: [toolResult] },
  ] }));

  assert.deepEqual(sent[1]?.body["messages"], [
    { role: "user", content: "read the file" },
    { role: "assistant", content: [{ type: "thinking", thinking: "kimi thought fixture", signature: "KIMI-SIGNATURE-FIXTURE" }, toolUse] },
    { role: "user", content: [toolResult] },
  ]);
});

it("answers count_tokens with the local estimate and no upstream call", () => {
  const { handler, sent, credentialCalls } = rig([]);
  const res = new StubResponse();
  const body = Buffer.from(JSON.stringify(request()));
  handler.handleCountTokens(clientRequest, res as unknown as ServerResponse, body);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { input_tokens: Math.ceil(body.length / 4) });
  assert.equal(sent.length, 0);
  assert.equal(credentialCalls(), 0);
});

it("replies to a Kimi failure with fixed text and sends nothing to another route", async () => {
  const echo = JSON.stringify({ type: "error", error: { type: "api_error", message: `bad bearer ${ACCESS}` } });
  const { send, sent, logs } = rig([() => new Response(echo, { status: 500, headers: { "retry-after": "17, 18" } })]);
  const res = await send(request({ stream: true }));

  assert.equal(res.statusCode, 500);
  assert.deepEqual(JSON.parse(res.body), { type: "error", error: { type: "api_error", message: "Kimi returned an error. Retry the request." } });
  assert.equal(res.headers["retry-after"], undefined);
  assert.deepEqual(sent.map((call) => call.url), [KIMI_URL]);
  assert.equal(JSON.stringify({ body: res.body, logs }).includes(ACCESS), false);
});

it("passes only a retry-after of digits", async () => {
  const { send } = rig([() => new Response("{}", { status: 429, headers: { "retry-after": "17" } })]);
  const res = await send(request({ stream: true }));

  assert.equal(res.statusCode, 429);
  assert.equal(res.headers["retry-after"], "17");
  assert.equal(JSON.parse(res.body).error.type, "rate_limit_error");
});

it("renews the sign-in once after a 401 and then replies with fixed text", async () => {
  const refused = () => new Response("{}", { status: 401 });
  const { send, sent, refreshes } = rig([refused, refused]);
  const res = await send(request({ stream: true }));

  assert.deepEqual(refreshes, [credential(ACCESS)]);
  assert.deepEqual(sent.map((call) => (call.init.headers as Record<string, string>)["authorization"]), [`Bearer ${ACCESS}`, `Bearer ${RENEWED}`]);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(JSON.parse(res.body).error, {
    type: "authentication_error", message: "Kimi refused the sign-in. Run `kimi login` in your own Terminal.",
  });
});

it("replies with the sign-in error and sends no request when the sign-in fails", async () => {
  const { send, sent } = rig([], { getCredentials: async () => err({ kind: "auth", message: "fixed sign-in text" }) });
  const res = await send(request({ stream: true }));

  assert.equal(res.statusCode, 401);
  assert.equal(JSON.parse(res.body).error.message, "fixed sign-in text");
  assert.equal(sent.length, 0);
});

it("ends a pending sign-in wait when the client closes, with no request to Kimi", async () => {
  const { handler, sent } = rig([], { getCredentials: () => new Promise(() => {}) });
  const res = new StubResponse();
  const body = request({ stream: true });
  const run = handler.handleMessages(clientRequest, res as unknown as ServerResponse, Buffer.from(JSON.stringify(body)), body, "kimi-for-coding");
  res.destroyed = true;
  res.emit("close");
  const settled = await Promise.race([run.then(() => true), new Promise<boolean>((resolve) => setImmediate(resolve, false))]);

  assert.equal(settled, true);
  assert.equal(sent.length, 0);
});
