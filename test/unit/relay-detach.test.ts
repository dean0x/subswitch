import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmodSync, closeSync, fstatSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { it, type TestContext } from "node:test";
import { detachRelay, type DetachDeps } from "../../src/relay-detach.js";
import { classifyRelay, openBootLog, relayFolder, type RelayClassification, type RelayRecord } from "../../src/relay-record.js";
import { err, ok } from "../../src/result.js";
import { SUBSWITCH_VERSION } from "../../src/version.js";

const port = 24161;
const record: RelayRecord = {
  schemaVersion: 1, pid: 1234, port, version: SUBSWITCH_VERSION, startedAt: "2026-11-21T00:00:00Z",
  managedBy: "none", nonce: "a".repeat(32),
};
const health = { name: "subswitch", version: SUBSWITCH_VERSION, pid: record.pid, nonce: record.nonce };
const verified = (pid = record.pid, version: string = SUBSWITCH_VERSION): RelayClassification =>
  ({ kind: "verified", record: { ...record, pid }, version });

function fakeClock() {
  let now = 0;
  const timers = new Map<() => void, number>();
  return {
    now: () => now,
    after(ms: number, run: () => void) {
      timers.set(run, now + ms);
      return () => { timers.delete(run); };
    },
    async advance(ms: number) {
      const end = now + ms;
      for (let i = 0; i < 200; i++) {
        const next = [...timers].sort((a, b) => a[1] - b[1])[0];
        if (!next || next[1] > end) { now = end; return; }
        const [run, at] = next;
        now = at;
        timers.delete(run);
        run();
        await setImmediate();
      }
      assert.fail("fake clock exceeded its timer limit");
    },
  };
}

function fixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "relay-detach-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const path = join(relayFolder(port, home), "boot.log");
  const clock = fakeClock();
  const child = Object.assign(new EventEmitter(), { pid: record.pid, unref: t.mock.fn() });
  const spawn = t.mock.fn<DetachDeps["spawn"]>(() => ok(child));
  const loadConfig = t.mock.fn<DetachDeps["loadConfig"]>(() => ok({ config: { port } }));
  const answers: RelayClassification[] = [];
  const state: { record?: RelayRecord; requestHealth: NonNullable<Parameters<typeof classifyRelay>[1]["requestHealth"]> } = {
    requestHealth: async () => Response.json(health),
  };
  const plistExists = t.mock.fn<DetachDeps["plistExists"]>(() => false);
  const readRecord = t.mock.fn<DetachDeps["readRecord"]>(() => ok(state.record));
  const classify = t.mock.fn<DetachDeps["classify"]>((p, deps) => deps.record
    ? classifyRelay(p, { ...deps, requestHealth: state.requestHealth, isAlive: (pid) => pid === record.pid })
    : Promise.resolve(answers.shift() ?? { kind: "none" }));
  const stdout: string[] = [], stderr: string[] = [], errors: string[] = [];
  const deps: DetachDeps = {
    platform: "linux", home, clock, spawn, loadConfig, classify, readRecord, plistExists,
    node: { execPath: "/node", execArgv: [], entry: "/subswitch-entry", env: {} },
    out: line => { stdout.push(line); }, errOut: line => { stderr.push(line); }, fail: line => { errors.push(line); },
  };
  return { deps, home, path, clock, child, spawn, loadConfig, answers, state, readRecord, classify, plistExists, stdout, stderr, errors };
}

it("waits for a verified launchd relay without a spawn (TP-21)", async t => {
  const f = fixture(t);
  f.spawn.mock.mockImplementation(() => err("child_exited"));
  f.plistExists.mock.mockImplementation(() => true);
  f.answers.push({ kind: "none" }, { kind: "verified", record: { ...record, managedBy: "launchd" }, version: SUBSWITCH_VERSION });

  const settled = t.mock.fn();
  void detachRelay({ ...f.deps, platform: "darwin" }).then(settled);
  await setImmediate();
  await f.clock.advance(100);

  assert.deepEqual([settled.mock.calls.map(call => call.arguments), f.stdout, f.stderr, f.spawn.mock.callCount()],
    [[[0]], ["1234"], [], 0]);
  assert.deepEqual(f.plistExists.mock.calls.map(call => call.arguments), [[join(f.home, "Library", "LaunchAgents", "com.subswitch.relay.plist")]]);
});

