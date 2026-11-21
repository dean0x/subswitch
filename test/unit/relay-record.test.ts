import assert from "node:assert/strict";
import { closeSync, writeSync } from "node:fs";
import { chmod, link, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer, type RequestListener } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { it, type TestContext } from "node:test";
import {
  classifyRelay, ensureRelayFolder, openBootLog, publishRelayRecord, readBootTail, readRelayRecord, relayFolder, removeOwnRelayRecord,
} from "../../src/relay-record.js";
import { SUBSWITCH_VERSION } from "../../src/version.js";
import type { Result } from "../../src/result.js";

const PORT = 53147;
const PID = process.pid === 42 ? 43 : 42;
const NONCE = "aa".repeat(16);
const OTHER_NONCE = "bb".repeat(16);
const PATH = "/__subswitch/health";
const unsafe = { ok: false, error: "unsafe_path" };
const fixture = (port = PORT) => ({
  schemaVersion: 1, pid: PID, port, version: "0.1.2", startedAt: "2026-11-21T18:47:00.000Z", managedBy: "none", nonce: NONCE,
});

function value<T>(result: Result<T, unknown>): T {
  assert.ok(result.ok, result.ok ? undefined : String(result.error));
  return result.value;
}

async function testHome(t: TestContext): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "subswitch-record-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

async function recordPath(home: string, port = PORT): Promise<string> {
  const path = join(home, ".cache", "subswitch", "relay", String(port));
  await mkdir(path, { recursive: true, mode: 0o700 });
  return join(path, "relay.json");
}

async function listen(t: TestContext, handler: RequestListener, port = 0): Promise<number> {
  const server = createServer(handler);
  t.after(() => { server.close(); server.closeAllConnections(); });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  assert.notEqual(address.port, 4141);
  return address.port;
}

it("uses the fixed home cache path even when XDG_CACHE_HOME is set", async (t) => {
  const home = await testHome(t);
  const saved = process.env["XDG_CACHE_HOME"];
  process.env["XDG_CACHE_HOME"] = join(home, "xdg");
  t.after(() => {
    if (saved === undefined) delete process.env["XDG_CACHE_HOME"];
    else process.env["XDG_CACHE_HOME"] = saved;
  });
  assert.equal(relayFolder(PORT, home), join(home, ".cache", "subswitch", "relay", String(PORT)));
});

it("publishes only the fixed fields in a private folder and file", async (t) => {
  const home = await testHome(t);
  const first = value(await publishRelayRecord(PORT, home));
  const directory = join(home, ".cache", "subswitch", "relay", String(PORT));
  const path = join(directory, "relay.json");
  const second = value(await publishRelayRecord(PORT, home));

  assert.notEqual(first.nonce, second.nonce);
  assert.match(second.nonce, /^[a-f0-9]{32}$/);
  assert.equal(new Date(second.startedAt).toISOString(), second.startedAt);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
    schemaVersion: 1, pid: process.pid, port: PORT, version: SUBSWITCH_VERSION, startedAt: second.startedAt, managedBy: "none", nonce: second.nonce,
  });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.deepEqual(await readdir(directory), ["relay.json"]);
});

it("accepts both record management values but refuses invalid schemas", async (t) => {
  const home = await testHome(t);
  const path = await recordPath(home);
  const base = fixture();
  for (const managedBy of ["none", "launchd"]) {
    const record = { ...base, managedBy };
    await writeFile(path, JSON.stringify(record), { mode: 0o600 });
    assert.deepEqual(value(readRelayRecord(PORT, home)), record);
  }
  for (const fields of [
    { schemaVersion: 2 }, { extra: true }, { port: PORT + 1 }, { pid: 0 }, { pid: 1 }, { pid: -2 }, { pid: 3.5 },
    { pid: Number.MAX_SAFE_INTEGER + 1 }, { pid: process.pid }, { nonce: NONCE.toUpperCase() }, { nonce: undefined },
    { startedAt: "not a date" }, { version: 1 }, { version: "x".repeat(65) }, { managedBy: "detach" },
  ]) {
    await writeFile(path, JSON.stringify({ ...base, ...fields }));
    assert.deepEqual(readRelayRecord(PORT, home), unsafe, JSON.stringify(fields));
  }
});

