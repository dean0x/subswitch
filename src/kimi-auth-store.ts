import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export interface KimiAuthRecord {
  version: 1;
  revision: string;
  generation: string;
  region: "global" | "mainland-cn";
  deviceId: string;
  tokens: {
    access_token: string;
    refresh_token: string;
    /** Unix epoch seconds, including when the credential has already expired. */
    expires_at: number;
    token_type: "Bearer";
  };
}

export interface KimiAuthStore {
  readonly coordinationKey: string;
  read(signal: AbortSignal): Promise<KimiAuthRecord>;
  withLock<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T>;
  /** Initial login only: fails if any credential file already exists. */
  write(record: KimiAuthRecord, signal: AbortSignal): Promise<void>;
  /** Requires this store's active lock and a matching read inside that lock. */
  compareAndSwap(expectedRevision: string, next: KimiAuthRecord, signal: AbortSignal): Promise<boolean>;
}

const MAX_BYTES = 64 * 1024;
const LOCK_WAIT_MS = 5_000;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const safeErrors = new WeakSet<Error>();
function fail(code: string): Error {
  const error = new Error(`kimi_auth_store_${code}`);
  safeErrors.add(error);
  return error;
}
function cancelled(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const error = fail("cancelled");
  error.name = "AbortError";
  throw error;
}
function sanitized(error: unknown): Error {
  return error instanceof Error && safeErrors.has(error) ? error : fail("io");
}
function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}
function record(value: unknown): KimiAuthRecord {
  const root = object(value), tokens = object(root?.tokens);
  if (!root || !tokens || root.version !== 1 || !text(root.revision, 256) ||
      !text(root.generation, 256) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(root.generation) ||
      (root.region !== "global" && root.region !== "mainland-cn") || !text(root.deviceId, 256) ||
      !text(tokens.access_token, 16_384) || !text(tokens.refresh_token, 16_384) || tokens.token_type !== "Bearer" ||
      typeof tokens.expires_at !== "number" || !Number.isSafeInteger(tokens.expires_at) ||
      tokens.expires_at <= 0 || tokens.expires_at > 253_402_300_799) throw fail("invalid_record");
  return {
    version: 1, revision: root.revision, generation: root.generation, region: root.region, deviceId: root.deviceId,
    tokens: { access_token: tokens.access_token, refresh_token: tokens.refresh_token,
      expires_at: tokens.expires_at, token_type: "Bearer" },
  };
}

interface Snapshot { stat: Stats; record: KimiAuthRecord; raw: string }
interface Lock { stat: Stats; active: boolean; observed?: Snapshot }

/**
 * Owned storage only. No home discovery, native-client import, migration or chmod.
 * The immediate auth directory is private; ancestors must be real directories
 * owned by this uid or root. Writable ancestors require sticky-bit protection.
 * Cross-process writers must use the lock. No stale lock is ever taken over.
 */