for (const [label, managedBy, alive, nonce] of [
  ["a foreground relay", "none", true, health.nonce],
  ["a dead record PID", "launchd", false, health.nonce],
  ["a health nonce mismatch", "launchd", true, "b".repeat(32)],
] as const) {
  it(`reports service_not_ready for ${label} (TP-22)`, async t => {
    const f = fixture(t);
    f.spawn.mock.mockImplementation(() => err("child_exited"));
    f.plistExists.mock.mockImplementation(() => true);
    f.classify.mock.mockImplementation((p, deps) => classifyRelay(p, {
      ...deps, record: { ...record, managedBy }, isAlive: () => alive,
      requestHealth: async () => Response.json({ ...health, nonce }),
    }));

    const settled = t.mock.fn();
    void detachRelay({ ...f.deps, platform: "darwin" }).then(settled);
    await setImmediate();
    await f.clock.advance(8_000);

    assert.deepEqual([settled.mock.calls.map(call => call.arguments), f.stdout, f.stderr, f.spawn.mock.callCount()],
      [[[1]], [], ["subswitch: service_not_ready"], 0]);
  });
}

it("includes the first probe in the 8 s service bound and cancels the pending probe (TP-22)", async t => {
  const f = fixture(t);
  f.spawn.mock.mockImplementation(() => err("child_exited"));
  f.plistExists.mock.mockImplementation(() => true);
  let pending: AbortSignal | undefined;
  f.classify.mock.mockImplementationOnce(() => new Promise(resolve => {
    f.clock.after(500, () => resolve({ kind: "none" }));
  }));
  f.classify.mock.mockImplementation((_, { signal }) => {
    pending = signal;
    return new Promise(resolve => signal?.addEventListener("abort", () => resolve({ kind: "none" }), { once: true }));
  });
  const settled = t.mock.fn();
  void detachRelay({ ...f.deps, platform: "darwin" }).then(settled);

  await f.clock.advance(7_999);
  const before = settled.mock.callCount();
  await f.clock.advance(1);

  assert.deepEqual([before, settled.mock.calls.map(call => call.arguments), f.stderr, f.spawn.mock.callCount()],
    [0, [[1]], ["subswitch: service_not_ready"], 0]);
  assert.equal(pending?.aborted, true);
});

for (const platform of ["darwin", "linux"] as const) {
  it(`spawns without a macOS service on ${platform} (TP-23)`, async t => {
    const f = fixture(t);
    f.plistExists.mock.mockImplementation(() => platform === "linux");
    f.state.record = record;
    const done = detachRelay({ ...f.deps, platform });
    await setImmediate();
    await f.clock.advance(8_000);
    assert.deepEqual([await done, f.stdout, f.spawn.mock.callCount(), f.plistExists.mock.callCount()],
      [0, ["1234"], 1, platform === "darwin" ? 1 : 0]);
  });
}

it("prints only the verified child pid after the record names that child (TP-1)", async t => {
  const f = fixture(t);
  f.state.record = { ...record, pid: 999 };
  f.answers.push({ kind: "unverified", reason: "no_answer", record: f.state.record });
  const done = detachRelay(f.deps);
  await setImmediate();
  assert.deepEqual(f.stdout, []);
  assert.equal(f.classify.mock.callCount(), 1);
  f.state.record = record;
  await f.clock.advance(100);
  assert.deepEqual([await done, f.stdout, f.stderr], [0, ["1234"], []]);
});

