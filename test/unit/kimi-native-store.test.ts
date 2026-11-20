/**
 * The Kimi sign-in store. Every home is a fabricated mkdtemp folder under the real temp
 * path; no test reads a real home, sign-in file or store. The lock layout, the marker name
 * and the record fields are spelled here from the Kimi CLI facts, apart from the code.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { KimiNativeError, toKimiProxyError, type KimiErrorCode } from "../../src/kimi-errors.js";
import { createKimiNativeStore, isSafeNode, kimiFingerprint, type KimiStoreHooks, type KimiTokenRecord } from "../../src/kimi-native-store.js";

const SLOT = "kimi-code";
const signal = () => AbortSignal.timeout(15_000);
const nowSeconds = () => Math.floor(Date.now() / 1000);
const record = (access = "FAKE-access-0001"): KimiTokenRecord => ({
  access_token: access, refresh_token: "FAKE-refresh-0001", expires_at: nowSeconds() + 3600,
  scope: "kimi-code", token_type: "Bearer", expires_in: 3600, custom: "kept",
});
/** The Kimi CLI file format: two-space JSON and a final newline. */
const cliText = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const without = (value: Record<string, unknown>, key: string) => Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
const grant = kimiFingerprint("FAKE-grant-0001");

async function kimiHome(t: TestContext, hooks?: KimiStoreHooks) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "subswitch-kimi-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const credentials = join(root, "credentials");
  await mkdir(credentials, { mode: 0o700 });
  const file = join(credentials, `${SLOT}.json`);
  await writeFile(file, cliText(record()), { mode: 0o600 });
  const oauth = join(root, "oauth");
  return {
    root, credentials, file, oauth,
    sentinel: join(oauth, SLOT), lock: join(oauth, `${SLOT}.lock`), marker: join(oauth, `${SLOT}.subswitch-renewal.json`),
    store: createKimiNativeStore(file, hooks),
  };
}
type Home = Awaited<ReturnType<typeof kimiHome>>;

const rejectsWith = (pending: Promise<unknown>, code: KimiErrorCode) => assert.rejects(pending, (error: unknown) => {
  assert.ok(error instanceof KimiNativeError, `a typed store failure, not ${String(error)}`);
  assert.equal(error.code, code);
  return true;
});
const staleLock = async (home: Home) => {
  await mkdir(home.oauth, { mode: 0o700 });
  await mkdir(home.lock, { mode: 0o700 });
  const old = new Date(Date.now() - 10_000);
  await utimes(home.lock, old, old);
};
const takeOver = async (lock: string) => {
  await rename(lock, `${lock}.old`);
  await mkdir(lock, { mode: 0o700 });
};

