import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, open, mkdir, stat, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodexAuthManager, createFsAuthFileStore, inspectAuthFile, type AuthFileStore } from "../../src/codex-auth.js";
import { noopLogger } from "../../src/logger.js";
import { ok, err } from "../../src/result.js";

const NOW_MS = 1_800_000_000_000;

const makeJwt = (payload: Record<string, unknown>): string => {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.signature`;
};

const accessToken = (expiresInMs: number, accountId = "acct_1234567890"): string =>
  makeJwt({ exp: (NOW_MS + expiresInMs) / 1000, "https://api.openai.com/auth": { chatgpt_account_id: accountId } });

interface MemoryStore extends AuthFileStore {
  content: string;
  writes: string[];
}

const memoryStore = (initial: object): MemoryStore => {
  const store: MemoryStore = {
    content: JSON.stringify(initial),
    writes: [],
    async read() {
      return ok(store.content);
    },
    async writeAtomic(content: string) {
      store.content = content;
      store.writes.push(content);
      return ok(undefined);
    },
  };
  return store;
};

const authFile = (token: string, overrides: Record<string, unknown> = {}): object => ({
  OPENAI_API_KEY: null,
  tokens: { id_token: "id.old.x", access_token: token, refresh_token: "refresh-1", account_id: "acct_1234567890" },
  last_refresh: "2026-07-20T00:00:00.000Z",
  auth_mode: "chatgpt",
  some_future_key: { keep: "me" },
  ...overrides,
});

interface FakeTokenEndpoint {
  fetchImpl: typeof fetch;
  calls: { refresh_token: string }[];
}

const fakeTokenEndpoint = (
  respond: (call: { refresh_token: string }, callIndex: number) => Response | { beforeRespond?: () => void; response: Response },
): FakeTokenEndpoint => {
  const calls: { refresh_token: string }[] = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { refresh_token: string };
    calls.push(body);
    const outcome = respond(body, calls.length - 1);
    if (outcome instanceof Response) return outcome;
    outcome.beforeRespond?.();
    return outcome.response;
  }) as typeof fetch;
  return { fetchImpl, calls };
};

const tokenResponse = (token: string, refreshToken?: string): Response =>
  new Response(
    JSON.stringify({ access_token: token, id_token: "id.new.x", ...(refreshToken !== undefined ? { refresh_token: refreshToken } : {}) }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const manager = (store: AuthFileStore, endpoint: FakeTokenEndpoint): CodexAuthManager =>
  new CodexAuthManager({
    store,
    oauthTokenUrl: "http://oauth.test/token",
    logger: noopLogger,
    fetchImpl: endpoint.fetchImpl,
    now: () => NOW_MS,
  });

describe("CodexAuthManager", () => {
  it("serves a fresh token without touching the token endpoint", async () => {
    const store = memoryStore(authFile(accessToken(3_600_000)));
    const endpoint = fakeTokenEndpoint(() => tokenResponse(accessToken(3_600_000)));
    const result = await manager(store, endpoint).getCredentials();
    assert.ok(result.ok);
    // The manager's public contract is a branded credential carrying auth headers, not
    // the ChatGPT token pair: the pair stays private to codex-auth.ts. These are the two
    // headers the Codex leg has always sent, asserted at the boundary that now produces them.
    assert.equal(result.value.provider, "codex", "the brand must name the provider these headers belong to");
    assert.deepEqual(Object.keys(result.value.authHeaders).sort(), ["authorization", "chatgpt-account-id"]);
    assert.equal(result.value.authHeaders["chatgpt-account-id"], "acct_1234567890");
    assert.equal(endpoint.calls.length, 0);
    assert.equal(store.writes.length, 0);
  });

  it("proactively refreshes a token expiring within the margin and preserves unknown keys", async () => {
    const newToken = accessToken(3_600_000);
    const store = memoryStore(authFile(accessToken(60_000)));
    const endpoint = fakeTokenEndpoint(() => tokenResponse(newToken, "refresh-2"));
    const result = await manager(store, endpoint).getCredentials();
    assert.ok(result.ok);
    assert.equal(result.value.authHeaders["authorization"], `Bearer ${newToken}`);
    assert.equal(endpoint.calls.length, 1);
    assert.equal(endpoint.calls[0]!.refresh_token, "refresh-1");

    const written = JSON.parse(store.content) as Record<string, unknown>;
    assert.deepEqual(written["some_future_key"], { keep: "me" });
    assert.equal(written["OPENAI_API_KEY"], null);
    const tokens = written["tokens"] as Record<string, unknown>;
    assert.equal(tokens["access_token"], newToken);
    assert.equal(tokens["refresh_token"], "refresh-2");
    assert.equal(written["last_refresh"], new Date(NOW_MS).toISOString());
  });

  it("retries once with the file's token after invalid_grant from an external rotation", async () => {
    const newToken = accessToken(3_600_000);
    const store = memoryStore(authFile(accessToken(60_000)));
    const endpoint = fakeTokenEndpoint((call) => {
      if (call.refresh_token === "refresh-1") {
        // Simulate the Codex CLI rotating the token between our read and our call.
        store.content = JSON.stringify(authFile(accessToken(60_000), {}));
        const updated = JSON.parse(store.content) as { tokens: Record<string, unknown> };
        updated.tokens["refresh_token"] = "refresh-rotated";
        store.content = JSON.stringify(updated);
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      }
      return tokenResponse(newToken);
    });
    const result = await manager(store, endpoint).getCredentials();
    assert.ok(result.ok);
    assert.equal(result.value.authHeaders["authorization"], `Bearer ${newToken}`);
    assert.deepEqual(
      endpoint.calls.map((call) => call.refresh_token),
      ["refresh-1", "refresh-rotated"],
    );
  });

  it("fails with an actionable error after invalid_grant with no rotation, within the 2-call bound", async () => {
    const store = memoryStore(authFile(accessToken(60_000)));
    const endpoint = fakeTokenEndpoint(() => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));
    const result = await manager(store, endpoint).getCredentials();
    assert.ok(!result.ok);
    assert.equal(result.error.kind, "auth");
    assert.match(result.error.message, /codex login/);
    assert.equal(endpoint.calls.length, 1);
  });

  it("single-flights concurrent refreshes", async () => {
    const store = memoryStore(authFile(accessToken(60_000)));
    const endpoint = fakeTokenEndpoint(() => tokenResponse(accessToken(3_600_000)));
    const auth = manager(store, endpoint);
    const [a, b, c] = await Promise.all([auth.getCredentials(), auth.getCredentials(), auth.getCredentials()]);
    assert.ok(a!.ok && b!.ok && c!.ok);
    assert.equal(endpoint.calls.length, 1);
  });

  it("lets a newer auth file win over its own refresh result", async () => {
    const cliToken = accessToken(3_600_000, "acct_1234567890");
    const store = memoryStore(authFile(accessToken(60_000)));
    const endpoint = fakeTokenEndpoint(() => ({
      beforeRespond: () => {
        // The CLI finished its own refresh while ours was in flight.
        store.content = JSON.stringify(
          authFile(cliToken, { last_refresh: new Date(NOW_MS + 5_000).toISOString() }, ),
        );
        const updated = JSON.parse(store.content) as { tokens: Record<string, unknown> };
        updated.tokens["refresh_token"] = "refresh-cli";
        store.content = JSON.stringify({ ...JSON.parse(store.content) as object, tokens: updated.tokens });
      },
      response: tokenResponse(accessToken(3_600_000)),
    }));
    const result = await manager(store, endpoint).getCredentials();
    assert.ok(result.ok);
    assert.equal(
      result.value.authHeaders["authorization"],
      `Bearer ${cliToken}`,
      "credentials should come from the newer file",
    );
    assert.equal(store.writes.length, 0, "the CLI's rotated refresh token must not be clobbered");
  });

  it("degrades to an auth error when the file is missing", async () => {
    const store: AuthFileStore = {
      read: async () => err({ kind: "auth", message: "cannot read codex auth file at /nope — run `codex login`" }),
      writeAtomic: async () => ok(undefined),
    };
    const endpoint = fakeTokenEndpoint(() => tokenResponse(accessToken(3_600_000)));
    const result = await new CodexAuthManager({
      store,
      oauthTokenUrl: "http://oauth.test/token",
      logger: noopLogger,
      fetchImpl: endpoint.fetchImpl,
      now: () => NOW_MS,
    }).getCredentials();
    assert.ok(!result.ok);
    assert.equal(result.error.kind, "auth");
    assert.equal(endpoint.calls.length, 0);
  });

  /**
   * RELI-04: callTokenEndpoint must pass a timeout signal to the fetch implementation.
   *
   * Without AbortSignal.timeout(15_000), a hung OAuth server holds the single-flight
   * refreshInflight promise open indefinitely — all 32 concurrent requests share one
   * hung promise, filling all concurrency slots and returning 503 until undici's ~300 s
   * default fires.
   *
   * Mutation that MUST turn this RED: remove `signal: AbortSignal.timeout(15_000)` from
   * the callTokenEndpoint fetch call → capturedSignal is undefined → assertion fails.
   *
   * PF-011: proven RED against the named mutation before trusting green.
   */
  it("RELI-04 — callTokenEndpoint passes a timeout signal to the fetch implementation", async () => {
    const store = memoryStore(authFile(accessToken(60_000))); // near-expiry → triggers refresh
    let capturedSignal: AbortSignal | undefined;

    const auth = new CodexAuthManager({
      store,
      oauthTokenUrl: "http://oauth.test/token",
      logger: noopLogger,
      fetchImpl: async (_url, init) => {
        capturedSignal = (init?.signal ?? undefined) as AbortSignal | undefined;
        // Return a valid token response so the refresh completes.
        return new Response(
          JSON.stringify({ access_token: accessToken(3_600_000) }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
      now: () => NOW_MS,
    });

    await auth.getCredentials();

    assert.ok(capturedSignal !== undefined, "callTokenEndpoint must pass a signal to fetch");
    assert.ok(!capturedSignal.aborted, "signal must not be pre-aborted when the request starts");
  });

  /**
   * RELI-05: forceRefresh() must honour a 30-second cooldown window.
   *
   * A persistent upstream 401 that survives a freshly-minted token cannot be resolved by
   * re-running the same OAuth cycle. Without this floor, each request in a 401 storm runs
   * its own token-endpoint call + fsync'd credential rewrite, permanently degrading the
   * server once all concurrency slots fill.
   *
   * Mutation that MUST turn this RED: remove the cooldown guard (always refresh).
   * Without it the second forceRefresh() within the window calls the token endpoint;
   * endpoint.calls.length increases → assert.equal(endpoint.calls.length, callsAfterFirst)
   * fails.
   *
   * PF-011: proven RED against the named mutation before trusting green.
   */
  it("RELI-05 — forceRefresh skips the token endpoint within the 30-second cooldown window", async () => {
    let nowMs = NOW_MS;
    const store = memoryStore(authFile(accessToken(60_000))); // near-expiry → triggers refresh
    const endpoint = fakeTokenEndpoint(() => tokenResponse(accessToken(3_600_000)));
    const auth = new CodexAuthManager({
      store,
      oauthTokenUrl: "http://oauth.test/token",
      logger: noopLogger,
      fetchImpl: endpoint.fetchImpl,
      now: () => nowMs,
    });

    // First forceRefresh: no prior lastForcedRefreshMs, so it runs a real refresh.
    const first = await auth.forceRefresh();
    assert.ok(first.ok, "first forceRefresh must succeed");
    const callsAfterFirst = endpoint.calls.length;
    assert.ok(callsAfterFirst >= 1, "first forceRefresh must have called the token endpoint");

    // Second forceRefresh within the cooldown window must NOT hit the token endpoint.
    nowMs += 10_000; // 10 seconds later — still within the 30-second window
    const second = await auth.forceRefresh();
    assert.ok(second.ok, "second forceRefresh (within cooldown) must return a credential");
    assert.equal(
      endpoint.calls.length,
      callsAfterFirst,
      "forceRefresh within the cooldown window must not call the token endpoint",
    );

    // After the cooldown expires, forceRefresh must run a real refresh again.
    nowMs += 25_000; // 35 seconds total — past the 30-second window
    const third = await auth.forceRefresh();
    assert.ok(third.ok, "third forceRefresh (after cooldown expiry) must succeed");
    assert.ok(
      endpoint.calls.length > callsAfterFirst,
      "forceRefresh after the cooldown window must call the token endpoint",
    );
  });
});

describe("inspectAuthFile", () => {
  it("summarizes without exposing token material", () => {
    const token = accessToken(3_600_000);
    const result = inspectAuthFile(JSON.stringify(authFile(token)));
    assert.ok(result.ok);
    assert.equal(result.value.authMode, "chatgpt");
    assert.equal(result.value.accountIdSuffix, "…567890");
    assert.equal(result.value.accessTokenExpiresAt, new Date(NOW_MS + 3_600_000).toISOString());
    assert.equal(JSON.stringify(result.value).includes(token), false);
  });

  it("rejects corrupt files", () => {
    assert.ok(!inspectAuthFile("not json").ok);
    assert.ok(!inspectAuthFile('{"tokens":{}}').ok);
  });
});

/**
 * createFsAuthFileStore — O_EXCL and cleanup tests.
 *
 * These test the REAL file-system implementation, not the in-memory stub, so they can
 * verify the security properties of the atomic write path.
 *
 * The temp path the store constructs is: `${path}.subswitch-${process.pid}.tmp`.
 * Tests derive this the same way so they can set up preconditions and inspect residue.
 */
describe("createFsAuthFileStore — O_EXCL and cleanup", () => {
  /** Returns authFilePath (auth.json inside a fresh temp dir) and the derived tmpPath. */
  const makePaths = async (prefix: string): Promise<{ authFilePath: string; tmpPath: string }> => {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    const authFilePath = join(dir, "auth.json");
    return { authFilePath, tmpPath: `${authFilePath}.subswitch-${process.pid}.tmp` };
  };

  /**
   * T4a: a stale temp file (EEXIST) must be detected, unlinked, and the open retried — so
   * a previous crash does not permanently block credential rotation.
   *
   * The "stale crash temp" scenario: process P crashed between open() and rename(), leaving
   * `auth.json.subswitch-<pid>.tmp` on disk. When we next call writeAtomic(), we get EEXIST
   * on the "wx" open. The fix: unlink the stale file and retry once (RELI-02).
   *
   * Mutation that MUST turn this RED: remove the EEXIST unlink-and-retry handler.
   * Without it, EEXIST propagates to the outer catch, returning err({ kind: "auth" });
   * the assertion assert.ok(result.ok) fails.
   *
   * PF-011: proven RED against the named mutation before trusting green.
   */
  it("T4a — stale temp (EEXIST) is unlinked and write retried; auth.json created, no .tmp survives", async () => {
    const { authFilePath, tmpPath } = await makePaths("croxy-t4a-");

    // Pre-create the temp file to simulate a stale crash artifact.
    const stale = await open(tmpPath, "w", 0o666);
    await stale.close();

    const store = createFsAuthFileStore(authFilePath);
    const result = await store.writeAtomic('{"replaced": true}');

    // The stale temp must be detected (EEXIST), unlinked, and the open retried — succeeding.
    assert.ok(result.ok, "writeAtomic must recover from a stale temp via EEXIST → unlink → retry");

    // auth.json must now exist (write succeeded and temp was renamed).
    await assert.doesNotReject(
      access(authFilePath),
      "auth.json must be created after self-healing from a stale temp",
    );

    // The temp file must not survive (renamed to auth.json on success).
    await assert.rejects(
      access(tmpPath),
      "no .tmp must survive after a successful writeAtomic",
    );
  });

  /**
   * T4b: when rename fails (auth path is a directory → EISDIR), no .tmp must survive.
   *
   * Mutation that MUST turn this red: delete the unlink(tmpPath) in the catch block.
   * Under the mutation, the temp file is left at tmpPath after the rename fails.
   *
   * PF-011: proven RED against the named mutation before trusting green.
   */
  it("T4b — rename failure (EISDIR) leaves no .tmp file behind", async () => {
    const { authFilePath, tmpPath } = await makePaths("croxy-t4b-");

    // Place a directory at the auth path so rename(tmpPath, authFilePath) fails with EISDIR.
    await mkdir(authFilePath);

    const store = createFsAuthFileStore(authFilePath);
    const result = await store.writeAtomic('{"data": "irrelevant"}');

    // Write must fail (rename over a directory is rejected on all platforms).
    assert.ok(!result.ok, "writeAtomic must fail when rename target is a directory");
    assert.equal(result.error.kind, "auth");

    // The temp file must have been cleaned up by the catch block's unlink.
    await assert.rejects(
      access(tmpPath),
      "temp file must be removed even when rename fails",
    );
  });

  /**
   * T4c — mode pin: auth.json must be created with mode 0o600 (no group/other bits).
   *
   * NOTE — SCOPE LIMIT: this test pins the mode argument and does NOT prove the O_EXCL
   * behaviour. It is green on the pre-fix code (which already passed 0o600) and on the
   * fixed code. Its mutation target (dropping the mode argument) is orthogonal to T4a.
   * Do not read it as a security proof for O_EXCL.
   *
   * Mutation that MUST turn this red: drop the 0o600 argument from open().
   * Without an explicit mode the OS applies the default (0o666 masked by umask, typically
   * 0o644), which leaks read permission to the group — mode & 0o077 becomes non-zero.
   *
   * PF-011: proven RED against the named mutation before trusting green.
   */
  it("T4c [mode-only, does NOT prove O_EXCL] — auth.json is created with mode 0o600", async () => {
    const { authFilePath } = await makePaths("croxy-t4c-");

    const store = createFsAuthFileStore(authFilePath);
    const result = await store.writeAtomic('{"tokens": {"access_token": "tok"}}');
    assert.ok(result.ok, "writeAtomic must succeed on a fresh path");

    const fileStat = await stat(authFilePath);
    // S_IRWXG and S_IRWXO bits must be zero — no permissions for group or other.
    assert.equal(
      fileStat.mode & 0o077,
      0,
      `auth.json must have mode 0o600, got 0o${(fileStat.mode & 0o777).toString(8)}`,
    );
  });
});
