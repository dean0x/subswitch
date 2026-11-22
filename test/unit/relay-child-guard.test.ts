import assert from "node:assert/strict";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { it } from "node:test";
import type { RelayRecord } from "../../src/relay-record.js";
import { err, ok } from "../../src/result.js";
import { assertIsolatedRelayTarget, stopDetached, type DetachedStopDeps } from "../helpers/relay-child.js";

const realHome = userInfo().homedir;
const testPort = 42_193;
const safeHome = join(homedir(), "relay-home-fixture");

it("refuses the real home as a relay test target", () => {
  assert.throws(() => assertIsolatedRelayTarget(realHome, realHome, testPort), /Relay test home contains the real home/);
});

it("refuses a parent of the real home as a relay test target", () => {
  assert.throws(() => assertIsolatedRelayTarget(dirname(realHome), realHome, testPort), /Relay test home contains the real home/);
});

it("accepts an isolated temporary relay test target", () => {
  assert.doesNotThrow(() => assertIsolatedRelayTarget(safeHome, realHome, testPort));
});

const record: RelayRecord = {
  schemaVersion: 1, pid: 42, port: testPort, nonce: "ab".repeat(16),
  version: "0.8.0", startedAt: "2026-11-21T00:00:00Z", managedBy: "none",
};

function fakeStop(pidAgeMs: number, current: ReturnType<DetachedStopDeps["readRecord"]> = ok(undefined)) {
  const signals: NodeJS.Signals[] = [];
  let now = 20_000;
  const deps: DetachedStopDeps = {
    readRecord: () => signals.length === 0 ? ok(record) : current,
    classify: async () => ({ kind: "verified", record, version: record.version }),
    signal: (pid, signal) => {
      assert.equal(pid, record.pid);
      if (signal !== 0) signals.push(signal);
      return true;
    },
    wait: async (_isGone, ms) => { now += ms; return false; },
    now: () => now,
    pidAgeMs: (pid) => { assert.equal(pid, record.pid); return pidAgeMs; },
  };
  return { deps, signals, elapsed: () => now - 20_000 };
}

it("gives the detached relay its shutdown grace before SIGKILL if the record is gone", async () => {
  const fake = fakeStop(20_000);
  await stopDetached(testPort, safeHome, fake.deps);
  assert.ok(fake.elapsed() > 5_000, "Wait more than the relay shutdown grace");
  assert.deepEqual(fake.signals, ["SIGTERM", "SIGKILL"]);
});

it("does not send SIGKILL if a new process has the verified pid", async () => {
  const fake = fakeStop(2_000);
  await stopDetached(testPort, safeHome, fake.deps);
  assert.deepEqual(fake.signals, ["SIGTERM"]);
});

it("refuses SIGKILL if the relay record has changed", async () => {
  const fake = fakeStop(20_000, ok({ ...record, nonce: "cd".repeat(16) }));
  await assert.rejects(stopDetached(testPort, safeHome, fake.deps), /Relay test record changed/);
  assert.deepEqual(fake.signals, ["SIGTERM"]);
});

it("refuses SIGKILL if the relay record is unsafe", async () => {
  const fake = fakeStop(20_000, err("unsafe_path"));
  await assert.rejects(stopDetached(testPort, safeHome, fake.deps), /Unsafe relay test record/);
  assert.deepEqual(fake.signals, ["SIGTERM"]);
});