it("reuses a relay that publishes its record during the first health check", async t => {
  const f = fixture(t);
  const boot = openBootLog(port, f.home);
  assert.ok(boot.ok);
  closeSync(boot.value);
  const classify: DetachDeps["classify"] = (p, deps) => classifyRelay(p, {
    ...deps,
    isAlive: (pid) => pid === record.pid,
    requestHealth: async () => {
      writeFileSync(join(relayFolder(port, f.home), "relay.json"), JSON.stringify(record), { mode: 0o600 });
      return Response.json(health);
    },
  });
  assert.deepEqual([await detachRelay({ ...f.deps, classify }), f.stdout, f.stderr, f.spawn.mock.callCount()], [0, [String(record.pid)], [], 0]);
});

it("does not accept a health answer for a record that has changed (TP-1)", async t => {
  const f = fixture(t);
  f.state.record = record;
  f.state.requestHealth = async () => {
    f.state.record = { ...record, nonce: "b".repeat(32) };
    return Response.json(health);
  };
  assert.deepEqual([await detachRelay(f.deps), f.stdout, f.stderr], [1, [], ["subswitch: identity_mismatch"]]);
});

it("polls every 100 ms, with one GET at a time and an 8 s deadline (TP-4/13)", async t => {
  const f = fixture(t);
  const requestTimes: number[] = [], deadlines: number[] = [];
  let active = 0, peak = 0;
  t.mock.method(AbortSignal, "timeout", (ms: number) => {
    const request = new AbortController();
    deadlines.push(ms);
    f.clock.after(ms, () => request.abort());
    return request.signal;
  });
  f.state.record = record;
  f.state.requestHealth = async (requestedPort, signal) => {
    assert.equal(requestedPort, port);
    requestTimes.push(f.clock.now());
    peak = Math.max(peak, ++active);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        signal.addEventListener("abort", () => { active--; controller.error(signal.reason); }, { once: true });
      },
    });
    return new Response(body);
  };
  const done = detachRelay(f.deps);
  await setImmediate();
  const settled = t.mock.fn();
  void done.then(settled);
  await f.clock.advance(7999);
  assert.equal(settled.mock.callCount(), 0);
  assert.equal(f.readRecord.mock.callCount(), 80);
  await f.clock.advance(1);
  assert.deepEqual([await done, f.stderr, peak, active], [1, ["subswitch: not_ready"], 1, 0]);
  assert.deepEqual(requestTimes, [0, 1000, 2000, 3000, 4000, 5000, 6000, 7000]);
  assert.deepEqual(deadlines, Array(8).fill(1000));
});

for (const flag of ["verbose", "quiet"] as const) {
  it(`passes safe argv, ${flag}, environment and boot stderr to a detached, unrefed child (TP-5)`, async t => {
    const f = fixture(t);
    f.state.record = record;
    const node = { ...f.deps.node, execArgv: ["--inspect", "--inspect-brk=9229", "--debug", "--inspect_port", "0", "--import", "tsx"], env: { KEEP: "yes" } };
    let fd: number | undefined;
    f.spawn.mock.mockImplementation((_, __, options) => {
      fd = options.stdio[2];
      assert.equal(fstatSync(fd).mode & 0o777, 0o600);
      return ok(f.child);
    });
    assert.equal(await detachRelay({ ...f.deps, node, [flag]: true }), 0);
    const bootFd = fd;
    assert.ok(bootFd !== undefined);
    assert.deepEqual(f.spawn.mock.calls[0]?.arguments, ["/node", ["--import", "tsx", "/subswitch-entry", "serve", "--port", String(port), `--${flag}`],
      { detached: true, env: { KEEP: "yes", SUBSWITCH_MANAGED_BY: "detach" }, stdio: ["ignore", "ignore", bootFd] }]);
    assert.throws(() => fstatSync(bootFd), { code: "EBADF" });
    assert.equal(f.child.unref.mock.callCount(), 1);
  });
}

it("removes debugger flags from NODE_OPTIONS and keeps other options", async t => {
  const f = fixture(t);
  f.state.record = record;
  const keep = '--max-old-space-size=512 --import "./path with --inspect in it.mjs"';
  const node = { ...f.deps.node, env: {
    NODE_OPTIONS: `--inspect --inspect=0 "--inspec\\t"-brk --inspect-port 9229 --inspect-wait --debug --debug-brk --debug-port=0 ${keep}`,
  } };

  assert.equal(await detachRelay({ ...f.deps, node }), 0);
  assert.equal(f.spawn.mock.calls[0]?.arguments[2].env["NODE_OPTIONS"], keep);
});

