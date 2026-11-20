/**
 * Tests for the test-process controls that keep a CLI child away from real stores:
 * the shared CLI-child helper and the exec-deny preload.
 */
import { describe, it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cliChildCommand, cliChildFolders, readExecLog, runCliChild } from "../helpers/cli-child.js";

const PRELOAD = new URL("../helpers/deny-exec-file.ts", import.meta.url).href;
const ATTEMPTS = fileURLToPath(new URL("../fixtures/child-process-attempts.ts", import.meta.url));
const DENIED = ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "fork"] as const;

/**
 * Run the attempts fixture, with or without the preload, and return its results and the
 * preload log. With `allowArgs` the preload runs in allow-list mode for those arguments.
 */
const runAttempts = async (t: TestContext, preload: boolean, allowArgs?: readonly string[]) => {
  const folder = await mkdtemp(join(tmpdir(), "subswitch-deny-preload-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const log = join(folder, "exec.log");
  const allow = allowArgs === undefined ? {} : { SUBSWITCH_TEST_EXEC_ALLOW: JSON.stringify(allowArgs) };
  const mode = allowArgs === undefined ? [] : ["allow-list"];
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(process.execPath, ["--import", import.meta.resolve("tsx"), ...(preload ? ["--import", PRELOAD] : []), ATTEMPTS, ...mode],
      { cwd: folder, env: { PATH: process.env["PATH"], SUBSWITCH_TEST_EXEC_LOG: log, ...allow }, timeout: 20_000 },
      (error, out) => (error === null ? resolve(out) : reject(error)));
  });
  const results: unknown = JSON.parse(stdout);
  return { results, log: preload ? await readFile(log, "utf8") : "" };
};

const freshFolders = async (t: TestContext) => {
  const folders = await cliChildFolders();
  t.after(() => rm(folders.home, { recursive: true, force: true }));
  return folders;
};

/** The value of a doctor row such as "config:". */
const doctorRow = (stdout: string, label: string): string | undefined =>
  stdout.split("\n").map((line) => line.trim()).find((line) => line.startsWith(`${label} `))?.slice(label.length).trim();

