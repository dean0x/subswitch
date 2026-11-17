import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { describe, it, type TestContext } from "node:test";
import type { NativeCleanupError, NativeProcessResult, NativeDiagnostic,
  NativeDiagnosticOptions } from "../../e2e/gates/native-process.js";

const { nativeProcessJson, nativeProcessFailureReport, NativeProcessFailureError,
  NativeDiagnosticScope, NativeGateFailureError, nativeGateFailureReport, runWithObservedTeardown, closeWithCompletion } =
  await import(new URL("../../e2e/gates/native-process.ts", import.meta.url).href) as
    typeof import("../../e2e/gates/native-process.js");

const cleanup: NativeCleanupError = { operation: "killpg", signal: "SIGKILL", code: "EPERM" };
function guard(t: TestContext) {
  t.mock.method(childProcess, "spawn", () => assert.fail("unexpected child"));
  t.mock.method(process, "kill", () => assert.fail("unexpected signal"));
  t.mock.method(globalThis, "fetch", () => assert.fail("unexpected transport"));
}
function result(extra: Partial<NativeProcessResult> = {}): NativeProcessResult {
  return { code: 0, signal: null, stdout: '{"is_error":false,"result":"fabricated"}', stderr: "", ...extra };
}

describe("closed native caller failure reporting", { concurrency: false }, () => {
  for (const failure of ["timeout", "output_limit", "spawn_error", "cancelled", "cleanup_error"] as const) {
    it(`retains ${failure} and cleanup before reading malformed stdout`, t => {
      guard(t);
      let stdoutReads = 0;
      const native = result({ failure, cleanupError: cleanup });
      Object.defineProperty(native, "stdout", { get() { stdoutReads++; throw new Error("fabricated-private-stdout"); } });
      let captured: unknown;
      try { nativeProcessJson(native); } catch (error) { captured = error; }
      assert.ok(captured instanceof NativeProcessFailureError);
      assert.equal(stdoutReads, 0);
      const fields = nativeProcessFailureReport(captured);
      assert.deepEqual(fields, { nativeExit: failure, nativeCleanupError: cleanup });
      // Both outer gate reports spread this same closed extractor; raw Error fields never enter either report.
      assert.deepEqual(Object.keys(fields!).sort(), ["nativeCleanupError", "nativeExit"]);
    });
  }

  it("parses ordinary successful native stdout", t => {
    guard(t);
    assert.deepEqual(nativeProcessJson(result()), { is_error: false, result: "fabricated" });
  });

  it("leaves a parse error generic and does not report its raw message", t => {
    guard(t);
    let captured: unknown;
    try { nativeProcessJson(result({ stdout: "fabricated-invalid-json" })); } catch (error) { captured = error; }
    assert.ok(captured instanceof SyntaxError);
    assert.equal(nativeProcessFailureReport(captured), undefined);
  });

  it("rejects untyped error lookalikes", t => {
    guard(t);
    assert.equal(nativeProcessFailureReport(Object.assign(new Error("fabricated-secret"), {
      nativeExit: "timeout", nativeCleanupError: cleanup, cause: { token: "fabricated-token" },
    })), undefined);
  });

  it("copies only allowlisted cleanup fields into the typed failure and report", t => {
    guard(t);
    const extra = { ...cleanup, pid: 123, token: "fabricated-secret", message: "fabricated-message" };
    const error = new NativeProcessFailureError("timeout", extra);
    assert.notEqual(error.nativeCleanupError, extra);
    assert.deepEqual(error.nativeCleanupError, cleanup);
    assert.deepEqual(nativeProcessFailureReport(error), { nativeExit: "timeout", nativeCleanupError: cleanup });
    assert.equal(JSON.stringify(nativeProcessFailureReport(error)).includes("fabricated"), false);
  });

  it("drops malformed cleanup fields while preserving the earlier failure", t => {
    guard(t);
    const error = new NativeProcessFailureError("cancelled", { ...cleanup, code: "fabricated-secret" } as unknown as NativeCleanupError);
    assert.deepEqual(nativeProcessFailureReport(error), { nativeExit: "cancelled", nativeCleanupError: null });
    Object.defineProperty(error, "nativeCleanupError", { get() { throw new Error("fabricated-secret"); } });
    assert.deepEqual(nativeProcessFailureReport(error), { nativeExit: "cancelled", nativeCleanupError: null });
  });

  it("rejects an invalid mutated failure field", t => {
    guard(t);
    const error = new NativeProcessFailureError("cleanup_error", cleanup);
    Object.defineProperty(error, "nativeExit", { value: "fabricated-secret" });
    assert.equal(nativeProcessFailureReport(error), undefined);
    assert.equal(nativeProcessFailureReport(new Proxy({}, {
      getPrototypeOf() { throw new Error("fabricated-secret"); },
    })), undefined);
  });
});

