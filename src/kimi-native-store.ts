/** Native wire storage and proper-lockfile-compatible coordination. No discovery. */
import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, rename, rmdir, unlink, type FileHandle } from "node:fs/promises";
import { dirname, join, parse, sep, basename } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { RoutingError } from "./routing/routing-types.js";

export class KimiNativeError extends RoutingError {}
export const nativeFailure = (code: string, status = 503) => new KimiNativeError(`kimi_native_${code}`, status);
export const nativeFingerprint = (value: string) => createHash("sha256").update(value).digest("hex");
const sameFile = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
const hasCode = (error: unknown, code: string) => error !== null && typeof error === "object" && "code" in error && error.code === code;
const check = (signal: AbortSignal) => { if (signal.aborted) throw nativeFailure("cancelled", 499); };
const token = (value: unknown): value is string => typeof value === "string" && /^[!-~]{1,8192}$/.test(value);
const MAX_BYTES = 64 * 1024;
export interface NativeToken extends Record<string, unknown> {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
  token_type: "Bearer";
  expires_in?: number;
}
export interface NativeSnapshot { raw: string; record: NativeToken }
export interface NativeAttempt {
  grant: string;
  outcome: "prepared" | "pending" | "denied" | "busy";
  retryAt: number;
  failures: number;
}

function safeNode(stat: Stats, directory: boolean, privateMode = true): void {
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) ||
      (process.platform !== "win32" && (stat.uid !== process.getuid?.() ||
        (privateMode ? (stat.mode & 0o7777) !== (directory ? 0o700 : 0o600) : (stat.mode & 0o022) !== 0)))) throw nativeFailure("unsafe_path");
}
async function directories(directory: string, signal: AbortSignal, privateMode = true): Promise<Map<string, Stats>> {
  const result = new Map<string, Stats>(), root = parse(directory).root;
  let current = root;
  for (const part of ["", ...directory.slice(root.length).split(sep).filter(Boolean)]) {
    check(signal);
    if (part) current = join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw nativeFailure("unsafe_path");
    if (current === directory) safeNode(stat, true, privateMode);
    else if (process.platform !== "win32" && ((stat.uid !== process.getuid?.() && stat.uid !== 0) ||
      ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0))) throw nativeFailure("unsafe_path");
    result.set(current, stat);
  }
  return result;
}
async function unchanged(before: Map<string, Stats>, signal: AbortSignal): Promise<void> {
  for (const [path, stat] of before) {
    check(signal);
    const after = await lstat(path);
    if (!sameFile(stat, after) || after.isSymbolicLink()) throw nativeFailure("changed");
  }
}
async function privateRead(path: string, signal: AbortSignal, privateDirectory = true): Promise<string> {
  const parents = await directories(dirname(path), signal, privateDirectory);
  const before = await lstat(path); safeNode(before, false);
  if (before.size > MAX_BYTES) throw nativeFailure("invalid_record");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat(); safeNode(stat, false);
    if (!sameFile(before, stat) || stat.size > MAX_BYTES) throw nativeFailure("changed");
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      check(signal);
      const chunk = await handle.read(buffer, size, buffer.length - size, size);
      if (!chunk.bytesRead) break;
      size += chunk.bytesRead;
    }
    const after = await handle.stat(), current = await lstat(path);
    safeNode(after, false); safeNode(current, false);
    if (size > MAX_BYTES || size !== stat.size || !sameFile(stat, current) ||
        stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs ||
        after.size !== current.size || after.mtimeMs !== current.mtimeMs || after.ctimeMs !== current.ctimeMs) throw nativeFailure("changed");
    await unchanged(parents, signal); check(signal);
    return buffer.toString("utf8", 0, size);
  } finally { await handle.close(); }
}
export async function readNativeSnapshot(path: string, signal: AbortSignal): Promise<NativeSnapshot> {
  const raw = await privateRead(path, signal), value: unknown = JSON.parse(raw);
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw nativeFailure("invalid_record");
  const record = value as NativeToken;
  if (record.access_token === "" && record.refresh_token === "") throw nativeFailure("reauthorization_required", 401);
  if (!token(record.access_token) || record.token_type !== "Bearer" || !Number.isSafeInteger(record.expires_at) ||
      record.expires_at <= 0 || record.expires_at > 253_402_300_799 ||
      (record.refresh_token !== undefined && !token(record.refresh_token)) ||
      (record.expires_in !== undefined && (!Number.isSafeInteger(record.expires_in) || record.expires_in < 0))) throw nativeFailure("invalid_record");
  return { raw, record };
}
export async function readNativeAttempt(authFile: string, signal: AbortSignal): Promise<NativeAttempt | undefined> {
  const path = join(dirname(dirname(authFile)), "oauth", basename(authFile, ".json") + ".subswitch-renewal.json");
  let raw: string;
  try { raw = await privateRead(path, signal, false); } catch (error) { if (hasCode(error, "ENOENT")) return; throw error; }
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw nativeFailure("invalid_attempt");
  const r = value as Record<string, unknown>, failures = r.version === 1 ? 1 : r.failures;
  if ((r.version !== 1 && r.version !== 2) || typeof r.grant !== "string" || !/^[a-f0-9]{64}$/.test(r.grant) ||
      !["prepared", "pending", "denied", "busy"].includes(String(r.outcome)) || !Number.isSafeInteger(r.retryAt) || (r.retryAt as number) < 0 ||
      !Number.isSafeInteger(failures) || (failures as number) < 1 || (failures as number) > 5) throw nativeFailure("invalid_attempt");
  return { grant: r.grant, outcome: r.outcome as NativeAttempt["outcome"], retryAt: r.retryAt as number, failures: failures as number };
}

