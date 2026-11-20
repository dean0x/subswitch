/**
 * The Kimi sign-in manager. Every home is a fabricated mkdtemp folder under the real temp
 * path, every token request goes to a fake fetch, and the clock is a fake. No test reads a
 * real home, sign-in file or store, and no test makes a network call. The token URL, the
 * client id, the lock layout and the marker name are spelled here, apart from the code.
 */
import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { toAnthropicErrorBody, type ProxyError } from "../../src/errors.js";
import { KIMI_ERRORS, toKimiProxyError, type KimiErrorCode } from "../../src/kimi-errors.js";
import { createKimiAuth, type KimiAuthDeps } from "../../src/kimi-native-auth.js";
import { createKimiNativeStore, type KimiNativeStore, type KimiStoreHooks, type KimiTokenRecord } from "../../src/kimi-native-store.js";
import type { LogFields, LogLevel, Logger } from "../../src/logger.js";
import type { ProviderCredential } from "../../src/provider-auth.js";
import type { Result } from "../../src/result.js";

const SLOT = "kimi-code";
/** A token URL that the code can not make up: only the config value leads here. */
const TOKEN_URL = "http://127.0.0.1:9/fake-kimi-oauth/api/oauth/token";
const CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const ACCESS = "FAKE-kimi-access-0001";
const REFRESH = "FAKE-kimi-refresh-0001";
const RENEWED = "FAKE-kimi-access-0002";
const ROTATED = "FAKE-kimi-refresh-0002";
const PEER = "FAKE-kimi-peer-access-0003";
/** Seconds of life left: 3600 is fresh, 600 is due but valid (due below 1800 s), -60 is expired. */
const FRESH = 3600, DUE = 600, EXPIRED = -60;

const signal = () => AbortSignal.timeout(15_000);
const nowSeconds = () => Math.floor(Date.now() / 1000);
const record = (access = ACCESS, life = FRESH, refresh = REFRESH): KimiTokenRecord => ({
  access_token: access, refresh_token: refresh, expires_at: nowSeconds() + life,
  scope: "kimi-code", token_type: "Bearer", expires_in: 3600, custom: "kept",
});
/** The Kimi CLI file format: two-space JSON and a final newline. */
const cliText = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const renewed = (access = RENEWED) =>
  reply({ access_token: access, refresh_token: ROTATED, token_type: "Bearer", expires_in: 3600, scope: "kimi-code" });
const networkError = (code: string) =>
  new TypeError("fetch failed", { cause: Object.assign(new Error(`FAKE-cause ${TOKEN_URL}`), { code }) });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

interface Call { readonly url: string; readonly init: RequestInit }
type Reply = (call: Call, count: number) => Response | Promise<Response>;
interface LogRecord { readonly level: LogLevel; readonly event: string; readonly fields: LogFields | undefined }

const neverAnswer: Reply = () => assert.fail("no token request is expected");
/** A token request that stays open until its signal aborts. */
const openUntilAbort: Reply = (call) => new Promise<Response>((_, reject) => {
  call.init.signal?.addEventListener("abort", () => reject(new DOMException("FAKE-abort", "AbortError")), { once: true });
});

async function kimiHome(t: TestContext, life = FRESH, hooks?: KimiStoreHooks) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "subswitch-kimi-auth-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const credentials = join(root, "credentials");
  await mkdir(credentials, { mode: 0o700 });
  const file = join(credentials, `${SLOT}.json`);
  await writeFile(file, cliText(record(ACCESS, life)), { mode: 0o600 });
  const oauth = join(root, "oauth");
  return {
    root, credentials, file, oauth, lock: join(oauth, `${SLOT}.lock`), marker: join(oauth, `${SLOT}.subswitch-renewal.json`),
    store: createKimiNativeStore(file, hooks),
  };
}
type Home = Awaited<ReturnType<typeof kimiHome>>;

