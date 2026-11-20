/**
 * Tests for the test-harness helpers in fake-upstreams.ts.
 *
 * H1: Verifies that an injected logger passed to startSubswitch is threaded
 * INTO buildDeps — not spread over its result — by asserting that
 * codex_upstream_error (emitted only by the handler, which closes over the
 * logger from buildDeps) appears in the captured records.  A spread-over-result
 * shape leaves every handler log on the original (console) logger, making the
 * captured set empty for handler-level events.
 *
 * Mutation that proves it: omit the logger argument to `buildTestDeps`
 * in fake-upstreams.ts and spread the logger onto the
 * result.  The H1 codex_upstream_error assertion goes RED; request_complete
 * (emitted by the request loop, not the handler) stays green.
 */
import { describe, it, after, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { claudeCredentialLocation } from "../../src/claude-auth.js";
import { loadConfig, type Config } from "../../src/config.js";
import type { LogLevel, LogFields } from "../../src/logger.js";
import { createProxyServer, listenServer } from "../../src/server.js";
import { buildTestDeps } from "../helpers/server-deps.js";
import { TOGETHER_API_KEY_ENV } from "../../src/together-auth.js";
import { lateToolNames } from "../fixtures/together/streams.js";
import {
  startSubswitch,
  startFakeUpstream,
  makeAuthFileContent,
  makeAccessToken,
  sseHandler,
} from "./fake-upstreams.js";

const cleanups: (() => Promise<void>)[] = [];
after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

// ---------------------------------------------------------------------------
// H1 — injected logger is threaded through buildDeps, not spread over result
//
// The load-bearing check: codex_upstream_error is emitted only from inside the
// handler, which closes over the logger that buildDeps received.  Spreading a
// different logger onto buildDeps' result leaves the handler's logger unchanged,
// so codex_upstream_error never reaches the captured set.
// ---------------------------------------------------------------------------

describe("startSubswitch logger injection", () => {
  it("injected logger captures codex_upstream_error from a gpt-* request routed to a 502 upstream", async () => {
    // A codex upstream that always returns 502 — triggers codex_upstream_error
    // inside the handler, which is the event that only reaches the captured set
    // when the logger is passed INTO buildDeps rather than spread over its result.
    const fakeCodex = await startFakeUpstream((_req, res) => {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end("Bad Gateway");
    });
    const dir = await mkdtemp(join(tmpdir(), "harness-h1-"));
    const authFilePath = join(dir, "auth.json");
    await writeFile(authFilePath, makeAuthFileContent(makeAccessToken(Date.now() + 3_600_000)), "utf8");

    type Captured = { level: LogLevel; event: string; fields: LogFields | undefined };
    const captured: Captured[] = [];

    const subswitch = await startSubswitch(
      { providers: { codex: { baseUrl: fakeCodex.url, authFile: authFilePath } } },
      {
        logger: {
          log: (level, event, fields) => {
            captured.push({ level, event, fields });
          },
        },
      },
    );
    cleanups.push(subswitch.close, fakeCodex.close);

    const res = await fetch(`${subswitch.url}/v1/messages`, {
      method: "POST",
      headers: {
        authorization: "Bearer sk-ant-placeholder",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5.6-sol",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 16,
      }),
    });
    await res.text();

    assert.ok(
      captured.some((c) => c.event === "codex_upstream_error"),
      `injected logger must capture codex_upstream_error (a handler-level event); got: ${captured.map((c) => c.event).join(", ")}`,
    );
  });

  it("default (no logger option) still works — no regression from signature change", async () => {
    const anthropic = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    // Signature unchanged for existing callers: second arg defaults to {}
    const subswitch = await startSubswitch({ anthropic: { baseUrl: anthropic.url } });
    cleanups.push(subswitch.close, anthropic.close);

    const response = await fetch(`${subswitch.url}/__subswitch/health`);
    assert.equal(response.status, 200);
  });
});

