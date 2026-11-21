import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { it } from "node:test";
import type { GeminiProviderConfig } from "../../src/config.js";
import { createGeminiAuth } from "../../src/gemini-auth.js";
import { createGeminiAccountBlockLatch } from "../../src/gemini-errors.js";
import { createGeminiHandler, type GeminiHandlerDeps } from "../../src/gemini-handler.js";
import { ReasoningCache } from "../../src/reasoning-cache.js";
import { ok } from "../../src/result.js";

const host = "https://daily-cloudcode-pa.googleapis.com";
const bootstrapUrl = `${host}/v1internal:loadCodeAssist`;
const generateUrl = `${host}/v1internal:streamGenerateContent?alt=sse`;
const clientBearer = "Bearer PRIVATE-CLAUDE-FIXTURE";
const access = `fixture-${randomUUID()}`;
const refresh = `fixture-${randomUUID()}`;
const project = "private-fixture-project";
const provider: GeminiProviderConfig = {
  optedIn: true, baseUrl: `${host}/`, aliases: {}, requestTimeoutMs: 5000, streamIdleTimeoutMs: 5000,
  signatureCache: { maxEntries: 8, maxBytes: 4096 },
};
const request = { model: "gemini-fixture", messages: [{ role: "user", content: "hello" }] };
const client = { headers: { authorization: clientBearer, cookie: "PRIVATE-CLIENT-COOKIE" } } as unknown as IncomingMessage;
const sse = (...frames: readonly object[]) => new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(""), {
  headers: { "content-type": "text/event-stream" },
});
const candidate = (parts: readonly object[]) => ({ response: { candidates: [{ content: { parts }, finishReason: "STOP" }] } });
const reply = () => sse(candidate([{ text: "hello" }]));

class ClientResponse extends EventEmitter {
  status = 0;
  headers: Record<string, string> = {};
  body = "";
  get headersSent() { return this.status !== 0; }
  get writableEnded() { return this.writableFinished; }
  writableFinished = false;
  destroyed = false;
  writeHead(status: number, headers: Record<string, string>) { this.status = status; this.headers = headers; }
  write(chunk: string) { this.body += chunk; return true; }
  end(chunk = "") { this.write(chunk); this.writableFinished = true; }
}

const rig = (generate: typeof fetch, overrides: Partial<GeminiHandlerDeps> = {}, qualify = true) => {
  const accountBlock = createGeminiAccountBlockLatch();
  const logs: unknown[] = [];
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const reads: string[] = [];
  const logger: GeminiHandlerDeps["logger"] = { log: (_level, event, fields) => logs.push({ event, fields }) };
  const auth = createGeminiAuth({ now: () => Date.parse("2026-01-01"), accountBlock, logger, register: () => true,
    reader: {
      probe: async () => { reads.push("probe"); return ok({ modifiedAtMs: 1 }); },
      readSecret: async () => {
        reads.push("read");
        const record = { token: { access_token: access, refresh_token: refresh, expiry: "2027-01-01T00:00:00Z" } };
        return ok(`go-keyring-base64:${Buffer.from(JSON.stringify(record)).toString("base64")}`);
      },
    },
  });
  const handler = createGeminiHandler({ provider, auth, accountBlock, logger, signatures: new ReasoningCache(8, 4096, true),
    fetchRaw: async (url, init) => { calls.push({ url: String(url), init }); return Response.json(project); },
    fetchImpl: async (url, init) => { calls.push({ url: String(url), init }); return generate(url, init); },
    clock: { schedule: () => () => undefined },
    ...(qualify ? { extractProjectId: (value: unknown) => value === project ? project : undefined } : {}), ...overrides,
  });
  const send = async (body: Record<string, unknown> = request) => {
    const res = new ClientResponse();
    await handler.handleMessages(client, res as unknown as ServerResponse, Buffer.from(JSON.stringify(body)), body, request.model);
    return res;
  };
  return { handler, send, calls, reads, accountBlock, logs };
};

