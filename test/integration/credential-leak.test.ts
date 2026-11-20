import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliChildFolders, readExecLog, runCliChild } from "../helpers/cli-child.js";
import { startSubswitch, startFakeUpstream, sseHandler, makeAccessToken, makeAuthFileContent, type RecordedRequest } from "./fake-upstreams.js";
import type { Logger, LogFields, LogLevel } from "../../src/logger.js";
import {
  TOGETHER_API_KEY_ENV, createTogetherAuth, createTogetherKeyReader, type TogetherKeyReaderDeps,
} from "../../src/together-auth.js";
import { lateToolNames } from "../fixtures/together/streams.js";

/**
 * Credential-leak matrix — the three rows gradable today.
 *
 * Row 1 (sk-ant-* never reaches Codex) is already pinned in codex-leg.test.ts:108-110.
 * That file is a frozen oracle — no test is added or moved here for Row 1.
 *
 * Row 5 (Codex credential never reaches Anthropic) is added below.
 * Row 6 (Codex credential never reaches the client or the log) is added below and is the
 * only row that exercises the Codex leg's own credential surface — Row 5 deliberately
 * sends a `claude-*` model, so the Codex handler never runs in it.
 * These rows cover credential flow between the client, proxy, and current upstreams.
 */

const FAR_FUTURE_MS = Date.now() + 24 * 3600 * 1000;

const cleanups: (() => Promise<void>)[] = [];
after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

