import assert from "node:assert/strict";
import { once } from "node:events";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { KIMI_REGION_TABLE } from "../../src/kimi-constants.js";
import { isPlainObject } from "../../src/plain-object.js";
import { messageFrames, nativeEvents } from "../fixtures/native-messages.js";
import { startRelayChild, type RelayChildOptions } from "../helpers/relay-child.js";
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

const KIMI_HOME = ".kimi-code";
const authPath = (home: string) => join(home, KIMI_HOME, "credentials", PROFILE.credentialFile);
const fixture: RelayChildOptions["prepare"] = async ({ home }) => {
  await mkdir(join(home, KIMI_HOME, "credentials"), { recursive: true, mode: 0o700 });
  await writeFile(authPath(home), JSON.stringify({ ...tokens(1, 3600), expires_at: Math.floor(Date.now() / 1000) - 1 }), { mode: 0o600 });
};

const startServe = async (t: TestContext, upstream: string, prepare = fixture) => {
  const relay = await startRelayChild({
    config: { logLevel: "info", providers: { kimi: {} } },
    env: { [UPSTREAM_ENV]: upstream, NO_COLOR: "1", SUBSWITCH_LIMIT_RECORDING: "0" },
    extraImport: import.meta.url, prepare,
  });
  t.after(relay.cleanup);
  await relay.waitFor("run `subswitch doctor`");
  return relay;
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
  const { child, exited, waitFor: waitForLog, folders, port } = await startServe(t, fake.url);
  const authFile = authPath(folders.home);
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

  const next = await startServe(t, fake.url, ({ home }) => cp(join(folders.home, KIMI_HOME), join(home, KIMI_HOME), { recursive: true }));
  const response = await postMessage(next.port, AbortSignal.timeout(4000));
  assert.equal(response.status, 200);
  assert.match(await response.text(), /event: message_stop/);
  assert.equal((await readRecord(authPath(next.folders.home)))["refresh_token"], grant(3));
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
    const { child, exited } = await startServe(t, "http://127.0.0.1:9");
    assert.ok(child.kill("SIGTERM"));
    assert.deepEqual(await Promise.race([exited, delay(2000, "not stopped", { ref: false })]), [0, null]);
  });
}