it("posts the prepared frame with only the Gemini headers and aggregates the reply", async () => {
  const { send, calls } = rig(async () => reply());
  const res = await send();
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body).content, [{ type: "text", text: "hello" }]);
  assert.deepEqual(calls.map(call => call.url), [bootstrapUrl, generateUrl]);
  const init = calls[1]?.init;
  assert.equal(init?.method, "POST");
  const headers = new Headers(init?.headers);
  assert.deepEqual([...headers.keys()], ["accept", "authorization", "content-type", "user-agent"]);
  assert.equal(headers.get("authorization"), `Bearer ${access}`);
  assert.equal(headers.get("accept"), "text/event-stream");
  assert.equal(headers.get("content-type"), "application/json");
  const { requestId, ...frame } = JSON.parse(String(init?.body));
  assert.equal(typeof requestId, "string");
  assert.deepEqual(frame, { project, request: { contents: [{ role: "user", parts: [{ text: "hello" }] }] } });
});

it("rejects an image or a missing signature before any Keychain read or HTTP call", async () => {
  const { send, calls, reads } = rig(async () => reply());
  const image = await send({ ...request, messages: [{ role: "user", content: [{ type: "image" }] }] });
  assert.equal(image.status, 400);
  const missing = await send({ ...request, messages: [...request.messages, { role: "assistant", content: [
    { type: "tool_use", id: "toolu_subswitch_gemini_s_YQ", name: "Read", input: {} },
  ] }] });
  assert.equal(missing.status, 409);
  assert.deepEqual(reads, []);
  assert.deepEqual(calls, []);
});

it("does not generate when the default bootstrap extractor refuses the project", async () => {
  const { send, calls, logs } = rig(async () => reply(), {}, false);
  const res = await send();
  assert.equal(res.status, 500);
  assert.deepEqual(calls.map(call => call.url), [bootstrapUrl]);
  assert.deepEqual(logs, [{ event: "gemini_credential_load_failed", fields: { errorCode: "bootstrap_project" } }]);
});

it("TP-18: forbids redirects and returns a fixed reply without a redirect header", async () => {
  const { send, calls, logs } = rig(async () => Response.redirect("https://example.invalid/private-redirect", 302));
  const res = await send();
  assert.equal(res.status, 502);
  assert.equal(res.headers.location, undefined);
  assert.equal(JSON.parse(res.body).error.message, "Gemini did not complete the request. Retry later.");
  assert.deepEqual(calls.map(call => call.init?.redirect), ["error", "error"]);
  assert.deepEqual(logs, [{ event: "gemini_upstream_error", fields: { errorCode: "upstream_error" } }]);
});

it("TP-35: latches both a TOS 403 and an unknown 403 in HTTP or SSE", async () => {
  for (const mode of ["http", "stream"] as const) {
    for (const reason of ["TOS_VIOLATION", "PRIVATE-UNKNOWN-403"]) {
      const frame = { error: { code: 403, details: [{ reason }], message: "PRIVATE-ERROR-FIXTURE" } };
      const { send, calls, reads, accountBlock, logs } = rig(async () => mode === "http"
        ? new Response(reason === "TOS_VIOLATION" ? JSON.stringify(frame) : "PRIVATE-NON-JSON", { status: 403 })
        : sse(frame));
      const res = await send({ ...request, stream: mode === "stream" });
      assert.match(res.body, /Gemini account access is blocked/);
      assert.equal(accountBlock.isBlocked(), true);
      assert.equal((await send()).status, 403);
      assert.deepEqual(calls.map(call => call.url), [bootstrapUrl, generateUrl]);
      assert.deepEqual(reads, ["probe", "read"]);
      assert.doesNotMatch(`${res.body}${JSON.stringify(logs)}`, /PRIVATE-|NaN/);
    }
  }
});

