import assert from "node:assert/strict";
import { once } from "node:events";
import { access, appendFile, readFile, unlink } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { it } from "node:test";
import { isPlainObject } from "../../src/plain-object.js";
import { classifyRelay, readRelayRecord, writeStopRequest, type StopRequest } from "../../src/relay-record.js";
import { runCliChild } from "../helpers/cli-child.js";
import type { RelayChild } from "../helpers/relay-child.js";
import { launch, lifecycleLines, log, state, stopped } from "../helpers/relay-lifecycle.js";

const stopRequestPath = (relay: RelayChild) => join(state(relay), "stop-request.json");
const requestFields = { requesterPid: 51001, requesterPpid: 51002, uid: 501, label: "test-request-label" } as const;
const requestCanaries = /test-env-canary|test-argv-canary/;

it("stops a verified relay, attributes the request and then reports an idle port", async (t) => {
  const relay = await launch(t);
  await relay.waitFor("subswitch ready");
  const { pid } = relay.child;
  assert.ok(pid && pid !== 37926 && pid !== 98325);
  const args = ["stop", "--port", String(relay.port)];
  const result = await runCliChild(relay.folders, [...args, "--by", "test-stop"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "");
  const match = /^subswitch: stop request (\{[^\n]+\})\n$/.exec(result.stderr);
  assert.ok(match?.[1], result.stderr);
  const request: unknown = JSON.parse(match[1]);
  assert.ok(isPlainObject(request) && typeof request["requesterPid"] === "number");
  assert.equal(request["targetPid"], pid);
  assert.equal(request["requesterPpid"], process.pid);
  assert.equal(request["label"], "test-stop");
  assert.deepEqual(await relay.exited, [0, null]);
  assert.match(lifecycleLines(await log(relay))[0] ?? "",
    stopped(pid, 0, "SIGTERM", ` requesterPid=${request["requesterPid"]} requesterPpid=${process.pid}`));
  await assert.rejects(access(stopRequestPath(relay)), { code: "ENOENT" });
  assert.deepEqual(await runCliChild(relay.folders, args), {
    code: 0, stdout: `No relay is active on port ${relay.port}.\n`, stderr: "",
  });
});

for (const mode of ["legacy", "launchd"] as const) {
  it(`refuses to stop a ${mode} relay`, async (t) => {
    const relay = await launch(t, { env: { SUBSWITCH_MANAGED_BY: mode === "launchd" ? mode : undefined } });
    await relay.waitFor("subswitch ready");
    const { pid } = relay.child;
    assert.ok(pid && pid !== 37926 && pid !== 98325);
    if (mode === "legacy") await unlink(join(state(relay), "relay.json"));
    const result = await runCliChild(relay.folders, ["stop", "--port", String(relay.port)]);
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, mode === "launchd" ? /run subswitch service uninstall/ : /has no record/);
    assert.equal((await classifyRelay(relay.port, { home: relay.folders.home })).kind,
      mode === "launchd" ? "verified" : "legacy");
    await assert.rejects(access(stopRequestPath(relay)), { code: "ENOENT" });
  });
}

function makeStopRequest(relay: RelayChild, changes: Partial<StopRequest> = {}): StopRequest {
  const saved = readRelayRecord(relay.port, relay.folders.home);
  assert.ok(saved.ok && saved.value);
  return { targetPid: saved.value.pid, nonce: saved.value.nonce, requestedAt: new Date().toISOString(), ...requestFields, ...changes };
}

async function placeStopRequest(relay: RelayChild, request: StopRequest): Promise<void> {
  assert.deepEqual(await writeStopRequest(relay.port, relay.folders.home, request), { ok: true, value: request });
}

async function requestReads(relay: RelayChild): Promise<number> {
  const text = await readFile(relay.folders.execLog, "utf8");
  return text.split("\n").filter((line) => line === `fs.openSync ${stopRequestPath(relay)}`).length;
}

