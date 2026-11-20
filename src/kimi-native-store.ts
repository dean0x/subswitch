/**
 * The Kimi CLI sign-in file and the Kimi CLI lock.
 *
 * Subswitch reads `<home>/credentials/<slot>.json` and writes it back only under the Kimi
 * CLI lock: the folder `<home>/oauth/<slot>.lock`, made with mkdir beside the empty lock
 * target `<home>/oauth/<slot>`. The CLI takes a lock folder as stale when its mtime is
 * older than 5000 ms. A lock holder updates the mtime every 2500 ms; Subswitch does the
 * same. Subswitch removes only an empty stale lock folder, and on release it removes only
 * the lock folder that it made, never the lock folder of a process that took over.
 *
 * The renewal marker `<home>/oauth/<slot>.subswitch-renewal.json` records each renewal
 * before its request is sent. The Kimi CLI does not clean `<home>/oauth`, so the marker
 * stays beside the lock, where each Subswitch process that uses this home finds it.
 *
 * Every call rejects only with a KimiNativeError, whose message is its fixed code. No path,
 * record text or system error text leaves this module.
 */
import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, rename, rmdir, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  KIMI_CREDENTIALS_FOLDER, KIMI_LOCK_HEARTBEAT_MS, KIMI_LOCK_STALE_MS, KIMI_OAUTH_FOLDER, KIMI_RECORD_FIELDS,
} from "./kimi-constants.js";
import { KimiNativeError, type KimiErrorCode } from "./kimi-errors.js";
import { isPlainObject } from "./plain-object.js";

/** The largest sign-in file or marker that Subswitch reads or writes. */
const MAX_BYTES = 64 * 1024;
/** Subswitch takes its own lock as lost when its mtime is older than this, a margin below the CLI stale bound. */
const OWN_LOCK_LOST_MS = KIMI_LOCK_STALE_MS - 500;
/** How long Subswitch waits for a lock that another process holds, and the pause between tries. */
const LOCK_WAIT_MS = 5000;
const LOCK_POLL_MS = 50;
/** A fixed bound on the lock tries, above LOCK_WAIT_MS / LOCK_POLL_MS. */
const LOCK_TRY_LIMIT = 200;
/** The pause before Subswitch checks a stale lock folder a second time and removes it. */
const STALE_GRACE_MS = 100;
const MARKER_SUFFIX = ".subswitch-renewal.json";
const MARKER_VERSION = 1;
const MAX_FAILURES = 5;
/** 9999-12-31T23:59:59Z in Unix seconds. */
const LATEST_EXPIRY_SECONDS = 253_402_300_799;
const TOKEN = /^[!-~]{1,8192}$/;
const FINGERPRINT = /^[a-f0-9]{64}$/;
const MARKER_OUTCOMES = ["prepared", "pending", "denied", "busy"] as const;

export type MarkerOutcome = (typeof MARKER_OUTCOMES)[number];

/** A Kimi CLI sign-in record. It keeps every key of the file, also the keys that Subswitch does not know. */
export interface KimiTokenRecord extends Readonly<Record<string, unknown>> {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly expires_at: number;
  readonly scope: string;
  readonly token_type: "Bearer";
  readonly expires_in: number;
}

/** The file text and the record in it. A write-back compares the text. */
export interface KimiSnapshot {
  readonly raw: string;
  readonly record: KimiTokenRecord;
}

/** The state of one renewal of one grant. The grant is the fingerprint that the caller gives. */
export interface RenewalMarker {
  readonly grant: string;
  readonly outcome: MarkerOutcome;
  readonly retryAt: number;
  readonly failures: number;
}

/** The calls that need the lock. Each one checks that the lease still holds the lock. */
export interface KimiLease {
  /** Aborts when the caller signal aborts or the lock is lost. Give it to the renewal request. */
  readonly signal: AbortSignal;
  /** Fail with lock_lost unless this lease still holds a fresh lock in the same folders. */
  readonly verify: () => Promise<void>;
  readonly read: () => Promise<KimiSnapshot>;
  readonly readMarker: () => Promise<RenewalMarker | undefined>;
  /** Write the marker atomically. Write it as prepared, then as pending, before each renewal request. */
  readonly writeMarker: (grant: string, outcome: MarkerOutcome, retryAt?: number, failures?: number) => Promise<void>;
  readonly clearMarker: () => Promise<void>;
  /**
   * Write `next` atomically in place of the file, only while the file text is still
   * `expected.raw`. Returns false when another process changed the file: read it again and
   * use its record. It never writes a record that `read` would refuse.
   */
  readonly replace: (expected: KimiSnapshot, next: KimiTokenRecord) => Promise<boolean>;
}