it("keeps only a valid retry-after and returns a fixed error for an empty success reply", async () => {
  const { send } = rig(async () => new Response(null, { status: 429, headers: {
    "retry-after": "120", "x-upstream-detail": "PRIVATE-HEADER", location: "https://example.invalid/private",
  } }));
  const limited = await send();
  assert.equal(limited.status, 429);
  assert.equal(limited.headers["retry-after"], "120");
  assert.equal(limited.headers["x-upstream-detail"], undefined);
  assert.equal(limited.headers.location, undefined);

  const empty = await rig(async () => new Response(null)).send();
  assert.equal(empty.status, 502);
  assert.equal(JSON.parse(empty.body).error.message, "Gemini did not complete the request. Retry later.");
});

it("replays a signed tool call for the same conversation without another bootstrap", async () => {
  const signature = "PRIVATE-TOOL-SIGNATURE";
  let attempts = 0;
  const { send, calls } = rig(async () => ++attempts === 1 ? sse(candidate([
    { functionCall: { id: "a", name: "Read", args: { path: "a" } }, thoughtSignature: signature },
  ])) : reply());
  const first = await send();
  assert.equal(first.status, 200);
  assert.doesNotMatch(first.body, /PRIVATE-TOOL-SIGNATURE/);
  const content = JSON.parse(first.body).content;
  const result = { type: "tool_result", tool_use_id: content[0].id, content: "file data" };
  const next = await send({ ...request, messages: [...request.messages,
    { role: "assistant", content }, { role: "user", content: [result] }] });
  assert.equal(next.status, 200);
  assert.deepEqual(calls.map(call => call.url), [bootstrapUrl, generateUrl, generateUrl]);
  assert.deepEqual(JSON.parse(String(calls[2]?.init?.body)).request.contents.slice(1), [
    { role: "model", parts: [{ functionCall: { id: "a", name: "Read", args: { path: "a" } }, thoughtSignature: signature }] },
    { role: "model", parts: [{ functionResponse: { id: "a", name: "Read", response: { output: "file data" } } }] },
  ]);
});

it("clears the project after a generate 4xx and checks the project again on the next request", async () => {
  let attempts = 0;
  const { send, calls } = rig(async () => ++attempts === 1 ? new Response(null, { status: 400 }) : reply());
  assert.equal((await send()).status, 502);
  assert.equal((await send()).status, 200);
  assert.deepEqual(calls.map(call => call.url), [bootstrapUrl, generateUrl, bootstrapUrl, generateUrl]);
});

it("keeps a rejected credential load at 500 without its cause text", async () => {
  const rejected = async () => { throw new Error("fixture private error"); };
  const { send, logs } = rig(async () => reply(), { auth: {
    refreshable: true, getCredentials: rejected, forceRefresh: rejected,
  } });
  const res = await send();
  assert.equal(res.status, 500);
  assert.match(res.body, /Gemini could not load the sign-in/);
  assert.doesNotMatch(JSON.stringify(logs) + res.body, /fixture private error/);
});

it("renders a transport interruption through the fixed Gemini error table in both reply modes", async () => {
  for (const stream of [false, true]) {
    const { send } = rig(async () => new Response(new ReadableStream({
      start(controller) { controller.error(new Error("private transport detail")); },
    })));
    const res = await send({ ...request, stream });
    assert.equal(res.status, stream ? 200 : 502);
    assert.match(res.body, /Gemini did not complete the request\. Retry later\./);
    assert.doesNotMatch(res.body, /private transport detail/);
  }
});

it("keeps count_tokens local and refuses requests when not opted in", async () => {
  const active = rig(async () => reply());
  const count = new ClientResponse();
  active.handler.handleCountTokens(client, count as unknown as ServerResponse, Buffer.from("a local request"));
  assert.equal(count.status, 200);
  assert.ok(JSON.parse(count.body).input_tokens > 0);
  assert.deepEqual(active.reads, []);
  assert.deepEqual(active.calls, []);
  const disabled = rig(async () => reply(), { provider: { ...provider, optedIn: false } });
  assert.equal((await disabled.send()).status, 400);
  const offCount = new ClientResponse();
  disabled.handler.handleCountTokens(client, offCount as unknown as ServerResponse, Buffer.from("local"));
  assert.equal(offCount.status, 400);
  assert.deepEqual(disabled.reads, []);
  assert.deepEqual(disabled.calls, []);
});