it("refuses oversized, linked and loosely moded record files", async (t) => {
  const home = await testHome(t);
  const path = await recordPath(home);
  const target = join(home, "other.json");
  const text = JSON.stringify(fixture());
  await writeFile(target, text, { mode: 0o600 });
  await symlink(target, path);
  assert.deepEqual(readRelayRecord(PORT, home), unsafe, "symlink");
  await rm(path);
  await link(target, path);
  assert.deepEqual(readRelayRecord(PORT, home), unsafe, "hard link");
  await rm(path);
  await writeFile(path, text, { mode: 0o644 });
  await chmod(path, 0o644);
  assert.deepEqual(readRelayRecord(PORT, home), unsafe, "mode");
  await chmod(path, 0o600);
  await writeFile(path, text.padEnd(4096, " "));
  assert.deepEqual(value(readRelayRecord(PORT, home)), fixture());
  await writeFile(path, text.padEnd(4097, " "));
  assert.deepEqual(readRelayRecord(PORT, home), unsafe, "size");
});

it("refuses a linked ancestor or a port folder with loose mode", async (t) => {
  const home = await testHome(t);
  const other = await testHome(t);
  const path = await recordPath(other);
  await writeFile(path, JSON.stringify(fixture()), { mode: 0o600 });
  await symlink(join(other, ".cache"), join(home, ".cache"));
  assert.deepEqual(ensureRelayFolder(PORT, home), unsafe);
  assert.deepEqual(readRelayRecord(PORT, home), unsafe);
  await chmod(join(path, ".."), 0o755);
  assert.deepEqual(ensureRelayFolder(PORT, other), unsafe);
  assert.deepEqual(readRelayRecord(PORT, other), unsafe);
});

it("requires owner-only write access from the home to the port folder", async (t) => {
  const home = await testHome(t);
  const portDir = value(ensureRelayFolder(PORT, home));
  for (const parent of [home, join(home, ".cache"), join(portDir, "..", ".."), join(portDir, "..")]) {
    await chmod(parent, 0o775);
    assert.deepEqual(ensureRelayFolder(PORT, home), unsafe);
    assert.deepEqual(openBootLog(PORT, home), unsafe);
    await chmod(parent, 0o755);
    assert.equal(value(ensureRelayFolder(PORT, home)), portDir);
  }
});

it("clears its temp file after a failed rename and never writes through a symlink", async (t) => {
  const home = await testHome(t);
  const path = await recordPath(home);
  await mkdir(path);
  assert.deepEqual(await publishRelayRecord(PORT, home), unsafe);
  assert.deepEqual(await readdir(join(path, "..")), ["relay.json"]);
  await rm(path, { recursive: true });
  const target = join(home, "target");
  await writeFile(target, "keep");
  await symlink(target, path);
  const record = value(await publishRelayRecord(PORT, home));
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), record);
  assert.equal(await readFile(target, "utf8"), "keep");
});

it("removes its own record but leaves a newer nonce intact", async (t) => {
  const home = await testHome(t);
  const path = await recordPath(home);
  const first = value(await publishRelayRecord(PORT, home));
  const second = value(await publishRelayRecord(PORT, home));

  assert.equal(value(removeOwnRelayRecord(PORT, home, first.nonce)), false);
  assert.equal(JSON.parse(await readFile(path, "utf8")).nonce, second.nonce);
  assert.equal(value(removeOwnRelayRecord(PORT, home, second.nonce)), true);
  assert.equal(value(readRelayRecord(PORT, home)), undefined);
});

it("classifies legacy, foreign, mismatched and verified health answers", async (t) => {
  const home = await testHome(t);
  let body: object = { name: "subswitch", version: "old", providers: [{ id: "anthropic", configured: true, modelCount: 0 }] };
  const requests: string[] = [];
  const port = await listen(t, (req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.end(JSON.stringify(body));
  });
  const deps = { home };
  assert.deepEqual(await classifyRelay(port, deps), { kind: "legacy" });
  body = { name: "another", version: "old" };
  assert.deepEqual(await classifyRelay(port, deps), { kind: "foreign" });
  const record = fixture(port);
  await writeFile(await recordPath(home, port), JSON.stringify(record), { mode: 0o600 });
  const health = { name: "subswitch", version: "new", pid: PID, nonce: NONCE };
  for (const answer of [
    { ...health, nonce: OTHER_NONCE }, { ...health, pid: PID + 1 }, { ...health, name: "another" },
    { ...health, nonce: undefined }, { ...health, extra: true },
  ]) {
    body = answer;
    assert.deepEqual(await classifyRelay(port, deps), { kind: "unverified", reason: "identity_mismatch", record });
  }
  body = health;
  assert.deepEqual(await classifyRelay(port, deps), { kind: "verified", record, version: "new" });
  assert.deepEqual(requests, Array.from({ length: 8 }, () => `GET ${PATH}`));
});

