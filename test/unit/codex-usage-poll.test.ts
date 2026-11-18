import assert from "node:assert/strict";
import { it } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexQuotaWriter, parseCodexUsageBody, type CodexQuotaParse } from "../../src/codex-quota-snapshot.js";
import { CodexUsagePoller, buildCodexUsagePoller, deriveUsageUrl, nextPollDecision, type PollDecisionState } from "../../src/codex-usage-poll.js";
import { loadConfig } from "../../src/config.js";
import { buildDeps } from "../../src/server.js";
import type { ProviderAuth } from "../../src/provider-auth.js";
import { noopLogger, type Logger } from "../../src/logger.js";
import type { RoutingClock } from "../../src/routing/clock.js";
import { usageBody, expectedUsage } from "../fixtures/codex-usage.js";

const NOW = 1800000000123;
const URL = "http://127.0.0.1:1/backend-api/wham/usage";
const BASE = "http://127.0.0.1:1/backend-api/codex";
const FILE = "/fixture/.codex/auth.json";
const settle = async () => { for (let n = 0; n < 8; n++) await new Promise<void>((resolve) => setImmediate(resolve)); };
function fixture(response: (init: RequestInit) => Promise<Response> = async () => Response.json(usageBody()), logger: Logger = noopLogger) {
  let now = NOW, monotonic = 0, refreshes = 0, credentials = 0, authFailed = false;
  const timers: { callback: () => void; delay: number; cancelled: boolean }[] = [];
  const clock: RoutingClock = { now: () => now, monotonic: () => monotonic, random: () => 0,
    schedule(callback, delay) { const timer = { callback: () => { timer.cancelled = true; callback(); }, delay, cancelled: false }; timers.push(timer); return () => { timer.cancelled = true; }; } };
  const writes: string[] = [], calls: { url: string; init: RequestInit }[] = [];
  const writer = new CodexQuotaWriter({ credentialFile: FILE, now: () => now, logger,
    write: async (text) => { writes.push(text); return { ok: true }; } });
  const auth: ProviderAuth<"codex"> = { refreshable: true,
    async getCredentials() { credentials++; if (authFailed) return { ok: false, error: { kind: "auth", message: "fixture-private" } }; return { ok: true, value: { provider: "codex", authHeaders: { "x-fixture-auth": "fixture-private", "x-fixture-account": "fixture-account" } } }; },
    async forceRefresh() { refreshes++; return this.getCredentials(); } };
  const fetchImpl: typeof fetch = async (url, init) => {
    // Exact loopback host. A near-match hostname must never reach a network call.
    assert.equal(new globalThis.URL(String(url)).hostname, "127.0.0.1", "fake refuses every non-loopback host");
    calls.push({ url: String(url), init: init! });
    return response(init!);
  };
  const options = { fetchImpl, auth, url: URL, writer, logger, clock, userAgent: "fixture-agent" };
  const poller = new CodexUsagePoller(options);
  return { poller, options, writer, writes, calls, timers, auth, get refreshes() { return refreshes; }, get credentials() { return credentials; },
    failAuth() { authFailed = true; }, setNow(value: number) { now = value; monotonic = value - NOW; }, get now() { return now; },
    async tick(at: number, elapsed = at - NOW) { now = at; monotonic = elapsed; poller.tick(); await settle(); await writer.flush(); } };
}
const state = (overrides: Partial<PollDecisionState> = {}): PollDecisionState => ({
  startedAt: NOW, startPending: false, inFlight: false, lastStart: undefined, nextAllowedAt: 0,
  starts: [], observedAt: NOW / 1000, resetsAt: [], usedResets: [], ...overrides,
});

