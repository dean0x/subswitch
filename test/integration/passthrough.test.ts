import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { LogLevel } from "../../src/logger.js";
import { createAnthropicForwarder } from "../../src/anthropic-passthrough.js";
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
    assert.equal(body.error.type, "request_too_large");
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
  // Timeout semantics — ADR-010 compliance
  // ---------------------------------------------------------------------------
  //
  // connectTimeoutMs bounds ONLY TCP connection establishment.  Once connected
  // the timer is DISARMED.  The relay must never fire a timer that terminates
  // a connected client's request — no headerTimeoutMs, no streamIdleTimeoutMs.

  it("does not 504 when upstream think-time exceeds connectTimeoutMs (no further timer after connect)", async () => {
    // Upstream delays its response by 200 ms — intentionally longer than
    // connectTimeoutMs (50 ms).  Before the fix the connect-phase timer fired
    // immediately after connect and produced a 504; after the fix the timer is
    // DISARMED on connect (ADR-010) so the 200 ms delay completes successfully.
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
      "response must be 200 — relay must not fire any timer after TCP connect",
    );
    const body = (await response.json()) as { id: string };
    assert.equal(body.id, "msg_think_time");
  });

  it("slow-header upstream is not terminated by the relay (ADR-010: no headers-phase timer)", async () => {
    // Upstream accepts the connection but delays headers by 300 ms.
    // Previously headerTimeoutMs would have fired at ~100 ms and produced a 504.
    // After ADR-010 no such timer exists — the 300 ms delay must complete with 200.
    //
    // Non-vacuity: if a 100 ms headers-phase timer were still armed after connect,
    // the response would be 504, not 200, and this test would fail.
    const captured: Array<{ level: LogLevel; event: string }> = [];
    const anthropic = await startFakeUpstream((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "slow_headers" }));
      }, 300);
    });
    const subswitch = await startSubswitch(
      {
        anthropic: {
          baseUrl: anthropic.url,
          connectTimeoutMs: 50,
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
    assert.equal(response.status, 200, "slow-header upstream must not be terminated by the relay");
    const body = (await response.json()) as { id: string };
    assert.equal(body.id, "slow_headers");

    // Allow one event-loop turn for stray events.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    const upstreamEvents = captured.filter((e) => e.event.startsWith("anthropic_upstream"));
    assert.equal(upstreamEvents.length, 0, `no upstream events must fire on a successful response; got: ${JSON.stringify(upstreamEvents)}`);
  });

  it("pooled (keep-alive) socket reuse succeeds when second request delays beyond connectTimeoutMs", async () => {
    // On a pooled socket the connect phase is already done and connectTimeoutMs
    // has no effect — the relay arms NO timer of any kind (ADR-010).
    // A 200 ms delay on the second (pooled) request must succeed.
    let requestIndex = 0;
    const anthropic = await startFakeUpstream((_req, res) => {
      const idx = requestIndex++;
      if (idx === 0) {
        // First request: respond immediately to establish the pooled connection.
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "first" }));
      } else {
        // Second request: delay 200 ms — longer than connectTimeoutMs (50 ms).
        // On a reused socket there is no connect phase and no timer — must succeed.
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
      },
    });
    cleanups.push(subswitch.close, anthropic.close);

    const postOpts = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
    } as const;

    // First request: establishes the pooled connection.
    const r1 = await fetch(`${subswitch.url}/v1/messages`, postOpts);
    assert.equal(r1.status, 200);
    await r1.text();

    // Second request: reuses the pooled socket.
    const r2 = await fetch(`${subswitch.url}/v1/messages`, postOpts);
    assert.equal(
      r2.status,
      200,
      "pooled socket: 200 ms delay must succeed — no timer armed after connect (ADR-010)",
    );
    const body2 = (await r2.json()) as { id: string };
    assert.equal(body2.id, "pooled");

    // Both requests must have used one TCP connection (keep-alive reuse).
    assert.equal(anthropic.connectionCount, 1, "keep-alive: both requests must share one TCP connection");
  });

  it("idle stream is not terminated by the relay (ADR-010: no stream-idle timer)", async () => {
    // Upstream sends 3 chunks, idles for 400 ms, then sends 3 more and closes.
    // Previously streamIdleTimeoutMs (100 ms) would have fired during the idle gap
    // and destroyed the connection. After ADR-010 no such timer exists — all 6
    // chunks must arrive.
    //
    // Non-vacuity: if a 100 ms stream-idle timer were still active, the connection
    // would be destroyed during the 400 ms gap and chunks 4–6 would never arrive.
    const anthropic = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      let sent = 0;
      const sendChunk = (): void => {
        sent++;
        res.write(`event: ping\ndata: ${sent}\n\n`);
      };
      sendChunk(); sendChunk(); sendChunk(); // 3 chunks immediately
      setTimeout(() => {
        sendChunk(); sendChunk(); sendChunk(); // 3 more after idle gap
        res.end();
      }, 400);
    });
    const subswitch = await startSubswitch({
      anthropic: {
        baseUrl: anthropic.url,
        connectTimeoutMs: 50,
      },
    });
    cleanups.push(subswitch.close, anthropic.close);

    const response = await fetch(`${subswitch.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
    });
    assert.equal(response.status, 200, "upstream sent headers before idle gap");
    const text = await response.text();

    // All 6 chunks must be received.
    const chunks = text.match(/^data: \d+$/gm) ?? [];
    assert.equal(
      chunks.length,
      6,
      `all 6 SSE chunks must arrive — stream-idle gap must not be terminated by relay; got: ${JSON.stringify(chunks)}`,
    );
  });

  // ---------------------------------------------------------------------------
  // connectTimeoutMs non-vacuity — proves the timer fires during TCP connect
  // ---------------------------------------------------------------------------
  //
  // This test requires a host/port that accepts SYN packets but never sends
  // SYN-ACK, keeping socket.connecting === true for the duration of the budget.
  // 192.0.2.1 (TEST-NET-1, RFC 5737) is used: it is documentation-only, has no
  // real host, and on systems with a default route the SYN is forwarded but
  // never answered — a true blackhole.
  //
  // CI note: on isolated containers with NO default route the kernel returns
  // ENETUNREACH immediately, producing a 502 error rather than a 504 timeout.
  // If this test fails with 502 on CI, the host has no route to 192.0.2.1 and
  // the blackhole approach is not viable there.
  //
  // Non-vacuity: without the fix (upstream.setTimeout instead of socket.setTimeout),
  // this test hangs until the macOS/Linux kernel TCP timeout (~75 s) or the
  // 30 s --test-timeout limit, confirming the test discriminates the two states.

  it("connectTimeoutMs fires during TCP connect to a non-routable upstream (192.0.2.1)", async () => {
    const CONNECT_MS = 250;
    const captured: Array<{ level: LogLevel; event: string }> = [];

    // Call createAnthropicForwarder directly so we can use plain HTTP without
    // the config-layer HTTPS-or-loopback validation.  The agent test seam is
    // not needed here — the real socket must connect (and fail) so socket.connecting
    // is genuinely true during the budget window.
    const forwarder = createAnthropicForwarder({
      baseUrl: "http://192.0.2.1:80",
      connectTimeoutMs: CONNECT_MS,
      maxUpstreamSockets: 1,
      logger: {
        log(level: LogLevel, event: string) {
          captured.push({ level, event });
        },
      },
    });

    const server = http.createServer((req, res) => forwarder(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    const start = Date.now();
    const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "test" }),
    });
    const elapsed = Date.now() - start;

    await new Promise<void>((resolve) => server.close(() => resolve()));

    assert.equal(
      response.status,
      504,
      `expected 504 (connect timeout after ${CONNECT_MS} ms); got ${response.status} after ${elapsed} ms. ` +
        `If 502: 192.0.2.1 returned ENETUNREACH (no default route — host has no path to TEST-NET-1). ` +
        `If 504 but elapsed >> ${CONNECT_MS}: connectTimeoutMs did not actually bound TCP connect.`,
    );

    // Without the fix this hangs ~75 000 ms (macOS kernel TCP timeout) or until
    // the 30 s test timeout — well above the 4× upper bound below.
    assert.ok(
      elapsed < CONNECT_MS * 4,
      `connect should time out at ~${CONNECT_MS} ms; elapsed ${elapsed} ms is too high — ` +
        `connectTimeoutMs is not bounding TCP connect (unfixed code hangs ~75 000 ms or test-timeout)`,
    );
    assert.ok(
      elapsed >= CONNECT_MS * 0.5,
      `timer fired before the connectTimeoutMs budget (elapsed: ${elapsed} ms < ${CONNECT_MS * 0.5} ms)`,
    );

    // The settled de-dup guard must hold on the connect-timeout path too:
    // exactly one anthropic_upstream_timeout warn, no anthropic_upstream_error.
    const upstreamEvents = captured.filter((e) => e.event.startsWith("anthropic_upstream"));
    assert.equal(
      upstreamEvents.length,
      1,
      `expected exactly 1 upstream warn event; got: ${JSON.stringify(upstreamEvents)}`,
    );
    assert.equal(upstreamEvents[0]!.event, "anthropic_upstream_timeout");
    assert.equal(upstreamEvents[0]!.level, "warn");
  });

  // ---------------------------------------------------------------------------
  // L3: x-subswitch-synthesized marker header
  // ---------------------------------------------------------------------------
  //
  // Every response the relay generates itself — 502 (connection failure),
  // 504 (timeout), 500 (internal proxy error), 413 (body too large), 529
  // (concurrency gate) — carries x-subswitch-synthesized: 1 so operators can
  // distinguish relay faults from upstream faults.  Responses proxied from the
  // origin (including upstream errors such as 429) must NOT carry this header.
  // Additionally, x-subswitch-synthesized is stripped from proxied responses
  // so that an origin setting it cannot impersonate the relay's marker.

  it("L3: x-subswitch-synthesized: 1 is present on a relay-synthesised 504 timeout response", async () => {
    // Produce a 504 via TCP connect timeout to 192.0.2.1 (TEST-NET-1, RFC 5737:
    // documentation-only, no real host — SYN is forwarded but never answered).
    // This is the only way to trigger a relay-synthesized 504 after the removal of
    // headerTimeoutMs (ADR-010): the connect-phase timer is the only remaining timer.
    //
    // CI note: on containers with no default route, the kernel returns ENETUNREACH
    // immediately (502, not 504). In that case the marker is still present on the 502.
    const forwarder = createAnthropicForwarder({
      baseUrl: "http://192.0.2.1:80",
      connectTimeoutMs: 150,
      maxUpstreamSockets: 1,
      logger: { log: () => undefined },
    });
    const server = http.createServer((req, res) => forwarder(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    cleanups.push(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));

    const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
    });

    // The relay produces a 504 (connect timeout) or 502 (no route on CI).
    // Either way x-subswitch-synthesized: 1 must be present.
    assert.ok(
      response.status === 504 || response.status === 502,
      `expected 504 or 502, got ${response.status}`,
    );
    assert.equal(
      response.headers.get("x-subswitch-synthesized"),
      "1",
      "relay-synthesised timeout/error response must carry x-subswitch-synthesized: 1",
    );
  });

  it("L3: x-subswitch-synthesized is ABSENT on a successfully proxied origin response", async () => {
    const { subswitch } = await setup((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "ok" }));
    });

    const response = await fetch(`${subswitch.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
    });

    assert.equal(response.status, 200);
    // Must be absent — the origin produced this response, not the relay.
    assert.equal(
      response.headers.get("x-subswitch-synthesized"),
      null,
      "proxied origin 200 must NOT carry x-subswitch-synthesized",
    );
  });

  it("L3: x-subswitch-synthesized is ABSENT on a proxied origin ERROR response such as 429", async () => {
    // A 429 that the upstream produced must reach the client unchanged —
    // the relay must not inject x-subswitch-synthesized on responses it merely forwarded.
    const { subswitch } = await setup((_req, res) => {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "30" });
      res.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "too many requests" } }));
    });

    const response = await fetch(`${subswitch.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
    });

    assert.equal(response.status, 429);
    // Without the marker: null. The relay must only mark what IT produces.
    assert.equal(
      response.headers.get("x-subswitch-synthesized"),
      null,
      "proxied upstream 429 error must NOT carry x-subswitch-synthesized",
    );
  });

  it("L3: x-subswitch-synthesized set by the upstream is STRIPPED from the proxied response", async () => {
    // An upstream that sets x-subswitch-synthesized must not have it forwarded
    // to the client — the relay strips it so the marker is authoritative (only
    // the relay can assert it).
    const { subswitch } = await setup((_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "x-subswitch-synthesized": "upstream-injected" });
      res.end(JSON.stringify({ id: "ok" }));
    });

    const response = await fetch(`${subswitch.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
    });

    assert.equal(response.status, 200);
    // Without fix: "upstream-injected" (forwarded verbatim).
    // With fix: null (stripped by filterRawHeaders adding it to HOP_BY_HOP).
    assert.equal(
      response.headers.get("x-subswitch-synthesized"),
      null,
      "upstream-set x-subswitch-synthesized must be stripped from the proxied response",
    );
  });

  // ---------------------------------------------------------------------------
  // Change 3: client abort must not produce anthropic_upstream_error warn
  // ---------------------------------------------------------------------------

  it("Change 3: aborting the client mid-request produces no anthropic_upstream_error warn", async () => {
    // Upstream never responds (stalls); client aborts after 60 ms.
    // res.on("close") fires → settled=true → upstream.destroy() → error fires
    // → settled guard prevents spurious warn and 502 attempt.
    const captured: Array<{ level: string; event: string }> = [];

    const anthropic = await startFakeUpstream((_req, _res) => {
      // Stall — never send a response.
    });
    const subswitch = await startSubswitch(
      { anthropic: { baseUrl: anthropic.url } },
      { logger: { log(level, event) { captured.push({ level, event }); } } },
    );
    cleanups.push(subswitch.close, anthropic.close);

    const controller = new AbortController();
    const fetchPromise = fetch(`${subswitch.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
      signal: controller.signal,
    });

    // Abort before upstream has a chance to respond.
    setTimeout(() => controller.abort(), 60);

    try {
      await fetchPromise;
    } catch {
      // Expected: AbortError from the client-side abort.
    }

    // Allow the event loop to drain so any stray error events settle.
    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    const warnLogs = captured.filter((e) => e.event === "anthropic_upstream_error");
    // Without fix: settled=false when res closes → upstream.destroy() → error fires → warn logged.
    // With fix: settled=true before destroy() → error fires → settled guard returns early → no warn.
    assert.equal(
      warnLogs.length,
      0,
      `client abort must not produce anthropic_upstream_error warn; got: ${JSON.stringify(warnLogs)}`,
    );
  });
});