describe("Kimi native store: read", () => {
  it("reads the CLI record and keeps its unknown keys", async (t) => {
    const { file, store } = await kimiHome(t);
    const snapshot = await store.read(signal());
    assert.equal(snapshot.raw, await readFile(file, "utf8"));
    assert.equal(snapshot.record.access_token, "FAKE-access-0001");
    assert.equal(snapshot.record["custom"], "kept");
  });

  it("creates no file or folder when it reads the record and the marker", async (t) => {
    const { root, store } = await kimiHome(t);
    await store.read(signal());
    assert.equal(await store.readMarker(signal()), undefined);
    assert.deepEqual(await readdir(root), ["credentials"]);
  });

  it("refuses a missing sign-in file with credential_missing and makes no lock state", async (t) => {
    const { root, file, store } = await kimiHome(t);
    await rm(file);
    await rejectsWith(store.read(signal()), "credential_missing");
    await rejectsWith(store.withLease(signal(), async () => assert.fail("no lease without a sign-in file")), "credential_missing");
    assert.deepEqual(await readdir(root), ["credentials"]);
  });

  it("refuses a sign-in path that is not absolute, normal and under a credentials folder", async () => {
    for (const path of ["credentials/kimi-code.json", "/fixture/credentials/../credentials/kimi-code.json", "/fixture/other/kimi-code.json"]) {
      await rejectsWith(createKimiNativeStore(path).read(signal()), "unsafe_path");
    }
  });

  const unsafeFiles: ReadonlyArray<readonly [string, KimiErrorCode, (home: Home) => Promise<void>]> = [
    ["a group-readable file", "unsafe_path", (h) => chmod(h.file, 0o640)],
    ["a credentials folder that is not private", "unsafe_path", (h) => chmod(h.credentials, 0o750)],
    ["a symbolic link in place of the file", "unsafe_path", async (h) => {
      await rename(h.file, join(h.root, "real.json"));
      await symlink(join(h.root, "real.json"), h.file);
    }],
    ["a second hard link to the file", "unsafe_path", (h) => link(h.file, join(h.root, "second-link.json"))],
    ["a symbolic link in place of the credentials folder", "unsafe_path", async (h) => {
      await rename(h.credentials, join(h.root, "real"));
      await symlink(join(h.root, "real"), h.credentials);
    }],
    ["a file over 64 KiB", "invalid_record", (h) => writeFile(h.file, cliText({ ...record(), pad: "x".repeat(64 * 1024) }))],
    ["a home folder that other users can write", "unsafe_path", (h) => chmod(h.root, 0o777)],
  ];
  for (const [name, code, arrange] of unsafeFiles) {
    it(`refuses ${name} with ${code}`, async (t) => {
      const home = await kimiHome(t);
      await arrange(home);
      await rejectsWith(home.store.read(signal()), code);
    });
  }

  it("refuses a file or a folder that another user owns", async (t) => {
    const { file, credentials } = await kimiHome(t);
    const uid = process.getuid?.() ?? 0;
    for (const [path, rule] of [[file, "private-file"], [credentials, "private-folder"]] as const) {
      const stat = await lstat(path);
      assert.equal(isSafeNode(stat, rule, uid), true, `${rule}: the owner passes`);
      assert.equal(isSafeNode(stat, rule, uid + 1), false, `${rule}: another owner fails`);
    }
  });

  it("keeps a FAKE marker beside a bad character out of every failure", async (t) => {
    const { file, oauth, marker, store } = await kimiHome(t);
    await writeFile(file, '{"access_token":"FAKE-MARKER-7f3a\u0001');
    await mkdir(oauth, { mode: 0o700 });
    await writeFile(marker, '{"grant":"FAKE-MARKER-7f3a\u0001', { mode: 0o600 });
    const reads = [[() => store.read(signal()), "invalid_record"], [() => store.readMarker(signal()), "invalid_marker"]] as const;
    for (const [read, code] of reads) {
      await assert.rejects(read(), (error: unknown) => {
        assert.ok(error instanceof KimiNativeError);
        assert.equal(error.code, code);
        const seen = [String(error), JSON.stringify(error), error.stack ?? "", toKimiProxyError(error.code).message].join("\n");
        assert.doesNotMatch(seen, /FAKE-MARKER|\u0001/);
        return true;
      });
    }
  });

  const layouts: ReadonlyArray<readonly [string, unknown]> = [
    ["camelCase field names", { accessToken: "FAKE-access-0001", refreshToken: "FAKE-refresh-0001", expiresAt: nowSeconds() + 3600, tokenType: "Bearer" }],
    ["a record with no expires_in field", without(record(), "expires_in")],
    ["a record with no scope field", without(record(), "scope")],
    ["a record with no refresh_token field", without(record(), "refresh_token")],
    ["a nested record", { oauth: record() }],
    ["an expires_at text value", { ...record(), expires_at: String(nowSeconds() + 3600) }],
  ];
  for (const [name, value] of layouts) {
    it(`refuses ${name} with layout_unsupported`, async (t) => {
      const { file, store } = await kimiHome(t);
      await writeFile(file, cliText(value));
      await rejectsWith(store.read(signal()), "layout_unsupported");
    });
  }

  it("refuses a revoked CLI record with reauthorization_required", async (t) => {
    const { file, store } = await kimiHome(t);
    await writeFile(file, cliText({ ...record(), access_token: "", refresh_token: "", expires_at: 0, expires_in: 0 }));
    await rejectsWith(store.read(signal()), "reauthorization_required");
  });

  const badValues: ReadonlyArray<readonly [string, unknown]> = [
    ["a JSON array", [record()]],
    ["a token type other than Bearer", { ...record(), token_type: "bearer" }],
    ["an expires_at with a fraction", { ...record(), expires_at: nowSeconds() + 0.5 }],
    ["an access token with a space", { ...record(), access_token: "FAKE access" }],
    ["an empty refresh token beside an access token", { ...record(), refresh_token: "" }],
    ["a negative expires_in", { ...record(), expires_in: -1 }],
  ];
  for (const [name, value] of badValues) {
    it(`refuses ${name} with invalid_record`, async (t) => {
      const { file, store } = await kimiHome(t);
      await writeFile(file, cliText(value));
      await rejectsWith(store.read(signal()), "invalid_record");
    });
  }
});

