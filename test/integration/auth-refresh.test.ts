import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAuthManager, createFsAuthFileStore } from "../../src/codex-auth.js";
import { noopLogger } from "../../src/logger.js";
import { makeAccessToken, makeAuthFileContent, startFakeUpstream, type FakeUpstream } from "./fake-upstreams.js";

const cleanups: (() => Promise<void>)[] = [];
after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

const setupOauth = async (): Promise<{ oauth: FakeUpstream; newToken: string }> => {
  const newToken = makeAccessToken(Date.now() + 24 * 3600 * 1000);
  const oauth = await startFakeUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ access_token: newToken, id_token: "id.new.x", refresh_token: "refresh-rotated-9" }));
  });
  cleanups.push(oauth.close);
  return { oauth, newToken };
};

describe("codex auth refresh against the real filesystem", () => {
  it("refreshes a near-expiry token and atomically rewrites auth.json preserving unknown keys", async () => {
    const { oauth, newToken } = await setupOauth();
    const dir = await mkdtemp(join(tmpdir(), "croxy-auth-"));
    const authFilePath = join(dir, "auth.json");
    await writeFile(authFilePath, makeAuthFileContent(makeAccessToken(Date.now() + 60_000)), "utf8");

    const auth = new CodexAuthManager({
      store: createFsAuthFileStore(authFilePath),
      oauthTokenUrl: `${oauth.url}/token`,
      logger: noopLogger,
    });

    const result = await auth.getCredentials();
    assert.ok(result.ok);
    assert.equal(result.value.accessToken, newToken);
    assert.equal(result.value.accountId, "acct_integration_1");
    assert.equal(oauth.requests.length, 1);

    const oauthBody = JSON.parse(oauth.requests[0]!.body.toString("utf8")) as Record<string, unknown>;
    assert.equal(oauthBody["grant_type"], "refresh_token");
    assert.equal(oauthBody["refresh_token"], "refresh-int-1");
    assert.equal(oauthBody["scope"], "openid profile email");
    assert.equal(typeof oauthBody["client_id"], "string");

    const rewritten = JSON.parse(await readFile(authFilePath, "utf8")) as Record<string, unknown>;
    const tokens = rewritten["tokens"] as Record<string, unknown>;
    assert.equal(tokens["access_token"], newToken);
    assert.equal(tokens["refresh_token"], "refresh-rotated-9");
    assert.equal(tokens["account_id"], "acct_integration_1");
    assert.deepEqual(rewritten["future_cli_key"], { must: "survive" });
    assert.equal(rewritten["OPENAI_API_KEY"], null);
    assert.notEqual(rewritten["last_refresh"], "2026-07-20T00:00:00.000Z");

    const leftovers = (await readdir(dir)).filter((name) => name !== "auth.json");
    assert.deepEqual(leftovers, [], "atomic write must leave no temp files behind");
  });

  it("caches credentials after one refresh so repeat calls stay off the token endpoint", async () => {
    const { oauth } = await setupOauth();
    const dir = await mkdtemp(join(tmpdir(), "croxy-auth-"));
    const authFilePath = join(dir, "auth.json");
    await writeFile(authFilePath, makeAuthFileContent(makeAccessToken(Date.now() + 60_000)), "utf8");

    const auth = new CodexAuthManager({
      store: createFsAuthFileStore(authFilePath),
      oauthTokenUrl: `${oauth.url}/token`,
      logger: noopLogger,
    });

    assert.ok((await auth.getCredentials()).ok);
    assert.ok((await auth.getCredentials()).ok);
    assert.ok((await auth.getCredentials()).ok);
    assert.equal(oauth.requests.length, 1);
  });
});
