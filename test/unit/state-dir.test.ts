import assert from "node:assert/strict";
import { access, chmod, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { err, ok } from "../../src/result.js";
import { subswitchStateDir } from "../../src/routing/state-dir.js";

/** A fresh root with a home folder and a cache folder path in it. Every test names its own folders. */
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "subswitch-state-dir-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  await mkdir(home);
  return { root, home, cacheHome: join(root, "cache"), defaultPath: join(home, ".cache", "subswitch") };
}

const modeOf = async (path: string): Promise<number> => (await lstat(path)).mode & 0o777;

it("makes the private state folder under an absolute XDG_CACHE_HOME", async (t) => {
  const { home, cacheHome } = await fixture(t);
  const path = join(cacheHome, "subswitch");
  assert.deepEqual(await subswitchStateDir({ XDG_CACHE_HOME: cacheHome }, home), ok(path));
  assert.equal(await modeOf(path), 0o700);
});

for (const [label, env] of [["unset", {}], ["empty", { XDG_CACHE_HOME: "" }], ["relative", { XDG_CACHE_HOME: "cache" }]] as const) {
  it(`makes the private state folder under <home>/.cache when XDG_CACHE_HOME is ${label}`, async (t) => {
    const { home, defaultPath } = await fixture(t);
    assert.deepEqual(await subswitchStateDir(env, home), ok(defaultPath));
    assert.equal(await modeOf(defaultPath), 0o700);
  });
}

it("accepts an existing private state folder", async (t) => {
  const { home, defaultPath } = await fixture(t);
  await mkdir(defaultPath, { recursive: true, mode: 0o700 });
  assert.deepEqual(await subswitchStateDir({}, home), ok(defaultPath));
});

for (const mode of [0o750, 0o705, 0o755]) {
  it(`refuses a state folder with mode ${mode.toString(8)}`, async (t) => {
    const { home, defaultPath } = await fixture(t);
    await mkdir(defaultPath, { recursive: true, mode: 0o700 });
    await chmod(defaultPath, mode);
    assert.deepEqual(await subswitchStateDir({}, home), err("state_folder_not_private"));
  });
}

it("refuses a state folder owned by another user", async (t) => {
  const { home, defaultPath } = await fixture(t);
  await mkdir(defaultPath, { recursive: true, mode: 0o700 });
  const { uid } = await lstat(defaultPath);
  t.mock.method(process, "getuid", () => uid + 1, {});
  assert.deepEqual(await subswitchStateDir({}, home), err("state_folder_not_private"));
});

it("refuses a symbolic link to a private folder in place of the state folder", async (t) => {
  const { root, home, defaultPath } = await fixture(t);
  const target = join(root, "target");
  await mkdir(target, { mode: 0o700 });
  await mkdir(join(defaultPath, ".."), { recursive: true });
  await symlink(target, defaultPath);
  assert.deepEqual(await subswitchStateDir({}, home), err("state_folder_not_private"));
});

it("fails closed when a file is in place of the state folder", async (t) => {
  const { home, defaultPath } = await fixture(t);
  await mkdir(join(defaultPath, ".."), { recursive: true });
  await writeFile(defaultPath, "not a folder", { mode: 0o600 });
  assert.deepEqual(await subswitchStateDir({}, home), err("state_folder_unavailable"));
});

it("fails closed for a relative home and makes no folder", async (t) => {
  const { root } = await fixture(t);
  // A relative home would resolve against the working folder, so run in the fresh root.
  const previous = process.cwd();
  process.chdir(root);
  t.after(() => process.chdir(previous));
  assert.deepEqual(await subswitchStateDir({}, "relative-home"), err("state_folder_unavailable"));
  await assert.rejects(access(join(root, "relative-home")), { code: "ENOENT" });
});