/** Test seams at two points of a renewal. Production code gives none. */
export interface KimiStoreHooks {
  /** Runs after the pending marker is on disk. */
  readonly afterPendingPersist?: () => Promise<void>;
  /** Runs after the last check of the file text, before the last lock check and the rename. */
  readonly beforeCredentialCommit?: () => Promise<void>;
}

export interface KimiNativeStore {
  /** Read and check the sign-in record. It makes no file, folder or lock. */
  readonly read: (signal: AbortSignal) => Promise<KimiSnapshot>;
  /** Read the renewal marker without the lock, or undefined when there is none. It makes nothing. */
  readonly readMarker: (signal: AbortSignal) => Promise<RenewalMarker | undefined>;
  /** Hold the Kimi CLI lock, with a heartbeat, while `operation` runs; then release it. */
  readonly withLease: <T>(signal: AbortSignal, operation: (lease: KimiLease) => Promise<T>) => Promise<T>;
}

/** The SHA-256 hex fingerprint of a value, for a marker grant or a log-free comparison. */
export const kimiFingerprint = (value: string): string => createHash("sha256").update(value).digest("hex");

/** A private node has mode 0700 (folder) or 0600 (file). A shared node has no group or other write bit. */
export type NodeRule = "private-folder" | "shared-folder" | "private-file" | "shared-file";

/** Whether an lstat result meets its rule: no link, the type, one name for a file, the owner and the mode. */
export const isSafeNode = (stat: Stats, rule: NodeRule, uid: number): boolean => {
  const folder = rule === "private-folder" || rule === "shared-folder";
  if (stat.isSymbolicLink() || stat.uid !== uid) return false;
  if (folder ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) return false;
  if (rule === "private-folder" || rule === "private-file") return (stat.mode & 0o7777) === (folder ? 0o700 : 0o600);
  return (stat.mode & 0o022) === 0;
};

/** A folder above the sign-in folders belongs to this user or to root, and others can not write it unless it is sticky. */
const isSafeAncestor = (stat: Stats, uid: number): boolean =>
  !stat.isSymbolicLink() && stat.isDirectory() && (stat.uid === uid || stat.uid === 0) &&
  ((stat.mode & 0o022) === 0 || (stat.mode & 0o1000) !== 0);

const failure = (code: KimiErrorCode): KimiNativeError => new KimiNativeError(code);
const hasCode = (error: unknown, code: string): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === code;
const sameNode = (a: Stats, b: Stats): boolean => a.dev === b.dev && a.ino === b.ino;
const sameTimes = (a: Stats, b: Stats): boolean => a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const checkSignal = (signal: AbortSignal): void => {
  if (signal.aborted) throw failure("cancelled");
};
const cliText = (record: KimiTokenRecord): string => `${JSON.stringify(record, null, 2)}\n`;

/** Any failure as a typed failure. O_NOFOLLOW reports a link as ELOOP. Every other system failure is unavailable. */
const typed = (error: unknown, signal: AbortSignal, missing: KimiErrorCode = "unavailable"): KimiNativeError => {
  if (error instanceof KimiNativeError) return error;
  if (signal.aborted) return failure("cancelled");
  if (hasCode(error, "ELOOP")) return failure("unsafe_path");
  return failure(hasCode(error, "ENOENT") ? missing : "unavailable");
};

const ownerUid = (): number => {
  if (process.platform === "win32" || typeof process.getuid !== "function") throw failure("platform_unsupported");
  return process.getuid();
};

const lstatIfPresent = async (path: string): Promise<Stats | undefined> => {
  try {
    return await lstat(path);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
};

const syncFolder = async (path: string): Promise<void> => {
  const folder = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await folder.sync();
  } finally {
    await folder.close();
  }
};

