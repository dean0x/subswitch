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
// Every leak assertion below compares against 0, which is also what a relay that
// never opened an upstream connection at all would produce.  `upstreamConnections`
// is the independent positive control for that direction: it counts TCP connections
// arriving at the origin and must equal the number of aborts, so "the path ran and
// was reclaimed" is distinguishable from "the path never ran" (avoids PF-011).  The
// status assertion sits outside the try for the same reason — inside it, the catch
// swallowed the AssertionError and a relay that answered 502 without contacting the
// origin passed (measured).
//
// A dedicated agent is injected via the documented `agent` test seam so the
// counters belong to this test alone and cannot be perturbed by another test's
// traffic.
// ---------------------------------------------------------------------------

describe("anthropic passthrough — mid-stream client abort reclaims the upstream socket (B6)", () => {
  it("aborting after headers destroys the upstream instead of leaking its socket", async () => {
    const ABORTS = 5;
    const liveUpstreamSockets = new Set<import("node:net").Socket>();
    let upstreamConnections = 0;

    // Upstream sends headers and one SSE frame, then stalls forever — the shape of
    // a real streaming completion that a sub-agent interrupts partway through.
    const upstreamServer = http.createServer((req, res) => {
      req.resume();
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: message_start\ndata: {}\n\n");
    });
    upstreamServer.on("connection", (socket) => {
      upstreamConnections++;
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
        const response = await fetch(`http://127.0.0.1:${relayPort}/v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "claude-sonnet-4-6", stream: true, messages: [] }),
          signal: controller.signal,
        });
        assert.equal(response.status, 200, "upstream headers must have been relayed before the abort");
        try {
          // Read the first frame so the settlement is provably already claimed.
          await response.body!.getReader().read();
        } catch {
          // A read that loses the race with teardown is not what this test measures.
        }
        controller.abort();
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
      assert.equal(
        upstreamConnections,
        ABORTS,
        `every iteration must have reached the origin; got ${upstreamConnections}/${ABORTS} connections. ` +
          `The three zero-comparisons above are equally satisfied by a relay that never opened an upstream socket.`,
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

// ---------------------------------------------------------------------------
// B8: a client that vanishes mid-upload is not recorded as a completed 200
//
// bufferBody's `client_disconnected` outcome writes nothing to `res`, so at close
// time `res.statusCode` is Node's 200 initialiser rather than a status the relay
// sent.  Recording `request_complete status=200` for a request that never received
// a response makes an abort indistinguishable from a success in the one line an
// operator has.  Measured on Node 22.22: `res` "close" fires BEFORE `req` "error",
// so the record has to be decided in the close handler, not in the dispatch arm.
//
// Non-vacuity: RED against a close handler that emits request_complete
// unconditionally — the first assertion then finds request_complete with
// status=200, and the second finds no client_disconnected record at all.
// ---------------------------------------------------------------------------

describe("server body ingestion — a client that vanishes mid-upload is not logged as a completed 200 (B8)", () => {
  it("records client_disconnected instead of request_complete status=200", async () => {
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
    const { port } = new URL(subswitch.url);

    await new Promise<void>((resolve) => {
      const socket = net.connect(Number(port), "127.0.0.1", () => {
        // Declared length is under maxBodyBytes, so the streaming path is the one
        // exercised; only a fraction of it is ever sent.
        socket.write(
          `POST /v1/messages HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
            `content-type: application/json\r\ncontent-length: 1048576\r\n\r\n`,
        );
        socket.write(JSON.stringify({ model: "claude-sonnet-4-6", pad: "A".repeat(512) }));
        setTimeout(() => { socket.destroy(); resolve(); }, 100);
      });
      socket.on("error", () => { /* the peer may RST first; either way the client is gone */ });
    });

    // The record lands on `res` "close" — allow the event loop to drain.
    await new Promise<void>((r) => setTimeout(r, 200));

    assert.ok(
      !captured.some((e) => e.event === "request_complete" && e.fields.status === 200),
      `an abandoned upload must not be recorded as request_complete status=200; got ${JSON.stringify(captured)}`,
    );
    const disconnect = captured.find((e) => e.event === "client_disconnected");
    assert.ok(disconnect !== undefined, `the abort must still be recorded; got ${JSON.stringify(captured)}`);
    assert.equal(disconnect.fields.path, "/v1/messages", "the record must carry the request path");
    assert.equal(typeof disconnect.fields.latencyMs, "number", "the record must carry a numeric latencyMs");
    assert.equal(disconnect.fields.status, undefined, "there is no status to report — none must be invented");
    assert.equal(anthropic.requests.length, 0, "an incomplete upload must not reach the upstream");
  });
});

