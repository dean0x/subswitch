import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DEFAULT_PORT, userConfigPath } from "../../src/config.js";
import { classifyRelay, readRelayRecord } from "../../src/relay-record.js";
import { cliChildCommand, cliChildFolders, type CliChildFolders } from "./cli-child.js";

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

const STOP_MS = 5_000;
const DETACH_LAUNCH_MS = 12_000;
const OUTPUT_CAP = 256 * 1024;

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", done);
  });
  const address = server.address();
  await new Promise<void>((done, fail) => server.close((error) => error ? fail(error) : done()));
  assert.ok(address && typeof address !== "string");
  assert.ok(address.port !== 4141 && address.port !== DEFAULT_PORT, "Reserved relay test port");
  return address.port;
}

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

async function stopDetached(port: number, home: string): Promise<void> {
  const saved = readRelayRecord(port, home);
  assert.ok(saved.ok, "Unsafe relay test record");
  if (saved.value === undefined || !signalPid(saved.value.pid, 0)) return;
  const live = await classifyRelay(port, { home });
  assert.equal(live.kind, "verified", "Refuse to stop a relay without a verified identity");
  const { pid, nonce } = live.record;
  assert.ok(pid === saved.value.pid && nonce === saved.value.nonce, "Relay test record changed");
  if (!signalPid(pid, "SIGTERM") || await waitUntil(() => !signalPid(pid, 0), STOP_MS)) return;
  const current = readRelayRecord(port, home);
  assert.ok(current.ok && current.value?.pid === pid && current.value.nonce === nonce, "Relay test record changed");
  signalPid(pid, "SIGKILL");
}

export async function startRelayChild(options: RelayChildOptions = {}): Promise<RelayChild> {
  const realHome = await realpath(homedir());
  const folders = await cliChildFolders({ resolveTemp: true });
  assert.notEqual(folders.home, realHome, "Relay test home is the real home");
  const removeHome = () => rm(folders.home, { recursive: true, force: true });
  try {
    const portFromConfig = options.detach === true && options.portFromConfig === true;
    // Reserve both ports together. The exec allow-list permits only the port under test.
    const [port, otherPort] = await Promise.all([reservePort(), options.detach && !portFromConfig ? reservePort() : undefined]);
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
    await writeFile(resolve(command.cwd, configFile), JSON.stringify({ ...options.config, port: otherPort ?? port }));
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
      const deadline = options.detach ? setTimeout(() => fail(new Error("Relay test launcher did not exit")), DETACH_LAUNCH_MS) : undefined;
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
        await removeHome();
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
    await removeHome();
    throw error;
  }
}
