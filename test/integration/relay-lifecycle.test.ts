import assert from "node:assert/strict";
import { once } from "node:events";
import { access, appendFile, chmod, mkdir, readFile, stat, symlink, truncate, unlink, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { isPlainObject } from "../../src/plain-object.js";
import { classifyRelay, readRelayRecord, writeStopRequest, type StopRequest } from "../../src/relay-record.js";
import { SUBSWITCH_VERSION } from "../../src/version.js";
import { runCliChild } from "../helpers/cli-child.js";
import { startRelayChild, type RelayChild, type RelayChildOptions } from "../helpers/relay-child.js";

async function launch(t: TestContext, options: Omit<RelayChildOptions, "env"> & { readonly env?: NodeJS.ProcessEnv } = {}) {
  const relay = await startRelayChild({
    ...options, env: { NO_COLOR: "1", SUBSWITCH_LIMIT_RECORDING: "0", ...options.env },
  });
  t.after(relay.cleanup);
  return relay;
}

const state = (relay: RelayChild) => join(relay.folders.home, ".cache", "subswitch", "relay", String(relay.port));
const log = (relay: RelayChild) => readFile(join(state(relay), "relay.log"), "utf8");
const lifecycleLines = (text: string) => text.split("\n").filter((line) => /event=relay_(fatal|stopped)\b/.test(line));
const iso = String.raw`\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z`;
const stopped = (pid: number | undefined, code: number, signal?: string, requester = "") =>
  new RegExp(`^${iso} level=info event=relay_stopped pid=${pid}${signal === undefined ? "" : ` signal=${signal}`} exitCode=${code}${requester}$`);
const beforeReady = (relay: RelayChild) => Promise.race([relay.exited, relay.waitFor("subswitch ready").then(() => "listened")]);

const LARGE_STDERR_BYTES = 256 * 1024 + 1;
const bootPath = (home: string) => join(home, "test-stderr.log");
const redirectStderrFile = `data:text/javascript,${encodeURIComponent(`
  import fs from "node:fs";
  import { syncBuiltinESMExports } from "node:module";
  import { homedir } from "node:os";
  import { join } from "node:path";
  const fd = fs.openSync(join(homedir(), "test-stderr.log"), "r+");
  const { fstatSync, ftruncateSync } = fs;
  fs.fstatSync = (target, ...args) => fstatSync(target === 2 ? fd : target, ...args);
  fs.ftruncateSync = (target, ...args) => ftruncateSync(target === 2 ? fd : target, ...args);
  syncBuiltinESMExports();
  process.once("exit", () => fs.closeSync(fd));
`)}`;

for (const mode of ["foreground", "detach", "launchd"] as const) {
  it(`${mode} publishes a private record, serves its identity and uses the correct log outputs`, async (t) => {
    const relay = await launch(t, {
      env: { SUBSWITCH_MANAGED_BY: mode === "foreground" ? undefined : mode, TOGETHER_API_KEY: "test-only-fake-key" },
      config: { providers: { together: {} } },
      extraImport: redirectStderrFile,
      prepare: async ({ home }) => {
        await writeFile(bootPath(home), "", { mode: 0o600 });
        await truncate(bootPath(home), LARGE_STDERR_BYTES);
      },
    });
    assert.equal(await beforeReady(relay), "listened", relay.stderr);
    await relay.waitFor("run `subswitch doctor`");
    assert.equal((await stat(bootPath(relay.folders.home))).size, mode === "launchd" ? 0 : LARGE_STDERR_BYTES);
    const saved = readRelayRecord(relay.port, relay.folders.home);
    assert.ok(saved.ok && saved.value, "The ready relay must publish a record");
    const { startedAt, nonce } = saved.value;
    assert.equal(new Date(startedAt).toISOString(), startedAt);
    assert.match(nonce, /^[a-f0-9]{32}$/);
    assert.deepEqual(saved.value, {
      schemaVersion: 1, pid: relay.child.pid, port: relay.port, version: SUBSWITCH_VERSION, startedAt,
      managedBy: mode === "launchd" ? "launchd" : "none", nonce,
    });
    assert.equal((await stat(state(relay))).mode & 0o777, 0o700);
    assert.equal((await stat(join(state(relay), "relay.json"))).mode & 0o777, 0o600);
    const response = await fetch(`http://127.0.0.1:${relay.port}/__subswitch/health`, { signal: AbortSignal.timeout(2_000) });
    assert.equal(response.status, 200);
    const body: unknown = await response.json();
    assert.ok(isPlainObject(body));
    assert.ok(Array.isArray(body.providers));
    const together: unknown = body.providers.find((row: unknown) => isPlainObject(row) && row.id === "together");
    assert.ok(isPlainObject(together));
    assert.equal(together.keySource, mode === "launchd" ? null : "env");
    const { name, pid, nonce: liveNonce } = body;
    assert.deepEqual({ name, pid, nonce: liveNonce }, { name: "subswitch", pid: relay.child.pid, nonce });
    assert.ok(relay.child.kill("SIGTERM"));
    assert.deepEqual(await relay.exited, [0, null]);
    const text = await log(relay);
    const start = `level=info event=relay_started pid=${pid} version=${SUBSWITCH_VERSION}`;
    assert.ok(text.split("\n").some((line) => line.endsWith(` ${start}`)));
    assert.match(text, /event=shutting_down/);
    const lines = lifecycleLines(text);
    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? "", stopped(relay.child.pid, 0, "SIGTERM"));
    assert.equal(relay.stderr.includes(start), mode === "foreground");
    assert.deepEqual(lifecycleLines(relay.stderr), mode === "foreground" ? lines : []);
    await assert.rejects(access(join(state(relay), "relay.json")), { code: "ENOENT" });
  });
}

