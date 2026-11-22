import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DEFAULT_PORT, userConfigPath } from "../../src/config.js";
import { classifyRelay, readRelayRecord } from "../../src/relay-record.js";
import { cliChildCommand, cliChildFolders, type CliChildFolders } from "./cli-child.js";
import { reserveTestPort } from "./test-port.js";

export interface RelayChildOptions {
  readonly config?: Readonly<Record<string, unknown>>;
  readonly env?: Readonly<NodeJS.ProcessEnv> | ((folders: CliChildFolders) => Readonly<NodeJS.ProcessEnv>);
  readonly extraImport?: string;
  /** A path below the test home, relative to that home or absolute. */
  readonly recordFsUnder?: string;
  readonly detach?: boolean;
  /** Use the implicit user config and omit --port from the detach launcher. */
  readonly portFromConfig?: boolean;
  /** Set up fixtures in the isolated home before the child starts. */
  readonly prepare?: (folders: CliChildFolders) => void | Promise<void>;
}

export interface RelayChild {
  readonly folders: CliChildFolders;
  readonly port: number;
  readonly child: ChildProcess;
  readonly stdout: string;
  readonly stderr: string;
  readonly exited: Promise<readonly [number | null, NodeJS.Signals | null]>;
  readonly waitFor: (text: string) => Promise<void>;
  readonly cleanup: () => Promise<void>;
}

const STOP_MS = 7_000;
const DETACH_LAUNCH_MS = 12_000;
const OUTPUT_CAP = 256 * 1024;

async function waitUntil(predicate: () => boolean, ms: number): Promise<boolean> {
  const stepMs = 20;
  const end = performance.now() + ms;
  for (let attempt = 0; attempt < Math.ceil(ms / stepMs) && performance.now() < end; attempt++) {
    if (predicate()) return true;
    await delay(Math.min(stepMs, Math.max(0, end - performance.now())));
  }
  return predicate();
}

