import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readSync, unlinkSync, type Stats } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { get } from "node:http";
import { isAbsolute, join } from "node:path";
import { Readable } from "node:stream";
import { redactCredentials } from "./errors.js";
import { z } from "zod";
import { CodexIngressHealthSchema } from "./codex-health.js";
import { CONTROL_CHARS } from "./logger.js";
import { isPrivateFile } from "./private-file.js";
import { err, ok, type Result } from "./result.js";
import { isPrivateFolder } from "./routing/state-dir.js";
import { SUBSWITCH_NAME, SUBSWITCH_VERSION } from "./version.js";

const RECORD_NAME = "relay.json";
const STOP_REQUEST_NAME = "stop-request.json";
const BOOT_NAME = "boot.log";
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const RECORD_BYTES = 4 * 1024;
const BOOT_TAIL_BYTES = 4 * 1024;
const BOOT_LINE_CHARS = 200;
const HEALTH_BYTES = 64 * 1024;
const HEALTH_MS = 1_000;
const NOFOLLOW = constants.O_NOFOLLOW | constants.O_NONBLOCK;

const Pid = z.int().min(2);
const Port = z.int().min(1).max(65_535);
const Version = z.string().max(64);
const Nonce = z.string().regex(/^[a-f0-9]{32}$/);
const IsoTime = z.iso.datetime({ offset: true }).refine((time) => Number.isFinite(Date.parse(time)));
export const StopRequestLabelSchema = z.string().min(1).max(32).regex(/^[a-z0-9._-]+$/);
const StopRequestSchema = z.strictObject({
  targetPid: Pid,
  nonce: Nonce,
  requesterPid: Pid,
  requesterPpid: z.int().nonnegative(),
  uid: z.int().nonnegative(),
  requestedAt: z.string().max(64).pipe(IsoTime),
  label: StopRequestLabelSchema.optional(),
});
const RecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  pid: Pid,
  port: Port,
  version: Version,
  startedAt: IsoTime,
  managedBy: z.enum(["none", "launchd"]),
  nonce: Nonce,
});

const HealthSchema = z.strictObject({
  name: z.literal(SUBSWITCH_NAME),
  version: Version,
  pid: Pid.optional(),
  nonce: Nonce.optional(),
  providers: z.array(z.strictObject({
    id: z.string(), configured: z.boolean(), modelCount: z.int().nonnegative(),
    keySource: z.literal("env").nullable().optional(),
  })).optional(),
  codexIngress: z.strictObject(CodexIngressHealthSchema.shape).optional(),
}).refine(({ pid, nonce }) => (pid === undefined) === (nonce === undefined));

type RelayHealth = z.infer<typeof HealthSchema>;
export type RelayRecord = Readonly<z.infer<typeof RecordSchema>>;
export type StopRequest = Readonly<z.infer<typeof StopRequestSchema>>;
export type StopRequester = Omit<StopRequest, "targetPid" | "nonce">;
type RelayPathResult<T> = Result<T, "unsafe_path">;
export type RelayClassification =
  | { readonly kind: "none" | "legacy" | "foreign" }
  | { readonly kind: "unverified"; readonly reason: "unsafe_path" }
  | { readonly kind: "unverified"; readonly reason: "identity_mismatch" | "no_answer"; readonly record: RelayRecord }
  | { readonly kind: "verified"; readonly record: RelayRecord; readonly version: string };
export interface ClassifyRelayDeps {
  readonly home: string;
  /** A record from the strict reader that triggered a readiness probe. */
  readonly record?: RelayRecord;
  readonly signal?: AbortSignal;
  readonly requestHealth?: typeof requestLoopbackHealth;
  readonly isAlive?: (pid: number) => boolean;
}