it("refuses a launchd start when the pinned config is writable by another user", async (t) => {
  const relay = await launch(t, {
    env: { SUBSWITCH_MANAGED_BY: "launchd" },
    prepare: ({ configFile }) => chmod(configFile, 0o666),
  });
  assert.deepEqual(await beforeReady(relay), [1, null]);
  assert.match(relay.stderr, /regular user-owned config/);
  await assert.rejects(access(state(relay)), { code: "ENOENT" });
});

it("refuses an unknown managed mode before listen without printing its value", async (t) => {
  const invalidMode = "mode-input-canary";
  const relay = await launch(t, { env: { SUBSWITCH_MANAGED_BY: invalidMode } });
  assert.deepEqual(await beforeReady(relay), [1, null]);
  assert.match(relay.stderr, /SUBSWITCH_MANAGED_BY/);
  assert.doesNotMatch(relay.stderr, /subswitch ready/);
  assert.ok(!relay.stderr.includes(invalidMode));
  await assert.rejects(access(join(state(relay), "relay.json")), { code: "ENOENT" });
});

it("answers health only after the action control file is ready", async (t) => {
  const relay = await launch(t, { config: { configVersion: 2 }, extraImport: `data:text/javascript,${encodeURIComponent(`
    import fs from "node:fs/promises";
    import { syncBuiltinESMExports } from "node:module";
    const rename = fs.rename;
    fs.rename = async (source, target) => {
      if (target.endsWith("/control.json")) await new Promise(done => {
        const timer = setTimeout(done, 5000);
        process.once("SIGUSR2", () => { clearTimeout(timer); done(); });
        process.stderr.write("wait for action control\\n");
      });
      return rename(source, target);
    };
    syncBuiltinESMExports();
  `)}` });
  await relay.waitFor("wait for action control");
  const health = `http://127.0.0.1:${relay.port}/__subswitch/health`;
  await assert.rejects(fetch(health, { signal: AbortSignal.timeout(2000) }), TypeError);
  assert.ok(relay.child.kill("SIGUSR2"));
  await relay.waitFor("subswitch ready");
  assert.equal((await classifyRelay(relay.port, { home: relay.folders.home })).kind, "verified");
});

