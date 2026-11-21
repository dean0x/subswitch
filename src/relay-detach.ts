import { closeSync } from "node:fs";
import { PortSchema } from "./init.js";
import { openBootLog, readBootTail, type classifyRelay, type readRelayRecord, type RelayClassification } from "./relay-record.js";
import { err, ok, type Result } from "./result.js";
import { SUBSWITCH_VERSION } from "./version.js";

const POLL_MS = 100;
const READY_MS = 8_000;
const DEBUGGER_FLAG = /^--(?:no[-_])?(?:inspect|debug)(?:[-_=]|$)/;
const DEBUGGER_VALUE_FLAG = /^--(?:inspect[-_]port|inspect[-_]publish[-_]uid|debug[-_]port)$/;

interface SpawnOptions {
  readonly detached: true;
  readonly stdio: ["ignore", "ignore", number];
  readonly env: NodeJS.ProcessEnv;
}

interface SpawnedRelay {
  readonly pid?: number | undefined;
  once(event: "exit" | "error", listener: () => void): unknown;
  unref(): void;
}

export type SpawnRelay = (executable: string, argv: readonly string[], options: SpawnOptions) => Result<SpawnedRelay, "child_exited">;

export interface DetachDeps {
  readonly platform: NodeJS.Platform;
  readonly home: string;
  readonly port?: string;
  readonly verbose?: boolean;
  readonly quiet?: boolean;
  readonly node: {
    readonly execPath: string;
    readonly execArgv: readonly string[];
    readonly entry: string | undefined;
    readonly env: Readonly<NodeJS.ProcessEnv>;
  };
  readonly clock: { after(ms: number, run: () => void): () => void };
  readonly spawn: SpawnRelay;
  readonly classify: typeof classifyRelay;
  readonly readRecord: typeof readRelayRecord;
  readonly loadConfig: (options: { allowProjectPort: false }) => Result<{ config: { port: number } }, { message: string }>;
  readonly out: (line: string) => void;
  readonly errOut: (line: string) => void;
  readonly fail: (message: string) => void;
}

export type DetachReason = "port_in_use" | "child_exited" | "not_ready" | "identity_mismatch" | "unsafe_path";
type Outcome = { readonly kind: "pid"; readonly pid: number; readonly otherVersion?: boolean }
  | { readonly kind: "legacy" }
  | { readonly kind: "failed"; readonly reason: DetachReason; readonly boot?: true };

const problem = (reason: DetachReason): Outcome => ({ kind: "failed", reason });

function existing(check: RelayClassification, afterExit = false): Outcome | undefined {
  switch (check.kind) {
    case "verified": return { kind: "pid", pid: check.record.pid, otherVersion: check.version !== SUBSWITCH_VERSION };
    case "legacy": return afterExit ? undefined : { kind: "legacy" };
    case "foreign": return problem("port_in_use");
    case "unverified": case "none": return undefined;
    default: return check satisfies never;
  }
}

function effectivePort(d: DetachDeps): Result<number, string> {
  if (d.port === undefined) {
    const config = d.loadConfig({ allowProjectPort: false });
    return config.ok ? ok(config.value.config.port) : err(config.error.message);
  }
  const parsed = PortSchema.safeParse(d.port);
  return parsed.success ? ok(parsed.data) : err(`invalid --port "${d.port}": port must be an integer between 1 and 65535`);
}

