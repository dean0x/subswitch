import assert from "node:assert/strict";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { PassThrough, Transform } from "node:stream";
import { it } from "node:test";
import type { LimitObservation } from "../../src/limit-observation.js";
import type { Logger } from "../../src/logger.js";
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

it("limits aggregate frames by UTF-8 bytes", async () => {
  const res = response();
  await runTranslatedLeg(res, options({ maxAggregateBytes: 3, fetchImpl: async () => new Response("éé"),
    aggregateFrames: () => assert.fail("An incomplete response must not reach the aggregator"),
  }));
  assert.equal(res.statusCode, 502);
});

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
    auth: {
      ...options().auth,
      getCredentials: async () => {
        throw Object.assign(new Error("fixture credential source detail"), { name: "FixtureLoadError" });
      },
    },
    logger: { log: (level, event, fields) => logs.push({ level, event, fields }) },
    fetchImpl,
  }));

  assert.equal(res.statusCode, 500);
  assert.equal(end.mock.calls[0]?.arguments[0],
    '{"type":"error","error":{"type":"api_error","message":"fixture credential load failed"}}');
  assert.equal(fetchImpl.mock.callCount(), 0);
  assert.deepEqual(logs, [
    { level: "error", event: "fixture_credential_load_failed", fields: { model: "fixture-model", errorCode: "FixtureLoadError" } },
  ]);
});

for (const step of ["getCredentials", "forceRefresh"] as const) {
  it(`logs unknown and returns a fixed 500 when ${step} rejects with text`, async (t) => {
    const rejectedText = "FAKE-CREDENTIAL-TEXT";
    const res = response();
    const end = t.mock.method(res, "end");
    const log = t.mock.fn<Logger["log"]>();
    const fetchImpl = t.mock.fn(async () => new Response("denied", { status: 401 }));
    const refreshable = step === "forceRefresh";
    await runTranslatedLeg(res, options({
      auth: { ...options().auth, refreshable, [step]: () => Promise.reject(rejectedText) },
      logger: { log }, fetchImpl,
    }));

    assert.equal(res.statusCode, 500);
    assert.equal(end.mock.calls[0]?.arguments[0],
      '{"type":"error","error":{"type":"api_error","message":"fixture credential load failed"}}');
    assert.equal(fetchImpl.mock.callCount(), refreshable ? 1 : 0);
    const logs = log.mock.calls.map(({ arguments: args }) => args);
    assert.equal(JSON.stringify(logs).includes(rejectedText), false, "log fields must not contain the rejection text");
    const failures = logs.filter(([level, event]) => level !== "warn" || event !== "fixture_upstream_401_refreshing");
    assert.deepEqual(failures, [
      ["error", "fixture_credential_load_failed", { model: "fixture-model", errorCode: "unknown" }],
    ]);
  });
}

for (const rejectedBy of ["prepareBody", "upstream"] as const) {
  it(`prepares the body again with the refreshed credential after a 401 from ${rejectedBy}`, async (t) => {
    const res = response();
    const getCredentials = t.mock.fn(async (_signal: AbortSignal) => ok("initial"));
    const forceRefresh = t.mock.fn(async (_signal: AbortSignal, _failed: string) => ok("renewed"));
    const prepareBody = t.mock.fn(async (credential: string, _signal: AbortSignal) =>
      rejectedBy === "prepareBody" && credential === "initial"
        ? err({ kind: "unauthorized" as const })
        : ok({ input: `prepared with ${credential}` }));
    const fetchImpl = t.mock.fn<typeof fetch>(async (_url, init) =>
      rejectedBy === "upstream" && init?.body === '{"input":"prepared with initial"}'
        ? new Response("denied", { status: 401 })
        : new Response("frame"));

    await runTranslatedLeg(res, options({
      auth: { refreshable: true, getCredentials, forceRefresh }, prepareBody, fetchImpl,
    }));

    assert.equal(forceRefresh.mock.callCount(), 1);
    const signal = getCredentials.mock.calls[0]?.arguments[0];
    assert.ok(signal instanceof AbortSignal);
    assert.deepEqual(forceRefresh.mock.calls[0]?.arguments, [signal, "initial"]);
    assert.deepEqual(prepareBody.mock.calls.map(({ arguments: args }) => args), [["initial", signal], ["renewed", signal]]);
    assert.deepEqual(fetchImpl.mock.calls.map(({ arguments: [, init] }) => [init?.headers, init?.body]), [
      ...(rejectedBy === "upstream" ? [[{ "x-fixture-auth": "initial" }, '{"input":"prepared with initial"}']] : []),
      [{ "x-fixture-auth": "renewed" }, '{"input":"prepared with renewed"}'],
    ]);
    assert.equal(res.statusCode, 200);
  });
}