it("does not publish a record or log a stop if listen fails", async (t) => {
  const relay = await launch(t, { extraImport: `data:text/javascript,${encodeURIComponent(`
    import { createServer } from "node:net";
    const server = createServer();
    await new Promise((resolve) => server.listen(Number(process.argv.at(-1)), "127.0.0.1", resolve));
    server.unref();
  `)}` });
  assert.deepEqual(await beforeReady(relay), [1, null]);
  assert.match(relay.stderr, /already in use/);
  assert.deepEqual(lifecycleLines(relay.stderr), []);
  await assert.rejects(access(join(state(relay), "relay.json")), { code: "ENOENT" });
});

for (const mode of ["foreground", "detach", "launchd"] as const) {
  it(`record write failure ${mode === "foreground" ? "warns once and leaves foreground ready" : `stops ${mode}`}`, async (t) => {
    const relay = await launch(t, {
      env: { SUBSWITCH_MANAGED_BY: mode === "foreground" ? undefined : mode },
      prepare: async ({ home }) => {
        await mkdir(join(home, "other-cache"), { mode: 0o700 });
        await symlink(join(home, "other-cache"), join(home, ".cache"));
      },
    });
    if (mode !== "foreground") {
      assert.deepEqual(await beforeReady(relay), [1, null]);
    } else {
      await relay.waitFor("subswitch ready");
      assert.ok(relay.child.kill("SIGTERM"));
      assert.deepEqual(await relay.exited, [0, null]);
      assert.match(relay.stderr, /level=info event=relay_started\b/);
    }
    assert.equal(relay.stderr.match(/relay record unavailable/g)?.length, 1);
    await assert.rejects(access(join(relay.folders.home, "other-cache", "subswitch")), { code: "ENOENT" });
  });
}

for (const signal of ["SIGHUP", "SIGINT"] as const) {
  it(`${signal} produces one stop line at the ready banner`, async (t) => {
    const relay = await launch(t, { extraImport: `data:text/javascript,${encodeURIComponent(`
      const write = process.stderr.write;
      process.stderr.write = function (chunk, ...args) {
        const result = write.call(this, chunk, ...args);
        if (typeof chunk === "string" && chunk.startsWith("\\nsubswitch ready")) {
          process.kill(process.pid, ${JSON.stringify(signal)});
        }
        return result;
      };
    `)}` });
    await relay.waitFor("subswitch ready");
    assert.deepEqual(await relay.exited, [0, null]);
    const lines = lifecycleLines(await log(relay));
    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? "", stopped(relay.child.pid, 0, signal));
  });
}

const stopRequestPath = (relay: RelayChild) => join(state(relay), "stop-request.json");
const requestFields = { requesterPid: 51001, requesterPpid: 51002, uid: 501, label: "test-request-label" } as const;
const requestCanaries = /test-env-canary|test-argv-canary/;

it("stops a verified relay, attributes the request and then reports an idle port", async (t) => {
  const relay = await launch(t);
  await relay.waitFor("subswitch ready");
  const { pid } = relay.child;
  assert.ok(pid && pid !== 37926 && pid !== 98325);
  const args = ["stop", "--port", String(relay.port)];
  const result = await runCliChild(relay.folders, [...args, "--by", "test-stop"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "");
  const match = /^subswitch: stop request (\{[^\n]+\})\n$/.exec(result.stderr);
  assert.ok(match?.[1], result.stderr);
  const request: unknown = JSON.parse(match[1]);
  assert.ok(isPlainObject(request) && typeof request["requesterPid"] === "number");
  assert.equal(request["targetPid"], pid);
  assert.equal(request["requesterPpid"], process.pid);
  assert.equal(request["label"], "test-stop");
  assert.deepEqual(await relay.exited, [0, null]);
  assert.match(lifecycleLines(await log(relay))[0] ?? "",
    stopped(pid, 0, "SIGTERM", ` requesterPid=${request["requesterPid"]} requesterPpid=${process.pid}`));
  await assert.rejects(access(stopRequestPath(relay)), { code: "ENOENT" });
  assert.deepEqual(await runCliChild(relay.folders, args), {
    code: 0, stdout: `No relay is active on port ${relay.port}.\n`, stderr: "",
  });
});

for (const mode of ["legacy", "launchd"] as const) {
  it(`refuses to stop a ${mode} relay`, async (t) => {
    const relay = await launch(t, { env: { SUBSWITCH_MANAGED_BY: mode === "launchd" ? mode : undefined } });
    await relay.waitFor("subswitch ready");
    const { pid } = relay.child;
    assert.ok(pid && pid !== 37926 && pid !== 98325);
    if (mode === "legacy") await unlink(join(state(relay), "relay.json"));
    const result = await runCliChild(relay.folders, ["stop", "--port", String(relay.port)]);
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, mode === "launchd" ? /run subswitch service uninstall/ : /has no record/);
    assert.equal((await classifyRelay(relay.port, { home: relay.folders.home })).kind,
      mode === "launchd" ? "verified" : "legacy");
    await assert.rejects(access(stopRequestPath(relay)), { code: "ENOENT" });
  });
}

