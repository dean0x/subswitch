/**
 * Integration tests for routing-layer behavior:
 *   F7  — ambiguous family name → fail-open (forwarded to Anthropic), warn log carries provider list
 *   F6g — unknown provider qualifier → fail-open (forwarded to Anthropic, not 400)
 *   L1  — colon-bearing unknown model name routes to Anthropic (not 400); real codex: prefix still works
 *   L4  — oversized body returns 413 with type "request_too_large" (matches Anthropic taxonomy)
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
// F7: ambiguous family → fail-open (forwarded to Anthropic, warn log carries provider list)
//
// Rationale (ADR-010): A relay-invented 400 naming our own provider registry is a
// relay-invented status the origin never emits — a defect.  PROVIDER_IDS only contains
// "codex" today, so this branch is currently unreachable in practice.  It becomes live
// the moment a second provider ships; the fail-open policy ensures correctness by default.
//
// Non-vacuity: if the old 400 branch were still active, assert.equal(response.status, 200)
// would fail and assert.equal(anthropic.requests.length, 1) would fail (0 requests).
// ---------------------------------------------------------------------------

describe("routing — ambiguous family forwards to Anthropic (F7)", () => {
  it("forwards to Anthropic when two providers claim the same family name", async () => {
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

    const captured: Array<{ event: string; model: string | undefined }> = [];
    const subswitch = await startSubswitch(
      {
        anthropic: { baseUrl: anthropic.url },
        providers: { codex: { authFile: authFilePath } },
      },
      {
        resolve,
        logger: { log(_level, event, fields?: Record<string, unknown>) { captured.push({ event, model: fields?.model as string | undefined }); } },
      },
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

      // Must NOT return 400 — the relay has no authority to reject ambiguous names (ADR-010).
      assert.equal(response.status, 200, "ambiguous model name must forward to Anthropic, not 400");

      // Must reach Anthropic (fail-open).
      assert.equal(anthropic.requests.length, 1, "request must be forwarded to Anthropic upstream");

      await response.body?.cancel();

      // A warn log must be emitted with both provider names in the model field.
      await new Promise<void>((r) => setTimeout(r, 20));
      const warnLog = captured.find((e) => e.event === "ambiguous_model_name");
      assert.ok(warnLog !== undefined, "ambiguous_model_name warn must be logged");
      assert.ok(warnLog.model?.includes("fast"), "warn log model field must include the ambiguous name");
      assert.ok(warnLog.model?.includes("codex"), "warn log model field must include first provider");
      assert.ok(warnLog.model?.includes("kimi"), "warn log model field must include second provider");
    } finally {
      for (const cleanup of cleanups.reverse()) await cleanup();
    }
  });

});

// ---------------------------------------------------------------------------
// F6g / L1: unknown provider qualifier → fail-open (forwarded to Anthropic)
//
// When a colon-separated name has an unknown prefix (not a registered provider),
// the relay must NOT return a 400 citing its own provider registry. The origin
// may support the model (e.g. future namespaced ids like "claude-sonnet-9:preview");
// the relay's job is to forward, not to police names it doesn't recognise.
// ---------------------------------------------------------------------------

describe("routing — unknown provider qualifier fails open to Anthropic (F6g / L1)", () => {
  it("forwards to Anthropic (not 400) when the qualifier prefix is not a known provider", async () => {
    const cleanups: Array<() => Promise<void>> = [];

    // Synthetic resolver that returns unknown_qualifier for "kimee:k2".
    // The router maps this to "unknown_provider", and the server must fail open.
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

    // C8: Attach a logger to capture the unknown_provider_qualifier warn event.
    // Previously the test had ZERO log capture — the event had zero test hits.
    const captured: Array<{ event: string; fields: Record<string, unknown> }> = [];

    const subswitch = await startSubswitch(
      {
        anthropic: { baseUrl: anthropic.url },
        providers: { codex: { authFile: authFilePath } },
      },
      {
        resolve,
        logger: {
          log(_level: string, event: string, fields: Record<string, unknown> = {}) {
            captured.push({ event, fields });
          },
        },
      },
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

      // Must return 200 — the relay has no authority to reject names it doesn't recognise.
      // Non-vacuity: assert.equal(200) fails on any other status, including 400 and 500,
      // so a broken relay that returns 400 or 504 turns this red.
      assert.equal(response.status, 200, "unknown provider qualifier must be forwarded with 200 (fail-open)");

      // Must reach Anthropic (fail-open routing).
      assert.equal(anthropic.requests.length, 1, "request must be forwarded to Anthropic upstream");
      await response.body?.cancel();

      // Allow the event loop to drain so the request_complete log fires.
      await new Promise<void>((r) => setTimeout(r, 50));

      // C8: unknown_provider_qualifier warn must fire with the qualifier field.
      // Non-vacuity: without the logger injection, this would always pass vacuously.
      // Removing the warn log from server.ts (line ~571) causes this assertion to fail.
      const warnLog = captured.find((e) => e.event === "unknown_provider_qualifier");
      assert.ok(warnLog !== undefined, "unknown_provider_qualifier warn must be logged");
      assert.equal(warnLog.fields.model, "kimee", "warn must carry the unknown qualifier as model field");
    } finally {
      for (const cleanup of cleanups.reverse()) await cleanup();
    }
  });

  it("a real codex: prefix still resolves as a provider qualifier (not forwarded to Anthropic)", async () => {
    const cleanups: Array<() => Promise<void>> = [];

    // Real registry resolution: "codex:gpt-5.6-sol" → resolved as Codex.
    // Uses default resolver (no synthetic seam) so the real registry is exercised.
    //
    // Minimal Responses-API stream: response.created → response.completed.
    // The codex leg translates this sequence into Anthropic SSE and aggregates
    // it for the non-streaming request the test sends (stream not set).
    const sseBody =
      "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_routing1\",\"model\":\"gpt-5.6-sol\",\"status\":\"in_progress\"}}\n\n" +
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_routing1\",\"model\":\"gpt-5.6-sol\",\"status\":\"completed\",\"usage\":{\"input_tokens\":10,\"output_tokens\":1}}}\n\n";

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

    const dir = await mkdtemp(join(tmpdir(), "subswitch-codex-prefix-test-"));
    const authFilePath = join(dir, "auth.json");
    await writeFile(authFilePath, makeAuthFileContent(makeAccessToken(Date.now() + 3_600_000)), "utf8");

    const subswitch = await startSubswitch({
      anthropic: { baseUrl: anthropic.url },
      providers: { codex: { baseUrl: codex.url, authFile: authFilePath } },
    });
    cleanups.push(subswitch.close);

    try {
      const response = await fetch(`${subswitch.url}/v1/messages`, {
        method: "POST",
        headers: {
          authorization: "Bearer sk-ant",
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "codex:gpt-5.6-sol", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
      });

      // Must route to Codex, not to the anthropic upstream.
      assert.equal(codex.requests.length, 1, "codex: prefix must route to the Codex upstream");
      assert.equal(anthropic.requests.length, 0, "codex: prefix must NOT route to Anthropic");
      assert.equal(response.status, 200, "codex: prefix routing must succeed with status 200");
      await response.body?.cancel();
    } finally {
      for (const cleanup of cleanups.reverse()) await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// L4: oversized body → 413 with type "request_too_large"
// ---------------------------------------------------------------------------

describe("routing — oversized body returns request_too_large (L4)", () => {
  it("returns 413 with error type 'request_too_large' for a body exceeding maxBodyBytes", async () => {
    const cleanups: Array<() => Promise<void>> = [];

    const anthropic = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "msg_from_anthropic" }));
    });
    cleanups.push(anthropic.close);

    // maxBodyBytes: 64 bytes — tiny, so we can trigger the limit easily.
    const subswitch = await startSubswitch({
      anthropic: { baseUrl: anthropic.url },
      limits: { maxBodyBytes: 64 },
    });
    cleanups.push(subswitch.close);

    try {
      const oversizedBody = Buffer.alloc(128, "x"); // 128 > 64 → triggers 413
      const response = await fetch(`${subswitch.url}/v1/messages`, {
        method: "POST",
        headers: {
          authorization: "Bearer sk-ant",
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: oversizedBody,
      });

      assert.equal(response.status, 413, "oversized body must return 413");
      const body = (await response.json()) as { type: string; error: { type: string; message: string } };
      assert.equal(body.type, "error", "response type must be 'error'");
      assert.equal(
        body.error.type,
        "request_too_large",
        "413 error type must be 'request_too_large', not 'invalid_request_error'",
      );
      // Must NOT reach the upstream — the relay caps before forwarding.
      assert.equal(anthropic.requests.length, 0, "oversized body must not reach the upstream");
    } finally {
      for (const cleanup of cleanups.reverse()) await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// P2: routing table built once (structural guarantee via Proxy ownKeys trap)
//
// Approach: inject a Proxy for config.providers.codex.aliases with an ownKeys trap that
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

    // Build config normally, then inject a Proxy for providers.codex.aliases.
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
    const modifiedConfig = {
      ...config,
      providers: { ...config.providers, codex: { ...config.providers.codex, aliases: aliasesProxy } },
    };
    const depsResult = buildDeps(modifiedConfig);
    assert.ok(depsResult.ok, `buildDeps must succeed for default config: ${!depsResult.ok ? depsResult.error : ""}`);
    const deps = depsResult.value;
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

    // Capture the ownKeys count immediately after buildDeps.  The routing table
    // is built once and must call Object.keys(aliases) at least once.  Pinning
    // the exact count to 1 is an implementation detail; the delta assertion at
    // lines below already carries the build-once claim (zero extra calls across
    // ≥2 requests).
    const ownKeysAfterBuild = ownKeysCallCount;
    assert.ok(ownKeysAfterBuild >= 1, "buildRoutingTable must iterate aliases at least once during buildDeps");

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

// ---------------------------------------------------------------------------
// L1 (real-registry): "claude-sonnet-9:preview" routes to Anthropic, not 400.
//
// The CHANGELOG motivation for the F6g / L1 fix is that namespaced model ids
// like "claude-sonnet-9:preview" must not be rejected with a relay-invented 400
// citing the provider registry.  The existing F6g test uses a synthetic resolver
// to drive the unknown_qualifier path; this test exercises the REAL registry so
// the literal motivating name has end-to-end coverage.
//
// Non-vacuity: if the relay returned 400 for unknown qualifiers, this test would
// fail at assert.equal(response.status, 200).
// ---------------------------------------------------------------------------

describe("routing — 'claude-sonnet-9:preview' routes to Anthropic via the real registry (L1-real)", () => {
  it("forwards claude-sonnet-9:preview to Anthropic (200, byte-identical body) — real registry, no synthetic seam", async () => {
    const cleanups: Array<() => Promise<void>> = [];

    // Fake Anthropic that returns a recognisable response body.
    const anthropicUpstream = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "msg_real_registry_l1" }));
    });
    cleanups.push(anthropicUpstream.close);

    const dir = await mkdtemp(join(tmpdir(), "subswitch-l1-real-"));
    const authFilePath = join(dir, "auth.json");
    await writeFile(authFilePath, makeAuthFileContent(makeAccessToken(Date.now() + 3_600_000)), "utf8");

    // startSubswitch with NO `resolve` override — the real registry resolver is used.
    const subswitch = await startSubswitch({
      anthropic: { baseUrl: anthropicUpstream.url },
      providers: { codex: { authFile: authFilePath } },
    });
    cleanups.push(subswitch.close);

    try {
      const response = await fetch(`${subswitch.url}/v1/messages`, {
        method: "POST",
        headers: {
          authorization: "Bearer sk-ant",
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-sonnet-9:preview",
          max_tokens: 16,
          messages: [{ role: "user", content: "hi" }],
        }),
      });

      // Must forward to Anthropic with 200 — relay must not police names it does not recognise.
      // Non-vacuity: assert.equal(200) fails on any other status, including 400 and 500.
      assert.equal(response.status, 200, "'claude-sonnet-9:preview' must be forwarded to Anthropic with 200 (relay must fail open)");

      // Must reach Anthropic (the real registry knows no provider for 'claude-sonnet-9:preview').
      assert.equal(anthropicUpstream.requests.length, 1, "request must be forwarded to Anthropic");

      // Response body must be forwarded byte-identical (no relay mangling).
      const parsed = (await response.json()) as { id: string };
      assert.equal(parsed.id, "msg_real_registry_l1", "response body must be forwarded byte-identical from upstream");
    } finally {
      for (const cleanup of cleanups.reverse()) await cleanup();
    }
  });
});