describe("CLI child helper", () => {
  it("gives the child the fresh folders, the preload and only the named parent variables", async (t) => {
    const sentinel = "SUBSWITCH_CLI_CHILD_SENTINEL";
    process.env[sentinel] = "parent value";
    t.after(() => { delete process.env[sentinel]; });
    const folders = await freshFolders(t);
    const command = cliChildCommand(folders, ["models"], { env: { NO_COLOR: "1" } });
    assert.equal(command.env["HOME"], folders.home);
    assert.equal(command.env["XDG_CONFIG_HOME"], join(folders.home, ".config"));
    assert.equal(command.env["XDG_CACHE_HOME"], join(folders.home, ".cache"));
    assert.equal(command.env["SUBSWITCH_CONFIG"], folders.configFile);
    assert.equal(await readFile(folders.configFile, "utf8"), "{}");
    assert.equal(command.env["NO_COLOR"], "1");
    assert.equal(command.env[sentinel], undefined, "the child must not copy the parent env");
    assert.equal(command.cwd, folders.home);
    assert.deepEqual(command.args.slice(0, 4), ["--import", import.meta.resolve("tsx"), "--import", PRELOAD]);
    assert.equal(command.args.at(-1), "models");
    assert.equal(command.env["SUBSWITCH_TEST_EXEC_LOG"], folders.execLog);
    assert.equal(command.env["SUBSWITCH_TEST_EXEC_ALLOW"], undefined);
  });

  it("keeps the preload and names the one allowed command in allow-list mode", async (t) => {
    const folders = await freshFolders(t);
    const command = cliChildCommand(folders, ["models"], { allowNodeArgs: ["--version"] });
    assert.deepEqual(command.args.slice(0, 4), ["--import", import.meta.resolve("tsx"), "--import", PRELOAD]);
    assert.equal(command.env["SUBSWITCH_TEST_EXEC_LOG"], folders.execLog);
    assert.equal(command.env["SUBSWITCH_TEST_EXEC_ALLOW"], '["--version"]');
  });

  it("refuses a test env that sets a folder variable or a config file outside the folder", async (t) => {
    const folders = await freshFolders(t);
    for (const name of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "SUBSWITCH_TEST_EXEC_LOG", "SUBSWITCH_TEST_EXEC_ALLOW"]) {
      assert.throws(() => cliChildCommand(folders, ["models"], { env: { [name]: folders.home } }), new RegExp(name));
    }
    assert.throws(() => cliChildCommand(folders, ["models"], { env: { SUBSWITCH_CONFIG: join(tmpdir(), "config.json") } }),
      /SUBSWITCH_CONFIG/);
    assert.equal(cliChildCommand(folders, ["models"], { env: { SUBSWITCH_CONFIG: "" } }).env["SUBSWITCH_CONFIG"], "");
  });

  it("runs doctor with the fresh folders and refuses its Keychain call", { timeout: 30_000 }, async (t) => {
    const folders = await freshFolders(t);
    const result = await runCliChild(folders, ["doctor"], { env: { NO_COLOR: "1" } });
    assert.equal(doctorRow(result.stdout, "config:"), folders.configFile, result.stdout + result.stderr);
    assert.equal(doctorRow(result.stdout, "codex.authFile:"), join(folders.home, ".codex", "auth.json"));
    const log = await readExecLog(folders);
    assert.equal(log[0], "preload");
    // On macOS the doctor looks for the Together key in the Keychain; the preload refuses it.
    if (process.platform === "darwin") assert.deepEqual(log.slice(1), ["execFile /usr/bin/security"]);
  });

  it("reads the user configuration from the fresh XDG_CONFIG_HOME when SUBSWITCH_CONFIG is empty", { timeout: 30_000 }, async (t) => {
    const folders = await freshFolders(t);
    const userConfig = join(folders.configHome, "subswitch", "config.json");
    await mkdir(join(userConfig, ".."), { recursive: true });
    await writeFile(userConfig, "{}");
    const result = await runCliChild(folders, ["doctor"], { env: { NO_COLOR: "1", SUBSWITCH_CONFIG: "" } });
    assert.equal(doctorRow(result.stdout, "config:"), userConfig, result.stdout + result.stderr);
  });
});

describe("exec-deny preload", () => {
  it("refuses and logs each child_process function that can start a program", { timeout: 30_000 }, async (t) => {
    const { results, log } = await runAttempts(t, true);
    assert.deepEqual(results, Object.fromEntries(DENIED.map((name) => [name, "refused"])));
    const lines = log.split("\n").filter((line) => line !== "");
    // "preload" first is the positive control that the preload ran in the child.
    assert.deepEqual(lines.map((line) => line.split(" ")[0]), ["preload", ...DENIED]);
  });

  it("in allow-list mode starts only this Node binary with the named arguments, and refuses and logs the rest", { timeout: 30_000 }, async (t) => {
    const { results, log } = await runAttempts(t, true, ["--version"]);
    assert.deepEqual(results, {
      spawn: "started", spawnSync: "started", execFile: "started", execFileSync: "started",
      exec: "refused", execSync: "refused", fork: "refused", "spawn other arguments": "refused", "spawn other program": "refused",
    });
    const node = process.execPath;
    assert.deepEqual(log.split("\n").filter((line) => line !== ""), [
      "preload",
      `allowed spawn ${node}`, `allowed spawnSync ${node}`, `allowed execFile ${node}`, `allowed execFileSync ${node}`,
      `exec "${node}" --version`, `execSync "${node}" --version`, `fork ${ATTEMPTS}`, `spawn ${node}`, "spawn /bin/sh",
    ]);
  });

  it("lets the same calls start a program without the preload (positive control)", { timeout: 30_000 }, async (t) => {
    const { results } = await runAttempts(t, false);
    assert.deepEqual(results, Object.fromEntries(DENIED.map((name) => [name, "started"])));
  });
});