function makeStopRequest(relay: RelayChild, changes: Partial<StopRequest> = {}): StopRequest {
  const saved = readRelayRecord(relay.port, relay.folders.home);
  assert.ok(saved.ok && saved.value);
  return { targetPid: saved.value.pid, nonce: saved.value.nonce, requestedAt: new Date().toISOString(), ...requestFields, ...changes };
}

async function placeStopRequest(relay: RelayChild, request: StopRequest): Promise<void> {
  assert.deepEqual(await writeStopRequest(relay.port, relay.folders.home, request), { ok: true, value: request });
}

async function requestReads(relay: RelayChild): Promise<number> {
  const text = await readFile(relay.folders.execLog, "utf8");
  return text.split("\n").filter((line) => line === `fs.openSync ${stopRequestPath(relay)}`).length;
}

const requestCases: readonly {
  readonly name: string;
  readonly signal: "SIGINT" | "SIGTERM" | "SIGHUP";
  readonly attributed?: boolean;
  readonly offsetMs?: number;
  readonly changes?: Partial<StopRequest>;
  readonly oversize?: boolean;
}[] = [
  { name: "matching fresh SIGTERM", signal: "SIGTERM", attributed: true },
  { name: "matching fresh SIGINT", signal: "SIGINT" },
  { name: "matching fresh SIGHUP", signal: "SIGHUP" },
  { name: "stale SIGTERM", signal: "SIGTERM", offsetMs: -41_000 },
  { name: "future SIGTERM", signal: "SIGTERM", offsetMs: 10_000 },
  { name: "wrong pid SIGTERM", signal: "SIGTERM", changes: { targetPid: 2 } },
  { name: "wrong nonce SIGTERM", signal: "SIGTERM", changes: { nonce: "00".repeat(16) } },
  { name: "oversize SIGTERM", signal: "SIGTERM", oversize: true },
];

for (const fixture of requestCases) {
  it(`consumes a stop request once for ${fixture.name}`, async (t) => {
    const relay = await launch(t, {
      recordFsUnder: ".cache/subswitch/relay",
      env: { SUBSWITCH_TEST_ENV_CANARY: "test-env-canary" },
      extraImport: "data:text/javascript,/*test-argv-canary*/",
    });
    await relay.waitFor("subswitch ready");
    const request = makeStopRequest(relay, {
      requestedAt: new Date(Date.now() + (fixture.offsetMs ?? 0)).toISOString(),
      ...fixture.changes,
    });
    await placeStopRequest(relay, request);
    if (fixture.oversize) await appendFile(stopRequestPath(relay), " ".repeat(4_096));
    const requestText = await readFile(stopRequestPath(relay), "utf8");
    assert.deepEqual(JSON.parse(requestText), request);
    assert.doesNotMatch(requestText, requestCanaries);
    assert.equal(await requestReads(relay), 0);

    assert.ok(relay.child.kill(fixture.signal));
    assert.deepEqual(await relay.exited, [0, null]);
    const text = await log(relay);
    const lines = lifecycleLines(text);
    assert.equal(lines.length, 1);
    const requester = fixture.attributed ? " requesterPid=51001 requesterPpid=51002" : "";
    assert.match(lines[0] ?? "", stopped(relay.child.pid, 0, fixture.signal, requester));
    assert.deepEqual(lifecycleLines(relay.stderr), lines);
    assert.doesNotMatch(text + relay.stderr + relay.stdout, requestCanaries);
    assert.equal(await requestReads(relay), 1);
    await assert.rejects(access(stopRequestPath(relay)), { code: "ENOENT" });
  });
}

