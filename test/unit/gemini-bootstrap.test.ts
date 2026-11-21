import assert from "node:assert/strict";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { PassThrough } from "node:stream";
import { it } from "node:test";
import { gzipSync } from "node:zlib";
import { createGeminiAuth } from "../../src/gemini-auth.js";
import { createGeminiBootstrap, type GeminiBootstrapDeps } from "../../src/gemini-bootstrap.js";
import { createGeminiAccountBlockLatch, geminiPrepareErrorCodes } from "../../src/gemini-errors.js";
import type { ProviderCredential } from "../../src/provider-auth.js";
import { err, ok } from "../../src/result.js";
import { runTranslatedLeg } from "../../src/translated-leg.js";

const endpoint = "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
const project = "fixture-private-project";
const credential = (access: string): ProviderCredential<"gemini"> => ({
  provider: "gemini", authHeaders: { authorization: `Bearer ${access}` },
});
const first = credential("fixture-first");
const second = credential("fixture-second");
const failed = (errorCode: string) => err({ kind: "failed", errorCode });
const validProject = (body: unknown) => body === project ? project : undefined;
const activeSignal = () => new AbortController().signal;
const projectResponse = () => Response.json(project);
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

const rig = (fetchRaw: typeof fetch, extractProjectId?: GeminiBootstrapDeps["extractProjectId"]) => {
  const accountBlock = createGeminiAccountBlockLatch();
  const deadlines = new Map<() => void, number>();
  const bootstrap = createGeminiBootstrap({
    accountBlock, fetchRaw, ...(extractProjectId === undefined ? {} : { extractProjectId }),
    clock: { schedule: (fn, ms) => { deadlines.set(fn, ms); return () => { deadlines.delete(fn); }; } },
  });
  return { ...bootstrap, accountBlock, deadlines };
};

it("shares one bootstrap per token and reuses each project for the same token", async () => {
  const calls: string[] = [];
  const { loadProject } = rig(async (url, init) => {
    assert.equal(url, endpoint);
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    const headers = new Headers(init?.headers);
    assert.equal(headers.has("x-fixture-client-session"), false);
    const bearer = headers.get("authorization");
    calls.push(String(bearer));
    return Response.json(bearer === "Bearer fixture-first" ? "first-project" : "second-project");
  }, (body) => typeof body === "string" ? body : undefined);

  const sameToken = { ...first, authHeaders: { ...first.authHeaders, "x-fixture-client-session": "local-session" } };
  const results = await Promise.all([sameToken, first, second, second].map((c) => loadProject(c, activeSignal())));
  assert.deepEqual(results, [ok("first-project"), ok("first-project"), ok("second-project"), ok("second-project")]);
  assert.deepEqual(await loadProject(sameToken, activeSignal()), ok("first-project"));
  assert.deepEqual(calls, ["Bearer fixture-first", "Bearer fixture-second"]);
});

it("refuses a new lineage at the flight limit but accepts it after a flight ends", async (t) => {
  const { promise, resolve } = deferred<void>();
  const fetchRaw = t.mock.fn(async () => { await promise; return projectResponse(); });
  const { loadProject } = rig(fetchRaw, validProject);
  const pending = Array.from({ length: 16 }, (_, i) => loadProject(credential(`fixture-${i}`), activeSignal()));
  const extra = loadProject(first, activeSignal());
  await Promise.resolve();
  const sentAtLimit = fetchRaw.mock.callCount();
  resolve();
  assert.equal(sentAtLimit, 16);
  assert.deepEqual(await extra, failed("bootstrap_busy"));
  await Promise.all(pending);
  assert.deepEqual(await loadProject(first, activeSignal()), ok(project));
  assert.equal(fetchRaw.mock.callCount(), 17);
});

