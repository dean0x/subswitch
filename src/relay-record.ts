import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readSync, unlinkSync } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { CodexIngressHealthSchema } from "./codex-health.js";
import { CONTROL_CHARS } from "./logger.js";
import { isPrivateFile } from "./private-file.js";
import { err, ok, type Result } from "./result.js";
import { isPrivateFolder } from "./routing/state-dir.js";
import { SUBSWITCH_NAME, SUBSWITCH_VERSION } from "./version.js";

const RECORD_NAME = "relay.json";
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
const RecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  pid: Pid,
  port: Port,
  version: Version,
  startedAt: z.iso.datetime({ offset: true }).refine((time) => Number.isFinite(Date.parse(time))),
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
type RelayPathResult<T> = Result<T, "unsafe_path">;
export type RelayClassification =
  | { readonly kind: "none" | "legacy" | "foreign" }
  | { readonly kind: "unverified"; readonly reason: "unsafe_path" }
  | { readonly kind: "unverified"; readonly reason: "identity_mismatch" | "no_answer"; readonly record: RelayRecord }
  | { readonly kind: "verified"; readonly record: RelayRecord; readonly version: string };
export interface ClassifyRelayDeps { readonly home: string; }

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
    const homeStat = lstatSync(home);
    if (!homeStat.isDirectory() || (uid !== undefined && homeStat.uid !== uid)) return err("unsafe_path");
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
      if (!stat.isDirectory() || (uid !== undefined && stat.uid !== uid)) return err("unsafe_path");
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

export async function publishRelayRecord(port: number, home: string): Promise<RelayPathResult<RelayRecord>> {
  const folder = ensureRelayFolder(port, home);
  if (!folder.ok) return folder;
  const path = join(folder.value, RECORD_NAME);
  let temporary: string | undefined;
  try {
    const record: RelayRecord = {
      schemaVersion: 1, port, pid: process.pid, version: SUBSWITCH_VERSION, startedAt: new Date().toISOString(),
      managedBy: "none", nonce: randomBytes(16).toString("hex"),
    };
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

function readRecordAt(path: string, port: number): RelayPathResult<RelayRecord | undefined> {
  return withPrivateReader(path, (fd, size) => {
    if (size > RECORD_BYTES) return err("unsafe_path");
    const buffer = Buffer.alloc(RECORD_BYTES + 1);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    if (bytes > RECORD_BYTES) return err("unsafe_path");
    const data: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytes)));
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

/** Share the strict reader, but allow the caller's pid for cleanup. */
export function removeOwnRelayRecord(port: number, home: string, nonce: string): RelayPathResult<boolean> {
  const folder = checkFolder(port, home, false);
  if (!folder.ok) return folder;
  if (folder.value === undefined) return ok(false);
  const path = join(folder.value, RECORD_NAME);
  const result = readRecordAt(path, port);
  if (!result.ok) return result;
  if (result.value?.nonce !== nonce) return ok(false);
  try {
    unlinkSync(path);
    return ok(true);
  } catch (error) {
    return hasCode(error, "ENOENT") ? ok(false) : err("unsafe_path");
  }
}

type HealthProbe = { readonly answered: false } | { readonly answered: true; readonly health?: RelayHealth };

async function probeHealth(port: number): Promise<HealthProbe> {
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${port}/__subswitch/health`, {
      method: "GET", redirect: "manual", signal: AbortSignal.timeout(HEALTH_MS),
    });
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
    return invalid;
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

export async function classifyRelay(port: number, deps: ClassifyRelayDeps): Promise<RelayClassification> {
  const current = readRelayRecord(port, deps.home);
  if (!current.ok) return { kind: "unverified", reason: current.error };
  const record = current.value;
  const probe = await probeHealth(port);
  if (!probe.answered) return record === undefined ? { kind: "none" } : { kind: "unverified", reason: "no_answer", record };
  const health = probe.health;
  if (record === undefined) return { kind: health === undefined ? "foreign" : "legacy" };
  if (health?.pid !== record.pid || health.nonce !== record.nonce) return { kind: "unverified", reason: "identity_mismatch", record };
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
    return ok(line?.replace(CONTROL_CHARS, "").slice(0, BOOT_LINE_CHARS));
  });
}
