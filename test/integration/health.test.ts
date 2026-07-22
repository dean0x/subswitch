import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { startCroxy, startFakeUpstream } from "./fake-upstreams.js";

const cleanups: (() => Promise<void>)[] = [];
after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

describe("__croxy health namespace", () => {
  it("GET /__croxy/health returns 200 with name+version and does NOT forward to Anthropic", async () => {
    const anthropic = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    const croxy = await startCroxy({ anthropic: { baseUrl: anthropic.url } });
    cleanups.push(croxy.close, anthropic.close);

    const response = await fetch(`${croxy.url}/__croxy/health`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
    const body = (await response.json()) as { name: string; version: string };
    assert.equal(body.name, "croxy");
    assert.equal(typeof body.version, "string");
    assert.ok(body.version.length > 0);
    // Critical: the health endpoint must never be forwarded to Anthropic.
    assert.equal(anthropic.requests.length, 0, "health check must not forward to Anthropic upstream");
  });

  it("GET /__croxy/unknown returns 404 and does NOT forward to Anthropic", async () => {
    const anthropic = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    const croxy = await startCroxy({ anthropic: { baseUrl: anthropic.url } });
    cleanups.push(croxy.close, anthropic.close);

    const response = await fetch(`${croxy.url}/__croxy/unknown-path`);
    assert.equal(response.status, 404);
    assert.equal(anthropic.requests.length, 0, "unknown /__croxy/* path must not forward to Anthropic upstream");
  });

  it("POST /__croxy/anything returns 404 and does NOT forward to Anthropic", async () => {
    const anthropic = await startFakeUpstream((_req, res) => {
      res.writeHead(200);
      res.end("{}");
    });
    const croxy = await startCroxy({ anthropic: { baseUrl: anthropic.url } });
    cleanups.push(croxy.close, anthropic.close);

    const response = await fetch(`${croxy.url}/__croxy/health`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    // POST to /__croxy/health is not the reserved GET method → 404, not forwarded
    assert.equal(response.status, 404);
    assert.equal(anthropic.requests.length, 0);
  });
});