describe("Kimi native store: CLI lock", () => {
  it("takes the CLI lock folder beside the lock target and removes only that folder on release", async (t) => {
    const { lock, sentinel, store } = await kimiHome(t);
    const inside = await store.withLease(signal(), async () => {
      const folder = await lstat(lock), target = await lstat(sentinel);
      return { folder: folder.isDirectory() && (folder.mode & 0o777) === 0o700, target: target.isFile() && target.size === 0 };
    });
    assert.deepEqual(inside, { folder: true, target: true });
    await assert.rejects(lstat(lock), { code: "ENOENT" });
    assert.ok((await lstat(sentinel)).isFile());
  });

  it("waits a bounded time and never takes a held CLI lock that its owner keeps fresh", async (t) => {
    const { oauth, lock, store } = await kimiHome(t);
    await mkdir(oauth, { mode: 0o700 });
    await mkdir(lock, { mode: 0o700 });
    const owner = await lstat(lock);
    const heartbeat = setInterval(() => {
      const now = new Date();
      void utimes(lock, now, now).catch(() => undefined);
    }, 500);
    t.after(() => clearInterval(heartbeat));
    let ran = false;
    const started = Date.now();
    await rejectsWith(store.withLease(signal(), async () => { ran = true; }), "lock_busy");
    clearInterval(heartbeat);
    assert.equal(ran, false);
    assert.ok(Date.now() - started < 7_000, "the lock wait is bounded");
    assert.equal((await lstat(lock)).ino, owner.ino, "the owner keeps its lock");
  });

  it("reclaims an empty lock folder older than the CLI stale bound", async (t) => {
    const home = await kimiHome(t);
    await staleLock(home);
    assert.equal(await home.store.withLease(signal(), async () => "ran"), "ran");
  });

  it("never removes a stale lock folder that is not empty", async (t) => {
    const home = await kimiHome(t);
    await staleLock(home);
    await writeFile(join(home.lock, "owned"), "FAKE-preserve");
    await rejectsWith(home.store.withLease(AbortSignal.timeout(400), async () => assert.fail("no lease")), "cancelled");
    assert.equal(await readFile(join(home.lock, "owned"), "utf8"), "FAKE-preserve");
  });

  for (const change of ["replaced by a successor", "renewed by its owner"] as const) {
    it(`never removes a stale-looking lock that is ${change} during the stale check`, async (t) => {
      const home = await kimiHome(t);
      await staleLock(home);
      let ran = false;
      const pending = home.store.withLease(signal(), async () => { ran = true; });
      await delay(30);
      if (change === "replaced by a successor") await takeOver(home.lock);
      else {
        const now = new Date();
        await utimes(home.lock, now, now);
      }
      const owner = await lstat(home.lock);
      await delay(250);
      assert.equal((await lstat(home.lock)).ino, owner.ino, "the new owner keeps its lock");
      assert.equal(ran, false);
      await rm(home.lock, { recursive: true });
      await pending;
      assert.equal(ran, true);
    });
  }

  it("lets two stale-lock contenders run their critical sections one at a time", async (t) => {
    const home = await kimiHome(t);
    await staleLock(home);
    let active = 0, peak = 0, completed = 0;
    const enter = () => home.store.withLease(signal(), async (lease) => {
      active++;
      peak = Math.max(peak, active);
      await delay(50);
      await lease.verify();
      active--;
      completed++;
    });
    await Promise.all([enter(), enter()]);
    assert.deepEqual({ peak, completed }, { peak: 1, completed: 2 });
  });

  it("keeps its own lock fresh with a heartbeat while the operation runs", async (t) => {
    const { lock, store } = await kimiHome(t);
    const seen = await store.withLease(signal(), async (lease) => {
      const first = await lstat(lock);
      await delay(2_800);
      const later = await lstat(lock);
      await lease.verify();
      return { sameLock: later.ino === first.ino, advancedMs: later.mtimeMs - first.mtimeMs };
    });
    assert.equal(seen.sameLock, true);
    assert.ok(seen.advancedMs >= 2_000, `the heartbeat moved the lock mtime (${seen.advancedMs} ms)`);
  });

  it("refuses the write-back after a takeover and leaves the successor lock in place", async (t) => {
    const { file, lock, store } = await kimiHome(t);
    const before = await readFile(file, "utf8");
    await rejectsWith(store.withLease(signal(), async (lease) => {
      const snapshot = await lease.read();
      await takeOver(lock);
      return lease.replace(snapshot, { ...snapshot.record, access_token: "FAKE-access-0002" });
    }), "lock_lost");
    assert.equal(await readFile(file, "utf8"), before);
    assert.ok((await lstat(lock)).isDirectory(), "the successor lock stays");
  });

  it("fails with changed when the sign-in folder is replaced under the lease", async (t) => {
    const { root, credentials, file, store } = await kimiHome(t);
    const text = await readFile(file, "utf8");
    await rejectsWith(store.withLease(signal(), async (lease) => {
      await rename(credentials, join(root, "moved"));
      await mkdir(credentials, { mode: 0o700 });
      await writeFile(file, text, { mode: 0o600 });
      await lease.verify();
    }), "changed");
  });

  it("aborts the lease signal when the heartbeat finds that another process took the lock", async (t) => {
    const { lock, store } = await kimiHome(t);
    const stop = new AbortController();
    const aborted = await store.withLease(signal(), async (lease) => {
      await takeOver(lock);
      if (!lease.signal.aborted) {
        await Promise.race([once(lease.signal, "abort"), delay(4_000, undefined, { signal: stop.signal }).catch(() => undefined)]);
      }
      stop.abort();
      return lease.signal.aborted;
    });
    assert.equal(aborted, true);
    assert.ok((await lstat(lock)).isDirectory(), "the successor lock stays");
  });

  it("checks the lock again after its last file read and before the rename", async (t) => {
    let lockPath = "";
    const { file, lock, store } = await kimiHome(t, { beforeCredentialCommit: () => takeOver(lockPath) });
    lockPath = lock;
    const before = await readFile(file, "utf8");
    await rejectsWith(store.withLease(signal(), async (lease) => {
      const snapshot = await lease.read();
      return lease.replace(snapshot, { ...snapshot.record, access_token: "FAKE-access-0002" });
    }), "lock_lost");
    assert.equal(await readFile(file, "utf8"), before);
    assert.ok((await lstat(lock)).isDirectory(), "the successor lock stays");
  });

  const lockLayouts: ReadonlyArray<readonly [string, (home: Home) => Promise<void>]> = [
    ["a lock path that is a file", async (h) => {
      await mkdir(h.oauth, { mode: 0o700 });
      await writeFile(h.lock, "", { mode: 0o600 });
    }],
    ["a lock target that is a folder", async (h) => {
      await mkdir(h.oauth, { mode: 0o700 });
      await mkdir(h.sentinel, { mode: 0o700 });
    }],
    ["a lock file of the legacy Kimi CLI beside the sign-in file", (h) => writeFile(join(h.credentials, `${SLOT}.lock`), "", { mode: 0o600 })],
  ];
  for (const [name, arrange] of lockLayouts) {
    it(`refuses ${name} with layout_unsupported`, async (t) => {
      const home = await kimiHome(t);
      await arrange(home);
      let ran = false;
      await rejectsWith(home.store.withLease(signal(), async () => { ran = true; }), "layout_unsupported");
      assert.equal(ran, false);
    });
  }

  const unsafeLocks: ReadonlyArray<readonly [string, (home: Home, target: string) => Promise<void>]> = [
    ["an oauth folder that is a symbolic link", async (h) => {
      await mkdir(join(h.root, "elsewhere"), { mode: 0o700 });
      await symlink(join(h.root, "elsewhere"), h.oauth);
    }],
    ["a lock target that is a symbolic link", async (h, target) => {
      await mkdir(h.oauth, { mode: 0o700 });
      await symlink(target, h.sentinel);
    }],
    ["a lock folder that is a symbolic link", async (h) => {
      await mkdir(h.oauth, { mode: 0o700 });
      await mkdir(join(h.root, "elsewhere"), { mode: 0o700 });
      await symlink(join(h.root, "elsewhere"), h.lock);
    }],
    ["an oauth folder that other users can write", async (h) => {
      await mkdir(h.oauth, { mode: 0o700 });
      await chmod(h.oauth, 0o777);
    }],
    ["a lock target that other users can write", async (h) => {
      await mkdir(h.oauth, { mode: 0o700 });
      await writeFile(h.sentinel, "", { mode: 0o600 });
      await chmod(h.sentinel, 0o666);
    }],
  ];
  for (const [name, arrange] of unsafeLocks) {
    it(`refuses ${name} with unsafe_path before any lock work`, async (t) => {
      const home = await kimiHome(t);
      const target = join(home.root, "unrelated");
      await writeFile(target, "FAKE-unrelated", { mode: 0o600 });
      await arrange(home, target);
      let ran = false;
      await rejectsWith(home.store.withLease(signal(), async () => { ran = true; }), "unsafe_path");
      assert.equal(ran, false);
      assert.equal(await readFile(target, "utf8"), "FAKE-unrelated");
    });
  }
});

