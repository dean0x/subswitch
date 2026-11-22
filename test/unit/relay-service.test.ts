import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { it, type TestContext } from "node:test";
import { noopLogger } from "../../src/logger.js";
import { err, ok } from "../../src/result.js";
import { installService, servicePlistPath, uninstallService, type ServiceDeps } from "../../src/relay-service.js";
import * as server from "../../src/server.js";

const PORT = 23123;
const LABEL = "com.subswitch.relay";
const UID = process.getuid?.() ?? 501;
const DOMAIN = `gui/${UID}`;
const JOB = `${DOMAIN}/${LABEL}`;
const noListener = { kind: "none" } as const;
const verified = (managedBy: "none" | "launchd") => ({
  kind: "verified", version: "0.8.0",
  record: { schemaVersion: 1, pid: 24680, port: PORT, version: "0.8.0", startedAt: "2026-11-22T00:00:00Z",
    nonce: "aa".repeat(16), managedBy },
} as const);

function underHome(home: string, path: string): void {
  const local = relative(home, path);
  assert.ok(isAbsolute(path) && !isAbsolute(local) && local !== ".." && !local.startsWith(`..${sep}`),
    "service path must stay under the temp home");
}

function fixture(t: TestContext) {
  const home = mkdtempSync(join(realpathSync(tmpdir()), "subswitch-service-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const configPath = join(home, ".config", "subswitch", "config.json");
  const execPath = join(home, "node's & tools", "node");
  const entry = join(home, 'entry <&> ".js');
  mkdirSync(join(home, ".config", "subswitch"), { recursive: true });
  mkdirSync(join(execPath, ".."));
  writeFileSync(configPath, JSON.stringify({ port: PORT }), { mode: 0o600 });
  writeFileSync(execPath, "");
  writeFileSync(entry, "");
  const calls: string[][] = [];
  const events: string[] = [];
  const errors: string[] = [];
  const plist = join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
  const folder = join(home, ".cache", "subswitch", "relay", String(PORT));
  const boot = join(folder, "boot.log");
  let elapsed = 0;
  let loaded = false;
  const deps: ServiceDeps = {
    home, uid: UID, platform: "darwin", execPath, entry, logger: noopLogger,
    monotonic: () => elapsed, sleep: async (ms) => { elapsed += ms; },
    errOut: (line) => errors.push(line),
    stop: t.mock.fn(async (port) => { assert.equal(port, PORT); events.push("stop"); return 0; }),
    vet: t.mock.fn(() => { events.push("vet"); return ok(undefined); }),
    probe: t.mock.fn(async (port) => { assert.equal(port, PORT); return loaded ? verified("launchd") : noListener; }),
    runner: async (path, args) => {
      const [op, , file] = args;
      calls.push([path, ...args]);
      events.push(op ?? "missing");
      if (op === "bootstrap") {
        assert.ok(file);
        underHome(home, file);
        assert.equal(file, plist);
        assert.equal(lstatSync(file).mode & 0o777, 0o644);
        loaded = true;
      }
      if (op === "print") return ok(loaded ? 0 : 113);
      if (op === "bootout") {
        if (!loaded) return ok(3);
        loaded = false;
      }
      return ok(0);
    },
  };
  return { deps, configPath, plist, folder, boot, calls, events, errors,
    install: (overrides: Partial<ServiceDeps> = {}) => installService({ ...deps, ...overrides }),
    uninstall: (overrides: Partial<ServiceDeps> = {}) => uninstallService({ ...deps, ...overrides }),
  };
}

it("installs the closed plist with real paths, private logs and only pinned environment values", async (t) => {
  const f = fixture(t);
  const { home, execPath, entry } = f.deps;
  const nodeAlias = join(home, "node-alias");
  const entryAlias = join(home, "entry-alias");
  const ca = join(home, "ca.pem");
  symlinkSync(execPath, nodeAlias);
  symlinkSync(entry, entryAlias);
  assert.equal(await f.install({ execPath: nodeAlias, entry: entryAlias, nodeExtraCaCerts: ca }), 0);
  const xml = readFileSync(f.plist, "utf8");
  const esc = (path: string) => path.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&apos;");
  assert.deepEqual([...xml.matchAll(/<string>([^<]*)<\/string>/g)].map((match) => match[1]), [
    LABEL, esc(execPath), esc(entry), "serve", "--port", String(PORT), "Interactive", f.folder, "/dev/null", f.boot,
    home, `/usr/bin:/bin:/usr/sbin:/sbin:${esc(join(execPath, ".."))}`, f.configPath, "launchd", ca,
  ]);
  assert.deepEqual([...xml.matchAll(/<key>([^<]*)<\/key>/g)].map((match) => match[1]), [
    "Label", "ProgramArguments", "RunAtLoad", "KeepAlive", "SuccessfulExit", "ThrottleInterval", "ExitTimeOut",
    "ProcessType", "WorkingDirectory", "StandardOutPath", "StandardErrorPath", "EnvironmentVariables",
    "HOME", "PATH", "SUBSWITCH_CONFIG", "SUBSWITCH_MANAGED_BY", "NODE_EXTRA_CA_CERTS",
  ]);
  assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(xml, /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>\s*<\/dict>/);
  assert.match(xml, /<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/);
  assert.match(xml, /<key>ExitTimeOut<\/key>\s*<integer>40<\/integer>/);
  assert.equal(lstatSync(f.folder).mode & 0o777, 0o700);
  assert.equal(lstatSync(f.boot).mode & 0o777, 0o600);
  assert.deepEqual(f.calls, [["/bin/launchctl", "print", JOB], ["/bin/launchctl", "bootstrap", DOMAIN, f.plist]]);
  assert.equal(servicePlistPath(home), f.plist);
  for (const path of [servicePlistPath(home), f.plist, f.folder, f.boot, f.configPath, nodeAlias, entryAlias, execPath, entry, ca]) {
    underHome(home, path);
  }
  assert.throws(() => underHome(home, join(home, "..", "elsewhere")), /must stay under the temp home/);
});

it("stops a verified detached relay and unloads an old job before bootstrap", async (t) => {
  const f = fixture(t);
  assert.equal(await f.install(), 0);
  assert.doesNotMatch(readFileSync(f.plist, "utf8"), /NODE_EXTRA_CA_CERTS/);
  f.events.length = 0;
  const probe = t.mock.fn(f.deps.probe);
  probe.mock.mockImplementationOnce(async () => verified("none"));
  assert.equal(await f.install({ probe }), 0);
  assert.deepEqual(f.events, ["vet", "stop", "print", "bootout", "print", "bootstrap"]);
  assert.deepEqual(f.calls.slice(-4), [
    ["/bin/launchctl", "print", JOB], ["/bin/launchctl", "bootout", JOB], ["/bin/launchctl", "print", JOB],
    ["/bin/launchctl", "bootstrap", DOMAIN, f.plist],
  ]);
});

it("does not publish a plist or bootstrap if the detached relay cannot stop", async (t) => {
  const f = fixture(t);
  assert.equal(await f.install({ probe: async () => verified("none"), stop: async () => 1 }), 1);
  assert.match(f.errors.join("\n"), /could not stop the detached relay/);
  assert.deepEqual(f.calls, []);
  assert.equal(existsSync(f.plist), false);
  assert.equal(existsSync(f.boot), false);
});

it("refuses a non-macOS request before it touches service files or runs dependencies", async (t) => {
  const f = fixture(t);
  const bad = { platform: "linux", home: join(f.deps.home, "missing") } as const;
  assert.equal(await f.install(bad), 1);
  assert.equal(await f.uninstall(bad), 1);
  assert.ok(f.errors.length === 2 && f.errors.every((line) => /launchd on macOS/.test(line)));
  assert.deepEqual(f.events, []);
  assert.equal(existsSync(bad.home), false);
});

it("uses the pinned explicit config and refuses an Anthropic host before any write", async (t) => {
  const f = fixture(t);
  const configPath = join(f.deps.home, "selected.json");
  writeFileSync(configPath, JSON.stringify({ port: PORT, anthropic: { baseUrl: "https://other.example" } }));
  const result = await f.install({ configPath, vet: server.vetConfig });
  assert.equal(result, 1);
  assert.match(f.errors.join("\n"), /anthropic\.baseUrl/);
  assert.equal(existsSync(join(f.deps.home, "Library")), false);
  assert.equal(existsSync(f.folder), false);
  assert.deepEqual(f.calls, []);
});

it("refuses relative and control paths, writable config, symlink parents and symlink plists", async (t) => {
  const f = fixture(t);
  for (const overrides of [{ configPath: "relative.json" }, { nodeExtraCaCerts: "relative.pem" },
    { entry: `${f.deps.entry}\n` }, { execPath: "node" }]) {
    assert.equal(await f.install(overrides), 1);
  }
  chmodSync(f.configPath, 0o622);
  assert.equal(await f.install(), 1);
  chmodSync(f.configPath, 0o600);
  assert.equal(existsSync(join(f.deps.home, "Library")), false);
  const library = join(f.deps.home, "Library");
  mkdirSync(library);
  const agents = join(library, "LaunchAgents");
  symlinkSync(f.deps.home, agents);
  assert.equal(await f.install(), 1);
  rmSync(agents);
  mkdirSync(agents);
  symlinkSync(f.configPath, f.plist);
  assert.equal(await f.install(), 1);
  assert.equal(lstatSync(f.plist).isSymbolicLink(), true);
  assert.equal(existsSync(f.folder), false);
  assert.deepEqual(f.calls, []);
});

for (const kind of ["foreign", "legacy"] as const) {
  it(`refuses a ${kind} listener without service writes or stop`, async (t) => {
    const f = fixture(t);
    assert.equal(await f.install({ probe: async () => ({ kind }) }), 1);
    assert.deepEqual(f.events, ["vet"]);
    assert.equal(existsSync(join(f.deps.home, "Library")), false);
    assert.equal(existsSync(f.folder), false);
  });
}

for (const stage of ["bootstrap", "verify"] as const) {
  it(`rolls back a failed ${stage} and reports that the detached relay stopped`, async (t) => {
    const f = fixture(t);
    let probes = 0;
    const runner: ServiceDeps["runner"] = async (...args) => {
      const result = await f.deps.runner(...args);
      return stage === "bootstrap" && args[1][0] === "bootstrap" ? err("failed") : result;
    };
    assert.equal(await f.install({ runner, probe: async () => { probes++; return verified("none"); } }), 1);
    assert.deepEqual(f.events, ["vet", "stop", "print", "bootstrap", "bootout", "print"]);
    assert.equal(existsSync(f.plist), false);
    assert.equal(existsSync(f.boot), true);
    assert.equal(f.errors.length, 1);
    assert.match(f.errors[0] ?? "", /earlier detached relay was stopped/);
    assert.equal(f.deps.monotonic(), stage === "verify" ? 8_000 : 0);
    assert.ok(probes <= 42);
  });
}

it("unloads an installed job, removes its plist and keeps its logs; a second uninstall succeeds", async (t) => {
  const f = fixture(t);
  assert.equal(await f.install(), 0);
  writeFileSync(f.boot, "keep this log");
  assert.equal(await f.uninstall(), 0);
  assert.equal(await f.uninstall(), 0);
  assert.equal(existsSync(f.plist), false);
  assert.equal(readFileSync(f.boot, "utf8"), "keep this log");
  assert.deepEqual(f.calls.slice(-4), [
    ["/bin/launchctl", "bootout", JOB], ["/bin/launchctl", "print", JOB],
    ["/bin/launchctl", "bootout", JOB], ["/bin/launchctl", "print", JOB],
  ]);
});

it("preserves a plist with a different label and reports a launchctl error or 45 second timeout", async (t) => {
  const f = fixture(t);
  assert.equal(await f.install(), 0);
  const xml = readFileSync(f.plist, "utf8");
  writeFileSync(f.plist, xml.replace(LABEL, "other.relay"));
  assert.equal(await f.uninstall(), 1);
  assert.match(readFileSync(f.plist, "utf8"), /other\.relay/);
  writeFileSync(f.plist, xml);
  assert.equal(await f.uninstall({ runner: async () => ok(5) }), 1);
  assert.equal(f.deps.monotonic(), 0);
  assert.equal(await f.uninstall({ runner: async () => ok(0) }), 1);
  assert.equal(f.deps.monotonic(), 45_000);
  assert.equal(readFileSync(f.plist, "utf8"), xml);
});