it("does not send a bootstrap request without a project extractor", async (t) => {
  const fetchRaw = t.mock.fn(async () => projectResponse());
  assert.deepEqual(await rig(fetchRaw).loadProject(first, activeSignal()), failed("bootstrap_project"));
  assert.equal(fetchRaw.mock.callCount(), 0);

  assert.deepEqual(await rig(fetchRaw, validProject).loadProject(first, activeSignal()), ok(project));
  assert.equal(fetchRaw.mock.callCount(), 1);
});

it("refuses an oversized compressed body without a content length", async () => {
  // Gzip headers can carry a large comment even when the decoded body is small.
  const gzip = gzipSync(JSON.stringify(project));
  gzip[3] = 0x10;
  const raw = Buffer.concat([gzip.subarray(0, 10), Buffer.alloc(64 * 1024, 0x61), Buffer.from([0]), gzip.subarray(10)]);
  const { loadProject } = rig(async () => new Response(new Uint8Array(raw), {
    headers: { "content-encoding": "gzip" },
  }), validProject);
  assert.deepEqual(await loadProject(first, activeSignal()), failed("bootstrap_response"));
});

it("refuses an oversized decoded body", async () => {
  const raw = gzipSync(JSON.stringify(project) + " ".repeat(256 * 1024));
  const { loadProject } = rig(async () => new Response(new Uint8Array(raw), {
    headers: { "content-encoding": "gzip" },
  }), validProject);
  assert.deepEqual(await loadProject(first, activeSignal()), failed("bootstrap_response"));
});

it("decodes a small raw gzip reply within the two bounds", async () => {
  const raw = gzipSync(JSON.stringify(project));
  const { loadProject } = rig(async () => new Response(new Uint8Array(raw), {
    headers: { "content-encoding": "gzip" },
  }), validProject);
  assert.deepEqual(await loadProject(first, activeSignal()), ok(project));
});

it("refuses a redirect reply without a second call", async (t) => {
  const fetchRaw = t.mock.fn(async (_url: unknown, _init?: RequestInit) =>
    Response.redirect(`https://foreign.invalid/${project}`, 307));
  const { loadProject } = rig(fetchRaw, validProject);
  assert.deepEqual(await loadProject(first, activeSignal()), failed("bootstrap_transport"));
  assert.equal(fetchRaw.mock.calls[0]?.arguments[1]?.redirect, "error");
  assert.equal(fetchRaw.mock.callCount(), 1);
});

it("ends a hung fetch at 10 seconds and drops its flight", async (t) => {
  let sentSignal: AbortSignal | null | undefined;
  let calls = 0;
  const fetchRaw = t.mock.fn<typeof fetch>(async (_url, init) => {
    sentSignal = init?.signal;
    if (++calls === 1) return new Promise(() => {});
    return projectResponse();
  });
  const { loadProject, deadlines } = rig(fetchRaw, validProject);
  const pending = loadProject(first, activeSignal());
  await Promise.resolve();
  assert.deepEqual([...deadlines.values()], [10_000]);
  for (const fire of deadlines.keys()) fire();
  assert.deepEqual(await pending, failed("bootstrap_timeout"));
  assert.equal(sentSignal?.aborted, true);
  assert.equal(deadlines.size, 0);
  assert.deepEqual(await loadProject(first, activeSignal()), ok(project));
});