function deferred() {
  let resolve!: () => void, reject!: (reason: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function observed(t: TestContext, options?: NativeDiagnosticOptions) {
  guard(t); t.mock.timers.enable({ apis: ["setTimeout"] });
  const diagnostics: NativeDiagnostic[] = [];
  const scope = new NativeDiagnosticScope(options ?? { onDiagnostic: diagnostic => { diagnostics.push(diagnostic); } });
  return { scope, diagnostics };
}
function closedDiagnostic(d: NativeDiagnostic) {
  assert.deepEqual(Object.keys(d).sort(), ["childClose", "cleanupError", "component", "event", "failure", "schemaVersion", "step"]);
  assert.equal(Object.isFrozen(d), true);
  if (d.cleanupError) {
    assert.equal(Object.isFrozen(d.cleanupError), true);
    assert.deepEqual(Object.keys(d.cleanupError).sort(), ["code", "operation", "signal"]);
  }
  assert.equal(JSON.stringify(d).includes("fabricated-private"), false);
}

describe("awaited teardown evidence", { concurrency: false }, () => {
  it("retains the native primary across sync throw, rejection and independent later cleanup", async t => {
    const { scope, diagnostics } = observed(t), order: string[] = [];
    const original = new NativeProcessFailureError("timeout", cleanup);
    const pending = runWithObservedTeardown(() => { throw original; }, () => [
      { step: "transport_stop", run: () => { order.push("transport"); throw new Error("fabricated-private-one"); } },
      { step: "relay_close", run: async () => { order.push("relay"); throw { token: "fabricated-private-two" }; } },
      { step: "temp_remove", run: () => { order.push("temp"); } },
    ], scope, "capture_teardown");
    let caught: unknown;
    try { await pending; } catch (error) { caught = error; }
    assert.ok(caught instanceof NativeGateFailureError);
    assert.equal(caught.message, "native_gate_failed"); assert.equal("cause" in caught, false);
    assert.deepEqual(order, ["transport", "relay", "temp"]);
    const fields = nativeGateFailureReport(caught)!;
    assert.equal(fields.nativeExit, "timeout"); assert.deepEqual(fields.nativeCleanupError, cleanup);
    assert.equal(fields.nativeTeardown?.step, "transport_stop");
    assert.equal(diagnostics.length, 1); assert.equal(diagnostics[0]!.event, "teardown_failed");
    closedDiagnostic(diagnostics[0]!);
    t.mock.timers.tick(10000); assert.equal(diagnostics.length, 1);
  });

  for (const operationFailed of [true, false]) {
    it(`reports ${operationFailed ? "unknown original failure" : "cleanup-first failure"} with a closed primary`, async t => {
      const { scope, diagnostics } = observed(t);
      const value = { get success(): never { throw new Error("fabricated-private-result-getter"); } };
      const pending = runWithObservedTeardown(() => {
        if (operationFailed) throw new Error("fabricated-private-original");
        return value;
      }, () => [{ step: "temp_remove", run: () => { throw new Error("fabricated-private-teardown"); } }], scope, "capture_teardown");
      await assert.rejects(pending, error => {
        const report = nativeGateFailureReport(error);
        assert.equal(report?.nativeExit, operationFailed ? "gate_error" : "teardown_error");
        assert.equal(report?.nativeCleanupError, null);
        assert.equal(JSON.stringify(report).includes("fabricated-private"), false);
        return error instanceof NativeGateFailureError;
      });
      assert.equal(diagnostics.length, 1); closedDiagnostic(diagnostics[0]!);
    });
  }

  it("keeps a never-settling reached step awaited and later actions unstarted", async t => {
    const { scope, diagnostics } = observed(t), entered = deferred(), finish = deferred();
    const order: string[] = [], value = { success: true, token: "fabricated-private-value" };
    const pending = runWithObservedTeardown(() => value, () => [
      { step: "relay_close", run: () => { order.push("relay"); entered.resolve(); return finish.promise; } },
      { step: "temp_remove", run: () => { order.push("temp"); } },
    ], scope, "capture_teardown");
    let settled = false; void pending.then(() => { settled = true; });
    await entered.promise;
    t.mock.timers.tick(499); assert.equal(diagnostics.length, 0);
    t.mock.timers.tick(1); t.mock.timers.tick(10000); await Promise.resolve();
    assert.equal(settled, false); assert.deepEqual(order, ["relay"]);
    assert.deepEqual(diagnostics, [{ schemaVersion: 1, event: "teardown_pending", component: "capture_teardown",
      failure: null, cleanupError: null, childClose: "not_applicable", step: "relay_close" }]);
    closedDiagnostic(diagnostics[0]!);
    finish.resolve(); assert.equal(await pending, value); assert.deepEqual(order, ["relay", "temp"]);
    t.mock.timers.tick(10000); assert.equal(diagnostics.length, 1);
  });

  it("uses one scope timer and reports the currently awaited step without restarting it", async t => {
    const { scope, diagnostics } = observed(t), first = deferred(), second = deferred(), firstEntered = deferred(), secondEntered = deferred();
    const pending = runWithObservedTeardown(() => 42, () => [
      { step: "transport_stop", run: () => { firstEntered.resolve(); return first.promise; } },
      { step: "proxy_close", run: () => { secondEntered.resolve(); return second.promise; } },
    ], scope, "reverse_teardown");
    await firstEntered.promise; t.mock.timers.tick(400); first.resolve(); await secondEntered.promise;
    t.mock.timers.tick(99); assert.equal(diagnostics.length, 0);
    t.mock.timers.tick(1); assert.equal(diagnostics.length, 1); assert.equal(diagnostics[0]!.step, "proxy_close");
    second.resolve(); assert.equal(await pending, 42);
    t.mock.timers.tick(10000); assert.equal(diagnostics.length, 1);
  });

  it("keeps pending plus failed evidence when a manually settled teardown rejects", async t => {
    const { scope, diagnostics } = observed(t), entered = deferred(), finish = deferred();
    const original = new NativeProcessFailureError("cancelled", cleanup), order: string[] = [];
    const pending = runWithObservedTeardown(() => { throw original; }, () => [
      { step: "proxy_close", run: () => { entered.resolve(); return finish.promise; } },
      { step: "temp_remove", run: () => { order.push("temp"); } },
    ], scope, "reverse_teardown");
    // Attach the rejection assertion before releasing the fabricated failed step.
    const checked = assert.rejects(pending, error => {
      const report = nativeGateFailureReport(error)!;
      assert.equal(report.nativeExit, "cancelled"); assert.deepEqual(report.nativeCleanupError, cleanup);
      assert.equal(report.nativeTeardown?.step, "proxy_close"); return error instanceof NativeGateFailureError;
    });
    await entered.promise; t.mock.timers.tick(500);
    assert.equal(diagnostics[0]!.failure, "cancelled");
    finish.reject(new Error("fabricated-private-rejection")); await checked;
    assert.deepEqual(order, ["temp"]);
    assert.deepEqual(diagnostics.map(d => d.event), ["teardown_pending", "teardown_failed"]);
    diagnostics.forEach(closedDiagnostic);
  });

  it("keeps nested cleanup components separate without re-emitting native facts", async t => {
    const { scope, diagnostics } = observed(t), order: string[] = [];
    const pending = runWithObservedTeardown(() => runWithObservedTeardown(() => {
      scope.bindNative("reverse_native")({ failure: "output_limit", cleanupError: cleanup, childClose: "unconfirmed" });
      throw new NativeProcessFailureError("output_limit", cleanup);
    }, () => [{ step: "upstream_close", run: () => { order.push("reverse"); throw new Error("fabricated-private-reverse"); } }], scope, "reverse_teardown"),
    () => [{ step: "relay_close", run: () => { order.push("capture"); throw new Error("fabricated-private-capture"); } }], scope, "capture_teardown");
    await assert.rejects(pending, error => {
      const fields = nativeGateFailureReport(error)!;
      assert.equal(fields.nativeExit, "output_limit"); assert.deepEqual(fields.nativeCleanupError, cleanup);
      assert.equal(fields.nativeTeardown?.component, "reverse_teardown");
      return error instanceof NativeGateFailureError;
    });
    assert.deepEqual(order, ["reverse", "capture"]);
    assert.deepEqual(diagnostics.map(d => [d.event, d.component]), [
      ["native_failure", "reverse_native"], ["teardown_failed", "reverse_teardown"], ["teardown_failed", "capture_teardown"],
    ]);
    diagnostics.forEach(closedDiagnostic);
  });

  it("marks a known failed report explicitly without reading arbitrary result getters", async t => {
    const { scope } = observed(t);
    const value = { get success(): never { throw new Error("fabricated-private-getter"); } };
    const pending = runWithObservedTeardown(() => {
      scope.markFailure("spawn_error", cleanup); return value;
    }, () => [{ step: "temp_remove", run: () => { throw new Error("fabricated-private"); } }], scope, "capture_teardown");
    await assert.rejects(pending, error => nativeGateFailureReport(error)?.nativeExit === "spawn_error");
  });

  it("leaves successful generic values and original errors unchanged after fast cleanup", async t => {
    const { scope, diagnostics } = observed(t);
    const value = { get success(): never { throw new Error("fabricated-private-getter"); } };
    assert.equal(await runWithObservedTeardown(() => value, () => [], scope, "capture_teardown"), value);
    const original = new Error("fabricated-private-original");
    await assert.rejects(runWithObservedTeardown(() => { throw original; }, () => [
      { step: "temp_remove", run: () => undefined },
    ], scope, "reverse_teardown"), error => error === original);
    t.mock.timers.tick(10000); assert.deepEqual(diagnostics, []);
  });

  it("omits automatic I/O with no sink while retaining eventual closed failure", async t => {
    observed(t, {});
    t.mock.method(console, "log", () => assert.fail("automatic stdout"));
    t.mock.method(console, "error", () => assert.fail("automatic stderr"));
    const scope = new NativeDiagnosticScope();
    const entered = deferred(), finish = deferred(), value = { success: true };
    const pending = runWithObservedTeardown(() => value, () => [
      { step: "relay_close", run: () => { entered.resolve(); return finish.promise; } },
    ], scope, "capture_teardown");
    const checked = assert.rejects(pending, error => nativeGateFailureReport(error)?.nativeExit === "teardown_error");
    await entered.promise; t.mock.timers.tick(500); finish.reject(new Error("fabricated-private")); await checked;
  });

  it("ignores sink throws and a throwing options getter without altering awaited work", async t => {
    observed(t, {}); let reads = 0, attempts = 0;
    const options: NativeDiagnosticOptions = { get onDiagnostic(): never { reads++; throw new Error("fabricated-private"); } };
    const scope = new NativeDiagnosticScope(options);
    assert.equal(await runWithObservedTeardown(() => 7, () => [], scope, "capture_teardown"), 7);
    assert.equal(reads, 1);
    const throwing = new NativeDiagnosticScope({ onDiagnostic: () => { attempts++; throw new Error("fabricated-private"); } });
    const entered = deferred(), finish = deferred();
    const pending = runWithObservedTeardown(() => 8, () => [
      { step: "relay_close", run: () => { entered.resolve(); return finish.promise; } },
    ], throwing, "capture_teardown");
    await entered.promise; t.mock.timers.tick(500); finish.resolve();
    assert.equal(await pending, 8); assert.equal(attempts, 1);
  });

  it("latches first facts per component and copies fresh frozen allowlisted fields", t => {
    const { scope, diagnostics } = observed(t);
    const notify = scope.bindNative("capture_native");
    notify({ failure: "timeout", cleanupError: null, childClose: "unconfirmed" });
    notify({ failure: "timeout", cleanupError: null, childClose: "observed" });
    const extra = { ...cleanup, token: "fabricated-private" };
    notify({ failure: "timeout", cleanupError: extra, childClose: "unconfirmed" });
    notify({ failure: "cancelled", cleanupError: cleanup, childClose: "observed" });
    scope.teardownPending("capture_teardown", "relay_close"); scope.teardownPending("capture_teardown", "temp_remove");
    scope.teardownFailed("capture_teardown", "temp_remove"); scope.teardownFailed("capture_teardown", "relay_close");
    assert.equal(diagnostics.length, 4); diagnostics.forEach(closedDiagnostic);
    assert.equal(diagnostics[0]!.cleanupError, null);
    assert.notEqual(diagnostics[1]!.cleanupError, extra);
    assert.equal(scope.failureReport()?.nativeExit, "timeout");
    assert.deepEqual(scope.failureReport()?.nativeCleanupError, cleanup);
    assert.notEqual(scope.failureReport()?.nativeCleanupError, scope.failureReport()?.nativeCleanupError);
  });

  it("rejects lookalikes, getters and arbitrary diagnostic labels without private output", t => {
    const { scope, diagnostics } = observed(t);
    const invalid = { get failure(): never { throw new Error("fabricated-private"); } };
    scope.bindNative("capture_native")(invalid as never);
    scope.bindNative("fabricated-private" as never)({ failure: "timeout", cleanupError: cleanup, childClose: "unconfirmed" });
    scope.teardownFailed("capture_teardown", "fabricated-private" as never);
    scope.teardownPending("fabricated-private" as never, "temp_remove");
    assert.deepEqual(diagnostics, []);
    assert.equal(nativeGateFailureReport({ nativeExit: "timeout", nativeCleanupError: cleanup }), undefined);
    assert.equal(nativeGateFailureReport(new Proxy({}, { getPrototypeOf() { throw new Error("fabricated-private"); } })), undefined);
    scope.teardownFailed("capture_teardown", "temp_remove");
    const error = scope.failureError();
    Object.assign(error, { cause: { token: "fabricated-private" }, stdout: "fabricated-private", pid: 123 });
    const report = nativeGateFailureReport(error)!;
    assert.deepEqual(Object.keys(report).sort(), ["nativeCleanupError", "nativeExit", "nativeTeardown"]);
    assert.equal(JSON.stringify(report).includes("fabricated-private"), false);
    Object.defineProperty(error, "nativeTeardown", { get() { throw new Error("fabricated-private"); } });
    assert.deepEqual(nativeGateFailureReport(error), { nativeExit: "teardown_error", nativeCleanupError: null });
    Object.defineProperty(error, "nativeExit", { value: "fabricated-private" });
    assert.equal(nativeGateFailureReport(error), undefined);
  });
});

describe("callback close completion", { concurrency: false }, () => {
  for (const { policy, component, step } of [
    { policy: "strict", component: "reverse_teardown", step: "transport_stop" },
    { policy: "node_server", component: "capture_teardown", step: "relay_close" },
  ] as const) {
    it(`awaits the ${policy} close callback through pending evidence and later cleanup`, async t => {
      const { scope, diagnostics } = observed(t), entered = deferred(), order: string[] = [];
      const value = { token: "fabricated-private-result" };
      let complete!: (error?: Error) => void, settled = false;
      const pending = runWithObservedTeardown(() => value, () => [
        { step, run: () => closeWithCompletion(done => {
          order.push("close_start"); complete = done; entered.resolve();
        }, policy) },
        { step: "temp_remove", run: () => { order.push("later_cleanup"); } },
      ], scope, component);
      void pending.then(() => { settled = true; }, () => { settled = true; });
      await entered.promise;
      t.mock.timers.tick(499); assert.deepEqual(diagnostics, []);
      t.mock.timers.tick(1); t.mock.timers.tick(10000); await Promise.resolve();
      assert.equal(settled, false); assert.deepEqual(order, ["close_start"]);
      assert.deepEqual(diagnostics, [{ schemaVersion: 1, event: "teardown_pending", component,
        failure: null, cleanupError: null, childClose: "not_applicable", step }]);
      closedDiagnostic(diagnostics[0]!);
      complete(); assert.equal(await pending, value);
      assert.deepEqual(order, ["close_start", "later_cleanup"]);
      t.mock.timers.tick(10000); assert.equal(diagnostics.length, 1);
    });
  }

  it("retains the native primary and one failed snapshot across callback errors and later cleanup", async t => {
    const { scope, diagnostics } = observed(t), entered = deferred(), order: string[] = [];
    const original = new NativeProcessFailureError("timeout", cleanup);
    const callbackError = Object.assign(new Error("fabricated-private-close"), {
      code: "EPERM", token: "fabricated-private-token", url: "https://fabricated-private.invalid/",
    });
    let complete!: (error?: Error) => void;
    const pending = runWithObservedTeardown(() => { throw original; }, () => [
      { step: "transport_stop", run: () => closeWithCompletion(done => {
        order.push("close_start"); complete = done; entered.resolve();
      }) },
      { step: "upstream_close", run: () => closeWithCompletion(done => {
        order.push("later_close"); done(new Error("fabricated-private-later-close"));
      }, "node_server") },
      { step: "temp_remove", run: () => { order.push("later_cleanup"); } },
    ], scope, "reverse_teardown");
    const checked = assert.rejects(pending, error => {
      assert.ok(error instanceof NativeGateFailureError);
      assert.equal(error.message, "native_gate_failed"); assert.equal("cause" in error, false);
      const fields = nativeGateFailureReport(error)!;
      assert.equal(fields.nativeExit, "timeout"); assert.deepEqual(fields.nativeCleanupError, cleanup);
      assert.deepEqual(fields.nativeTeardown, diagnostics[0]);
      assert.equal(fields.nativeTeardown?.step, "transport_stop");
      assert.equal(JSON.stringify(fields).includes("fabricated-private"), false);
      return true;
    });
    await entered.promise; assert.deepEqual(order, ["close_start"]);
    complete(callbackError); await checked;
    assert.deepEqual(order, ["close_start", "later_close", "later_cleanup"]);
    assert.equal(diagnostics.length, 1); assert.equal(diagnostics[0]!.event, "teardown_failed");
    closedDiagnostic(diagnostics[0]!);
    t.mock.timers.tick(10000); assert.equal(diagnostics.length, 1);
  });

  for (const policy of ["strict", "node_server"] as const) {
    it(`propagates a synchronous ${policy} close throw without losing native precedence or later actions`, async t => {
      const { scope, diagnostics } = observed(t), order: string[] = [];
      const original = new NativeProcessFailureError("cancelled", cleanup);
      const closeError = Object.assign(new Error("fabricated-private-sync-close"), { code: "ERR_SERVER_NOT_RUNNING" });
      const pending = runWithObservedTeardown(() => { throw original; }, () => [
        { step: "relay_close", run: () => closeWithCompletion(() => {
          order.push("close_start"); throw closeError;
        }, policy) },
        { step: "temp_remove", run: () => { order.push("later_cleanup"); } },
      ], scope, "capture_teardown");
      await assert.rejects(pending, error => {
        const fields = nativeGateFailureReport(error)!;
        assert.equal(fields.nativeExit, "cancelled"); assert.deepEqual(fields.nativeCleanupError, cleanup);
        assert.equal(fields.nativeTeardown?.step, "relay_close");
        assert.equal(JSON.stringify(fields).includes("fabricated-private"), false);
        return error instanceof NativeGateFailureError;
      });
      assert.deepEqual(order, ["close_start", "later_cleanup"]);
      assert.equal(diagnostics.length, 1); closedDiagnostic(diagnostics[0]!);
    });
  }

  it("accepts only the Node already-not-open callback code without reading its message", async t => {
    const { scope, diagnostics } = observed(t), order: string[] = [], value = {};
    const callbackError = Object.assign(new Error(), { code: "ERR_SERVER_NOT_RUNNING" });
    let messageReads = 0;
    Object.defineProperty(callbackError, "message", { get() { messageReads++; throw new Error("fabricated-private-message"); } });
    assert.equal(await runWithObservedTeardown(() => value, () => [
      { step: "relay_close", run: () => closeWithCompletion(done => {
        order.push("close_start"); done(callbackError);
      }, "node_server") },
      { step: "temp_remove", run: () => { order.push("later_cleanup"); } },
    ], scope, "capture_teardown"), value);
    assert.deepEqual(order, ["close_start", "later_cleanup"]);
    assert.equal(messageReads, 0); t.mock.timers.tick(10000); assert.deepEqual(diagnostics, []);
  });

  it("does not apply the Node benign policy to the default WebSocket adapter", async t => {
    const { scope, diagnostics } = observed(t), order: string[] = [];
    const callbackError = Object.assign(new Error("fabricated-private-wss"), { code: "ERR_SERVER_NOT_RUNNING" });
    await assert.rejects(runWithObservedTeardown(() => 42, () => [
      { step: "transport_stop", run: () => closeWithCompletion(done => done(callbackError)) },
      { step: "temp_remove", run: () => { order.push("later_cleanup"); } },
    ], scope, "reverse_teardown"), error => {
      const fields = nativeGateFailureReport(error)!;
      assert.equal(fields.nativeExit, "teardown_error"); assert.equal(fields.nativeTeardown?.step, "transport_stop");
      assert.equal(JSON.stringify(fields).includes("fabricated-private"), false);
      return error instanceof NativeGateFailureError;
    });
    assert.deepEqual(order, ["later_cleanup"]); assert.equal(diagnostics.length, 1); closedDiagnostic(diagnostics[0]!);
  });

  for (const kind of ["unexpected_code", "message_only", "throwing_code"] as const) {
    it(`keeps a Node ${kind} callback error as a closed failure`, async t => {
      const { scope, diagnostics } = observed(t), order: string[] = [];
      const callbackError = new Error("The server is not running: fabricated-private");
      if (kind === "unexpected_code") Object.assign(callbackError, { code: "ERR_SERVER_NOT_RUNNING_extra" });
      if (kind === "throwing_code") Object.defineProperty(callbackError, "code", {
        get() { throw new Error("fabricated-private-code"); },
      });
      await assert.rejects(runWithObservedTeardown(() => 42, () => [
        { step: "proxy_close", run: () => closeWithCompletion(done => done(callbackError), "node_server") },
        { step: "temp_remove", run: () => { order.push("later_cleanup"); } },
      ], scope, "reverse_teardown"), error => {
        const fields = nativeGateFailureReport(error)!;
        assert.equal(fields.nativeExit, "teardown_error"); assert.equal(fields.nativeTeardown?.step, "proxy_close");
        assert.equal(fields.nativeCleanupError, null);
        assert.equal(JSON.stringify(fields).includes("fabricated-private"), false);
        return error instanceof NativeGateFailureError;
      });
      assert.deepEqual(order, ["later_cleanup"]); assert.equal(diagnostics.length, 1); closedDiagnostic(diagnostics[0]!);
    });
  }

  it("keeps callback failure private and awaited with no diagnostic sink", async t => {
    observed(t, {});
    t.mock.method(console, "log", () => assert.fail("automatic stdout"));
    t.mock.method(console, "error", () => assert.fail("automatic stderr"));
    const scope = new NativeDiagnosticScope(), entered = deferred(), order: string[] = [];
    let complete!: (error?: Error) => void, settled = false;
    const pending = runWithObservedTeardown(() => ({ token: "fabricated-private-result" }), () => [
      { step: "upstream_close", run: () => closeWithCompletion(done => {
        complete = done; entered.resolve();
      }, "node_server") },
      { step: "temp_remove", run: () => { order.push("later_cleanup"); } },
    ], scope, "reverse_teardown");
    void pending.then(() => { settled = true; }, () => { settled = true; });
    const checked = assert.rejects(pending, error => {
      const fields = nativeGateFailureReport(error)!;
      assert.equal(fields.nativeExit, "teardown_error"); assert.equal(fields.nativeTeardown?.step, "upstream_close");
      assert.equal(JSON.stringify(fields).includes("fabricated-private"), false);
      return error instanceof NativeGateFailureError;
    });
    await entered.promise; t.mock.timers.tick(10000); await Promise.resolve();
    assert.equal(settled, false); assert.deepEqual(order, []);
    complete(new Error("fabricated-private-callback")); await checked;
    assert.deepEqual(order, ["later_cleanup"]);
  });
});
