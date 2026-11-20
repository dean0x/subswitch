/**
 * Kimi through the CLI child. Without the block, the doctor Kimi row makes no file call
 * under the Kimi home; with it, doctor reads the file through the store. The models
 * commands list the Kimi ids. Each child has a fresh HOME below the resolved temporary
 * root, so the Kimi home is a fabricated folder. The doctor config keeps every probe on
 * the loopback host.
 */
import { describe, it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { KIMI_REGION_TABLE } from "../../src/kimi-constants.js";
import { KIMI_MODELS } from "../../src/kimi-models.js";
import { cliChildFolders, offlineDoctorConfig, readExecLog, runCliChild } from "../helpers/cli-child.js";

const SLOT = KIMI_REGION_TABLE.global.credentialFile;

/** A CLI child folder set with a valid Kimi sign-in file in the default Kimi home. */
const kimiChild = async (t: TestContext) => {
  const folders = await cliChildFolders({ resolveTemp: true });
  t.after(() => rm(folders.home, { recursive: true, force: true }));
  const kimiHome = join(folders.home, ".kimi-code");
  await mkdir(join(kimiHome, "credentials"), { recursive: true, mode: 0o700 });
  const authFile = join(kimiHome, "credentials", SLOT);
  const record = {
    access_token: "FAKE-KIMI-CLI-ACCESS-0001", refresh_token: "FAKE-KIMI-CLI-REFRESH-0001",
    expires_at: Math.floor(Date.now() / 1000) + 3600, scope: "kimi-code", token_type: "Bearer", expires_in: 3600,
  };
  await writeFile(authFile, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  return { folders, kimiHome, authFile };
};

/** The value of a doctor row such as "kimi auth:". */
const doctorRow = (stdout: string, label: string): string | undefined =>
  stdout.split("\n").map((line) => line.trim()).find((line) => line.startsWith(`${label} `))?.slice(label.length).trim();

describe("CLI doctor Kimi row", () => {
  it("without the block, makes no file call under the Kimi home", { timeout: 30_000 }, async (t) => {
    const { folders, kimiHome } = await kimiChild(t);
    await writeFile(folders.configFile, JSON.stringify(await offlineDoctorConfig()));
    const result = await runCliChild(folders, ["doctor"], { env: { NO_COLOR: "1" }, recordFsUnder: kimiHome });
    assert.match(doctorRow(result.stdout, "kimi auth:") ?? "", /^not turned on /, result.stdout + result.stderr);
    const log = await readExecLog(folders);
    assert.equal(log[0], "preload");
    assert.deepEqual(log.filter((line) => line.startsWith("fs")), []);
  });

  it("with the block, reads the Kimi file through the store and makes no lock or marker (positive control)", { timeout: 30_000 },
    async (t) => {
      const { folders, kimiHome, authFile } = await kimiChild(t);
      const kimi = { baseUrl: "http://127.0.0.1:9/coding/v1", oauthTokenUrl: "http://127.0.0.1:9/api/oauth/token" };
      await writeFile(folders.configFile, JSON.stringify(await offlineDoctorConfig({ providers: { kimi } })));
      const result = await runCliChild(folders, ["doctor"], { env: { NO_COLOR: "1" }, recordFsUnder: kimiHome });
      assert.equal(doctorRow(result.stdout, "renewal due:"), "no", result.stdout + result.stderr);
      const calls = (await readExecLog(folders)).filter((line) => line.startsWith("fs"));
      assert.ok(calls.includes(`fs/promises.open ${authFile}`), calls.join("\n"));
      assert.deepEqual(calls.filter((line) => !line.startsWith("fs/promises.lstat ") && !line.startsWith("fs/promises.open ")), [],
        "doctor only checks and opens the sign-in path");
      assert.deepEqual(calls.filter((line) => line.includes(join(kimiHome, "oauth"))), [], "doctor makes no lock or marker");
    });
});

describe("CLI models: Kimi", () => {
  it("models --json lists each Kimi id with its efforts", { timeout: 30_000 }, async (t) => {
    const { folders } = await kimiChild(t);
    const result = await runCliChild(folders, ["models", "--json"], { env: { NO_COLOR: "1" } });
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as { models: ReadonlyArray<{ id: string; provider: string; reasoningEfforts?: string[] }> };
    const rows = payload.models.filter((row) => row.provider === "kimi").map(({ id, reasoningEfforts }) => ({ id, reasoningEfforts }));
    assert.deepEqual(rows, KIMI_MODELS.map(({ id, reasoningEfforts }) => ({ id, reasoningEfforts })));
  });

  it("models lists each Kimi id under the kimi provider", { timeout: 30_000 }, async (t) => {
    const { folders } = await kimiChild(t);
    const result = await runCliChild(folders, ["models"], { env: { NO_COLOR: "1" } });
    assert.equal(result.code, 0, result.stderr);
    for (const { id } of KIMI_MODELS) {
      assert.match(result.stdout, new RegExp(`\\s${id.replaceAll(".", "\\.")}\\s+kimi\\s`), id);
    }
  });
});
