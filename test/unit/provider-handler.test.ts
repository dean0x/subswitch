import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createCodexHandler } from "../../src/codex-handler.js";
import { noopLogger } from "../../src/logger.js";
import { ReasoningCache } from "../../src/reasoning-cache.js";
import { CodexAuthManager, type AuthFileStore } from "../../src/codex-auth.js";
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
 * The remediation command in the auth-failure message comes from config.
 *
 * This is the one client-visible string that is NOT derivable from the provider id.
 * `${providerId} login` happens to be correct for Codex, which is exactly why the
 * synthesised form survived review: with `providerId === "codex"` and
 * `loginCommand === "codex login"` the two are byte-identical, so no Codex-only test
 * can tell them apart. A provider whose id is `kimi` but whose command is
 * `kimi auth login` would be told to run a command that does not exist.
 *
 * Method: drive the full 401 → refresh → 401 path with a loginCommand that is not
 * `${providerId} login`, and assert the rendered message quotes it verbatim.
 */
describe("auth-failure remediation names the configured login command", () => {
  /** Upstream that 401s on every attempt, so the retry loop exhausts. */
  const always401: typeof fetch = async () => new Response("unauthorized", { status: 401 });

  /**
   * STATIC-CREDENTIAL AUTH FAKE, cast because `deps.auth` is still the concrete
   * `CodexAuthManager` (a branded `ProviderAuth<P>` is a separate piece of work).
   * Only the three members the handler touches are implemented.
   *
   * REACHABILITY — why the fake is necessary. The "authentication failed after
   * refresh" branch is reached only when the retry loop exits with no upstream
   * response, and with `refreshable: true` that cannot happen: attempt 1's 401 breaks
   * out of the loop with the response in hand and renders "upstream error (401)"
   * instead. The branch is reachable today ONLY with `refreshable: false`, because the
   * loop's `attempt === 0` guard fires a refresh the retry budget of 1 does not allow.
   *
   * That guard is a known defect owned by the ProviderAuth work (it should read
   * `attempt + 1 < maxAttempts`). WHEN IT IS FIXED, this branch becomes structurally
   * unreachable and these two tests must be revisited along with it — either the branch
   * goes, or it becomes an invariant assertion. Do not simply delete the tests.
   */
  const staticCredentialAuth = (): CodexAuthManager => {
    const credential = { accessToken: "static-token", accountId: "acct_static" };
    const fake = {
      refreshable: false,
      getCredentials: async () => ({ ok: true as const, value: credential }),
      forceRefresh: async () => ({ ok: true as const, value: credential }),
    };
    return fake as unknown as CodexAuthManager;
  };

  const runAuthFailure = async (loginCommand: string): Promise<string> => {
    const configResult = loadConfig({
      configPath: "inline-login-command-test.json",
      readFile: () => JSON.stringify({ logLevel: "error" }),
    });
    assert.ok(configResult.ok, "config load should succeed");

    const handler = createCodexHandler({
      ...codexDepsFrom(configResult.value.config),
      loginCommand,
      logger: noopLogger,
      auth: staticCredentialAuth(),
      cache: new ReasoningCache(4, 1024),
      fetchImpl: always401,
    });

    const body = { model: "gpt-5.5", max_tokens: 10, messages: [{ role: "user", content: "hi" }] };
    const res = new StubResponse();
    const req = new EventEmitter() as unknown as IncomingMessage;
    await handler.handleMessages(req, res as unknown as ServerResponse, Buffer.from(JSON.stringify(body)), body, "gpt-5.5");
    assert.equal(res.statusCode, 401, `expected the exhausted-retry auth error; body was: ${res.body}`);
    return (JSON.parse(res.body) as { error: { message: string } }).error.message;
  };

  it("quotes a login command that is not derivable from the provider id", async () => {
    const message = await runAuthFailure("kimi auth login");
    assert.match(
      message,
      /run `kimi auth login`/,
      "the remediation must come from config — synthesising `${providerId} login` invents a command that does not exist",
    );
  });

  it("keeps the Codex leg's message byte-identical", async () => {
    const message = await runAuthFailure("codex login");
    assert.equal(message, "codex authentication failed after refresh — run `codex login`");
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
