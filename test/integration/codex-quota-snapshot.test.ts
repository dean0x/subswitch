/** Offline quota hooks. All credentials and paths belong to temporary fixtures. */
import assert from "node:assert/strict";
import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { it } from "node:test";
import { createCodexHandler } from "../../src/codex-handler.js";
import { loadConfig, type Config } from "../../src/config.js";
import type { CodexQuotaSink } from "../../src/codex-quota-snapshot.js";
import { LimitRecorder, withLimitRecorder } from "../../src/limit-recorder.js";
import { noopLogger, type Logger, type LogFields } from "../../src/logger.js";
import type { ProviderId } from "../../src/models.js";
import { ReasoningCache } from "../../src/reasoning-cache.js";
import { SharedRouting } from "../../src/routing/shared-routing.js";
import { nativeCredential } from "../fixtures/native-profile.js";

const NOW = 1800000000123;
const HEADERS = {
  "content-type": "text/event-stream",
  "x-codex-primary-used-percent": "75.5",
  "x-codex-primary-window-minutes": "10080",
  "x-codex-primary-reset-at": "1800500000",
  "x-codex-secondary-used-percent": "25",
  "x-codex-secondary-window-minutes": "300",
  "x-codex-secondary-reset-at": "1800010000",
  "x-codex-rate-limit-reached-type": "weekly",
  "x-codex-active-limit": "missing-family",
};
const EXPECTED = '{"version":1,"observed_at":1800000000,"windows":[{"window_minutes":300,"used_percent":25,"resets_at":1800010000},{"window_minutes":10080,"used_percent":75.5,"resets_at":1800500000}],"rate_limit_reached_type":"weekly","source":"response-headers","plan_type":null,"active_limit":"missing-family","limit_name":null,"credits":null,"additional_limits":[]}';
const SSE = 'data: {"type":"response.created","response":{"id":"resp_fixture","status":"in_progress","output":[]}}\n\n' +
  'data: {"type":"response.completed","response":{"id":"resp_fixture","status":"completed","output":[]}}\n\n';
const ERROR = '{"error":{"code":"insufficient_quota","message":"fixture limit"}}';
const BODY = { model: "gpt-6-sol", max_tokens: 16, messages: [{ role: "user", content: "fixture" }] };
const CLI = new URL("../../src/cli.ts", import.meta.url).pathname;
const TSX = import.meta.resolve("tsx");