describe("Kimi native store: renewal marker", () => {
  it("writes the prepared and the pending marker with mode 0600 and no token text", async (t) => {
    const { marker, store } = await kimiHome(t);
    const prepared = await store.withLease(signal(), async (lease) => {
      await lease.writeMarker(grant, "prepared", 1_000, 1);
      const seen = await lease.readMarker();
      await lease.writeMarker(grant, "pending");
      return seen;
    });
    assert.deepEqual(prepared, { grant, outcome: "prepared", retryAt: 1_000, failures: 1 });
    assert.deepEqual(await store.readMarker(signal()), { grant, outcome: "pending", retryAt: 0, failures: 1 });
    assert.equal((await lstat(marker)).mode & 0o777, 0o600);
    assert.doesNotMatch(await readFile(marker, "utf8"), /FAKE|Bearer|token/);
  });

  it("clears the marker under the lock", async (t) => {
    const { marker, store } = await kimiHome(t);
    await store.withLease(signal(), async (lease) => {
      await lease.clearMarker();
      await lease.writeMarker(grant, "pending");
      await lease.clearMarker();
    });
    assert.equal(await store.readMarker(signal()), undefined);
    await assert.rejects(lstat(marker), { code: "ENOENT" });
  });

  it("refuses a marker that is a symbolic link and leaves its target unchanged", async (t) => {
    const { root, oauth, marker, store } = await kimiHome(t);
    const target = join(root, "unrelated");
    await writeFile(target, "FAKE-unrelated", { mode: 0o600 });
    await mkdir(oauth, { mode: 0o700 });
    await symlink(target, marker);
    await rejectsWith(store.readMarker(signal()), "unsafe_path");
    await rejectsWith(store.withLease(signal(), (lease) => lease.writeMarker(grant, "pending")), "unsafe_path");
    await rejectsWith(store.withLease(signal(), (lease) => lease.clearMarker()), "unsafe_path");
    assert.equal(await readFile(target, "utf8"), "FAKE-unrelated");
  });

  const badMarkers: ReadonlyArray<readonly [string, unknown]> = [
    ["an unknown outcome", { version: 1, grant, outcome: "sent", retryAt: 0, failures: 1 }],
    ["a grant that is not a fingerprint", { version: 1, grant: "FAKE-refresh-0001", outcome: "pending", retryAt: 0, failures: 1 }],
    ["an unknown version", { version: 9, grant, outcome: "pending", retryAt: 0, failures: 1 }],
    ["a failure count over the bound", { version: 1, grant, outcome: "busy", retryAt: 0, failures: 6 }],
    ["a JSON array", [grant]],
  ];
  for (const [name, value] of badMarkers) {
    it(`refuses a marker with ${name} with invalid_marker`, async (t) => {
      const { oauth, marker, store } = await kimiHome(t);
      await mkdir(oauth, { mode: 0o700 });
      await writeFile(marker, cliText(value), { mode: 0o600 });
      await rejectsWith(store.readMarker(signal()), "invalid_marker");
    });
  }

  it("refuses to write a marker for a value that is not a fingerprint", async (t) => {
    const { store } = await kimiHome(t);
    await rejectsWith(store.withLease(signal(), (lease) => lease.writeMarker("FAKE-refresh-0001", "pending")), "invalid_marker");
  });
});

