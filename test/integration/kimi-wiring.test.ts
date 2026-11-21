/**
 * Kimi wiring: the opt-in gate, the startup checks, the refusing test defaults, health,
 * and the agreement of doctor and buildDeps. Each Kimi home is a fabricated mkdtemp folder
 * through realpath. No test reads a real home, sign-in file or store, and no test sends a
 * request to a Kimi host: every fetch is a fake.
 */
import { describe, it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { loadConfig, type Config } from "../../src/config.js";
import { runDoctor, type DoctorIO, type TlsStatus } from "../../src/doctor.js";
import { KIMI_REGION_TABLE } from "../../src/kimi-constants.js";
import { toKimiProxyError } from "../../src/kimi-errors.js";
import type { KimiStoreDeps } from "../../src/kimi-native-auth.js";
import { createKimiNativeStore, type KimiNativeStore, type KimiTokenRecord } from "../../src/kimi-native-store.js";
import type { Logger } from "../../src/logger.js";
import { buildDeps, createProxyServer, listenServer } from "../../src/server.js";
import { buildTestDeps, refusingProviderDeps } from "../helpers/server-deps.js";
import { recordFsPaths } from "../helpers/fs-path-recorder.js";
import { startSubswitch } from "./fake-upstreams.js";

const SLOT = KIMI_REGION_TABLE.global.credentialFile;
const ACCESS = "FAKE-KIMI-WIRING-ACCESS-0001";
const silent: Logger = { log: () => undefined };

const record = (): KimiTokenRecord => ({
  access_token: ACCESS, refresh_token: "FAKE-KIMI-WIRING-REFRESH-0001", expires_at: Math.floor(Date.now() / 1000) + 3600,
  scope: "kimi-code", token_type: "Bearer", expires_in: 3600,
});
const cliText = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** A fabricated Kimi CLI home with one valid sign-in file in the global slot. */
const kimiHome = async (t: TestContext, root?: string) => {
  const home = root ?? await mkdtemp(join(await realpath(tmpdir()), "subswitch-kimi-wiring-"));
  if (root === undefined) t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, "credentials"), { recursive: true, mode: 0o700 });
  const authFile = join(home, "credentials", SLOT);
  await writeFile(authFile, cliText(record()), { mode: 0o600 });
  return { home, authFile };
};

