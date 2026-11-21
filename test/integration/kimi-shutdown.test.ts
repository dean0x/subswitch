import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { KIMI_REGION_TABLE } from "../../src/kimi-constants.js";
import { isPlainObject } from "../../src/plain-object.js";
import { messageFrames, nativeEvents } from "../fixtures/native-messages.js";
import { cliChildCommand, cliChildFolders, offlineDoctorConfig, type CliChildFolders } from "../helpers/cli-child.js";
import { sseHandler, startFakeUpstream } from "./fake-upstreams.js";

const PROFILE = KIMI_REGION_TABLE.global;
const TOKEN_PATH = new URL(PROFILE.oauthTokenUrl).pathname;
const UPSTREAM_ENV = "SUBSWITCH_TEST_KIMI_SHUTDOWN_UPSTREAM";
const access = (version: number): string => `FAKE-KIMI-SHUTDOWN-ACCESS-${version}`;
const grant = (version: number): string => `FAKE-KIMI-SHUTDOWN-REFRESH-${version}`;
const tokens = (version: number, life: number) => ({
  access_token: access(version), refresh_token: grant(version), expires_in: life, token_type: "Bearer", scope: "kimi-code",
});

/** The child uses the live store and routes its fetch calls to the loopback fake only. */
const useLoopbackFetch = (target: string): void => {
  const upstream = new URL(target);
  assert.equal(upstream.protocol, "http:");
  assert.equal(upstream.hostname, "127.0.0.1");
  assert.notEqual(upstream.port, "4141");
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const api = new URL(PROFILE.baseUrl);
    if (url.href !== PROFILE.oauthTokenUrl && !(url.origin === api.origin && url.pathname === `${api.pathname}/messages`)) {
      return Promise.reject(new Error("Unexpected fetch in the shutdown child"));
    }
    return realFetch(new URL(url.pathname + url.search, upstream), { ...init, redirect: "error" });
  };
};

const fixture = async (t: TestContext) => {
  const folders = await cliChildFolders({ resolveTemp: true });
  t.after(() => rm(folders.home, { recursive: true, force: true }));
  const credentials = join(folders.home, ".kimi-code", "credentials");
  const authFile = join(credentials, PROFILE.credentialFile);
  await mkdir(credentials, { recursive: true, mode: 0o700 });
  await writeFile(authFile, JSON.stringify({ ...tokens(1, 3600), expires_at: Math.floor(Date.now() / 1000) - 1 }), { mode: 0o600 });
  const { port } = await offlineDoctorConfig();
  assert.ok(typeof port === "number");
  assert.notEqual(port, 4141);
  await writeFile(folders.configFile, JSON.stringify({ port, logLevel: "info", providers: { kimi: {} } }));
  return { folders, authFile, port };
};

const startServe = async (t: TestContext, folders: CliChildFolders, upstream: string) => {
  const command = cliChildCommand(folders, ["serve"], { env: { [UPSTREAM_ENV]: upstream, NO_COLOR: "1", SUBSWITCH_LIMIT_RECORDING: "0" } });
  // Preload this file after tsx and before the CLI entry and its serve argument.
  const args = command.args.toSpliced(-2, 0, "--import", import.meta.url);
  const child = spawn(command.file, args, { cwd: command.cwd, env: command.env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const exited = new Promise<readonly [number | null, NodeJS.Signals | null]>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve([code, signal]));
  });
  t.after(async () => { child.kill("SIGKILL"); await exited; });
  const waitForLog = async (text: string): Promise<void> => {
    for (let check = 0; check < 400 && child.exitCode === null && child.signalCode === null && !stderr.includes(text); check++) await delay(20);
    assert.ok(stderr.includes(text), `Expected ${text} in child output:\n${stderr}`);
  };
  await waitForLog("run `subswitch doctor`");
  return { child, exited, waitForLog };
};

const postMessage = (port: number, signal: AbortSignal): Promise<Response> => fetch(`http://127.0.0.1:${port}/v1/messages`, {
  method: "POST",
  headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
  body: JSON.stringify({ model: "k3", max_tokens: 16, stream: true, messages: [{ role: "user", content: "hi" }] }),
  signal,
});

