import assert from "node:assert/strict";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { PassThrough } from "node:stream";
import { it } from "node:test";
import type { LimitObservation } from "../../src/limit-observation.js";
import { err, ok } from "../../src/result.js";
import { runTranslatedLeg, type TranslatedLegOptions } from "../../src/translated-leg.js";
import { sampleLimitKey } from "../fixtures/limit-context.js";

const options = (overrides: Partial<TranslatedLegOptions<string>> = {}): TranslatedLegOptions<string> => ({
  url: "https://upstream.invalid/stream",
  model: "fixture-model",
  name: "fixture",
  body: { input: "hello" },
  wantStream: false,
  requestTimeoutMs: 5_000,
  streamIdleTimeoutMs: 5_000,
  maxAggregateBytes: 1024,
  logger: { log() {} },
  events: {
    upstream401Refreshing: "fixture_upstream_401_refreshing",
    retryBoundViolated: "fixture_retry_bound_violated",
    upstreamError: "fixture_upstream_error",
    streamInterrupted: "fixture_stream_interrupted",
  },
  auth: {
    refreshable: false,
    getCredentials: async () => ok("initial"),
    forceRefresh: async () => assert.fail("Unexpected refresh"),
  },
  buildHeaders: (credential) => ({ "x-fixture-auth": credential }),
  fetchImpl: async () => new Response("frame"),
  createTranslator: () => ({ parser: new PassThrough(), translator: new PassThrough() }),
  aggregateFrames: (frames) => ok({ kind: "message", message: { text: frames.join("") } }),
  renderUpstreamError: (status) => ({ status, type: "api_error", message: "upstream rejected request" }),
  ...overrides,
});

const response = (): ServerResponse => {
  const res = new ServerResponse(new IncomingMessage(new Socket()));
  res.setHeader("x-test", "1");
  return res;
};

it("sets the close listener before credential load", async () => {
  const res = response();
  const { auth } = options();
  let aborted = false;
  let fetchCalls = 0;
  await runTranslatedLeg(res, options({
    auth: {
      ...auth,
      getCredentials: async (signal) => {
        res.emit("close");
        aborted = signal.aborted;
        return err({ kind: "auth", message: "cancelled" });
      },
    },
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response("frame");
    },
  }));

  assert.equal(aborted, true);
  assert.equal(fetchCalls, 0);
  assert.equal(res.listenerCount("close"), 0);
});

it("sets redirect on the injected POST without replacing its headers or signal", async () => {
  const requests: { url: string; init?: RequestInit }[] = [];
  const { auth } = options();
  let credentialSignal: AbortSignal | undefined;
  const res = response();
  await runTranslatedLeg(res, options({
    auth: {
      ...auth,
      getCredentials: async (signal) => {
        credentialSignal = signal;
        return ok("initial");
      },
    },
    redirect: "error",
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), ...(init ? { init } : {}) });
      return new Response("frame");
    },
  }));

  assert.equal(res.statusCode, 200);
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.equal(request?.url, "https://upstream.invalid/stream");
  assert.ok(credentialSignal instanceof AbortSignal);
  assert.deepEqual(request?.init, {
    method: "POST", headers: { "x-fixture-auth": "initial" }, body: '{"input":"hello"}',
    redirect: "error", signal: credentialSignal,
  });
  assert.equal(request?.init?.signal, credentialSignal);
});

it("aborts a request before headers at the total bound and adds the timeout headers", { timeout: 1000 }, async (t) => {
  const res = response();
  const keepAlive = setTimeout(() => undefined, 1000);
  t.after(() => clearTimeout(keepAlive));
  await runTranslatedLeg(res, options({
    requestTimeoutMs: 20,
    proxyErrorHeaders: (kind) => kind === "timeout" ? { "x-should-retry": "false" } : undefined,
    fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }),
  }));

  assert.equal(res.statusCode, 504);
  assert.equal(res.getHeader("x-should-retry"), "false");
  assert.equal(res.listenerCount("close"), 0);
});

it("aborts a stalled body at the idle bound", { timeout: 1000 }, async (t) => {
  const res = response();
  const keepAlive = setTimeout(() => undefined, 1000);
  t.after(() => clearTimeout(keepAlive));
  await runTranslatedLeg(res, options({
    streamIdleTimeoutMs: 20,
    fetchImpl: async (_url, init) => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("frame"));
        init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true });
      },
    })),
  }));

  assert.equal(res.statusCode, 502);
  assert.equal(res.listenerCount("close"), 0);
});

it("rejects an over-limit aggregate instead of sending partial content", async () => {
  const res = response();
  await runTranslatedLeg(res, options({
    maxAggregateBytes: 4,
    aggregateFrames: () => assert.fail("Unexpected aggregate"),
  }));

  assert.equal(res.statusCode, 502);
});

it("reports one upstream 401 and retries only with a renewable credential", async () => {
  for (const refreshable of [false, true]) {
    const attempts: RequestInit["headers"][] = [];
    const logs: unknown[] = [];
    const res = response();
    const { auth } = options();
    await runTranslatedLeg(res, options({
      auth: { ...auth, refreshable, forceRefresh: async () => ok("renewed") },
      logger: { log: (level, event, fields) => logs.push({ level, event, fields }) },
      fetchImpl: async (_url, init) => {
        assert.ok(init && !Object.hasOwn(init, "redirect"));
        attempts.push(init.headers);
        return new Response("denied", { status: 401 });
      },
    }));

    assert.equal(res.statusCode, 401);
    assert.deepEqual(logs, [
      ...(refreshable ? [{ level: "warn", event: "fixture_upstream_401_refreshing", fields: { model: "fixture-model" } }] : []),
      { level: "warn", event: "fixture_upstream_error", fields: { model: "fixture-model", status: 401 } },
    ]);
    assert.deepEqual(attempts, refreshable
      ? [{ "x-fixture-auth": "initial" }, { "x-fixture-auth": "renewed" }]
      : [{ "x-fixture-auth": "initial" }]);
  }
});

it("uses one optional limit key for HTTP and SSE observations", async () => {
  const records: LimitObservation[] = [];
  const logger = { log() {}, recordLimit: (record: LimitObservation) => records.push(record) };
  const body = '{"type":"error","error":{"code":"rate_limit_error","status":429}}';
  for (const limitKey of [{}, { limitKey: sampleLimitKey }]) {
    await runTranslatedLeg(response(), options({ ...limitKey, logger, fetchImpl: async () => new Response(body, { status: 429 }) }));
    await runTranslatedLeg(response(), options({ ...limitKey, logger, fetchImpl: async () => new Response(`data: ${body}\n\n`) }));
    if (!("limitKey" in limitKey)) assert.deepEqual(records, []);
  }

  assert.deepEqual(records.map(({ context, transport }) => ({ context, transport })), [
    { context: sampleLimitKey, transport: "http" },
    { context: sampleLimitKey, transport: "sse" },
  ]);
});
