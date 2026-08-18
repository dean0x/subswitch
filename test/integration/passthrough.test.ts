import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import type { LogLevel } from "../../src/logger.js";
import { startSubswitch, startFakeUpstream, rawHttpRequest, type SubswitchInstance, type FakeUpstream } from "./fake-upstreams.js";

const cleanups: (() => Promise<void>)[] = [];
after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

const setup = async (
  handler: Parameters<typeof startFakeUpstream>[0],
  limits: Record<string, unknown> = {},
): Promise<{ anthropic: FakeUpstream; subswitch: SubswitchInstance }> => {
  const anthropic = await startFakeUpstream(handler);
  const subswitch = await startSubswitch({ anthropic: { baseUrl: anthropic.url }, limits });
  cleanups.push(subswitch.close, anthropic.close);
  return { anthropic, subswitch };
};

/** Convert a flat [name, value, ...] raw-header array to [name, value] pairs. */
const toPairs = (raw: string[]): [string, string][] => {
  const pairs: [string, string][] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) pairs.push([raw[i]!, raw[i + 1]!]);
  return pairs;
};

describe("anthropic passthrough", () => {
  it("forwards method, path+query, auth headers, and body verbatim", async () => {
    const { anthropic, subswitch } = await setup((_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "request-id": "req_fake_1" });
      res.end(JSON.stringify({ id: "msg_ok" }));
    });

    const body = JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 32, messages: [{ role: "user", content: "hi" }] });
    const response = await fetch(`${subswitch.url}/v1/messages?beta=true`, {
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
    const { subswitch } = await setup((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(sse);
    });

    const response = await fetch(`${subswitch.url}/v1/messages?beta=true`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", stream: true, messages: [] }),
    });
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    assert.equal(await response.text(), sse);
  });

  it("passes through HEAD / and GET /v1/models without buffering", async () => {
    const { anthropic, subswitch } = await setup((req, res) => {
      if (req.method === "HEAD") {
        res.writeHead(200, { "x-probe": "ok" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [] }));
    });

    const head = await fetch(`${subswitch.url}/`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("x-probe"), "ok");

    const models = await fetch(`${subswitch.url}/v1/models?limit=5`);
    assert.equal(models.status, 200);
    assert.equal(anthropic.requests[1]!.url, "/v1/models?limit=5");
  });

  it("responds 413 with an anthropic-shaped error when the body exceeds the cap", async () => {
    const { anthropic, subswitch } = await setup(
      (_req, res) => {
        res.writeHead(200);
        res.end();
      },
      { maxBodyBytes: 1024 },
    );

    const response = await fetch(`${subswitch.url}/v1/messages`, {
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
    const subswitch = await startSubswitch({ anthropic: { baseUrl: anthropic.url } });
    cleanups.push(subswitch.close);

    const response = await fetch(`${subswitch.url}/v1/messages`, {
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
    const { anthropic, subswitch } = await setup((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "msg_ok" }));
    });

    const opts = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
    };

    const r1 = await fetch(`${subswitch.url}/v1/messages`, opts);
    assert.equal(r1.status, 200);
    await r1.body?.cancel(); // drain

    const r2 = await fetch(`${subswitch.url}/v1/messages`, opts);
    assert.equal(r2.status, 200);
    await r2.body?.cancel();

    // subswitch must have reused one TCP connection to the fake upstream
    assert.equal(anthropic.connectionCount, 1, "keep-alive: expected 1 TCP connection for 2 requests");
  });

  it("self-heals after the upstream socket is destroyed server-side", async () => {
    let capturedSocket: import("node:net").Socket | undefined;
    const anthropic = await startFakeUpstream((req, res, _body, index) => {
      if (index === 0) capturedSocket = req.socket as import("node:net").Socket;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "ok" }));
    });
    const subswitch = await startSubswitch({ anthropic: { baseUrl: anthropic.url } });
    cleanups.push(subswitch.close, anthropic.close);

    const makePost = () =>
      fetch(`${subswitch.url}/v1/messages`, {
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
  // Header byte-parity — request direction (client → subswitch → upstream)
  // ---------------------------------------------------------------------------

  it("forwards request headers byte-identically: preserves casing, order, and duplicates", async () => {
    const { anthropic, subswitch } = await setup((_req, res) => {
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

    await rawHttpRequest(`${subswitch.url}/v1/messages`, {
      method: "POST",
      rawHeaders: sentRawHeaders,
      body: Buffer.from(JSON.stringify({ model: "claude-sonnet-4-6", messages: [] })),
    });

    const seen = anthropic.requests[0]!;
    const upstreamRaw = seen.rawHeaders;

    const upstreamPairs = toPairs(upstreamRaw);
    const upstreamNameSet = new Set(upstreamPairs.map(([n]) => n.toLowerCase()));

    // 1. subswitch must inject ONLY Host and Connection — nothing else.
    // content-length is auto-added by the HTTP client for the request body; it is NOT
    // injected by subswitch, so we allow it here for POST requests.
    const allowed = new Set(["host", "connection", "content-length"]);
    const sentNames = new Set(
      toPairs(sentRawHeaders)
        .map(([n]) => n.toLowerCase()),
    );
    for (const [name] of upstreamPairs) {
      const lc = name.toLowerCase();
      if (!sentNames.has(lc)) {
        assert.ok(allowed.has(lc), `subswitch injected unexpected header: ${name}`);
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
  // Header byte-parity — response direction (upstream → subswitch → client)
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
    const { subswitch } = await setup((_req, res) => {
      // Use writeHead with flat raw array so headers go out with original casing
      res.writeHead(200, upstreamResponseHeaders as string[]);
      res.end(body);
    });

    const response = await rawHttpRequest(`${subswitch.url}/v1/models`, {
      method: "GET",
      rawHeaders: ["Accept", "application/json"],
    });

    assert.equal(response.status, 200);

    const receivedPairs = toPairs(response.rawHeaders);
    const receivedNames = new Set(receivedPairs.map(([n]) => n.toLowerCase()));

    // 1. Every upstream header must appear in the response byte-identically
    const expectedPairs = toPairs(upstreamResponseHeaders);
    for (const [name, value] of expectedPairs) {
      const found = receivedPairs.some(([n, v]) => n === name && v === value);
      assert.ok(found, `upstream response header ${name}: ${value} must reach client byte-identically`);
    }

    // 2. subswitch must add only headers Node's HTTP server must inject.
    // Node adds Date, Connection, and Keep-Alive (on keep-alive connections), plus
    // Transfer-Encoding when there is no explicit Content-Length.
    const upstreamNames = new Set(expectedPairs.map(([n]) => n.toLowerCase()));
    const allowedInjections = new Set(["date", "connection", "keep-alive", "transfer-encoding"]);
    for (const [name] of receivedPairs) {
      const lc = name.toLowerCase();
      if (!upstreamNames.has(lc)) {
        assert.ok(allowedInjections.has(lc), `subswitch injected unexpected response header: ${name}`);
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

  // ---------------------------------------------------------------------------
  // Timeout semantics — regression tests for issue #27
  // ---------------------------------------------------------------------------
  //
  // connectTimeoutMs must bound only TCP connection establishment.  Once
  // connected (or when a pooled socket is reused), the timer is re-armed to
  // streamIdleTimeoutMs so that upstream think-time beyond connectTimeoutMs
  // is not spuriously cut off with a 504.

  it("does not 504 when upstream think-time exceeds connectTimeoutMs but is under streamIdleTimeoutMs", async () => {
    // Upstream delays its response by 200 ms — intentionally longer than
    // connectTimeoutMs (50 ms) but shorter than streamIdleTimeoutMs (500 ms).
    // Before the fix the 50 ms timer fired immediately after connect and
    // produced a 504; after the fix the timer is re-armed to 500 ms on connect.
    const anthropic = await startFakeUpstream((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "msg_think_time" }));
      }, 200);
    });
    const subswitch = await startSubswitch({
      anthropic: {
        baseUrl: anthropic.url,
        connectTimeoutMs: 50,
        streamIdleTimeoutMs: 500,
      },
    });
    cleanups.push(subswitch.close, anthropic.close);

    const response = await fetch(`${subswitch.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
    });
    assert.equal(
      response.status,
      200,
      "response must be 200 — connectTimeoutMs must not cut off upstream think-time after connect",
    );
    const body = (await response.json()) as { id: string };
    assert.equal(body.id, "msg_think_time");
  });

  it("emits exactly one warn event on a genuine upstream timeout (no duplicate anthropic_upstream_error)", async () => {
    // Upstream accepts the connection but never sends headers.
    // After streamIdleTimeoutMs (100 ms) the timeout handler fires, writes a
    // 504, and calls upstream.destroy().  That destroy() makes the ClientRequest
    // emit 'error'; the error handler must return early (via `settled`) and must
    // NOT log a second anthropic_upstream_error warn.
    const captured: Array<{ level: LogLevel; event: string }> = [];
    const anthropic = await startFakeUpstream((_req, _res) => {
      // Never responds — stall indefinitely so the idle timer fires.
    });
    const subswitch = await startSubswitch(
      {
        anthropic: {
          baseUrl: anthropic.url,
          connectTimeoutMs: 50,
          streamIdleTimeoutMs: 100,
        },
      },
      {
        logger: {
          log(level, event) {
            captured.push({ level, event });
          },
        },
      },
    );
    cleanups.push(subswitch.close, anthropic.close);

    const response = await fetch(`${subswitch.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
    });
    assert.equal(response.status, 504, "timed-out upstream must produce a 504");
    await response.text(); // drain

    // Allow one extra event-loop turn for any stray error events to land.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    const upstreamEvents = captured.filter((e) => e.event.startsWith("anthropic_upstream"));
    assert.equal(upstreamEvents.length, 1, `expected exactly 1 upstream warn event, got: ${JSON.stringify(upstreamEvents)}`);
    assert.equal(upstreamEvents[0]!.event, "anthropic_upstream_timeout", "the single warn must be anthropic_upstream_timeout");
    assert.equal(upstreamEvents[0]!.level, "warn");
  });

  it("re-arms streamIdleTimeoutMs immediately on a pooled (keep-alive) socket", async () => {
    // The pooled socket path takes the `else rearm()` branch because
    // socket.connecting is false on a reused socket — no 'connect' event fires.
    // Verify that a second request whose upstream think-time exceeds
    // connectTimeoutMs but is under streamIdleTimeoutMs still succeeds.
    let requestIndex = 0;
    const anthropic = await startFakeUpstream((_req, res) => {
      const idx = requestIndex++;
      if (idx === 0) {
        // First request: respond immediately to establish the pooled socket.
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "first" }));
      } else {
        // Second request: delay 200 ms — longer than connectTimeoutMs (50 ms),
        // shorter than streamIdleTimeoutMs (500 ms).  On a reused socket the
        // `else rearm()` branch must arm the 500 ms budget immediately.
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ id: "pooled" }));
        }, 200);
      }
    });
    const subswitch = await startSubswitch({
      anthropic: {
        baseUrl: anthropic.url,
        connectTimeoutMs: 50,
        streamIdleTimeoutMs: 500,
      },
    });
    cleanups.push(subswitch.close, anthropic.close);

    const postOpts = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
    } as const;

    // First request: builds the pooled connection.
    const r1 = await fetch(`${subswitch.url}/v1/messages`, postOpts);
    assert.equal(r1.status, 200);
    await r1.text();

    // Second request: reuses the pooled socket (else rearm() branch).
    const r2 = await fetch(`${subswitch.url}/v1/messages`, postOpts);
    assert.equal(
      r2.status,
      200,
      "pooled socket: streamIdleTimeoutMs must be armed immediately via else rearm(), not cut off at connectTimeoutMs",
    );
    const body2 = (await r2.json()) as { id: string };
    assert.equal(body2.id, "pooled");

    // Both requests must have used one TCP connection (keep-alive reuse).
    assert.equal(anthropic.connectionCount, 1, "keep-alive: both requests must share one TCP connection");
  });
});
