import { randomUUID } from "node:crypto";
import {
  closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync,
  renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { loadConfig, userConfigPath } from "./config.js";
import { PortSchema } from "./init.js";
import type { Logger } from "./logger.js";
import { BOOT_LOG_NAME, openBootLog, relayFolder, type classifyRelay } from "./relay-record.js";
import { err, ok, type Result } from "./result.js";
import type { vetConfig } from "./server.js";

export const SERVICE_LABEL = "com.subswitch.relay";
export const LAUNCHCTL_PATH = "/bin/launchctl";
export const servicePlistPath = (home: string): string => join(home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);

export type LaunchctlRunner = (path: typeof LAUNCHCTL_PATH, args: readonly string[], timeoutMs: number) => Promise<Result<number, string>>;

export interface ServiceDeps {
  readonly home: string;
  readonly uid: number;
  readonly platform: NodeJS.Platform;
  readonly execPath: string;
  readonly entry: string;
  readonly port?: string;
  readonly configPath?: string;
  readonly nodeExtraCaCerts?: string;
  readonly runner: LaunchctlRunner;
  readonly probe: typeof classifyRelay;
  readonly stop: (port: number) => Promise<0 | 1>;
  readonly vet: typeof vetConfig;
  readonly logger: Logger;
  readonly monotonic: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly out: (line: string) => void;
  readonly errOut: (line: string) => void;
}

const POLL_MS = 200;
const READY_MS = 8_000;
const UNLOAD_MS = 45_000;
const PRINT_MISSING = 113;
const BOOTOUT_MISSING = 3;
const PLIST_BYTES = 32 * 1024;
const CONFIG_BYTES = 1024 * 1024;
const CA_BYTES = 1024 * 1024;
const MAX_PATH_LENGTH = 1024;
const NOFOLLOW = constants.O_NOFOLLOW | constants.O_NONBLOCK;

const safePath = (path: string): boolean => isAbsolute(path) && !/[\u0000-\u001f\u007f-\u009f\uD800-\uDFFF￾￿]/u.test(path);
const xml = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&apos;");

const PLIST_HEAD = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
`;

function renderPlist(node: string, entry: string, port: number, home: string, folder: string, config: string, ca?: string): string {
  return `${PLIST_HEAD}  <key>ProgramArguments</key>
  <array>
    <string>${xml(node)}</string><string>${xml(entry)}</string><string>serve</string><string>--port</string><string>${port}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ExitTimeOut</key><integer>40</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>WorkingDirectory</key><string>${xml(folder)}</string>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>${xml(join(folder, BOOT_LOG_NAME))}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>${xml(home)}</string>
    <key>PATH</key><string>${xml(`/usr/bin:/bin:/usr/sbin:/sbin:${dirname(node)}`)}</string>
    <key>SUBSWITCH_CONFIG</key><string>${xml(config)}</string>
    <key>SUBSWITCH_MANAGED_BY</key><string>launchd</string>${ca === undefined ? "" : `
    <key>NODE_EXTRA_CA_CERTS</key><string>${xml(ca)}</string>`}
  </dict>
</dict>
</plist>
`;
}

// Accept only the label at the root of the template we own, not one in a comment or nested dictionary.
const plistShape = (text: string): string => text.replace(/<string>[^<>]*<\/string>/g, "<string></string>");
const OWN_PLIST_SHAPES = [undefined, "/ca.pem"].map((ca) => plistShape(renderPlist("/node", "/entry", 1, "/home", "/relay", "/config", ca)));

function checkLaunchAgents(d: ServiceDeps, create: boolean): boolean {
  try {
    for (const path of [d.home, join(d.home, "Library"), dirname(servicePlistPath(d.home))]) {
      let stat = lstatSync(path, { throwIfNoEntry: false });
      if (stat === undefined) {
        if (path === d.home) return false;
        if (!create) return true;
        mkdirSync(path, { mode: 0o755 });
        stat = lstatSync(path);
      }
      if (!stat.isDirectory() || stat.uid !== d.uid || (stat.mode & 0o022) !== 0) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function readOwnedFile(path: string, uid: number, limit: number): Result<string | undefined, string> {
  try {
    const fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== uid || (stat.mode & 0o022) !== 0 || stat.size > limit) {
        return err("not a safe regular file");
      }
      const bytes = Buffer.alloc(stat.size + 1);
      const read = readSync(fd, bytes, 0, bytes.length, 0);
      if (read !== stat.size) return err("file size changed");
      return ok(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, read)));
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT" ? ok(undefined) : err("cannot read file");
  }
}

function checkServiceParents(path: string, uid: number): boolean {
  if (path.length >= MAX_PATH_LENGTH) return false;
  try {
    // Check from the root down, before the next lookup can follow a link.
    let folder = "/";
    for (const part of dirname(path).split("/")) {
      if (part === "..") return false;
      folder = join(folder, part);
      const stat = lstatSync(folder);
      if (!stat.isDirectory() || (stat.uid !== 0 && stat.uid !== uid) || (stat.mode & 0o022) !== 0) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function readServiceFile(path: string, uid: number | undefined, limit: number, name: string): Result<string, string> {
  if (!safePath(path) || uid === undefined) return err(`the service needs an absolute ${name} path and a user ID`);
  if (!checkServiceParents(path, uid)) {
    return err(`parent folders of the service ${name} path must have no links or group or other write bits. The user or root must own them`);
  }
  const file = readOwnedFile(path, uid, limit);
  if (!file.ok || file.value === undefined) {
    return err(`the service needs a regular user-owned ${name} file with one link and no group or other write access`);
  }
  return ok(file.value);
}

/** Check and read the pinned config at install and on each service start. */
export function loadServiceConfig(configPath: string, uid: number | undefined): ReturnType<typeof loadConfig> {
  const file = readServiceFile(configPath, uid, CONFIG_BYTES, "config");
  if (!file.ok) return err({ kind: "translate", message: file.error });
  return loadConfig({ configPath, globalConfigPath: false, env: {}, readFile: () => file.value });
}

function checkPlist(d: ServiceDeps, path: string): Result<boolean, string> {
  if (!checkLaunchAgents(d, false)) return err("unsafe LaunchAgents folder");
  const file = readOwnedFile(path, d.uid, PLIST_BYTES);
  if (!file.ok) return err("unsafe service plist");
  if (file.value === undefined) return ok(false);
  return file.value.startsWith(PLIST_HEAD) && OWN_PLIST_SHAPES.includes(plistShape(file.value))
    ? ok(true) : err("service plist is not a subswitch plist");
}

const run = (d: ServiceDeps, args: readonly string[], ms = READY_MS) => d.runner(LAUNCHCTL_PATH, args, ms);
const serviceDomain = (d: ServiceDeps): string => `gui/${d.uid}`;
const serviceJob = (d: ServiceDeps): string => `${serviceDomain(d)}/${SERVICE_LABEL}`;

async function unload(d: ServiceDeps): Promise<Result<void, string>> {
  const deadline = d.monotonic() + UNLOAD_MS;
  const bootout = await run(d, ["bootout", serviceJob(d)], UNLOAD_MS);
  if (!bootout.ok || (bootout.value !== 0 && bootout.value !== BOOTOUT_MISSING)) return err("launchctl bootout failed");
  for (let poll = 0; poll < UNLOAD_MS / POLL_MS; poll++) {
    const left = deadline - d.monotonic();
    if (left <= 0) break;
    const status = await run(d, ["print", serviceJob(d)], Math.min(READY_MS, Math.ceil(left)));
    if (!status.ok || (status.value !== 0 && status.value !== PRINT_MISSING)) return err("launchctl print failed");
    if (status.value === PRINT_MISSING && d.monotonic() <= deadline) return ok(undefined);
    await d.sleep(Math.min(POLL_MS, Math.max(0, deadline - d.monotonic())));
  }
  return err("the service did not unload within 45 seconds");
}

async function removeService(d: ServiceDeps): Promise<Result<void, string>> {
  const unloaded = await unload(d);
  if (!unloaded.ok) return unloaded;
  const path = servicePlistPath(d.home);
  const current = checkPlist(d, path);
  if (!current.ok) return current;
  if (current.value) {
    try {
      unlinkSync(path);
    } catch {
      return err("cannot remove the service plist");
    }
  }
  return ok(undefined);
}

function validService(d: ServiceDeps): Result<void, string> {
  if (d.platform !== "darwin") return err("the service needs launchd on macOS");
  return safePath(d.home) && Number.isSafeInteger(d.uid) && d.uid >= 0
    ? ok(undefined) : err("the service needs an absolute home path and a user ID");
}

const fail = (d: ServiceDeps, message: string): 1 => { d.errOut(`subswitch: ${message}`); return 1; };

export async function uninstallService(d: ServiceDeps): Promise<0 | 1> {
  const valid = validService(d);
  if (!valid.ok) return fail(d, valid.error);
  const removed = await removeService(d);
  return removed.ok ? 0 : fail(d, removed.error);
}

export async function installService(d: ServiceDeps): Promise<0 | 1> {
  const valid = validService(d);
  if (!valid.ok) return fail(d, valid.error);
  const configPath = d.configPath ?? userConfigPath({}, d.home);
  const ca = d.nodeExtraCaCerts;
  if (![configPath, d.execPath, d.entry, ...(ca === undefined ? [] : [ca])].every(safePath)) {
    return fail(d, "service paths must be absolute and contain no control characters");
  }
  let node: string;
  let entry: string;
  try {
    node = realpathSync(d.execPath);
    entry = realpathSync(d.entry);
  } catch {
    return fail(d, "cannot resolve the node or CLI path");
  }
  if (!safePath(node) || !safePath(entry) || dirname(node).includes(":")) return fail(d, "invalid real node or CLI path");
  if (ca !== undefined) {
    const file = readServiceFile(ca, d.uid, CA_BYTES, "NODE_EXTRA_CA_CERTS");
    if (!file.ok) return fail(d, file.error);
  }
  const loaded = loadServiceConfig(configPath, d.uid);
  if (!loaded.ok) return fail(d, loaded.error.message);
  const parsed = PortSchema.safeParse(d.port ?? loaded.value.config.port);
  if (!parsed.success) return fail(d, "invalid --port: expected an integer between 1 and 65535");
  const port = parsed.data;
  const vetted = d.vet({ ...loaded.value.config, port }, d.logger);
  if (!vetted.ok) return fail(d, vetted.error);

  const path = servicePlistPath(d.home);
  const current = checkPlist(d, path);
  if (!current.ok) return fail(d, current.error);
  const data = renderPlist(node, entry, port, d.home, relayFolder(port, d.home), configPath, ca);
  if (Buffer.byteLength(data) > PLIST_BYTES) return fail(d, "service plist is too large");
  const probe = await d.probe(port, { home: d.home, confirmIdle: true });
  if (probe.kind !== "none" && probe.kind !== "verified") return fail(d, `cannot verify the listener or relay record on port ${port}`);
  const job = await run(d, ["print", serviceJob(d)]);
  if (!job.ok || (job.value !== 0 && job.value !== PRINT_MISSING)) return fail(d, "launchctl print failed");
  const stopped = probe.kind === "verified" && probe.record.managedBy === "none";
  if (stopped && await d.stop(port) !== 0) return fail(d, `could not stop the detached relay on port ${port}`);

  const stopNote = stopped ? "; the earlier detached relay was stopped" : "";
  const replaceJob = job.value === 0;
  const published = await publishPlist(d, port, path, data, replaceJob);
  if (!published.ok) return fail(d, `${published.error}${stopNote}`);
  const bootstrap = await run(d, ["bootstrap", serviceDomain(d), path]);
  if (bootstrap.ok && bootstrap.value === 0 && await waitForService(d, port)) {
    if (ca !== undefined) d.out(`Service NODE_EXTRA_CA_CERTS: ${ca}`);
    return 0;
  }
  const rollback = await removeService(d);
  const startError = `the launchd relay did not start${stopNote}`;
  if (!rollback.ok) return fail(d, `${startError}; rollback failed: ${rollback.error}`);
  const removedNote = replaceJob ? "; the earlier service was removed; run install again with the earlier settings" : "";
  return fail(d, `${startError}${removedNote}`);
}

async function publishPlist(d: ServiceDeps, port: number, path: string, data: string, replaceJob: boolean): Promise<Result<void, string>> {
  if (!checkLaunchAgents(d, true) || !checkPlist(d, path).ok) return err("unsafe service plist path");
  const boot = openBootLog(port, d.home, { truncate: false });
  if (!boot.ok) return err("cannot open the service boot log");
  let temp: string | undefined;
  try {
    try {
      fchmodSync(boot.value, 0o600);
    } finally {
      closeSync(boot.value);
    }
    const name = `${path}.${randomUUID()}.tmp`;
    const fd = openSync(name, "wx", 0o644);
    temp = name;
    try {
      writeFileSync(fd, data);
      fchmodSync(fd, 0o644);
    } finally {
      closeSync(fd);
    }
    if (replaceJob) {
      const unloaded = await unload(d);
      if (!unloaded.ok) return unloaded;
    }
    if (!checkPlist(d, path).ok) return err("unsafe service plist path");
    renameSync(temp, path);
    temp = undefined;
    return ok(undefined);
  } catch {
    return err("cannot write the service plist");
  } finally {
    if (temp !== undefined) {
      try { unlinkSync(temp); } catch { return err("cannot remove the temporary service plist"); }
    }
  }
}

async function waitForService(d: ServiceDeps, port: number): Promise<boolean> {
  const deadline = d.monotonic() + READY_MS;
  for (let poll = 0; poll < READY_MS / POLL_MS; poll++) {
    const left = deadline - d.monotonic();
    if (left <= 0) break;
    const state = await d.probe(port, { home: d.home, signal: AbortSignal.timeout(Math.ceil(left)) });
    if (state.kind === "verified" && state.record.managedBy === "launchd" && d.monotonic() <= deadline) return true;
    await d.sleep(Math.min(POLL_MS, Math.max(0, deadline - d.monotonic())));
  }
  return false;
}
