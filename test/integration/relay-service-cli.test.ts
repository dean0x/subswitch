import assert from "node:assert/strict";
import { access, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { before, it } from "node:test";
import { cliChildFolders, readExecLog, runCliChild } from "../helpers/cli-child.js";

// Fill the tsx cache on the host platform so esbuild uses the installed binary.
before(async () => {
  const folders = await cliChildFolders();
  try {
    const result = await runCliChild(folders, ["--version"]);
    assert.equal(result.code, 0, result.stderr);
  } finally {
    await rm(folders.home, { recursive: true, force: true });
  }
});

const serviceEnv = (platform: "darwin" | "linux", uid?: number) => ({ NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(`
  Object.defineProperty(process, "platform", { value: ${JSON.stringify(platform)} });
  ${uid === undefined ? "delete process.getuid;" : `process.getuid = () => ${uid};`}
`)}` });

it("reads the selected service config on macOS but not on Linux", async (t) => {
  const folders = await cliChildFolders();
  t.after(() => rm(folders.home, { recursive: true, force: true }));
  const dir = join(folders.home, "config");
  const file = join(dir, "selected.json");
  await mkdir(dir);
  await writeFile(file, "{", { mode: 0o600 });
  const { uid } = await stat(file);
  const args = ["service", "install", "--port", "23123", "--config", file];
  for (const platform of ["linux", "darwin"] as const) {
    const result = await runCliChild(folders, args, { env: serviceEnv(platform, uid), recordFsUnder: dir });
    assert.equal(result.code, 1);
    assert.match(result.stderr, platform === "linux" ? /launchd on macOS/ : /malformed JSON/);
    const calls = await readExecLog(folders);
    assert.deepEqual(calls.filter((line) => line !== "preload"), platform === "linux" ? [] : [`fs.openSync ${file}`]);
  }
});

for (const [args, message] of [
  [["service"], /service requires install or uninstall/],
  [["service", "unknown"], /service requires install or uninstall/],
  [["service", "install", "extra"], /service requires install or uninstall/],
  [["service", "uninstall", "extra"], /service requires install or uninstall/],
  [["service", "uninstall", "--port", "23123"], /flag '--port' is not valid/],
  [["service", "uninstall", "--config", "test.json"], /flag '--config' is not valid/],
  [["service", "install", "--detach"], /flag '--detach' is not valid/],
  [["serve", "--port", "0", "--config", "test.json"], /flag '--config' is not valid/],
] as const) {
  it(`refuses ${args.join(" ")}`, async (t) => {
    const folders = await cliChildFolders();
    t.after(() => rm(folders.home, { recursive: true, force: true }));
    const result = await runCliChild(folders, args, { env: serviceEnv("linux") });
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, message);
    assert.deepEqual(await readExecLog(folders), ["preload"]);
  });
}

for (const platform of ["linux", "darwin"] as const) {
  for (const action of ["install", "uninstall"] as const) {
    it(`refuses service ${action} ${platform === "linux" ? "outside macOS" : "without a user ID"}`, async (t) => {
      const folders = await cliChildFolders();
      t.after(() => rm(folders.home, { recursive: true, force: true }));
      const args = action === "install" ? ["--port", "23123", "--config", folders.configFile] : [];
      const result = await runCliChild(folders, ["service", action, ...args], { env: serviceEnv(platform) });
      assert.equal(result.code, 1, result.stderr);
      assert.match(result.stderr, platform === "linux" ? /the service needs launchd on macOS/ : /the service needs a user ID/);
      await assert.rejects(access(join(folders.home, "Library")), { code: "ENOENT" });
      await assert.rejects(access(join(folders.home, ".cache")), { code: "ENOENT" });
      assert.deepEqual(await readExecLog(folders), ["preload"]);
    });
  }
}