it("checks a loopback relay on a port that browser fetch excludes", async (t) => {
  const home = await testHome(t);
  for (const port of [10080, 6667, 6000]) {
    try {
      await listen(t, (_req, res) => res.end('{"name":"subswitch","version":"old"}'), port);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EADDRINUSE") continue;
      throw error;
    }
    assert.deepEqual(await classifyRelay(port, { home }), { kind: "legacy" });
    return;
  }
  assert.fail("No free test port");
});

it("times out after one second and distinguishes no record from no answer", async (t) => {
  const home = await testHome(t);
  const port = await listen(t, () => undefined);
  const start = performance.now();
  assert.deepEqual(await classifyRelay(port, { home }), { kind: "none" });
  const elapsed = performance.now() - start;
  assert.ok(elapsed >= 850 && elapsed < 1_800, `elapsed=${elapsed}`);
  const record = fixture(port);
  await writeFile(await recordPath(home, port), JSON.stringify(record), { mode: 0o600 });
  assert.deepEqual(await classifyRelay(port, { home }), { kind: "unverified", reason: "no_answer", record });
});

it("does not treat an unsafe record as absent", async (t) => {
  const home = await testHome(t);
  const port = await listen(t, (_req, res) => res.end('{"name":"subswitch","version":"old"}'));
  await writeFile(await recordPath(home, port), "{}", { mode: 0o600 });
  assert.deepEqual(await classifyRelay(port, { home }), { kind: "unverified", reason: "unsafe_path" });
});

it("refuses redirects and bounds chunked health bodies", async (t) => {
  const home = await testHome(t);
  const health = '{"name":"subswitch","version":"old"}';
  let status = 302;
  let body = health;
  let followed = 0;
  const port = await listen(t, (req, res) => {
    if (req.url === "/elsewhere") {
      followed++;
      res.end(health);
      return;
    }
    if (status === 302) res.setHeader("Location", "/elsewhere");
    res.writeHead(status);
    res.write(body);
    res.end();
  });
  assert.deepEqual(await classifyRelay(port, { home }), { kind: "foreign" });
  assert.equal(followed, 0);
  status = 200;
  body = health.padEnd(64 * 1024, " ");
  assert.deepEqual(await classifyRelay(port, { home }), { kind: "legacy" });
  body += " ";
  assert.deepEqual(await classifyRelay(port, { home }), { kind: "foreign" });
});

it("opens a private boot log with truncate and append semantics", async (t) => {
  const home = await testHome(t);
  const first = value(openBootLog(PORT, home));
  t.after(() => closeSync(first));
  writeSync(first, "old text");
  const second = value(openBootLog(PORT, home));
  t.after(() => closeSync(second));
  writeSync(first, "one");
  writeSync(second, "two");
  const active = join(home, ".cache", "subswitch", "relay", String(PORT), "boot.log");
  assert.equal(await readFile(active, "utf8"), "onetwo");
  assert.equal((await stat(active)).mode & 0o777, 0o600);
});

it("does not truncate a linked or loosely moded boot log", async (t) => {
  const home = await testHome(t);
  const directory = value(ensureRelayFolder(PORT, home));
  const active = join(directory, "boot.log");
  const target = join(home, "target");
  await writeFile(target, "keep", { mode: 0o600 });
  for (const makeLink of [symlink, link]) {
    await makeLink(target, active);
    assert.deepEqual(openBootLog(PORT, home), unsafe);
    assert.deepEqual(readBootTail(PORT, home), unsafe);
    assert.equal(await readFile(target, "utf8"), "keep");
    await rm(active);
  }
  await writeFile(active, "keep", { mode: 0o644 });
  await chmod(active, 0o644);
  assert.deepEqual(openBootLog(PORT, home), unsafe);
  assert.equal(await readFile(active, "utf8"), "keep");
});

it("takes only the last prefixed boot line in the tail, cleans it and caps it", async (t) => {
  const home = await testHome(t);
  const path = join(value(ensureRelayFolder(PORT, home)), "boot.log");
  await writeFile(path, `subswitch: outside\n${"x".repeat(4096)}\nnot selected\n`, { mode: 0o600 });
  assert.equal(value(readBootTail(PORT, home)), undefined);
  await writeFile(path, `subswitch: first\n\u001bsubswitch: ignore\nsubswitch: a\u001b\u009bz${"x".repeat(300)}\nlast but no prefix\n`);
  assert.equal(value(readBootTail(PORT, home)), `subswitch: az${"x".repeat(187)}`);
  await writeFile(path, "subswitch: config contains Bearer FAKE-BOOT-VALUE\n");
  assert.equal(value(readBootTail(PORT, home)), "subswitch: config contains Bearer <redacted>");
});
