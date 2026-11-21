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
    case "unverified": return !afterExit && check.reason === "unsafe_path" ? problem(check.reason) : undefined;
    case "none": return undefined;
    default: return check satisfies never;
  }
}

function effectivePort(d: DetachDeps): Result<number, string> {
  const config = d.loadConfig({ allowProjectPort: false });
  if (!config.ok) return err(config.error.message);
  if (d.port === undefined) return ok(config.value.config.port);
  const parsed = PortSchema.safeParse(d.port);
  return parsed.success ? ok(parsed.data) : err(`invalid --port "${d.port}": port must be an integer between 1 and 65535`);
}

function keepNodeArg(arg: string, previous: string | undefined): boolean {
  return !DEBUGGER_FLAG.test(arg) && (arg.startsWith("-") || !DEBUGGER_VALUE_FLAG.test(previous ?? ""));
}

function detachedNodeOptions(input: string): Result<string, string> {
  // Match Node's ParseNodeOptionsEnvVar. Keep the original text of each retained option.
  const retained: string[] = [];
  let previous: string | undefined;
  let removed = false;
  let quoted = false;
  let start = 0;
  let arg = "";
  for (let i = 0; i <= input.length; i++) {
    const ch = input[i];
    if (ch === undefined || (ch === " " && !quoted)) {
      if (arg !== "") {
        if (keepNodeArg(arg, previous)) retained.push(input.slice(start, i));
        else removed = true;
        previous = arg;
        arg = "";
      }
      start = i + 1;
    } else if (ch === '"') {
      quoted = !quoted;
    } else if (ch === "\\" && quoted) {
      arg += input[++i] ?? "";
    } else {
      arg += ch;
    }
  }
  if (quoted) return err("invalid NODE_OPTIONS");
  return ok(removed ? retained.join(" ") : input);
}

function readiness(check: RelayClassification, d: DetachDeps, port: number): Outcome | undefined {
  switch (check.kind) {
    case "verified": {
      const current = d.readRecord(port, d.home);
      if (!current.ok) return problem(current.error);
      return current.value?.pid === check.record.pid && current.value.nonce === check.record.nonce
        ? { kind: "pid", pid: check.record.pid } : problem("identity_mismatch");
    }
    case "unverified": return check.reason === "no_answer" ? undefined : problem(check.reason);
    case "foreign": case "legacy": return problem("identity_mismatch");
    case "none": return undefined;
    default: return check satisfies never;
  }
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
          const outcome = readiness(check, d, port);
          if (outcome !== undefined) finish(outcome);
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

  const childEnv: NodeJS.ProcessEnv = { ...env, SUBSWITCH_MANAGED_BY: "detach" };
  const nodeOptions = env["NODE_OPTIONS"];
  if (nodeOptions !== undefined) {
    const filtered = detachedNodeOptions(nodeOptions);
    if (!filtered.ok) { d.fail(filtered.error); return 1; }
    childEnv["NODE_OPTIONS"] = filtered.value;
  }
  const boot = openBootLog(port, d.home);
  if (!boot.ok) return report(d, problem(boot.error), port);
  const argv = execArgv.filter((arg, i) => keepNodeArg(arg, execArgv[i - 1]));
  argv.push(entry, "serve", "--port", String(port));
  if (d.verbose) argv.push("--verbose");
  if (d.quiet) argv.push("--quiet");
  const child = d.spawn(execPath, argv, { detached: true, stdio: ["ignore", "ignore", boot.value], env: childEnv });
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