const testAuthDir = (path: string, provider: string): string => {
  const dir = dirname(path);
  assert.ok(dirname(dir) === tmpdir() && basename(dir).startsWith("subswitch-test-auth-"),
    `${provider} auth must use a private test folder`);
  return dir;
};

const claudeFilePath = (config: Config): string => {
  const claude = claudeCredentialLocation(config.codexIngress.claude, {}, "darwin");
  assert.ok(claude.kind === "file", "Claude auth must use a file on darwin");
  return claude.path;
};

const checkedAuthDir = (config: Config): string => {
  const codexFile = config.providers.codex.authFile;
  const dir = testAuthDir(codexFile, "Codex");
  const claudeFile = claudeFilePath(config);
  assert.equal(testAuthDir(claudeFile, "Claude"), dir);
  assert.notEqual(claudeFile, codexFile);
  return dir;
};

const post = (url: string, path: string, body: unknown) => fetch(`${url}${path}`, {
  method: "POST",
  headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
  body: JSON.stringify(body),
});

const messages = (model: string) => ({ model, messages: [{ role: "user", content: "hi" }], max_tokens: 16 });

const missingFolder = (dir: string) => assert.rejects(stat(dir), { code: "ENOENT" });

describe("startSubswitch auth files", () => {
  it("defaults to absent files and returns local auth errors for both routes", async (t) => {
    const upstream = await startFakeUpstream((_req, res) => res.end());
    t.after(upstream.close);
    let dir = "";
    const proxy = await startSubswitch({
      providers: { codex: { baseUrl: upstream.url } },
      codexIngress: { enabled: true, claude: { enabled: true, baseUrl: upstream.url } },
    }, { checkConfig: (config) => { dir = checkedAuthDir(config); } });
    try {
      assert.equal((await stat(dir)).mode & 0o077, 0);
      assert.deepEqual(await readdir(dir), []);
      const codex = await post(proxy.url, "/v1/messages", messages("gpt-5.6-sol"));
      assert.equal(codex.status, 401);
      assert.match(await codex.text(), /cannot read codex auth file/);
      const claude = await post(proxy.url, "/codex/v1/responses", { model: "sonnet", input: "hi" });
      assert.equal(claude.status, 503);
      assert.match(await claude.text(), /Cannot read Claude subscription credentials/);
      assert.equal(upstream.requests.length, 0);
    } finally {
      await proxy.close();
    }
    await missingFolder(dir);
  });

  it("uses unique folders and preserves each explicit auth file path", async (t) => {
    let firstDir = "";
    const first = await startSubswitch({
      providers: { codex: { authFile: undefined } },
      codexIngress: { claude: { authFile: undefined } },
    }, { checkConfig: (config) => { firstDir = checkedAuthDir(config); } });
    t.after(first.close);
    const codexFile = join(firstDir, "explicit-codex.json");
    const claudeFile = join(firstDir, "explicit-claude.json");
    const second = await startSubswitch({ providers: { codex: { authFile: codexFile } } }, {
      checkConfig(config) {
        assert.equal(config.providers.codex.authFile, codexFile);
        assert.notEqual(testAuthDir(claudeFilePath(config), "Claude"), firstDir);
      },
    });
    t.after(second.close);
    const third = await startSubswitch({ codexIngress: { claude: { authFile: claudeFile } } }, {
      checkConfig(config) {
        assert.notEqual(testAuthDir(config.providers.codex.authFile, "Codex"), firstDir);
        assert.equal(claudeFilePath(config), claudeFile);
      },
    });
    await third.close();
    assert.ok((await stat(firstDir)).isDirectory());
  });

  it("removes the private folder if startup fails", async () => {
    let dir = "";
    await assert.rejects(startSubswitch({ anthropic: { baseUrl: "https://fixture.invalid" } }, {
      checkConfig: (config) => { dir = checkedAuthDir(config); },
    }), /buildDeps rejected config/);
    await missingFolder(dir);
  });
});

