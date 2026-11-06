import assert from "node:assert/strict";
import childProcess, { type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, it, type TestContext } from "node:test";
import type { NativeProcessDiagnostic, NativeProcessDiagnosticSink } from "../../e2e/gates/native-process.js";
// Node type stripping resolves the real .ts file; the erased type query keeps the existing tsc config.
const { nativeProcess } = await import(new URL("../../e2e/gates/native-process.ts", import.meta.url).href) as
  typeof import("../../e2e/gates/native-process.js");

// This file never creates a child or sends a signal. Keep it separate from the native-spawning tests.
function mockedProcess(t: TestContext, options: {
  pid?: number | null;
  groupSignal?: (signal: string | number | undefined) => void;
  childSignal?: () => boolean;
} = {}) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const child = Object.assign(new EventEmitter(), {
    pid: options.pid === null ? undefined : options.pid ?? 987654,
    stdout: new EventEmitter(), stderr: new EventEmitter(),
    stdin: Object.assign(new EventEmitter(), { end: t.mock.fn() }),
    kill: t.mock.fn(options.childSignal ?? (() => true)),
  });
  const spawn = t.mock.method(childProcess, "spawn", () => child as unknown as ChildProcessWithoutNullStreams);
  const signals: { pid: number; signal: string | number | undefined }[] = [];
  t.mock.method(process, "kill", (pid: number, signal?: string | number): true => {
    signals.push({ pid, signal });
    options.groupSignal?.(signal);
    return true;
  });
  return { child, spawn, signals,
    start: (extra: { timeoutMs?: number; maxBytes?: number; signal?: AbortSignal; onDiagnostic?: NativeProcessDiagnosticSink } = {}) =>
      nativeProcess("fabricated-client", [], { cwd: "/fabricated-work", env: {}, timeoutMs: 1000, ...extra }),
    close: (code: number | null = 0) => { child.emit("close", code, null); },
  };
}

