import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { it } from "node:test";
import { createGeminiAuth, type GeminiAuthDeps } from "../../src/gemini-auth.js";
import { createGeminiAccountBlockLatch, renderGeminiUpstreamError } from "../../src/gemini-errors.js";
import { redactCredentials, registerExactCredential } from "../../src/errors.js";
import { createKeychainReader, type KeychainReaderDeps } from "../../src/keychain-read.js";
import type { ProviderCredential } from "../../src/provider-auth.js";

const access = `FAKE-GEMINI-ACCESS-ONE-${randomUUID()}`;
const refresh = `FAKE-GEMINI-REFRESH-ONE-${randomUUID()}`;
const rotated = `FAKE-GEMINI-ACCESS-TWO-${randomUUID()}`;
const now = Date.UTC(2031, 0, 1);
const expiry = "2031-01-01T00:05:00Z";
const prefix = "go-keyring-base64:";
const path = "/fake-home/Library/Keychains/login.keychain-db";
const wrap = (json: string | Buffer) => prefix + Buffer.from(json).toString("base64");
const record = (token: object = {}) => wrap(JSON.stringify({
  token: { access_token: access, refresh_token: refresh, token_type: "Bearer", expiry, expires_in: 0, ...token },
  auth_method: "FAKE-AUTH-METHOD", id_token_email: "FAKE-ACCOUNT@example.invalid",
}));
const credential = (token = access) => ({
  ok: true, value: { provider: "gemini", authHeaders: { authorization: `Bearer ${token}` } },
});
const failed: ProviderCredential<"gemini"> = { provider: "gemini", authHeaders: { authorization: `Bearer ${access}` } };
const signInAgain = {
  ok: false, error: { kind: "auth", message: "The Gemini sign-in is not usable. Sign in again with `agy` in your own Terminal." },
};
const invalid = {
  ok: false, error: { kind: "auth", message: "The Gemini sign-in record is not valid. Sign in again with `agy` in your own Terminal." },
};
const blocked = {
  ok: false, error: { kind: "upstream", status: 403, message: "Gemini account access is blocked. Check your account, then restart Subswitch." },
};
const mdat = (date: string) => `"mdat"<timedate>=0x${Buffer.from(`${date}\0`).toString("hex")}  "${date}\\000"\n`;
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

const harness = (platform: NodeJS.Platform = "darwin", register: GeminiAuthDeps["register"] = registerExactCredential) => {
  const latch = createGeminiAccountBlockLatch();
  const calls: Parameters<KeychainReaderDeps["exec"]>[] = [];
  const logs: unknown[] = [];
  const state = {
    now, secret: record(), modified: "20310101000000Z", failure: undefined as { code: number } | undefined,
    probeFailure: undefined as { code: number } | undefined,
    timeout: false, onRead: (): void => {}, onProbe: (): void => {}, expire: (): void => {},
    wait: undefined as Promise<void> | undefined,
  };
  const reader = createKeychainReader({
    platform, env: {}, loginKeychainPath: path,
    setTimer: (expire) => { state.expire = expire; return () => {}; },
    exec: async (...args) => {
      calls.push(args);
      const reveal = args[1].includes("-w");
      if (!reveal) {
        state.onProbe();
        if (state.probeFailure !== undefined) throw state.probeFailure;
        return { stdout: mdat(state.modified) };
      }
      state.onRead();
      if (state.timeout) state.expire();
      if (state.failure !== undefined) throw state.failure;
      await state.wait;
      return { stdout: state.secret };
    },
  });
  const restart = () => createGeminiAuth({ reader, now: () => state.now, register, accountBlock: latch,
    logger: { log: (level, event, fields) => logs.push({ level, event, fields }) },
  });
  const ops = () => calls.map(([, args]) => args.includes("-w") ? "read" : "probe");
  return { auth: restart(), restart, calls, logs, latch, state, ops };
};

it("reads the fixed item and returns only the bearer header from a strict record", async () => {
  const { auth, calls, state } = harness();
  state.secret = record({ access_token: `FAKE${"X".repeat(8188)}` });
  assert.equal(auth.refreshable, true);
  assert.deepEqual(await auth.getCredentials(), credential(`FAKE${"X".repeat(8188)}`));
  assert.deepEqual(calls.map(([file, args, { env }]) => [file, args, env]), [
    ["/usr/bin/security", ["find-generic-password", "-s", "gemini", "-a", "antigravity", path], {}],
    ["/usr/bin/security", ["find-generic-password", "-s", "gemini", "-a", "antigravity", "-w", path], {}],
  ]);
});

