import assert from "node:assert/strict";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { PassThrough, Transform } from "node:stream";
import { it } from "node:test";
import type { AnthropicErrorType } from "../../src/errors.js";
import type { LimitObservation } from "../../src/limit-observation.js";
import { err, ok } from "../../src/result.js";
import { runTranslatedLeg, type TranslatedLegOptions } from "../../src/translated-leg.js";
import { sampleLimitKey } from "../fixtures/limit-context.js";

const requiresExplicitRedirectPolicy = (
  res: ServerResponse,
  options: Omit<TranslatedLegOptions<string>, "redirect">,
): void => {
  // @ts-expect-error Callers must select a redirect policy.
  void runTranslatedLeg(res, options);
};
void requiresExplicitRedirectPolicy;

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
    credentialLoadFailed: "fixture_credential_load_failed",
  },
  auth: {
    refreshable: false,
    getCredentials: async () => ok("initial"),
    forceRefresh: async () => assert.fail("Unexpected refresh"),
  },
  buildHeaders: (credential) => ({ "x-fixture-auth": credential }),
  fetchImpl: async () => new Response("frame"),
  redirect: "follow",
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

it("ends a pending credential wait on client close without a fetch", async (t) => {
  const res = response();
  const { auth } = options();
  const fetchImpl = t.mock.fn(async () => new Response("frame"));
  const logs: unknown[] = [];
  const run = runTranslatedLeg(res, options({
    auth: { ...auth, getCredentials: () => new Promise(() => {}) },
    logger: { log: (level, event, fields) => logs.push({ level, event, fields }) },
    fetchImpl,
  }));
  res.destroy();
  res.emit("close");
  const settled = await Promise.race([run.then(() => true), new Promise<boolean>((resolve) => setImmediate(resolve, false))]);

  assert.equal(settled, true, "the runner must settle after close");
  assert.equal(fetchImpl.mock.callCount(), 0);
  assert.equal(res.listenerCount("close"), 0);
  assert.deepEqual(logs, [], "a cancelled credential wait is not a fault");
});