describe("Kimi native store: write-back", () => {
  it("writes back by rename in the CLI format with mode 0600 and leaves no temp file", async (t) => {
    const { credentials, file, store } = await kimiHome(t);
    const before = await lstat(file);
    const next = { ...record("FAKE-access-0002"), refresh_token: "FAKE-refresh-0002" };
    assert.equal(await store.withLease(signal(), async (lease) => lease.replace(await lease.read(), next)), true);
    assert.equal(await readFile(file, "utf8"), cliText(next));
    const after = await lstat(file);
    assert.equal(after.mode & 0o777, 0o600);
    assert.notEqual(after.ino, before.ino, "a rename, not a write in place");
    assert.deepEqual(await readdir(credentials), [`${SLOT}.json`]);
    assert.equal((await store.read(signal())).record["custom"], "kept");
  });

  it("refuses to replace a file that the Kimi CLI changed, so the caller can adopt the rotation", async (t) => {
    const { file, store } = await kimiHome(t);
    const peer = cliText(record("FAKE-peer-0001"));
    const saved = await store.withLease(signal(), async (lease) => {
      const before = await lease.read();
      await writeFile(`${file}.peer`, peer, { mode: 0o600 });
      await rename(`${file}.peer`, file);
      return lease.replace(before, { ...before.record, access_token: "FAKE-unwanted-0001" });
    });
    assert.equal(saved, false);
    assert.equal(await readFile(file, "utf8"), peer);
  });

  const unsafeRecords: ReadonlyArray<readonly [string, KimiErrorCode, (value: ReturnType<typeof record>) => Record<string, unknown>]> = [
    ["an empty access token", "invalid_record", (value) => ({ ...value, access_token: "" })],
    ["an access token with a line break", "invalid_record", (value) => ({ ...value, access_token: "FAKE\naccess" })],
    ["a record with no expires_in field", "layout_unsupported", (value) => without(value, "expires_in")],
  ];
  for (const [name, code, change] of unsafeRecords) {
    it(`refuses to write ${name} and keeps the file`, async (t) => {
      const { file, store } = await kimiHome(t);
      const before = await readFile(file, "utf8");
      await rejectsWith(store.withLease(signal(), async (lease) => {
        const snapshot = await lease.read();
        return lease.replace(snapshot, change(record()) as typeof snapshot.record);
      }), code);
      assert.equal(await readFile(file, "utf8"), before);
    });
  }

  it("passes a typed failure out of the lease and turns any other failure into unavailable", async (t) => {
    const { store } = await kimiHome(t);
    await rejectsWith(store.withLease(signal(), async () => { throw new KimiNativeError("refresh_busy"); }), "refresh_busy");
    await assert.rejects(store.withLease(signal(), async () => {
      throw new Error("FAKE-secret at /fixture/credentials/kimi-code.json");
    }), (error: unknown) => {
      assert.ok(error instanceof KimiNativeError);
      assert.equal(error.code, "unavailable");
      assert.doesNotMatch(`${String(error)} ${JSON.stringify(error)}`, /FAKE|fixture/);
      return true;
    });
  });
});