/** Check each folder from the root down to `folder`. The lstat results let a later check see a replaced folder. */
const folderChain = async (folder: string, rule: "private-folder" | "shared-folder", signal: AbortSignal): Promise<ReadonlyMap<string, Stats>> => {
  const uid = ownerUid();
  const chain = new Map<string, Stats>();
  const { root } = parse(folder);
  let current = root;
  for (const part of ["", ...folder.slice(root.length).split(sep).filter(Boolean)]) {
    checkSignal(signal);
    if (part) current = join(current, part);
    const stat = await lstat(current);
    if (!(current === folder ? isSafeNode(stat, rule, uid) : isSafeAncestor(stat, uid))) throw failure("unsafe_path");
    chain.set(current, stat);
  }
  return chain;
};

const unchanged = async (chain: ReadonlyMap<string, Stats>, signal: AbortSignal): Promise<void> => {
  for (const [path, before] of chain) {
    checkSignal(signal);
    const after = await lstat(path);
    if (after.isSymbolicLink() || !sameNode(before, after)) throw failure("changed");
  }
};

/** Read a private file of at most MAX_BYTES. Fail when the file or a folder above it changes during the read. */
const privateRead = async (path: string, folderRule: "private-folder" | "shared-folder", signal: AbortSignal,
  tooLarge: KimiErrorCode): Promise<string> => {
  const uid = ownerUid();
  const chain = await folderChain(dirname(path), folderRule, signal);
  const before = await lstat(path);
  if (!isSafeNode(before, "private-file", uid)) throw failure("unsafe_path");
  if (before.size > MAX_BYTES) throw failure(tooLarge);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!isSafeNode(opened, "private-file", uid)) throw failure("unsafe_path");
    if (!sameNode(before, opened) || opened.size > MAX_BYTES) throw failure("changed");
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    // Each read adds at least one byte or ends the loop, so the buffer length bounds it.
    for (let reads = 0; reads < buffer.length && size < buffer.length; reads++) {
      checkSignal(signal);
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    const after = await handle.stat(), current = await lstat(path);
    if (!isSafeNode(after, "private-file", uid) || !isSafeNode(current, "private-file", uid)) throw failure("unsafe_path");
    if (size > MAX_BYTES) throw failure(tooLarge);
    if (size !== opened.size || after.size !== opened.size || current.size !== after.size || !sameNode(opened, current) ||
        !sameTimes(opened, after) || !sameTimes(after, current)) throw failure("changed");
    await unchanged(chain, signal);
    return buffer.toString("utf8", 0, size);
  } finally {
    await handle.close().catch(() => undefined);
  }
};

/** Why a value is not a supported sign-in record, or undefined when it is one. */
const recordFault = (value: unknown): KimiErrorCode | undefined => {
  if (!isPlainObject(value)) return "invalid_record";
  for (const [field, type] of KIMI_RECORD_FIELDS) {
    if (typeof value[field] !== type) return "layout_unsupported";
  }
  const { access_token: access, refresh_token: refresh, token_type: tokenType, expires_at: expiresAt, expires_in: expiresIn } = value;
  // The Kimi CLI marks a revoked sign-in with two empty tokens.
  if (access === "" && refresh === "") return "reauthorization_required";
  const valid = typeof access === "string" && TOKEN.test(access) && typeof refresh === "string" && TOKEN.test(refresh) &&
    tokenType === "Bearer" && typeof expiresAt === "number" && Number.isSafeInteger(expiresAt) && expiresAt > 0 &&
    expiresAt <= LATEST_EXPIRY_SECONDS && typeof expiresIn === "number" && Number.isSafeInteger(expiresIn) && expiresIn >= 0;
  return valid ? undefined : "invalid_record";
};

const parseRecord = (raw: string): KimiTokenRecord => {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    // The parse error quotes the file text, so it is dropped here.
    throw failure("invalid_record");
  }
  const fault = recordFault(value);
  if (fault !== undefined) throw failure(fault);
  return value as KimiTokenRecord;
};