for (const [refreshable, rejects] of [
  [false, ["prepareBody"]],
  [true, ["prepareBody", "prepareBody"]],
  [true, ["prepareBody", "upstream"]],
  [true, ["upstream", "prepareBody"]],
] as const) {
  it(`stops after ${rejects.join(" then ")} rejects the credential (refreshable: ${refreshable})`, async (t) => {
    const res = response();
    const end = t.mock.method(res, "end");
    const forceRefresh = t.mock.fn(async () => ok("renewed"));
    const prepareBody = t.mock.fn(async (credential: string) =>
      rejects[credential === "initial" ? 0 : 1] === "prepareBody"
        ? err({ kind: "unauthorized" as const })
        : ok({ input: "prepared" }));
    const fetchImpl = t.mock.fn(async () => new Response("denied", { status: 401 }));
    const logs: string[] = [];

    await runTranslatedLeg(res, options({
      auth: { ...options().auth, refreshable, forceRefresh }, prepareBody, fetchImpl,
      logger: { log: (_level, event) => logs.push(event) },
    }));

    assert.equal(forceRefresh.mock.callCount(), refreshable ? 1 : 0);
    assert.equal(prepareBody.mock.callCount(), rejects.length);
    assert.equal(fetchImpl.mock.callCount(), rejects.some((source) => source === "upstream") ? 1 : 0);
    assert.equal(res.statusCode, 401);
    assert.equal(end.mock.calls[0]?.arguments[0], rejects.at(-1) === "prepareBody"
      ? '{"type":"error","error":{"type":"authentication_error","message":"fixture request unauthorized"}}'
      : '{"type":"error","error":{"type":"api_error","message":"upstream rejected request"}}');
    assert.deepEqual(logs, [
      ...(refreshable ? ["fixture_upstream_401_refreshing"] : []),
      ...(rejects.at(-1) === "upstream" ? ["fixture_upstream_error"] : []),
    ]);
  });
}

for (const hasCodeSet of [false, true]) {
  it(`logs unknown and returns a 500 for an undeclared prepareBody code (code set: ${hasCodeSet})`, async (t) => {
    const res = response();
    const log = t.mock.fn<Logger["log"]>();
    const prepareErrorCodes = new Set(["fixture_failed"]);

    await runTranslatedLeg(res, options({
      prepareBody: async () => err({ kind: "failed", errorCode: "fixture_undeclared" }),
      ...(hasCodeSet ? { prepareErrorCodes } : {}),
      logger: { log },
    }));

    assert.equal(res.statusCode, 500);
    assert.deepEqual(log.mock.calls.map(({ arguments: args }) => args), [
      ["error", "fixture_credential_load_failed", { model: "fixture-model", errorCode: "unknown" }],
    ]);
  });
}

for (const failure of ["result", "rejection", "throw"] as const) {
  it(`logs only the error code for a prepareBody ${failure} and returns a 500 without a fetch`, async (t) => {
    const res = response();
    const end = t.mock.method(res, "end");
    const fetchImpl = t.mock.fn(async () => new Response("frame"));
    const logs: unknown[] = [];
    const prepareBody = () => {
      const cause = new Error("fake fixture detail");
      if (failure === "throw") throw cause;
      if (failure === "rejection") return Promise.reject(cause);
      return Promise.resolve(err({ kind: "failed" as const, errorCode: "fixture_failed", detail: cause.message }));
    };

    await runTranslatedLeg(res, options({
      auth: { ...options().auth, refreshable: true }, prepareBody, prepareErrorCodes: new Set(["fixture_failed"]), fetchImpl,
      logger: { log: (level, event, fields) => logs.push({ level, event, fields }) },
    }));

    assert.equal(res.statusCode, 500);
    assert.equal(end.mock.calls[0]?.arguments[0],
      '{"type":"error","error":{"type":"api_error","message":"fixture credential load failed"}}');
    assert.equal(fetchImpl.mock.callCount(), 0);
    assert.deepEqual(logs, [{
      level: "error", event: "fixture_credential_load_failed",
      fields: { model: "fixture-model", errorCode: failure === "result" ? "fixture_failed" : "Error" },
    }]);
  });
}

