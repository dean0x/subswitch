import childProcess from "node:child_process";

export interface NativeCleanupError {
  readonly operation: "killpg" | "kill";
  readonly signal: "SIGTERM" | "SIGKILL";
  readonly code: "EPERM" | "EACCES" | "EINVAL" | "NOT_SENT" | "UNKNOWN";
}

function signalErrorCode(error: unknown): NativeCleanupError["code"] | "ESRCH" {
  try {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "ESRCH" || code === "EPERM" || code === "EACCES" || code === "EINVAL") return code;
  } catch { /* Even a hostile error accessor must not expose raw exception data. */ }
  return "UNKNOWN";
}

export interface NativeProcessResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly failure?: "timeout" | "output_limit" | "spawn_error" | "cancelled" | "cleanup_error";
  /** First unexpected signal failure only. Never includes a PID or raw exception. */
  readonly cleanupError?: NativeCleanupError;
  /** In-memory inspection only. Callers must emit allowlisted diagnostics. */
  readonly stdout: string;
  readonly stderr: string;
}

type NativeFailure = NonNullable<NativeProcessResult["failure"]>;

function closedCleanupError(value: unknown): NativeCleanupError | null {
  try {
    const diagnostic = value as Partial<NativeCleanupError> | null | undefined;
    const operation = diagnostic?.operation, signal = diagnostic?.signal, code = diagnostic?.code;
    if ((operation === "killpg" || operation === "kill") && (signal === "SIGTERM" || signal === "SIGKILL") &&
      (code === "EPERM" || code === "EACCES" || code === "EINVAL" || code === "NOT_SENT" || code === "UNKNOWN")) {
      return Object.freeze({ operation, signal, code });
    }
  } catch { /* No raw value or accessor failure belongs in a report. */ }
  return null;
}

/** Carry only closed native failure fields across a caller boundary. */
export class NativeProcessFailureError extends Error {
  readonly nativeExit: NativeFailure;
  readonly nativeCleanupError: NativeCleanupError | null;
  constructor(failure: NativeFailure, cleanupError?: NativeCleanupError) {
    super("native_process_failed");
    this.nativeExit = failure;
    this.nativeCleanupError = closedCleanupError(cleanupError);
  }
}

export function nativeProcessFailureReport(error: unknown): {
  nativeExit: NativeFailure; nativeCleanupError: NativeCleanupError | null;
} | undefined {
  try {
    if (!(error instanceof NativeProcessFailureError)) return undefined;
    const failure = error.nativeExit;
    if (failure === "timeout" || failure === "output_limit" || failure === "spawn_error" ||
      failure === "cancelled" || failure === "cleanup_error") {
      let cleanup: unknown;
      try { cleanup = error.nativeCleanupError; } catch { /* Keep the validated first failure. */ }
      return { nativeExit: failure, nativeCleanupError: closedCleanupError(cleanup) };
    }
  } catch { /* Preserve the caller's generic failure rather than emit unvalidated data. */ }
  return undefined;
}

/** A returned native failure takes precedence over parsing any stdout. */
export function nativeProcessJson(result: NativeProcessResult): unknown {
  if (result.failure) throw new NativeProcessFailureError(result.failure, result.cleanupError);
  return JSON.parse(result.stdout);
}

export interface NativeProcessDiagnostic {
  readonly failure: NativeFailure;
  readonly cleanupError: NativeCleanupError | null;
  readonly childClose: "observed" | "unconfirmed";
}
export type NativeProcessDiagnosticSink = (diagnostic: NativeProcessDiagnostic) => undefined;
type NativeComponent = "capture_native" | "reverse_version" | "reverse_native";
type TeardownComponent = "capture_teardown" | "reverse_teardown";
type TeardownStep = "transport_stop" | "proxy_close" | "upstream_close" | "relay_close" | "temp_remove";
type GateFailure = NativeFailure | "gate_error" | "teardown_error";
export interface NativeDiagnostic {
  readonly schemaVersion: 1;
  readonly event: "native_failure" | "teardown_pending" | "teardown_failed";
  readonly component: NativeComponent | TeardownComponent;
  readonly failure: GateFailure | null;
  readonly cleanupError: NativeCleanupError | null;
  readonly childClose: "observed" | "unconfirmed" | "not_applicable";
  readonly step: "none" | TeardownStep;
}
/** Trusted passive synchronous sink. Blocking/async callbacks are outside this contract. */
export type NativeDiagnosticSink = (diagnostic: NativeDiagnostic) => undefined;
export interface NativeDiagnosticOptions { readonly onDiagnostic?: NativeDiagnosticSink }