const isMarker = (value: Readonly<Record<keyof RenewalMarker, unknown>>): value is RenewalMarker =>
  typeof value.grant === "string" && FINGERPRINT.test(value.grant) &&
  (MARKER_OUTCOMES as readonly unknown[]).includes(value.outcome) &&
  typeof value.retryAt === "number" && Number.isSafeInteger(value.retryAt) && value.retryAt >= 0 &&
  typeof value.failures === "number" && Number.isSafeInteger(value.failures) && value.failures >= 1 && value.failures <= MAX_FAILURES;

const parseMarker = (raw: string): RenewalMarker => {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw failure("invalid_marker");
  }
  if (!isPlainObject(value) || value["version"] !== MARKER_VERSION) throw failure("invalid_marker");
  const marker = { grant: value["grant"], outcome: value["outcome"], retryAt: value["retryAt"], failures: value["failures"] };
  if (!isMarker(marker)) throw failure("invalid_marker");
  return marker;
};

interface StorePaths {
  readonly authFile: string;
  readonly credentials: string;
  /** The lock file of the archived Python Kimi CLI. Its lock does not exclude the Kimi Code CLI lock. */
  readonly legacyLock: string;
  readonly oauth: string;
  readonly target: string;
  readonly lock: string;
  readonly marker: string;
}

/** The store paths, or undefined for a path that is not absolute, normal and `<home>/credentials/<slot>.json`. */
const storePaths = (authFile: string): StorePaths | undefined => {
  const credentials = dirname(authFile), slot = basename(authFile, ".json");
  if (!isAbsolute(authFile) || resolve(authFile) !== authFile || authFile.includes("\0") || !authFile.endsWith(".json") ||
      basename(credentials) !== KIMI_CREDENTIALS_FOLDER || slot === "" || slot.startsWith(".")) return undefined;
  const oauth = join(dirname(credentials), KIMI_OAUTH_FOLDER), target = join(oauth, slot);
  return {
    authFile, credentials, legacyLock: join(credentials, `${slot}.lock`), oauth, target,
    lock: `${target}.lock`, marker: `${target}${MARKER_SUFFIX}`,
  };
};

const readSnapshot = async (paths: StorePaths, signal: AbortSignal): Promise<KimiSnapshot> => {
  const raw = await privateRead(paths.authFile, "private-folder", signal, "invalid_record");
  return { raw, record: parseRecord(raw) };
};