function signalPid(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    return process.kill(pid, signal);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

export interface DetachedStopDeps {
  readonly readRecord: typeof readRelayRecord;
  readonly classify: typeof classifyRelay;
  readonly signal: typeof signalPid;
  readonly wait: typeof waitUntil;
  readonly now: () => number;
  readonly pidAgeMs: (pid: number) => number | undefined;
}

function pidAgeMs(pid: number): number | undefined {
  try {
    const age = execFileSync("/bin/ps", ["-p", String(pid), "-o", "etime="], {
      encoding: "utf8", timeout: 500, maxBuffer: 128,
    });
    const fields = /^(?:(\d+)-)?(?:(\d+):)?(\d{2}):(\d{2})$/.exec(age.trim());
    if (fields === null) return undefined;
    const [, days = "0", hours = "0", minutes, seconds] = fields;
    return (Number(days) * 86_400 + Number(hours) * 3_600 + Number(minutes) * 60 + Number(seconds)) * 1_000;
  } catch {
    return undefined;
  }
}

const liveStopDeps: DetachedStopDeps = {
  readRecord: readRelayRecord, classify: classifyRelay, signal: signalPid, wait: waitUntil,
  now: () => performance.now(), pidAgeMs,
};

export async function stopDetached(port: number, home: string, deps: DetachedStopDeps = liveStopDeps): Promise<void> {
  const saved = deps.readRecord(port, home);
  assert.ok(saved.ok, "Unsafe relay test record");
  if (saved.value === undefined || !deps.signal(saved.value.pid, 0)) return;
  const probeStarted = deps.now();
  const live = await deps.classify(port, { home });
  assert.equal(live.kind, "verified", "Refuse to stop a relay without a verified identity");
  const { pid, nonce } = live.record;
  assert.ok(pid === saved.value.pid && nonce === saved.value.nonce, "Relay test record changed");
  if (!deps.signal(pid, "SIGTERM") || await deps.wait(() => !deps.signal(pid, 0), STOP_MS)) return;
  const current = deps.readRecord(port, home);
  assert.ok(current.ok, "Unsafe relay test record");
  if (current.value === undefined) {
    // Shutdown removes the record and closes health. Require a process older than the
    // initial probe. Allow one second for the precision of the OS age sample.
    const age = deps.pidAgeMs(pid);
    if (age === undefined || age <= deps.now() - probeStarted + 1_000) return;
    const latest = deps.readRecord(port, home);
    assert.ok(latest.ok, "Unsafe relay test record");
    assert.equal(latest.value, undefined, "Relay test record changed");
  } else {
    assert.ok(current.value.pid === pid && current.value.nonce === nonce, "Relay test record changed");
    const latest = await deps.classify(port, { home });
    if (latest.kind !== "verified" || latest.record.pid !== pid || latest.record.nonce !== nonce) return;
  }
  deps.signal(pid, "SIGKILL");
}

export function assertIsolatedRelayTarget(home: string, realHome: string, ...ports: readonly number[]): void {
  assert.ok(isAbsolute(home) && isAbsolute(realHome), "Relay test homes must be absolute");
  const fromTestHome = relative(home, realHome);
  assert.ok(fromTestHome === ".." || fromTestHome.startsWith(`..${sep}`) || isAbsolute(fromTestHome),
    "Relay test home contains the real home");
  for (const port of ports) assert.ok(port !== 4141 && port !== DEFAULT_PORT, "Reserved relay test port");
}

export async function startRelayChild(options: RelayChildOptions = {}): Promise<RelayChild> {
  const [realHome, envHome] = await Promise.all([realpath(userInfo().homedir), realpath(homedir())]);
  const folders = await cliChildFolders({ resolveTemp: true });
  assertIsolatedRelayTarget(folders.home, realHome);
  assertIsolatedRelayTarget(folders.home, envHome);
  const claims: Awaited<ReturnType<typeof reserveTestPort>>[] = [];
  let launcherTimedOut = false;
  const reserve = async () => {
    const claim = await reserveTestPort();
    claims.push(claim);
    return claim.port;
  };
  const removeHomeAndRelease = async () => {
    try { await rm(folders.home, { recursive: true, force: true }); }
    finally {
      // A late launcher can still start a relay. Keep its claims until the test process exits.
      if (!launcherTimedOut) for (const claim of claims) claim.release();
    }
  };
  try {
    const portFromConfig = options.detach === true && options.portFromConfig === true;
    // The exec allow-list permits only the port under test.
    const port = await reserve();
    const otherPort = options.detach && !portFromConfig ? await reserve() : undefined;
    assertIsolatedRelayTarget(folders.home, realHome, ...(otherPort === undefined ? [port] : [port, otherPort]));
    assert.notEqual(port, otherPort, "The option port must differ from the config port");
    await options.prepare?.(folders);
    const cliArgs = ["serve", "--port", String(port)];
    const extraEnv = typeof options.env === "function" ? options.env(folders) : options.env;
    const childOptions = {
      env: portFromConfig ? { ...extraEnv, SUBSWITCH_CONFIG: "" } : extraEnv ?? {},
      ...(options.recordFsUnder === undefined ? {} : { recordFsUnder: resolve(folders.home, options.recordFsUnder) }),
    };
    const command = cliChildCommand(folders, cliArgs, childOptions);
    const configFile = portFromConfig ? userConfigPath(command.env) : command.env["SUBSWITCH_CONFIG"];
    assert.ok(configFile, "Relay test needs an isolated config file");
    if (portFromConfig) await mkdir(dirname(configFile), { recursive: true, mode: 0o700 });
    // The mode applies to new files only. A test can set a different mode in prepare.
    await writeFile(resolve(command.cwd, configFile), JSON.stringify({ ...options.config, port: otherPort ?? port }), { mode: 0o600 });
    const args = options.extraImport === undefined ? command.args :
      command.args.toSpliced(-cliArgs.length - 1, 0, "--import", options.extraImport);
    const env = options.detach ? cliChildCommand(folders, cliArgs, { ...childOptions, allowNodeArgs: args }).env : command.env;
    const launcherArgs = portFromConfig ? args.slice(0, -2) : args;
    const child = spawn(command.file, options.detach ? [...launcherArgs, "--detach"] : launcherArgs, {
      cwd: command.cwd, env, detached: options.detach ?? false, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout = (stdout + chunk).slice(-OUTPUT_CAP); });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-OUTPUT_CAP); });
    let closed = false;
    const exited = new Promise<readonly [number | null, NodeJS.Signals | null]>((done, fail) => {
      const deadline = options.detach ? setTimeout(() => {
        launcherTimedOut = true;
        fail(new Error("Relay test launcher did not exit"));
      }, DETACH_LAUNCH_MS) : undefined;
      child.once("error", (error) => { clearTimeout(deadline); fail(error); });
      child.once("close", (code, signal) => { clearTimeout(deadline); closed = true; done([code, signal]); });
    });
    void exited.catch(() => undefined);
    const stop = async () => {
      try {
        if (options.detach) {
          try { await exited; } finally { await stopDetached(port, folders.home); }
        } else if (!closed) {
          child.kill("SIGTERM");
          if (!await waitUntil(() => closed, STOP_MS)) {
            child.kill("SIGKILL");
            assert.ok(await waitUntil(() => closed, STOP_MS), "Relay test child did not exit");
          }
        }
      } finally {
        await removeHomeAndRelease();
      }
    };
    let cleanup: Promise<void> | undefined;
    return {
      folders, port, child, get stdout() { return stdout; }, get stderr() { return stderr; }, exited,
      waitFor: async (text) => {
        await waitUntil(() => closed || stderr.includes(text), 20_000);
        assert.ok(stderr.includes(text), `Expected relay child stderr to contain ${text}`);
      },
      cleanup: () => cleanup ??= stop(),
    };
  } catch (error) {
    await removeHomeAndRelease();
    throw error;
  }
}