for (const source of ["result", "exception"] as const) {
  it(`does not report undeclared text from a preparation ${source}`, async () => {
    const res = response();
    const codes: unknown[] = [];
    const prepareBody = async () => {
      const detail = "FAKE-PREPARE-DETAIL";
      if (source === "exception") throw Object.assign(new Error(detail), { name: detail });
      return err({ kind: "failed" as const, errorCode: detail });
    };
    await runTranslatedLeg(res, options({
      prepareBody, logger: { log: (_level, _event, fields) => codes.push(fields?.errorCode) },
    }));
    assert.equal(res.statusCode, 500);
    assert.equal(codes.length, 1);
    assert.equal(codes[0] === "unknown", true);
  });
}

it("does not start another credential step after close while it discards a 401", { timeout: 1000 }, async (t) => {
  const res = response();
  const prepareBody = t.mock.fn(async () => ok({ input: "prepared" }));
  const forceRefresh = t.mock.fn(async () => ok("renewed"));
  const fetchImpl = t.mock.fn(async () => new Response(new ReadableStream({
    cancel: () => { res.emit("close"); return new Promise<void>(() => {}); },
  }), { status: 401 }));
  await runTranslatedLeg(res, options({
    auth: { ...options().auth, refreshable: true, forceRefresh }, prepareBody, fetchImpl,
  }));
  assert.equal(res.statusCode, 504);
  assert.equal(forceRefresh.mock.callCount(), 0);
  assert.equal(prepareBody.mock.callCount(), 1);
  assert.equal(fetchImpl.mock.callCount(), 1);
});

it("ends a pending prepareBody wait on close with a timeout and no log or fetch", { timeout: 1000 }, async (t) => {
  const res = response();
  const end = t.mock.method(res, "end");
  const fetchImpl = t.mock.fn(async () => new Response("frame"));
  const log = t.mock.fn();
  let cancelWait: (cause: Error) => void = () => assert.fail("Preparation did not start");
  const run = runTranslatedLeg(res, options({
    prepareBody: () => new Promise((_resolve, reject) => { cancelWait = reject; }),
    logger: { log }, fetchImpl,
  }));
  await new Promise<void>((resolve) => setImmediate(resolve));
  res.emit("close");
  const settled = await Promise.race([run.then(() => true), new Promise<boolean>((resolve) => setImmediate(resolve, false))]);

  assert.equal(res.statusCode, 504);
  assert.equal(settled, true, "the runner must not wait for preparation after close");
  assert.equal(end.mock.calls[0]?.arguments[0],
    '{"type":"error","error":{"type":"api_error","message":"fixture request timed out"}}');
  cancelWait(new Error("fake fixture detail"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(log.mock.callCount(), 0);
  assert.equal(fetchImpl.mock.callCount(), 0);
  assert.equal(res.listenerCount("close"), 0);
});

it("does not log or fetch after prepareBody fails on an already aborted signal", async (t) => {
  const res = response();
  const fetchImpl = t.mock.fn(async () => new Response("frame"));
  const log = t.mock.fn();

  await runTranslatedLeg(res, options({
    prepareBody: async () => {
      res.emit("close");
      return err({ kind: "failed", errorCode: "fixture_failed" });
    },
    logger: { log }, fetchImpl,
  }));

  assert.equal(res.statusCode, 504);
  assert.equal(log.mock.callCount(), 0);
  assert.equal(fetchImpl.mock.callCount(), 0);
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
    auth: {
      ...options().auth,
      refreshable: true,
      forceRefresh: async () => {
        throw Object.assign(new Error("fixture refresh source detail"), { name: "FixtureRefreshError" });
      },
    },
    logger: { log: (level, event, fields) => logs.push({ level, event, fields }) },
    fetchImpl,
  }));

  assert.equal(res.statusCode, 500);
  assert.equal(end.mock.calls[0]?.arguments[0],
    '{"type":"error","error":{"type":"api_error","message":"fixture credential load failed"}}');
  assert.equal(fetchImpl.mock.callCount(), 1);
  assert.deepEqual(logs, [
    { level: "warn", event: "fixture_upstream_401_refreshing", fields: { model: "fixture-model" } },
    { level: "error", event: "fixture_credential_load_failed", fields: { model: "fixture-model", errorCode: "FixtureRefreshError" } },
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
