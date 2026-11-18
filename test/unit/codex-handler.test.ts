import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createCodexHandler, buildHeaders, type CodexTransportConstants } from "../../src/codex-handler.js";
import { noopLogger } from "../../src/logger.js";
import { ReasoningCache } from "../../src/reasoning-cache.js";
import { CodexAuthManager, type AuthFileStore } from "../../src/codex-auth.js";
import type { ProviderAuth, ProviderCredential } from "../../src/provider-auth.js";
import { providerEvents } from "../../src/provider-events.js";
import { ok } from "../../src/result.js";
import { loadConfig, providerConfigFor, type Config, type CodexProviderConfig } from "../../src/config.js";
import type { ProviderId } from "../../src/models.js";

/**
 * SYNTHETIC-PROVIDER CAST — the single sanctioned cast in this file.
 *
 * `ProviderId` is the one-member union `"codex"` today, so a handler that only ever
 * receives `"codex"` cannot distinguish a threaded provider id from a hardcoded
 * literal. Casting through `string` (a direct `as ProviderId` is rejected outright)
 * supplies the second value that makes those assertions falsifiable.
 *
 * Remove this and its callers when a second real provider lands and PROVIDER_IDS
 * expands. (mirrors test/unit/routing-table.test.ts)
 */
const otherProviderName: string = "kimi";
const OTHER_PROVIDER = otherProviderName as ProviderId;

/**
 * Build handler deps from a loaded config, exactly as `createCodexProvider` does in
 * server.ts. Kept in one place so a test cannot accidentally hand the handler a
 * different slice than production does.
 */
const codexDepsFrom = (config: Config) => ({
  providerId: "codex" as ProviderId,
  provider: config.providers.codex,
  pingIntervalMs: config.limits.pingIntervalMs,
  loginCommand: providerConfigFor(config, "codex").loginCommand,
});

/**
 * P4: ProviderHandler.handleMessages must use the pre-parsed body directly and must
 * NOT call JSON.parse on rawBody.
 *
 * Context: the server calls JSON.parse exactly once to peek the model for routing,
 * then passes the result as `parsed: unknown` to the handler. A second JSON.parse
 * call inside the handler wastes ~40 ms on a 32 MiB body (70–340× the streaming
 * translation overhead). This test pins the contract structurally.
 *
 * Method: pass a `parsedBody` that fails AnthropicRequestSchema (null) alongside
 * a `rawBody` that IS a valid AnthropicRequest. If the handler uses `parsedBody`,
 * schema validation fails → 400. If the handler calls JSON.parse(rawBody), schema
 * succeeds → auth stub fails → 401. The status code is the discriminator.
 */

// Stub auth file store that always fails on read so auth errors out immediately.
// This is the shortest path through handleMessages that still exercises the
// JSON-parse-free contract (schema check runs before auth).
const stubStore: AuthFileStore = {
  async read() {
    return { ok: false as const, error: { kind: "auth" as const, message: "stub auth — read always fails" } };
  },
  async writeAtomic() {
    return { ok: true as const, value: undefined };
  },
};

// Minimal ServerResponse stub. Tracks statusCode written via writeHead so tests
// can assert which error path the handler took.
class StubResponse extends EventEmitter {
  public statusCode = 0;
  public writableEnded = false;
  public writableFinished = false;
  public destroyed = false;
  public headersSent = false;
  public socket = { setNoDelay: () => undefined };
  /** Everything handed to write()/end(), so tests can assert on the rendered body. */
  public body = "";

  writeHead(status: number, _headers?: Record<string, string>): this {
    this.statusCode = status;
    this.headersSent = true;
    return this;
  }

  write(data: unknown): boolean {
    if (typeof data === "string") this.body += data;
    return true;
  }

  end(data?: unknown): this {
    if (typeof data === "string") this.body += data;
    this.writableEnded = true;
    return this;
  }

  destroy(): void {
    this.destroyed = true;
  }
}

