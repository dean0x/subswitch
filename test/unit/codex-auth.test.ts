import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, open, mkdir, stat, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodexAuthManager, createFsAuthFileStore, inspectAuthFile, type AuthFileStore } from "../../src/codex-auth.js";
import { noopLogger } from "../../src/logger.js";
import { providerEvents } from "../../src/provider-events.js";
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
    events: providerEvents("codex"),
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
      events: providerEvents("codex"),
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
   * refreshInflight promise open indefinitely — every concurrent request that needs a token
   * shares the one hung promise, blocking until undici's ~300 s default fires.
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
      events: providerEvents("codex"),
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
   * its own token-endpoint call and fsync'd credential rewrite, flooding the token endpoint.
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
      events: providerEvents("codex"),
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

  // -------------------------------------------------------------------------
  // Auth event names are table-derived (avoids ARCH-05 / CONS-01).
  //
  // These tests use a recording logger and assert the logged event name equals
  // the events record's field value.  Because the events record is built from
  // the closed ProviderId union via providerEvents(), a hardcoded string literal
  // that happened to match today would become a tsc error the moment it was
  // written inside a generic function — the type-level gate is the primary
  // control.  The tests here are the runtime half: they confirm the manager
  // actually READS from the events record it was handed, not from an internal
  // constant, so a future addition of a second provider id cannot silently emit
  // a misnamed event.
  //
  // PF-011 / PF-012: each control below has a named falsifier.
  // -------------------------------------------------------------------------

  /**
   * tokenRefreshed is emitted on a successful refresh cycle.
   *
   * Falsifier: replace `this.events.tokenRefreshed` in doRefresh() with a
   * hardcoded string that does not match the events record's value → the
   * `events.includes(events.tokenRefreshed)` assertion fails.
   */
  it("emits events.tokenRefreshed after a successful token-endpoint call", async () => {
    const loggedEvents: string[] = [];
    const recordingLogger = { log: (_level: string, event: string) => { loggedEvents.push(event); } };
    const events = providerEvents("codex");
    const store = memoryStore(authFile(accessToken(60_000))); // near-expiry → triggers refresh
    const endpoint = fakeTokenEndpoint(() => tokenResponse(accessToken(3_600_000)));

    const auth = new CodexAuthManager({
      store,
      oauthTokenUrl: "http://oauth.test/token",
      logger: recordingLogger,
      events,
      fetchImpl: endpoint.fetchImpl,
      now: () => NOW_MS,
    });

    const result = await auth.getCredentials();
    assert.ok(result.ok, "refresh must succeed");
    assert.ok(
      loggedEvents.includes(events.tokenRefreshed),
      `tokenRefreshed event must be logged via the events record; logged: ${loggedEvents.join(", ")}`,
    );
  });

  /**
   * tokenRefreshFailed is emitted when the token endpoint returns invalid_grant
   * with no external rotation available (single attempt, no continue).
   *
   * Falsifier: replace `this.events.tokenRefreshFailed` with a hardcoded string
   * → the includes() assertion fails.
   */
  it("emits events.tokenRefreshFailed when the token endpoint rejects the refresh", async () => {
    const loggedEvents: string[] = [];
    const recordingLogger = { log: (_level: string, event: string) => { loggedEvents.push(event); } };
    const events = providerEvents("codex");
    const store = memoryStore(authFile(accessToken(60_000)));
    const endpoint = fakeTokenEndpoint(() => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));

    const auth = new CodexAuthManager({
      store,
      oauthTokenUrl: "http://oauth.test/token",
      logger: recordingLogger,
      events,
      fetchImpl: endpoint.fetchImpl,
      now: () => NOW_MS,
    });

    const result = await auth.getCredentials();
    assert.ok(!result.ok, "refresh must fail");
    assert.ok(
      loggedEvents.includes(events.tokenRefreshFailed),
      `tokenRefreshFailed event must be logged via the events record; logged: ${loggedEvents.join(", ")}`,
    );
  });

  /**
   * refreshTokenRotatedExternally is emitted when a concurrent process rotated
   * the refresh token between our read and our call, and we re-read and retry.
   *
   * Falsifier: replace `this.events.refreshTokenRotatedExternally` with a
   * hardcoded string → the includes() assertion fails.
   */
  it("emits events.refreshTokenRotatedExternally when a concurrent process rotated the token", async () => {
    const loggedEvents: string[] = [];
    const recordingLogger = { log: (_level: string, event: string) => { loggedEvents.push(event); } };
    const events = providerEvents("codex");
    const store = memoryStore(authFile(accessToken(60_000)));
    const newToken = accessToken(3_600_000);
    const endpoint = fakeTokenEndpoint((call) => {
      if (call.refresh_token === "refresh-1") {
        // Simulate external rotation — update store with a different refresh token.
        const updated = JSON.parse(store.content) as { tokens: Record<string, unknown> };
        updated.tokens["refresh_token"] = "refresh-rotated";
        store.content = JSON.stringify(updated);
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      }
      return tokenResponse(newToken);
    });

    const auth = new CodexAuthManager({
      store,
      oauthTokenUrl: "http://oauth.test/token",
      logger: recordingLogger,
      events,
      fetchImpl: endpoint.fetchImpl,
      now: () => NOW_MS,
    });

    const result = await auth.getCredentials();
    assert.ok(result.ok, "refresh must succeed after using the rotated token");
    assert.ok(
      loggedEvents.includes(events.refreshTokenRotatedExternally),
      `refreshTokenRotatedExternally must be logged via the events record; logged: ${loggedEvents.join(", ")}`,
    );
  });

  /**
   * authFileWriteFailed is emitted when writeAtomic fails.
   *
   * Falsifier: replace `this.events.authFileWriteFailed` with a hardcoded string
   * → the includes() assertion fails.
   */
  // -------------------------------------------------------------------------
  // Concurrent-refresh guard: identity-check correctness
  //
  // These tests cover the cases where the previous string-lexicographic comparison
  // was insufficient. The guard must fire when the on-disk refresh_token differs from
  // the one we sent — independent of timestamp format differences or same-second writes.
  // -------------------------------------------------------------------------

  /**
   * Format divergence: the CLI writes last_refresh with a different precision (e.g.,
   * no milliseconds, or 6/9 fractional digits) but a genuinely rotated refresh_token.
   * The string `>` comparison would fail if the formats differ and the timestamp is not
   * lexicographically greater; the identity check is format-independent.
   *
   * Assert: guard fires (no write), file's material returned.
   */
  it("guard fires on format-diverged last_refresh when refresh_token differs (identity check)", async () => {
    const cliToken = accessToken(3_600_000, "acct_1234567890");
    // Falsifier: baseline is "2027-01-15T08:00:00.000Z" and the file writes epoch-millis
    // "1800000005000" (5 s later). Lexicographically "1..." < "2..." so the old string >
    // comparison returns false and the guard does NOT fire → the test fails on main, proving
    // the fixture exercises the identity-check path on the branch.
    const store = memoryStore(authFile(accessToken(60_000), { last_refresh: "2027-01-15T08:00:00.000Z" }));
    const endpoint = fakeTokenEndpoint(() => ({
      beforeRespond: () => {
        // CLI writes last_refresh as raw epoch-millis ("1800000005000"), which sorts
        // lexicographically before any ISO date starting with "2" — the old string >
        // comparison misses this; the identity check on refresh_token fires instead.
        store.content = JSON.stringify({
          ...authFile(cliToken),
          last_refresh: "1800000005000",
          tokens: {
            ...(JSON.parse(JSON.stringify(authFile(cliToken))) as { tokens: Record<string, unknown> }).tokens,
            access_token: cliToken,
            refresh_token: "refresh-cli-rotated",
          },
        });
      },
      response: tokenResponse(accessToken(3_600_000)),
    }));

    const result = await manager(store, endpoint).getCredentials();
    assert.ok(result.ok, "should succeed using the file's material");
    assert.equal(
      result.value.authHeaders["authorization"],
      `Bearer ${cliToken}`,
      "credentials should come from the newer file, not our response",
    );
    assert.equal(store.writes.length, 0, "the CLI's rotated refresh_token must not be clobbered");
  });

  /**
   * Same-second collision: the file has the SAME last_refresh timestamp as the baseline
   * (two writes landed in the same second) but a different refresh_token — the CLI rotated
   * it. The string `>` comparison returns false for equal timestamps; identity check fires.
   *
   * Assert: guard fires (no write), file's material returned.
   */
  it("guard fires in the same-second collision case via identity check", async () => {
    const cliToken = accessToken(3_600_000, "acct_1234567890");
    const baselineRefresh = "2026-07-20T00:00:00.000Z"; // matches authFile default
    const store = memoryStore(authFile(accessToken(60_000)));
    const endpoint = fakeTokenEndpoint(() => ({
      beforeRespond: () => {
        // Same last_refresh as the baseline — string `>` would be false, guard would miss.
        store.content = JSON.stringify({
          ...authFile(cliToken),
          last_refresh: baselineRefresh,
          tokens: {
            ...(JSON.parse(JSON.stringify(authFile(cliToken))) as { tokens: Record<string, unknown> }).tokens,
            access_token: cliToken,
            refresh_token: "refresh-cli-same-second",
          },
        });
      },
      response: tokenResponse(accessToken(3_600_000)),
    }));

    const result = await manager(store, endpoint).getCredentials();
    assert.ok(result.ok, "should succeed using the file's material");
    assert.equal(
      result.value.authHeaders["authorization"],
      `Bearer ${cliToken}`,
      "credentials should come from the file even on same-second collision",
    );
    assert.equal(store.writes.length, 0, "same-second collision must not clobber the file");
  });

  /**
   * Fix 2: fileIsNewer is true but materialFrom fails (malformed access_token in the
   * newer file). The guard fires — no write occurs. The branch serves our own valid
   * refresh result from memory so the request still succeeds.
   *
   * Assert: no write occurs, result is a success using our own refresh tokens.
   */
  it("does not write when fileIsNewer is true but materialFrom fails", async () => {
    const freshToken = accessToken(3_600_000);
    const store = memoryStore(authFile(accessToken(60_000)));
    const endpoint = fakeTokenEndpoint(() => ({
      beforeRespond: () => {
        // File has a different refresh_token (guard fires) but no account_id and a
        // non-JWT access_token, so materialFrom cannot extract an accountId and returns err.
        // account_id is deliberately absent here — materialFrom falls through to jwtAccountId,
        // which also fails on "not-a-valid-jwt", so the result is err.
        store.content = JSON.stringify({
          OPENAI_API_KEY: null,
          auth_mode: "chatgpt",
          last_refresh: new Date(NOW_MS + 5_000).toISOString(),
          tokens: {
            id_token: "id.old.x",
            access_token: "not-a-valid-jwt",
            // no account_id — forces materialFrom to try jwtAccountId, which also fails
            refresh_token: "refresh-cli-rotated",
          },
        });
      },
      response: tokenResponse(freshToken),
    }));

    const result = await manager(store, endpoint).getCredentials();
    assert.ok(result.ok, "should succeed serving our own valid refresh result from memory");
    assert.equal(
      result.value.authHeaders["authorization"],
      `Bearer ${freshToken}`,
      "credentials should come from our own refresh result, not the malformed file",
    );
    assert.equal(store.writes.length, 0, "must not write when materialFrom fails on the newer file");
  });

  /**
   * I-036: When fileIsNewer is true but materialFrom fails on the newer file, and the
   * token endpoint returned a rotated refresh_token, the rotated credential is served
   * from memory but never persisted. This outcome must be logged at ERROR (matching the
   * write-failure branch's escalation rule) so operators can diagnose invalid_grant on
   * the next OAuth cycle.
   *
   * Falsifier: remove the `if (tokens.refresh_token !== undefined)` error-log block
   * added in the materialFrom-failed fallback → the "error"-level assertion fails.
   */
  it("emits events.authFileWriteFailed at error when fileIsNewer+materialFrom-failed and refresh_token was rotated (I-036)", async () => {
    const loggedCalls: { level: string; event: string }[] = [];
    const recordingLogger = { log: (level: string, event: string) => { loggedCalls.push({ level, event }); } };
    const events = providerEvents("codex");
    const freshToken = accessToken(3_600_000);
    const store = memoryStore(authFile(accessToken(60_000)));

    const endpoint = fakeTokenEndpoint(() => ({
      beforeRespond: () => {
        // Disk file has a different refresh_token (guard fires) but a malformed
        // access_token and no account_id — materialFrom returns err on the disk file.
        store.content = JSON.stringify({
          OPENAI_API_KEY: null,
          auth_mode: "chatgpt",
          last_refresh: new Date(NOW_MS + 5_000).toISOString(),
          tokens: {
            id_token: "id.old.x",
            access_token: "not-a-valid-jwt",
            refresh_token: "refresh-cli-rotated",
            // no account_id — forces materialFrom to fail
          },
        });
      },
      // Token endpoint returned a rotated refresh_token — the credential that will be
      // silently lost unless the error is surfaced.
      response: tokenResponse(freshToken, "refresh-our-rotated"),
    }));

    const auth = new CodexAuthManager({
      store,
      oauthTokenUrl: "http://oauth.test/token",
      logger: recordingLogger,
      events,
      fetchImpl: endpoint.fetchImpl,
      now: () => NOW_MS,
    });

    const result = await auth.getCredentials();
    assert.ok(result.ok, "should succeed serving our own refresh result from memory");

    const errorCalls = loggedCalls.filter((c) => c.level === "error" && c.event === events.authFileWriteFailed);
    assert.equal(
      errorCalls.length,
      1,
      `authFileWriteFailed must be logged at error when a rotated refresh_token goes unpersisted; logged: ${JSON.stringify(loggedCalls)}`,
    );
  });

  it("emits events.authFileWriteFailed when writeAtomic fails during token persistence", async () => {
    const loggedEvents: string[] = [];
    const recordingLogger = { log: (_level: string, event: string) => { loggedEvents.push(event); } };
    const events = providerEvents("codex");
    // A store whose read succeeds but write always fails.
    const failingWriteStore: AuthFileStore = {
      async read() { return ok(JSON.stringify(authFile(accessToken(60_000)))); },
      async writeAtomic() { return err({ kind: "auth", message: "disk full" }); },
    };
    const endpoint = fakeTokenEndpoint(() => tokenResponse(accessToken(3_600_000)));

    const auth = new CodexAuthManager({
      store: failingWriteStore,
      oauthTokenUrl: "http://oauth.test/token",
      logger: recordingLogger,
      events,
      fetchImpl: endpoint.fetchImpl,
      now: () => NOW_MS,
    });

    // The refresh itself still serves the fresh token even though persistence failed.
    await auth.getCredentials();
    assert.ok(
      loggedEvents.includes(events.authFileWriteFailed),
      `authFileWriteFailed must be logged via the events record; logged: ${loggedEvents.join(", ")}`,
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