function config(value: unknown = {}): Config {
  const loaded = loadConfig({ env: {}, configPath: "/fixture/config.json", readFile: () => JSON.stringify(value) });
  assert.ok(loaded.ok, "fixture config must parse");
  return loaded.value.config;
}
async function listen(server: http.Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string", "fixture must bind a TCP port");
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: http.Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
const fixtureWriters = new Map<string, LimitRecorder[]>();
async function temporary(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "subswitch-quota-hooks-"));
  fixtureWriters.set(dir, []);
  try { await run(dir); } finally {
    // Drain accepted work even when an assertion fails, before removal of its directory.
    await Promise.all(fixtureWriters.get(dir)!.map((writer) => writer.flush()));
    fixtureWriters.delete(dir);
    await chmod(join(dir, "cache"), 0o700).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
}
function recorder(dir: string, credentialFile = join(dir, ".codex", "auth.json"), logger: Logger = noopLogger) {
  const path = join(dir, "cache", "codex-quota.json");
  const writer = new LimitRecorder(join(dir, "events"), logger, { codexQuota: { path, credentialFile, now: () => NOW } });
  fixtureWriters.get(dir)!.push(writer);
  return { path, writer, logger: withLimitRecorder(logger, writer), credentialFile };
}
function upstream(status: number, headers: Record<string, string> = HEADERS): Response {
  return new Response(status === 200 ? SSE : ERROR, { status, headers });
}
async function handler(logger: Logger, authFile: string, response: () => Response, providerId: ProviderId = "codex") {
  const urls: string[] = [];
  const handle = createCodexHandler({
    providerId, provider: { ...config().providers.codex, authFile, baseUrl: "http://127.0.0.1:1/backend-api/codex" },
    pingIntervalMs: 10000, loginCommand: "fixture login", logger, cache: new ReasoningCache(4, 1024),
    auth: { refreshable: false, async getCredentials() { return { ok: true, value: { provider: "codex", authHeaders: { authorization: "Bearer fixture" } } }; },
      async forceRefresh() { assert.fail("no refresh expected"); } },
    newSessionId: () => "fixture-session",
    fetchImpl: async (url) => { urls.push(String(url)); return response(); },
  });
  const server = http.createServer((req, res) => {
    void handle.handleMessages(req, res, Buffer.from(JSON.stringify(BODY)), BODY, BODY.model).catch(() => {
      res.writeHead(599);
      res.end("fixture handler failed");
    });
  });
  const base = await listen(server);
  try {
    const result = await fetch(base, { signal: AbortSignal.timeout(5000) });
    return { status: result.status, bytes: Buffer.from(await result.arrayBuffer()), urls };
  } finally { await close(server); }
}
async function routed(logger: Logger, authFile: string, response: () => Response) {
  const urls: string[] = [];
  const credential = { ...nativeCredential("codex", "quota-route"), authFile };
  const router = new SharedRouting(config({ configVersion: 2,
    accessProfiles: {
      code: { provider: "codex", product: "chatgpt-codex", billing: "subscription", account: "fixture", credential,
        baseUrl: "http://127.0.0.1:1/backend-api/codex" },
      backup: { provider: "codex", product: "chatgpt-codex", billing: "subscription", account: "fixture", credential,
        baseUrl: "http://127.0.0.1:2/backend-api/codex" },
    },
    routes: { work: { clients: ["claude-code"], primary: { profile: "code", model: "gpt-6-sol", effort: "high" },
      fallbacks: [{ profile: "backup", model: "gpt-6-sol", effort: "high" }], affinity: "native-or-explicit" } },
  }), logger, undefined, async (url) => { urls.push(String(url)); return response(); });
  try {
    const action = router.actions.create("claude-code", "fixture-thread");
    const events = [];
    for await (const event of router.events({ ...BODY, model: "work", stream: true }, "claude-code", "work",
      new AbortController().signal, router.actions.context(action.id, "claude-code"))) events.push(event);
    return { bytes: Buffer.from(JSON.stringify(events)), urls };
  } finally { router.close(); }
}