export function relayFolder(port: number, home: string): string {
  return join(home, ".cache", "subswitch", "relay", String(port));
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function checkFolder(port: number, home: string, create: boolean): RelayPathResult<string | undefined> {
  if (!Port.safeParse(port).success || !isAbsolute(home)) return err("unsafe_path");
  const directory = relayFolder(port, home);
  const uid = process.getuid?.();
  try {
    const safeParent = (stat: Stats) => stat.isDirectory() &&
      (stat.mode & 0o022) === 0 && (uid === undefined || stat.uid === uid);
    if (!safeParent(lstatSync(home))) return err("unsafe_path");
    for (const path of [join(home, ".cache"), join(directory, "..", ".."), join(directory, ".."), directory]) {
      let stat = lstatSync(path, { throwIfNoEntry: false });
      if (stat === undefined) {
        if (!create) return ok(undefined);
        try {
          mkdirSync(path, { mode: DIRECTORY_MODE });
        } catch (error) {
          if (!hasCode(error, "EEXIST")) return err("unsafe_path");
        }
        stat = lstatSync(path);
      }
      if (!safeParent(stat)) return err("unsafe_path");
      if (path === directory && (!isPrivateFolder(stat) || (stat.mode & 0o7777) !== DIRECTORY_MODE)) return err("unsafe_path");
    }
    return ok(directory);
  } catch {
    return err("unsafe_path");
  }
}

export function ensureRelayFolder(port: number, home: string): RelayPathResult<string> {
  const result = checkFolder(port, home, true);
  return result.ok && result.value !== undefined ? ok(result.value) : err("unsafe_path");
}

export const createRelayNonce = (): string => randomBytes(16).toString("hex");

async function writePrivateRecord<T extends RelayRecord | StopRequest>(path: string, record: T): Promise<RelayPathResult<T>> {
  let temporary: string | undefined;
  try {
    const name = `${path}.${randomUUID()}.tmp`;
    const file = await open(name, "wx", FILE_MODE);
    temporary = name;
    try {
      await file.writeFile(JSON.stringify(record));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    temporary = undefined;
    return ok(record);
  } catch {
    return err("unsafe_path");
  } finally {
    if (temporary !== undefined) await unlink(temporary).catch(() => undefined);
  }
}

export async function publishRelayRecord(
  port: number, home: string, nonce?: string, managedBy: RelayRecord["managedBy"] = "none",
): Promise<RelayPathResult<RelayRecord>> {
  const folder = ensureRelayFolder(port, home);
  if (!folder.ok) return folder;
  try {
    const record: RelayRecord = {
      schemaVersion: 1, port, pid: process.pid, version: SUBSWITCH_VERSION, startedAt: new Date().toISOString(),
      managedBy, nonce: nonce ?? createRelayNonce(),
    };
    return writePrivateRecord(join(folder.value, RECORD_NAME), record);
  } catch {
    return err("unsafe_path");
  }
}

function withPrivateReader<T>(path: string, read: (fd: number, size: number) => RelayPathResult<T>): RelayPathResult<T | undefined> {
  try {
    const fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      return isPrivateFile(stat) ? read(fd, stat.size) : err("unsafe_path");
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    return hasCode(error, "ENOENT") ? ok(undefined) : err("unsafe_path");
  }
}

function readRecordJson<T>(path: string, parse: (data: unknown) => RelayPathResult<T>): RelayPathResult<T | undefined> {
  return withPrivateReader(path, (fd, size) => {
    if (size > RECORD_BYTES) return err("unsafe_path");
    const buffer = Buffer.alloc(RECORD_BYTES);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    if (fstatSync(fd).size !== bytes) return err("unsafe_path");
    const data: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytes)));
    return parse(data);
  });
}

function readRecordAt(path: string, port: number): RelayPathResult<RelayRecord | undefined> {
  return readRecordJson(path, (data) => {
    const record = RecordSchema.safeParse(data);
    return record.success && record.data.port === port ? ok(record.data) : err("unsafe_path");
  });
}