/** A Kimi manager with a fake fetch, a fake clock and a log that the test reads. */
function kimiAuth(home: Home, answer: Reply, extra: Partial<KimiAuthDeps> = {}) {
  const calls: Call[] = [];
  const logs: LogRecord[] = [];
  const clock = { now: Date.now() };
  const logger: Logger = { log: (level, event, fields) => { logs.push({ level, event, fields }); } };
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return answer(call, calls.length);
  }) as typeof globalThis.fetch;
  const auth = createKimiAuth({ store: home.store, oauthTokenUrl: TOKEN_URL, fetch, now: () => clock.now, logger, ...extra });
  return { auth, calls, logs, clock };
}

type CredentialResult = Result<ProviderCredential<"kimi">, ProxyError>;
const bearer = (result: CredentialResult): string => {
  assert.ok(result.ok, `a credential, not: ${result.ok ? "" : result.error.message}`);
  return result.value.authHeaders["authorization"] ?? "";
};
const failsWith = (result: CredentialResult, code: KimiErrorCode): void => {
  assert.equal(result.ok, false, `the ${code} failure`);
  if (!result.ok) assert.deepEqual(result.error, toKimiProxyError(code));
};
const messageOf = (result: CredentialResult): string => (result.ok ? "" : result.error.message);
const readMarker = async (home: Home) => JSON.parse(await readFile(home.marker, "utf8")) as Record<string, unknown>;
const readRecord = async (home: Home) => JSON.parse(await readFile(home.file, "utf8")) as Record<string, unknown>;
const writePeer = async (home: Home, access = PEER) => {
  await writeFile(`${home.file}.peer`, cliText(record(access, FRESH, "FAKE-kimi-peer-refresh-0003")), { mode: 0o600 });
  await rename(`${home.file}.peer`, home.file);
};
const takeOverLock = async (home: Home) => {
  await rename(home.lock, `${home.lock}.old`);
  await mkdir(home.lock, { mode: 0o700 });
};
/** A store that records each finished marker write, by its outcome. */
const recordingStore = (store: KimiNativeStore, steps: string[]): KimiNativeStore => ({
  ...store,
  withLease: (lease, operation) => store.withLease(lease, (inner) => operation({
    ...inner,
    writeMarker: async (grant, outcome, retryAt, failures) => {
      await inner.writeMarker(grant, outcome, retryAt, failures);
      steps.push(`marker:${outcome}`);
    },
  })),
});

describe("Kimi sign-in: read", () => {
  it("returns only the bearer of a fresh sign-in, sends no grant and makes no lock state", async (t) => {
    const home = await kimiHome(t);
    const { auth, calls } = kimiAuth(home, neverAnswer);
    const result = await auth.getCredentials(signal());
    assert.ok(result.ok);
    assert.deepEqual(result.value, { provider: "kimi", authHeaders: { authorization: `Bearer ${ACCESS}` } });
    assert.equal(auth.refreshable, true);
    assert.equal(calls.length, 0);
    assert.deepEqual(await readdir(home.root), ["credentials"]);
  });

  it("refuses an access token that the scrub can not hold with invalid_record", async (t) => {
    const home = await kimiHome(t);
    await writeFile(home.file, cliText(record("FAKE-short-01")));
    const { auth } = kimiAuth(home, neverAnswer);
    failsWith(await auth.getCredentials(signal()), "invalid_record");
  });
});