// ---------------------------------------------------------------------------
// B9: a declared Content-Length over the cap is rejected before the body is read
//
// The declared length fixes the outcome before a byte arrives, so buffering up to
// maxBodyBytes first only costs memory: a 40 MiB upload paid a full 32 MiB of
// buffering to reach a 413 that was already decided.  The client-visible outcome is
// unchanged (413 + request_too_large + synthesized marker); only timing and peak
// memory differ, and the origin rejects on the declared length too (ADR-010).
//
// Non-vacuity: RED against code that ignores Content-Length — the client sends one
// small chunk and stops, the relay waits for a cap it will never reach, and the
// 3 s budget below rejects with the count of bytes actually sent.  The second case
// pins the streaming cap for chunked bodies, which have no declared length at all.
// ---------------------------------------------------------------------------

describe("server body ingestion — declared Content-Length over the cap is answered before the body is read (B9)", () => {
  const readReply = (port: string, write: (socket: net.Socket) => void, budgetMs: number): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      let reply = "";
      let settle: NodeJS.Timeout | undefined;
      const socket = net.connect(Number(port), "127.0.0.1", () => write(socket));
      socket.on("data", (chunk: Buffer) => {
        reply += chunk.toString("utf8");
        // Header block seen: give the body its own tick or two, then take the reply.
        if (reply.includes("\r\n\r\n") && settle === undefined) {
          settle = setTimeout(() => { socket.destroy(); resolve(reply); }, 50);
        }
      });
      socket.on("error", () => { /* the relay destroys the socket after the drain bound */ });
      const giveUp = setTimeout(() => {
        socket.destroy();
        reject(new Error(`no reply within ${budgetMs} ms — the relay is still reading a body whose outcome is already decided`));
      }, budgetMs);
      giveUp.unref();
    });

  it("answers 413 after one small chunk instead of buffering maxBodyBytes first", async () => {
    const MAX_BODY = 1024 * 1024;
    const FIRST_CHUNK = 4096;
    const { anthropic, subswitch } = await setup(
      (_req, res) => { res.writeHead(200); res.end("{}"); },
      { maxBodyBytes: MAX_BODY },
    );
    const { port } = new URL(subswitch.url);

    const reply = await readReply(
      port,
      (socket) => {
        socket.write(
          `POST /v1/messages HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
            `content-type: application/json\r\ncontent-length: ${MAX_BODY * 4}\r\n\r\n`,
        );
        // The only body bytes this client will ever send — a fraction of the cap.
        socket.write("x".repeat(FIRST_CHUNK));
      },
      3_000,
    );

    assert.match(reply, /^HTTP\/1\.1 413 /, `declared oversize must be answered 413; got: ${JSON.stringify(reply.split("\r\n")[0])}`);
    assert.match(reply, /x-subswitch-synthesized: 1/i, "the 413 must carry the synthesized marker");
    assert.match(reply, /"request_too_large"/, `the 413 body must carry error type request_too_large; got: ${JSON.stringify(reply)}`);
    assert.ok(FIRST_CHUNK < MAX_BODY, "the client must stop well short of the cap for this to prove anything");
    assert.equal(anthropic.requests.length, 0, "an oversized request must not reach the upstream");
  });

  it("still caps a chunked body, which declares no length at all", async () => {
    const MAX_BODY = 1024;
    const { anthropic, subswitch } = await setup(
      (_req, res) => { res.writeHead(200); res.end("{}"); },
      { maxBodyBytes: MAX_BODY },
    );
    const { port } = new URL(subswitch.url);

    const reply = await readReply(
      port,
      (socket) => {
        socket.write(
          `POST /v1/messages HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
            `content-type: application/json\r\ntransfer-encoding: chunked\r\n\r\n`,
        );
        const piece = "x".repeat(512);
        // Four 512-byte chunks cross the 1 KiB cap with no Content-Length in sight.
        for (let i = 0; i < 4; i += 1) socket.write(`200\r\n${piece}\r\n`);
      },
      3_000,
    );

    assert.match(reply, /^HTTP\/1\.1 413 /, `a chunked body over the cap must be answered 413; got: ${JSON.stringify(reply.split("\r\n")[0])}`);
    assert.match(reply, /"request_too_large"/, `the 413 body must carry error type request_too_large; got: ${JSON.stringify(reply)}`);
    assert.equal(anthropic.requests.length, 0, "an oversized request must not reach the upstream");
  });
});