export function readRelayRecord(port: number, home: string): RelayPathResult<RelayRecord | undefined> {
  const folder = checkFolder(port, home, false);
  if (!folder.ok) return folder;
  if (folder.value === undefined) return ok(undefined);
  const result = readRecordAt(join(folder.value, RECORD_NAME), port);
  return result.ok && result.value?.pid === process.pid ? err("unsafe_path") : result;
}

export async function writeStopRequest(
  port: number, home: string, request: StopRequest,
): Promise<Result<StopRequest, "invalid_request" | "unsafe_path">> {
  const parsed = StopRequestSchema.safeParse(request);
  if (!parsed.success) return err("invalid_request");
  const folder = ensureRelayFolder(port, home);
  if (!folder.ok) return folder;
  return writePrivateRecord(join(folder.value, STOP_REQUEST_NAME), parsed.data);
}

/** Consume the file once. The caller checks the signal and request age before use. */
export function readStopRequest(
  port: number, home: string, targetPid: number, nonce: string,
): RelayPathResult<StopRequester | undefined> {
  const folder = checkFolder(port, home, false);
  if (!folder.ok || folder.value === undefined) return folder.ok ? ok(undefined) : folder;
  const path = join(folder.value, STOP_REQUEST_NAME);
  const result = readRecordJson(path, (data) => {
    const parsed = StopRequestSchema.safeParse(data);
    return parsed.success ? ok(parsed.data) : err("unsafe_path");
  });
  if (!result.ok) {
    unlinkRecord(path);
    return result;
  }
  if (result.value === undefined) return ok(undefined);
  const removed = unlinkRecord(path);
  if (!removed.ok) return removed;
  if (!removed.value) return ok(undefined);
  const { targetPid: pid, nonce: savedNonce, ...requester } = result.value;
  return ok(pid === targetPid && savedNonce === nonce ? requester : undefined);
}

function unlinkRecord(path: string): RelayPathResult<boolean> {
  try {
    unlinkSync(path);
    return ok(true);
  } catch (error) {
    return hasCode(error, "ENOENT") ? ok(false) : err("unsafe_path");
  }
}

/** Share the strict reader, but allow the caller's pid for cleanup. */
export function removeOwnRelayRecord(port: number, home: string, nonce: string): RelayPathResult<boolean> {
  const folder = checkFolder(port, home, false);
  if (!folder.ok) return folder;
  if (folder.value === undefined) return ok(false);
  const path = join(folder.value, RECORD_NAME);
  const result = readRecordAt(path, port);
  if (!result.ok) return result;
  if (result.value?.nonce !== nonce) return ok(false);
  return unlinkRecord(path);
}

type HealthProbe = { readonly answered: false } | { readonly answered: true; readonly health?: RelayHealth };

type HealthResponse = Pick<Response, "status" | "body">;

// Fetch blocks some valid relay ports. Connect directly to the selected loopback socket.
function requestLoopbackHealth(port: number, signal: AbortSignal): Promise<HealthResponse> {
  return new Promise((resolve, reject) => {
    get({ hostname: "127.0.0.1", port, path: "/__subswitch/health", agent: false, signal }, (response) => {
      const body = Readable.toWeb(response, { strategy: { highWaterMark: HEALTH_BYTES, size: (chunk: Uint8Array) => chunk.byteLength } });
      resolve({ status: response.statusCode ?? 0, body });
    }).once("upgrade", (_response, socket) => {
      socket.destroy();
      resolve({ status: 101, body: null });
    }).once("error", reject);
  });
}

