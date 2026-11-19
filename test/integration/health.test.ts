import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSubswitch, startFakeUpstream } from "./fake-upstreams.js";

const cleanups: (() => Promise<void>)[] = [];
let authDir: string;

before(async () => {
  authDir = await mkdtemp(join(tmpdir(), "subswitch-health-"));
  cleanups.push(() => rm(authDir, { recursive: true, force: true }));
  await writeFile(join(authDir, "auth.json"), "{}");
});

after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

// Use fixture paths so the health checks do not depend on local Codex state.
const startHealthProxy = (baseUrl: string, authFileName = "missing.json") =>
  startSubswitch({
    anthropic: { baseUrl },
    providers: { codex: { authFile: join(authDir, authFileName) } },
  });

describe("__subswitch health namespace", () => {
  it("GET /__subswitch/health returns 200 with name+version and does NOT forward to Anthropic", async () => {
    const anthropic = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    const subswitch = await startHealthProxy(anthropic.url);
    cleanups.push(subswitch.close, anthropic.close);

    const response = await fetch(`${subswitch.url}/__subswitch/health`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
    // C6: health 200 is relay-synthesized — must carry x-subswitch-synthesized: 1.
    // Non-vacuity: the marker is set via synthesizedHeaders() in server.ts line ~456;
    // removing it from synthesizedHeaders() would cause this assertion to fail.
    assert.equal(
      response.headers.get("x-subswitch-synthesized"),
      "1",
      "health 200 is relay-synthesized and must carry x-subswitch-synthesized: 1",
    );
    const body = (await response.json()) as { name: string; version: string };
    assert.equal(body.name, "subswitch");
    assert.equal(typeof body.version, "string");
    assert.ok(body.version.length > 0);
    // Critical: the health endpoint must never be forwarded to Anthropic.
    assert.equal(anthropic.requests.length, 0, "health check must not forward to Anthropic upstream");
  });

  it("GET /__subswitch/unknown returns 404 and does NOT forward to Anthropic", async () => {
    const anthropic = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    const subswitch = await startHealthProxy(anthropic.url);
    cleanups.push(subswitch.close, anthropic.close);

    const response = await fetch(`${subswitch.url}/__subswitch/unknown-path`);
    assert.equal(response.status, 404);
    assert.equal(anthropic.requests.length, 0, "unknown /__subswitch/* path must not forward to Anthropic upstream");
  });

  it("POST /__subswitch/anything returns 404 and does NOT forward to Anthropic", async () => {
    const anthropic = await startFakeUpstream((_req, res) => {
      res.writeHead(200);
      res.end("{}");
    });
    const subswitch = await startHealthProxy(anthropic.url);
    cleanups.push(subswitch.close, anthropic.close);

    const response = await fetch(`${subswitch.url}/__subswitch/health`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    // POST to /__subswitch/health is not the reserved GET method → 404, not forwarded
    assert.equal(response.status, 404);
    assert.equal(anthropic.requests.length, 0);
  });

  // P1-8: Health providers[] shape and Codex status tests.
  for (const { authFileName, configured } of [
    { authFileName: "missing.json", configured: false },
    { authFileName: "auth.json", configured: true },
  ]) {
    it(`GET /__subswitch/health has the provider fields and reports Codex configured=${configured}`, async () => {
      const anthropic = await startFakeUpstream((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
      cleanups.push(anthropic.close);
      const subswitch = await startHealthProxy(anthropic.url, authFileName);
      cleanups.push(subswitch.close);

      const response = await fetch(`${subswitch.url}/__subswitch/health`);
      assert.equal(response.status, 200);

      const body = (await response.json()) as {
        providers: Array<{ id: string; configured: boolean; modelCount: number }>;
      };

      // providers must be an array
      assert.ok(Array.isArray(body.providers), "providers must be an array");
      assert.ok(body.providers.length > 0, "providers must be non-empty");

      // Each entry must have the documented shape
      for (const provider of body.providers) {
        assert.ok(typeof provider.id === "string" && provider.id.length > 0, "provider.id must be a non-empty string");
        assert.ok(typeof provider.configured === "boolean", "provider.configured must be a boolean");
        assert.ok(typeof provider.modelCount === "number" && provider.modelCount >= 0, "provider.modelCount must be a non-negative number");
      }

      const codexEntry = body.providers.find((p) => p.id === "codex");
      assert.ok(codexEntry !== undefined, "providers must include 'codex'");
      assert.equal(codexEntry.configured, configured);

      // modelCount for codex must reflect the real registry (non-zero, non-retired models)
      assert.ok(codexEntry.modelCount > 0, "codex must have at least one non-retired model in registry");
    });
  }

  // ARCH-04: Anthropic passthrough must appear in health providers[]
  it("GET /__subswitch/health providers[] includes Anthropic with configured=true and modelCount=0", async () => {
    const anthropic = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    const subswitch = await startHealthProxy(anthropic.url);
    cleanups.push(subswitch.close, anthropic.close);

    const response = await fetch(`${subswitch.url}/__subswitch/health`);
    assert.equal(response.status, 200);

    const body = (await response.json()) as {
      providers: Array<{ id: string; configured: boolean; modelCount: number }>;
    };

    const anthropicEntry = body.providers.find((p) => p.id === "anthropic");
    assert.ok(
      anthropicEntry !== undefined,
      "providers[] must include 'anthropic' — health endpoint must match models --json topology (ARCH-04)",
    );
    assert.equal(
      anthropicEntry.configured,
      true,
      "Anthropic passthrough is always configured (no auth file required)",
    );
    assert.equal(
      anthropicEntry.modelCount,
      0,
      "Anthropic passthrough carries modelCount=0 (routing is passthrough, not registry-governed)",
    );
  });

  // MUTATION CHECK: if Anthropic were omitted from enumerateDestinations, the test above would fail
  it("MUTATION CHECK: providers[] must not be empty and must contain more than just codex", async () => {
    const anthropic = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    const subswitch = await startHealthProxy(anthropic.url);
    cleanups.push(subswitch.close, anthropic.close);

    const response = await fetch(`${subswitch.url}/__subswitch/health`);
    const body = (await response.json()) as {
      providers: Array<{ id: string }>;
    };

    assert.ok(
      body.providers.length > 1,
      "providers[] must have more than one entry — Anthropic + at least one registry provider",
    );
  });
});