function nativeFailure(value: unknown): value is NativeFailure {
  return value === "timeout" || value === "output_limit" || value === "spawn_error" ||
    value === "cancelled" || value === "cleanup_error";
}
function gateFailure(value: unknown): value is GateFailure {
  return nativeFailure(value) || value === "gate_error" || value === "teardown_error";
}
function teardownComponent(value: unknown): value is TeardownComponent {
  return value === "capture_teardown" || value === "reverse_teardown";
}
function teardownStep(value: unknown): value is TeardownStep {
  return value === "transport_stop" || value === "proxy_close" || value === "upstream_close" ||
    value === "relay_close" || value === "temp_remove";
}
function frozenNativeFact(failure: NativeFailure, cleanup: unknown,
  childClose: NativeProcessDiagnostic["childClose"]): NativeProcessDiagnostic {
  return Object.freeze({ failure, cleanupError: closedCleanupError(cleanup), childClose });
}
function frozenDiagnostic(event: NativeDiagnostic["event"], component: NativeDiagnostic["component"],
  failure: GateFailure | null, cleanup: unknown, childClose: NativeDiagnostic["childClose"],
  step: NativeDiagnostic["step"]): NativeDiagnostic {
  return Object.freeze({ schemaVersion: 1, event, component, failure,
    cleanupError: closedCleanupError(cleanup), childClose, step });
}
function closedTeardown(value: unknown): NativeDiagnostic | null {
  try {
    const d = value as Partial<NativeDiagnostic> | null;
    const event = d?.event, component = d?.component, failure = d?.failure, step = d?.step;
    if (d?.schemaVersion === 1 && event === "teardown_failed" &&
      (component === "capture_teardown" || component === "reverse_teardown") &&
      gateFailure(failure) && d?.childClose === "not_applicable" &&
      (step === "transport_stop" || step === "proxy_close" || step === "upstream_close" ||
        step === "relay_close" || step === "temp_remove")) {
      return frozenDiagnostic(event, component, failure, d.cleanupError, "not_applicable", step);
    }
  } catch { /* Unvalidated values never become diagnostics. */ }
  return null;
}

/** Contains no raw cause, result, output or cleanup ownership handle. */
export class NativeGateFailureError extends Error {
  readonly nativeExit: GateFailure;
  readonly nativeCleanupError: NativeCleanupError | null;
  readonly nativeTeardown: NativeDiagnostic | null;
  constructor(failure: GateFailure, cleanup: unknown, teardown: NativeDiagnostic) {
    super("native_gate_failed");
    this.nativeExit = gateFailure(failure) ? failure : "gate_error";
    this.nativeCleanupError = closedCleanupError(cleanup);
    this.nativeTeardown = closedTeardown(teardown);
  }
}
export function nativeGateFailureReport(error: unknown): {
  nativeExit: GateFailure; nativeCleanupError: NativeCleanupError | null; nativeTeardown?: NativeDiagnostic;
} | undefined {
  const native = nativeProcessFailureReport(error);
  if (native) return native;
  try {
    if (!(error instanceof NativeGateFailureError)) return undefined;
    const failure = error.nativeExit;
    if (!gateFailure(failure)) return undefined;
    let cleanup: unknown, teardown: unknown;
    try { cleanup = error.nativeCleanupError; } catch { /* Retain validated primary. */ }
    try { teardown = error.nativeTeardown; } catch { /* Do not emit accessor failures. */ }
    const closed = closedTeardown(teardown);
    return { nativeExit: failure, nativeCleanupError: closedCleanupError(cleanup),
      ...(closed ? { nativeTeardown: closed } : {}) };
  } catch { return undefined; }
}