it("cancels a body that does not finish by the deadline", async () => {
  const { promise: started, resolve: onRead } = deferred<void>();
  let cancelled = false;
  const { loadProject, deadlines } = rig(async () => new Response(new ReadableStream<Uint8Array>({
    pull() { onRead(); return new Promise(() => {}); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 })), validProject);
  const pending = loadProject(first, activeSignal());
  await started;
  for (const fire of deadlines.keys()) fire();
  assert.deepEqual(await pending, failed("bootstrap_timeout"));
  assert.equal(cancelled, true);
});

it("cancels a lone request and does not use the transport for pre-aborted requests", async (t) => {
  let sentSignal: AbortSignal | null | undefined;
  const fetchRaw = t.mock.fn<typeof fetch>(async (_url, init) => {
    sentSignal = init?.signal;
    return new Promise(() => {});
  });
  const { loadProject, deadlines } = rig(fetchRaw, validProject);
  const request = new AbortController();
  const pending = loadProject(first, request.signal);
  await Promise.resolve();
  request.abort();
  assert.deepEqual(await pending, failed("bootstrap_cancelled"));
  assert.deepEqual(await loadProject(first, request.signal), failed("bootstrap_cancelled"));
  assert.equal(sentSignal?.aborted, true);
  assert.equal(fetchRaw.mock.callCount(), 1);
  assert.equal(deadlines.size, 0);
});

it("does not cancel a flight while another request waits for it", async (t) => {
  const { promise, resolve } = deferred<Response>();
  const fetchRaw = t.mock.fn<typeof fetch>(async () => promise);
  const { loadProject } = rig(fetchRaw, validProject);
  const request = new AbortController();
  const cancelled = loadProject(first, request.signal);
  const waiting = loadProject(first, activeSignal());
  request.abort();
  assert.deepEqual(await cancelled, failed("bootstrap_cancelled"));
  resolve(projectResponse());
  assert.deepEqual(await waiting, ok(project));
  assert.equal(fetchRaw.mock.callCount(), 1);
});

it("keeps a bootstrap account refusal even after the caller leaves", async () => {
  const { promise, resolve } = deferred<Response>();
  const { loadProject, accountBlock } = rig(async () => promise, validProject);
  const client = new AbortController();
  const waiting = loadProject(first, client.signal);
  await Promise.resolve();
  client.abort();
  assert.deepEqual(await waiting, failed("bootstrap_cancelled"));
  resolve(new Response(null, { status: 403 }));
  await new Promise<void>(done => setImmediate(done));
  assert.ok(accountBlock.isBlocked());
  assert.deepEqual(await loadProject(second, activeSignal()), failed("account_blocked"));
});

it("does not cache a 401 from loadCodeAssist", async () => {
  let calls = 0;
  const { loadProject } = rig(async () => ++calls === 1 ? new Response(null, { status: 401 }) : projectResponse(), validProject);
  assert.deepEqual(await loadProject(first, activeSignal()), err({ kind: "unauthorized" }));
  assert.deepEqual(await loadProject(first, activeSignal()), ok(project));
});

it("drops only the rejected lineage when the generate path invalidates a project", async (t) => {
  const fetchRaw = t.mock.fn(async () => projectResponse());
  const { loadProject, invalidate } = rig(fetchRaw, validProject);
  assert.deepEqual(await loadProject(first, activeSignal()), ok(project));
  assert.deepEqual(await loadProject(second, activeSignal()), ok(project));
  invalidate(first);
  assert.deepEqual(await loadProject(first, activeSignal()), ok(project));
  assert.deepEqual(await loadProject(second, activeSignal()), ok(project));
  assert.equal(fetchRaw.mock.callCount(), 3);
});

it("does not put a project from an invalidated flight back in the cache", async (t) => {
  const { promise, resolve } = deferred<Response>();
  let calls = 0;
  const fetchRaw = t.mock.fn<typeof fetch>(async () => ++calls === 1 ? promise : projectResponse());
  const { loadProject, invalidate } = rig(fetchRaw, validProject);
  const old = loadProject(first, activeSignal());
  await Promise.resolve();
  invalidate(first);
  resolve(Response.json("stale-project"));
  assert.deepEqual(await old, failed("bootstrap_cancelled"));
  assert.deepEqual(await loadProject(first, activeSignal()), ok(project));
  assert.equal(fetchRaw.mock.callCount(), 2);
});

for (const body of ['{"fixture":"TOS_VIOLATION"}', "not JSON"]) {
  it(`blocks later Google calls and credential reads after a 403 with ${body}`, async (t) => {
    let calls = 0;
    const fetchRaw = t.mock.fn(async () => ++calls === 1 ? projectResponse() : new Response(body, { status: 403 }));
    const { accountBlock, loadProject } = rig(fetchRaw, validProject);
    const probe = t.mock.fn(async () => err("missing" as const));
    const readSecret = t.mock.fn(async () => err("missing" as const));
    const auth = createGeminiAuth({
      accountBlock, reader: { probe, readSecret }, now: () => 0, register: () => true, logger: { log() {} },
    });

    assert.deepEqual(await loadProject(second, activeSignal()), ok(project));
    assert.deepEqual(await loadProject(first, activeSignal()), failed("account_blocked"));
    assert.deepEqual(await loadProject(second, activeSignal()), failed("account_blocked"));
    assert.deepEqual(await loadProject(credential("fixture-third"), activeSignal()), failed("account_blocked"));
    assert.equal((await auth.getCredentials(activeSignal())).ok, false);
    assert.equal(accountBlock.isBlocked(), true);
    assert.equal(fetchRaw.mock.callCount(), 2);
    assert.equal(probe.mock.callCount(), 0);
    assert.equal(readSecret.mock.callCount(), 0);
  });
}

const translatedResponse = async (fetchRaw: typeof fetch, upstream: typeof fetch) => {
  const { loadProject } = rig(fetchRaw, validProject);
  const res = new ServerResponse(new IncomingMessage(new Socket()));
  const fields: unknown[] = [];
  let reply: unknown;
  res.end = ((chunk: unknown) => { reply = chunk; return res; }) as typeof res.end;
  let retries = 0;
  await runTranslatedLeg(res, {
    auth: { refreshable: true, getCredentials: async () => ok(first), forceRefresh: async () => { retries++; return ok(second); } },
    prepareBody: async (c, signal) => {
      const result = await loadProject(c, signal);
      return result.ok ? ok({ fixture: result.value }) : result;
    },
    prepareErrorCodes: geminiPrepareErrorCodes,
    name: "Gemini", model: "fixture", url: "https://upstream.invalid/generate", body: {}, wantStream: false,
    logger: { log: (_level, _event, data) => { fields.push(data); } },
    events: {
      upstream401Refreshing: "retry", retryBoundViolated: "retry_bound", upstreamError: "upstream",
      streamInterrupted: "stream", credentialLoadFailed: "credential_failed",
    },
    redirect: "error", fetchImpl: upstream, buildHeaders: (c) => ({ ...c.authHeaders }),
    requestTimeoutMs: 5000, streamIdleTimeoutMs: 5000, maxAggregateBytes: 1024,
    createTranslator: () => ({ parser: new PassThrough(), translator: new PassThrough() }),
    aggregateFrames: () => ok({ kind: "message", message: {} }),
    renderUpstreamError: (status) => ({ status, type: "api_error", message: "fixture upstream error" }),
  });
  return { status: res.statusCode, retries, reply, fields };
};

it("shares one retry between the bootstrap and the generate call", async (t) => {
  const fetchRaw = t.mock.fn<typeof fetch>(async (_url, init) => new Headers(init?.headers).get("authorization") === "Bearer fixture-first"
    ? new Response(null, { status: 401 }) : projectResponse());
  const upstream = t.mock.fn(async () => new Response(null, { status: 401 }));
  const result = await translatedResponse(fetchRaw, upstream);
  assert.equal(result.status, 401);
  assert.equal(result.retries, 1);
  assert.equal(fetchRaw.mock.callCount(), 2);
  assert.equal(upstream.mock.callCount(), 1);
});

it("puts only the fixed preparation code in the log and no project in the reply", async (t) => {
  const upstream = t.mock.fn(async () => new Response(null));
  const result = await translatedResponse(async () => Response.json({ fixture: project }), upstream);
  assert.equal(result.status, 500);
  assert.equal(result.retries, 0);
  assert.deepEqual(result.fields, [{ model: "fixture", errorCode: "bootstrap_project" }]);
  assert.equal(typeof result.reply, "string");
  assert.match(String(result.reply), /Gemini credential load failed/);
  assert.doesNotMatch(String(result.reply), new RegExp(project));
  assert.equal(upstream.mock.callCount(), 0);
});
