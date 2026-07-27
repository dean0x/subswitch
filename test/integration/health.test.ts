import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { startSubswitch, startFakeUpstream } from "./fake-upstreams.js";

const cleanups: (() => Promise<void>)[] = [];
after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

describe("__subswitch health namespace", () => {
  it("GET /__subswitch/health returns 200 with name+version and does NOT forward to Anthropic", async () => {
    const anthropic = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    const subswitch = await startSubswitch({ anthropic: { baseUrl: anthropic.url } });
    cleanups.push(subswitch.close, anthropic.close);

    const response = await fetch(`${subswitch.url}/__subswitch/health`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
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
    const subswitch = await startSubswitch({ anthropic: { baseUrl: anthropic.url } });
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
    const subswitch = await startSubswitch({ anthropic: { baseUrl: anthropic.url } });
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

  // P1-8: Health providers[] shape test
  it("GET /__subswitch/health body has providers array with required per-provider fields", async () => {
    const anthropic = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    const subswitch = await startSubswitch({ anthropic: { baseUrl: anthropic.url } });
    cleanups.push(subswitch.close, anthropic.close);

    const response = await fetch(`${subswitch.url}/__subswitch/health`);
    assert.equal(response.status, 200);

    const body = (await response.json()) as {
      name: string;
      version: string;
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

    // "codex" must appear in providers (it is the only registered provider)
    const codexEntry = body.providers.find((p) => p.id === "codex");
    assert.ok(codexEntry !== undefined, "providers must include 'codex'");

    // modelCount for codex must reflect the real registry (non-zero, non-retired models)
    assert.ok(codexEntry.modelCount > 0, "codex must have at least one non-retired model in registry");

    // configured reflects whether the auth file exists on disk — we don't assert
    // a specific value here because the test machine's state varies (auth file may or may not exist).
    // The shape assertion above is sufficient: configured must be a boolean.
  });
});