export interface NativeLease {
  readonly signal: AbortSignal;
  verify(): Promise<void>;
  readAttempt(): Promise<NativeAttempt | undefined>;
  writeAttempt(grant: string, outcome: NativeAttempt["outcome"], retryAt?: number, failures?: number): Promise<void>;
  replace(expected: NativeSnapshot, next: NativeToken): Promise<boolean>;
}
/** Injection seams for deterministic offline suspension/takeover tests only. */
export interface NativeStoreHooks {
  afterPendingPersist?(): Promise<void>;
  beforeCredentialCommit?(): Promise<void>;
}

/** Native uses mkdir `<home>/oauth/<slot>.lock`, 5s stale / heartbeat.
 * Heartbeat every second. Stale recovery requires an unchanged, owned, empty
 * directory observed twice beyond native's 5s boundary; a live/renewed/successor
 * lease is preserved. Verify ownership at every persistence boundary.
 */
export async function withNativeLease<T>(authFile: string, signal: AbortSignal, operation: (lease: NativeLease) => Promise<T>, hooks?: NativeStoreHooks): Promise<T> {
  if (process.platform === "win32") throw nativeFailure("locking_unsupported");
  const parents = await directories(dirname(authFile), signal);
  const home = dirname(dirname(authFile)), directory = join(home, "oauth"), name = basename(authFile, ".json");
  try { await mkdir(directory, { mode: 0o700 }); } catch (error) { if (!hasCode(error, "EEXIST")) throw error; }
  const oauthParents = await directories(directory, signal, false);
  const target = join(directory, name), lock = `${target}.lock`, attempt = `${target}.subswitch-renewal.json`;
  const sentinel = await open(target, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try { safeNode(await sentinel.stat(), false, false); } finally { await sentinel.close(); }
  async function reclaimStale(): Promise<boolean> {
    let candidate: Stats;
    try { candidate = await lstat(lock); } catch (error) { if (hasCode(error, "ENOENT")) return true; throw error; }
    safeNode(candidate, true, false);
    if (Date.now() - candidate.mtimeMs <= 5000) return false;
    // Native proper-lockfile uses the same empty-directory rmdir protocol. Keep
    // an inode handle and confirm both identity and timestamps after a grace
    // observation; never recursively remove/rename a lock or delete its contents.
    const held = await open(lock, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!sameFile(candidate, await held.stat())) return false;
      await delay(100, undefined, { signal });
      await directories(directory, signal, false); await unchanged(oauthParents, signal); await unchanged(parents, signal);
      const descriptor = await held.stat(), current = await lstat(lock);
      safeNode(current, true, false);
      if (!sameFile(candidate, descriptor) || !sameFile(candidate, current) ||
          candidate.mtimeMs !== descriptor.mtimeMs || candidate.ctimeMs !== descriptor.ctimeMs ||
          candidate.mtimeMs !== current.mtimeMs || candidate.ctimeMs !== current.ctimeMs ||
          Date.now() - current.mtimeMs <= 5000) return false;
      try { await rmdir(lock); return true; }
      catch (error) { if (hasCode(error, "ENOENT")) return true; if (hasCode(error, "ENOTEMPTY") || hasCode(error, "EEXIST")) return false; throw error; }
    } finally { await held.close(); }
  }
  const deadline = Date.now() + 5000;
  while (true) {
    check(signal); await unchanged(parents, signal); await unchanged(oauthParents, signal);
    try { await mkdir(lock, { mode: 0o700 }); break; }
    catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      if (await reclaimStale().catch(error => { if (hasCode(error, "ENOENT")) return true; throw error; })) continue;
      if (Date.now() >= deadline) throw nativeFailure("lock_busy");
      await delay(50, undefined, { signal });
    }
  }
  const identity = await lstat(lock); safeNode(identity, true);
  let handle: FileHandle | undefined, compromised = false, heartbeat: ReturnType<typeof setInterval> | undefined;
  const lost = new AbortController();
  let updating = Promise.resolve();
  const verify = async () => {
    try {
    check(signal); await directories(dirname(authFile), signal); await directories(directory, signal, false);
    await unchanged(parents, signal); await unchanged(oauthParents, signal);
    const current = await lstat(lock);
    if (compromised || !sameFile(identity, current) || current.isSymbolicLink() || Date.now() - current.mtimeMs >= 4500) throw nativeFailure("lock_lost");
    } catch (error) {
      compromised = true; lost.abort(nativeFailure("lock_lost"));
      throw error instanceof KimiNativeError ? error : nativeFailure("lock_lost");
    }
  };
  async function atomic(path: string, raw: string, guard?: () => Promise<boolean>): Promise<boolean> {
    if (Buffer.byteLength(raw) > MAX_BYTES) throw nativeFailure("invalid_record");
    const temporary = `${path}.tmp.${process.pid}.${randomUUID()}`;
    let owned = false;
    try {
      await verify();
      const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); owned = true;
      try { await file.writeFile(raw, "utf8"); await file.sync(); } finally { await file.close(); }
      await verify();
      if (guard && !await guard()) return false;
      if (guard) await hooks?.beforeCredentialCommit?.();
      // The guard itself performs awaited IO; ownership must be fresh AFTER it.
      await verify();
      await rename(temporary, path); owned = false;
      const dir = await open(directory === dirname(path) ? directory : dirname(authFile), constants.O_RDONLY | constants.O_NOFOLLOW);
      try { await dir.sync(); } finally { await dir.close(); }
      return true;
    } finally { if (owned) await unlink(temporary).catch(() => {}); }
  }
  try {
    handle = await open(lock, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!sameFile(identity, await handle.stat())) throw nativeFailure("lock_lost");
    const pulse = async () => { await verify(); const date = new Date(); await handle!.utimes(date, date); };
    await pulse();
    heartbeat = setInterval(() => { updating = updating.then(pulse).catch(() => { compromised = true; lost.abort(nativeFailure("lock_lost")); }); }, 1000);
    heartbeat.unref();
    return await operation({ verify, signal: AbortSignal.any([signal, lost.signal]),
      async readAttempt() {
        await verify();
        return readNativeAttempt(authFile, signal);
      },
      async writeAttempt(grant, outcome, retryAt = 0, failures = 1) {
        // Inspect any existing marker before replacing it; never overwrite a link.
        try { safeNode(await lstat(attempt), false); } catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
        await atomic(attempt, JSON.stringify({ version: 2, grant, outcome, retryAt, failures }) + "\n");
        if (outcome === "pending") await hooks?.afterPendingPersist?.();
      },
      async replace(expected, next) {
        await verify();
        if ((await readNativeSnapshot(authFile, signal)).raw !== expected.raw) return false;
        return atomic(authFile, JSON.stringify(next, null, 2) + "\n", async () => (await readNativeSnapshot(authFile, signal)).raw === expected.raw);
      },
    });
  } finally {
    clearInterval(heartbeat); await updating;
    // Never unlink a successor's lock after stale takeover/replacement.
    try { if (sameFile(identity, await lstat(lock))) await rmdir(lock); } catch { /* leave an unprovable lock alone */ }
    await handle?.close();
  }
}