export function createKimiAuthStore(authFile: string): KimiAuthStore {
  if (typeof authFile !== "string" || !isAbsolute(authFile) || resolve(authFile) !== authFile || authFile === parse(authFile).root ||
      authFile.includes("\0")) throw fail("invalid_path");
  const directory = dirname(authFile), lockFile = `${authFile}.lock`;
  const context = new AsyncLocalStorage<Lock>();
  const uid = process.getuid?.();
  const posix = process.platform !== "win32";
  let directoryIdentity: Stats | undefined;

  function privateNode(stat: Stats, directoryNode: boolean): void {
    if (stat.isSymbolicLink() || (directoryNode ? !stat.isDirectory() : !stat.isFile()) ||
        (!directoryNode && stat.nlink !== 1) ||
        (posix && (stat.uid !== uid || (stat.mode & 0o7777) !== (directoryNode ? 0o700 : 0o600)))) {
      throw fail("unsafe_path");
    }
  }

  async function checkDirectory(create: boolean, signal: AbortSignal): Promise<void> {
    const root = parse(directory).root;
    let current = root;
    for (const part of ["", ...directory.slice(root.length).split(sep).filter(Boolean)]) {
      if (part) current = join(current, part);
      cancelled(signal);
      let stat: Stats;
      try { stat = await lstat(current); }
      catch (error) {
        if (!create || !hasCode(error, "ENOENT")) throw error;
        try { await mkdir(current, { mode: 0o700 }); }
        catch (created) { if (!hasCode(created, "EEXIST")) throw created; }
        stat = await lstat(current);
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw fail("unsafe_path");
      if (current === directory) {
        privateNode(stat, true);
        if (directoryIdentity && !sameFile(directoryIdentity, stat)) throw fail("changed");
        directoryIdentity = stat;
      } else if (posix && ((stat.uid !== uid && stat.uid !== 0) ||
          ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0))) {
        throw fail("unsafe_path");
      }
    }
  }

  async function optionalStat(path: string): Promise<Stats | undefined> {
    try { return await lstat(path); }
    catch (error) { if (hasCode(error, "ENOENT")) return undefined; throw error; }
  }

  async function snapshot(signal: AbortSignal): Promise<Snapshot> {
    await checkDirectory(false, signal);
    const before = await lstat(authFile);
    privateNode(before, false);
    const handle = await open(authFile, constants.O_RDONLY | NOFOLLOW);
    try {
      const stat = await handle.stat();
      privateNode(stat, false);
      if (!sameFile(before, stat) || stat.size > MAX_BYTES) throw fail("changed");
      // A bounded descriptor read prevents a concurrently growing file from
      // turning a size precheck into an unbounded credential read.
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      let size = 0;
      while (size < buffer.length) {
        cancelled(signal);
        const chunk = await handle.read(buffer, size, buffer.length - size, size);
        if (chunk.bytesRead === 0) break;
        size += chunk.bytesRead;
      }
      const after = await handle.stat(), pathStat = await lstat(authFile);
      privateNode(after, false); privateNode(pathStat, false);
      if (size > MAX_BYTES || !sameFile(stat, pathStat) || stat.size !== after.size ||
          stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) throw fail("changed");
      await checkDirectory(false, signal);
      const raw = buffer.toString("utf8", 0, size);
      return { stat: after, record: record(JSON.parse(raw)), raw };
    } finally { await handle.close(); }
  }

  async function assertLock(lock: Lock, signal: AbortSignal): Promise<void> {
    cancelled(signal);
    if (!lock.active || context.getStore() !== lock) throw fail("lock_required");
    await checkDirectory(false, signal);
    const current = await lstat(lockFile);
    privateNode(current, false);
    if (!sameFile(lock.stat, current)) throw fail("changed");
  }

  async function removeOwned(path: string, identity: Stats): Promise<void> {
    const current = await optionalStat(path);
    if (!current) return;
    privateNode(current, false);
    if (!sameFile(identity, current)) throw fail("changed");
    await unlink(path);
  }

  async function withLock<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    let handle: FileHandle | undefined, lock: Lock | undefined;
    try {
      cancelled(signal);
      if (context.getStore()?.active) throw fail("lock_required");
      await checkDirectory(true, signal);
      const deadline = performance.now() + LOCK_WAIT_MS;
      for (;;) {
        cancelled(signal);
        await checkDirectory(false, signal);
        try { handle = await open(lockFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600); }
        catch (error) {
          if (!hasCode(error, "EEXIST")) throw error;
          const existing = await optionalStat(lockFile);
          if (existing) privateNode(existing, false);
          const remaining = deadline - performance.now();
          if (remaining <= 0) throw fail("lock_timeout");
          try { await delay(Math.min(25, remaining), undefined, { signal }); }
          catch { cancelled(signal); throw fail("io"); }
          continue;
        }
        const stat = await handle.stat();
        privateNode(stat, false);
        lock = { stat, active: true };
        break;
      }
      const held = lock;
      return await context.run(held, async () => {
        await assertLock(held, signal);
        return operation();
      });
    } catch (error) { cancelled(signal); throw sanitized(error); }
    finally {
      if (lock) lock.active = false;
      try {
        if (lock) await removeOwned(lockFile, lock.stat);
      } catch { /* Never remove a replaced lock, or disclose cleanup errors. */ }
      await handle?.close().catch(() => undefined);
    }
  }

  async function persist(next: KimiAuthRecord, expected: Snapshot | undefined, lock: Lock, signal: AbortSignal): Promise<boolean> {
    const safe = record(next), raw = JSON.stringify(safe);
    if (Buffer.byteLength(raw, "utf8") > MAX_BYTES) throw fail("invalid_record");
    const temporary = join(directory, `.${basename(authFile)}.${randomUUID()}.tmp`);
    let handle: FileHandle | undefined, identity: Stats | undefined;
    try {
      await assertLock(lock, signal);
      handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
      identity = await handle.stat(); privateNode(identity, false);
      await handle.writeFile(raw, { encoding: "utf8", signal });
      await handle.sync();
      await handle.close(); handle = undefined;
      await assertLock(lock, signal);
      const tempStat = await lstat(temporary); privateNode(tempStat, false);
      if (!sameFile(identity, tempStat)) throw fail("changed");
      if (expected) {
        let latest: Snapshot;
        try { latest = await snapshot(signal); }
        catch (error) { if (hasCode(error, "ENOENT")) return false; throw error; }
        if (!sameFile(expected.stat, latest.stat) || expected.raw !== latest.raw) return false;
      } else {
        const existing = await optionalStat(authFile);
        if (existing) { privateNode(existing, false); throw fail("exists"); }
      }
      cancelled(signal);
      // Commit point: complete private temp is atomically published while locked.
      await rename(temporary, authFile);
      delete lock.observed;
      return true;
    } finally {
      await handle?.close().catch(() => undefined);
      if (identity) await removeOwned(temporary, identity).catch(() => undefined);
    }
  }

  return {
    coordinationKey: `kimi-owned:${authFile}`,
    async read(signal) {
      try {
        const value = await snapshot(signal), lock = context.getStore();
        if (lock?.active) { await assertLock(lock, signal); lock.observed = value; }
        return record(value.record);
      } catch (error) {
        cancelled(signal);
        if (hasCode(error, "ENOENT")) throw fail("missing");
        throw sanitized(error);
      }
    },
    withLock,
    async write(value, signal) {
      const operation = async () => {
        const lock = context.getStore();
        if (!lock?.active) throw fail("lock_required");
        await persist(value, undefined, lock, signal);
      };
      try {
        if (context.getStore()?.active) await operation();
        else await withLock(operation, signal);
      } catch (error) { cancelled(signal); throw sanitized(error); }
    },
    async compareAndSwap(expectedRevision, next, signal) {
      try {
        const lock = context.getStore();
        if (!lock?.active) throw fail("lock_required");
        await assertLock(lock, signal);
        const expected = lock.observed;
        if (!expected || expected.record.revision !== expectedRevision) return false;
        const safe = record(next), previous = expected.record;
        if (safe.generation !== previous.generation || safe.region !== previous.region ||
            safe.deviceId !== previous.deviceId || safe.revision === expectedRevision) throw fail("changed");
        return await persist(safe, expected, lock, signal);
      } catch (error) { cancelled(signal); throw sanitized(error); }
    },
  };
}
