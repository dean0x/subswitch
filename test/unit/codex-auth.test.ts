import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CodexAuthManager, inspectAuthFile, type AuthFileStore } from "../../src/codex-auth.js";
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
    assert.equal(result.value.accountId, "acct_1234567890");
    assert.equal(endpoint.calls.length, 0);
    assert.equal(store.writes.length, 0);
  });

  it("proactively refreshes a token expiring within the margin and preserves unknown keys", async () => {
    const newToken = accessToken(3_600_000);
    const store = memoryStore(authFile(accessToken(60_000)));
    const endpoint = fakeTokenEndpoint(() => tokenResponse(newToken, "refresh-2"));
    const result = await manager(store, endpoint).getCredentials();
    assert.ok(result.ok);
    assert.equal(result.value.accessToken, newToken);
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
    assert.equal(result.value.accessToken, newToken);
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
    assert.equal(result.value.accessToken, cliToken, "credentials should come from the newer file");
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