/** An incomplete request keeps the socket active. Send no path, headers or body. */
const holdConnection = async (t: TestContext, port: number): Promise<void> => {
  const client = createConnection({ host: "127.0.0.1", port });
  t.after(() => { client.destroy(); });
  const ready = once(client, "connect", { signal: AbortSignal.timeout(4000) });
  client.on("error", () => { /* The child can close a held socket at exit. */ });
  await ready;
  client.write("POST ");
};

const readRecord = async (path: string): Promise<Readonly<Record<string, unknown>>> => {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  assert.ok(isPlainObject(value));
  return value;
};

const checkShutdown = async (t: TestContext, forceExit: boolean): Promise<void> => {
  const { folders, authFile, port } = await fixture(t);
  let receiveReply!: (release: () => void) => void;
  const held = new Promise<() => void>((resolve) => { receiveReply = resolve; });
  const messages = sseHandler(messageFrames(nativeEvents([{ type: "text", text: "Kimi fixture reply" }])).join(""));
  const fake = await startFakeUpstream((req, res, body, index) => {
    if (req.url !== TOKEN_PATH) return messages(req, res, body, index);
    const respond = (version: number, life: number): void => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(tokens(version, life)));
    };
    // The first reply leaves less than five minutes of life, so the next request renews again.
    if (index === 0) receiveReply(() => respond(2, 120));
    else respond(3, 3600);
  });
  t.after(() => fake.close());
  const { child, exited, waitForLog } = await startServe(t, folders, fake.url);
  if (forceExit) await holdConnection(t, port);

  const cancel = new AbortController();
  const caller = postMessage(port, AbortSignal.any([cancel.signal, AbortSignal.timeout(10_000)]));
  const release = await Promise.race([held, caller.then((response) => assert.fail(`Caller returned ${response.status} before renewal`))]);
  cancel.abort();
  await assert.rejects(caller, { name: "AbortError" });
  await waitForLog("client_disconnected");
  assert.ok(child.kill("SIGTERM"));
  await waitForLog("shutting_down");
  await delay(5500); // Longer than the old five-second shutdown bound, below the renewal deadline.
  release();
  const exit = await exited;

  const record = await readRecord(authFile);
  assert.equal(record["refresh_token"], grant(2), "SIGTERM must not exit before it saves the renewed record");
  assert.equal(record["access_token"], access(2));
  assert.deepEqual(exit, [forceExit ? 1 : 0, null]);

  const next = await startServe(t, folders, fake.url);
  const response = await postMessage(port, AbortSignal.timeout(4000));
  assert.equal(response.status, 200);
  assert.match(await response.text(), /event: message_stop/);
  assert.equal((await readRecord(authFile))["refresh_token"], grant(3));
  const sentGrants = fake.requests.filter((sent) => sent.url === TOKEN_PATH)
    .map((sent) => new URLSearchParams(sent.body.toString()).get("refresh_token"));
  assert.deepEqual(sentGrants, [grant(1), grant(2)], "the old marker does not block the next grant");
  assert.ok(next.child.kill("SIGTERM"));
  assert.deepEqual(await next.exited, [0, null]);
};

const upstream = process.env[UPSTREAM_ENV];
if (upstream !== undefined) {
  useLoopbackFetch(upstream);
} else {
  it("SIGTERM saves the renewal after the caller disconnects", { timeout: 28_000 }, (t) => checkShutdown(t, false));
  it("SIGTERM saves the renewal even when an open socket forces exit", { timeout: 28_000 }, (t) => checkShutdown(t, true));
  it("SIGTERM exits promptly without a renewal", { timeout: 12_000 }, async (t) => {
    const { folders } = await fixture(t);
    const { child, exited } = await startServe(t, folders, "http://127.0.0.1:9");
    assert.ok(child.kill("SIGTERM"));
    assert.deepEqual(await Promise.race([exited, delay(2000, "not stopped", { ref: false })]), [0, null]);
  });
}
