import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import { Server } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { DEFAULT_PORT } from "../../src/config.js";
import { ensureRelayFolder } from "../../src/relay-record.js";
import { startRelayChild } from "../helpers/relay-child.js";

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
    t.mock.method(globalThis, "fetch", async () => Response.json({
      name: "subswitch", version: "0.8.0", pid, nonce: matches ? nonce : "cd".repeat(16),
    }));
    const relay = await startRelayChild({ detach: true, extraImport: "data:text/javascript,process.exit(0)" });
    t.after(() => relay.cleanup().catch(() => undefined));
    await relay.exited;
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
