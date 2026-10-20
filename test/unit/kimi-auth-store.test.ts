/** Entirely synthetic, isolated storage fixtures. No native credentials or network. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it } from "node:test";
import { createKimiAuthStore, type KimiAuthRecord } from "../../src/kimi-auth-store.js";

const signal = () => new AbortController().signal;
const fabricated = (revision = randomUUID()): KimiAuthRecord => ({
  version: 1, revision, generation: randomUUID(), region: "global", deviceId: "synthetic-device",
  tokens: { access_token: "synthetic-access", refresh_token: "synthetic-refresh", expires_at: 1_900_000_000, token_type: "Bearer" },
});
async function fixture(run: (directory: string, authFile: string) => Promise<void>): Promise<void> {
  // Canonicalize the test temp base explicitly: the store itself rejects aliases.
  const directory = await mkdtemp(join(await realpath(tmpdir()), "subswitch-kimi-store-"));
  try { await run(directory, join(directory, "owned", "auth.json")); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
async function seed(authFile: string, value = fabricated()) {
  const store = createKimiAuthStore(authFile);
  await store.write(value, signal());
  return { store, value };
}

describe("owned Kimi credential store", () => {
  it("requires an explicit normalized absolute file and does not discover a home", () => {
    for (const path of ["auth.json", "~/auth.json", "/", "/synthetic/../auth.json", "/synthetic/auth.json\0secret"]) {
      assert.throws(() => createKimiAuthStore(path), /kimi_auth_store_invalid_path/);
    }
  });

  it("reports missing read-only state without creating the directory or lock", async () => fixture(async (directory, authFile) => {
    const store = createKimiAuthStore(authFile);
    await assert.rejects(store.read(signal()), /kimi_auth_store_missing/);
    assert.deepEqual(await readdir(directory), []);
  }));

  it("creates private owned storage, round-trips epoch seconds, and refuses relogin overwrite", async () => fixture(async (directory, authFile) => {
    const { store, value } = await seed(authFile);
    assert.deepEqual(await store.read(signal()), value);
    if (process.platform !== "win32") {
      assert.equal((await lstat(join(directory, "owned"))).mode & 0o7777, 0o700);
      assert.equal((await lstat(authFile)).mode & 0o7777, 0o600);
    }
    await assert.rejects(store.withLock(() => store.write(fabricated(), signal()), signal()), /kimi_auth_store_exists/);
    assert.deepEqual(await store.read(signal()), value);
    assert.deepEqual(await readdir(join(directory, "owned")), ["auth.json"]);
  }));

  it("validates read, write and CAS records without leaking invalid payloads", async () => fixture(async (_directory, authFile) => {
    const { store, value } = await seed(authFile);
    const invalid = { ...value, tokens: { ...value.tokens, expires_at: 1_900_000_000_000 } };
    await assert.rejects(store.write(invalid, signal()), /kimi_auth_store_invalid_record/);
    const oversized = { ...value, tokens: { ...value.tokens, access_token: "😀".repeat(8192), refresh_token: "😀".repeat(8192) } };
    await assert.rejects(store.write(oversized, signal()), /kimi_auth_store_invalid_record/);
    await store.withLock(async () => {
      await store.read(signal());
      await assert.rejects(store.compareAndSwap(value.revision, invalid, signal()), /kimi_auth_store_invalid_record/);
    }, signal());
    assert.deepEqual(await store.read(signal()), value);
    await writeFile(authFile, "synthetic-access synthetic-refresh malformed JSON", { mode: 0o600 });
    await assert.rejects(store.read(signal()), error => {
      assert.equal((error as Error).message, "kimi_auth_store_io");
      assert.equal((error as Error).cause, undefined);
      return true;
    });
    await writeFile(authFile, JSON.stringify({ ...value, generation: "not-a-lineage-uuid" }));
    await assert.rejects(store.read(signal()), /kimi_auth_store_invalid_record/);
  }));

  it("requires a lock and a read in that lock before CAS, then rotates atomically", async () => fixture(async (_directory, authFile) => {
    const { store, value } = await seed(authFile);
    const next = { ...value, revision: randomUUID(), tokens: { ...value.tokens, access_token: "synthetic-next", refresh_token: "synthetic-next-refresh" } };
    await assert.rejects(store.compareAndSwap(value.revision, next, signal()), /kimi_auth_store_lock_required/);
    await store.read(signal());
    await store.withLock(async () => {
      assert.equal(await store.compareAndSwap(value.revision, next, signal()), false);
      await store.read(signal());
      assert.equal(await store.compareAndSwap("stale", next, signal()), false);
      assert.equal(await store.compareAndSwap(value.revision, next, signal()), true);
      assert.equal(await store.compareAndSwap(value.revision, next, signal()), false);
    }, signal());
    assert.deepEqual(await store.read(signal()), next);
    assert.deepEqual(await readdir(join(authFile, "..")), ["auth.json"]);
  }));

  it("does not let caller mutation redefine the observed login lineage", async () => fixture(async (_directory, authFile) => {
    const { store, value } = await seed(authFile);
    await store.withLock(async () => {
      const observed = await store.read(signal());
      observed.generation = randomUUID();
      await assert.rejects(store.compareAndSwap(value.revision, { ...observed, revision: randomUUID() }, signal()), /kimi_auth_store_changed/);
      for (const next of [
        { ...value, revision: randomUUID(), region: "mainland-cn" as const },
        { ...value, revision: randomUUID(), deviceId: "other-device" },
        value,
      ]) await assert.rejects(store.compareAndSwap(value.revision, next, signal()), /kimi_auth_store_changed/);
    }, signal());
    assert.deepEqual(await store.read(signal()), value);
  }));

  it("rejects replacement inodes and changed generation/revision even if a writer ignores the lock", async () => fixture(async (_directory, authFile) => {
    const { store, value } = await seed(authFile);
    const next = { ...value, revision: randomUUID() };
    await store.withLock(async () => {
      await store.read(signal());
      const replacement = `${authFile}.replacement`;
      await writeFile(replacement, JSON.stringify(value), { mode: 0o600 });
      await rename(replacement, authFile);
      assert.equal(await store.compareAndSwap(value.revision, next, signal()), false);
      await store.read(signal());
      const newerLogin = { ...value, generation: randomUUID(), revision: randomUUID() };
      await writeFile(authFile, JSON.stringify(newerLogin));
      assert.equal(await store.compareAndSwap(value.revision, next, signal()), false);
      assert.deepEqual(await store.read(signal()), newerLogin);
    }, signal());
  }));

  it("detects an owned directory replacement instead of following the new store", async () => fixture(async (directory, authFile) => {
    const { store } = await seed(authFile);
    await rename(join(directory, "owned"), join(directory, "old"));
    await mkdir(join(directory, "owned"), { mode: 0o700 });
    await writeFile(authFile, JSON.stringify(fabricated()), { mode: 0o600 });
    await assert.rejects(store.read(signal()), /kimi_auth_store_changed/);
    await assert.rejects(store.write(fabricated(), signal()), /kimi_auth_store_changed/);
  }));

  it("rejects symlink ancestors, auth files and locks without changing their targets", async () => fixture(async (directory, authFile) => {
    const { value } = await seed(authFile);
    const alias = join(directory, "alias");
    await symlink(join(directory, "owned"), alias);
    await assert.rejects(createKimiAuthStore(join(alias, "auth.json")).read(signal()), /kimi_auth_store_unsafe_path/);
    const target = join(directory, "target.json");
    await writeFile(target, JSON.stringify(value), { mode: 0o600 });
    await rm(authFile);
    await symlink(target, authFile);
    const store = createKimiAuthStore(authFile);
    await assert.rejects(store.read(signal()), /kimi_auth_store_unsafe_path/);
    await assert.rejects(store.write(fabricated(), signal()), /kimi_auth_store_unsafe_path/);
    await symlink(target, `${authFile}.lock`);
    await assert.rejects(store.withLock(async () => undefined, signal()), /kimi_auth_store_unsafe_path/);
    assert.deepEqual(JSON.parse(await readFile(target, "utf8")), value);
    assert.equal((await lstat(`${authFile}.lock`)).isSymbolicLink(), true);
  }));

  it("rejects hard-linked credentials", async () => fixture(async (directory, authFile) => {
    const { store } = await seed(authFile);
    await link(authFile, join(directory, "extra-link"));
    await assert.rejects(store.read(signal()), /kimi_auth_store_unsafe_path/);
  }));

  it("rejects ownership outside the current uid", { skip: process.platform === "win32" || !process.getuid }, async t => fixture(async (_directory, authFile) => {
    await seed(authFile);
    const uid = process.getuid!();
    // Simulate a reader with another uid; no ownership of ambient paths changes.
    const mocked = t.mock.method(process as { getuid(): number }, "getuid", () => uid + 1);
    try { await assert.rejects(createKimiAuthStore(authFile).read(signal()), /kimi_auth_store_unsafe_path/); }
    finally { mocked.mock.restore(); }
  }));

  it("rejects lock replacement and never unlinks the replacement holder", async () => fixture(async (_directory, authFile) => {
    const { store, value } = await seed(authFile);
    await store.withLock(async () => {
      await store.read(signal());
      await rename(`${authFile}.lock`, `${authFile}.old-lock`);
      await writeFile(`${authFile}.lock`, "synthetic-new-holder", { mode: 0o600 });
      await assert.rejects(store.compareAndSwap(value.revision, { ...value, revision: randomUUID() }, signal()), /kimi_auth_store_changed/);
    }, signal());
    assert.equal(await readFile(`${authFile}.lock`, "utf8"), "synthetic-new-holder");
    assert.deepEqual(await store.read(signal()), value);
  }));

  it("preserves the old record when a locked refresh is cancelled", async () => fixture(async (_directory, authFile) => {
    const { store, value } = await seed(authFile);
    const abort = new AbortController();
    await store.withLock(async () => {
      await store.read(signal());
      abort.abort("synthetic-refresh-secret");
      await assert.rejects(store.compareAndSwap(value.revision, { ...value, revision: randomUUID() }, abort.signal), { name: "AbortError" });
    }, signal());
    assert.deepEqual(await store.read(signal()), value);
    assert.deepEqual(await readdir(join(authFile, "..")), ["auth.json"]);
  }));

  it("rejects permissive directories, credentials and locks without chmod repair", { skip: process.platform === "win32" }, async () => fixture(async (directory, authFile) => {
    const { store } = await seed(authFile);
    await chmod(join(directory, "owned"), 0o755);
    await assert.rejects(store.read(signal()), /kimi_auth_store_unsafe_path/);
    assert.equal((await lstat(join(directory, "owned"))).mode & 0o777, 0o755);
    await chmod(join(directory, "owned"), 0o700);
    await chmod(authFile, 0o644);
    await assert.rejects(store.read(signal()), /kimi_auth_store_unsafe_path/);
    assert.equal((await lstat(authFile)).mode & 0o777, 0o644);
    await chmod(authFile, 0o600);
    await writeFile(`${authFile}.lock`, "", { mode: 0o644 });
    await assert.rejects(store.withLock(async () => undefined, signal()), /kimi_auth_store_unsafe_path/);
    assert.equal((await lstat(`${authFile}.lock`)).mode & 0o777, 0o644);
  }));

  it("checks literal backslash directory names on POSIX without treating them as separators", { skip: process.platform === "win32" }, async () => fixture(async (directory) => {
    const owned = join(directory, "permissive\\name");
    await mkdir(owned, { mode: 0o755 });
    await assert.rejects(createKimiAuthStore(join(owned, "auth.json")).write(fabricated(), signal()), /kimi_auth_store_unsafe_path/);
    assert.deepEqual(await readdir(owned), []);
  }));

  it("honors cancellation without exposing the signal reason or removing another lock", async () => fixture(async (_directory, authFile) => {
    const { store, value } = await seed(authFile);
    await writeFile(`${authFile}.lock`, "synthetic-holder", { mode: 0o600 });
    const abort = new AbortController();
    const waiting = store.withLock(async () => assert.fail("acquired another process's lock"), abort.signal);
    const rejected = assert.rejects(waiting, error => {
      assert.equal((error as Error).name, "AbortError");
      assert.equal((error as Error).message, "kimi_auth_store_cancelled");
      return true;
    });
    abort.abort(new Error("synthetic-refresh-secret"));
    await rejected;
    assert.equal(await readFile(`${authFile}.lock`, "utf8"), "synthetic-holder");
    assert.deepEqual(await store.read(signal()), value);
    await assert.rejects(store.write(fabricated(), abort.signal), { name: "AbortError" });
  }));

  it("never takes over a stale-looking lock and has a finite wait", async () => fixture(async (_directory, authFile) => {
    const { store } = await seed(authFile);
    await writeFile(`${authFile}.lock`, "", { mode: 0o600 });
    const started = performance.now();
    await assert.rejects(store.withLock(async () => assert.fail("stale takeover"), signal()), /kimi_auth_store_lock_timeout/);
    assert.ok(performance.now() - started < 7_000);
    assert.equal(await readFile(`${authFile}.lock`, "utf8"), "");
  }));

  it("sanitizes operation errors, releases its lock, and rejects detached lock contexts", async () => fixture(async (_directory, authFile) => {
    const { store, value } = await seed(authFile);
    await assert.rejects(store.withLock(async () => { throw new Error("synthetic-access synthetic-refresh"); }, signal()), { message: "kimi_auth_store_io" });
    let detached!: Promise<void>;
    let release!: () => void;
    const proceed = new Promise<void>(resolve => { release = resolve; });
    await store.withLock(async () => {
      await store.read(signal());
      detached = (async () => {
        await proceed;
        await assert.rejects(store.compareAndSwap(value.revision, { ...value, revision: randomUUID() }, signal()), /kimi_auth_store_lock_required/);
      })();
    }, signal());
    release(); await detached;
    assert.deepEqual(await store.read(signal()), value);
    assert.deepEqual(await readdir(join(authFile, "..")), ["auth.json"]);
  }));

  it("serializes independent processes and lets the second observe the first committed revision", async () => fixture(async (_directory, authFile) => {
    const { store, value } = await seed(authFile);
    const moduleUrl = new URL("../../src/kimi-auth-store.ts", import.meta.url).href;
    const script = `import { createKimiAuthStore } from ${JSON.stringify(moduleUrl)};
      const store = createKimiAuthStore(${JSON.stringify(authFile)});
      await store.withLock(async () => {
        const current = await store.read(new AbortController().signal);
        process.stdout.write('locked\\n');
        await new Promise(resolve => process.stdin.once('data', resolve));
        await store.compareAndSwap(current.revision, { ...current, revision: 'child-revision' }, new AbortController().signal);
      }, new AbortController().signal);`;
    // Supported by the project's Node >=22.15 engine; no installed CLI or child
    // dependency resolution is involved in this cross-process storage check.
    const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { stdio: ["pipe", "pipe", "pipe"] });
    const exited = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("synthetic child did not lock")), 3_000);
        child.stdout.once("data", () => { clearTimeout(timer); resolve(); });
        exited.then(() => { clearTimeout(timer); reject(new Error("synthetic child exited before lock")); }, reject);
      });
      let entered = false;
      const waiting = store.withLock(async () => {
        entered = true;
        const current = await store.read(signal());
        assert.equal(current.revision, "child-revision");
      }, signal());
      await delay(50); assert.equal(entered, false);
      assert.equal((await store.read(signal())).revision, value.revision);
      child.stdin.end("release\n");
      await waiting;
      assert.equal(await exited, 0);
    } finally {
      child.kill();
      await exited;
    }
  }));
});