for (const status of [200, 429]) {
  it(`handler ${status} writes the literal snapshot before body access and preserves bytes`, async () => temporary(async (dir) => {
    const r = recorder(dir);
    let observed = false;
    const sink = r.logger.codexQuota!;
    const logger = { ...r.logger, codexQuota: { ...sink, credentialFile: sink.credentialFile, now: sink.now,
      noteActivity: () => sink.noteActivity(), record: (value) => { observed = true; sink.record(value); } } satisfies CodexQuotaSink };
    const baseline = await handler(noopLogger, r.credentialFile, () => upstream(status));
    const result = await handler(logger, r.credentialFile, () => {
      const response = upstream(status), body = response.body;
      Object.defineProperty(response, "body", { get() { assert.ok(observed, "snapshot precedes body access"); return body; } });
      return response;
    });
    await r.writer.flush();
    assert.equal(await readFile(r.path, "utf8"), EXPECTED);
    assert.equal(result.status, status);
    assert.deepEqual(result, baseline);
  }));
  it(`routed ${status} writes the literal snapshot from the matching account`, async () => temporary(async (dir) => {
    const credential = nativeCredential("codex", `quota-${status}`);
    const r = recorder(dir, credential.authFile);
    let observed = false;
    const sink = r.logger.codexQuota!;
    const logger: Logger = { ...r.logger, codexQuota: {
      credentialFile: sink.credentialFile, now: sink.now, noteActivity: () => sink.noteActivity(),
      record(value) { observed = true; sink.record(value); },
    } };
    const response = () => {
      const value = upstream(status), body = value.body;
      Object.defineProperty(value, "body", { get() { assert.ok(observed, "snapshot precedes routed body access"); return body; } });
      return value;
    };
    const rawPath = `${dirname(credential.authFile)}/./${basename(credential.authFile)}`;
    if (status === 200) await routed(logger, rawPath, response);
    else await assert.rejects(routed(logger, rawPath, response));
    await r.writer.flush();
    assert.equal(await readFile(r.path, "utf8"), EXPECTED);
  }));
}
it("handler refuses another provider id with a positive twin", async () => temporary(async (dir) => {
  const r = recorder(dir);
  const other: string = "kimi";
  await handler(r.logger, r.credentialFile, () => upstream(200), other as ProviderId);
  await r.writer.flush();
  await assert.rejects(readFile(r.path), { code: "ENOENT" });
  await handler(r.logger, r.credentialFile, () => upstream(200));
  await r.writer.flush();
  assert.equal(await readFile(r.path, "utf8"), EXPECTED);
}));
it("routed account path mismatch leaves no file and its positive twin writes", async () => temporary(async (dir) => {
  const credential = nativeCredential("codex", "quota-path");
  const r = recorder(dir, join(dir, "other-auth.json"));
  await routed(r.logger, credential.authFile, () => upstream(200));
  await r.writer.flush();
  await assert.rejects(readFile(r.path), { code: "ENOENT" });
  const twin = recorder(dir, credential.authFile);
  await routed(twin.logger, credential.authFile, () => upstream(200));
  await twin.writer.flush();
  assert.equal(await readFile(twin.path, "utf8"), EXPECTED);
}));
it("read-only cache preserves handler bytes and emits one fixed warning", async () => temporary(async (dir) => {
  const warnings: { event: string; fields: LogFields | undefined }[] = [];
  const r = recorder(dir, undefined, { log(level, event, fields) { if (level === "warn" && event.startsWith("codex_quota")) warnings.push({ event, fields }); } });
  await mkdir(dirname(r.path), { mode: 0o500 });
  const baseline = await handler(noopLogger, r.credentialFile, () => upstream(200));
  for (let count = 0; count < 2; count++) {
    assert.deepEqual(await handler(r.logger, r.credentialFile, () => upstream(200)), baseline);
    await r.writer.flush();
  }
  await assert.rejects(readFile(r.path), { code: "ENOENT" });
  assert.deepEqual(warnings, [{ event: "codex_quota_unavailable", fields: { errorCode: "EACCES" } }]);
  await chmod(dirname(r.path), 0o700);
  await handler(r.logger, r.credentialFile, () => upstream(200));
  await r.writer.flush();
  assert.equal(await readFile(r.path, "utf8"), EXPECTED);
}));
for (const kind of ["sink", "headers"] as const) {
  for (const site of ["handler", "routed"] as const) {
    it(`${site} contains throwing ${kind}, preserves bytes and sends no failover`, async () => temporary(async (dir) => {
      const credential = nativeCredential("codex", "quota-throw");
      const r = recorder(dir, credential.authFile);
      let calls = 0;
      const logger: Logger = kind === "sink" ? { ...r.logger, codexQuota: {
        credentialFile: credential.authFile, now: () => NOW, noteActivity() {}, record() { calls++; throw new Error("fixture private error"); },
      } } : r.logger;
      const response = () => {
        const value = upstream(200);
        if (kind === "headers") {
          const get = value.headers.get.bind(value.headers);
          Object.defineProperty(value.headers, "get", { value: (name: string) => {
            if (name === "x-codex-primary-used-percent") { calls++; throw new Error("fixture private header"); }
            return get(name);
          } });
        }
        return value;
      };
      const run = site === "handler" ? handler : routed;
      const baseline = await run(noopLogger, credential.authFile, () => upstream(200));
      let result: Awaited<ReturnType<typeof run>> | undefined;
      await assert.doesNotReject(async () => { result = await run(logger, credential.authFile, response); });
      assert.ok(result, "optional diagnostics must return the client result");
      assert.ok(calls > 0, "the throwing boundary must be reached");
      assert.deepEqual(result, baseline);
      assert.equal(result.urls.length, 1);
      await r.writer.flush();
      await assert.rejects(readFile(r.path), { code: "ENOENT" });
      await run(r.logger, credential.authFile, () => upstream(200));
      await r.writer.flush();
      assert.equal(await readFile(r.path, "utf8"), EXPECTED);
    }));
  }
}
it("hooks dispatch only the responses URL and never a usage request", async () => temporary(async (dir) => {
  const credential = nativeCredential("codex", "quota-urls");
  const r = recorder(dir, credential.authFile);
  for (const run of [handler, routed]) {
    const result = await run(r.logger, credential.authFile, () => upstream(200));
    assert.deepEqual(result.urls, ["http://127.0.0.1:1/backend-api/codex/responses"]);
  }
  await r.writer.flush();
}));

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("fixture child did not reach its deadline");
}
async function stop(child: ChildProcess, signal: NodeJS.Signals): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
  const exited = once(child, "exit");
  child.kill(signal);
  const [code] = await exited;
  return code as number | null;
}
async function serve(dir: string, recording: string, home = dir) {
  const counts = { responses: 0, tokens: 0, usage: 0 };
  const now = Math.floor(Date.now() / 1000);
  const backend = http.createServer((req, res) => {
    if (req.url === "/backend-api/codex/responses") counts.responses++;
    else if (req.url === "/token") counts.tokens++;
    else counts.usage++;
    res.writeHead(200, { ...HEADERS, "x-codex-primary-reset-at": String(now + 500000), "x-codex-secondary-reset-at": String(now + 10000) });
    res.end(SSE);
  });
  const base = await listen(backend);
  const reserve = http.createServer(), reserved = await listen(reserve), port = Number(new URL(reserved).port);
  await close(reserve);
  const authFile = join(dir, ".codex", "auth.json");
  await mkdir(dirname(authFile), { mode: 0o700 });
  await writeFile(authFile, '{"tokens":{"access_token":"fixture-not-jwt","refresh_token":"fixture-refresh","account_id":"fixture-account"}}', { mode: 0o600 });
  const path = join(dir, ".cache", "subswitch", "codex-quota.json");
  const configPath = join(dir, "config.json");
  await writeFile(configPath, JSON.stringify({ port, providers: { codex: {
    baseUrl: base + "/backend-api/codex", oauthTokenUrl: base + "/token", allowInsecureBaseUrl: true, authFile,
  } } }));
  const child = spawn(process.execPath, ["--import", TSX, CLI, "serve"], { cwd: dir,
    env: { ...process.env, HOME: home, SUBSWITCH_CONFIG: configPath, SUBSWITCH_LIMIT_RECORDING: recording,
      SUBSWITCH_LIMIT_DIR: join(dir, "limit-override"), NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  child.stdout!.on("data", () => undefined);
  try { await until(() => stderr.includes("subswitch ready") || child.exitCode !== null); assert.equal(child.exitCode, null, stderr); }
  catch (error) { await stop(child, "SIGKILL"); await close(backend); throw error; }
  return { child, path, port, counts, now, stderr: () => stderr, async cleanup() { await stop(child, "SIGKILL"); await close(backend); } };
}
for (const [recording, oldFile] of [["1", false], ["0", false], ["0", true]] as const) {
  it(`serve HOME stays isolated with recording ${recording}, old file ${oldFile}, and the limit root does not move the snapshot`, async () => temporary(async (dir) => {
    const path = join(dir, ".cache", "subswitch", "codex-quota.json");
    if (oldFile) { await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await writeFile(path, "old snapshot", { mode: 0o600 }); }
    const fixture = await serve(dir, recording);
    try {
      if (recording === "1") {
        await assert.rejects(readFile(path), { code: "ENOENT" });
        await assert.rejects(readdir(dirname(path)), { code: "ENOENT" });
        assert.ok(fixture.stderr().includes("Codex quota snapshot: " + path), "banner names the HOME snapshot path");
      } else assert.ok(!fixture.stderr().includes("Codex quota snapshot:"), "no banner without a snapshot sink");
      const before = Math.floor(Date.now() / 1000);
      const result = await fetch(`http://127.0.0.1:${fixture.port}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(BODY), signal: AbortSignal.timeout(5000) });
      assert.equal(result.status, 200);
      await result.arrayBuffer();
      assert.equal(await stop(fixture.child, "SIGTERM"), 0);
      assert.deepEqual(fixture.counts, { responses: 1, tokens: 0, usage: 0 });
      if (recording === "0") {
        if (oldFile) assert.equal(await readFile(path, "utf8"), "old snapshot");
        else await assert.rejects(readFile(path), { code: "ENOENT" });
      } else {
        const snapshot: unknown = JSON.parse(await readFile(path, "utf8"));
        assert.ok(snapshot && typeof snapshot === "object" && "observed_at" in snapshot && "windows" in snapshot, "snapshot has the public shape");
        assert.ok(typeof snapshot.observed_at === "number" && Number.isInteger(snapshot.observed_at), "observed_at uses whole seconds");
        assert.ok(snapshot.observed_at >= before && snapshot.observed_at <= Math.floor(Date.now() / 1000), "observed_at uses the response clock");
        assert.deepEqual(snapshot, {
          version: 1, observed_at: snapshot.observed_at,
          windows: [
            { window_minutes: 300, used_percent: 25, resets_at: fixture.now + 10000 },
            { window_minutes: 10080, used_percent: 75.5, resets_at: fixture.now + 500000 },
          ],
          rate_limit_reached_type: "weekly", source: "response-headers", plan_type: null,
          active_limit: "missing-family", limit_name: null, credits: null, additional_limits: [],
        });
        assert.deepEqual(await readdir(dirname(path)), ["codex-quota.json"]);
      }
      await assert.rejects(readFile(join(dir, "limit-override", "codex-quota.json")), { code: "ENOENT" });
    } finally { await fixture.cleanup(); }
  }));
}
for (const recording of ["1", "0"]) {
  it(`serve warns only when active for a relative HOME with recording ${recording}`, async () => temporary(async (dir) => {
    const fixture = await serve(dir, recording, "relative-home");
    try {
      assert.equal(fixture.stderr().split("codex_quota_home_unavailable").length - 1, Number(recording));
      assert.ok(!fixture.stderr().includes("Codex quota snapshot:"), "no banner without a snapshot sink");
      assert.equal(fixture.counts.usage, 0);
      await assert.rejects(readFile(fixture.path), { code: "ENOENT" });
    } finally { await fixture.cleanup(); }
  }));
}
it("help states the HOME path, fixed root and recording switch", async () => temporary(async (dir) => {
  const child = spawn(process.execPath, ["--import", TSX, CLI, "--help"], { cwd: dir, env: { ...process.env, HOME: dir }, stdio: ["ignore", "pipe", "pipe"] });
  let text = "";
  child.stdout!.on("data", (chunk: Buffer) => { text += chunk.toString(); });
  child.stderr!.on("data", () => undefined);
  const [code] = await once(child, "exit");
  assert.equal(code, 0);
  assert.equal(text.includes("$HOME/.cache/subswitch/codex-quota.json"), true, "help names the HOME snapshot path");
  assert.equal(text.includes("SUBSWITCH_LIMIT_DIR does not move the snapshot"), true, "help keeps the snapshot root fixed");
  assert.equal(text.includes("SUBSWITCH_LIMIT_RECORDING=0 stops the snapshot"), true, "help names the recording switch");
}));