function waitForRelay(d: DetachDeps, child: SpawnedRelay, port: number): Promise<Outcome> {
  return new Promise(resolve => {
    let state: "poll" | "exit" | "done" = "poll";
    let cancelPoll = () => {};
    let pending: { controller: AbortController; done: Promise<void> } | undefined;
    const exitProbe = new AbortController();
    const exited: Outcome = { kind: "failed", reason: "child_exited", boot: true };
    const finish = (outcome: Outcome) => {
      if (state === "done") return;
      state = "done";
      cancelPoll();
      cancelDeadline();
      pending?.controller.abort();
      exitProbe.abort();
      resolve(outcome);
    };
    const cancelDeadline = d.clock.after(READY_MS, () => finish(state === "exit" ? exited : problem("not_ready")));
    child.once("error", () => finish(problem("child_exited")));
    child.once("exit", () => {
      if (state !== "poll") return;
      state = "exit";
      cancelPoll();
      pending?.controller.abort();
      // Let the canceled GET settle before the last check of the port.
      void Promise.resolve(pending?.done).then(async () => {
        if (state !== "exit") return;
        const winner = await d.classify(port, { home: d.home, signal: exitProbe.signal });
        finish(existing(winner, true) ?? exited);
      });
    });
    child.unref();
    const poll = (attempt: number) => {
      if (state !== "poll") return;
      const current = d.readRecord(port, d.home);
      if (!current.ok) { finish(problem(current.error)); return; }
      const record = current.value;
      if (pending === undefined && record !== undefined && record.pid === child.pid) {
        const controller = new AbortController();
        const done = d.classify(port, { home: d.home, record, signal: controller.signal }).then(check => {
          pending = undefined;
          if (state !== "poll") return;
          switch (check.kind) {
            case "verified": {
              const latest = d.readRecord(port, d.home);
              if (!latest.ok) finish(problem(latest.error));
              else if (latest.value?.pid === record.pid && latest.value.nonce === record.nonce) finish({ kind: "pid", pid: record.pid });
              else finish(problem("identity_mismatch"));
              break;
            }
            case "unverified": if (check.reason !== "no_answer") finish(problem(check.reason)); break;
            case "foreign": case "legacy": finish(problem("identity_mismatch")); break;
            case "none": break;
            default: check satisfies never;
          }
        });
        pending = { controller, done };
      }
      if (attempt + 1 < READY_MS / POLL_MS) cancelPoll = d.clock.after(POLL_MS, () => poll(attempt + 1));
    };
    poll(0);
  });
}

function report(d: DetachDeps, outcome: Outcome, port: number): 0 | 1 {
  switch (outcome.kind) {
    case "pid":
      if (outcome.otherVersion) d.errOut("subswitch: the relay version differs from this CLI");
      d.out(String(outcome.pid));
      return 0;
    case "legacy":
      d.errOut("subswitch: restart the legacy relay to get its pid");
      return 0;
    case "failed": {
      d.errOut(`subswitch: ${outcome.reason}`);
      if (outcome.boot) {
        const tail = readBootTail(port, d.home);
        if (tail.ok && tail.value !== undefined) d.errOut(tail.value);
      }
      return 1;
    }
    default: return outcome satisfies never;
  }
}

export async function detachRelay(d: DetachDeps): Promise<0 | 1> {
  if (d.platform === "win32") { d.fail("detach is not available on Windows"); return 1; }
  const selected = effectivePort(d);
  if (!selected.ok) { d.fail(selected.error); return 1; }
  const { entry, execPath, execArgv, env } = d.node;
  if (entry === undefined || entry === "") { d.fail("the CLI entry is unavailable"); return 1; }
  const port = selected.value;
  const found = existing(await d.classify(port, { home: d.home }));
  if (found !== undefined) return report(d, found, port);

  const boot = openBootLog(port, d.home);
  if (!boot.ok) return report(d, problem(boot.error), port);
  const argv = execArgv.filter((arg, i) => !DEBUGGER_FLAG.test(arg) &&
    (arg.startsWith("-") || !DEBUGGER_VALUE_FLAG.test(execArgv[i - 1] ?? "")));
  argv.push(entry, "serve", "--port", String(port));
  if (d.verbose) argv.push("--verbose");
  if (d.quiet) argv.push("--quiet");
  const child = d.spawn(execPath, argv, { detached: true, stdio: ["ignore", "ignore", boot.value], env: { ...env, SUBSWITCH_MANAGED_BY: "detach" } });
  try {
    closeSync(boot.value);
  } catch {
    if (child.ok) {
      child.value.once("error", () => {});
      child.value.unref();
    }
    return report(d, problem("unsafe_path"), port);
  }
  return report(d, child.ok ? await waitForRelay(d, child.value, port) : problem(child.error), port);
}