it("TP-54/57/73 pure decisions enforce floor, flight, wait and rolling bounds", () => {
  assert.equal(nextPollDecision(state({ startPending: true }), NOW, NOW).kind, "poll", "start trigger");
  for (const gate of [{ inFlight: true }, { nextAllowedAt: NOW + 1 }, { lastStart: NOW - 59999 }, { starts: Array.from({ length: 48 }, () => NOW) }])
    assert.equal(nextPollDecision(state({ startPending: true, ...gate }), NOW, NOW).kind, "wait", "each limit blocks a start");
  assert.equal(nextPollDecision(state({ startPending: true, lastStart: NOW - 60000 }), NOW, NOW).kind, "poll", "floor boundary is inclusive");
  assert.equal(nextPollDecision(state({ startPending: true, starts: Array.from({ length: 48 }, () => NOW - 86400000) }), NOW, NOW).kind, "poll", "rolling day expires at the exact boundary");
  assert.equal(nextPollDecision(state({ observedAt: undefined }), NOW + 899999, NOW + 899999).kind, "wait", "no early stale trigger without any snapshot");
  assert.equal(nextPollDecision(state({ observedAt: undefined }), NOW + 900000, NOW + 900000).kind, "poll", "idle stale boundary");
  assert.equal(nextPollDecision(state({ resetsAt: [1800000060] }), 1800000119999, 1800000119999).kind, "wait", "reset grace cannot start early");
  assert.deepEqual(nextPollDecision(state({ resetsAt: [1800000060] }), 1800000120000, 1800000120000), { kind: "poll", dueResets: [1800000060] }, "reset grace boundary");
  assert.equal(nextPollDecision(state({ resetsAt: [1800000060], usedResets: [1800000060] }), 1800000120000, 1800000120000).kind, "wait", "consumed reset cannot trigger twice");
});
it("a 300 second old snapshot prevents a stale poll at process age 900 seconds", () => {
  assert.equal(nextPollDecision(state({ startedAt: 0, observedAt: Math.floor((NOW + 600000) / 1000) }), NOW + 900000, 900000).kind, "wait", "a fresh snapshot prevents the process-age stale trigger");
});
it("TP-61 unsupported URL logs a fixed info code and valid builder uses supplied auth", async () => {
  const records: unknown[] = [];
  const f = fixture();
  const options = { ...f.options, enabled: true, recording: true, authFile: FILE, baseUrl: BASE, logger: { log: (level: string, event: string, fields?: unknown) => records.push({ level, event, fields }) } };
  assert.equal(buildCodexUsagePoller({ ...options, baseUrl: "http://127.0.0.1:1/unsupported" }), undefined, "unsupported URL makes no poller");
  assert.deepEqual(records, [{ level: "info", event: "codex_usage_poll_unsupported_base_url", fields: undefined }], "fixed unsupported code");
  const poller = buildCodexUsagePoller(options); assert.ok(poller, "valid builder makes a poller");
  poller.start(); await settle(); poller.stop();
  assert.equal(f.credentials, 1, "builder reuses supplied auth");
});
it("TP-65 usage seconds map to the independent literal snapshot", () => {
  assert.deepEqual(parseCodexUsageBody(JSON.stringify(usageBody()), 1800000000), { snapshot: expectedUsage, resetRejected: false }, "literal usage snapshot");
});
it("TP-62 parser drops invalid levels, non-finite numbers and fractional minutes", () => {
  for (const text of ["{", "null", "[]", "1", '{"rate_limit":[]}', JSON.stringify({ ...usageBody(), rate_limit: null })])
    assert.equal(parseCodexUsageBody(text, 1800000000).snapshot, undefined, "bad body gives no snapshot");
  const body = usageBody();
  const parsed = parseCodexUsageBody(JSON.stringify({ ...body, plan_type: "bad\nprivate", credits: { has_credits: "true", unlimited: {}, balance: "12" },
    additional_rate_limits: [{ limit_id: "bad\nprivate", rate_limit: body.rate_limit }], rate_limit: {
      primary_window: { used_percent: 1, limit_window_seconds: 18001, reset_at: 1800010000 }, secondary_window: body.rate_limit.secondary_window } }), 1800000000).snapshot;
  assert.deepEqual(parsed?.windows, [expectedUsage.windows[1]], "seconds must divide by 60");
  assert.equal(parsed?.plan_type, null, "hostile text is absent");
  assert.deepEqual(parsed?.credits, { has_credits: null, unlimited: null, balance: null }, "JSON types stay strict");
  assert.deepEqual(parsed?.additional_limits, [], "hostile family id is absent");
  assert.equal(parseCodexUsageBody('{"rate_limit":{"primary_window":{"used_percent":1e999,"limit_window_seconds":18000,"reset_at":1800010000}}}', 1800000000).snapshot, undefined, "JSON overflow is not finite");
  for (const used of ["25", -1, null, Infinity]) {
    const text = JSON.stringify({ rate_limit: { primary_window: { used_percent: used, limit_window_seconds: 18000, reset_at: 1800010000 } } });
    assert.equal(parseCodexUsageBody(text, 1800000000).snapshot, undefined, "invalid numbers give no window");
  }
});
it("TP-62 usage rules share bounds, deduplication, sorting and eight family cap", () => {
  const body = usageBody();
  const parsed = parseCodexUsageBody(JSON.stringify({ ...body, additional_rate_limits: Array.from({ length: 9 }, (_, n) => ({ limit_id: `family-${n}`, limit_name: "Name", rate_limit: body.rate_limit })),
    rate_limit: { primary_window: { used_percent: 150, limit_window_seconds: 18000, reset_at: 1800010000 }, secondary_window: { used_percent: 1, limit_window_seconds: 18000, reset_at: 1800010001 } } }), 1800000000);
  assert.deepEqual(parsed.snapshot?.windows, [{ window_minutes: 300, used_percent: 100, resets_at: 1800010000 }], "primary wins duplicates and percent is clamped");
  assert.equal(parsed.snapshot?.additional_limits.length, 8, "eight families only");
  const invalid = parseCodexUsageBody('{"rate_limit":{"primary_window":{"used_percent":1,"limit_window_seconds":18000,"reset_at":1,"reset_after_seconds":10000}}}', 1800000000);
  assert.equal(invalid.snapshot, undefined, "relative reset cannot rescue invalid epoch");
  assert.equal(invalid.resetRejected, true, "shared reset bound");
});
it("TP-60/61 derives only the exact suffix on the same origin", () => {
  assert.equal(deriveUsageUrl(BASE + "/"), URL, "one trailing slash is supported");
  for (const base of [BASE + "//", BASE + "/responses", "not a URL", "http://127.0.0.1:1/api/codex", "ftp://127.0.0.1/backend-api/codex", "http://user:pass@127.0.0.1/backend-api/codex"])
    assert.equal(deriveUsageUrl(base), undefined, "unsupported base is refused");
});
it("TP-53 builder gates switch, recording, writer and account without auth I/O", async () => {
  const f = fixture();
  for (const override of [{ enabled: false }, { recording: false }, { writer: undefined }, { authFile: "/fixture/other.json" }, { baseUrl: BASE + "/responses" }]) {
    assert.doesNotThrow(() => { assert.equal(buildCodexUsagePoller({ ...f.options, enabled: true, recording: true, authFile: FILE, baseUrl: BASE, ...override }), undefined, "each disabled gate builds no poller"); }, "disabled builder is total");
  }
  await settle();
  assert.equal(f.calls.length, 0, "disabled builder sends nothing");
  assert.equal(f.credentials, 0, "disabled builder loads no credential");
});
it("a tick before start sends nothing", async () => {
  const f = fixture();
  try {
    for (let n = 0; n < 10; n++) await f.tick(NOW + n * 900000);
    assert.equal(f.calls.length, 0, "ticks before start send no request");
    assert.equal(f.credentials, 0, "ticks before start load no credential");
  } finally { f.poller.stop(); }
});
it("TP-53 buildDeps alone never starts a poll", async () => {
  const dir = await mkdtemp(join(tmpdir(), "subswitch-poll-build-"));
  let requests = 0;
  const backend = http.createServer((_req, res) => { requests++; res.end(JSON.stringify(usageBody(Math.floor(Date.now() / 1000)))); });
  backend.listen(0, "127.0.0.1"); await once(backend, "listening");
  const address = backend.address(); assert.ok(address && typeof address !== "string", "loopback address");
  const base = `http://127.0.0.1:${address.port}`, authFile = join(dir, ".codex", "auth.json");
  try {
    await mkdir(join(dir, ".codex"), { mode: 0o700 });
    await writeFile(authFile, '{"tokens":{"access_token":"fixture-not-jwt","refresh_token":"fixture-refresh","account_id":"fixture-account"}}', { mode: 0o600 });
    const loaded = loadConfig({ env: {}, configPath: join(dir, "config.json"), readFile: () => JSON.stringify({ providers: { codex: { baseUrl: base + "/backend-api/codex", oauthTokenUrl: base + "/token", authFile, usagePoll: true } } }) });
    assert.ok(loaded.ok, "loopback config parses");
    const writer = new CodexQuotaWriter({ credentialFile: authFile, now: Date.now, logger: noopLogger, write: async () => ({ ok: true }) });
    const deps = buildDeps(loaded.value.config, { ...noopLogger, codexQuota: writer });
    assert.ok(deps.ok, "dependency builder succeeds");
    assert.equal(typeof deps.value.codexAuth?.getCredentials, "function", "single auth instance is exposed");
    deps.value.sharedRouting?.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(requests, 0, "buildDeps alone sends no request despite valid fixture credentials");
  } finally { backend.closeAllConnections(); await new Promise<void>((resolve) => backend.close(() => resolve())); await rm(dir, { recursive: true, force: true }); }
});
it("TP-54 start runs once and fresh headers prevent stale polls", async () => {
  const f = fixture();
  f.poller.start(); f.poller.start(); await settle();
  assert.equal(f.calls.length, 1, "one start trigger");
  assert.equal(f.timers.filter((timer) => timer.delay === 60000 && !timer.cancelled).length, 1, "one repeating timer");
  f.setNow(NOW + 60000); f.timers.find((timer) => timer.delay === 60000)!.callback(); await settle();
  assert.equal(f.timers.filter((timer) => timer.delay === 60000 && !timer.cancelled).length, 1, "tick reschedules one timer");
  f.setNow(NOW + 600000);
  f.writer.record({ snapshot: { ...expectedUsage, observed_at: Math.floor(f.now / 1000), source: "response-headers" }, resetRejected: false });
  await f.writer.flush();
  await f.tick(NOW + 900000);
  assert.equal(f.calls.length, 1, "a 300 s old header snapshot prevents the stale poll");
  await f.tick(NOW + 1500000);
  assert.equal(f.calls.length, 2, "the header snapshot becomes stale at 900 s");
  f.poller.stop();
});
it("TP-55 stale activity and idle processes both poll at 900 seconds", async () => {
  for (const activity of [false, true]) {
    const f = fixture(); f.poller.start(); await settle();
    if (activity) f.writer.noteActivity();
    await f.tick(NOW + 900000);
    assert.equal(f.calls.length, 2, "stale poll for either activity state");
    f.poller.stop();
  }
});
it("elapsed floor, backoff and daily cap use monotonic time", () => {
  for (const [gate, boundary] of [
    [{ lastStart: 0 }, 60000],
    [{ nextAllowedAt: 120000 }, 120000],
    [{ starts: Array.from({ length: 48 }, () => 0) }, 86400000],
  ] as const) {
    const pending = state({ startedAt: 0, startPending: true, ...gate });
    assert.equal(nextPollDecision(pending, NOW, boundary - 1).kind, "wait", "wall time cannot expire an elapsed bound");
    assert.equal(nextPollDecision(pending, NOW - 600000, boundary).kind, "poll", "elapsed boundary permits a poll after a backward step");
  }
});
it("stale decisions ignore snapshot times only beyond the 300 second future bound", () => {
  const elapsed = state({ startedAt: 0, observedAt: Math.floor(NOW / 1000) + 300 });
  assert.equal(nextPollDecision(elapsed, NOW, 900000).kind, "wait", "snapshot at the future bound remains present");
  assert.equal(nextPollDecision({ ...elapsed, observedAt: Math.floor(NOW / 1000) + 301 }, NOW, 900000).kind, "poll", "snapshot beyond the future bound uses monotonic process age");
});
it("a backward wall step leaves stale polling eligible on the next tick", async () => {
  const f = fixture(async () => Response.json(usageBody(Math.floor(f.now / 1000))));
  try {
    f.poller.start(); await settle(); await f.writer.flush();
    assert.equal(f.calls.length, 1, "start accepts a snapshot before the wall step");
    await f.tick(NOW - 600000, 899999);
    assert.equal(f.calls.length, 1, "a future snapshot uses the process stale interval");
    await f.tick(NOW - 600000, 900000);
    assert.equal(f.calls.length, 2, "the next eligible tick polls despite the backward wall step");
    assert.equal(f.writer.pollState().observedAt, Math.floor((NOW - 600000) / 1000), "snapshot timestamps remain wall time");
  } finally { f.poller.stop(); }
});
it("a missing snapshot uses monotonic process age after a backward wall step", async () => {
  const f = fixture(async () => new Response(null, { status: 500 }));
  try {
    f.poller.start(); await settle();
    await f.tick(NOW - 600000, 900000);
    assert.equal(f.calls.length, 2, "monotonic stale age and failure backoff permit the next attempt");
  } finally { f.poller.stop(); }
});
it("TP-56 each due reset causes one attempt even if it fails", async () => {
  const f = fixture(async () => new Response(null, { status: 500 }));
  f.writer.record({ snapshot: { ...expectedUsage, source: "response-headers", windows: [{ window_minutes: 300, used_percent: 1, resets_at: 1800000060 }] }, resetRejected: false });
  f.poller.start(); await settle();
  await f.tick(NOW + 120000);
  assert.equal(f.calls.length, 2, "reset plus grace triggers a poll");
  await f.tick(NOW + 360000);
  assert.equal(f.calls.length, 2, "same reset is consumed on failure");
  f.poller.stop();
});
it("TP-57 floor and in-flight state block extra attempts", async () => {
  let finish: ((response: Response) => void) | undefined;
  const f = fixture(() => new Promise<Response>((resolve) => { finish = resolve; }));
  f.poller.start(); await settle();
  await f.tick(NOW + 900000);
  assert.equal(f.calls.length, 1, "one request in flight");
  finish!(Response.json(usageBody())); await settle();
  f.poller.stop();
  assert.equal(nextPollDecision(state({ startPending: true, lastStart: NOW - 59999 }), NOW, NOW).kind, "wait", "60 second floor");
});
for (const [retry, delay] of [["3600", 3600000], ["60", 120000], ["3601", 120000], ["1.5", 120000]] as const) {
  it(`TP-58 rate limit keeps header bytes and uses bounded Retry-After ${retry} with backoff`, async () => {
    let fail = true;
    const f = fixture(async () => fail ? new Response("private body", { status: 429, headers: { "retry-after": retry } }) : Response.json(usageBody()));
    f.writer.record({ snapshot: { ...expectedUsage, source: "response-headers", windows: [{ window_minutes: 300, used_percent: 1, resets_at: 1800000000 }] }, resetRejected: false }); await f.writer.flush();
    try {
      const before = f.writes[0]; f.poller.start(); await settle();
      assert.equal(f.writes.length, 1, "failure never writes"); assert.equal(f.writes[0], before, "header bytes stay unchanged");
      await f.tick(NOW + delay - 1); assert.equal(f.calls.length, 1, "the larger wait blocks a due reset until its boundary");
      fail = false; await f.tick(NOW + delay);
      assert.equal(f.calls.length, 2, "a due reset polls at the larger wait boundary");
    } finally { f.poller.stop(); }
  });
}
for (const failure of ["network", "timeout", "500", "401", "403", "auth"] as const) {
  it(`TP-59 ${failure} gives one failure step without forceRefresh`, async () => {
    const f = fixture(async (init) => {
      if (failure === "network") throw new Error("fixture-private");
      if (failure === "timeout") return new Promise<Response>((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      return new Response(null, { status: failure === "auth" ? 200 : Number(failure) });
    });
    if (failure === "auth") f.failAuth();
    f.writer.record({ snapshot: { ...expectedUsage, source: "response-headers", windows: [{ window_minutes: 300, used_percent: 1, resets_at: 1800000060 }] }, resetRejected: false });
    await f.writer.flush();
    f.poller.start(); await settle();
    if (failure === "timeout") { const timer = f.timers.find((timer) => timer.delay === 10000 && !timer.cancelled); assert.ok(timer, "timeout timer exists"); timer.callback(); await settle(); }
    await f.tick(NOW + 119999); assert.equal(f.calls.length, failure === "auth" ? 0 : 1, "one attempt before backoff");
    await f.tick(NOW + 120000); assert.equal(f.calls.length, failure === "auth" ? 0 : 2, "second attempt after first backoff step");
    assert.equal(f.credentials, 2, "credential failures count as attempts");
    assert.equal(f.writes.length, 1, "no failure snapshot"); assert.equal(f.refreshes, 0, "no force refresh"); f.poller.stop();
  });
}
it("TP-58/59 backoff steps cap at one hour and a valid body clears them", async () => {
  let success = false;
  const f = fixture(async () => success ? Response.json(usageBody(Math.floor(f.now / 1000))) : new Response(null, { status: 500 }));
  f.poller.start(); await settle();
  for (const delay of [120000, 240000, 480000, 960000, 1920000, 3600000, 3600000]) {
    const start = f.now, count = f.calls.length;
    // Fresh header data creates a new reset trigger while the failure wait still applies.
    f.writer.record({ snapshot: { ...expectedUsage, observed_at: Math.floor(start / 1000), source: "response-headers", windows: [{ window_minutes: 300, used_percent: count, resets_at: Math.floor(start / 1000) }] }, resetRejected: false });
    await f.tick(start + delay - 1); assert.equal(f.calls.length, count, "backoff step blocks a due reset");
    await f.tick(start + delay); assert.equal(f.calls.length, count + 1, "backoff step ends at its bound");
  }
  success = true;
  await f.tick(f.now + 3600000);
  const succeeded = f.now, count = f.calls.length;
  f.writer.record({ snapshot: { ...expectedUsage, observed_at: Math.floor(succeeded / 1000), source: "response-headers", windows: [{ window_minutes: 300, used_percent: 1, resets_at: Math.floor(succeeded / 1000) }] }, resetRejected: false });
  await f.tick(succeeded + 60000);
  assert.equal(f.calls.length, count + 1, "success clears backoff");
  f.poller.stop();
});
it("TP-62/63 invalid JSON and body-read errors do not write or expose body text", async () => {
  for (const mode of ["json", "read"] as const) {
    const records: unknown[] = [];
    const f = fixture(async () => mode === "json" ? new Response("fixture-private") : new Response(new ReadableStream({ start(controller) { controller.error(new Error("fixture-private")); } })), { log: (level, event, fields) => records.push({ level, event, fields }) });
    f.poller.start(); await settle();
    assert.equal(f.writes.length, 0, "invalid body writes nothing");
    assert.deepEqual(records, [{ level: "warn", event: "codex_usage_poll_failed", fields: mode === "json" ? { errorCode: "body_invalid", status: 200 } : { errorCode: "body_invalid" } }], "only fixed fields survive");
    f.poller.stop();
  }
});
for (const outcome of ["timeout", "stop"] as const) {
  it(`credential wait ends on ${outcome} without a late usage request`, async (t) => {
    const records: unknown[] = [];
    const f = fixture(undefined, { log: (level, event, fields) => records.push({ level, event, fields }) });
    const getCredentials = f.auth.getCredentials.bind(f.auth);
    let finish!: (value: Awaited<ReturnType<typeof getCredentials>>) => void;
    let loads = 0;
    t.mock.method(f.auth, "getCredentials", () => ++loads === 1
      ? new Promise<Awaited<ReturnType<typeof getCredentials>>>((resolve) => { finish = resolve; }) : getCredentials());
    f.writer.record({ snapshot: { ...expectedUsage, source: "response-headers", windows: [{ window_minutes: 300, used_percent: 1, resets_at: 1800000060 }] }, resetRejected: false });
    await f.writer.flush();
    try {
      f.poller.start(); await settle();
      f.setNow(NOW + 10000);
      if (outcome === "timeout") f.timers.find((timer) => timer.delay === 10000 && !timer.cancelled)!.callback();
      else f.poller.stop();
      await settle();
      assert.deepEqual(records, outcome === "timeout"
        ? [{ level: "warn", event: "codex_usage_poll_failed", fields: { errorCode: "timeout" } }] : [], "wait ends before the credential resolves");
      assert.equal(f.calls.length, 0, "no request before credentials");
      if (outcome === "timeout") {
        await f.tick(NOW + 129999);
        assert.equal(loads, 1, "failure backoff starts at timeout");
        await f.tick(NOW + 130000);
        assert.equal(loads, 2, "timeout releases the poll slot");
        assert.equal(f.calls.length, 1, "a later eligible poll can proceed");
      }
      finish(await getCredentials()); await settle();
      assert.equal(f.calls.length, outcome === "timeout" ? 1 : 0, "late credentials never dispatch the cancelled poll");
      assert.equal(f.refreshes, 0, "poll never forces refresh");
    } finally { f.poller.stop(); }
  });
}
it("TP-59 a transport that resolves after timeout still takes one failure step", async () => {
  let finish: ((response: Response) => void) | undefined;
  const f = fixture(() => new Promise<Response>((resolve) => { finish = resolve; }));
  f.writer.record({ snapshot: { ...expectedUsage, source: "response-headers", windows: [{ window_minutes: 300, used_percent: 1, resets_at: 1800000060 }] }, resetRejected: false }); await f.writer.flush();
  f.poller.start(); await settle(); f.timers.find((timer) => timer.delay === 10000)!.callback();
  finish!(Response.json(usageBody())); await settle(); await f.tick(NOW + 119999);
  assert.equal(f.calls.length, 1, "timeout must set backoff even if fetch ignores abort");
  assert.equal(f.writes.length, 1, "timed-out result never writes"); f.poller.stop();
});
it("TP-60 request uses credential headers and fixed transport only", async () => {
  const f = fixture(); f.poller.start(); await settle();
  assert.equal(f.calls[0]?.url, URL, "same-origin usage URL");
  assert.equal(f.calls[0]?.init.method, "GET", "GET method");
  assert.equal(f.calls[0]?.init.redirect, "error", "redirects refused");
  assert.deepEqual(Object.fromEntries(new Headers(f.calls[0]?.init.headers)), { accept: "application/json", originator: "codex_cli_rs", "user-agent": "fixture-agent", "x-fixture-account": "fixture-account", "x-fixture-auth": "fixture-private" }, "exact headers");
  f.poller.stop();
});
it("TP-60 a loopback redirect causes no second request", async () => {
  let requests = 0;
  const backend = http.createServer((_req, res) => { requests++; res.writeHead(302, { location: "/redirected" }); res.end(); });
  backend.listen(0, "127.0.0.1"); await once(backend, "listening");
  const address = backend.address(); assert.ok(address && typeof address !== "string", "loopback address");
  const f = fixture(); const poller = new CodexUsagePoller({ ...f.options, fetchImpl: fetch, url: `http://127.0.0.1:${address.port}/backend-api/wham/usage` });
  try { poller.start(); for (let n = 0; n < 30 && requests === 0; n++) await settle(); await settle(); assert.equal(requests, 1, "no follow-up redirect"); assert.equal(f.writes.length, 0, "redirect writes nothing"); }
  finally { poller.stop(); backend.closeAllConnections(); await new Promise<void>((resolve) => backend.close(() => resolve())); }
});
it("TP-62 oversized length and streamed body cancel without write", async () => {
  for (const length of [true, false]) {
    let cancelled = false;
    const f = fixture(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(65537)); }, cancel() { cancelled = true; } }), { headers: length ? { "content-length": "65537" } : {} }));
    f.poller.start(); await settle();
    assert.equal(cancelled, true, "oversized read is cancelled"); assert.equal(f.writes.length, 0, "oversized response never writes"); f.poller.stop();
  }
});
for (const mode of ["result", "reject"] as const) {
  it(`TP-63 credential ${mode} failures use a fixed credential warning without private text`, async (t) => {
    const records: unknown[] = [];
    const f = fixture(undefined, { log: (level, event, fields) => records.push({ level, event, fields }) });
    if (mode === "result") f.failAuth();
    else t.mock.method(f.auth, "getCredentials", async () => { throw new Error("fixture-private"); });
    try {
      f.poller.start(); await settle();
      await f.tick(NOW + 900000);
      assert.equal(f.calls.length, 0, "credential failures send no request");
      assert.deepEqual(records, [{ level: "warn", event: "codex_usage_poll_failed", fields: { errorCode: "credential" } }], "one fixed warning names the credential cause");
    } finally { f.poller.stop(); }
  });
}
it("TP-63 warning fields contain only fixed codes and numeric status once", async () => {
  const records: unknown[] = [];
  const logger: Logger = { log: (level, event, fields) => { records.push({ level, event, fields }); } };
  const f = fixture(async () => new Response("fixture-private", { status: 401 }), logger);
  f.poller.start(); await settle(); await f.tick(NOW + 900000); f.poller.stop();
  assert.equal(f.calls.length, 2, "two rejected requests exercise warning deduplication");
  assert.deepEqual(records, [{ level: "warn", event: "codex_usage_poll_rejected", fields: { status: 401 } }], "closed log fields and once per code");
});
it("TP-64 header wins late polls and ties; newer poll replaces older header", async () => {
  for (const second of [1800000001, 1800000000, 1799999999]) {
    let finish: ((response: Response) => void) | undefined;
    const f = fixture(() => new Promise<Response>((resolve) => { finish = resolve; }));
    f.poller.start(); await settle();
    f.writer.record({ snapshot: { ...expectedUsage, observed_at: second, source: "response-headers", plan_type: "pro" }, resetRejected: false }); await f.writer.flush();
    f.setNow(NOW + 5000); finish!(Response.json(usageBody())); await settle(); await f.writer.flush();
    const result = JSON.parse(f.writes.at(-1)!);
    assert.equal(result.source, second >= 1800000000 ? "response-headers" : "usage-endpoint", "header precedence uses request start second");
    assert.equal(result.observed_at, Math.max(second, 1800000000), "request start is the poll time"); f.poller.stop();
  }
});
it("TP-66 stop cancels timers, aborts fetch and discards late response", async () => {
  let finish: ((response: Response) => void) | undefined;
  const f = fixture(() => new Promise<Response>((resolve) => { finish = resolve; }));
  f.poller.start(); await settle(); f.poller.stop();
  assert.equal(f.calls[0]?.init.signal?.aborted, true, "stop aborts fetch");
  assert.ok(f.timers.every((timer) => timer.cancelled), "stop cancels each timer");
  finish!(Response.json(usageBody())); await settle(); await f.tick(NOW + 900000);
  assert.equal(f.writes.length, 0, "late result is discarded"); assert.equal(f.calls.length, 1, "no request after stop");
});
it("TP-71 poll, tick and warn catches contain fetch, writer and state failures", async () => {
  const unhandled: unknown[] = [];
  const listener = (error: unknown) => { unhandled.push(error); };
  process.on("unhandledRejection", listener);
  try {
    for (const mode of ["fetch", "writer", "state"] as const) {
      const f = fixture(async () => { if (mode === "fetch") throw new Error("fixture-private"); return Response.json(usageBody()); }, { log() { throw new Error("fixture-private"); } });
      if (mode === "writer") f.options.writer.record = (_parse: CodexQuotaParse) => { throw new Error("fixture-private"); };
      if (mode === "state") f.options.writer.pollState = () => { throw new Error("fixture-private"); };
      assert.doesNotThrow(() => f.poller.start(), "synchronous writer and logger failures stay contained"); await settle(); f.poller.stop();
    }
    assert.deepEqual(unhandled, [], "poll exceptions stay contained");
  } finally { process.off("unhandledRejection", listener); }
});
it("TP-71 terminal catch contains a timeout scheduler failure and releases the poll slot", async () => {
  const f = fixture(), unhandled: unknown[] = [];
  const listener = (error: unknown) => { unhandled.push(error); };
  const schedule = f.options.clock.schedule;
  assert.ok(schedule, "fixture supplies a scheduler");
  f.options.clock.schedule = (callback, delay) => {
    if (delay === 10000) throw new Error("fixture timeout scheduler failure");
    return schedule(callback, delay);
  };
  process.on("unhandledRejection", listener);
  try {
    assert.doesNotThrow(() => f.poller.start(), "timeout scheduler failure does not escape start");
    await settle();
    assert.deepEqual(unhandled, [], "terminal catch contains the rejected poll");
    assert.equal(f.calls.length, 0, "timeout setup failure sends no request");
    f.options.clock.schedule = schedule;
    await f.tick(NOW + 900000);
    assert.equal(f.calls.length, 1, "the next eligible tick uses the released poll slot");
    assert.deepEqual(unhandled, [], "recovery has no unhandled rejection");
  } finally { f.poller.stop(); process.off("unhandledRejection", listener); }
});
it("TP-73 rolling daily cap refuses 49th start and resumes at expiry", async () => {
  const f = fixture(async () => Response.json(usageBody(Math.floor(f.now / 1000))));
  f.poller.start(); await settle();
  for (let n = 1; n < 49; n++) await f.tick(NOW + n * 900000);
  assert.equal(f.calls.length, 48, "all triggers share 48-start daily cap");
  await f.tick(NOW + 86400000); assert.equal(f.calls.length, 49, "oldest start expires at 24 hours"); f.poller.stop();
});
it("TP-67 a poll child exits without stop after its request", async () => {
  const dir = await mkdtemp(join(tmpdir(), "subswitch-poll-exit-"));
  const backend = http.createServer((_req, res) => { res.end("{}"); }); backend.listen(0, "127.0.0.1"); await once(backend, "listening");
  const address = backend.address(); assert.ok(address && typeof address !== "string", "loopback address");
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), new globalThis.URL("../fixtures/codex-poll-child.ts", import.meta.url).pathname, `http://127.0.0.1:${address.port}/backend-api/wham/usage`], { cwd: dir, env: { ...process.env, HOME: dir }, stdio: ["ignore", "pipe", "pipe"] });
  let text = ""; child.stdout.on("data", (chunk: Buffer) => { text += chunk; }); child.stderr.on("data", () => undefined);
  const deadline = setTimeout(() => child.kill("SIGKILL"), 10000);
  try { const [code] = await once(child, "exit"); assert.equal(code, 0, "unref timers allow natural exit"); assert.equal(text, "requested\n", "child did start a poll"); }
  finally { clearTimeout(deadline); backend.closeAllConnections(); await new Promise<void>((resolve) => backend.close(() => resolve())); await rm(dir, { recursive: true, force: true }); }
});