// The default Together deps refuse store calls.

const PROCESS_KEY = "FAKE-TOGETHER-KEY-process-env";

/**
 * Start a proxy with a Together route to a fake upstream. A marked fake key is put in the
 * process env first: if startSubswitch used the live deps, the live reader would find that
 * key before any Keychain call and send it upstream, so the test can not reach a real store.
 */
const togetherRig = async (t: TestContext, options: Parameters<typeof startSubswitch>[1] = {}) => {
  const previous = process.env[TOGETHER_API_KEY_ENV];
  process.env[TOGETHER_API_KEY_ENV] = PROCESS_KEY;
  t.after(() => {
    if (previous === undefined) delete process.env[TOGETHER_API_KEY_ENV];
    else process.env[TOGETHER_API_KEY_ENV] = previous;
  });
  const together = await startFakeUpstream(sseHandler(lateToolNames));
  t.after(together.close);
  const subswitch = await startSubswitch({ providers: { together: { baseUrl: `${together.url}/v1` } } }, options);
  t.after(subswitch.close);
  const response = await post(subswitch.url, "/v1/messages", messages("together:fixture/model"));
  return { together, subswitch, status: response.status, body: await response.text() };
};

it("refuses the Together store in the direct test builder", async (t) => {
  const upstream = await startFakeUpstream(sseHandler(lateToolNames));
  t.after(upstream.close);
  const config = loadConfig({
    configPath: "inline-test-config.json", globalConfigPath: false, env: {},
    readFile: () => JSON.stringify({ logLevel: "error", providers: { together: { baseUrl: `${upstream.url}/v1` } } }),
  });
  assert.ok(config.ok);
  // Use only the fixture key if the builder uses the process environment.
  const previousEnv = process.env;
  const refusedStoreCalls: string[] = [];
  let built: ReturnType<typeof buildTestDeps>;
  try {
    process.env = { [TOGETHER_API_KEY_ENV]: PROCESS_KEY };
    built = buildTestDeps(config.value.config, undefined, { refusedStoreCalls });
  } finally {
    process.env = previousEnv;
  }
  assert.ok(built.ok);
  const server = createProxyServer(built.value);
  assert.ok((await listenServer(server, 0, "127.0.0.1")).ok);
  t.after(() => new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const response = await post(`http://127.0.0.1:${address.port}`, "/v1/messages", messages("together:fixture/model"));
  const body = await response.text();
  assert.equal(response.status, 401, "The direct test builder must refuse the store call");
  assert.match(body, /Together key is missing/);
  assert.equal(upstream.requests.length, 0);
  assert.deepEqual(refusedStoreCalls, ["together.exec"]);
});

describe("startSubswitch provider deps", () => {
  it("refuses the Together Keychain call when a test injects no Together deps", async (t) => {
    const { together, subswitch, status, body } = await togetherRig(t);
    assert.equal(status, 401);
    assert.match(body, /Together key is missing/);
    assert.equal(together.requests.length, 0, "the live reader must not find the process env key");
    // The darwin fake reaches the Keychain call, so this list proves that the fake refused it.
    assert.deepEqual(subswitch.refusedStoreCalls, ["together.exec"]);
  });

  it("uses injected Together deps in place of the refusing fake", async (t) => {
    const injected = "FAKE-TOGETHER-KEY-injected";
    const { together, subswitch, status } = await togetherRig(t, {
      providerDeps: {
        together: {
          env: { [TOGETHER_API_KEY_ENV]: injected }, platform: "darwin", setTimer: () => () => {},
          exec: async () => { throw new Error("The env key must be used before the Keychain"); },
        },
      },
    });
    assert.equal(status, 200);
    assert.equal(together.requests.length, 1);
    assert.equal(together.requests[0]?.headers.authorization, `Bearer ${injected}`);
    assert.deepEqual(subswitch.refusedStoreCalls, []);
  });
});