describe("Kimi sign-in: renewal when due", () => {
  it("sends the refresh grant to the vetted token URL with the Kimi CLI client id and no bearer", async (t) => {
    const home = await kimiHome(t, EXPIRED);
    const { auth, calls } = kimiAuth(home, () => renewed());
    assert.equal(bearer(await auth.getCredentials(signal())), `Bearer ${RENEWED}`);
    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.equal(call.url, TOKEN_URL);
    assert.equal(call.init.method, "POST");
    assert.equal(call.init.redirect, "error");
    const form = new URLSearchParams(String(call.init.body));
    assert.deepEqual([...form.entries()].sort(), [["client_id", CLIENT_ID], ["grant_type", "refresh_token"], ["refresh_token", REFRESH]]);
    const headers = new Headers(call.init.headers);
    assert.equal(headers.get("content-type"), "application/x-www-form-urlencoded");
    assert.equal(headers.has("authorization"), false);
    assert.match(auth.deviceId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.equal(headers.get("x-msh-device-id"), auth.deviceId);
    assert.equal(headers.get("x-msh-platform"), "subswitch");
  });

  it("writes the marker as prepared, then as pending, before the token request", async (t) => {
    const home = await kimiHome(t, DUE);
    const steps: string[] = [];
    const { auth } = kimiAuth(home, async () => {
      steps.push(`request with marker ${String((await readMarker(home))["outcome"])}`);
      return renewed();
    }, { store: recordingStore(home.store, steps) });
    assert.equal(bearer(await auth.getCredentials(signal())), `Bearer ${RENEWED}`);
    assert.deepEqual(steps, ["marker:prepared", "marker:pending", "request with marker pending"]);
  });

  it("saves the new record atomically with mode 0600 and keeps the unknown keys", async (t) => {
    const home = await kimiHome(t, EXPIRED);
    const before = await lstat(home.file);
    const { auth, clock } = kimiAuth(home, () => renewed());
    assert.equal(bearer(await auth.getCredentials(signal())), `Bearer ${RENEWED}`);
    const after = await lstat(home.file);
    assert.notEqual(after.ino, before.ino, "a new file is renamed into place");
    assert.equal(after.mode & 0o777, 0o600);
    assert.deepEqual(await readRecord(home), {
      access_token: RENEWED, refresh_token: ROTATED, expires_at: Math.floor(clock.now / 1000) + 3600,
      scope: "kimi-code", token_type: "Bearer", expires_in: 3600, custom: "kept",
    });
    assert.deepEqual((await readdir(home.oauth)).sort(), [SLOT, `${SLOT}.subswitch-renewal.json`]);
    assert.deepEqual(await readdir(home.credentials), [`${SLOT}.json`]);
  });
});

describe("Kimi sign-in: renewal after a 401", () => {
  it("returns refresh_required and sends no grant when forceRefresh names no refused credential", async (t) => {
    const home = await kimiHome(t);
    const { auth, calls } = kimiAuth(home, neverAnswer);
    failsWith(await auth.forceRefresh(signal()), "refresh_required");
    failsWith(await auth.forceRefresh(signal(), { provider: "kimi", authHeaders: {} }), "refresh_required");
    assert.equal(calls.length, 0);
    assert.deepEqual(await readdir(home.root), ["credentials"]);
  });

  it("renews once for the refused bearer of a sign-in that is not due", async (t) => {
    const home = await kimiHome(t);
    const { auth, calls } = kimiAuth(home, () => renewed());
    const first = await auth.getCredentials(signal());
    assert.ok(first.ok);
    assert.equal(bearer(await auth.forceRefresh(signal(), first.value)), `Bearer ${RENEWED}`);
    assert.equal(calls.length, 1);
  });

  it("renews at most once for each refused token, also for 401s at the same time", async (t) => {
    const home = await kimiHome(t);
    const { auth, calls } = kimiAuth(home, () => renewed());
    const first = await auth.getCredentials(signal());
    assert.ok(first.ok);
    const both = await Promise.all([auth.forceRefresh(signal(), first.value), auth.forceRefresh(signal(), first.value)]);
    assert.deepEqual(both.map(bearer), [`Bearer ${RENEWED}`, `Bearer ${RENEWED}`]);
    assert.equal(bearer(await auth.forceRefresh(signal(), first.value)), `Bearer ${RENEWED}`);
    assert.equal(calls.length, 1);
  });

  it("sends no grant for a refused bearer that the file no longer holds", async (t) => {
    const home = await kimiHome(t);
    const { auth, calls } = kimiAuth(home, () => renewed());
    const stale: ProviderCredential<"kimi"> = { provider: "kimi", authHeaders: { authorization: "Bearer FAKE-kimi-stale-access-0000" } };
    assert.equal(bearer(await auth.forceRefresh(signal(), stale)), `Bearer ${ACCESS}`);
    assert.equal(calls.length, 0);
  });
});

describe("Kimi sign-in: client aborts and deadlines", () => {
  for (const entry of ["getCredentials", "forceRefresh"] as const) {
    it(`ends only the wait of a client that aborts during ${entry}, and saves the sent renewal`, async (t) => {
      const home = await kimiHome(t, entry === "getCredentials" ? EXPIRED : FRESH);
      const sent = deferred<void>(), release = deferred<Response>();
      const { auth, calls } = kimiAuth(home, () => {
        sent.resolve();
        return release.promise;
      });
      const client = new AbortController();
      const held = entry === "forceRefresh" ? await auth.getCredentials(signal()) : undefined;
      const pending = held?.ok === true ? auth.forceRefresh(client.signal, held.value) : auth.getCredentials(client.signal);
      await sent.promise;
      client.abort();
      failsWith(await pending, "cancelled");
      assert.equal(calls[0]?.init.signal?.aborted, false, "the client abort does not reach the token request");
      release.resolve(renewed());
      assert.equal(bearer(await auth.getCredentials(signal())), `Bearer ${RENEWED}`);
      assert.equal((await readRecord(home))["access_token"], RENEWED);
      assert.equal(calls.length, 1);
    });
  }

  const fakeDeadlines = () => {
    const made: { readonly ms: number; readonly controller: AbortController }[] = [];
    const deadline = (ms: number): AbortSignal => {
      const controller = new AbortController();
      made.push({ ms, controller });
      return controller.signal;
    };
    const fire = (ms: number): void => {
      const found = made.find((entry) => entry.ms === ms);
      assert.ok(found, `a ${ms} ms deadline`);
      found.controller.abort(new DOMException("FAKE-deadline", "TimeoutError"));
    };
    return { deadline, fire };
  };

  it("runs the renewal under its own 20 s deadline, and a request that may have left is not sent again", async (t) => {
    const home = await kimiHome(t, EXPIRED);
    const sent = deferred<void>();
    const { deadline, fire } = fakeDeadlines();
    const { auth, calls } = kimiAuth(home, (call) => {
      sent.resolve();
      return openUntilAbort(call, 1);
    }, { deadline });
    const pending = auth.getCredentials(signal());
    await sent.promise;
    fire(20_000);
    failsWith(await pending, "refresh_recovery_required");
    assert.equal(calls[0]?.init.signal?.aborted, true);
    assert.equal((await readRecord(home))["access_token"], ACCESS);
    failsWith(await auth.getCredentials(signal()), "refresh_recovery_required");
    assert.equal(calls.length, 1);
  });

  it("ends the credential wait at its own bound with timeout while the renewal goes on", async (t) => {
    const home = await kimiHome(t, EXPIRED);
    const sent = deferred<void>(), release = deferred<Response>();
    const { deadline, fire } = fakeDeadlines();
    const { auth, calls } = kimiAuth(home, () => {
      sent.resolve();
      return release.promise;
    }, { deadline });
    const pending = auth.getCredentials();
    await sent.promise;
    fire(25_000);
    failsWith(await pending, "timeout");
    assert.equal(calls[0]?.init.signal?.aborted, false);
    release.resolve(renewed());
    assert.equal(bearer(await auth.getCredentials(signal())), `Bearer ${RENEWED}`);
    assert.equal(calls.length, 1);
  });
});

describe("Kimi sign-in: a request that may have left is never sent again", () => {
  const brokenBody = () => new Response(new ReadableStream<Uint8Array>({
    pull: (controller) => controller.error(new Error(`FAKE-broken ${REFRESH}`)),
  }), { status: 200 });
  const outcomes: ReadonlyArray<readonly [string, () => Response]> = [
    ["a connection reset", () => { throw networkError("ECONNRESET"); }],
    ["a 503 reply", () => new Response(`FAKE-busy ${REFRESH}`, { status: 503 })],
    ["a 200 reply that is not JSON", () => new Response(`{"access_token":"FAKE-not-json ${REFRESH}`, { status: 200 })],
    ["a 200 reply with no access token", () => reply({ refresh_token: ROTATED, expires_in: 3600 })],
    ["a reply body that breaks", brokenBody],
    ["a redirect reply", () => new Response(null, { status: 302, headers: { location: "https://elsewhere.invalid/token" } })],
  ];
  for (const [name, answer] of outcomes) {
    it(`gives refresh_recovery_required after ${name}, also after a restart and a long wait`, async (t) => {
      const home = await kimiHome(t, EXPIRED);
      const { auth, calls, clock } = kimiAuth(home, (_, count) => (count === 1 ? answer() : renewed()));
      failsWith(await auth.getCredentials(signal()), "refresh_recovery_required");
      assert.equal((await readMarker(home))["outcome"], "pending");
      clock.now += 3_600_000;
      const restarted = kimiAuth(home, () => renewed());
      restarted.clock.now = clock.now;
      failsWith(await auth.getCredentials(signal()), "refresh_recovery_required");
      failsWith(await restarted.auth.getCredentials(signal()), "refresh_recovery_required");
      assert.equal(calls.length + restarted.calls.length, 1);
      assert.equal((await readRecord(home))["access_token"], ACCESS);
    });
  }

  const backoffs: ReadonlyArray<readonly [string, () => Response, KimiErrorCode]> = [
    ["a failed name lookup", () => { throw networkError("ENOTFOUND"); }, "refresh_unavailable"],
    ["a refused connection", () => { throw networkError("ECONNREFUSED"); }, "refresh_unavailable"],
    ["a 429 reply", () => reply({ error: "rate_limited" }, 429), "refresh_busy"],
    ["an invalid_client reply", () => reply({ error: "invalid_client" }, 401), "refresh_rejected"],
  ];
  for (const [name, answer, code] of backoffs) {
    it(`backs off after ${name} with ${code}, then sends the grant again`, async (t) => {
      const home = await kimiHome(t, EXPIRED);
      const { auth, calls, clock } = kimiAuth(home, (_, count) => (count === 1 ? answer() : renewed()));
      failsWith(await auth.getCredentials(signal()), code);
      const marker = await readMarker(home);
      assert.equal(marker["outcome"], "busy");
      assert.equal(marker["retryAt"], clock.now + 30_000);
      failsWith(await auth.getCredentials(signal()), "refresh_busy");
      assert.equal(calls.length, 1);
      clock.now += 30_001;
      assert.equal(bearer(await auth.getCredentials(signal())), `Bearer ${RENEWED}`);
      assert.equal(calls.length, 2);
    });
  }

  it("marks the grant denied after invalid_grant and gives reauthorization_required with the sign-in hint", async (t) => {
    const home = await kimiHome(t, EXPIRED);
    const raw = await readFile(home.file, "utf8");
    const { auth, calls } = kimiAuth(home, () => reply({ error: "invalid_grant", error_description: "FAKE-detail" }, 400));
    const result = await auth.getCredentials(signal());
    failsWith(result, "reauthorization_required");
    assert.match(messageOf(result), /kimi login/);
    assert.equal((await readMarker(home))["outcome"], "denied");
    failsWith(await auth.getCredentials(signal()), "reauthorization_required");
    assert.equal(calls.length, 1);
    assert.equal(await readFile(home.file, "utf8"), raw, "the file is not changed or emptied");
  });

  it("keeps a due bearer that is still valid when the renewal result is unknown, but not a refused one", async (t) => {
    const home = await kimiHome(t, DUE);
    const { auth, calls, logs } = kimiAuth(home, () => { throw networkError("ECONNRESET"); });
    assert.equal(bearer(await auth.getCredentials(signal())), `Bearer ${ACCESS}`);
    assert.equal(bearer(await auth.getCredentials(signal())), `Bearer ${ACCESS}`);
    assert.equal(calls.length, 1);
    assert.deepEqual(logs.map((entry) => entry.fields), [{ errorCode: "refresh_recovery_required" }, { errorCode: "refresh_recovery_required" }]);
    const refused: ProviderCredential<"kimi"> = { provider: "kimi", authHeaders: { authorization: `Bearer ${ACCESS}` } };
    failsWith(await auth.forceRefresh(signal(), refused), "refresh_recovery_required");
    assert.equal(calls.length, 1);
  });

  it("sends the token request with redirect error, so a redirect gives a fixed code and no write", async (t) => {
    const home = await kimiHome(t, EXPIRED);
    const followed: string[] = [];
    const { auth } = kimiAuth(home, (call) => {
      // The fake acts as fetch does: it follows a redirect unless the request refuses redirects.
      if (call.init.redirect !== "error") {
        followed.push("https://elsewhere.invalid/token");
        return renewed("FAKE-kimi-elsewhere-access-0009");
      }
      throw new TypeError("fetch failed", { cause: new Error("unexpected redirect") });
    });
    failsWith(await auth.getCredentials(signal()), "refresh_recovery_required");
    assert.deepEqual(followed, []);
    assert.equal((await readRecord(home))["access_token"], ACCESS);
  });
});

describe("Kimi sign-in: the Kimi CLI writes the same file", () => {
  const replies: ReadonlyArray<readonly [string, () => Response]> = [
    ["a success", () => renewed()],
    ["an invalid_grant reply", () => reply({ error: "invalid_grant" }, 400)],
    ["a 503 reply", () => new Response("FAKE-busy", { status: 503 })],
  ];
  for (const [name, answer] of replies) {
    it(`adopts a CLI rotation during the renewal and never overwrites it, after ${name}`, async (t) => {
      const home = await kimiHome(t, EXPIRED);
      const { auth, calls } = kimiAuth(home, async () => {
        await writePeer(home);
        return answer();
      });
      assert.equal(bearer(await auth.getCredentials(signal())), `Bearer ${PEER}`);
      assert.equal((await readRecord(home))["access_token"], PEER);
      assert.equal(bearer(await auth.getCredentials(signal())), `Bearer ${PEER}`);
      assert.equal(calls.length, 1);
    });
  }

  it("uses a CLI rotation that lands before the lock, and sends no grant for the refused bearer", async (t) => {
    const home = await kimiHome(t);
    const store: KimiNativeStore = {
      ...home.store,
      withLease: async (leaseSignal, operation) => {
        await writePeer(home);
        return home.store.withLease(leaseSignal, operation);
      },
    };
    const { auth, calls } = kimiAuth(home, () => renewed(), { store });
    const first = await auth.getCredentials(signal());
    assert.ok(first.ok);
    assert.equal(bearer(await auth.forceRefresh(signal(), first.value)), `Bearer ${PEER}`);
    assert.equal(calls.length, 0);
  });
});

describe("Kimi sign-in: the Kimi CLI lock", () => {
  it("gives lock_lost with the hint to run the Kimi CLI once when the lock is lost after the send", async (t) => {
    const home = await kimiHome(t, EXPIRED);
    const raw = await readFile(home.file, "utf8");
    const { auth } = kimiAuth(home, async () => {
      await takeOverLock(home);
      return renewed();
    });
    const result = await auth.getCredentials(signal());
    failsWith(result, "lock_lost");
    assert.match(messageOf(result), /Run the Kimi CLI once/);
    assert.equal(await readFile(home.file, "utf8"), raw);
    assert.ok((await lstat(home.lock)).isDirectory(), "the lock of the process that took over stays");
  });

  it("aborts an open token request with lock_lost when the heartbeat finds the lock lost", async (t) => {
    const home = await kimiHome(t, EXPIRED);
    const raw = await readFile(home.file, "utf8");
    const { auth, calls } = kimiAuth(home, async (call) => {
      await takeOverLock(home);
      return openUntilAbort(call, 1);
    });
    // The heartbeat timer does not hold the process open, so this test does.
    const keepalive = setInterval(() => undefined, 250);
    try {
      failsWith(await auth.getCredentials(signal()), "lock_lost");
    } finally {
      clearInterval(keepalive);
    }
    assert.equal(calls[0]?.init.signal?.aborted, true);
    assert.equal(await readFile(home.file, "utf8"), raw);
  });
});

describe("Kimi sign-in: one renewal queue for each sign-in file", () => {
  it("lets two managers of one file share one renewal, and one abort does not stop it", async (t) => {
    const home = await kimiHome(t, EXPIRED);
    const leases: string[] = [];
    const secondRead = deferred<void>();
    const counting = (store: KimiNativeStore, onRead?: () => void): KimiNativeStore => ({
      ...store,
      read: async (readSignal) => {
        const snapshot = await store.read(readSignal);
        onRead?.();
        return snapshot;
      },
      withLease: (leaseSignal, operation) => {
        leases.push("lease");
        return store.withLease(leaseSignal, operation);
      },
    });
    const sent = deferred<void>(), release = deferred<Response>();
    const answer: Reply = () => {
      sent.resolve();
      return release.promise;
    };
    const first = kimiAuth(home, answer, { store: counting(createKimiNativeStore(home.file)) });
    const second = kimiAuth(home, answer, { store: counting(createKimiNativeStore(home.file), () => secondRead.resolve()) });
    const client = new AbortController();
    const cancelled = first.auth.getCredentials(client.signal);
    await sent.promise;
    const survivor = second.auth.getCredentials(signal());
    await secondRead.promise;
    await delay(10);
    client.abort();
    failsWith(await cancelled, "cancelled");
    release.resolve(renewed());
    assert.equal(bearer(await survivor), `Bearer ${RENEWED}`);
    assert.equal(first.calls.length + second.calls.length, 1);
    assert.deepEqual(leases, ["lease"]);
  });
});

describe("Kimi sign-in: logs, replies and the scrub", () => {
  type Make = (answer: Reply) => ReturnType<typeof kimiAuth>["auth"];
  const failures: ReadonlyArray<readonly [KimiErrorCode, (home: Home, make: Make) => Promise<CredentialResult>]> = [
    ["refresh_required", (_, make) => make(neverAnswer).forceRefresh(signal())],
    ["credential_missing", async (home, make) => {
      await rm(home.file);
      return make(neverAnswer).getCredentials(signal());
    }],
    ["unsafe_path", async (home, make) => {
      await chmod(home.file, 0o640);
      return make(neverAnswer).getCredentials(signal());
    }],
    ["cancelled", (home, make) => make(neverAnswer).getCredentials(AbortSignal.abort(new Error(`FAKE-reason ${home.root}`)))],
    ["reauthorization_required", async (home, make) => {
      await writeFile(home.file, cliText(record(ACCESS, EXPIRED)));
      return make(() => reply({ error: "invalid_grant", error_description: "FAKE-detail" }, 400)).getCredentials(signal());
    }],
    ["refresh_recovery_required", async (home, make) => {
      await writeFile(home.file, cliText(record(ACCESS, EXPIRED)));
      return make(() => { throw networkError("ECONNRESET"); }).getCredentials(signal());
    }],
  ];
  for (const [code, run] of failures) {
    it(`logs ${code} once with its fixed event and code only, and the reply names no path and no token`, async (t) => {
      const home = await kimiHome(t);
      const made: { readonly logs: LogRecord[] }[] = [];
      const result = await run(home, (answer) => {
        const manager = kimiAuth(home, answer);
        made.push(manager);
        return manager.auth;
      });
      const all = made.flatMap((manager) => manager.logs);
      failsWith(result, code);
      assert.deepEqual(all.map(({ event, fields }) => ({ event, fields })), [{ event: KIMI_ERRORS[code].event, fields: { errorCode: code } }]);
      const seen = JSON.stringify(all) + messageOf(result);
      assert.equal(seen.includes(home.root), false, "no path");
      assert.doesNotMatch(seen, /FAKE-/, "no token, reply or cause text");
    });
  }

  it("redacts the new and the previous access token after a Kimi rotation", async (t) => {
    const home = await kimiHome(t);
    const before = "FAKE-kimi-scrub-access-0001", after = "FAKE-kimi-scrub-access-0002";
    await writeFile(home.file, cliText(record(before)));
    const { auth } = kimiAuth(home, () => renewed(after));
    const first = await auth.getCredentials(signal());
    assert.ok(first.ok);
    assert.equal(bearer(await auth.forceRefresh(signal(), first.value)), `Bearer ${after}`);
    // An error of a request that still holds the previous token is redacted too.
    for (const token of [before, after]) {
      assert.equal(toAnthropicErrorBody("api_error", `the upstream refused ${token} here`).includes(token), false, token);
    }
  });
});
