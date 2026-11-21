import assert from "node:assert/strict";
import { once } from "node:events";
import { access, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { createConnection, Server } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { DEFAULT_PORT } from "../../src/config.js";
import { isPlainObject } from "../../src/plain-object.js";
import { ensureRelayFolder, readRelayRecord } from "../../src/relay-record.js";
import { SUBSWITCH_VERSION } from "../../src/version.js";
import { startRelayChild, type RelayChild, type RelayChildOptions } from "../helpers/relay-child.js";

async function launch(t: TestContext, options: Pick<RelayChildOptions, "extraImport" | "prepare"> & { readonly env?: NodeJS.ProcessEnv } = {}) {
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
const stopped = (pid: number | undefined, code: number, signal?: string) =>
  new RegExp(`^${iso} level=info event=relay_stopped pid=${pid}${signal === undefined ? "" : ` signal=${signal}`} exitCode=${code}$`);
const beforeReady = (relay: RelayChild) => Promise.race([relay.exited, relay.waitFor("subswitch ready").then(() => "listened")]);

for (const mode of ["foreground", "detach"] as const) {
  it(`${mode} publishes a private record, serves its identity and uses the correct log outputs`, async (t) => {
    const relay = await launch(t, { env: mode === "detach" ? { SUBSWITCH_MANAGED_BY: "detach" } : {} });
    await relay.waitFor("run `subswitch doctor`");
    const saved = readRelayRecord(relay.port, relay.folders.home);
    assert.ok(saved.ok && saved.value, "The ready relay must publish a record");
    const { startedAt, nonce } = saved.value;
    assert.equal(new Date(startedAt).toISOString(), startedAt);
    assert.match(nonce, /^[a-f0-9]{32}$/);
    assert.deepEqual(saved.value, {
      schemaVersion: 1, pid: relay.child.pid, port: relay.port, version: SUBSWITCH_VERSION, startedAt, managedBy: "none", nonce,
    });
    assert.equal((await stat(state(relay))).mode & 0o777, 0o700);
    assert.equal((await stat(join(state(relay), "relay.json"))).mode & 0o777, 0o600);
    const response = await fetch(`http://127.0.0.1:${relay.port}/__subswitch/health`, { signal: AbortSignal.timeout(2_000) });
    assert.equal(response.status, 200);
    const body: unknown = await response.json();
    assert.ok(isPlainObject(body));
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

for (const value of ["launchd", "unknown"]) {
  it(`refuses managed-by ${value} before listen`, async (t) => {
    const relay = await launch(t, { env: { SUBSWITCH_MANAGED_BY: value } });
    assert.deepEqual(await beforeReady(relay), [1, null]);
    assert.match(relay.stderr, /SUBSWITCH_MANAGED_BY/);
    await assert.rejects(access(join(state(relay), "relay.json")), { code: "ENOENT" });
  });
}

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

for (const detach of [false, true]) {
  it(`record write failure ${detach ? "stops detach" : "warns once and leaves foreground ready"}`, async (t) => {
    const relay = await launch(t, {
      env: detach ? { SUBSWITCH_MANAGED_BY: "detach" } : {},
      prepare: async ({ home }) => {
        await mkdir(join(home, "other-cache"), { mode: 0o700 });
        await symlink(join(home, "other-cache"), join(home, ".cache"));
      },
    });
    if (detach) {
      assert.deepEqual(await beforeReady(relay), [1, null]);
    } else {
      await relay.waitFor("subswitch ready");
      assert.ok(relay.child.kill("SIGTERM"));
      assert.deepEqual(await relay.exited, [0, null]);
    }
    assert.equal(relay.stderr.match(/relay record unavailable/g)?.length, 1);
    await assert.rejects(access(join(relay.folders.home, "other-cache", "subswitch")), { code: "ENOENT" });
  });
}

for (const signal of ["SIGHUP", "SIGINT"] as const) {
  it(`${signal} produces one stop line`, async (t) => {
    const relay = await launch(t);
    await relay.waitFor("subswitch ready");
    assert.ok(relay.child.kill(signal));
    assert.deepEqual(await relay.exited, [0, null]);
    const lines = lifecycleLines(await log(relay));
    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? "", stopped(relay.child.pid, 0, signal));
  });
}

it("exits 1 after the grace period and keeps the first stop signal", async (t) => {
  const relay = await launch(t);
  await relay.waitFor("subswitch ready");
  const socket = createConnection({ host: "127.0.0.1", port: relay.port });
  t.after(() => { socket.destroy(); });
  socket.on("error", () => { /* Exit can close the held connection. */ });
  await once(socket, "connect", { signal: AbortSignal.timeout(2_000) });
  socket.write("POST ");
  assert.ok(relay.child.kill("SIGTERM"));
  await relay.waitFor("shutting_down");
  assert.ok(relay.child.kill("SIGHUP"));
  assert.deepEqual(await relay.exited, [1, null]);
  const lines = lifecycleLines(await log(relay));
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? "", stopped(relay.child.pid, 1, "SIGTERM"));
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

it("starts and stops a relay under a separate home and on a test port", async (t) => {
  const relay = await startRelayChild({ config: { port: 9 }, env: { NO_COLOR: "1" } });
  t.after(relay.cleanup);
  assert.notEqual(relay.folders.home, homedir());
  assert.ok(relay.port > 0 && relay.port !== 4141 && relay.port !== DEFAULT_PORT && relay.port !== 9);
  assert.equal(JSON.parse(await readFile(relay.folders.configFile, "utf8")).port, relay.port);
  await relay.waitFor("subswitch ready");
  assert.match(relay.stderr, /subswitch ready/);
  await relay.cleanup();
  assert.deepEqual(await relay.exited, [0, null]);
  await assert.rejects(access(relay.folders.home), { code: "ENOENT" });
});

it("refuses port 4141 before any relay child can start", async (t) => {
  t.mock.method(Server.prototype, "address", () => ({ address: "127.0.0.1", family: "IPv4", port: 4141 }));
  await assert.rejects(startRelayChild({
    prepare: () => assert.fail("Must not prepare or spawn a relay on this port"),
  }), /Reserved relay test port/);
});

for (const matches of [true, false]) {
  it(`signals the pid from the temporary record only when the identity matches (${matches})`, async (t) => {
    const pid = process.pid === 42 ? 43 : 42;
    const nonce = "ab".repeat(16);
    const signals: NodeJS.Signals[] = [];
    t.mock.method(process, "kill", (target: number, signal: NodeJS.Signals | 0) => {
      assert.equal(target, pid);
      if (signal !== 0) signals.push(signal);
      return true;
    });
    t.mock.method(globalThis, "fetch", async () => Response.json({
      name: "subswitch", version: "0.8.0", pid, nonce: matches ? nonce : "cd".repeat(16),
    }));
    const relay = await startRelayChild({ detach: true, extraImport: "data:text/javascript,process.exit(0)" });
    t.after(() => relay.cleanup().catch(() => undefined));
    await relay.exited;
    const folder = ensureRelayFolder(relay.port, relay.folders.home);
    assert.ok(folder.ok);
    await writeFile(join(folder.value, "relay.json"), JSON.stringify({
      schemaVersion: 1, pid, nonce, port: relay.port, version: "0.8.0", startedAt: new Date().toISOString(), managedBy: "none",
    }), { mode: 0o600 });
    if (matches) await relay.cleanup();
    else await assert.rejects(relay.cleanup(), /Refuse to stop a relay without a verified identity/);
    assert.deepEqual(signals, matches ? ["SIGTERM", "SIGKILL"] : []);
    await assert.rejects(access(relay.folders.home), { code: "ENOENT" });
  });
}
