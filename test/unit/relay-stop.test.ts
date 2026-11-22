import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { loadConfig } from "../../src/config.js";
import { stopRelay, type StopRelayDeps } from "../../src/relay-stop.js";

const PORT = 23123;
const PID = process.pid === 24680 ? 24683 : 24680;
const CALLER = 24681;
const PPID = 24682;
const UID = 501;
const NONCE = "ab".repeat(16);
const AT = "2026-11-22T00:00:00.000Z";
const VERSION = "0.8.0";

const osError = (code: string) => Object.assign(new Error("private OS details"), { code });
const identity = { name: "subswitch", version: VERSION, pid: PID, nonce: NONCE };

type FixtureOptions = {
  readonly record?: false | { readonly pid?: number; readonly managedBy?: "none" | "launchd" };
  readonly health?: false | object;
  readonly kill?: StopRelayDeps["kill"];
};

async function fixture(t: TestContext, options: FixtureOptions = {}) {
  const home = await mkdtemp(join(tmpdir(), "subswitch-stop-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const directory = join(home, ".cache", "subswitch", "relay", String(PORT));
  const requestPath = join(directory, "stop-request.json");
  const recordPath = join(directory, "relay.json");
  if (options.record !== false) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(recordPath, JSON.stringify({
      schemaVersion: 1, pid: PID, port: PORT, version: VERSION, startedAt: AT,
      managedBy: "none", nonce: NONCE, ...options.record,
    }), { mode: 0o600 });
  }
  const calls: [number, 0 | "SIGTERM"][] = [];
  const probes: number[] = [];
  const delays: number[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  let elapsed = 0;
  const deps: StopRelayDeps = {
    home, port: String(PORT), pid: CALLER, ppid: PPID, uid: UID,
    kill: (target, signal) => {
      calls.push([target, signal]);
      return options.kill?.(target, signal) ?? true;
    },
    requestHealth: async (port) => {
      probes.push(port);
      if (options.health === false) throw osError("ECONNREFUSED");
      return Response.json(options.health ?? identity);
    },
    clock: { now: () => Date.parse(AT), monotonic: () => elapsed },
    sleep: async (ms) => { delays.push(ms); elapsed += ms; },
    loadConfig: (opts) => loadConfig({ ...opts, cwd: home, env: {}, homeDir: home }),
    out: (line) => stdout.push(line), errOut: (line) => stderr.push(line),
  };
  return {
    home, recordPath, requestPath, calls, probes, delays, stdout, stderr,
    run: (overrides: Partial<StopRelayDeps> = {}) => stopRelay({ ...deps, ...overrides }),
  };
}

it("uses an explicit port without a config load and reports no active relay", async (t) => {
  const f = await fixture(t, { record: false, health: false });
  const load = t.mock.fn(() => ({ ok: false, error: { message: "unusable config" } }) as const);
  assert.equal(await f.run({ loadConfig: load }), 0);
  assert.equal(load.mock.callCount(), 0);
  assert.deepEqual(f.probes, [PORT]);
  assert.deepEqual(f.stdout, [`No relay is active on port ${PORT}.`]);
  assert.deepEqual(f.calls, []);
});

it("uses the user port instead of the project port when the option is absent", async (t) => {
  const f = await fixture(t, { record: false, health: false });
  await mkdir(join(f.home, ".config", "subswitch"), { recursive: true });
  await writeFile(join(f.home, ".config", "subswitch", "config.json"), `{"port":${PORT}}`);
  await writeFile(join(f.home, "subswitch.config.json"), '{"port":23124}');
  assert.equal(await f.run({ port: undefined }), 0);
  assert.deepEqual(f.probes, [PORT]);
});

it("uses the default port when the config cannot load", async (t) => {
  const f = await fixture(t, { record: false, health: false });
  await writeFile(join(f.home, "subswitch.config.json"), "{");
  assert.equal(await f.run({ port: undefined }), 0);
  assert.deepEqual(f.probes, [4141]);
  assert.deepEqual(f.calls, []);
});

for (const port of ["1.5", "0", "65536"]) {
  it(`refuses invalid port ${port} before any probe`, async (t) => {
    const f = await fixture(t);
    assert.equal(await f.run({ port }), 1);
    assert.deepEqual(f.probes, []);
    assert.deepEqual(f.calls, []);
    assert.throws(() => statSync(f.requestPath), { code: "ENOENT" });
    assert.match(f.stderr.join("\n"), /invalid --port/);
  });
}

for (const label of ["no\nraw value", "ops\n", "X", "a".repeat(33), ""]) {
  it(`refuses label ${JSON.stringify(label)} before a probe, write or signal`, async (t) => {
    const f = await fixture(t);
    assert.equal(await f.run({ label }), 1);
    assert.deepEqual(f.probes, []);
    assert.deepEqual(f.calls, []);
    assert.throws(() => statSync(f.requestPath), { code: "ENOENT" });
    assert.deepEqual(f.stderr, ["subswitch: invalid --by: use 1 to 32 lowercase letters, digits, dots, underscores or dashes"]);
  });
}

for (const [name, health] of [["legacy", identity], ["foreign", { name: "other" }]] as const) {
  it(`refuses a ${name} listener without a record or any pid lookup`, async (t) => {
    const f = await fixture(t, { record: false, health });
    assert.equal(await f.run(), 1);
    assert.match(f.stderr.join("\n"), new RegExp(`port ${PORT}`));
    assert.deepEqual(f.calls, []);
    assert.throws(() => statSync(f.requestPath), { code: "ENOENT" });
  });
}

for (const pid of [-10, 0, 1, 2_147_483_648, Number.MAX_SAFE_INTEGER + 1, CALLER]) {
  it(`never looks up or signals invalid target pid ${pid}`, async (t) => {
    const f = await fixture(t, { record: { pid }, health: { ...identity, pid } });
    assert.equal(await f.run(), 1);
    assert.deepEqual(f.calls, []);
    assert.throws(() => statSync(f.requestPath), { code: "ENOENT" });
  });
}

for (const [name, health] of [
  ["no answer", false], ["wrong nonce", { ...identity, nonce: "cd".repeat(16) }],
  ["wrong pid", { ...identity, pid: PID + 1 }], ["wrong name", { ...identity, name: "other" }],
] as const) {
  it(`refuses a live pid with ${name}`, async (t) => {
    const f = await fixture(t, { health });
    assert.equal(await f.run(), 1);
    assert.match(f.stderr.join("\n"), /unverified/);
    assert.deepEqual(f.calls, [[PID, 0]]);
    assert.throws(() => statSync(f.requestPath), { code: "ENOENT" });
  });
}

for (const [name, health] of [["no answer", false], ["matching health", identity]] as const) {
  it(`does not signal a dead pid with ${name}`, async (t) => {
    const f = await fixture(t, { health, kill: () => { throw osError("ESRCH"); } });
    assert.equal(await f.run(), 0);
    assert.deepEqual(f.calls, name === "matching health" ? [[PID, 0], [PID, 0]] : [[PID, 0]]);
    assert.deepEqual(f.stdout, [`No relay is active on port ${PORT}.`]);
    assert.throws(() => statSync(f.requestPath), { code: "ENOENT" });
  });
}

for (const code of ["EPERM", "EIO"]) {
  it(`refuses an unverified pid when the lookup returns ${code}`, async (t) => {
    const f = await fixture(t, { health: false, kill: () => { throw osError(code); } });
    assert.equal(await f.run(), 1);
    assert.match(f.stderr.join("\n"), /unverified/);
    assert.deepEqual(f.calls, [[PID, 0]]);
  });
}

it("refuses a verified launchd relay and names the uninstall command", async (t) => {
  const f = await fixture(t, { record: { managedBy: "launchd" } });
  assert.equal(await f.run(), 1);
  assert.match(f.stderr.join("\n"), /subswitch service uninstall/);
  assert.deepEqual(f.calls, [[PID, 0]]);
  assert.throws(() => statSync(f.requestPath), { code: "ENOENT" });
});

it("refuses to signal when an I/O error prevents the request write", async (t) => {
  const f = await fixture(t);
  await mkdir(f.requestPath, { mode: 0o700 });
  assert.equal(await f.run(), 1);
  assert.match(f.stderr.join("\n"), /could not write stop request/);
  assert.deepEqual(f.calls, [[PID, 0]]);
  assert.ok(statSync(f.requestPath).isDirectory());
});

it("does not call an unanswered listener idle without a record", async (t) => {
  const f = await fixture(t, { record: false });
  assert.equal(await f.run({ requestHealth: async () => { throw osError("ECONNRESET"); } }), 1);
  assert.deepEqual(f.calls, []);
  assert.equal(f.stdout.length, 0);
});

it("does not send SIGTERM if the listener changes during request publication", async (t) => {
  const f = await fixture(t);
  let written = false;
  assert.equal(await f.run({
    errOut: () => { written = true; },
    requestHealth: async () => Response.json(written ? { name: "other" } : identity),
  }), 1);
  assert.equal(written, true);
  assert.ok(f.calls.every(([, signal]) => signal === 0));
});

it("does not write or signal when the requester uid is unavailable", async (t) => {
  const f = await fixture(t);
  assert.equal(await f.run({ uid: undefined }), 1);
  assert.match(f.stderr.join("\n"), /could not identify the stop requester/);
  assert.deepEqual(f.calls, [[PID, 0]]);
  assert.throws(() => statSync(f.requestPath), { code: "ENOENT" });
});

it("refuses an unsafe record before a probe or signal", async (t) => {
  const f = await fixture(t);
  await writeFile(f.recordPath, "{}");
  assert.equal(await f.run(), 1);
  assert.match(f.stderr.join("\n"), /unsafe_path/);
  assert.deepEqual(f.probes, []);
  assert.deepEqual(f.calls, []);
});

it("writes and reports only the private request facts before one SIGTERM", async (t) => {
  const f = await fixture(t);
  const request = { targetPid: PID, nonce: NONCE, requesterPid: CALLER, requesterPpid: PPID, uid: UID, requestedAt: AT, label: "ops.stop_1-a" };
  let sent = false;
  const kill: StopRelayDeps["kill"] = (pid, signal) => {
    assert.equal(pid, PID);
    if (signal === "SIGTERM") {
      assert.equal(sent, false);
      assert.deepEqual(JSON.parse(readFileSync(f.requestPath, "utf8")), request);
      assert.equal(statSync(f.requestPath).mode & 0o777, 0o600);
      assert.deepEqual(f.stderr, [`subswitch: stop request ${JSON.stringify(request)}`]);
      sent = true;
      return true;
    }
    if (sent) throw osError("ESRCH");
    return true;
  };
  assert.equal(await f.run({ label: request.label, kill }), 0);
  assert.equal(sent, true);
  assert.deepEqual(f.delays, [200]);
  assert.deepEqual(f.stdout, []);
});

for (const [code, exit] of [["ESRCH", 0], ["EPERM", 1]] as const) {
  it(`returns ${exit} when SIGTERM returns ${code}`, async (t) => {
    const f = await fixture(t, { kill: (_pid, signal) => {
      if (signal === "SIGTERM") throw osError(code);
      return true;
    } });
    assert.equal(await f.run(), exit);
    assert.deepEqual(f.calls, [[PID, 0], [PID, 0], [PID, "SIGTERM"]]);
    assert.deepEqual(f.delays, []);
    assert.ok(!f.stderr.join("\n").includes("private OS details"));
    assert.ok(!Object.hasOwn(JSON.parse(readFileSync(f.requestPath, "utf8")), "label"));
  });
}

it("counts a permission error during the wait as exit", async (t) => {
  let sent = false;
  const f = await fixture(t, { kill: (_pid, signal) => {
    if (sent) throw osError("EPERM");
    sent = signal === "SIGTERM";
    return true;
  } });
  assert.equal(await f.run(), 0);
  assert.deepEqual(f.calls, [[PID, 0], [PID, 0], [PID, "SIGTERM"], [PID, 0]]);
  assert.deepEqual(f.delays, [200]);
});

it("times out at 35 seconds with one timeout line and no escalation", async (t) => {
  const f = await fixture(t);
  assert.equal(await f.run(), 1);
  assert.deepEqual(f.delays, Array(175).fill(200));
  assert.deepEqual(f.calls.slice(0, 3), [[PID, 0], [PID, 0], [PID, "SIGTERM"]]);
  assert.deepEqual(f.calls.slice(3), Array(175).fill([PID, 0]));
  assert.deepEqual(f.stderr.slice(1), [`subswitch: relay on port ${PORT} did not stop within 35 seconds`]);
});

it("bounds the wait even if the monotonic clock does not advance", async (t) => {
  const f = await fixture(t);
  assert.equal(await f.run({ clock: { now: () => Date.parse(AT), monotonic: () => 0 } }), 1);
  assert.equal(f.delays.length, 175);
});

it("does not look up the pid after the wait deadline passes", async (t) => {
  const f = await fixture(t);
  let elapsed = 0;
  assert.equal(await f.run({
    clock: { now: () => Date.parse(AT), monotonic: () => elapsed },
    sleep: async () => { elapsed = 35_001; },
  }), 1);
  assert.deepEqual(f.calls, [[PID, 0], [PID, 0], [PID, "SIGTERM"]]);
});