describe("P4 — ProviderHandler.handleMessages uses pre-parsed body, not rawBody", () => {
  it("returns 400 (schema fail on null parsedBody) rather than 401 (auth fail after valid parse)", async () => {
    const configResult = loadConfig({
      configPath: "inline-p4-test.json",
      readFile: () => JSON.stringify({ logLevel: "error" }),
    });
    assert.ok(configResult.ok, "config load should succeed");

    const cache = new ReasoningCache(4, 1024);
    const auth = new CodexAuthManager({
      store: stubStore,
      oauthTokenUrl: "http://localhost/fake-oauth",
      logger: noopLogger,
      events: providerEvents("codex"),
    });
    const handler = createCodexHandler({
      ...codexDepsFrom(configResult.value.config),
      logger: noopLogger,
      auth,
      cache,
    });

    // rawBody is a valid AnthropicRequest — if the handler calls JSON.parse(rawBody)
    // schema validation would succeed and the path would reach auth (→ 401).
    const rawBody = Buffer.from(
      JSON.stringify({ model: "gpt-5.5", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }),
    );

    // parsedBody is null — schema validation must fail immediately (→ 400).
    // This is the discriminator: 400 proves parsedBody was used; 401 would mean rawBody was re-parsed.
    const parsedBody: unknown = null;

    const res = new StubResponse() as unknown as ServerResponse;
    const req = new EventEmitter() as unknown as IncomingMessage;

    await handler.handleMessages(req, res, rawBody, parsedBody, "gpt-5.5");

    assert.equal(
      (res as unknown as StubResponse).statusCode,
      400,
      "handler must return 400 (schema fail on null parsedBody), not 401 (which would mean rawBody was re-parsed)",
    );
  });
});

/**
 * Call-site threading of `aggregateFrames(frames, providerId)`.
 *
 * `aggregateFrames`' second parameter is now required, so the argument cannot simply
 * be dropped — but it can still be given the wrong value (a literal `"codex"` rather
 * than the handler's own `providerId`), and with one provider id in the union that
 * substitution is invisible to every integration test. A unit test of `aggregateFrames`
 * cannot catch it either: it pins the function, not its caller.
 *
 * Method: construct the handler with OTHER_PROVIDER and drive a real non-streaming
 * request whose upstream yields no `message_start`. The 502 body is produced inside
 * `aggregateFrames`, so the provider name it renders can only have arrived through the
 * call site's second argument. Hardcode that argument and this test reads "codex …".
 */

// Auth stub whose read succeeds. The access token is not a JWT, so jwtExpiryMs()
// returns undefined and the credential never expires — no refresh, no network.
const workingStore: AuthFileStore = {
  async read() {
    return {
      ok: true as const,
      value: JSON.stringify({
        tokens: { access_token: "stub-access-token", refresh_token: "stub-refresh", account_id: "acct_stub" },
      }),
    };
  },
  async writeAtomic() {
    return { ok: true as const, value: undefined };
  },
};