async function probeHealth(port: number, { signal: cancel, requestHealth = requestLoopbackHealth }: ClassifyRelayDeps): Promise<HealthProbe> {
  const timeout = AbortSignal.timeout(HEALTH_MS);
  const signal = cancel === undefined ? timeout : AbortSignal.any([timeout, cancel]);
  let response: HealthResponse;
  try {
    response = await requestHealth(port, signal);
  } catch {
    return { answered: false };
  }
  const invalid = { answered: true } as const;
  const reader = response.body?.getReader();
  if (reader === undefined) return invalid;
  try {
    if (response.status !== 200) return invalid;
    const body = new Uint8Array(HEALTH_BYTES);
    let used = 0;
    for (let reads = 0; reads <= HEALTH_BYTES; reads++) {
      const chunk = await reader.read();
      if (chunk.done) {
        const data: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body.subarray(0, used)));
        const health = HealthSchema.safeParse(data);
        return health.success ? { answered: true, health: health.data } : invalid;
      }
      if (used + chunk.value.byteLength > HEALTH_BYTES) return invalid;
      body.set(chunk.value, used);
      used += chunk.value.byteLength;
    }
    return invalid;
  } catch {
    return signal.aborted ? { answered: false } : invalid;
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

function relayPidIsAlive(pid: number): boolean {
  try {
    return process.kill(pid, 0);
  } catch (error) {
    return hasCode(error, "EPERM");
  }
}

/** A verified relay has a live record pid and a health answer with matching identity. */
export async function classifyRelay(port: number, deps: ClassifyRelayDeps): Promise<RelayClassification> {
  const current = deps.record === undefined ? readRelayRecord(port, deps.home) : ok(deps.record);
  if (!current.ok) return { kind: "unverified", reason: current.error };
  const probe = await probeHealth(port, deps);
  if (!probe.answered) return current.value === undefined ? { kind: "none" } : { kind: "unverified", reason: "no_answer", record: current.value };
  // A relay can publish or replace the record while the health request is in flight.
  const latest = deps.record === undefined ? readRelayRecord(port, deps.home) : current;
  if (!latest.ok) return { kind: "unverified", reason: latest.error };
  const record = latest.value;
  const health = probe.health;
  if (record === undefined) return { kind: health === undefined ? "foreign" : "legacy" };
  if (health?.pid !== record.pid || health.nonce !== record.nonce || !(deps.isAlive ?? relayPidIsAlive)(record.pid)) {
    return { kind: "unverified", reason: "identity_mismatch", record };
  }
  return { kind: "verified", record, version: health.version };
}

/** The caller owns the returned descriptor. */
export function openBootLog(port: number, home: string): RelayPathResult<number> {
  const folder = ensureRelayFolder(port, home);
  if (!folder.ok) return folder;
  try {
    const fd = openSync(join(folder.value, BOOT_NAME), constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | NOFOLLOW, FILE_MODE);
    let keep = false;
    try {
      if (!isPrivateFile(fstatSync(fd))) return err("unsafe_path");
      // Truncate only after fstat accepts the file. O_TRUNC acts before that check.
      ftruncateSync(fd, 0);
      keep = true;
      return ok(fd);
    } finally {
      if (!keep) closeSync(fd);
    }
  } catch {
    return err("unsafe_path");
  }
}

export function readBootTail(port: number, home: string): RelayPathResult<string | undefined> {
  const folder = checkFolder(port, home, false);
  if (!folder.ok) return folder;
  if (folder.value === undefined) return ok(undefined);
  return withPrivateReader(join(folder.value, BOOT_NAME), (fd, size) => {
    const start = Math.max(0, size - BOOT_TAIL_BYTES);
    // The byte before the window tells us whether it starts on a line boundary.
    const guard = start === 0 ? 0 : 1;
    const tail = Buffer.alloc(BOOT_TAIL_BYTES + guard);
    const bytes = readSync(fd, tail, 0, tail.length, start - guard);
    const lines = tail.subarray(guard, bytes).toString("utf8").split("\n");
    if (guard === 1 && tail[0] !== 0x0a) lines.shift();
    const line = lines.findLast((entry) => entry.startsWith("subswitch: "));
    return ok(line === undefined ? undefined : redactCredentials(line.replace(CONTROL_CHARS, "")).slice(0, BOOT_LINE_CHARS));
  });
}
