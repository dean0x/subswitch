import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createCodexHandler } from "../../src/codex-handler.js";
import { noopLogger } from "../../src/logger.js";
import { ReasoningCache } from "../../src/reasoning-cache.js";
import { CodexAuthManager, type AuthFileStore } from "../../src/codex-auth.js";
import { loadConfig } from "../../src/config.js";

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
    const handler = createCodexHandler({ config: configResult.value.config, logger: noopLogger, auth, cache });

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
 * Call-site threading of `aggregateFrames(frames, providerName)`.
 *
 * This is otherwise UNDETECTABLE. `createCodexProvider` (src/server.ts) never passes
 * `deps.providerName`, so the threaded value and `aggregateFrames`' own
 * `providerName = "codex"` parameter default resolve to the same string — dropping the
 * second argument at the call site changes nothing observable over HTTP, and every
 * integration test keeps passing. A unit test of `aggregateFrames` cannot catch it
 * either: it pins the function, not its caller.
 *
 * Method: construct the handler with a NON-default providerName and drive a real
 * non-streaming request whose upstream yields no `message_start`. The 502 body is
 * produced inside `aggregateFrames`, so the provider name it renders can only have
 * arrived through the call site's second argument. Drop that argument and this test
 * reads "codex …" instead of "kimi …".
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

describe("providerName is threaded into aggregateFrames at the handler call site", () => {
  it("renders the handler's providerName in the aggregation error, not aggregateFrames' default", async () => {
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
      config: configResult.value.config,
      logger: noopLogger,
      auth,
      cache: new ReasoningCache(4, 1024),
      fetchImpl,
      providerName: "kimi",
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
      "aggregateFrames must receive the handler's providerName — a 'codex …' message means the call site dropped its second argument",
    );
  });
});