describe("providerId is threaded into aggregateFrames at the handler call site", () => {
  it("renders the handler's own providerId in the aggregation error, not a hardcoded one", async () => {
    const configResult = loadConfig({
      configPath: "inline-threading-test.json",
      readFile: () => JSON.stringify({ logLevel: "error" }),
    });
    assert.ok(configResult.ok, "config load should succeed");

    const auth = new CodexAuthManager({
      store: workingStore,
      oauthTokenUrl: "http://localhost/fake-oauth",
      logger: noopLogger,
      events: providerEvents("codex"),
    });

    // A stream of only unknown events: the translator emits no frames at all, so
    // aggregateFrames sees zero frames, finds no message_start, and returns
    // err(`${providerName} stream ended before producing a message`).
    const fetchImpl: typeof fetch = async () =>
      new Response('event: unknown.event\ndata: {"type":"unknown.event"}\n\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });

    const handler = createCodexHandler({
      ...codexDepsFrom(configResult.value.config),
      providerId: OTHER_PROVIDER,
      logger: noopLogger,
      auth,
      cache: new ReasoningCache(4, 1024),
      fetchImpl,
    });

    // No `stream: true` — the non-streaming path is the one that calls aggregateFrames.
    const body = { model: "gpt-5.5", max_tokens: 10, messages: [{ role: "user", content: "hi" }] };
    const res = new StubResponse();
    const req = new EventEmitter() as unknown as IncomingMessage;

    await handler.handleMessages(req, res as unknown as ServerResponse, Buffer.from(JSON.stringify(body)), body, "gpt-5.5");

    assert.equal(res.statusCode, 502, `expected 502 from the aggregation error; body was: ${res.body}`);
    const parsed = JSON.parse(res.body) as { error: { message: string } };
    assert.equal(
      parsed.error.message,
      "kimi stream ended before producing a message",
      "aggregateFrames must receive the handler's own providerId — a 'codex …' message means the call site hardcoded it",
    );
  });
});

/**
 * `refreshable` sizes the retry bound, and the bound is what the loop obeys.
 *
 * `maxAttempts = auth.refreshable ? 2 : 1` is only a real field if the refresh guard
 * respects it. It did not: the guard read `attempt === 0`, so a static-credential
 * provider's 401 on its single permitted attempt still triggered a refresh the budget
 * of 1 did not allow, fell out of the loop with no response, and rendered a synthesised
 * "authentication failed after refresh" instead of the upstream's truthful 401.
 *
 * Both tests below are asserted on OBSERVABLE traffic — how many requests reached the
 * upstream, how many times the credential was renewed, and which credential the retry
 * carried — rather than on the branch taken, so they survive a refactor of the loop.
 */
describe("the 401 refresh retry obeys the bound `refreshable` sets", () => {
  /** Upstream that 401s on every attempt, so the retry loop runs to its bound. */
  const always401: typeof fetch = async () => new Response("unauthorized", { status: 401 });

  const STATIC_TOKEN = "Bearer static-token";
  const REFRESHED_TOKEN = "Bearer refreshed-token";

  /**
   * Auth fake honestly typed as `ProviderAuth<"codex">` — no cast, because the seam is
   * now an interface a test can implement rather than a concrete class.
   *
   * Its behaviour depends on both of its inputs: `refreshable` is varied across the two
   * tests, and `forceRefresh` hands back a DIFFERENT bearer token from `getCredentials`
   * so "the retry used the refreshed credential" is observable in the captured headers
   * rather than assumed.
   */
  const countingAuth = (refreshable: boolean): { auth: ProviderAuth<"codex">; refreshes: () => number } => {
    let refreshes = 0;
    const credentialWith = (authorization: string): ProviderCredential<"codex"> => ({
      provider: "codex",
      authHeaders: { authorization, "chatgpt-account-id": "acct_static" },
    });
    return {
      auth: {
        refreshable,
        getCredentials: async () => ok(credentialWith(STATIC_TOKEN)),
        forceRefresh: async () => {
          refreshes += 1;
          return ok(credentialWith(REFRESHED_TOKEN));
        },
      },
      refreshes: () => refreshes,
    };
  };

  interface Attempt {
    readonly authorization: string | undefined;
    readonly sessionId: string | undefined;
  }

  interface RunOptions {
    /** Overrides the request body; the default has a user message, so it derives a key. */
    readonly body?: Record<string, unknown>;
    /** Overrides the random-session-id source the handler falls back to. */
    readonly newSessionId?: () => string;
  }

  const runAgainstPersistent401 = async (
    refreshable: boolean,
    options: RunOptions = {},
  ): Promise<{ attempts: Attempt[]; refreshes: number; status: number; message: string }> => {
    const configResult = loadConfig({
      configPath: "inline-retry-bound-test.json",
      readFile: () => JSON.stringify({ logLevel: "error" }),
    });
    assert.ok(configResult.ok, "config load should succeed");

    const attempts: Attempt[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const headers = init?.headers as Record<string, string> | undefined;
      attempts.push({ authorization: headers?.["authorization"], sessionId: headers?.["session_id"] });
      return always401(input, init);
    };

    const { auth, refreshes } = countingAuth(refreshable);
    const handler = createCodexHandler({
      ...codexDepsFrom(configResult.value.config),
      logger: noopLogger,
      auth,
      cache: new ReasoningCache(4, 1024),
      fetchImpl,
      ...(options.newSessionId !== undefined ? { newSessionId: options.newSessionId } : {}),
    });

    const body = options.body ?? { model: "gpt-5.5", max_tokens: 10, messages: [{ role: "user", content: "hi" }] };
    const res = new StubResponse();
    const req = new EventEmitter() as unknown as IncomingMessage;
    await handler.handleMessages(req, res as unknown as ServerResponse, Buffer.from(JSON.stringify(body)), body, "gpt-5.5");
    return {
      attempts,
      refreshes: refreshes(),
      status: res.statusCode,
      message: (JSON.parse(res.body) as { error: { type: string; message: string } }).error.message,
    };
  };

  it("spends exactly one attempt and never refreshes a credential that cannot be refreshed", async () => {
    const run = await runAgainstPersistent401(false);

    assert.equal(run.attempts.length, 1, "a budget of 1 attempt must produce exactly 1 upstream request");
    assert.equal(run.refreshes, 0, "a static credential must never be sent to forceRefresh");
    assert.equal(run.attempts[0]?.authorization, STATIC_TOKEN);
    // The upstream's own 401 reaches the client, unedited by a refresh that never happened.
    assert.equal(run.status, 401);
    assert.doesNotMatch(
      run.message,
      /after refresh/,
      "a provider that cannot refresh must not be told its refresh failed",
    );
    assert.doesNotMatch(run.message, /retry bound violated/, "the loop must not exit without a response");
  });

  it("spends exactly two attempts when the credential can be refreshed, and no more", async () => {
    const run = await runAgainstPersistent401(true);

    assert.equal(run.attempts.length, 2, "the bound is 2 attempts — one initial, one after a refresh");
    assert.equal(run.refreshes, 1, "exactly one refresh: the retry is bounded from above, not a loop");
    assert.equal(run.attempts[0]?.authorization, STATIC_TOKEN);
    assert.equal(
      run.attempts[1]?.authorization,
      REFRESHED_TOKEN,
      "the retry must carry the refreshed credential, otherwise the refresh bought nothing",
    );
    // Second 401 is the upstream's answer, not a synthesised one — unchanged Codex behaviour.
    assert.equal(run.status, 401);
    assert.doesNotMatch(run.message, /retry bound violated/, "the loop must not exit without a response");
  });

  /**
   * ADR-003: the session id is derived ONCE, above the retry loop, and both attempts
   * carry it. Codex runs with `store: false`, so the encrypted reasoning items for a turn
   * are keyed to the session the request announced; a retry that announced a new session
   * would orphan them and break the tool-calling round-trip.
   *
   * This is the case the existing integration pin CANNOT see. `codex-leg.test.ts`
   * ("session_id is stable across the 401→refresh→retry path") sends a request WITH a user
   * message, so `deriveConversationKey` returns a value and `conversationKey ?? newSessionId()`
   * is deterministic wherever it is evaluated — moving the derivation inside the loop leaves
   * that test green. Only the no-user-message fallback, where the id comes from a generator
   * that returns something different every call, distinguishes "derived once" from "derived
   * per attempt". Verified by mutation: with the derivation moved into the loop, the whole
   * suite stayed green before this test existed.
   */
  it("derives the fallback session id once for the whole request, not once per attempt", async () => {
    let issued = 0;
    const run = await runAgainstPersistent401(true, {
      // No user message ⇒ deriveConversationKey returns undefined ⇒ the fallback is used.
      body: { model: "gpt-5.5", max_tokens: 10, messages: [{ role: "assistant", content: "prior turn" }] },
      newSessionId: () => `session-${(issued += 1)}`,
    });

    assert.equal(run.attempts.length, 2, "the rig must actually retry, or the assertion below is vacuous");
    assert.equal(run.attempts[0]?.sessionId, "session-1");
    assert.equal(
      run.attempts[1]?.sessionId,
      "session-1",
      "the retry must announce the same session as the first attempt (applies ADR-003)",
    );
    assert.equal(issued, 1, "a second generated id means the derivation moved inside the retry loop");
  });
});

/**
 * The handler reads ITS OWN config slice.
 *
 * `provider` is a `CodexProviderConfig`, not a `Config`, so there is no way for the
 * handler to reach another provider's settings — but "the wiring passes the right
 * slice" is a separate claim from "the type forbids the wrong one", and the type
 * cannot prove it while every slice has the same shape.
 *
 * Method: build two handlers from two DIFFERENT slices in the same process and check
 * that each one uses its own. A handler that ignored `deps.provider` — reading a
 * captured slice, a module-level default, or the first slice it ever saw — makes both
 * runs identical and fails here. With one ProviderId in the union this is the only
 * available proof that the slice is genuinely per-handler.
 */
describe("handler reads its own provider config slice", () => {
  const sliceWith = (config: Config, overrides: Partial<CodexProviderConfig>): CodexProviderConfig => ({
    ...config.providers.codex,
    ...overrides,
  });

  const captureUpstreamCall = async (
    provider: CodexProviderConfig,
  ): Promise<{ url: string; userAgent: string | undefined }> => {
    const configResult = loadConfig({
      configPath: "inline-slice-test.json",
      readFile: () => JSON.stringify({ logLevel: "error" }),
    });
    assert.ok(configResult.ok, "config load should succeed");

    let seenUrl = "";
    let seenUserAgent: string | undefined;
    const fetchImpl: typeof fetch = async (input, init) => {
      seenUrl = String(input);
      seenUserAgent = (init?.headers as Record<string, string> | undefined)?.["user-agent"];
      return new Response("nope", { status: 502 });
    };

    const handler = createCodexHandler({
      ...codexDepsFrom(configResult.value.config),
      provider,
      logger: noopLogger,
      auth: new CodexAuthManager({
        store: workingStore,
        oauthTokenUrl: "http://localhost/fake-oauth",
        logger: noopLogger,
        events: providerEvents("codex"),
      }),
      cache: new ReasoningCache(4, 1024),
      fetchImpl,
    });

    const body = { model: "gpt-5.5", max_tokens: 10, messages: [{ role: "user", content: "hi" }] };
    const res = new StubResponse();
    const req = new EventEmitter() as unknown as IncomingMessage;
    await handler.handleMessages(req, res as unknown as ServerResponse, Buffer.from(JSON.stringify(body)), body, "gpt-5.5");
    return { url: seenUrl, userAgent: seenUserAgent };
  };

  it("two handlers built from different slices each use their own baseUrl and userAgent", async () => {
    const configResult = loadConfig({
      configPath: "inline-slice-base.json",
      readFile: () => JSON.stringify({ logLevel: "error" }),
    });
    assert.ok(configResult.ok, "config load should succeed");
    const base = configResult.value.config;

    const first = await captureUpstreamCall(
      sliceWith(base, { baseUrl: "https://first.example/api", userAgent: "first-ua/1.0" }),
    );
    const second = await captureUpstreamCall(
      sliceWith(base, { baseUrl: "https://second.example/api", userAgent: "second-ua/2.0" }),
    );

    assert.equal(first.url, "https://first.example/api/responses");
    assert.equal(first.userAgent, "first-ua/1.0");
    assert.equal(second.url, "https://second.example/api/responses");
    assert.equal(second.userAgent, "second-ua/2.0");
    assert.notEqual(first.url, second.url, "the two handlers must not share a base URL");
  });
});

/**
 * Log event names are derived from `providerId`.
 *
 * Asserting `codex_upstream_error` while passing `providerId: "codex"` would be
 * worthless: it passes identically against a hardcoded literal. The only assertion that
 * distinguishes derivation from hardcoding is one made under a DIFFERENT provider id,
 * which is what OTHER_PROVIDER is for.
 *
 * The security property behind the derivation (event names can only come from the
 * closed ProviderId union, never a config string) is a compile-time guarantee and is
 * pinned in test/unit/provider-events.types.test.ts — no runtime test can observe it.
 */
describe("log event names derive from the handler's providerId", () => {
  const upstream502: typeof fetch = async () =>
    new Response("upstream is unwell", { status: 502, headers: { "content-type": "text/plain" } });

  const runWithCapturedEvents = async (providerId: ProviderId): Promise<string[]> => {
    const configResult = loadConfig({
      configPath: "inline-event-name-test.json",
      readFile: () => JSON.stringify({ logLevel: "debug" }),
    });
    assert.ok(configResult.ok, "config load should succeed");

    const events: string[] = [];
    const handler = createCodexHandler({
      ...codexDepsFrom(configResult.value.config),
      providerId,
      logger: { log: (_level, event) => { events.push(event); } },
      auth: new CodexAuthManager({
        store: workingStore,
        oauthTokenUrl: "http://localhost/fake-oauth",
        logger: noopLogger,
        events: providerEvents("codex"),
      }),
      cache: new ReasoningCache(4, 1024),
      fetchImpl: upstream502,
    });

    const body = { model: "gpt-5.5", max_tokens: 10, messages: [{ role: "user", content: "hi" }] };
    const res = new StubResponse();
    const req = new EventEmitter() as unknown as IncomingMessage;
    await handler.handleMessages(req, res as unknown as ServerResponse, Buffer.from(JSON.stringify(body)), body, "gpt-5.5");
    assert.equal(res.statusCode, 502, `expected the upstream error path; body was: ${res.body}`);
    return events;
  };

  it("emits a second provider's id in the event name, not 'codex'", async () => {
    const events = await runWithCapturedEvents(OTHER_PROVIDER);
    assert.ok(
      events.includes("kimi_upstream_error"),
      `event name must be derived from providerId; got: ${events.join(", ")}`,
    );
    assert.ok(
      !events.some((event) => event.startsWith("codex_")),
      `no event may name a provider this handler is not; got: ${events.join(", ")}`,
    );
  });

  it("keeps the Codex leg's event names byte-identical", async () => {
    // The other half of the pair: derivation must not have shifted the names the
    // Codex leg has always emitted (README documents codex_effort_applied by name).
    const events = await runWithCapturedEvents("codex");
    assert.ok(
      events.includes("codex_upstream_error"),
      `the Codex leg's event name must be unchanged; got: ${events.join(", ")}`,
    );
  });
});

/**
 * buildHeaders puts auth-first with transport constants after (regression avoidance).
 *
 * Verified end-to-end through undici 6.24.1 on Node 22.22.3: undici preserves
 * insertion order of the object literal verbatim onto the wire (HTTP/1.1 only).
 * The auth-first order was live-verified 2026-08-07.
 *
 * PF-005 scope: PF-005 forbids using the e2e/README.md wrong-transport capture table
 * to change header names or values. It does NOT govern order. These tests assert order
 * and the shadow-prevention guard, not parity with codex exec analytics captures.
 *
 * PF-011: each test below is proven RED against its named mutation before trusting green.
 */
const TARGET_HEADER_ORDER = [
  "authorization",
  "chatgpt-account-id",
  "openai-beta",
  "originator",
  "session_id",
  "accept",
  "content-type",
  "user-agent",
] as const;

/** Minimal two-header credential that matches what CodexAuthManager emits. */
const makeStandardAuth = (): ProviderAuth<"codex"> => ({
  refreshable: false,
  getCredentials: async () =>
    ok({
      provider: "codex" as const,
      authHeaders: { authorization: "Bearer tok", "chatgpt-account-id": "acct_x" },
    }),
  forceRefresh: async () =>
    ok({ provider: "codex" as const, authHeaders: { authorization: "Bearer tok", "chatgpt-account-id": "acct_x" } }),
});

/** Run the handler far enough to call fetchImpl, then return the captured headers. */
const captureOutgoingHeaders = async (
  auth: ProviderAuth<"codex">,
  configPath = "inline-header-capture.json",
): Promise<Record<string, string>> => {
  const configResult = loadConfig({
    configPath,
    readFile: () => JSON.stringify({ logLevel: "error" }),
  });
  assert.ok(configResult.ok, "config load should succeed");

  let capturedHeaders: Record<string, string> | undefined;
  const fetchImpl: typeof fetch = async (_input, init) => {
    capturedHeaders = { ...(init?.headers as Record<string, string> | undefined) };
    // Return a non-streaming error so the handler exits quickly.
    return new Response("upstream", { status: 502 });
  };

  const handler = createCodexHandler({
    ...codexDepsFrom(configResult.value.config),
    logger: noopLogger,
    auth,
    cache: new ReasoningCache(4, 1024),
    fetchImpl,
  });

  const body = { model: "gpt-5.5", max_tokens: 10, messages: [{ role: "user", content: "hi" }] };
  const res = new StubResponse();
  const req = new EventEmitter() as unknown as IncomingMessage;
  await handler.handleMessages(req, res as unknown as ServerResponse, Buffer.from(JSON.stringify(body)), body, "gpt-5.5");

  assert.ok(capturedHeaders !== undefined, "fetchImpl must have been called — handler returned before reaching fetch");
  return capturedHeaders;
};

describe("buildHeaders — auth-first header order with owned-name guard (avoids PF-005)", () => {
  /**
   * U1.1: Object.keys(captured) deep-equals the eight-name target order.
   *
   * Mutation that MUST turn it red: move the auth spread back to last (old pattern).
   * Proven red: "Expected values to be strictly deep-equal" — keys start with
   * ["openai-beta", "originator", ...] instead of ["authorization", "chatgpt-account-id", ...].
   */
  it("U1.1 — Object.keys of outgoing headers equals the eight-name target order", async () => {
    const captured = await captureOutgoingHeaders(makeStandardAuth(), "inline-header-u1-1.json");
    assert.deepEqual(Object.keys(captured), [...TARGET_HEADER_ORDER]);
  });

  /**
   * U1.2: a credential returning user-agent wins over provider.userAgent.
   *
   * Mutation that MUST turn it red: delete the owned guard (always call `headers[name] = value`).
   * Proven red: "Expected 'codex_cli_rs/0.144.6' to equal 'credential-ua/1.0'" (provider UA wins).
   */
  it("U1.2 — a credential returning user-agent wins over provider.userAgent (owned guard)", async () => {
    const authWithUa: ProviderAuth<"codex"> = {
      refreshable: false,
      getCredentials: async () =>
        ok({
          provider: "codex" as const,
          authHeaders: {
            authorization: "Bearer tok",
            "chatgpt-account-id": "acct_x",
            "user-agent": "credential-ua/1.0",
          },
        }),
      forceRefresh: async () =>
        ok({
          provider: "codex" as const,
          authHeaders: {
            authorization: "Bearer tok",
            "chatgpt-account-id": "acct_x",
            "user-agent": "credential-ua/1.0",
          },
        }),
    };
    const captured = await captureOutgoingHeaders(authWithUa, "inline-header-u1-2.json");
    assert.equal(
      captured["user-agent"],
      "credential-ua/1.0",
      "credential's user-agent must win over provider.userAgent",
    );
  });

  /**
   * U1.3: a credential returning User-Agent (capital) → exactly one key matching /^user-agent$/i.
   *
   * Mutation that MUST turn it red: drop .toLowerCase() from the owned Set construction
   * (change `k.toLowerCase()` → `k`). Transport constant names ("user-agent") are all
   * lowercase, so only the owned-construction normalisation detects the case collision.
   * Proven red: "Expected 1 to be equal to 2" — both "User-Agent" (from credential spread)
   * and "user-agent" (from put) are emitted when owned has "User-Agent" but put checks
   * owned.has("user-agent"), which returns false on a case-sensitive set.
   */
  it("U1.3 — a credential returning User-Agent (capital) produces exactly one user-agent key", async () => {
    const authWithCapUa: ProviderAuth<"codex"> = {
      refreshable: false,
      getCredentials: async () =>
        ok({
          provider: "codex" as const,
          authHeaders: {
            authorization: "Bearer tok",
            "chatgpt-account-id": "acct_x",
            "User-Agent": "capital-ua/1.0",
          },
        }),
      forceRefresh: async () =>
        ok({
          provider: "codex" as const,
          authHeaders: {
            authorization: "Bearer tok",
            "chatgpt-account-id": "acct_x",
            "User-Agent": "capital-ua/1.0",
          },
        }),
    };
    const captured = await captureOutgoingHeaders(authWithCapUa, "inline-header-u1-3.json");
    const uaKeys = Object.keys(captured).filter((k) => /^user-agent$/i.test(k));
    assert.equal(uaKeys.length, 1, `exactly one user-agent key must exist; got keys: ${JSON.stringify(Object.keys(captured))}`);
  });
});

/**
 * Upstream 401 message includes the provider's loginCommand from deps.
 *
 * The loginCommand cannot be synthesised from providerId: a provider whose id is "kimi"
 * may log in with "kimi auth login", not "kimi login". The value comes from the
 * hand-written PROVIDER_CONFIG_ACCESSORS table in config.ts and is read from deps.
 *
 * PF-011: proven RED against the named mutation before trusting green.
 */
describe("upstream 401 names the provider loginCommand in the client-visible message", () => {
  /**
   * U2.1: providerId: OTHER_PROVIDER, loginCommand: "kimi auth login".
   * auth is makeStandardAuth() — refreshable: false — exercising the non-refreshable path.
   * Assert message ends with "kimi auth login" and does NOT match /kimi login/.
   *
   * Mutation that MUST turn it red: synthesise the login command as `${providerId} login`
   * instead of reading from deps (i.e. produce "kimi login" instead of "kimi auth login").
   * Proven red: doesNotMatch(/kimi login/) fails because the synthesised form IS "kimi login".
   */
  it("U2.1 — message ends with the loginCommand from deps, not a synthesised providerId-login form", async () => {
    const configResult = loadConfig({
      configPath: "inline-login-cmd-u2-1.json",
      readFile: () => JSON.stringify({ logLevel: "error" }),
    });
    assert.ok(configResult.ok, "config load should succeed");

    const always401: typeof fetch = async () => new Response("unauthorized", { status: 401 });

    const handler = createCodexHandler({
      ...codexDepsFrom(configResult.value.config),
      providerId: OTHER_PROVIDER,
      loginCommand: "kimi auth login",
      logger: noopLogger,
      auth: makeStandardAuth(),
      cache: new ReasoningCache(4, 1024),
      fetchImpl: always401,
    });

    const body = { model: "gpt-5.5", max_tokens: 10, messages: [{ role: "user", content: "hi" }] };
    const res = new StubResponse();
    const req = new EventEmitter() as unknown as IncomingMessage;
    await handler.handleMessages(req, res as unknown as ServerResponse, Buffer.from(JSON.stringify(body)), body, "gpt-5.5");

    assert.equal(res.statusCode, 401, `expected 401; body was: ${res.body}`);
    const parsed = JSON.parse(res.body) as { error: { message: string } };
    assert.match(
      parsed.error.message,
      /kimi auth login/,
      "message must include the loginCommand from deps",
    );
    assert.doesNotMatch(
      parsed.error.message,
      /kimi login/,
      'synthesising `${providerId} login` would produce "kimi login" — must read from deps',
    );
  });
});

/**
 * Direct unit tests of the exported `buildHeaders` pure function (TEST-09).
 *
 * `buildHeaders` was previously a closure inside `createCodexHandler`, making its
 * mixed-case `put()` branch reachable only through a full handler invocation. Lifting
 * it to module-level makes the branch directly testable and removes the closure
 * capture of `provider.userAgent`.
 *
 * These tests are companions to the handler-level U1.x tests above (which exercise the
 * same logic through a full fetch cycle). Both are needed: U1.x proves the handler wires
 * the right transport constants; these prove the pure function handles edge cases the
 * handler tests cannot isolate.
 *
 * PF-005 scope: PF-005 forbids using the e2e/README.md wrong-transport capture table to
 * change header NAMES or VALUES. It does NOT govern ORDER.
 * PF-011/PF-012: each test is proven RED against its named mutation before trusting green.
 *
 * Before/after header-set proof (MANDATORY per TEST-09):
 * The U1.1, U1.2, and U1.3 handler-level tests above drive the real `buildHeaders` call
 * through `createCodexHandler`. They passed before the refactor (against the inline
 * closure) and must pass after (against the module-level function). Any drift in name,
 * value, or order would turn those tests red. The U1.1-direct test below provides an
 * additional direct assertion on the same eight-name order.
 */
const STANDARD_TRANSPORT: CodexTransportConstants = {
  "openai-beta": "responses=experimental",
  originator: "codex_cli_rs",
  accept: "text/event-stream",
  "content-type": "application/json",
  "user-agent": "test-ua/1.0",
};

describe("buildHeaders — direct unit tests of the exported pure function (TEST-09)", () => {
  /**
   * U1.1-direct: Object.keys matches the eight-name target order when called directly.
   *
   * This is the before/after parity assertion for TEST-09: if the module-level
   * `buildHeaders` produces the same key order as the old inline closure, the
   * refactoring is transparent to callers.
   *
   * Mutation that MUST turn it red: reorder the put() calls in buildHeaders so that
   * session_id appears last (after user-agent). Proven red: "Expected values to be
   * strictly deep-equal" — keys end with [..., "session_id"] instead of
   * [..., "content-type", "user-agent"].
   */
  it("U1.1-direct — buildHeaders() emits keys in the eight-name live-verified order", () => {
    const credential: ProviderCredential<"codex"> = {
      provider: "codex",
      authHeaders: { authorization: "Bearer tok", "chatgpt-account-id": "acct_x" },
    };
    const result = buildHeaders(credential, "sess-abc", STANDARD_TRANSPORT);
    assert.deepEqual(Object.keys(result), [
      "authorization",
      "chatgpt-account-id",
      "openai-beta",
      "originator",
      "session_id",
      "accept",
      "content-type",
      "user-agent",
    ]);
  });

  /**
   * U1.3-direct: a credential returning "User-Agent" (capital U, capital A) must yield
   * exactly one key matching /^user-agent$/i — the credential's own casing wins via the
   * spread, and `put("user-agent", ...)` is suppressed by the owned-set guard.
   *
   * This is the DIRECT test of the mixed-case put() branch (TEST-09). The handler-level
   * U1.3 above reaches the same branch through a full fetch cycle; this test calls
   * `buildHeaders` directly, making the branch independently testable.
   *
   * Mutation that MUST turn it red: drop `.toLowerCase()` from the owned Set construction
   * in buildHeaders (change `k.toLowerCase()` → `k` in the map call). The put() call sites
   * all pass lowercase literals, so only the construction-side normalisation detects the
   * case mismatch — owned.has("user-agent") returns false against a set containing "User-Agent".
   * Proven red: uaKeys.length equals 2 (both "User-Agent" from spread and "user-agent"
   * from put), so assert.equal(uaKeys.length, 1) fails.
   *
   * Per PF-012: do NOT test by dropping .toLowerCase() from put() — all put() call sites
   * pass lowercase literals, so that mutation is inert and the test would stay green.
   * The real falsifier is the construction-side normalisation.
   */
  it("U1.3-direct — credential with capital User-Agent yields exactly one user-agent key", () => {
    const credential: ProviderCredential<"codex"> = {
      provider: "codex",
      authHeaders: {
        authorization: "Bearer tok",
        "chatgpt-account-id": "acct_x",
        "User-Agent": "capital-ua/1.0",
      },
    };
    const result = buildHeaders(credential, "sess-123", STANDARD_TRANSPORT);
    const uaKeys = Object.keys(result).filter((k) => /^user-agent$/i.test(k));
    assert.equal(
      uaKeys.length,
      1,
      `exactly one user-agent key must exist; got keys: ${JSON.stringify(Object.keys(result))}`,
    );
    // The credential's own key ("User-Agent") is in the spread, so it must be present.
    assert.equal(result["User-Agent"], "capital-ua/1.0", "credential value must be preserved under its own casing");
    // The transport constant's lowercase form must be absent (suppressed by the owned guard).
    assert.equal(result["user-agent"], undefined, "transport put() must be suppressed when credential already owns the name");
  });

  /**
   * U1.4-direct: values from transportConstants are emitted with their given values.
   * Ensures transport constants are not silently dropped or overwritten when the
   * credential does not own them.
   *
   * Mutation that MUST turn it red: drop a put() call for one of the transport constants
   * (e.g. remove `put("originator", ...)`). Proven red: assert.equal fails for the
   * missing key.
   */
  it("U1.4-direct — transport constant values are emitted with the given values", () => {
    const credential: ProviderCredential<"codex"> = {
      provider: "codex",
      authHeaders: { authorization: "Bearer tok", "chatgpt-account-id": "acct_x" },
    };
    const result = buildHeaders(credential, "my-session", STANDARD_TRANSPORT);
    assert.equal(result["openai-beta"], "responses=experimental");
    assert.equal(result["originator"], "codex_cli_rs");
    assert.equal(result["session_id"], "my-session");
    assert.equal(result["accept"], "text/event-stream");
    assert.equal(result["content-type"], "application/json");
    assert.equal(result["user-agent"], "test-ua/1.0");
  });
});