it("refuses malformed NODE_OPTIONS before spawn", async t => {
  const f = fixture(t);
  f.state.record = record;
  const node = { ...f.deps.node, env: { NODE_OPTIONS: '--inspect --import "path' } };

  assert.equal(await detachRelay({ ...f.deps, node }), 1);
  assert.deepEqual(f.errors, ["invalid NODE_OPTIONS"]);
  assert.equal(f.spawn.mock.callCount(), 0);
});

it("leaves an unsafe record intact (TP-8 to TP-11)", async t => {
  const f = fixture(t);
  const boot = openBootLog(port, f.home);
  assert.ok(boot.ok);
  closeSync(boot.value);
  const path = join(relayFolder(port, f.home), "relay.json");
  const bytes = Buffer.from(JSON.stringify(record));
  writeFileSync(path, bytes);
  chmodSync(path, 0o644);
  const classify: DetachDeps["classify"] = (p, deps) => classifyRelay(p, {
    ...deps, requestHealth: f.state.requestHealth, isAlive: () => assert.fail("Unsafe records must not cause a pid lookup"),
  });

  const code = await detachRelay({ ...f.deps, classify });

  assert.deepEqual([code, f.stdout, f.stderr, f.spawn.mock.callCount()], [1, [], ["subswitch: unsafe_path"], 0]);
  const saved = lstatSync(path, { throwIfNoEntry: false });
  assert.ok(saved !== undefined && saved.isFile(), "detach must keep the unsafe record file");
  assert.equal(saved.mode & 0o7777, 0o644);
  assert.deepEqual(readFileSync(path), bytes);
});

for (const [label, first, onExit, code, stdout, stderr] of [
  ["refuses a foreign port", { kind: "foreign" }, undefined, 1, [], ["subswitch: port_in_use"]],
  ["reports a legacy relay", { kind: "legacy" }, undefined, 0, [], ["subswitch: restart the legacy relay to get its pid"]],
  ["reports a version difference", verified(4567, "old"), undefined, 0, ["4567"], ["subswitch: the relay version differs from this CLI"]],
  ["reuses a verified relay", verified(4567), undefined, 0, ["4567"], []],
  ["finds a verified winner after child exit", { kind: "none" }, verified(4567), 0, ["4567"], []],
  ["finds a foreign listener after child exit", { kind: "none" }, { kind: "foreign" }, 1, [], ["subswitch: port_in_use"]],
] as const satisfies readonly (readonly [string, RelayClassification, RelayClassification | undefined, number, readonly string[], readonly string[]])[]) {
  it(`${label} (TP-8 to TP-11)`, async t => {
    const f = fixture(t);
    f.answers.push(first);
    if (onExit) f.answers.push(onExit);
    const done = detachRelay(f.deps);
    if (onExit) { await setImmediate(); f.child.emit("exit", 1); }
    assert.deepEqual([await done, f.stdout, f.stderr, f.spawn.mock.callCount()], [code, stdout, stderr, onExit ? 1 : 0]);
  });
}