it("refuses malformed envelopes, bad token fields and oversized access tokens", async () => {
  for (const secret of [
    record().slice(prefix.length), `${record()}=`, `${record()}!`, record().replace("64:", "64: "),
    `${prefix}Zh==`, wrap("null"), wrap('["FAKE"]'), wrap('{"token":{}}'), wrap('{"token": "FAKE"}'),
    wrap(Buffer.from([0xff])), record({ refresh_token: null }), record({ access_token: `${access}\r\nFAKE` }),
    record({ access_token: `FAKE${"X".repeat(8189)}` }),
  ]) {
    const { auth, state } = harness("darwin", () => true);
    state.secret = secret;
    assert.deepEqual(await auth.getCredentials(), invalid);
  }
});

it("uses the offset and fraction in the expiry and ignores expires_in", async () => {
  const { auth, state, ops } = harness();
  state.secret = record({ expiry: "2031-01-01T02:30:01.123456789+02:30", expires_in: "FAKE" });
  state.now += 1123;
  assert.deepEqual(await auth.getCredentials(), credential());
  state.now += 1;
  assert.deepEqual(await auth.getCredentials(), signInAgain);
  assert.deepEqual(ops(), ["probe", "read", "read"]);
  state.secret = record({ expiry: "2030-12-31T23:01:00.5-01:00" });
  assert.deepEqual(await auth.getCredentials(), credential());
});

it("rejects non-RFC 3339 fields and impossible dates instead of normalizing them", async () => {
  for (const value of ["2031-02-29T00:00:00-01:00", "2031-04-31T00:00:00Z", "2031-01-01T24:00:00Z",
    "2031-01-01 00:00:00Z", "2031-01-01T00:00:00", "2031-01-01T00:00:00+0230",
    "2031-01-01T00:00:00.1234567890Z", "2031-01-01T00:00:00+24:00", "2031-01-01T00:00:00+00:60", 1]) {
    const { auth, state } = harness();
    state.secret = record({ expiry: value });
    assert.deepEqual(await auth.getCredentials(), invalid);
  }
});

it("registers each value with the Gemini scrub before use and refuses either rejected value", async () => {
  const calls: [string, string][] = [];
  const { auth } = harness("darwin", (source, value) => {
    calls.push([source, value]);
    return registerExactCredential(source, value);
  });
  assert.deepEqual(await auth.getCredentials(), credential());
  assert.deepEqual(calls.sort((a, b) => a[1].localeCompare(b[1])), [["gemini", access], ["gemini", refresh]]);
  assert.equal(redactCredentials(`${access} ${refresh}`), "<redacted> <redacted>");
  for (const refused of [access, refresh]) {
    const { auth: other } = harness("darwin", (_source, value) => value !== refused);
    assert.deepEqual(await other.getCredentials(), invalid);
  }
});

it("reports a malformed record with only a fixed error and log code", async (t) => {
  const { auth, logs, state } = harness();
  state.secret = wrap('{"token": "FAKE-RECORD-MARKER"!}');
  const stdout = t.mock.method(process.stdout, "write", () => true);
  const stderr = t.mock.method(process.stderr, "write", () => true);
  assert.deepEqual(await auth.getCredentials(), invalid);
  assert.deepEqual(logs, [{ level: "warn", event: "gemini_credential_load_failed", fields: { errorCode: "invalid_record" } }]);
  assert.equal(stdout.mock.callCount() + stderr.mock.callCount(), 0);
});

it("latches denial, timeout and failed exec until a new manager starts", async () => {
  for (const [cause, errorCode] of [[51, "denied"], [null, "timeout"], [1, "exec_failed"]] as const) {
    const { auth, restart, ops, logs, state } = harness();
    if (cause === null) state.timeout = true;
    else state.failure = { code: cause };
    const first = await auth.getCredentials();
    assert.equal(first.ok, false);
    assert.deepEqual(ops(), ["probe", "read"]);
    assert.match(JSON.stringify(logs), new RegExp(`"errorCode":"${errorCode}"`));
    state.timeout = false;
    state.failure = undefined;
    state.now += 60_000;
    assert.deepEqual(await auth.getCredentials(), first);
    assert.deepEqual(await auth.forceRefresh(undefined, failed), first);
    assert.deepEqual(ops(), ["probe", "read"]);
    assert.deepEqual(await restart().getCredentials(), credential());
    assert.deepEqual(ops(), ["probe", "read", "probe", "read"]);
  }
});

it("does not read a secret or probe again after a denied attribute probe", async () => {
  const { auth, state, ops } = harness();
  assert.deepEqual(await auth.getCredentials(), credential());
  state.probeFailure = { code: 51 };
  state.now += 60_000;
  const denied = await auth.getCredentials();
  assert.equal(denied.ok, false);
  state.probeFailure = undefined;
  assert.deepEqual(await auth.forceRefresh(undefined, failed), denied);
  assert.deepEqual(ops(), ["probe", "read", "probe"]);
});