/** Invocation-local metadata only; does not own, complete or cancel child/teardown work. */
export class NativeDiagnosticScope {
  #sink: NativeDiagnosticSink | undefined;
  #failure: GateFailure | null = null;
  #cleanup: NativeCleanupError | null = null;
  #teardown: NativeDiagnostic | undefined;
  #native = new Map<NativeComponent, { failure: boolean; cleanup: boolean }>();
  #pending = new Set<TeardownComponent>();
  #failed = new Set<TeardownComponent>();
  constructor(options?: NativeDiagnosticOptions) {
    try { const sink = options?.onDiagnostic; if (typeof sink === "function") this.#sink = sink; }
    catch { /* A diagnostic accessor cannot prevent the operation. */ }
  }
  #emit(diagnostic: NativeDiagnostic): void {
    try { this.#sink?.(diagnostic); } catch { /* Passive diagnostics cannot replace failure or success. */ }
  }
  markFailure(failure: GateFailure = "gate_error", cleanup?: unknown): void {
    this.#failure ??= gateFailure(failure) ? failure : "gate_error";
    this.#cleanup ??= closedCleanupError(cleanup);
  }
  recordFailure(error: unknown): void {
    const fields = nativeGateFailureReport(error);
    this.markFailure(fields?.nativeExit ?? "gate_error", fields?.nativeCleanupError);
    if (fields?.nativeTeardown) this.#teardown ??= fields.nativeTeardown;
  }
  failureReport(): ReturnType<typeof nativeGateFailureReport> {
    if (!this.#failure) return undefined;
    return { nativeExit: this.#failure, nativeCleanupError: closedCleanupError(this.#cleanup),
      ...(this.#teardown ? { nativeTeardown: closedTeardown(this.#teardown)! } : {}) };
  }
  bindNative(component: NativeComponent): NativeProcessDiagnosticSink {
    return fact => {
      try {
        if (component !== "capture_native" && component !== "reverse_version" && component !== "reverse_native") return;
        const failure = fact.failure, close = fact.childClose;
        if (!nativeFailure(failure) || (close !== "observed" && close !== "unconfirmed")) return;
        const cleanup = closedCleanupError(fact.cleanupError);
        this.markFailure(failure, cleanup);
        const seen = this.#native.get(component) ?? { failure: false, cleanup: false };
        if (seen.failure && (!cleanup || seen.cleanup)) return;
        seen.failure = true; seen.cleanup ||= cleanup !== null;
        this.#native.set(component, seen); // Latch before entering user code.
        this.#emit(frozenDiagnostic("native_failure", component, failure, cleanup, close, "none"));
      } catch { /* Reject malformed facts/accessors; never copy their raw data. */ }
    };
  }
  teardownPending(component: TeardownComponent, step: TeardownStep): void {
    if (!teardownComponent(component) || !teardownStep(step)) return;
    if (this.#pending.has(component)) return;
    this.#pending.add(component);
    this.#emit(frozenDiagnostic("teardown_pending", component, this.#failure, this.#cleanup, "not_applicable", step));
  }
  teardownFailed(component: TeardownComponent, step: TeardownStep): void {
    if (!teardownComponent(component) || !teardownStep(step)) return;
    this.markFailure("teardown_error");
    if (this.#failed.has(component)) return;
    this.#failed.add(component);
    const diagnostic = frozenDiagnostic("teardown_failed", component, this.#failure, this.#cleanup, "not_applicable", step);
    this.#teardown ??= diagnostic;
    this.#emit(diagnostic);
  }
  failureError(): NativeGateFailureError {
    // Called only after a reached cleanup action failed, so the first snapshot is already retained.
    return new NativeGateFailureError(this.#failure ?? "teardown_error", this.#cleanup, this.#teardown!);
  }
}

export interface NativeTeardownAction { readonly step: TeardownStep; readonly run: () => void | Promise<void> }
/** Await the close callback itself; an omitted callback completion keeps ownership here. */
export function closeWithCompletion(close: (complete: (error?: Error) => void) => void,
  policy: "strict" | "node_server" = "strict"): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // Promise construction also rejects a synchronous close throw, without classifying it as benign.
    close(error => {
      if (error == null) { resolve(); return; }
      // Node net.Server.close reports an already-not-open server through this exact code.
      // The installed ws close callback has no equivalent coded contract; it stays strict.
      if (policy === "node_server") {
        try {
          if ((error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING") { resolve(); return; }
        } catch { /* An unreadable code is still the original callback failure. */ }
      }
      reject(error);
    });
  });
}

/** Reports progress without racing, detaching or settling any reached cleanup action. */
export async function runWithObservedTeardown<T>(operation: () => T | Promise<T>,
  steps: () => Iterable<NativeTeardownAction>, scope: NativeDiagnosticScope,
  component: TeardownComponent): Promise<T> {
  let value: T | undefined, original: unknown, operationFailed = false, teardownFailed = false;
  try { value = await operation(); }
  catch (error) { operationFailed = true; original = error; scope.recordFailure(error); }
  let current: TeardownStep | undefined;
  const pending = setTimeout(() => { if (current) scope.teardownPending(component, current); }, 500);
  try {
    for (const action of steps()) {
      current = action.step;
      try { await action.run(); }
      catch { teardownFailed = true; scope.teardownFailed(component, current); }
    }
  } finally { clearTimeout(pending); }
  if (teardownFailed) throw scope.failureError();
  if (operationFailed) throw original;
  return value as T;
}

/** Own a dedicated process group so cancellation cannot target another native session. */
export function nativeProcess(command: string, args: string[], options: {
  cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number; maxBytes?: number; signal?: AbortSignal;
  readonly onDiagnostic?: NativeProcessDiagnosticSink;
}): Promise<NativeProcessResult> {
  return new Promise((resolve, reject) => {
    let sink: NativeProcessDiagnosticSink | undefined;
    try { const candidate = options.onDiagnostic; if (typeof candidate === "function") sink = candidate; } catch { /* Optional only. */ }
    let failure: NativeProcessResult["failure"];
    let cleanupError: NativeCleanupError | undefined;
    let closed = false, notifiedFailure = false, notifiedCleanup = false, notifying = false;
    const notify = () => {
      if (notifying) return;
      notifying = true;
      try {
        // A reentrant sink may produce the second first fact; never nest delivery or exceed two snapshots.
        while (failure && (!notifiedFailure || (cleanupError && !notifiedCleanup))) {
          notifiedFailure = true; notifiedCleanup ||= cleanupError !== undefined;
          const fact = frozenNativeFact(failure, cleanupError, closed ? "observed" : "unconfirmed");
          try { sink?.(fact); } catch { /* No await/drain or raw sink error. */ }
        }
      } finally { notifying = false; }
    };
    try {
      const group = process.platform !== "win32";
      const child = childProcess.spawn(command, args, { cwd: options.cwd, env: options.env, detached: group, stdio: "pipe" });
      const stdout: Buffer[] = [], stderr: Buffer[] = [];
      let bytes = 0;
      let targetGone = false;
      let force: ReturnType<typeof setTimeout> | undefined;
      const kill = (signal: NativeCleanupError["signal"]) => {
        // Do not retry or escalate after an unexpected failure, or signal a vanished target again.
        if (cleanupError || targetGone) return;
        const operation = group && child.pid ? "killpg" : "kill";
        const failed = (code: NativeCleanupError["code"]) => {
          cleanupError = { operation, signal, code };
          failure ??= "cleanup_error";
        };
        try {
          if (operation === "killpg") process.kill(-child.pid!, signal);
          else if (!child.kill(signal)) failed("NOT_SENT");
        } catch (error) {
          const code = signalErrorCode(error);
          // ESRCH is the kernel's explicit no-such-target outcome; other errors prove no such thing.
          if (code === "ESRCH") targetGone = true;
          else failed(code);
        }
      };
      const stop = (reason: NonNullable<NativeProcessResult["failure"]>) => {
        if (failure || closed) return;
        failure = reason;
        kill("SIGTERM");
        if (!closed && !cleanupError && !targetGone) force = setTimeout(() => {
          force = undefined;
          if (closed) return;
          kill("SIGKILL"); notify();
        }, 500);
        notify();
      };
      const timer = setTimeout(() => stop("timeout"), options.timeoutMs ?? 45000);
      const abort = () => stop("cancelled");
      options.signal?.addEventListener("abort", abort, { once: true });
      const collect = (parts: Buffer[], chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > (options.maxBytes ?? 2 * 1024 * 1024)) { stop("output_limit"); return; }
        parts.push(chunk);
      };
      child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
      child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
      child.stdin.on("error", () => undefined);
      child.once("error", () => { if (!closed) { failure ??= "spawn_error"; notify(); } });
      child.once("close", (code, signal) => {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        if (force) clearTimeout(force);
        // Clear any descendants that outlived the CLI wrapper, only in our group.
        if (group && child.pid) kill("SIGKILL");
        resolve({ code, signal, ...(failure ? { failure } : {}), ...(cleanupError ? { cleanupError } : {}),
          stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
        notify();
      });
      // Native CLIs may wait for stdin EOF even when the prompt is an argument.
      child.stdin.end();
      if (options.signal?.aborted) abort();
    } catch (error) {
      failure ??= "spawn_error"; notify();
      reject(error); // Preserve setup/spawn rejection; no absence or cleanup claim.
    }
  });
}

export function isolatedNativeEnv(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(CODEX_|OPENAI_|ANTHROPIC_|CLAUDE_|SUBSWITCH_|NODE_OPTIONS$)/.test(key)) delete env[key];
  }
  return { ...env, ...overrides };
}
