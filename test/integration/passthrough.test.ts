import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { startCroxy, startFakeUpstream, rawHttpRequest, type CroxyInstance, type FakeUpstream } from "./fake-upstreams.js";

const cleanups: (() => Promise<void>)[] = [];
after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

const setup = async (
  handler: Parameters<typeof startFakeUpstream>[0],
  limits: Record<string, unknown> = {},
): Promise<{ anthropic: FakeUpstream; croxy: CroxyInstance }> => {
  const anthropic = await startFakeUpstream(handler);
  const croxy = await startCroxy({ anthropic: { baseUrl: anthropic.url }, limits });
  cleanups.push(croxy.close, anthropic.close);
  return { anthropic, croxy };
};

describe("anthropic passthrough", () => {
  it("forwards method, path+query, auth headers, and body verbatim", async () => {
    const { anthropic, croxy } = await setup((_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "request-id": "req_fake_1" });
      res.end(JSON.stringify({ id: "msg_ok" }));
    });

    const body = JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 32, messages: [{ role: "user", content: "hi" }] });
    const response = await fetch(`${croxy.url}/v1/messages?beta=true`, {
      method: "POST",
      headers: {
        authorization: "Bearer sk-ant-oat-FAKE-OAUTH",
        "anthropic-beta": "oauth-2025-04-20,interleaved-thinking-2025-05-14",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "x-app": "cli",
      },
      body,
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("request-id"), "req_fake_1");
    assert.deepEqual(await response.json(), { id: "msg_ok" });

    const seen = anthropic.requests[0]!;
    assert.equal(seen.method, "POST");
    assert.equal(seen.url, "/v1/messages?beta=true");
    assert.equal(seen.headers["authorization"], "Bearer sk-ant-oat-FAKE-OAUTH");
    assert.equal(seen.headers["anthropic-beta"], "oauth-2025-04-20,interleaved-thinking-2025-05-14");
    assert.equal(seen.headers["anthropic-version"], "2023-06-01");
    assert.equal(seen.headers["x-app"], "cli");
    assert.equal(seen.body.toString("utf8"), body);
  });

  it("relays SSE responses byte-for-byte", async () => {
    const sse = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join("");
    const { croxy } = await setup((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(sse);
    });

    const response = await fetch(`${croxy.url}/v1/messages?beta=true`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", stream: true, messages: [] }),
    });
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    assert.equal(await response.text(), sse);
  });

  it("passes through HEAD / and GET /v1/models without buffering", async () => {
    const { anthropic, croxy } = await setup((req, res) => {
      if (req.method === "HEAD") {
        res.writeHead(200, { "x-probe": "ok" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [] }));
    });

    const head = await fetch(`${croxy.url}/`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("x-probe"), "ok");

    const models = await fetch(`${croxy.url}/v1/models?limit=5`);
    assert.equal(models.status, 200);
    assert.equal(anthropic.requests[1]!.url, "/v1/models?limit=5");
  });

  it("responds 413 with an anthropic-shaped error when the body exceeds the cap", async () => {
    const { anthropic, croxy } = await setup(
      (_req, res) => {
        res.writeHead(200);
        res.end();
      },
      { maxBodyBytes: 1024 },
    );

    const response = await fetch(`${croxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: `{"model":"claude-sonnet-4-6","padding":"${"x".repeat(4096)}"}`,
    });
    assert.equal(response.status, 413);
    const body = (await response.json()) as { type: string; error: { type: string } };
    assert.equal(body.type, "error");
    assert.equal(body.error.type, "invalid_request_error");
    assert.equal(anthropic.requests.length, 0);
  });

  it("responds 502 anthropic-shaped when the upstream is unreachable", async () => {
    const anthropic = await startFakeUpstream((_req, res) => res.end());
    await anthropic.close();
    const croxy = await startCroxy({ anthropic: { baseUrl: anthropic.url } });
    cleanups.push(croxy.close);

    const response = await fetch(`${croxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
    });
    assert.equal(response.status, 502);
    const body = (await response.json()) as { error: { type: string } };
    assert.equal(body.error.type, "api_error");
  });

  // ---------------------------------------------------------------------------
  // R2: keep-alive connection pooling
  // ---------------------------------------------------------------------------

  it("reuses a single TCP connection for two sequential requests (keep-alive)", async () => {
    const { anthropic, croxy } = await setup((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "msg_ok" }));
    });

    const opts = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
    };

    const r1 = await fetch(`${croxy.url}/v1/messages`, opts);
    assert.equal(r1.status, 200);
    await r1.body?.cancel(); // drain

    const r2 = await fetch(`${croxy.url}/v1/messages`, opts);
    assert.equal(r2.status, 200);
    await r2.body?.cancel();

    // croxy must have reused one TCP connection to the fake upstream
    assert.equal(anthropic.connectionCount, 1, "keep-alive: expected 1 TCP connection for 2 requests");
  });

  it("self-heals after the upstream socket is destroyed server-side", async () => {
    let capturedSocket: import("node:net").Socket | undefined;
    const anthropic = await startFakeUpstream((req, res, _body, index) => {
      if (index === 0) capturedSocket = req.socket as import("node:net").Socket;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "ok" }));
    });
    const croxy = await startCroxy({ anthropic: { baseUrl: anthropic.url } });
    cleanups.push(croxy.close, anthropic.close);

    const makePost = () =>
      fetch(`${croxy.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
      });

    // First request — builds the pooled connection
    const r1 = await makePost();
    assert.equal(r1.status, 200);
    await r1.text();

    // Destroy the upstream socket to simulate an idle-timeout or server restart
    capturedSocket!.destroy();
    // Wait for the TCP close to propagate through Node's event loop
    await new Promise<void>((resolve) => setTimeout(resolve, 80));

    // Next request must succeed: the agent detects the dead socket and opens a fresh one
    const r2 = await makePost();
    assert.equal(r2.status, 200, "keep-alive self-heal: second request after socket destroy must succeed");
    await r2.text();

    // Two TCP connections were needed (first pooled one was dead)
    assert.equal(anthropic.connectionCount, 2, "keep-alive self-heal: expected 2 connections after heal");
  });

  // ---------------------------------------------------------------------------
  // Header byte-parity — request direction (client → croxy → upstream)
  // ---------------------------------------------------------------------------

  it("forwards request headers byte-identically: preserves casing, order, and duplicates", async () => {
    const { anthropic, croxy } = await setup((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "ok" }));
    });

    // Mixed-case, out-of-standard-order, and a duplicate header.
    // anthropic-beta is included as PF-001 regression guard.
    const sentRawHeaders = [
      "Authorization", "Bearer sk-ant-oat-FAKE-OAUTH",
      "Anthropic-Beta", "oauth-2025-04-20,interleaved-thinking-2025-05-14",
      "anthropic-version", "2023-06-01",
      "X-App", "cli",
      "X-Custom", "first",
      "X-Custom", "second",
      "Content-Type", "application/json",
    ];

    await rawHttpRequest(`${croxy.url}/v1/messages`, {
      method: "POST",
      rawHeaders: sentRawHeaders,
      body: Buffer.from(JSON.stringify({ model: "claude-sonnet-4-6", messages: [] })),
    });

    const seen = anthropic.requests[0]!;
    const upstreamRaw = seen.rawHeaders;

    // Helper: convert flat raw-header array to [name, value] pairs
    const toPairs = (raw: string[]): [string, string][] => {
      const pairs: [string, string][] = [];
      for (let i = 0; i + 1 < raw.length; i += 2) pairs.push([raw[i]!, raw[i + 1]!]);
      return pairs;
    };

    const upstreamPairs = toPairs(upstreamRaw);
    const upstreamNameSet = new Set(upstreamPairs.map(([n]) => n.toLowerCase()));

    // 1. croxy must inject ONLY Host and Connection — nothing else.
    // content-length is auto-added by the HTTP client for the request body; it is NOT
    // injected by croxy, so we allow it here for POST requests.
    const allowed = new Set(["host", "connection", "content-length"]);
    const sentNames = new Set(
      toPairs(sentRawHeaders)
        .map(([n]) => n.toLowerCase()),
    );
    for (const [name] of upstreamPairs) {
      const lc = name.toLowerCase();
      if (!sentNames.has(lc)) {
        assert.ok(allowed.has(lc), `croxy injected unexpected header: ${name}`);
      }
    }

    // 2. PF-001: anthropic-beta header must arrive byte-identical (avoids PF-001)
    const hasBeta = upstreamPairs.some(
      ([n, v]) => n === "Anthropic-Beta" && v === "oauth-2025-04-20,interleaved-thinking-2025-05-14",
    );
    assert.ok(hasBeta, "Anthropic-Beta must be forwarded with exact name casing and value (avoids PF-001)");

    // 3. Every non-hop-by-hop sent header must appear byte-identically (name+value)
    const hopByHop = new Set([
      "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
      "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade", "host",
    ]);
    const expectedPairs = toPairs(sentRawHeaders).filter(([n]) => !hopByHop.has(n.toLowerCase()));
    for (const [name, value] of expectedPairs) {
      const found = upstreamPairs.some(([n, v]) => n === name && v === value);
      assert.ok(found, `header ${name}: ${value} must arrive byte-identical at upstream`);
    }

    // 4. Relative order of sent headers is preserved in what the upstream received
    //    (filter upstream to only the sent names, then verify sequence matches)
    const sentFiltered = toPairs(sentRawHeaders).filter(([n]) => upstreamNameSet.has(n.toLowerCase()));
    const upstreamFiltered = upstreamPairs.filter(([n]) => sentNames.has(n.toLowerCase()));
    assert.deepEqual(
      upstreamFiltered,
      sentFiltered,
      "request headers must reach upstream in original send order with original casing",
    );
  });

  // ---------------------------------------------------------------------------
  // Header byte-parity — response direction (upstream → croxy → client)
  // ---------------------------------------------------------------------------

  it("forwards response headers byte-identically: preserves casing, order, and duplicates", async () => {
    // These headers will be returned by the fake upstream with mixed casing
    const upstreamResponseHeaders = [
      "Content-Type", "application/json",
      "Request-Id", "req_parity_test",
      "X-UPPER-CASE", "VALUE",
      "x-lower-case", "value",
      "X-Mixed-Case", "MixedValue",
    ];

    const body = JSON.stringify({ id: "ok" });
    const { croxy } = await setup((_req, res) => {
      // Use writeHead with flat raw array so headers go out with original casing
      res.writeHead(200, upstreamResponseHeaders as string[]);
      res.end(body);
    });

    const response = await rawHttpRequest(`${croxy.url}/v1/models`, {
      method: "GET",
      rawHeaders: ["Accept", "application/json"],
    });

    assert.equal(response.status, 200);

    const toPairs = (raw: string[]): [string, string][] => {
      const pairs: [string, string][] = [];
      for (let i = 0; i + 1 < raw.length; i += 2) pairs.push([raw[i]!, raw[i + 1]!]);
      return pairs;
    };

    const receivedPairs = toPairs(response.rawHeaders);
    const receivedNames = new Set(receivedPairs.map(([n]) => n.toLowerCase()));

    // 1. Every upstream header must appear in the response byte-identically
    const expectedPairs = toPairs(upstreamResponseHeaders);
    for (const [name, value] of expectedPairs) {
      const found = receivedPairs.some(([n, v]) => n === name && v === value);
      assert.ok(found, `upstream response header ${name}: ${value} must reach client byte-identically`);
    }

    // 2. croxy must add only headers Node's HTTP server must inject.
    // Node adds Date, Connection, and Keep-Alive (on keep-alive connections), plus
    // Transfer-Encoding when there is no explicit Content-Length.
    const upstreamNames = new Set(expectedPairs.map(([n]) => n.toLowerCase()));
    const allowedInjections = new Set(["date", "connection", "keep-alive", "transfer-encoding"]);
    for (const [name] of receivedPairs) {
      const lc = name.toLowerCase();
      if (!upstreamNames.has(lc)) {
        assert.ok(allowedInjections.has(lc), `croxy injected unexpected response header: ${name}`);
      }
    }

    // 3. Relative order of upstream response headers must be preserved
    const upstreamFiltered = expectedPairs.filter(([n]) => receivedNames.has(n.toLowerCase()));
    const receivedFiltered = receivedPairs.filter(([n]) => upstreamNames.has(n.toLowerCase()));
    assert.deepEqual(
      receivedFiltered,
      upstreamFiltered,
      "response headers must reach client in original upstream order with original casing",
    );
  });
});
