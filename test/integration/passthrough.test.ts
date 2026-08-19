import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import type { LogLevel } from "../../src/logger.js";
import { createAnthropicForwarder } from "../../src/anthropic-passthrough.js";
import { startSubswitch, startFakeUpstream, rawHttpRequest, type SubswitchInstance, type FakeUpstream } from "./fake-upstreams.js";
import { loadConfig } from "../../src/config.js";
import { buildDeps, createProxyServer } from "../../src/server.js";
import type { AnthropicForwarder } from "../../src/anthropic-passthrough.js";

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
    assert.equal(
      response.headers.get("x-subswitch-synthesized"),
      "1",
      "413 is relay-synthesized — must carry x-subswitch-synthesized: 1",
    );
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
    // C6: relay-synthesized 502 must carry x-subswitch-synthesized: 1.
    // Non-vacuity: the marker is set in anthropic-passthrough.ts line 237; removing it
    // would cause this assertion to fail.
    assert.equal(
      response.headers.get("x-subswitch-synthesized"),
      "1",
      "relay-synthesized 502 must carry x-subswitch-synthesized: 1",
    );
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
    // x-subswitch-synthesized is included to prove REQUEST-direction stripping is absent:
    // the relay must forward this header to the upstream unchanged (ADR-010). If the relay
    // stripped it on the request side, the upstream would not receive it and the assertion
    // at the bottom of this test would fail.
    const sentRawHeaders = [
      "Authorization", "Bearer sk-ant-oat-FAKE-OAUTH",
      "Anthropic-Beta", "oauth-2025-04-20,interleaved-thinking-2025-05-14",
      "anthropic-version", "2023-06-01",
      "X-App", "cli",
      "X-Custom", "first",
      "X-Custom", "second",
      "x-subswitch-synthesized", "client-sent",
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

    assert.ok(
      response.status === 504 || response.status === 502,
      `expected 504 (connect timeout) or 502 (ENETUNREACH — host has no route to TEST-NET-1 on this network); ` +
        `got ${response.status} after ${elapsed} ms`,
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
  // Synthesized-response coverage:
  //   502 (connection failure)  — asserted above in the 502 test (C6)
  //   504 (connect timeout)     — asserted in "x-subswitch-synthesized: 1 on 504" below
  //   500 (internal error)      — asserted in the 8d dispatch-error test below
  //   413 (body too large)      — asserted in the 413 test and 413-race test above
  //   404 (/__subswitch/*)      — asserted in the L3/8a 404 shape test below
  //   health 200 (/__subswitch/health) — asserted in health.test.ts
  //   431 (header overflow)     — asserted in server-wiring.test.ts B4
  //
  // 529 (concurrency gate) was removed — the admission gate was deleted (ADR-010).
  //
  // Proxied responses (200, 429, etc.) must NOT carry this header.
  // x-subswitch-synthesized is stripped from proxied responses so an origin
  // setting it cannot impersonate the relay's marker.

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
    // With fix: null (stripped by RESPONSE_STRIP, the response-only set that extends
    // HOP_BY_HOP with x-subswitch-synthesized — split out in item 7 so the synthesized
    // marker is only stripped from responses, never from relay→upstream requests).
    assert.equal(
      response.headers.get("x-subswitch-synthesized"),
      null,
      "upstream-set x-subswitch-synthesized must be stripped from the proxied response",
    );
  });

  // ---------------------------------------------------------------------------
  // Client abort must not produce anthropic_upstream_error warn
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // 413 delivery race — drainRejectedUpload (item 6)
  // ---------------------------------------------------------------------------
  //
  // When the server sends 413 while the client is still uploading, calling
  // req.destroy() with unread inbound data causes the kernel to send RST.
  // The client may receive ECONNRESET before reading the response body, making
  // the 413 delivery unreliable.  drainRejectedUpload() fixes this by calling
  // req.resume() to drain remaining data so the TCP teardown uses FIN, giving
  // the client time to read the 413.
  //
  // Non-vacuity: without drainRejectedUpload (i.e. with req.destroy() still present),
  // the RST races against the client's socket read.  On a loopback interface the race
  // is tight; in practice the response sometimes arrives, sometimes throws ECONNRESET.
  // The test uses rawHttpRequest (Node http module) which buffers the full response
  // before resolving — if RST arrives first, it rejects with an ECONNRESET error
  // rather than resolving with status 413.  With drainRejectedUpload the connection
  // closes cleanly (FIN) after all data is drained, and the 413 is always readable.

  it("413 race: large upload receives the 413 response even while still sending body", async () => {
    const { anthropic, subswitch } = await setup(
      (_req, res) => {
        res.writeHead(200);
        res.end();
      },
      { maxBodyBytes: 1024 },
    );

    // 8 MiB body — well above the 1024 byte cap.  Use rawHttpRequest so we
    // control the send and can observe the raw status without fetch buffering
    // complications.  The relay triggers body_too_large after 1024 bytes and
    // sends 413 while the rest of the 8 MiB is still in-flight.
    const largeBody = Buffer.alloc(8 * 1024 * 1024, "x");
    const response = await rawHttpRequest(`${subswitch.url}/v1/messages`, {
      method: "POST",
      rawHeaders: ["Content-Type", "application/json"],
      body: largeBody,
    });

    assert.equal(response.status, 413, "large-body 413 must be readable (drainRejectedUpload prevents RST before client reads response)");
    assert.equal(
      response.rawHeaders[response.rawHeaders.findIndex((h) => h.toLowerCase() === "x-subswitch-synthesized") + 1],
      "1",
      "413 response must carry x-subswitch-synthesized: 1",
    );
    const parsed = JSON.parse(response.body.toString("utf8")) as { type: string; error: { type: string } };
    assert.equal(parsed.error.type, "request_too_large", "413 body error type must be request_too_large");
    assert.equal(anthropic.requests.length, 0, "upstream must not receive the oversized request");
  });

  // ---------------------------------------------------------------------------
  // 404 shape — /__subswitch/* uses toAnthropicErrorBody (item 8a)
  // ---------------------------------------------------------------------------
  //
  // Non-vacuity: without toAnthropicErrorBody, the 404 body was JSON.stringify({error:"not found"})
  // which has no `type` field and no `error.type` field — the assertions below would fail.
  // With toAnthropicErrorBody the body has the standard Anthropic shape AND does not echo the path.

  it("L3/8a: /__subswitch/* 404 is Anthropic-shaped, synthesized, and does not reflect the path", async () => {
    const { subswitch } = await setup((_req, res) => {
      res.writeHead(200);
      res.end();
    });

    // Use a path with a recognisable token — if path reflection were present, the token
    // would appear in the error body, and the assertion below would catch it.
    const injectionPath = "/__subswitch/does-not-exist?q=INJECTION_TOKEN";
    const response = await fetch(`${subswitch.url}${injectionPath}`);

    assert.equal(response.status, 404, "unknown /__subswitch/* path must return 404");
    assert.equal(
      response.headers.get("x-subswitch-synthesized"),
      "1",
      "404 must carry x-subswitch-synthesized: 1 (relay-synthesized)",
    );
    const body = (await response.json()) as { type: string; error: { type: string; message: string } };
    assert.equal(body.type, "error", "404 body must have outer type: 'error'");
    assert.equal(body.error.type, "not_found_error", "404 error type must be 'not_found_error'");
    // No path reflection: the requested path must not appear in the body.
    const bodyStr = JSON.stringify(body);
    assert.ok(!bodyStr.includes("does-not-exist"), "requested path must not be reflected in the 404 body");
    assert.ok(!bodyStr.includes("INJECTION_TOKEN"), "query parameters must not be reflected in the 404 body");
  });

  // ---------------------------------------------------------------------------
  // 500/internal_error — dispatch().catch() sets route = "internal_error" (item 8d)
  // ---------------------------------------------------------------------------
  //
  // Non-vacuity: without route = "internal_error" in dispatch().catch(), the
  // request_complete log would carry route: "anthropic" (the initial default).
  // The assertion on the captured log would fail.  Without the updated message,
  // the message assertion would also fail.

  it("8d: dispatch error → 500 Anthropic-shaped body with 'proxy fault' message and route=internal_error log", async () => {
    // Use buildDeps + createProxyServer directly so we can inject a throwing forwardAnthropic.
    // startSubswitch does not expose forwardAnthropic as an override seam.
    const anthropic = await startFakeUpstream((_req, res) => { res.end(); });
    cleanups.push(anthropic.close);

    const configResult = loadConfig({
      configPath: "inline-test-config.json",
      readFile: () => JSON.stringify({ logLevel: "error", anthropic: { baseUrl: anthropic.url } }),
    });
    assert.ok(configResult.ok, `config must load: ${!configResult.ok ? configResult.error.message : ""}`);

    const captured: Array<{ event: string; route: string | undefined }> = [];
    const capturedLogger = {
      log(_level: string, event: string, fields?: Record<string, unknown>) {
        captured.push({ event, route: fields?.route as string | undefined });
      },
    };

    const depsResult = buildDeps(configResult.value.config, capturedLogger);
    assert.ok(depsResult.ok, `buildDeps must succeed: ${!depsResult.ok ? depsResult.error : ""}`);

    // Override forwardAnthropic to throw synchronously — simulates an unexpected
    // internal error in the proxy path that dispatch() does not explicitly handle.
    const throwingForwarder: AnthropicForwarder = () => {
      throw new Error("simulated internal proxy fault");
    };

    const server = createProxyServer({ ...depsResult.value, forwardAnthropic: throwingForwarder });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    cleanups.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));

    // A GET request routes to forwardAnthropic (unbuffered path) and will throw synchronously.
    const response = await fetch(`http://127.0.0.1:${port}/v1/models`);

    assert.equal(response.status, 500, "internal error must return 500");
    assert.equal(
      response.headers.get("x-subswitch-synthesized"),
      "1",
      "500 must carry x-subswitch-synthesized: 1",
    );
    const body = (await response.json()) as { type: string; error: { type: string; message: string } };
    assert.equal(body.type, "error", "500 body must have outer type: 'error'");
    assert.equal(body.error.type, "api_error", "500 error type must be api_error");
    assert.ok(
      body.error.message.includes("proxy fault"),
      `500 message must identify this as a proxy fault; got: ${JSON.stringify(body.error.message)}`,
    );

    // Wait for the request_complete log to fire (res.on("close") fires after response is consumed).
    await new Promise<void>((resolve) => setTimeout(resolve, 30));

    const completeLog = captured.find((e) => e.event === "request_complete");
    assert.ok(completeLog !== undefined, "request_complete log must be emitted");
    assert.equal(
      completeLog.route,
      "internal_error",
      `request_complete log must carry route: "internal_error"; got: ${JSON.stringify(completeLog.route)}`,
    );
  });

  it("aborting the client mid-request produces no anthropic_upstream_error warn", async () => {
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

// ---------------------------------------------------------------------------
// B5: upstreamEvents() at-most-one contract — every terminal path
//
// settle() in anthropic-passthrough.ts ensures that exactly one terminal
// handler fires per request, preventing duplicate anthropic_upstream_* events.
//
// HONEST CONTRACT NOTE: No test in this suite fails on the pre-fix code for
// this specific guarantee.  The settle() latch was added to fix FRAGILITY in
// the client-disconnect + upstream-error race, but that race path is now
// structurally unreachable (the latch itself makes it unreachable).  These
// tests assert the CONTRACT — at most one anthropic_upstream_* event — and
// document the terminal path coverage.  They are not proofs of a previously
// observable failure.
//
// Terminal-path coverage table (named by test, not by line number — line numbers
// in this table had already drifted once and a stale pointer reads as coverage):
//   response-headers-received  → 0 upstream events
//        — "forwards method, path+query, auth headers, and body verbatim" and the
//          header-fidelity tests, none of which tolerate an upstream warn
//   connect timeout            → 1 event (anthropic_upstream_timeout)
//        — "connectTimeoutMs fires during TCP connect to a non-routable upstream"
//   client disconnect          → 0 upstream events
//        — "aborting the client mid-request produces no anthropic_upstream_error warn"
//          (pre-headers) and "B6: mid-stream client abort reclaims the upstream socket"
//          (post-headers; also pins that the teardown itself still happens)
//   upstream error (ECONNRESET) → 1 event (anthropic_upstream_error) — asserted below
// ---------------------------------------------------------------------------

describe("anthropic passthrough — upstream error emits exactly one event (B5)", () => {
  it("upstream ECONNRESET produces exactly one anthropic_upstream_error event (not zero, not two)", async () => {
    // This test covers the one terminal path not already asserting the contract:
    // when the upstream is unreachable and the error handler fires.
    //
    // Non-vacuity argument, stated precisely:
    //  - The assertion IS falsifiable in the duplicate direction: the filter is
    //    `startsWith("anthropic_upstream")`, not an exact-name match, so a second
    //    record of any upstream event turns it RED (verified by emitting one twice).
    //  - It does NOT prove the settle() latch.  Neutering settle() to always return
    //    true leaves this test green, because only one error occurs on this path.
    //    The latch's observable guarantee is covered by the client-disconnect test
    //    instead.  Documented rather than overclaimed.
    //
    // Both terminal handlers now call settle() BEFORE logging, so the latch — not
    // the shape of any individual path — is what makes at-most-one structural.
    // The timeout handler previously logged first, leaving the timeout path's
    // at-most-one property dependent on the connect test rather than on the latch.
    const captured: Array<{ level: string; event: string }> = [];

    const anthropic = await startFakeUpstream((_req, res) => res.end());
    await anthropic.close(); // Make it unreachable
    const subswitch = await startSubswitch(
      { anthropic: { baseUrl: anthropic.url } },
      { logger: { log(level, event) { captured.push({ level: level as string, event }); } } },
    );
    cleanups.push(subswitch.close);

    const response = await fetch(`${subswitch.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
    });
    await response.body?.cancel();

    // Allow the event loop to drain.
    await new Promise<void>((r) => setTimeout(r, 50));

    const upstreamEvents = captured.filter((e) => e.event.startsWith("anthropic_upstream"));
    assert.equal(
      upstreamEvents.length,
      1,
      `upstream ECONNRESET must produce exactly 1 anthropic_upstream_* event; got: ${JSON.stringify(upstreamEvents)}`,
    );
    assert.equal(upstreamEvents[0]!.event, "anthropic_upstream_error", "event must be anthropic_upstream_error");
    assert.equal(upstreamEvents[0]!.level, "warn", "upstream error must log at warn level");
  });
});

// ---------------------------------------------------------------------------
// C7: request_complete log fields from a live request
//
// Nothing in the suite previously asserted the full field set of the
// request_complete log event on a real request.  This pins the contract so
// any future field rename or removal produces an immediate test failure.
//
// Non-vacuity: each field is asserted; removing one from server.ts would cause
// the corresponding assertion to fail.
// ---------------------------------------------------------------------------

describe("anthropic passthrough — request_complete log fields on a live request (C7)", () => {
  it("request_complete carries path, route, model, status, and a numeric latencyMs", async () => {
    const captured: Array<{ event: string; fields: Record<string, unknown> }> = [];

    const anthropic = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "msg_ok" }));
    });
    const subswitch = await startSubswitch(
      { anthropic: { baseUrl: anthropic.url } },
      {
        logger: {
          log(_level: string, event: string, fields: Record<string, unknown> = {}) {
            captured.push({ event, fields });
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
    await response.body?.cancel();

    // request_complete fires on res.on("close") — allow the event loop to drain.
    await new Promise<void>((r) => setTimeout(r, 50));

    const completeLog = captured.find((e) => e.event === "request_complete");
    assert.ok(completeLog !== undefined, "request_complete must be emitted");

    const f = completeLog.fields;
    assert.equal(f.path, "/v1/messages", "path must be the pathname without query string");
    assert.equal(f.route, "anthropic", "route must be 'anthropic' for a forwarded request");
    assert.equal(f.model, "claude-sonnet-4-6", "model must be the as-requested model name");
    assert.equal(f.status, 200, "status must be the HTTP response status code");
    assert.equal(typeof f.latencyMs, "number", "latencyMs must be a number");
    assert.ok((f.latencyMs as number) >= 0, "latencyMs must be non-negative");
  });
});

// ---------------------------------------------------------------------------
// B6: a client abort AFTER response headers must still reclaim the upstream socket
//
// The existing client-abort test aborts BEFORE the upstream responds, so the
// settlement is still open and upstream.destroy() runs.  The mid-stream case is
// the one that leaks: once headers are relayed the response callback has already
// claimed settle(), so gating the teardown on the latch skips destroy() entirely.
// `pipe()` does not propagate destination teardown to the source, so the upstream
// response stays half-read and its socket never returns to the agent's free pool.
//
// This is the failure ADR-010 names as the reason a relay cannot simply delete
// every bound: leaked sockets accumulate until maxUpstreamSockets is exhausted,
// after which http.Agent queues every later request forever — an unbounded hang
// no origin can produce, and one the removed streamIdleTimeoutMs no longer covers.
//
// Non-vacuity: measured RED on the pre-fix code — 5 aborts left 5 sockets in
// agent.sockets and 5 upstream connections open.  The assertion counts live
// sockets rather than log records, so no filter can hide the leak.
//
// A dedicated agent is injected via the documented `agent` test seam so the
// counters belong to this test alone and cannot be perturbed by another test's
// traffic.
// ---------------------------------------------------------------------------

describe("anthropic passthrough — mid-stream client abort reclaims the upstream socket (B6)", () => {
  it("aborting after headers destroys the upstream instead of leaking its socket", async () => {
    const ABORTS = 5;
    const liveUpstreamSockets = new Set<import("node:net").Socket>();

    // Upstream sends headers and one SSE frame, then stalls forever — the shape of
    // a real streaming completion that a sub-agent interrupts partway through.
    const upstreamServer = http.createServer((req, res) => {
      req.resume();
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: message_start\ndata: {}\n\n");
    });
    upstreamServer.on("connection", (socket) => {
      liveUpstreamSockets.add(socket);
      socket.on("close", () => liveUpstreamSockets.delete(socket));
    });
    await new Promise<void>((r) => upstreamServer.listen(0, "127.0.0.1", r));
    const upstreamPort = (upstreamServer.address() as AddressInfo).port;

    const agent = new http.Agent({ keepAlive: true, maxSockets: 8, scheduling: "lifo" });
    const forwarder = createAnthropicForwarder({
      baseUrl: `http://127.0.0.1:${upstreamPort}`,
      connectTimeoutMs: 10_000,
      maxUpstreamSockets: 8,
      logger: { log: () => undefined },
      agent,
    });

    const relay = http.createServer((req, res) => forwarder(req, res, Buffer.from("{}")));
    await new Promise<void>((r) => relay.listen(0, "127.0.0.1", r));
    const relayPort = (relay.address() as AddressInfo).port;

    try {
      for (let i = 0; i < ABORTS; i++) {
        const controller = new AbortController();
        try {
          const response = await fetch(`http://127.0.0.1:${relayPort}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: "claude-sonnet-4-6", stream: true, messages: [] }),
            signal: controller.signal,
          });
          assert.equal(response.status, 200, "upstream headers must have been relayed before the abort");
          // Read the first frame so the settlement is provably already claimed.
          await response.body!.getReader().read();
          controller.abort();
        } catch {
          // AbortError from the client-side abort is expected.
        }
        await new Promise((r) => setTimeout(r, 60));
      }

      await new Promise((r) => setTimeout(r, 300));

      const pools = agent as unknown as { sockets: Record<string, unknown[]>; requests: Record<string, unknown[]> };
      const inUse = Object.values(pools.sockets).reduce((n, list) => n + list.length, 0);
      const queued = Object.values(pools.requests).reduce((n, list) => n + list.length, 0);

      assert.equal(
        inUse,
        0,
        `every aborted request must release its upstream socket; ${inUse} of ${ABORTS} still held in agent.sockets. ` +
          `Held sockets count against maxUpstreamSockets, so this leak wedges the relay permanently.`,
      );
      assert.equal(queued, 0, `no request should be left queued inside http.Agent; got ${queued}`);
      assert.equal(
        liveUpstreamSockets.size,
        0,
        `every aborted request must close its upstream connection; ${liveUpstreamSockets.size} still open at the upstream`,
      );
    } finally {
      agent.destroy();
      relay.closeAllConnections();
      await new Promise<void>((r) => relay.close(() => r()));
      upstreamServer.closeAllConnections();
      await new Promise<void>((r) => upstreamServer.close(() => r()));
    }
  });
});

// ---------------------------------------------------------------------------
// B7: the drainRejectedUpload 2 s safety bound must actually FIRE
//
// PF-019's standing rule: never trust a timeout that has no test proving it fires.
// The drain exists so the client can read its 413 before TCP teardown, but a client
// that ignores the 413 and keeps uploading must still be cut off — that is what the
// 2 s timer is for.  Disarming it on `res` "close" made it dead: the 413 has already
// been written when the drain starts, so `res` closes within a tick or two and the
// timer was cleared ~2 ms after being armed (measured).  Every disarm signal must
// come from `req`, the stream actually being drained.
//
// Non-vacuity: this test is RED on code that disarms on `res` "close" — the socket
// is never destroyed and the assertion times out at the 8 s budget instead of the
// ~2 s bound.  The paired 413-race test above is the control for the opposite
// mutation (dropping the drain entirely, or shortening the timer to zero, breaks
// delivery of the 413 and turns that test red).
//
// A raw socket is required: fetch/undici will not keep writing a body after the
// server has responded, so it cannot construct the "client ignores the 413" case.
// ---------------------------------------------------------------------------

describe("anthropic passthrough — drainRejectedUpload cuts off a client that ignores the 413 (B7)", () => {
  it("destroys the socket ~2 s after the 413 when the upload never stops", async () => {
    const { subswitch } = await setup((_req, res) => res.end("{}"), { maxBodyBytes: 1024 });
    const { port } = new URL(subswitch.url);

    const timeline = await new Promise<{ responded: boolean; closedAfterMs: number }>((resolve, reject) => {
      const started = Date.now();
      let responded = false;
      let dribble: NodeJS.Timeout | undefined;
      const socket = net.connect(Number(port), "127.0.0.1", () => {
        // Declare a body far larger than maxBodyBytes and never finish sending it.
        socket.write(
          `POST /v1/messages HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
            `content-type: application/json\r\ncontent-length: 1000000000\r\n\r\n`,
        );
        socket.write(JSON.stringify({ model: "claude-sonnet-4-6", pad: "A".repeat(4096) }));
        // Keep uploading after the 413 — the case the bound exists for.
        dribble = setInterval(() => socket.write("B".repeat(64)), 100);
      });
      socket.on("data", () => { responded = true; });
      socket.on("close", () => {
        if (dribble !== undefined) clearInterval(dribble);
        resolve({ responded, closedAfterMs: Date.now() - started });
      });
      socket.on("error", () => { /* RST/EPIPE on destroy is the expected end state */ });
      const giveUp = setTimeout(() => {
        if (dribble !== undefined) clearInterval(dribble);
        socket.destroy();
        reject(new Error("socket still open 8 s after the 413 — the 2 s drain bound never fired"));
      }, 8_000);
      giveUp.unref();
    });

    assert.ok(timeline.responded, "the 413 must reach the client before the socket is destroyed");
    assert.ok(
      timeline.closedAfterMs > 1_500 && timeline.closedAfterMs < 3_000,
      `the 2 s drain bound (drainRejectedUpload) must fire; socket stayed open ${timeline.closedAfterMs} ms (expected > 1_500 && < 3_000)`,
    );
  });
});