const readMarkerFile = async (paths: StorePaths, signal: AbortSignal): Promise<RenewalMarker | undefined> => {
  let raw: string;
  try {
    raw = await privateRead(paths.marker, "shared-folder", signal, "invalid_marker");
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
  return parseMarker(raw);
};

/** Check the sign-in folders and file before any lock state is made. */
const preflight = async (paths: StorePaths, uid: number, signal: AbortSignal): Promise<ReadonlyMap<string, Stats>> => {
  const chain = await folderChain(paths.credentials, "private-folder", signal);
  if (!isSafeNode(await lstat(paths.authFile), "private-file", uid)) throw failure("unsafe_path");
  if (await lstatIfPresent(paths.legacyLock) !== undefined) throw failure("layout_unsupported");
  return chain;
};

/** Make the empty lock target, as the CLI does. A folder there is a layout that the CLI does not make. */
const ensureLockTarget = async (target: string, uid: number): Promise<void> => {
  const existing = await lstatIfPresent(target);
  if (existing?.isDirectory()) throw failure("layout_unsupported");
  if (existing !== undefined && !isSafeNode(existing, "shared-file", uid)) throw failure("unsafe_path");
  const handle = await open(target, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    if (!isSafeNode(await handle.stat(), "shared-file", uid)) throw failure("unsafe_path");
  } finally {
    await handle.close().catch(() => undefined);
  }
};

const runLease = async <T>(paths: StorePaths, signal: AbortSignal, operation: (lease: KimiLease) => Promise<T>,
  hooks: KimiStoreHooks): Promise<T> => {
  const uid = ownerUid();
  const credentialChain = await preflight(paths, uid, signal).catch((error: unknown) => {
    throw typed(error, signal, "credential_missing");
  });
  try {
    await mkdir(paths.oauth, { mode: 0o700 });
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
  }
  const oauthChain = await folderChain(paths.oauth, "shared-folder", signal);
  await ensureLockTarget(paths.target, uid);

  /** Remove the lock folder only when it is empty, stale, and still the same folder after a pause. */
  const reclaimStale = async (): Promise<boolean> => {
    const candidate = await lstatIfPresent(paths.lock);
    if (candidate === undefined) return true;
    if (candidate.isFile()) throw failure("layout_unsupported");
    if (!isSafeNode(candidate, "shared-folder", uid)) throw failure("unsafe_path");
    if (Date.now() - candidate.mtimeMs <= KIMI_LOCK_STALE_MS) return false;
    const held = await open(paths.lock, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!sameNode(candidate, await held.stat())) return false;
      await delay(STALE_GRACE_MS, undefined, { signal });
      await folderChain(paths.oauth, "shared-folder", signal);
      await unchanged(oauthChain, signal);
      await unchanged(credentialChain, signal);
      const descriptor = await held.stat(), current = await lstat(paths.lock);
      if (!isSafeNode(current, "shared-folder", uid)) throw failure("unsafe_path");
      if (!sameNode(candidate, descriptor) || !sameNode(candidate, current) || !sameTimes(candidate, descriptor) ||
          !sameTimes(candidate, current) || Date.now() - current.mtimeMs <= KIMI_LOCK_STALE_MS) return false;
      try {
        await rmdir(paths.lock);
        return true;
      } catch (error) {
        if (hasCode(error, "ENOENT")) return true;
        if (hasCode(error, "ENOTEMPTY") || hasCode(error, "EEXIST")) return false;
        throw error;
      }
    } finally {
      await held.close().catch(() => undefined);
    }
  };

  const acquire = async (): Promise<void> => {
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (let tries = 0; tries < LOCK_TRY_LIMIT; tries++) {
      checkSignal(signal);
      await unchanged(credentialChain, signal);
      await unchanged(oauthChain, signal);
      try {
        await mkdir(paths.lock, { mode: 0o700 });
        return;
      } catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;
      }
      const reclaimed = await reclaimStale().catch((error: unknown) => {
        if (hasCode(error, "ENOENT")) return true;
        throw error;
      });
      if (reclaimed) continue;
      if (Date.now() >= deadline) break;
      await delay(LOCK_POLL_MS, undefined, { signal });
    }
    throw failure("lock_busy");
  };

  await acquire();
  const identity = await lstat(paths.lock);
  const lost = new AbortController();
  let compromised = false;
  const markLost = (): void => {
    compromised = true;
    if (!lost.signal.aborted) lost.abort(failure("lock_lost"));
  };
  const verify = async (): Promise<void> => {
    try {
      checkSignal(signal);
      await folderChain(paths.credentials, "private-folder", signal);
      await folderChain(paths.oauth, "shared-folder", signal);
      await unchanged(credentialChain, signal);
      await unchanged(oauthChain, signal);
      const current = await lstat(paths.lock);
      if (compromised || !sameNode(identity, current) || current.isSymbolicLink() ||
          Date.now() - current.mtimeMs >= OWN_LOCK_LOST_MS) throw failure("lock_lost");
    } catch (error) {
      markLost();
      throw error instanceof KimiNativeError ? error : failure("lock_lost");
    }
  };

  /** Write `text` to a new 0600 temp file, sync it, and rename it over `path` while the lease holds the lock. */
  const atomicWrite = async (path: string, text: string, tooLarge: KimiErrorCode,
    guard?: () => Promise<boolean>): Promise<boolean> => {
    if (Buffer.byteLength(text) > MAX_BYTES) throw failure(tooLarge);
    const temporary = `${path}.tmp.${process.pid}.${randomUUID()}`;
    let owned = false;
    try {
      await verify();
      const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      owned = true;
      try {
        await file.chmod(0o600);
        await file.writeFile(text, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      await verify();
      if (guard !== undefined) {
        if (!(await guard())) return false;
        await hooks.beforeCredentialCommit?.();
      }
      // The guard reads the file, so the lock is checked again after it.
      await verify();
      await rename(temporary, path);
      owned = false;
      await syncFolder(dirname(path));
      return true;
    } finally {
      if (owned) await unlink(temporary).catch(() => undefined);
    }
  };

  const refuseUnsafeMarker = async (): Promise<boolean> => {
    const existing = await lstatIfPresent(paths.marker);
    if (existing !== undefined && !isSafeNode(existing, "private-file", uid)) throw failure("unsafe_path");
    return existing !== undefined;
  };

  const lease: KimiLease = {
    signal: AbortSignal.any([signal, lost.signal]),
    verify,
    read: async () => {
      await verify();
      return readSnapshot(paths, signal);
    },
    readMarker: async () => {
      await verify();
      return readMarkerFile(paths, signal);
    },
    writeMarker: async (grant, outcome, retryAt = 0, failures = 1) => {
      const marker = { grant, outcome, retryAt, failures };
      if (!isMarker(marker)) throw failure("invalid_marker");
      await refuseUnsafeMarker();
      await atomicWrite(paths.marker, `${JSON.stringify({ version: MARKER_VERSION, ...marker })}\n`, "invalid_marker");
      if (outcome === "pending") await hooks.afterPendingPersist?.();
    },
    clearMarker: async () => {
      await verify();
      if (!(await refuseUnsafeMarker())) return;
      await unlink(paths.marker);
      await syncFolder(paths.oauth);
    },
    replace: async (expected, next) => {
      const fault = recordFault(next);
      // Subswitch never writes a record that the reader refuses, a revoked record included.
      if (fault !== undefined) throw failure(fault === "reauthorization_required" ? "invalid_record" : fault);
      await verify();
      if ((await readSnapshot(paths, signal)).raw !== expected.raw) return false;
      return atomicWrite(paths.authFile, cliText(next), "invalid_record",
        async () => (await readSnapshot(paths, signal)).raw === expected.raw);
    },
  };

  let handle: FileHandle | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let pulses: Promise<void> = Promise.resolve();
  try {
    if (!isSafeNode(identity, "private-folder", uid)) throw failure("unsafe_path");
    const lockHandle = await open(paths.lock, constants.O_RDONLY | constants.O_NOFOLLOW);
    handle = lockHandle;
    if (!sameNode(identity, await lockHandle.stat())) throw failure("lock_lost");
    const pulse = async (): Promise<void> => {
      await verify();
      const now = new Date();
      await lockHandle.utimes(now, now);
    };
    await pulse();
    heartbeat = setInterval(() => {
      pulses = pulses.then(pulse).catch(markLost);
    }, KIMI_LOCK_HEARTBEAT_MS);
    heartbeat.unref();
    try {
      return await operation(lease);
    } catch (error) {
      if (error instanceof KimiNativeError) throw error;
      if (lost.signal.aborted && !signal.aborted) throw failure("lock_lost");
      throw typed(error, signal);
    }
  } finally {
    clearInterval(heartbeat);
    await pulses;
    // Remove the lock folder only while it is the folder that this lease made, never a successor's.
    const current = await lstatIfPresent(paths.lock).catch(() => undefined);
    if (current !== undefined && sameNode(identity, current)) await rmdir(paths.lock).catch(() => undefined);
    await handle?.close().catch(() => undefined);
  }
};

const guarded = async <T>(signal: AbortSignal, missing: KimiErrorCode, run: () => Promise<T>): Promise<T> => {
  try {
    return await run();
  } catch (error) {
    throw typed(error, signal, missing);
  }
};

/**
 * The store of one Kimi CLI sign-in file. `authFile` is `<home>/credentials/<slot>.json`,
 * absolute and normal; any other path fails each call with unsafe_path.
 */
export const createKimiNativeStore = (authFile: string, hooks: KimiStoreHooks = {}): KimiNativeStore => {
  const paths = storePaths(authFile);
  const checkedPaths = (): StorePaths => {
    if (paths === undefined) throw failure("unsafe_path");
    return paths;
  };
  return {
    read: (signal) => guarded(signal, "credential_missing", () => readSnapshot(checkedPaths(), signal)),
    readMarker: (signal) => guarded(signal, "unavailable", () => readMarkerFile(checkedPaths(), signal)),
    withLease: (signal, operation) => guarded(signal, "unavailable", () => runLease(checkedPaths(), signal, operation, hooks)),
  };
};
