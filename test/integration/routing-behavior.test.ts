/**
 * Integration tests for routing-layer behavior:
 *   F7  — ambiguous family name → 400 with both provider names in the body
 *   F6g — unknown provider qualifier → 400 with provider list
 *   P2  — routing table built once: ≥2 requests route consistently without per-request rebuilds
 *         Verified via Proxy ownKeys trap on the aliases map (production resolver, no synthetic seam).
 *
 * F7 and F6g tests use the `resolve` injection seam in startSubswitch to drive the router
 * into states (ambiguous, unknown_qualifier) that cannot be produced by the real
 * registry alone (which only knows "codex").
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import {
  startSubswitch,
  startFakeUpstream,
  makeAuthFileContent,
  makeAccessToken,
} from "./fake-upstreams.js";
import { loadConfig } from "../../src/config.js";
import { buildDeps, createProxyServer } from "../../src/server.js";
import type { ModelResolution } from "../../src/models.js";

// ---------------------------------------------------------------------------
// F7: ambiguous family → 400 with both provider names
// ---------------------------------------------------------------------------

describe("routing — ambiguous family (F7)", () => {
  it("returns 400 when two providers claim the same family name", async () => {
    const cleanups: Array<() => Promise<void>> = [];

    // A synthetic resolver that always reports "fast" as ambiguous between two providers.
    const resolve = (name: string): ModelResolution =>
      name === "fast"
        ? { kind: "ambiguous", name: "fast", providers: ["codex", "kimi"] as never[] }
        : { kind: "unresolved" };

    const anthropic = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "msg_from_anthropic" }));
    });
    cleanups.push(anthropic.close);

    const dir = await mkdtemp(join(tmpdir(), "subswitch-ambig-test-"));
    const authFilePath = join(dir, "auth.json");
    await writeFile(authFilePath, makeAuthFileContent(makeAccessToken(Date.now() + 3_600_000)), "utf8");

    const subswitch = await startSubswitch(
      {
        anthropic: { baseUrl: anthropic.url },
        providers: { codex: { authFile: authFilePath } },
      },
      { resolve },
    );
    cleanups.push(subswitch.close);

    try {
      const response = await fetch(`${subswitch.url}/v1/messages`, {
        method: "POST",
        headers: {
          authorization: "Bearer sk-ant",
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "fast", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
      });

      assert.equal(response.status, 400, "ambiguous model name must return 400");

      const body = (await response.json()) as { error: { type: string; message: string } };
      assert.equal(body.error.type, "invalid_request_error", "error type must be invalid_request_error");
      assert.ok(body.error.message.includes("fast"), "error message must name the ambiguous model");
      assert.ok(body.error.message.includes("codex"), "error message must name the first provider");
      assert.ok(body.error.message.includes("kimi"), "error message must name the second provider");
      assert.ok(body.error.message.includes("multiple providers"), "error message must mention multiple providers");
    } finally {
      for (const cleanup of cleanups.reverse()) await cleanup();
    }
  });

  it("does not forward an ambiguous request to either upstream", async () => {
    const cleanups: Array<() => Promise<void>> = [];

    const resolve = (name: string): ModelResolution =>
      name === "fast"
        ? { kind: "ambiguous", name: "fast", providers: ["codex", "kimi"] as never[] }
        : { kind: "unresolved" };

    const anthropic = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "msg_from_anthropic" }));
    });
    cleanups.push(anthropic.close);

    const dir = await mkdtemp(join(tmpdir(), "subswitch-ambig-fwd-test-"));
    const authFilePath = join(dir, "auth.json");
    await writeFile(authFilePath, makeAuthFileContent(makeAccessToken(Date.now() + 3_600_000)), "utf8");

    const subswitch = await startSubswitch(
      {
        anthropic: { baseUrl: anthropic.url },
        providers: { codex: { authFile: authFilePath } },
      },
      { resolve },
    );
    cleanups.push(subswitch.close);

    try {
      const response = await fetch(`${subswitch.url}/v1/messages`, {
        method: "POST",
        headers: {
          authorization: "Bearer sk-ant",
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "fast", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
      });

      // The 400 must be emitted by subswitch itself — not proxied from any upstream.
      assert.equal(response.status, 400);
      assert.equal(anthropic.requests.length, 0, "anthropic upstream must not receive the request");
    } finally {
      for (const cleanup of cleanups.reverse()) await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// F6g: unknown provider qualifier → 400
// ---------------------------------------------------------------------------

describe("routing — unknown provider qualifier (F6g)", () => {
  it("returns 400 when the qualifier prefix is not a known provider", async () => {
    const cleanups: Array<() => Promise<void>> = [];

    // Synthetic resolver that returns unknown_qualifier for "kimee:k2"
    const resolve = (name: string): ModelResolution =>
      name === "kimee:k2"
        ? { kind: "unknown_qualifier", qualifier: "kimee" }
        : { kind: "unresolved" };

    const anthropic = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "msg_from_anthropic" }));
    });
    cleanups.push(anthropic.close);

    const dir = await mkdtemp(join(tmpdir(), "subswitch-unkn-prov-test-"));
    const authFilePath = join(dir, "auth.json");
    await writeFile(authFilePath, makeAuthFileContent(makeAccessToken(Date.now() + 3_600_000)), "utf8");

    const subswitch = await startSubswitch(
      {
        anthropic: { baseUrl: anthropic.url },
        providers: { codex: { authFile: authFilePath } },
      },
      { resolve },
    );
    cleanups.push(subswitch.close);

    try {
      const response = await fetch(`${subswitch.url}/v1/messages`, {
        method: "POST",
        headers: {
          authorization: "Bearer sk-ant",
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "kimee:k2", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
      });

      assert.equal(response.status, 400, "unknown provider qualifier must return 400");

      const body = (await response.json()) as { error: { type: string; message: string } };
      assert.equal(body.error.type, "invalid_request_error");
      assert.ok(body.error.message.includes("kimee"), "error message must name the unknown qualifier");
      assert.ok(body.error.message.includes("codex"), "error message must list the known providers");
      // Does not reach anthropic.
      assert.equal(anthropic.requests.length, 0, "unknown provider must not be forwarded to anthropic");
    } finally {
      for (const cleanup of cleanups.reverse()) await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// P2: routing table built once (structural guarantee via Proxy ownKeys trap)
//
// Approach: inject a Proxy for config.codex.aliases with an ownKeys trap that
// counts invocations. buildRoutingTable calls Object.keys(aliases) exactly once.
// After buildDeps returns, ≥2 requests are driven through the production resolver.
// The trap count must not increase beyond what was observed after buildDeps —
// proving the routing table is NOT rebuilt per-request.
//
// This replaces the prior synthetic-resolve test that could not observe production
// routing table builds. With the Proxy approach we drive the real resolver and
// intercept the structural guarantee at the alias-iteration boundary.
// ---------------------------------------------------------------------------

describe("routing — table built once via ownKeys trap (P2)", () => {
  it("ownKeys trap on aliases fires exactly once during buildDeps and not again across ≥2 requests", async () => {
    const cleanups: Array<() => Promise<void>> = [];

    const sseBody =
      "data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg1\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[],\"model\":\"gpt-5.6-sol\",\"stop_reason\":null,\"stop_sequence\":null,\"usage\":{\"input_tokens\":10,\"output_tokens\":0}}}\n\n" +
      "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n" +
      "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hi\"}}\n\n" +
      "data: {\"type\":\"content_block_stop\",\"index\":0}\n\n" +
      "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\",\"stop_sequence\":null},\"usage\":{\"output_tokens\":1}}\n\n" +
      "data: {\"type\":\"message_stop\"}\n\n";

    const codex = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(sseBody);
    });
    cleanups.push(codex.close);

    const anthropic = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "msg_from_anthropic" }));
    });
    cleanups.push(anthropic.close);

    const dir = await mkdtemp(join(tmpdir(), "subswitch-p2-proxy-test-"));
    const authFilePath = join(dir, "auth.json");
    await writeFile(authFilePath, makeAuthFileContent(makeAccessToken(Date.now() + 3_600_000)), "utf8");

    // Build config normally, then inject a Proxy for codex.aliases.
    const configResult = loadConfig({
      configPath: "inline-test-config.json",
      readFile: () =>
        JSON.stringify({
          logLevel: "error",
          anthropic: { baseUrl: anthropic.url },
          providers: { codex: { baseUrl: codex.url, authFile: authFilePath } },
        }),
    });
    assert.ok(configResult.ok, `config must load: ${!configResult.ok ? configResult.error.message : ""}`);
    const config = configResult.value.config;

    // Count how many times Object.keys() iterates the aliases map.
    // Each Object.keys() / Object.entries() call triggers the ownKeys trap once.
    let ownKeysCallCount = 0;
    const aliasesProxy = new Proxy({} as Record<string, string>, {
      ownKeys(target) {
        ownKeysCallCount++;
        return Reflect.ownKeys(target);
      },
      getOwnPropertyDescriptor(target, key) {
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });

    // buildDeps calls buildRoutingTable which calls Object.keys(aliases) once.
    const modifiedConfig = { ...config, codex: { ...config.codex, aliases: aliasesProxy } };
    const deps = buildDeps(modifiedConfig);
    const server = createProxyServer(deps);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const subswitchUrl = `http://127.0.0.1:${port}`;
    cleanups.push(
      () =>
        new Promise((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    );

    // Capture the ownKeys count immediately after buildDeps — this is the
    // "expected" count (1 call from buildRoutingTable's Object.keys(aliases)).
    const ownKeysAfterBuild = ownKeysCallCount;
    assert.equal(ownKeysAfterBuild, 1, "buildRoutingTable must call Object.keys(aliases) exactly once during buildDeps");

    try {
      const body = JSON.stringify({
        model: "gpt-5.6-sol",
        stream: true,
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }],
      });
      const headers = {
        authorization: "Bearer sk-ant",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      };

      // Drive two requests through the production resolver.
      const res1 = await fetch(`${subswitchUrl}/v1/messages`, { method: "POST", headers, body });
      assert.equal(res1.status, 200, "first request must succeed");
      await res1.text();

      const res2 = await fetch(`${subswitchUrl}/v1/messages`, { method: "POST", headers, body });
      assert.equal(res2.status, 200, "second request must succeed");
      await res2.text();

      // The ownKeys trap must NOT have fired again — the routing table is not rebuilt per-request.
      assert.equal(
        ownKeysCallCount,
        ownKeysAfterBuild,
        `ownKeys trap fired ${ownKeysCallCount - ownKeysAfterBuild} extra time(s) during request handling — routing table is being rebuilt per-request`,
      );

      // Both requests must have reached the codex upstream (correct routing).
      assert.equal(codex.requests.length, 2, "both requests must route to codex");
      assert.equal(anthropic.requests.length, 0, "neither request should reach anthropic");
    } finally {
      for (const cleanup of cleanups.reverse()) await cleanup();
    }
  });
});