describe("credential leak matrix", () => {
  /**
   * Row 5: a Codex OAuth credential (Bearer ey… JWT) must never appear in a request
   * forwarded to the Anthropic leg.
   *
   * The Codex handler builds its own auth headers inside buildHeaders() and only sends
   * them to the Codex upstream. The Anthropic passthrough forwards the original client
   * headers verbatim. This test verifies the two paths stay disjoint.
   *
   * Setup: configure subswitch with a real Codex auth file (so credentials exist) and a
   * fake Anthropic upstream. Send a claude-* model request — routed to Anthropic.
   * Assert that no Codex-specific header appears in the Anthropic upstream request.
   */
  it("Row 5: Codex OAuth credential never reaches the Anthropic leg", async () => {
    // Set up a Codex auth file so credentials exist in the process.
    // Even though this request routes to Anthropic, we want to ensure credentials
    // don't leak even when the Codex provider is fully wired.
    const dir = await mkdtemp(join(tmpdir(), "cred-leak-"));
    const authFilePath = join(dir, "auth.json");
    await writeFile(authFilePath, makeAuthFileContent(makeAccessToken(FAR_FUTURE_MS)));

    const anthropic = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "msg_anthropic_ok", type: "message" }));
    });
    const subswitch = await startSubswitch({
      anthropic: { baseUrl: anthropic.url },
      providers: { codex: { authFile: authFilePath } },
    });
    cleanups.push(subswitch.close, anthropic.close);

    // Send a Claude-model request — decideRoute routes it to Anthropic, never to Codex.
    const clientToken = "Bearer sk-ant-oat-CLIENT-CREDENTIAL-FIXTURE";
    const response = await fetch(`${subswitch.url}/v1/messages`, {
      method: "POST",
      headers: {
        authorization: clientToken,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 10,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    assert.equal(response.status, 200);
    await response.json();

    assert.equal(anthropic.requests.length, 1, "Anthropic must have received exactly one request");
    const anthropicReq = anthropic.requests[0]!;

    // Codex-specific auth headers must not appear in the Anthropic request.
    assert.equal(
      "chatgpt-account-id" in anthropicReq.headers,
      false,
      "chatgpt-account-id must not reach Anthropic",
    );
    assert.equal(
      "openai-beta" in anthropicReq.headers,
      false,
      "openai-beta must not reach Anthropic",
    );
    assert.equal(
      "originator" in anthropicReq.headers,
      false,
      "originator (codex_cli_rs) must not reach Anthropic",
    );
    assert.equal(
      "session_id" in anthropicReq.headers,
      false,
      "session_id must not reach Anthropic",
    );

    // The authorization header must be the client's sk-ant-* token forwarded verbatim,
    // not a Codex JWT. Codex JWTs are base64url-encoded and start with "Bearer ey".
    const authHeader = String(anthropicReq.headers["authorization"] ?? "");
    assert.equal(
      authHeader.startsWith("Bearer ey"),
      false,
      "authorization must not be a Codex JWT in the Anthropic request",
    );
    assert.equal(
      authHeader,
      clientToken,
      "authorization must be the client's token forwarded verbatim",
    );
  });

  /**
   * Row 6: the Codex credential must never reach the client or the log.
   *
   * This is the row that covers the seam item B introduced. `ProviderCredential<P>`
   * puts every secret under one key (`authHeaders`), which is only a redaction boundary
   * if something asserts nothing crosses it — and Row 5 cannot: it sends a `claude-*`
   * model, so `createCodexHandler` never executes and the Anthropic forwarder it does
   * exercise has no access to `auth` at all (`server.ts` passes it only baseUrl/timeouts).
   *
   * The upstream-received assertion is the load-bearing half. Without it this test would
   * pass vacuously if the request never reached the Codex leg — "the token is absent from
   * the output" is trivially true when the token was never in play. Asserting the fake
   * Codex upstream actually received `Bearer <token>` proves the credential was live in
   * the process for the duration of the request that produced the output being scanned.
   */
  it("Row 6: Codex credential reaches the upstream but never the client or the log", async () => {
    const accessToken = makeAccessToken(FAR_FUTURE_MS);
    const accountId = "acct_integration_1";

    const dir = await mkdtemp(join(tmpdir(), "cred-leak-codex-"));
    const authFilePath = join(dir, "auth.json");
    await writeFile(authFilePath, makeAuthFileContent(accessToken, "refresh-SECRET-FIXTURE"));

    const sse = readFileSync(new URL("../fixtures/response/text-only.sse", import.meta.url), "utf8");
    const codex = await startFakeUpstream(sseHandler(sse));
    const anthropic = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });

    // Capture every log record the request emits, rendered the way the real logger
    // renders them, so a widened FIELD_KEYS or a stray field would show up here.
    const records: string[] = [];
    const capturing: Logger = {
      log: (level: LogLevel, event: string, fields?: LogFields) =>
        records.push(`${level} ${event} ${JSON.stringify(fields ?? {})}`),
    };

    const subswitch = await startSubswitch(
      {
        anthropic: { baseUrl: anthropic.url },
        providers: { codex: { baseUrl: codex.url, authFile: authFilePath } },
      },
      { logger: capturing },
    );
    cleanups.push(subswitch.close, codex.close, anthropic.close);

    const response = await fetch(`${subswitch.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.5",
        max_tokens: 16,
        stream: false,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    const clientBody = await response.text();

    // Positive control: the credential really was in play on this request.
    assert.equal(codex.requests.length, 1, "the Codex upstream must have received the request");
    assert.equal(
      codex.requests[0]!.headers["authorization"],
      `Bearer ${accessToken}`,
      "the Codex upstream must have received the credential — otherwise the assertions below are vacuous",
    );

    // The client-visible surface must not carry it.
    const clientHeaders = JSON.stringify([...response.headers.entries()]);
    for (const [label, surface] of [
      ["response body", clientBody],
      ["response headers", clientHeaders],
      ["log records", records.join("\n")],
    ] as const) {
      assert.equal(surface.includes(accessToken), false, `the access token must not appear in the ${label}`);
      assert.equal(surface.includes("refresh-SECRET-FIXTURE"), false, `the refresh token must not appear in the ${label}`);
      assert.equal(surface.includes(accountId), false, `the chatgpt account id must not appear in the ${label}`);
      assert.equal(surface.includes("Bearer "), false, `no bearer credential may appear in the ${label}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Together rows: the paid key goes to Together as Bearer and nowhere else.
// ---------------------------------------------------------------------------

const TOGETHER_KEY = "FAKE-TOGETHER-KEY-leak-matrix";
const KEY_MARKER = "FAKE-TOGETHER-KEY-";
const CLIENT_HEADERS = { authorization: "Bearer fabricated-client-auth", "x-api-key": "fabricated-client-key" };
const MALFORMED_KEYS = [
  `${KEY_MARKER}has space`, `${KEY_MARKER}tab\there`, `${KEY_MARKER}bell\u0007`, `${KEY_MARKER}non-ascii-é`,
  `${KEY_MARKER}two-newlines\n\n`, `${KEY_MARKER}${"x".repeat(512)}`,
];

const requestText = (request: RecordedRequest): string => JSON.stringify(request.headers) + request.body.toString();
const keyReader = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform = "linux", stdout = ""): TogetherKeyReaderDeps => ({
  env, platform, exec: async () => ({ stdout }), setTimer: () => () => {},
});

const startLeakMatrix = async (togetherKeyReader: TogetherKeyReaderDeps) => {
  const together = await startFakeUpstream((req, res, body, index) => {
    if (JSON.parse(body.toString()).model !== "fixture/server-error") return sseHandler(lateToolNames)(req, res, body, index);
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "server_error", message: "fixture failure" } }));
  });
  const anthropic = await startFakeUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  const codex = await startFakeUpstream(sseHandler(readFileSync(new URL("../fixtures/response/text-only.sse", import.meta.url), "utf8")));
  const dir = await mkdtemp(join(tmpdir(), "cred-leak-together-"));
  const authFile = join(dir, "auth.json");
  await writeFile(authFile, makeAuthFileContent(makeAccessToken(FAR_FUTURE_MS)));
  const records: string[] = [];
  const subswitch = await startSubswitch({
    anthropic: { baseUrl: anthropic.url },
    providers: { codex: { baseUrl: codex.url, authFile }, together: { baseUrl: `${together.url}/v1` } },
  }, {
    logger: { log: (level, event, fields) => records.push(`${level} ${event} ${JSON.stringify(fields ?? {})}`) },
    providerDeps: { together: togetherKeyReader },
  });
  cleanups.push(subswitch.close, together.close, anthropic.close, codex.close, () => rm(dir, { recursive: true, force: true }));
  const post = async (model: string) => {
    const response = await fetch(`${subswitch.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", ...CLIENT_HEADERS },
      body: JSON.stringify({ model, max_tokens: 16, stream: false, messages: [{ role: "user", content: "hi" }] }),
    });
    return { status: response.status, text: JSON.stringify([...response.headers.entries()]) + await response.text() };
  };
  return { together, anthropic, codex, records, post, url: subswitch.url };
};

describe("Together credential leak matrix", () => {
  const rows = [
    { model: "together:fixture/ok", upstream: "together" },
    { model: "together:fixture/server-error", upstream: "together" },
    { model: "together:has space", upstream: "none" },
    { model: "fixture-unknown-model", upstream: "anthropic" },
    { model: "claude-sonnet-4-6", upstream: "anthropic" },
    { model: "gpt-5.5", upstream: "codex" },
  ] as const;

  for (const key of [TOGETHER_KEY, undefined]) {
    const label = key === undefined ? "sends no Together request with a missing key" : "sends the key to Together as Bearer only";
    it(`${label} on every route`, async () => {
      const m = await startLeakMatrix(keyReader(key === undefined ? {} : { [TOGETHER_API_KEY_ENV]: key }));
      const clientSurfaces: string[] = [];
      for (const { model, upstream } of rows) {
        const fakes = [m.together, m.anthropic, m.codex];
        const before = fakes.map((fake) => fake.requests.length);
        const { status, text } = await m.post(model);
        clientSurfaces.push(text);
        const expected = key === undefined && upstream === "together" ? "none" : upstream;
        assert.deepEqual(fakes.map((fake, i) => fake.requests.length - before[i]!),
          ["together", "anthropic", "codex"].map((name) => (name === expected ? 1 : 0)), `upstream requests for ${model}`);
        if (key === undefined && upstream === "together") assert.equal(status, 401, model);
      }

      assert.equal(m.together.requests.length, key === undefined ? 0 : 2);
      for (const request of m.together.requests) {
        assert.equal(request.headers.authorization, `Bearer ${TOGETHER_KEY}`);
        const outside = JSON.stringify({ ...request.headers, authorization: undefined }) + request.body.toString();
        assert.equal(outside.includes(KEY_MARKER), false, "the key must travel in the authorization header only");
        assert.equal(outside.includes("fabricated-client"), false, "client credentials must never reach Together");
      }
      for (const request of [...m.anthropic.requests, ...m.codex.requests]) {
        assert.equal(requestText(request).includes(KEY_MARKER), false, `the key must not reach ${request.url}`);
      }
      const health = await (await fetch(`${m.url}/__subswitch/health`)).text();
      for (const [surface, text] of [["client responses", clientSurfaces.join("\n")], ["log records", m.records.join("\n")],
        ["health body", health]] as const) {
        assert.equal(text.includes(KEY_MARKER), false, `the key must not appear in the ${surface}`);
      }
    });
  }

  for (const source of ["env", "keychain"] as const) {
    it(`never echoes a rejected ${source} key in the 401, the logs or the error text`, async () => {
      for (const value of MALFORMED_KEYS) {
        const deps = source === "env" ? keyReader({ [TOGETHER_API_KEY_ENV]: value }) : keyReader({}, "darwin", value);
        const credentials = await createTogetherAuth(createTogetherKeyReader(deps)).getCredentials();
        assert.ok(!credentials.ok);
        assert.match(credentials.error.message, /^Together key is malformed\./, JSON.stringify(value));
        const m = await startLeakMatrix(deps);
        const { status, text } = await m.post("together:fixture/ok");
        assert.equal(status, 401);
        for (const surface of [credentials.error.message, text, m.records.join("\n")]) {
          assert.equal(surface.includes(KEY_MARKER), false, `a rejected key must not be echoed: ${JSON.stringify(value)}`);
        }
        assert.equal(m.together.requests.length + m.anthropic.requests.length + m.codex.requests.length, 0);
      }
    });
  }

  it("keeps models and models --json away from the key reader and the key", { timeout: 30_000 }, async () => {
    const runs = [[["models", "--json"], TOGETHER_KEY], [["models", "--json"], undefined], [["models"], undefined]] as const;
    for (const [args, key] of runs) {
      const folders = await cliChildFolders();
      cleanups.push(() => rm(folders.home, { recursive: true, force: true }));
      const result = await runCliChild(folders, args, {
        env: { NO_COLOR: "1", ...(key === undefined ? {} : { [TOGETHER_API_KEY_ENV]: key }) },
      });
      const command = args.join(" ");
      const output = result.stdout + result.stderr;
      assert.equal(result.code, 0, output);
      assert.equal(output.includes(KEY_MARKER), false, `${command} must not print the key`);
      assert.deepEqual(await readExecLog(folders), ["preload"], `${command} must not start a child process`);
    }
  });
});