it("removes the record before port release and leaves the next relay record alone", async (t) => {
  const nonce = "ab".repeat(16);
  const relay = await launch(t, { extraImport: `data:text/javascript,${encodeURIComponent(`
    import fs from "node:fs";
    import { Server } from "node:http";
    import { syncBuiltinESMExports } from "node:module";
    import { createServer } from "node:net";
    import { homedir } from "node:os";
    import { join } from "node:path";
    const close = Server.prototype.close;
    Server.prototype.close = function (done) {
      const { address, port } = this.address();
      const record = join(homedir(), ".cache", "subswitch", "relay", String(port), "relay.json");
      process.stderr.write("record at close: " + fs.existsSync(record) + "\\n");
      return close.call(this, () => createServer().listen(port, address, function () {
        this.unref();
        fs.writeFileSync(record, JSON.stringify({
          schemaVersion: 1, pid: process.pid, port, version: ${JSON.stringify(SUBSWITCH_VERSION)},
          startedAt: new Date().toISOString(), managedBy: "none", nonce: ${JSON.stringify(nonce)},
        }), { mode: 0o600 });
        const open = fs.openSync;
        fs.openSync = (path, ...args) => {
          if (path === record) process.stderr.write("record opened after port release\\n");
          return open(path, ...args);
        };
        syncBuiltinESMExports();
        done();
      }));
    };
  `)}` });
  await relay.waitFor("subswitch ready");
  await access(join(state(relay), "relay.json"));
  assert.ok(relay.child.kill("SIGTERM"));
  assert.deepEqual(await relay.exited, [0, null]);
  assert.match(relay.stderr, /record at close: false/);
  assert.doesNotMatch(relay.stderr, /record opened after port release/);
  const saved = readRelayRecord(relay.port, relay.folders.home);
  assert.ok(saved.ok && saved.value?.nonce === nonce, "The next relay record must remain");
});

it("exits 1 after the grace period, keeps the first stop signal and consumes a later request", async (t) => {
  const relay = await launch(t, { recordFsUnder: ".cache/subswitch/relay" });
  await relay.waitFor("subswitch ready");
  const request = makeStopRequest(relay);
  const socket = createConnection({ host: "127.0.0.1", port: relay.port });
  t.after(() => { socket.destroy(); });
  socket.on("error", () => { /* Exit can close the held connection. */ });
  await once(socket, "connect", { signal: AbortSignal.timeout(2_000) });
  socket.write("POST ");
  await placeStopRequest(relay, request);
  assert.ok(relay.child.kill("SIGTERM"));
  await relay.waitFor("shutting_down");
  await placeStopRequest(relay, { ...request, requesterPid: 51003 });
  assert.ok(relay.child.kill("SIGHUP"));
  assert.deepEqual(await relay.exited, [1, null]);
  const lines = lifecycleLines(await log(relay));
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? "", stopped(relay.child.pid, 1, "SIGTERM", " requesterPid=51001 requesterPpid=51002"));
  assert.equal(await requestReads(relay), 2);
  await assert.rejects(access(stopRequestPath(relay)), { code: "ENOENT" });
});

it("logs only the pid on fatal, then writes the stop line and removes the record", async (t) => {
  const relay = await launch(t, { extraImport: 'data:text/javascript,process.once("SIGUSR2",()=>{throw Error("fixture fault")})' });
  await relay.waitFor("subswitch ready");
  assert.ok(relay.child.kill("SIGUSR2"));
  assert.deepEqual(await relay.exited, [1, null]);
  const text = await log(relay);
  const lines = lifecycleLines(text);
  assert.equal(lines.length, 2);
  assert.match(lines[0] ?? "", new RegExp(`^${iso} level=error event=relay_fatal pid=${relay.child.pid}$`));
  assert.match(lines[1] ?? "", stopped(relay.child.pid, 1));
  assert.doesNotMatch(text, /fixture fault|at process\./);
  await assert.rejects(access(join(state(relay), "relay.json")), { code: "ENOENT" });
});