it("lets a missing item recover without a restart", async () => {
  const { auth, state, logs, ops } = harness();
  state.failure = { code: 44 };
  assert.deepEqual(await auth.getCredentials(), { ok: false, error: {
    kind: "auth", message: "Subswitch did not find the Gemini sign-in in Keychain. Sign in again with `agy` in your own Terminal.",
  } });
  assert.match(JSON.stringify(logs), /"errorCode":"missing"/);
  state.failure = undefined;
  assert.deepEqual(await auth.getCredentials(), credential());
  assert.deepEqual(ops(), ["probe", "read", "read"]);
});

it("shares first use and due probes, and reads only when modification data changes", async () => {
  const { auth, state, ops } = harness();
  const parallel = () => Promise.all([auth.getCredentials(), auth.getCredentials(), auth.getCredentials()]);
  assert.deepEqual(await parallel(), Array.from({ length: 3 }, () => credential()));
  state.secret = record({ access_token: rotated });
  state.now += 59_999;
  assert.deepEqual(await auth.getCredentials(), credential());
  assert.deepEqual(ops(), ["probe", "read"]);
  state.now += 1;
  assert.deepEqual(await parallel(), Array.from({ length: 3 }, () => credential()));
  assert.deepEqual(ops(), ["probe", "read", "probe"]);
  state.now += 60_000;
  state.modified = "20310101000100Z";
  assert.deepEqual(await parallel(), Array.from({ length: 3 }, () => credential(rotated)));
  assert.deepEqual(ops(), ["probe", "read", "probe", "probe", "read"]);
});

it("probes and re-reads once after a 401, refuses the same token, and accepts a new token", async () => {
  const { auth, state, ops } = harness();
  assert.deepEqual(await auth.getCredentials(), credential());
  assert.deepEqual(await Promise.all([auth.forceRefresh(undefined, failed), auth.forceRefresh(undefined, failed)]),
    [signInAgain, signInAgain]);
  assert.deepEqual(ops(), ["probe", "read", "probe", "read"]);
  assert.deepEqual(await auth.getCredentials(), signInAgain);
  state.secret = record({ access_token: rotated });
  assert.deepEqual(await auth.forceRefresh(undefined, failed), credential(rotated));
});

it("uses the same account block in the error mapper and auth, even if auth has a cached token", async () => {
  const { auth, latch, ops, state } = harness();
  assert.deepEqual(await auth.getCredentials(), credential());
  renderGeminiUpstreamError(403, undefined, new Headers(), latch);
  state.now += 60_000;
  assert.deepEqual(await auth.getCredentials(), blocked);
  assert.deepEqual(await auth.forceRefresh(undefined, failed), blocked);
  assert.deepEqual(ops(), ["probe", "read"]);
});

it("does not reveal the item when an account block arrives during a probe", async () => {
  const { auth, latch, ops, state } = harness();
  state.onProbe = latch.block;
  assert.deepEqual(await auth.getCredentials(), blocked);
  assert.deepEqual(ops(), ["probe"]);
});

it("stops one caller wait on abort and lets the shared read or re-read finish", async () => {
  for (const force of [false, true]) {
    const { auth, state, ops } = harness();
    const controller = new AbortController();
    const began = deferred();
    const release = deferred();
    state.secret = record({ access_token: rotated });
    state.wait = release.promise;
    state.onRead = began.resolve;
    const request = force ? auth.forceRefresh(controller.signal, failed) : auth.getCredentials(controller.signal);
    await began.promise;
    const other = auth.getCredentials();
    controller.abort(new Error("FAKE-ABORT-DETAIL"));
    const cancelled = { ok: false, error: { kind: "timeout", message: "The Gemini sign-in wait ended. Retry the request." } };
    const waited = await Promise.race([request, new Promise<string>((resolve) => setImmediate(() => resolve("still waiting")))]);
    assert.deepEqual(waited, cancelled);
    assert.deepEqual(await auth.forceRefresh(controller.signal, failed), cancelled);
    release.resolve();
    assert.deepEqual(await other, credential(rotated));
    assert.deepEqual(ops(), ["probe", "read"]);
  }
});

it("refuses other platforms with a fixed code and no exec", async () => {
  const other = harness("linux");
  assert.deepEqual(await other.auth.getCredentials(), { ok: false, error: {
    kind: "auth", message: "Gemini sign-in is not available on this platform. Use the Gemini route on macOS.",
  } });
  assert.deepEqual(other.ops(), []);
  const darwin = harness();
  assert.deepEqual(await darwin.auth.getCredentials(), credential());
  assert.deepEqual(darwin.ops(), ["probe", "read"]);
});
