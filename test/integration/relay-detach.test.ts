import assert from "node:assert/strict";
import { once } from "node:events";
import { access, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { Server } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { DEFAULT_PORT } from "../../src/config.js";
import { classifyRelay, ensureRelayFolder } from "../../src/relay-record.js";
import { startRelayChild } from "../helpers/relay-child.js";

const detached = { detach: true, env: { NO_COLOR: "1", SUBSWITCH_LIMIT_RECORDING: "0" } } as const;

it("starts and stops a relay under a separate home and on a test port", async (t) => {
  const relay = await startRelayChild({ config: { port: 9 }, env: { NO_COLOR: "1" } });
  t.after(relay.cleanup);
  assert.notEqual(relay.folders.home, homedir());
  assert.ok(relay.port > 0 && relay.port !== 4141 && relay.port !== DEFAULT_PORT && relay.port !== 9);
  assert.equal(JSON.parse(await readFile(relay.folders.configFile, "utf8")).port, relay.port);
  await relay.waitFor("subswitch ready");
  assert.match(relay.stderr, /subswitch ready/);
  await relay.cleanup();
  assert.deepEqual(await relay.exited, [0, null]);
  await assert.rejects(access(relay.folders.home), { code: "ENOENT" });
});

it("prints only the detached relay PID and stops the relay through the test record", async (t) => {
  const relay = await startRelayChild(detached);
  t.after(relay.cleanup);
  assert.deepEqual(await relay.exited, [0, null], relay.stderr);
  assert.equal(relay.stderr, "");
  const live = await classifyRelay(relay.port, { home: relay.folders.home });
  assert.equal(live.kind, "verified");
  const { pid } = live.record;
  assert.notEqual(pid, relay.child.pid);
  assert.equal(relay.stdout, `${pid}\n`);
  await relay.cleanup();
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  await assert.rejects(access(relay.folders.home), { code: "ENOENT" });
});

it("keeps the relay ready after SIGKILL to the detach launcher's process group", async (t) => {
  const relay = await startRelayChild(detached);
  t.after(relay.cleanup);
  assert.deepEqual(await relay.exited, [0, null], relay.stderr);
  const group = relay.child.pid;
  assert.ok(group !== undefined && group > 1 && /^[1-9]\d*\n$/.test(relay.stdout));
  let groupExisted = false;
  try {
    groupExisted = process.kill(-group, "SIGKILL");
  } catch (error) {
    assert.ok(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
  const live = await classifyRelay(relay.port, { home: relay.folders.home });
  assert.equal(live.kind, "verified");
  assert.equal(relay.stdout, `${live.record.pid}\n`);
  assert.equal(groupExisted, false, "No process should stay in the launcher group");
});

it("uses the user config port and ignores the project port on detach", async (t) => {
  const relay = await startRelayChild({
    ...detached, portFromConfig: true,
    prepare: ({ home }) => writeFile(join(home, "subswitch.config.json"), '{"port":0}'),
  });
  t.after(relay.cleanup);
  assert.deepEqual(await relay.exited, [0, null], relay.stderr);
  const live = await classifyRelay(relay.port, { home: relay.folders.home });
  assert.equal(live.kind, "verified");
  assert.equal(relay.stdout, `${live.record.pid}\n`);
});

it("refuses port 4141 before any relay child can start", async (t) => {
  t.mock.method(Server.prototype, "address", () => ({ address: "127.0.0.1", family: "IPv4", port: 4141 }));
  await assert.rejects(startRelayChild({
    prepare: () => assert.fail("Must not prepare or spawn a relay on this port"),
  }), /Reserved relay test port/);
});

for (const matches of [true, false]) {
  it(`signals the pid from the temporary record only when the identity matches (${matches})`, async (t) => {
    const pid = process.pid === 42 ? 43 : 42;
    const nonce = "ab".repeat(16);
    const signals: NodeJS.Signals[] = [];
    t.mock.method(process, "kill", (target: number, signal: NodeJS.Signals | 0) => {
      assert.equal(target, pid);
      if (signal !== 0) signals.push(signal);
      return true;
    });
    const relay = await startRelayChild({ detach: true, extraImport: "data:text/javascript,process.exit(0)" });
    t.after(() => relay.cleanup().catch(() => undefined));
    await relay.exited;
    const health = createServer((_req, res) => res.end(JSON.stringify({
      name: "subswitch", version: "0.8.0", pid, nonce: matches ? nonce : "cd".repeat(16),
    })));
    t.after(() => { health.close(); health.closeAllConnections(); });
    health.listen(relay.port, "127.0.0.1");
    await once(health, "listening");
    const folder = ensureRelayFolder(relay.port, relay.folders.home);
    assert.ok(folder.ok);
    await writeFile(join(folder.value, "relay.json"), JSON.stringify({
      schemaVersion: 1, pid, nonce, port: relay.port, version: "0.8.0", startedAt: new Date().toISOString(), managedBy: "none",
    }), { mode: 0o600 });
    if (matches) await relay.cleanup();
    else await assert.rejects(relay.cleanup(), /Refuse to stop a relay without a verified identity/);
    assert.deepEqual(signals, matches ? ["SIGTERM", "SIGKILL"] : []);
    await assert.rejects(access(relay.folders.home), { code: "ENOENT" });
  });
}