for (const [label, event, withinTail] of [["exit", "exit", true], ["exit with no tail line", "exit", false], ["error", "error", true]] as const) {
  it(`ends the wait on child ${label} and emits the allowed boot output (TP-4/6/7/12/53)`, async t => {
    const f = fixture(t);
    const first = openBootLog(port, f.home);
    assert.ok(first.ok);
    t.after(() => closeSync(first.value));
    writeSync(first.value, "old\n");
    f.spawn.mock.mockImplementation((_, __, options) => {
      const lines = withinTail ? `subswitch: one\nsubswitch: a\u001bz${"x".repeat(300)}\n` : "";
      writeSync(first.value, `subswitch: outside\n${"x".repeat(4096)}\n${lines}ignore\n`);
      writeSync(options.stdio[2], "end\n");
      return ok(f.child);
    });
    f.state.record = record;
    let canceled = false;
    f.state.requestHealth = (_, signal) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => { canceled = true; reject(); }, { once: true });
    });
    const done = detachRelay(f.deps);
    const settled = t.mock.fn();
    void done.then(settled);
    await setImmediate();
    f.child.emit(event, new Error("not for stderr"));
    await setImmediate();
    const expected = event === "exit" && withinTail ? [`subswitch: az${"x".repeat(187)}`] : [];
    assert.equal(settled.mock.callCount(), 1);
    assert.deepEqual([await done, f.stderr, canceled], [1, ["subswitch: child_exited", ...expected], true]);
    assert.equal(f.clock.now(), 0);
    assert.match(readFileSync(f.path, "utf8"), /^subswitch: outside\n[\s\S]*\nend\n$/);
  });
}

for (const change of [{ pid: 999 }, { nonce: "b".repeat(32) }, { name: "foreign" }]) {
  it(`refuses a health ${Object.keys(change)[0]} mismatch (TP-13)`, async t => {
    const f = fixture(t);
    f.state.record = record;
    f.state.requestHealth = async () => Response.json({ ...health, ...change });
    assert.deepEqual([await detachRelay(f.deps), f.stdout, f.stderr], [1, [], ["subswitch: identity_mismatch"]]);
  });
}

for (const [why, input, message] of [
  ["invalid port", { port: "65536" }, 'invalid --port "65536": port must be an integer between 1 and 65535'],
  ["config error", {}, "bad config"],
  ["config error with an explicit port", { port: String(port) }, "bad config"],
  ["win32", { platform: "win32" }, "detach is not available on Windows"],
  ["entry absent", {}, "the CLI entry is unavailable"],
] as const) {
  it(`uses the existing error path for ${why} (TP-14/15)`, async t => {
    const f = fixture(t);
    if (message === "bad config") f.loadConfig.mock.mockImplementation(() => err({ message }));
    f.spawn.mock.mockImplementation(() => err("child_exited"));
    const node = why === "entry absent" ? { ...f.deps.node, entry: undefined } : f.deps.node;
    assert.equal(await detachRelay({ ...f.deps, ...input, node }), 1);
    assert.deepEqual([f.errors, f.stdout, f.stderr, f.spawn.mock.callCount(), f.classify.mock.callCount()], [[message], [], [], 0, 0]);
  });
}

for (const unsafe of ["symlink", "folder mode"] as const) {
  it(`refuses an unsafe boot ${unsafe} before spawn (TP-16)`, async t => {
    const f = fixture(t);
    const first = openBootLog(port, f.home);
    assert.ok(first.ok);
    closeSync(first.value);
    if (unsafe === "symlink") { rmSync(f.path); symlinkSync(join(f.home, "target"), f.path); }
    else chmodSync(relayFolder(port, f.home), 0o755);
    f.state.record = record;
    assert.deepEqual([await detachRelay(f.deps), f.stderr, f.spawn.mock.callCount()], [1, ["subswitch: unsafe_path"], 0]);
  });
}

it("loads config without project ports before it applies an explicit port (TP-15/17)", async t => {
  const f = fixture(t);
  f.state.record = { ...record, port: 24162 };
  assert.equal(await detachRelay({ ...f.deps, port: "24162" }), 0);
  assert.deepEqual(f.loadConfig.mock.calls.map(call => call.arguments), [[{ allowProjectPort: false }]]);
  f.state.record = record;
  assert.equal(await detachRelay(f.deps), 0);
  assert.equal(f.loadConfig.mock.callCount(), 2);
  assert.deepEqual(f.loadConfig.mock.calls[1]?.arguments, [{ allowProjectPort: false }]);
  assert.equal(f.spawn.mock.callCount(), 2);
  assert.deepEqual(f.spawn.mock.calls.map(call => call.arguments[1].at(-1)), ["24162", "24161"]);
});