/** Kimi deps that record each call. The store gives the fixed record; fetch answers 503. */
const recordingKimiDeps = () => {
  const opened: string[] = [];
  const calls: string[] = [];
  const store: KimiNativeStore = {
    get coordinationKey(): string {
      calls.push("coordinationKey");
      return "fixture:kimi-wiring";
    },
    read: async () => {
      calls.push("read");
      const value = record();
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
  const deps: KimiStoreDeps = {
    openStore: (authFile) => {
      opened.push(authFile);
      return store;
    },
    fetch: async (input) => {
      calls.push(`fetch ${String(input)}`);
      return new Response("{}", { status: 503 });
    },
    now: () => Date.now(),
  };
  return { deps, opened, calls };
};

const postKimi = (url: string): Promise<Response> => fetch(`${url}/v1/messages`, {
  method: "POST",
  headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
  body: JSON.stringify({ model: "k3", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
});

/** A config from one explicit file, with absent Codex and Claude sign-in files in `folder`. */
const loadFixture = (folder: string, overrides: Record<string, unknown>) => {
  const text = JSON.stringify({
    logLevel: "error",
    ...overrides,
    providers: { codex: { authFile: join(folder, "codex.json") }, ...(overrides["providers"] as object | undefined) },
    codexIngress: { claude: { authFile: join(folder, "claude.json") } },
  });
  const loaded = loadConfig({ configPath: "kimi-fixture.json", globalConfigPath: false, env: {}, readFile: () => text });
  if (!loaded.ok) throw new Error(loaded.error.message);
  return loaded.value;
};

/** Run `body` while HOME names `home`, so the default Kimi sign-in path is a fixture path. */
const withHome = async <T>(home: string, body: () => Promise<T>): Promise<T> => {
  const previous = process.env["HOME"];
  process.env["HOME"] = home;
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env["HOME"];
    else process.env["HOME"] = previous;
  }
};

describe("Kimi wiring: the opt-in gate", () => {
  it("without the block, a Kimi model gets the fixed local error and no Kimi dep is used", async (t) => {
    const probe = recordingKimiDeps();
    const subswitch = await startSubswitch({}, { providerDeps: { kimi: probe.deps } });
    t.after(subswitch.close);
    const response = await postKimi(subswitch.url);
    assert.equal(response.status, 400);
    assert.match(await response.text(), /Add a \\"providers\.kimi\\" block/);
    assert.deepEqual(probe.opened, [], "no Kimi store is made without the block");
    assert.deepEqual(probe.calls, []);
  });

  it("with the block, a Kimi request reads the configured store and sends through the injected fetch only", async (t) => {
    const { authFile } = await kimiHome(t);
    const probe = recordingKimiDeps();
    const subswitch = await startSubswitch({ providers: { kimi: { authFile } } }, { providerDeps: { kimi: probe.deps } });
    t.after(subswitch.close);
    const response = await postKimi(subswitch.url);
    await response.arrayBuffer();
    assert.deepEqual(probe.opened, [authFile]);
    assert.deepEqual(probe.calls, ["read", "fetch https://api.kimi.ai/coding/v1/messages?beta=true"]);
    assert.deepEqual(subswitch.refusedStoreCalls, []);
  });
});

describe("Kimi wiring: startup", () => {
  it("with the block, startup makes the store of the configured file and reads, writes and sends nothing", async (t) => {
    const { authFile } = await kimiHome(t);
    const probe = recordingKimiDeps();
    const subswitch = await startSubswitch({ providers: { kimi: { authFile } } }, { providerDeps: { kimi: probe.deps } });
    t.after(subswitch.close);
    assert.deepEqual(probe.opened, [authFile]);
    assert.deepEqual(probe.calls, []);
  });

  it("with the block, startup with the Kimi file store makes no file or folder in the Kimi home", async (t) => {
    const { home, authFile } = await kimiHome(t);
    const before = await readFile(authFile, "utf8");
    const calls: string[] = [];
    const kimi: KimiStoreDeps = {
      openStore: createKimiNativeStore,
      fetch: async () => { calls.push("fetch"); throw new Error("no network in this test"); },
      now: () => Date.now(),
    };
    const subswitch = await startSubswitch({ providers: { kimi: { authFile } } }, { providerDeps: { kimi } });
    t.after(subswitch.close);
    assert.deepEqual(await readdir(home), ["credentials"]);
    assert.deepEqual(await readdir(join(home, "credentials")), [SLOT]);
    assert.equal(await readFile(authFile, "utf8"), before);
    assert.deepEqual(calls, []);
  });

  for (const key of ["baseUrl", "oauthTokenUrl"] as const) {
    it(`refuses a loopback Kimi ${key} with the live store, and names no host opt-in key`, async (t) => {
      const { home, authFile } = await kimiHome(t);
      const config = loadFixture(home, { providers: { kimi: { authFile, [key]: "http://127.0.0.1:9/kimi" } } }).config;
      const { kimi: _injected, ...withoutKimi } = refusingProviderDeps([]);
      const live = buildDeps(config, silent, { providerDeps: withoutKimi });
      assert.equal(live.ok, false);
      if (live.ok) return;
      assert.match(live.error, new RegExp(`providers\\.kimi\\.${key}`));
      assert.doesNotMatch(live.error, /allowInsecureBaseUrl/);
      const injected = buildTestDeps(config, silent, { providerDeps: { kimi: recordingKimiDeps().deps } });
      assert.equal(injected.ok, true, "a loopback Kimi URL is for injected test deps");
    });
  }

  it("refuses a Kimi URL on another host, and names no host opt-in key", async (t) => {
    const { home, authFile } = await kimiHome(t);
    const loaded = loadFixture(home, { providers: { kimi: { authFile } } }).config;
    const config: Config = { ...loaded, providers: { ...loaded.providers,
      kimi: { ...loaded.providers.kimi, baseUrl: "https://kimi.example.test/coding/v1" } } };
    const result = buildTestDeps(config, silent, { providerDeps: { kimi: recordingKimiDeps().deps } });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /providers\.kimi\.baseUrl points at 'kimi\.example\.test'/);
    assert.doesNotMatch(result.error, /allowInsecureBaseUrl/);
  });
});

describe("Kimi wiring: refusing test defaults", () => {
  it("records and refuses each Kimi store member, the queue key, fetch and the clock", async () => {
    const refused: string[] = [];
    const { kimi } = refusingProviderDeps(refused);
    const store = kimi.openStore("/fixture-home/.kimi-code/credentials/kimi-code.json");
    assert.deepEqual(refused, [], "making the store is not a call");
    assert.throws(() => store.coordinationKey, /inject the Kimi deps/);
    await assert.rejects(store.read(AbortSignal.timeout(1000)), /inject the Kimi deps/);
    await assert.rejects(store.readMarker(AbortSignal.timeout(1000)), /inject the Kimi deps/);
    await assert.rejects(store.withLease(AbortSignal.timeout(1000), async () => undefined), /inject the Kimi deps/);
    await assert.rejects(kimi.fetch("https://api.kimi.ai/coding/v1/messages"), /inject the Kimi deps/);
    assert.throws(() => kimi.now(), /inject the Kimi deps/);
    assert.deepEqual(refused, ["kimi.coordinationKey", "kimi.read", "kimi.readMarker", "kimi.withLease", "kimi.fetch", "kimi.now"]);
  });

  it("startSubswitch with the block and no Kimi deps starts, and a Kimi request reaches only the refusing fake", async (t) => {
    const { authFile } = await kimiHome(t);
    const subswitch = await startSubswitch({ providers: { kimi: { authFile } } });
    t.after(subswitch.close);
    const response = await postKimi(subswitch.url);
    assert.equal(response.status, 401);
    const body = await response.json() as { error: { message: string } };
    assert.equal(body.error.message, toKimiProxyError("unavailable").message);
    assert.deepEqual(subswitch.refusedStoreCalls, ["kimi.read"]);
  });
});

describe("Kimi wiring: health", () => {
  const healthOf = async (home: string, overrides: Record<string, unknown>) => {
    const kimiFolder = join(home, ".kimi-code");
    const seen: string[] = [];
    const stop = recordFsPaths(kimiFolder, (call, path) => seen.push(`${call} ${path}`));
    try {
      const subswitch = await withHome(home, () => startSubswitch(overrides, {
        checkConfig: (config) => assert.equal(config.providers.kimi.authFile, join(kimiFolder, "credentials", SLOT)),
      }));
      try {
        const body = await (await fetch(`${subswitch.url}/__subswitch/health`)).json() as {
          providers: ReadonlyArray<{ id: string; configured: boolean }>;
        };
        return { kimi: body.providers.find((entry) => entry.id === "kimi"), seen };
      } finally {
        await subswitch.close();
      }
    } finally {
      stop();
    }
  };

  it("without the block, reports Kimi as not configured and stats nothing under the Kimi home", async (t) => {
    const home = await mkdtemp(join(await realpath(tmpdir()), "subswitch-kimi-health-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    await kimiHome(t, join(home, ".kimi-code"));
    const { kimi, seen } = await healthOf(home, {});
    assert.equal(kimi?.configured, false);
    assert.deepEqual(seen, []);
  });

  it("with the block, checks that the Kimi file exists (positive control of the recorder)", async (t) => {
    const home = await mkdtemp(join(await realpath(tmpdir()), "subswitch-kimi-health-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    const { authFile } = await kimiHome(t, join(home, ".kimi-code"));
    const { kimi, seen } = await healthOf(home, { providers: { kimi: {} } });
    assert.equal(kimi?.configured, true);
    assert.deepEqual(seen, [`fs.existsSync ${authFile}`]);
  });
});

describe("Kimi wiring: doctor and buildDeps agree", () => {
  const doctorIO = (kimi: KimiStoreDeps, hosts: string[]): DoctorIO => ({
    write: () => undefined,
    readAuthFile: async () => { throw Object.assign(new Error("ENOENT: fixture"), { code: "ENOENT" }); },
    httpGet: async () => ({ ok: false, connectionRefused: true }),
    tlsConnect: async (host): Promise<TlsStatus> => { hosts.push(host); return { kind: "reachable" }; },
    color: false,
    listAgentFiles: async () => [],
    readTextFile: async () => "",
    kimiStore: { openStore: kimi.openStore, now: kimi.now },
  });

  for (const withBlock of [false, true]) {
    it(`${withBlock ? "with" : "without"} the block, doctor reads the Kimi store only when the leg does`, async (t) => {
      const { home, authFile } = await kimiHome(t);
      const loaded = loadFixture(home, withBlock ? { providers: { kimi: { authFile } } } : {});
      const doctor = recordingKimiDeps();
      const hosts: string[] = [];
      await runDoctor(loaded.config, "kimi-fixture.json", true, doctorIO(doctor.deps, hosts), loaded.configuredProviders);
      const leg = recordingKimiDeps();
      const deps = buildTestDeps(loaded.config, silent, { providerDeps: { kimi: leg.deps } });
      assert.ok(deps.ok, deps.ok ? undefined : deps.error);
      const server = createProxyServer(deps.value);
      const listening = await listenServer(server, 0, "127.0.0.1");
      assert.ok(listening.ok);
      t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
      const { port } = server.address() as AddressInfo;
      await (await postKimi(`http://127.0.0.1:${port}`)).arrayBuffer();
      const doctorRead = doctor.calls.includes("read");
      const legRead = leg.calls.includes("read");
      assert.equal(doctorRead, legRead, "doctor and the leg must agree on the block");
      assert.equal(legRead, withBlock);
      assert.equal(hosts.includes("api.kimi.ai"), withBlock, "doctor probes the Kimi host only with the block");
      assert.deepEqual(doctor.calls.filter((call) => call !== "read"), [], "doctor never renews or locks");
    });
  }
});