describe("mocked native process cleanup reporting", { concurrency: false, skip: process.platform === "win32" }, () => {
  it("retains group cleanup and clears timers and the abort listener after close", async t => {
    const fake = mockedProcess(t);
    const controller = new AbortController();
    const pending = fake.start({ signal: controller.signal });
    assert.equal(fake.spawn.mock.callCount(), 1);
    assert.equal(fake.spawn.mock.calls[0]?.arguments[2]?.detached, true);
    assert.equal(fake.child.stdin.end.mock.callCount(), 1);
    fake.close();
    assert.deepEqual(await pending, { code: 0, signal: null, stdout: "", stderr: "" });
    controller.abort();
    t.mock.timers.tick(5000);
    assert.deepEqual(fake.signals, [{ pid: -987654, signal: "SIGKILL" }]);
  });

  it("treats only an explicit ESRCH as an absent target", async t => {
    const fake = mockedProcess(t, { groupSignal: () => { throw { code: "ESRCH", message: "fabricated-private-detail" }; } });
    const pending = fake.start(); fake.close();
    const result = await pending;
    assert.equal(result.failure, undefined);
    assert.equal(result.cleanupError, undefined);
  });

  for (const code of ["EPERM", "EACCES", "EINVAL"] as const) {
    it(`fails closed after close with allowlisted ${code}`, async t => {
      const fake = mockedProcess(t, { groupSignal: () => { throw {
        code, errno: 999, pid: 123, syscall: "fabricated-secret", message: "fabricated-private-detail",
        path: "/fabricated-private-path", token: "fabricated-token",
      }; } });
      const pending = fake.start(); fake.close();
      const result = await pending;
      assert.deepEqual(result, { code: 0, signal: null, failure: "cleanup_error",
        cleanupError: { operation: "killpg", signal: "SIGKILL", code }, stdout: "", stderr: "" });
      assert.equal(result.code === 0 && !result.failure, false);
    });
  }

  for (const [name, error] of [
    ["unknown code", { code: "fabricated-secret-code", message: "fabricated-secret" }],
    ["primitive", "fabricated-secret"],
    ["null", null],
    ["throwing accessor", { get code(): never { throw new Error("fabricated-secret"); } }],
  ] as const) {
    it(`redacts ${name} into UNKNOWN`, async t => {
      const fake = mockedProcess(t, { groupSignal: () => { throw error; } });
      const pending = fake.start(); fake.close();
      const result = await pending;
      assert.equal(result.failure, "cleanup_error");
      assert.deepEqual(result.cleanupError, { operation: "killpg", signal: "SIGKILL", code: "UNKNOWN" });
      assert.equal(JSON.stringify(result).includes("fabricated-secret"), false);
    });
  }

  it("preserves timeout and never escalates or retries a refused TERM", async t => {
    const fake = mockedProcess(t, { groupSignal: () => { throw { code: "EPERM" }; } });
    const pending = fake.start();
    t.mock.timers.tick(1000);
    fake.child.emit("error", new Error("fabricated-later-error"));
    t.mock.timers.tick(5000); fake.close();
    const result = await pending;
    assert.equal(result.failure, "timeout");
    assert.deepEqual(result.cleanupError, { operation: "killpg", signal: "SIGTERM", code: "EPERM" });
    assert.deepEqual(fake.signals, [{ pid: -987654, signal: "SIGTERM" }]);
  });

  it("retains forced cleanup failure without repeating KILL at close", async t => {
    const fake = mockedProcess(t, { groupSignal: signal => { if (signal === "SIGKILL") throw { code: "EACCES" }; } });
    const pending = fake.start();
    t.mock.timers.tick(1000); t.mock.timers.tick(500); fake.close();
    const result = await pending;
    assert.equal(result.failure, "timeout");
    assert.deepEqual(result.cleanupError, { operation: "killpg", signal: "SIGKILL", code: "EACCES" });
    assert.deepEqual(fake.signals.map(call => call.signal), ["SIGTERM", "SIGKILL"]);
  });

  it("does not signal a target again after TERM reports ESRCH", async t => {
    const fake = mockedProcess(t, { groupSignal: () => { throw { code: "ESRCH" }; } });
    const pending = fake.start();
    t.mock.timers.tick(1000); t.mock.timers.tick(5000); fake.close();
    const result = await pending;
    assert.equal(result.failure, "timeout");
    assert.equal(result.cleanupError, undefined);
    assert.equal(fake.signals.length, 1);
  });

  it("preserves output-limit evidence and excludes the oversized chunk", async t => {
    const fake = mockedProcess(t, { groupSignal: () => { throw { code: "EPERM" }; } });
    const pending = fake.start({ maxBytes: 2 });
    fake.child.stdout.emit("data", Buffer.from("oversized")); fake.close();
    const result = await pending;
    assert.equal(result.failure, "output_limit");
    assert.equal(result.stdout, "");
    assert.equal(result.cleanupError?.signal, "SIGTERM");
    assert.equal(fake.signals.length, 1);
  });

  it("preserves cancellation when TERM is refused", async t => {
    const controller = new AbortController();
    const fake = mockedProcess(t, { groupSignal: () => { throw { code: "EPERM" }; } });
    const pending = fake.start({ signal: controller.signal });
    controller.abort(); fake.close();
    const result = await pending;
    assert.equal(result.failure, "cancelled");
    assert.equal(result.cleanupError?.code, "EPERM");
    t.mock.timers.tick(5000);
    assert.equal(fake.signals.length, 1);
  });

  it("fails closed when child.kill returns false without an explicit ESRCH", async t => {
    const fake = mockedProcess(t, { pid: null, childSignal: () => false });
    const pending = fake.start();
    t.mock.timers.tick(1000); t.mock.timers.tick(5000); fake.close();
    const result = await pending;
    assert.equal(result.failure, "timeout");
    assert.deepEqual(result.cleanupError, { operation: "kill", signal: "SIGTERM", code: "NOT_SENT" });
    assert.equal(fake.child.kill.mock.callCount(), 1);
    assert.equal(fake.signals.length, 0);
  });

  it("reports direct child signal exceptions without real process calls", async t => {
    const fake = mockedProcess(t, { pid: null, childSignal: () => { throw { code: "EINVAL" }; } });
    const pending = fake.start(); t.mock.timers.tick(1000); fake.close();
    const result = await pending;
    assert.deepEqual(result.cleanupError, { operation: "kill", signal: "SIGTERM", code: "EINVAL" });
    assert.equal(fake.child.kill.mock.callCount(), 1);
    assert.equal(fake.signals.length, 0);
  });

  it("keeps a spawn error when no child target was created", async t => {
    const fake = mockedProcess(t, { pid: null });
    const pending = fake.start();
    fake.child.emit("error", new Error("fabricated-private-spawn-detail")); fake.close(null);
    const result = await pending;
    assert.equal(result.failure, "spawn_error");
    assert.equal(result.cleanupError, undefined);
    assert.equal(fake.child.kill.mock.callCount(), 0);
    assert.equal(fake.signals.length, 0);
  });
});