// ---------------------------------------------------------------------------
// B10: the rejected-upload drain is bounded by bytes, not only by time
//
// The 2 s bound caps how long the drain runs, not how much it reads, and volume is
// the resource at stake: measured on this loopback, a client at line rate pushes
// 1 GB through the drain in ~215 ms, so the 2 s window admits gigabytes per
// rejected request.
//
// The assertion is on BYTES, not elapsed time, precisely because of that rate — a
// client that finishes its declared body inside the window closes early anyway, so
// a timing assertion passes with or without the byte bound (measured: 247 ms on
// unbounded code).  What the byte bound changes is how much the relay accepts
// before reclaiming the socket, and the client's own `bytesWritten` at close reads
// that number from outside the relay.
//
// Non-vacuity: RED against a drain with a time bound only — the client writes its
// full 1 GB declaration and closes, so bytesWritten is ~1e9 rather than the ~32 MiB
// the byte bound admits.  B7 above is the paired control for the other direction:
// a slow client must still be cut off by the TIME bound, so a byte bound small
// enough to fire on B7's dribble turns B7 red.
// ---------------------------------------------------------------------------

describe("server body ingestion — the rejected-upload drain is bounded by bytes as well as time (B10)", () => {
  it("stops accepting a line-rate upload long before the declared body is delivered", async () => {
    const DECLARED = 1_000_000_000;
    // Well above the drain's 32 MiB byte bound (plus whatever the kernel and Node
    // buffer ahead of it) and well below the declared length, so only the presence
    // of a byte bound decides the outcome.
    const CEILING = 200 * 1024 * 1024;
    const { subswitch } = await setup((_req, res) => res.end("{}"), { maxBodyBytes: 1024 });
    const { port } = new URL(subswitch.url);

    const outcome = await new Promise<{ responded: boolean; written: number }>((resolve, reject) => {
      let responded = false;
      const chunk = Buffer.alloc(1024 * 1024, "B");
      const socket = net.connect(Number(port), "127.0.0.1", () => {
        socket.write(
          `POST /v1/messages HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
            `content-type: application/json\r\ncontent-length: ${DECLARED}\r\n\r\n`,
        );
        // Stream as fast as the socket accepts and never stop — the case the byte
        // bound exists for.  write() returns false on the first 1 MiB chunk, so the
        // loop is one chunk per "drain", not a spin.
        const pump = (): void => { while (!socket.destroyed && socket.write(chunk)); };
        socket.on("drain", pump);
        pump();
      });
      socket.on("data", () => { responded = true; });
      socket.on("close", () => resolve({ responded, written: socket.bytesWritten }));
      socket.on("error", () => { /* RST/EPIPE on destroy is the expected end state */ });
      const giveUp = setTimeout(() => {
        socket.destroy();
        reject(new Error("socket still open 8 s after the 413 — neither drain bound fired"));
      }, 8_000);
      giveUp.unref();
    });

    assert.ok(outcome.responded, "the 413 must reach the client before the socket is destroyed");
    assert.ok(
      outcome.written < CEILING,
      `the drain must stop reading at its byte bound; the client got ${outcome.written} bytes onto the socket ` +
        `(ceiling ${CEILING}, declared ${DECLARED}) — a drain bounded only by time accepts the whole declaration`,
    );
  });
});

// ---------------------------------------------------------------------------
// B11: an origin that dies AFTER response headers must terminate the client
//
// Every other upstream-failure control in this file fails BEFORE headers reach the
// client — 502 unreachable, 504 connect timeout, B5's ECONNRESET — so the response
// callback never runs and the post-headers teardown is unreached.  The nearest
// neighbour, "self-heals after the upstream socket is destroyed server-side",
// destroys the socket while it is IDLE in the keep-alive pool, after its response
// completed.  This is the other half: the socket dies with the body half-relayed.
//
// The relay's only signal there is `upstreamRes` "error"; `pipe()` does not
// propagate source teardown to the destination, so without that handler the client
// response is never ended and never destroyed.  A half-relayed response that never
// terminates is worse than any status the origin could return (ADR-010) — the client
// cannot retry what it cannot see fail.
//
// The assertion distinguishes three outcomes, not two: a hang, a clean EOF (which
// would tell the client it received a complete stream), and an error.  Only the
// error is correct.
//
// Non-vacuity: RED with `upstreamRes.on("error", () => res.destroy())` deleted from
// src/anthropic-passthrough.ts (measured together with both `else { res.destroy(); }`
// arms neutered — the full suite stays green without this control).
// ---------------------------------------------------------------------------

describe("anthropic passthrough — an origin that dies mid-body terminates the client response (B11)", () => {
  it("surfaces a truncated stream as an error rather than a hang or a clean EOF", async () => {
    let originSocket: net.Socket | undefined;
    const { subswitch } = await setup((req, res) => {
      originSocket = req.socket;
      res.writeHead(200, { "content-type": "text/event-stream" });
      // Headers plus one frame, then nothing: the shape of a streaming completion
      // whose origin dies partway through.
      res.write("event: message_start\ndata: {}\n\n");
    });

    const response = await fetch(`${subswitch.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", stream: true, messages: [] }),
    });
    assert.equal(response.status, 200, "headers must be relayed before the origin dies");

    const reader = response.body!.getReader();
    const first = await reader.read();
    assert.equal(first.done, false, "the first frame must be relayed before the origin dies");
    assert.ok(originSocket !== undefined, "the origin socket must have been captured");

    originSocket.destroy();

    const HANG_BUDGET_MS = 3_000;
    const outcome = await Promise.race([
      reader.read().then(
        (r) => (r.done ? ("clean-eof" as const) : ("more-data" as const)),
        () => "errored" as const,
      ),
      new Promise<"hung">((resolve) => {
        setTimeout(() => resolve("hung"), HANG_BUDGET_MS).unref();
      }),
    ]);

    assert.notEqual(
      outcome,
      "hung",
      `the client response must terminate when the origin dies mid-body; it was still open ${HANG_BUDGET_MS} ms later. ` +
        `Nothing else bounds it: the relay arms no post-connect timer (ADR-010), so this hangs for the life of the process.`,
    );
    assert.equal(
      outcome,
      "errored",
      `a truncated relay must reach the client as a transport error, not ${JSON.stringify(outcome)} — ` +
        `a clean EOF tells the client it received the whole stream`,
    );
  });
});

// ---------------------------------------------------------------------------
// B12: a client-stream error must claim the settlement before tearing the upstream down
//
// On the unbuffered path the client's bytes are piped straight into the upstream,
// so a client stream that fails takes the upstream down with it.  Destroying the
// upstream without claiming the latch first leaves the settlement open for the
// ECONNRESET that destroy() raises a tick later: the upstream error handler then
// wins, logs anthropic_upstream_error, and writes a 502 for a request the origin
// never failed — a client fault reported as an origin fault, and a status the
// origin never emitted (ADR-010).  This is the same discipline the res "close"
// sibling five lines above already follows (PF-022).
//
// The client error is emitted directly rather than produced by killing the client
// socket, and deliberately so: killing the socket fires `res` "close" as well, and
// on Node 22 that arrives FIRST, claims the latch, and masks the defect on most
// runs.  The control removes the race instead of betting on it — what is under test
// is the handler's discipline, not which of two events wins.
//
// Non-vacuity: RED against `req.on("error", () => upstream.destroy())` — one
// anthropic_upstream_error warn and a 502 written to a client that is still
// connected.
// ---------------------------------------------------------------------------

describe("anthropic passthrough — a client error on the unbuffered path claims the settlement (B12)", () => {
  it("does not report the relay's own teardown as an origin failure", async () => {
    const captured: Array<{ level: LogLevel; event: string }> = [];

    // The origin accepts the connection and never answers, so no terminal outcome
    // is available except the one the test drives.
    let originSawRequest: () => void = () => undefined;
    const originReached = new Promise<void>((resolve) => { originSawRequest = resolve; });
    const origin = http.createServer(() => originSawRequest());
    await new Promise<void>((r) => origin.listen(0, "127.0.0.1", r));
    const originPort = (origin.address() as AddressInfo).port;

    const forwarder = createAnthropicForwarder({
      baseUrl: `http://127.0.0.1:${originPort}`,
      connectTimeoutMs: 10_000,
      maxUpstreamSockets: 4,
      logger: { log(level: LogLevel, event: string) { captured.push({ level, event }); } },
    });

    let inbound: import("node:http").IncomingMessage | undefined;
    // No body argument — the unbuffered path, where req is piped into the upstream.
    const relay = http.createServer((req, res) => { inbound = req; forwarder(req, res); });
    await new Promise<void>((r) => relay.listen(0, "127.0.0.1", r));
    const relayPort = (relay.address() as AddressInfo).port;

    let clientBytes = 0;
    const client = net.connect(relayPort, "127.0.0.1");
    client.on("data", (chunk: Buffer) => { clientBytes += chunk.length; });
    client.on("error", () => { /* teardown noise is not what this test measures */ });

    try {
      await new Promise<void>((r) => client.once("connect", () => r()));
      // Declared body far larger than what is sent: the request is still uploading.
      client.write(
        `POST /v1/messages HTTP/1.1\r\nHost: 127.0.0.1:${relayPort}\r\n` +
          `content-type: application/json\r\ncontent-length: 1000000\r\n\r\n{"model":"claude-sonnet-4-6"`,
      );
      await originReached;

      assert.ok(inbound !== undefined, "the relay must have received the request");
      inbound.emit("error", new Error("client stream failed mid-upload"));

      // Long enough for the upstream ECONNRESET raised by destroy() to land.
      await new Promise((r) => setTimeout(r, 200));

      const upstreamErrors = captured.filter((e) => e.event === "anthropic_upstream_error");
      assert.equal(
        upstreamErrors.length,
        0,
        `a client-side stream failure must not be logged as an origin failure; got ${JSON.stringify(upstreamErrors)}`,
      );
      assert.equal(
        clientBytes,
        0,
        `the relay must not synthesize a 502 for a request the origin never failed; ` +
          `the client received ${clientBytes} bytes`,
      );
    } finally {
      client.destroy();
      relay.closeAllConnections();
      await new Promise<void>((r) => relay.close(() => r()));
      origin.closeAllConnections();
      await new Promise<void>((r) => origin.close(() => r()));
    }
  });
});

// ---------------------------------------------------------------------------
// B13: the unbuffered 504 must reclaim the connection, not wedge it
//
// On the unbuffered path (`body === undefined` — every non-/v1/messages POST with a
// body) the client's upload is piped straight into the upstream.  When the connect
// budget expires the relay writes its 504 and destroys the upstream, and the client
// is still uploading into a request body nothing will ever read.  Node cannot parse
// the next request out of a body it never consumed, so before the fix the socket sat
// there until server.requestTimeout (600 s) — measured: 504 delivered, connection
// still open and still being written to 8 s later, `req._dump()` powerless because
// `req.pipe(upstream)` already set `_consuming`.
//
// The 413 path solved this once already; this asserts the passthrough leg reaches the
// same end state through the same helper (drainRejectedUpload, provider-transport.ts).
//
// Both bounds of the assertion matter: the response must arrive COMPLETE (draining
// before teardown is what keeps the client from losing a response it was already
// sent — ADR-010), and the socket must be reclaimed within the drain's time bound
// rather than held for requestTimeout.
//
// Non-vacuity: RED without the `req.unpipe(upstream); drainRejectedUpload(req)` pair
// in the timeout handler — the socket is still open at the 8 s give-up.
// ---------------------------------------------------------------------------

describe("anthropic passthrough — an unbuffered 504 reclaims a client that is still uploading (B13)", () => {
  it("delivers the whole 504 and closes the connection instead of holding it for requestTimeout", async (t) => {
    const CONNECT_MS = 250;
    // 192.0.2.1 is TEST-NET-1 (RFC 5737): the SYN is forwarded and never answered, so
    // the connect budget is the only thing that can end the request.  createAnthropicForwarder
    // is called directly because the config layer requires HTTPS-or-loopback base URLs.
    const forwarder = createAnthropicForwarder({
      baseUrl: "http://192.0.2.1:80",
      connectTimeoutMs: CONNECT_MS,
      maxUpstreamSockets: 1,
      logger: { log: () => undefined },
    });
    // No body argument — the unbuffered path this test exists for.
    const relay = http.createServer((req, res) => forwarder(req, res));
    await new Promise<void>((r) => relay.listen(0, "127.0.0.1", r));
    const relayPort = (relay.address() as AddressInfo).port;
    cleanups.push(() => new Promise<void>((r) => { relay.closeAllConnections(); relay.close(() => r()); }));

    const GIVE_UP_MS = 8_000;
    const outcome = await new Promise<{ wire: string; closedAfterMs: number }>((resolve) => {
      const started = Date.now();
      const received: Buffer[] = [];
      let dribble: NodeJS.Timeout | undefined;
      const stop = (): void => { if (dribble !== undefined) clearInterval(dribble); };
      const socket = net.connect(relayPort, "127.0.0.1", () => {
        // Declare far more than is ever sent: the client is mid-upload for the whole test.
        socket.write(
          `POST /v1/complete HTTP/1.1\r\nHost: 127.0.0.1:${relayPort}\r\n` +
            `content-type: application/json\r\ncontent-length: 1000000000\r\n\r\n`,
        );
        socket.write(JSON.stringify({ model: "claude-sonnet-4-6", pad: "A".repeat(4096) }));
        dribble = setInterval(() => socket.write("B".repeat(64)), 100);
      });
      socket.on("data", (chunk: Buffer) => received.push(chunk));
      socket.on("error", () => { /* RST/EPIPE on destroy is the expected end state */ });
      socket.on("close", () => {
        stop();
        resolve({ wire: Buffer.concat(received).toString("utf8"), closedAfterMs: Date.now() - started });
      });
      const giveUp = setTimeout(() => {
        stop();
        const wire = Buffer.concat(received).toString("utf8");
        socket.destroy();
        resolve({ wire, closedAfterMs: -1 });
      }, GIVE_UP_MS);
      giveUp.unref();
    });

    const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(outcome.wire)?.[1] ?? 0);
    assert.ok(
      status === 504 || status === 502,
      `expected 504 (connect timeout) or 502 (ENETUNREACH — host has no route to TEST-NET-1); got ${status} ` +
        `from wire ${JSON.stringify(outcome.wire.slice(0, 200))}`,
    );
    assert.ok(
      outcome.wire.includes("upstream timed out") || outcome.wire.includes("upstream connection failed"),
      `the synthesized error body must reach the client whole; got ${JSON.stringify(outcome.wire)}`,
    );
    assert.ok(
      outcome.wire.endsWith("0\r\n\r\n"),
      `the response must be terminated, not truncated by a teardown mid-write; got ${JSON.stringify(outcome.wire.slice(-40))}`,
    );

    if (status === 502) {
      // The host answered with ICMP unreachable, so the connect budget never ran and
      // the error path produced the response.  The reclaim below belongs to the
      // timeout path; the sibling connect-timeout tests document the same caveat.
      t.skip("host has no route to TEST-NET-1 (ENETUNREACH → 502); the connect-timeout path is unreachable here");
      return;
    }
    assert.ok(
      outcome.closedAfterMs > 1_500 && outcome.closedAfterMs < 4_000,
      `the drain's time bound must reclaim the connection; closed after ${outcome.closedAfterMs} ms ` +
        `(expected > 1_500 && < 4_000; -1 means still open at the ${GIVE_UP_MS} ms give-up, i.e. held until requestTimeout)`,
    );
  });
});
