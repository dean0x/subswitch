import assert from "node:assert/strict";
import { addAbortListener, EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { it } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { KimiProviderConfig } from "../../src/config.js";
import { createKimiHandler } from "../../src/kimi-handler.js";
import type { KimiAuth } from "../../src/kimi-native-auth.js";
import { renderLogLine } from "../../src/logger.js";
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

  close(): void {
    this.destroyed = true;
    this.emit("close");
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
const sseResponse = (body: string | ReadableStream<Uint8Array>) =>
  new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });

const openSseResponse = (signal: AbortSignal): Response => sseResponse(new ReadableStream<Uint8Array>({
  start(controller) {
    controller.enqueue(Buffer.from(sse([start])));
    addAbortListener(signal, () => controller.error(signal.reason));
  },
}));

type Reply = (init: RequestInit) => Response | Promise<Response>;
type RigOverrides = { readonly auth?: Partial<KimiAuth>; readonly provider?: Partial<KimiProviderConfig> };
const rig = (replies: readonly Reply[], overrides: RigOverrides = {}) => {
  const sent: Sent[] = [];
  const logs: string[] = [];
  const refreshes: unknown[] = [];
  let credentialCalls = 0;
  const auth: KimiAuth = {
    refreshable: true, deviceId: DEVICE_ID,
    getCredentials: async () => { credentialCalls++; return ok(credential(ACCESS)); },
    forceRefresh: async (_signal, failed) => { refreshes.push(failed); return ok(credential(RENEWED)); },
    ...overrides.auth,
  };
  const fetchImpl: typeof fetch = async (url, init = {}) => {
    sent.push({ url: String(url), init, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    const reply = replies[sent.length - 1];
    return reply === undefined ? assert.fail("Unexpected upstream request") : reply(init);
  };
  const handler = createKimiHandler({
    provider: { ...provider, ...overrides.provider }, auth, fetchImpl, cache: new ReasoningCache(8, 64 * 1024, true),
    logger: { log: (level, event, fields) => logs.push(renderLogLine(level, event, fields)) },
  });
  const send = async (body: Record<string, unknown>, res = new StubResponse()) => {
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

const tool = { name: "Read", input_schema: { type: "object" } };

it("refuses a forced tool choice before it reads the sign-in or sends a request", async () => {
  const { send, sent, logs, credentialCalls } = rig([() => sseResponse(textReply)]);
  const res = await send(request({ tools: [tool], tool_choice: { type: "tool", name: tool.name } }));

  assert.equal(res.statusCode, 400);
  assert.deepEqual(JSON.parse(res.body), { type: "error", error: {
    type: "invalid_request_error", message: 'The Kimi route does not accept a forced tool choice (tool_choice type "tool").',
  } });
  assert.equal(credentialCalls(), 0);
  assert.equal(sent.length, 0);
  assert.deepEqual(logs, ["level=warn event=kimi_request_rejected model=kimi:kimi-for-coding errorCode=forced_tool_choice"]);
});

for (const type of ["auto", "any", "none", undefined] as const) {
  it(`passes ${type ?? "absent"} tool choice through unchanged`, async () => {
    const { send, sent } = rig([() => sseResponse(textReply)]);
    const toolChoice = type === undefined ? {} : { tool_choice: { type } };
    const res = await send(request({ tools: [tool], ...toolChoice }));

    assert.equal(res.statusCode, 200);
    assert.equal(sent.length, 1);
    const body = sent[0]?.body;
    assert.ok(body);
    assert.equal(Object.hasOwn(body, "tool_choice"), type !== undefined);
    assert.deepEqual(body["tool_choice"], toolChoice.tool_choice);
  });
}

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

const shortTimeouts = { requestTimeoutMs: 100, streamIdleTimeoutMs: 20 };

it("aborts the Kimi fetch when the client closes after the first frame", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const res = new StubResponse();
  const cleanup = new AbortController();
  const { send, sent } = rig([({ signal }) => {
    assert.ok(signal);
    return openSseResponse(AbortSignal.any([signal, cleanup.signal]));
  }], { provider: shortTimeouts });
  const run = send(request({ stream: true }), res);
  t.after(async () => { cleanup.abort(); await run; });

  await nextTurn();
  assert.match(res.body, /^event: message_start\n/);
  const signal = sent[0]?.init.signal;
  assert.ok(signal);
  assert.equal(signal.aborted, false);
  res.close();

  assert.equal(signal.aborted, true, "client close must abort the Kimi fetch");
  await run;
});

it("returns a 504 and aborts the Kimi fetch at the request timeout before headers", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { send, sent } = rig([({ signal }) => new Promise<Response>((_resolve, reject) => {
    assert.ok(signal);
    addAbortListener(signal, () => reject(signal.reason));
  })], { provider: shortTimeouts });
  const run = send(request({ stream: true }));

  await nextTurn();
  const signal = sent[0]?.init.signal;
  assert.ok(signal);
  t.mock.timers.tick(shortTimeouts.requestTimeoutMs - 1);
  assert.equal(signal.aborted, false, "the request must wait for its full header deadline");
  t.mock.timers.tick(1);
  assert.equal(signal.aborted, true, "the request deadline must abort the Kimi fetch");
  const res = await run;

  assert.equal(res.statusCode, 504);
  assert.deepEqual(JSON.parse(res.body), { type: "error", error: { type: "api_error", message: "Kimi request timed out" } });
});

it("ends a stalled Kimi stream with an SSE error at the idle timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const res = new StubResponse();
  const cleanup = new AbortController();
  // Keep the body open when the fetch signal aborts. The runner must stop the read.
  const { send } = rig([() => openSseResponse(cleanup.signal)], { provider: shortTimeouts });
  const run = send(request({ stream: true }), res);
  t.after(async () => { cleanup.abort(); await run; });

  await nextTurn();
  assert.match(res.body, /^event: message_start\n/);
  t.mock.timers.tick(shortTimeouts.streamIdleTimeoutMs - 1);
  assert.equal(res.writableEnded, false);
  t.mock.timers.tick(1);
  await nextTurn();

  assert.equal(res.writableEnded, true, "the idle timeout must end the client stream");
  assert.ok(res.body.endsWith('event: error\ndata: {"type":"error","error":{"type":"api_error","message":"Kimi stream interrupted"}}\n\n'));
  await run;
});

it("returns only an error when a non-stream Kimi reply exceeds the aggregate cap", async () => {
  const { send } = rig([() => sseResponse(textReply)], { provider: { maxAggregateBytes: 512 } });
  const res = await send(request({ stream: false }));

  assert.equal(res.statusCode, 502);
  assert.deepEqual(JSON.parse(res.body), { type: "error", error: { type: "api_error", message: "Kimi stream interrupted" } });
});

it("returns a fixed 502 when Kimi sends JSON to a stream request", async () => {
  const { send } = rig([() => Response.json({ content: "Unexpected Kimi JSON" })]);
  const res = await send(request({ stream: true }));

  assert.equal(res.statusCode, 502);
  assert.deepEqual(JSON.parse(res.body), {
    type: "error", error: { type: "api_error", message: "Kimi returned a JSON reply to a stream request." },
  });
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

for (const [name, body, expected] of [
  ["an allow-listed type", '{"error":{"type":"overloaded_error"}}', "overloaded_error"],
  ["an unknown string type", '{"error":{"type":"unlisted_fixture_type"}}', "other"],
  ["a non-JSON body", "fixture text", "none"],
  ["a missing type", '{"error":{}}', "none"],
] as const) {
  it(`logs ${expected} for ${name} in a Kimi HTTP error`, async () => {
    const { send, logs } = rig([() => new Response(body, { status: 400 })]);
    await send(request());

    assert.deepEqual(logs, [
      `level=warn event=kimi_upstream_error model=kimi:kimi-for-coding status=400 upstreamErrorType=${expected}`,
    ]);
  });
}

it("omits the Kimi HTTP error message from every log line and the client reply", async () => {
  const marker = "KIMI-HTTP-ERROR-MESSAGE-FIXTURE-032";
  const { send, logs } = rig([() => Response.json({
    error: { type: "invalid_request_error", message: marker },
  }, { status: 400 })]);
  const res = await send(request());

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.includes(marker), false);
  assert.equal(logs.some((line) => line.includes(marker)), false);
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
  const { send, sent } = rig([], { auth: { getCredentials: async () => err({ kind: "auth", message: "fixed sign-in text" }) } });
  const res = await send(request({ stream: true }));

  assert.equal(res.statusCode, 401);
  assert.equal(JSON.parse(res.body).error.message, "fixed sign-in text");
  assert.equal(sent.length, 0);
});

it("ends a pending sign-in wait when the client closes, with no request to Kimi", async () => {
  const { send, sent } = rig([], { auth: { getCredentials: () => new Promise(() => {}) } });
  const res = new StubResponse();
  const run = send(request({ stream: true }), res);
  res.close();
  const settled = await Promise.race([run.then(() => true), nextTurn(false)]);

  assert.equal(settled, true);
  assert.equal(sent.length, 0);
});