function closedFact(fact: NativeProcessDiagnostic) {
  assert.deepEqual(Object.keys(fact).sort(), ["childClose", "cleanupError", "failure"]);
  assert.equal(Object.isFrozen(fact), true);
  if (fact.cleanupError) {
    assert.deepEqual(Object.keys(fact.cleanupError).sort(), ["code", "operation", "signal"]);
    assert.equal(Object.isFrozen(fact.cleanupError), true);
  }
  assert.equal(JSON.stringify(fact).includes("fabricated-private"), false);
}

describe("native failure availability without child settlement", { concurrency: false, skip: process.platform === "win32" }, () => {
  it("publishes one coherent refused-TERM fact while close remains awaited", async t => {
    const fake = mockedProcess(t, { groupSignal: () => { throw { code: "EPERM", token: "fabricated-private" }; } });
    const facts: NativeProcessDiagnostic[] = [];
    const pending = fake.start({ onDiagnostic: fact => { facts.push(fact); } });
    let settled = false; void pending.then(() => { settled = true; });
    t.mock.timers.tick(1000); t.mock.timers.tick(10000);
    await Promise.resolve();
    assert.equal(settled, false);
    assert.deepEqual(facts, [{ failure: "timeout", cleanupError: { operation: "killpg", signal: "SIGTERM", code: "EPERM" }, childClose: "unconfirmed" }]);
    closedFact(facts[0]!);
    assert.deepEqual(fake.signals.map(call => call.signal), ["SIGTERM"]);
    fake.close();
    assert.equal((await pending).failure, "timeout");
    assert.equal(facts.length, 1);
    assert.equal(facts[0]!.childClose, "unconfirmed"); // An emitted snapshot is never upgraded.
  });

  it("adds only the later first KILL refusal without fulfilling a missing close", async t => {
    const fake = mockedProcess(t, { groupSignal: signal => { if (signal === "SIGKILL") throw { code: "EACCES" }; } });
    const facts: NativeProcessDiagnostic[] = [];
    const pending = fake.start({ onDiagnostic: fact => { facts.push(fact); } });
    let settled = false; void pending.then(() => { settled = true; });
    t.mock.timers.tick(1000);
    assert.equal(facts.length, 1); assert.equal(facts[0]!.cleanupError, null);
    t.mock.timers.tick(499); assert.equal(fake.signals.length, 1);
    t.mock.timers.tick(1); t.mock.timers.tick(10000); await Promise.resolve();
    assert.equal(settled, false);
    assert.equal(facts.length, 2);
    assert.deepEqual(facts[1], { failure: "timeout", cleanupError: { operation: "killpg", signal: "SIGKILL", code: "EACCES" }, childClose: "unconfirmed" });
    facts.forEach(closedFact);
    assert.notEqual(facts[0], facts[1]);
    fake.close(); await pending;
    assert.deepEqual(fake.signals.map(call => call.signal), ["SIGTERM", "SIGKILL"]);
    assert.equal(facts.length, 2);
  });

  it("keeps successful TERM and KILL timing without inventing close or reaping", async t => {
    const fake = mockedProcess(t);
    const facts: NativeProcessDiagnostic[] = [];
    const pending = fake.start({ onDiagnostic: fact => { facts.push(fact); } });
    let settled = false; void pending.then(() => { settled = true; });
    t.mock.timers.tick(1000); t.mock.timers.tick(499);
    assert.deepEqual(fake.signals.map(call => call.signal), ["SIGTERM"]);
    t.mock.timers.tick(1); await Promise.resolve();
    assert.deepEqual(fake.signals.map(call => call.signal), ["SIGTERM", "SIGKILL"]);
    assert.equal(settled, false); assert.equal(facts.length, 1);
    assert.equal(facts[0]!.childClose, "unconfirmed"); assert.equal(facts[0]!.cleanupError, null);
    fake.close(); await pending;
    // Retain the existing final group cleanup on close; notification adds no signal.
    assert.deepEqual(fake.signals.map(call => call.signal), ["SIGTERM", "SIGKILL", "SIGKILL"]);
    t.mock.timers.tick(10000); assert.equal(fake.signals.length, 3); assert.equal(facts.length, 1);
  });

  for (const kind of ["ESRCH", "NOT_SENT", "UNKNOWN"] as const) {
    it(`reports ${kind} without turning a missing close into completion`, async t => {
      const fake = mockedProcess(t, kind === "NOT_SENT" ? { pid: null, childSignal: () => false } : {
        groupSignal: () => { throw kind === "ESRCH" ? { code: "ESRCH" } : {
          get code(): never { throw new Error("fabricated-private"); }, token: "fabricated-private",
        }; },
      });
      const facts: NativeProcessDiagnostic[] = [];
      const pending = fake.start({ onDiagnostic: fact => { facts.push(fact); } });
      let settled = false; void pending.then(() => { settled = true; });
      t.mock.timers.tick(1000); t.mock.timers.tick(10000); await Promise.resolve();
      assert.equal(settled, false); assert.equal(facts.length, 1); closedFact(facts[0]!);
      assert.equal(facts[0]!.cleanupError?.code ?? null, kind === "ESRCH" ? null : kind);
      assert.equal(fake.signals.length + fake.child.kill.mock.callCount(), 1);
      fake.close(); await pending;
      assert.equal(fake.signals.length + fake.child.kill.mock.callCount(), 1); assert.equal(facts.length, 1);
    });
  }

  for (const failure of ["timeout", "output_limit", "cancelled", "spawn_error"] as const) {
    it(`keeps first ${failure} across later abort/error/cleanup facts`, async t => {
      const fake = mockedProcess(t, { groupSignal: signal => { if (signal === "SIGKILL") throw { code: "EINVAL" }; } });
      const controller = new AbortController(), facts: NativeProcessDiagnostic[] = [];
      const pending = fake.start({ maxBytes: 1, signal: controller.signal, onDiagnostic: fact => { facts.push(fact); } });
      if (failure === "timeout") t.mock.timers.tick(1000);
      else if (failure === "output_limit") fake.child.stdout.emit("data", Buffer.from("fabricated-private"));
      else if (failure === "cancelled") controller.abort();
      else fake.child.emit("error", new Error("fabricated-private"));
      if (failure !== "spawn_error") fake.child.emit("error", new Error("fabricated-private-later"));
      controller.abort(); t.mock.timers.tick(2000);
      fake.close(); const result = await pending;
      assert.equal(result.failure, failure); assert.equal(facts.length, 2);
      assert.equal(facts.every(fact => fact.failure === failure), true);
      assert.equal(facts[1]!.cleanupError?.code, "EINVAL"); facts.forEach(closedFact);
      t.mock.timers.tick(10000); assert.equal(facts.length, 2);
    });
  }

  for (const beforeForce of [true, false]) {
    it(`clears force work when close is ${beforeForce ? "before" : "at"} its boundary`, async t => {
      const fake = mockedProcess(t), facts: NativeProcessDiagnostic[] = [];
      const pending = fake.start({ onDiagnostic: fact => { facts.push(fact); } });
      t.mock.timers.tick(1000); t.mock.timers.tick(beforeForce ? 499 : 500);
      fake.close(); await pending;
      const count = fake.signals.length;
      t.mock.timers.tick(10000);
      assert.equal(count, beforeForce ? 2 : 3); assert.equal(fake.signals.length, count);
      assert.equal(facts.length, 1);
    });
  }

  it("finishes stop bookkeeping before a sink reenters close and throws", async t => {
    const fake = mockedProcess(t), controller = new AbortController(), facts: NativeProcessDiagnostic[] = [];
    const pending = fake.start({ signal: controller.signal, onDiagnostic: fact => {
      facts.push(fact); controller.abort(); fake.close(); throw new Error("fabricated-private");
    } });
    t.mock.timers.tick(1000);
    const result = await pending;
    assert.equal(result.failure, "timeout"); assert.equal(facts.length, 1);
    t.mock.timers.tick(10000); controller.abort();
    assert.deepEqual(fake.signals.map(call => call.signal), ["SIGTERM", "SIGKILL"]);
  });

  it("flushes a reentrant first cleanup fact without nested sink calls", async t => {
    const fake = mockedProcess(t, { groupSignal: signal => { if (signal === "SIGKILL") throw { code: "EPERM" }; } });
    const facts: NativeProcessDiagnostic[] = [];
    let depth = 0, maxDepth = 0;
    const pending = fake.start({ onDiagnostic: fact => {
      depth++; maxDepth = Math.max(depth, maxDepth); facts.push(fact);
      if (facts.length === 1) fake.close();
      depth--;
    } });
    t.mock.timers.tick(1000); await pending;
    assert.equal(maxDepth, 1); assert.equal(facts.length, 2);
    assert.equal(facts[0]!.childClose, "unconfirmed"); assert.equal(facts[1]!.childClose, "observed");
    assert.equal(facts[1]!.cleanupError?.signal, "SIGKILL");
    t.mock.timers.tick(10000); assert.equal(fake.signals.length, 2);
  });

  it("ignores a throwing sink getter before the actual helper invocation", async t => {
    const fake = mockedProcess(t); let reads = 0;
    const options = { cwd: "/fabricated-work", env: {}, timeoutMs: 1000,
      get onDiagnostic(): NativeProcessDiagnosticSink { reads++; throw new Error("fabricated-private"); } };
    const pending = nativeProcess("fabricated-client", [], options);
    t.mock.timers.tick(1000); fake.close();
    assert.equal((await pending).failure, "timeout"); assert.equal(reads, 1);
  });

  it("preserves sync spawn rejection with a closed unconfirmed spawn notice", async t => {
    mockedProcess(t);
    const error = Object.assign(new Error("fabricated-private"), { token: "fabricated-private" });
    t.mock.method(childProcess, "spawn", () => { throw error; });
    const facts: NativeProcessDiagnostic[] = [];
    await assert.rejects(nativeProcess("fabricated-private-command", [], {
      cwd: "/fabricated-private-path", env: {}, onDiagnostic: fact => { facts.push(fact); },
    }), caught => caught === error);
    assert.deepEqual(facts, [{ failure: "spawn_error", cleanupError: null, childClose: "unconfirmed" }]);
    closedFact(facts[0]!);
  });
});