it("logs the cause name and returns a 500 without a fetch when the credential source throws", async (t) => {
  const res = response();
  const end = t.mock.method(res, "end");
  const fetchImpl = t.mock.fn(async () => new Response("frame"));
  const logs: unknown[] = [];
  await runTranslatedLeg(res, options({
    auth: { ...options().auth, getCredentials: async () => { throw new Error("fixture credential source detail"); } },
    logger: { log: (level, event, fields) => logs.push({ level, event, fields }) },
    fetchImpl,
  }));

  assert.equal(res.statusCode, 500);
  assert.equal(end.mock.calls[0]?.arguments[0],
    '{"type":"error","error":{"type":"api_error","message":"fixture credential load failed"}}');
  assert.equal(fetchImpl.mock.callCount(), 0);
  assert.deepEqual(logs, [
    { level: "error", event: "fixture_credential_load_failed", fields: { model: "fixture-model", errorCode: "Error" } },
  ]);
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

it("ends a failed stream with an SSE error event", async (t) => {
  const res = response();
  const write = t.mock.method(res, "write");
  await runTranslatedLeg(res, options({
    wantStream: true,
    createTranslator: () => ({
      parser: new PassThrough(),
      translator: new Transform({ transform: (_chunk, _encoding, done) => done(new Error("fixture stream failure")) }),
    }),
  }));

  assert.equal(res.statusCode, 200);
  assert.equal(res.writableEnded, true);
  assert.deepEqual(write.mock.calls.map(({ arguments: [frame] }) => frame), [
    'event: error\ndata: {"type":"error","error":{"type":"api_error","message":"fixture stream interrupted"}}\n\n',
  ]);
});

it("returns a 502 with the error from a completed aggregate", async (t) => {
  const res = response();
  const end = t.mock.method(res, "end");
  await runTranslatedLeg(res, options({
    aggregateFrames: () => ok({ kind: "error", errorType: "api_error", message: "fixture aggregate error" }),
  }));

  assert.equal(res.statusCode, 502);
  assert.equal(end.mock.calls[0]?.arguments[0],
    '{"type":"error","error":{"type":"api_error","message":"fixture aggregate error"}}');
});

it("adds the caller's headers for the error type to the 502 from a completed aggregate", async () => {
  const noRetry = (type: AnthropicErrorType) => type === "invalid_request_error" ? { "x-should-retry": "false" } : undefined;
  const cases: readonly [AnthropicErrorType, Partial<TranslatedLegOptions<string>>, string | undefined][] = [
    ["invalid_request_error", { aggregateErrorHeaders: noRetry }, "false"],
    ["api_error", { aggregateErrorHeaders: noRetry }, undefined],
    ["invalid_request_error", {}, undefined],
  ];
  for (const [errorType, extra, expected] of cases) {
    const res = response();
    await runTranslatedLeg(res, options({
      ...extra, aggregateFrames: () => ok({ kind: "error", errorType, message: "fixture aggregate error" }),
    }));
    assert.equal(res.statusCode, 502);
    assert.equal(res.getHeader("x-should-retry"), expected, `${errorType} ${Object.keys(extra).join()}`);
  }
});

it("returns an upstream unreachable 502 when fetch rejects without an abort", async (t) => {
  const res = response();
  const end = t.mock.method(res, "end");
  await runTranslatedLeg(res, options({ fetchImpl: async () => { throw new Error("fixture network error"); } }));

  assert.equal(res.statusCode, 502);
  assert.equal(end.mock.calls[0]?.arguments[0],
    '{"type":"error","error":{"type":"api_error","message":"fixture upstream unreachable"}}');
});

it("sends the refresh error after an upstream 401 and makes no second request", async (t) => {
  const res = response();
  const end = t.mock.method(res, "end");
  const fetchImpl = t.mock.fn(async () => new Response("denied", { status: 401 }));
  await runTranslatedLeg(res, options({
    auth: { ...options().auth, refreshable: true, forceRefresh: async () => err({ kind: "auth", message: "fixture refresh failed" }) },
    fetchImpl,
  }));

  assert.equal(res.statusCode, 401);
  assert.equal(end.mock.calls[0]?.arguments[0],
    '{"type":"error","error":{"type":"authentication_error","message":"fixture refresh failed"}}');
  assert.equal(fetchImpl.mock.callCount(), 1);
});

it("ends a forced refresh wait on client close with the timeout reply", async (t) => {
  const res = response();
  const fetchImpl = t.mock.fn(async () => new Response("denied", { status: 401 }));
  const logs: unknown[] = [];
  let refreshArgs: { signal: AbortSignal; failed: string } | undefined;
  let refreshStarted = (): void => undefined;
  const started = new Promise<void>((resolve) => { refreshStarted = resolve; });
  const run = runTranslatedLeg(res, options({
    auth: {
      ...options().auth,
      refreshable: true,
      forceRefresh: (signal, failed) => {
        refreshArgs = { signal, failed };
        refreshStarted();
        return new Promise(() => {});
      },
    },
    logger: { log: (level, event, fields) => logs.push({ level, event, fields }) },
    fetchImpl,
  }));
  await started;
  res.emit("close");
  const settled = await Promise.race([run.then(() => true), new Promise<boolean>((resolve) => setImmediate(resolve, false))]);

  assert.equal(settled, true, "the runner must not wait for the refresh after close");
  assert.equal(res.statusCode, 504);
  assert.equal(fetchImpl.mock.callCount(), 1);
  assert.ok(refreshArgs?.signal instanceof AbortSignal, "the refresh gets the request signal");
  assert.equal(refreshArgs.signal.aborted, true);
  assert.equal(refreshArgs.failed, "initial", "the refresh gets the credential that the upstream refused");
  assert.deepEqual(logs, [
    { level: "warn", event: "fixture_upstream_401_refreshing", fields: { model: "fixture-model" } },
  ], "a cancelled refresh wait is not a fault");
});

it("logs the cause name and returns a 500 when the forced refresh throws", async (t) => {
  const res = response();
  const end = t.mock.method(res, "end");
  const fetchImpl = t.mock.fn(async () => new Response("denied", { status: 401 }));
  const logs: unknown[] = [];
  await runTranslatedLeg(res, options({
    auth: { ...options().auth, refreshable: true, forceRefresh: async () => { throw new Error("fixture refresh source detail"); } },
    logger: { log: (level, event, fields) => logs.push({ level, event, fields }) },
    fetchImpl,
  }));

  assert.equal(res.statusCode, 500);
  assert.equal(end.mock.calls[0]?.arguments[0],
    '{"type":"error","error":{"type":"api_error","message":"fixture credential load failed"}}');
  assert.equal(fetchImpl.mock.callCount(), 1);
  assert.deepEqual(logs, [
    { level: "warn", event: "fixture_upstream_401_refreshing", fields: { model: "fixture-model" } },
    { level: "error", event: "fixture_credential_load_failed", fields: { model: "fixture-model", errorCode: "Error" } },
  ]);
});

it("returns a 502 when the upstream sends a 200 with no body", async (t) => {
  const res = response();
  const end = t.mock.method(res, "end");
  await runTranslatedLeg(res, options({ fetchImpl: async () => new Response(null, { status: 200 }) }));

  assert.equal(res.statusCode, 502);
  assert.equal(end.mock.calls[0]?.arguments[0],
    '{"type":"error","error":{"type":"api_error","message":"fixture upstream returned an empty body"}}');
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
