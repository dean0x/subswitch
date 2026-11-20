/**
 * The doctor Kimi row. Each Kimi home is a fabricated mkdtemp folder through realpath; no
 * test reads a real home, sign-in file or store. The doctor io is a fake: no network.
 */
import { describe, it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config.js";
import { runDoctor, type DoctorIO, type TlsStatus } from "../../src/doctor.js";
import { KIMI_REGION_TABLE, type KimiRegion } from "../../src/kimi-constants.js";
import type { KimiStoreDeps } from "../../src/kimi-native-auth.js";
import { createKimiNativeStore, type KimiNativeStore, type KimiTokenRecord } from "../../src/kimi-native-store.js";

const NOW = Date.parse("2031-02-03T04:00:00.000Z");
const ACCESS = "FAKE-KIMI-DOCTOR-ACCESS-0001";
const label = (text: string): string => `  ${text}`.padEnd(22);

const record = (lifeSeconds: number): KimiTokenRecord => ({
  access_token: ACCESS, refresh_token: "FAKE-KIMI-DOCTOR-REFRESH-0001", expires_at: NOW / 1000 + lifeSeconds,
  scope: "kimi-code", token_type: "Bearer", expires_in: 3600,
});
const cliText = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** A fabricated Kimi CLI home, with the file of the region slot when `content` is given. */
const kimiHome = async (t: TestContext, region: KimiRegion = "global", content?: string) => {
  const home = await mkdtemp(join(await realpath(tmpdir()), "subswitch-kimi-doctor-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, "credentials"), { mode: 0o700 });
  const authFile = join(home, "credentials", KIMI_REGION_TABLE[region].credentialFile);
  if (content !== undefined) await writeFile(authFile, content, { mode: 0o600 });
  return { home, authFile };
};

/** A config from one explicit file: the block turns Kimi on. */
const load = (kimi: Record<string, unknown> | undefined) => {
  const text = JSON.stringify(kimi === undefined ? {} : { providers: { kimi } });
  const loaded = loadConfig({ configPath: "kimi-doctor.json", globalConfigPath: false, env: {}, readFile: () => text });
  if (!loaded.ok) throw new Error(loaded.error.message);
  return loaded.value;
};

/** A store fake that records each call and gives `value` to a read. */
const recordingStore = (value: KimiTokenRecord) => {
  const calls: string[] = [];
  const store: KimiNativeStore = {
    get coordinationKey(): string {
      calls.push("coordinationKey");
      return "fixture:kimi-doctor";
    },
    read: async () => {
      calls.push("read");
      return { raw: cliText(value), record: value };
    },
    readMarker: async () => {
      calls.push("readMarker");
      return undefined;
    },
    withLease: async () => {
      calls.push("withLease");
      throw new Error("The fixture store has no lock");
    },
  };
  const openStore = (authFile: string): KimiNativeStore => {
    calls.push(`open ${authFile}`);
    return store;
  };
  return { calls, openStore };
};

const doctorIO = (lines: string[], hosts: string[], kimiStore?: Pick<KimiStoreDeps, "openStore" | "now">): DoctorIO => ({
  write: (line) => lines.push(line),
  readAuthFile: async () => { throw Object.assign(new Error("ENOENT: fixture"), { code: "ENOENT" }); },
  httpGet: async () => ({ ok: true, status: 200, body: JSON.stringify({ name: "subswitch", version: "0.0.0" }) }),
  tlsConnect: async (host): Promise<TlsStatus> => { hosts.push(host); return { kind: "reachable" }; },
  color: false,
  listAgentFiles: async () => [],
  readTextFile: async () => "",
  ...(kimiStore === undefined ? {} : { kimiStore }),
});

const kimiRows = (lines: readonly string[]): string[] => lines.filter((line) => /^ {2}kimi(\.authFile| auth)?:|^ {2}(token expires|renewal due):/.test(line));

describe("doctor Kimi row", () => {
  it("without the block, says not turned on, opens no Kimi store and probes no Kimi host", async () => {
    const loaded = load(undefined);
    const fake = recordingStore(record(3600));
    const lines: string[] = [];
    const hosts: string[] = [];
    const exit = await runDoctor(loaded.config, "fixture", true, doctorIO(lines, hosts, { openStore: fake.openStore, now: () => NOW }),
      loaded.configuredProviders);
    assert.deepEqual(kimiRows(lines), [
      `${label("kimi auth:")}not turned on (add a "providers.kimi" block to the user configuration or to a file selected with SUBSWITCH_CONFIG)`,
    ]);
    assert.deepEqual(fake.calls, []);
    assert.equal(hosts.includes("api.kimi.ai"), false);
    assert.equal(exit, 0);
  });

  for (const [life, due] of [[3600, "no"], [200, "yes"]] as const) {
    it(`with the block, shows only the expiry and that a renewal is ${due === "yes" ? "" : "not "}due`, async (t) => {
      const { authFile } = await kimiHome(t);
      const loaded = load({ authFile });
      const fake = recordingStore(record(life));
      const lines: string[] = [];
      const hosts: string[] = [];
      const exit = await runDoctor(loaded.config, "fixture", true, doctorIO(lines, hosts, { openStore: fake.openStore, now: () => NOW }),
        loaded.configuredProviders);
      assert.deepEqual(kimiRows(lines), [
        `${label("kimi.authFile:")}${authFile}`,
        `${label("token expires:")}${new Date(NOW + life * 1000).toISOString()}`,
        `${label("renewal due:")}${due}`,
      ]);
      assert.deepEqual(fake.calls, [`open ${authFile}`, "read"], "doctor reads the file and never renews or locks");
      assert.equal(lines.join("\n").includes(ACCESS), false);
      assert.ok(hosts.includes("api.kimi.ai"));
      assert.equal(exit, 0);
    });
  }

  it("with the block and the Kimi file store, reads the file and makes no file, folder, lock or marker", async (t) => {
    const { home, authFile } = await kimiHome(t, "global", cliText(record(3600)));
    const loaded = load({ authFile });
    const before = await readdir(home, { recursive: true });
    const lines: string[] = [];
    const exit = await runDoctor(loaded.config, "fixture", true,
      doctorIO(lines, [], { openStore: createKimiNativeStore, now: () => NOW }), loaded.configuredProviders);
    assert.ok(lines.includes(`${label("renewal due:")}no`), lines.join("\n"));
    assert.deepEqual(await readdir(home, { recursive: true }), before);
    assert.equal(exit, 0);
  });

  for (const [region, hint] of [["global", "kimi login"], ["mainland-cn", "kimi login --region mainland-cn"]] as const) {
    it(`fails a missing ${region} file with the sign-in hint \`${hint}\``, async (t) => {
      const { authFile } = await kimiHome(t, region);
      const loaded = load({ region, authFile });
      const lines: string[] = [];
      const exit = await runDoctor(loaded.config, "fixture", true,
        doctorIO(lines, [], { openStore: createKimiNativeStore, now: () => NOW }), loaded.configuredProviders);
      assert.ok(lines.includes(`${label("kimi auth:")}UNAVAILABLE (no auth file — run \`${hint}\`)`), lines.join("\n"));
      assert.equal(exit, 1);
    });
  }

  it("fails a file that the store refuses with the fixed text of its code and no file text", async (t) => {
    // The parse error of this text quotes the token, so a row with the error text would show it.
    const { authFile } = await kimiHome(t, "global", `{"access_token": "${ACCESS}",`);
    const loaded = load({ authFile });
    const lines: string[] = [];
    const exit = await runDoctor(loaded.config, "fixture", true,
      doctorIO(lines, [], { openStore: createKimiNativeStore, now: () => NOW }), loaded.configuredProviders);
    assert.ok(lines.includes(`${label("kimi auth:")}INVALID (The Kimi sign-in file does not hold a valid sign-in record. ` +
      "Run `kimi login` in your own Terminal.)"), lines.join("\n"));
    assert.equal(lines.join("\n").includes(ACCESS), false);
    assert.equal(exit, 1);
  });
});