const requestCases: readonly {
  readonly name: string;
  readonly signal: "SIGINT" | "SIGTERM" | "SIGHUP";
  readonly attributed?: boolean;
  readonly offsetMs?: number;
  readonly changes?: Partial<StopRequest>;
  readonly oversize?: boolean;
}[] = [
  { name: "matching fresh SIGTERM", signal: "SIGTERM", attributed: true },
  { name: "matching fresh SIGINT", signal: "SIGINT" },
  { name: "matching fresh SIGHUP", signal: "SIGHUP" },
  { name: "stale SIGTERM", signal: "SIGTERM", offsetMs: -41_000 },
  { name: "future SIGTERM", signal: "SIGTERM", offsetMs: 10_000 },
  { name: "wrong pid SIGTERM", signal: "SIGTERM", changes: { targetPid: 2 } },
  { name: "wrong nonce SIGTERM", signal: "SIGTERM", changes: { nonce: "00".repeat(16) } },
  { name: "oversize SIGTERM", signal: "SIGTERM", oversize: true },
];

for (const fixture of requestCases) {
  it(`consumes a stop request once for ${fixture.name}`, async (t) => {
    const relay = await launch(t, {
      recordFsUnder: ".cache/subswitch/relay",
      env: { SUBSWITCH_TEST_ENV_CANARY: "test-env-canary" },
      extraImport: "data:text/javascript,/*test-argv-canary*/",
    });
    await relay.waitFor("subswitch ready");
    const request = makeStopRequest(relay, {
      requestedAt: new Date(Date.now() + (fixture.offsetMs ?? 0)).toISOString(),
      ...fixture.changes,
    });
    await placeStopRequest(relay, request);
    if (fixture.oversize) await appendFile(stopRequestPath(relay), " ".repeat(4_096));
    const requestText = await readFile(stopRequestPath(relay), "utf8");
    assert.deepEqual(JSON.parse(requestText), request);
    assert.doesNotMatch(requestText, requestCanaries);
    assert.equal(await requestReads(relay), 0);

    assert.ok(relay.child.kill(fixture.signal));
    assert.deepEqual(await relay.exited, [0, null]);
    const text = await log(relay);
    const lines = lifecycleLines(text);
    assert.equal(lines.length, 1);
    const requester = fixture.attributed ? " requesterPid=51001 requesterPpid=51002" : "";
    assert.match(lines[0] ?? "", stopped(relay.child.pid, 0, fixture.signal, requester));
    assert.deepEqual(lifecycleLines(relay.stderr), lines);
    assert.doesNotMatch(text + relay.stderr + relay.stdout, requestCanaries);
    assert.equal(await requestReads(relay), 1);
    await assert.rejects(access(stopRequestPath(relay)), { code: "ENOENT" });
  });
}

it("exits 1 after the grace period, keeps the first stop signal and consumes a later request", async (t) => {
  const relay = await launch(t, { recordFsUnder: ".cache/subswitch/relay" });
  await relay.waitFor("subswitch ready");
  const request = makeStopRequest(relay);
  const socket = createConnection({ host: "127.0.0.1", port: relay.port });
  t.after(() => { socket.destroy(); });
  socket.on("error", () => { /* Exit can close the held connection. */ });
  await once(socket, "connect", { signal: AbortSignal.timeout(2_000) });
  socket.write("POST ");
  await placeStopRequest(relay, request);
  assert.ok(relay.child.kill("SIGTERM"));
  await relay.waitFor("shutting_down");
  await placeStopRequest(relay, { ...request, requesterPid: 51003 });
  assert.ok(relay.child.kill("SIGHUP"));
  assert.deepEqual(await relay.exited, [1, null]);
  const lines = lifecycleLines(await log(relay));
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? "", stopped(relay.child.pid, 1, "SIGTERM", " requesterPid=51001 requesterPpid=51002"));
  assert.equal(await requestReads(relay), 2);
  await assert.rejects(access(stopRequestPath(relay)), { code: "ENOENT" });
});
