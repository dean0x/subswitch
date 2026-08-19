/**
 * I-047 — the loopback Host/Origin gate.
 *
 * subswitch binds 127.0.0.1, requires no authentication, and holds the operator's
 * Codex OAuth material.  Without a Host check, a page served from
 * `http://evil.test:4141` that rebinds `evil.test` to 127.0.0.1 with a short TTL is
 * treated by the browser as SAME-ORIGIN with the relay: the request carries no
 * credentials the attacker needs to forge, and the response is fully READABLE.
 * `gpt-*` names resolve to the Codex leg, which attaches the victim's
 * `~/.codex/auth.json`, so the page gets unlimited inference billed to the victim's
 * ChatGPT subscription and can read every token back.
 *
 * The gate rejects with 403 `permission_error` (applies ADR-010: rejecting a Host
 * that names a domain this relay does not serve is not a transparency violation —
 * such a request is one the origin would never have received — but the rejection
 * must use a status and shape the origin itself emits, and Anthropic emits
 * 403/permission_error).  Every body renders through `toAnthropicErrorBody`
 * (applies ADR-008).
 *
 * Every control below was proven RED against HEAD before the gate existed
 * (avoids PF-011): the foreign-Host requests were forwarded upstream and answered
 * 200, and the Codex-routed one reached the auth layer.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { startSubswitch, startFakeUpstream, rawHttpRequest, type FakeUpstream, type SubswitchInstance } from "./fake-upstreams.js";

const cleanups: (() => Promise<void>)[] = [];
after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

const MESSAGES_BODY = Buffer.from(JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }));

interface Fixture {
  readonly anthropic: FakeUpstream;
  readonly subswitch: SubswitchInstance;
  readonly port: string;
}

/**
 * A relay whose Anthropic leg is a fake upstream and whose Codex leg has no auth
 * file, so a Codex-routed request fails locally (401 authentication_error) instead
 * of reaching chatgpt.com.  That 401 is what the ordering control below discriminates
 * against: a 403 proves the gate ran BEFORE routing.
 */
const setup = async (): Promise<Fixture> => {
  const anthropic = await startFakeUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "msg_fake", type: "message" }));
  });
  const subswitch = await startSubswitch({
    anthropic: { baseUrl: anthropic.url },
    providers: { codex: { authFile: "/tmp/subswitch-host-gate-absent-auth.json" } },
  });
  cleanups.push(subswitch.close, anthropic.close);
  return { anthropic, subswitch, port: new URL(subswitch.url).port };
};

const parseErrorBody = (body: Buffer): { type: string; error: { type: string; message: string } } =>
  JSON.parse(body.toString("utf8")) as { type: string; error: { type: string; message: string } };

const headerValue = (rawHeaders: readonly string[], name: string): string | undefined => {
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    if (rawHeaders[i]?.toLowerCase() === name) return rawHeaders[i + 1];
  }
  return undefined;
};

// ---------------------------------------------------------------------------
// G1: a foreign Host is rejected before the request is forwarded
// ---------------------------------------------------------------------------

describe("host gate — a foreign Host is answered 403 and never forwarded (G1)", () => {
  it("rejects Host: evil.test with permission_error, the synthesized marker, and no upstream call", async () => {
    const { anthropic, subswitch, port } = await setup();

    const response = await rawHttpRequest(`${subswitch.url}/v1/messages`, {
      method: "POST",
      rawHeaders: ["Host", `evil.test:${port}`, "content-type", "application/json"],
      body: MESSAGES_BODY,
    });

    assert.equal(response.status, 403, "a Host this relay does not serve must be refused");
    const body = parseErrorBody(response.body);
    assert.equal(body.type, "error", "the body must be the Anthropic error envelope (toAnthropicErrorBody — ADR-008)");
    assert.equal(body.error.type, "permission_error", "403 carries permission_error, the type Anthropic emits for 403");
    assert.equal(
      headerValue(response.rawHeaders, "x-subswitch-synthesized"),
      "1",
      "the 403 is relay-authored and must be marked as synthesized",
    );
    // No reflection: the attacker-controlled Host must not appear in the client-visible body.
    assert.ok(
      !response.body.toString("utf8").includes("evil.test"),
      `the rejected Host must never be reflected into the response body; got ${response.body.toString("utf8")}`,
    );
    // The load-bearing assertion: RED on HEAD, where this request was forwarded verbatim.
    assert.equal(anthropic.requests.length, 0, "a rejected request must never reach the Anthropic upstream");
  });
});

// ---------------------------------------------------------------------------
// G2: every loopback spelling still works — regression guard, GREEN before and after
// ---------------------------------------------------------------------------

describe("host gate — loopback Host spellings are unaffected (G2)", () => {
  it("forwards 127.0.0.1, localhost, LOCALHOST, [::1] and a bare IP with no port", async () => {
    const { anthropic, subswitch, port } = await setup();

    const spellings = [
      `127.0.0.1:${port}`,
      `localhost:${port}`,
      `LOCALHOST:${port}`,
      `[::1]:${port}`,
      "127.0.0.1",
      `127.1.2.3:${port}`,
    ];

    for (const host of spellings) {
      const response = await rawHttpRequest(`${subswitch.url}/v1/messages`, {
        method: "POST",
        rawHeaders: ["Host", host, "content-type", "application/json"],
        body: MESSAGES_BODY,
      });
      assert.equal(response.status, 200, `Host: ${host} is loopback and must be served exactly as before`);
    }

    assert.equal(
      anthropic.requests.length,
      spellings.length,
      "every loopback spelling must still reach the Anthropic upstream",
    );
  });
});

// ---------------------------------------------------------------------------
// G3: a rebinding-shaped hostname must not pass the loopback test
// ---------------------------------------------------------------------------

describe("host gate — a hostname that merely STARTS with a loopback literal is foreign (G3)", () => {
  it("rejects Host: 127.0.0.1.evil.test (the nip.io-style rebinding domain shape)", async () => {
    const { anthropic, subswitch, port } = await setup();

    for (const host of [`127.0.0.1.evil.test:${port}`, `localhost.evil.test:${port}`, `evil-127.0.0.1:${port}`]) {
      const response = await rawHttpRequest(`${subswitch.url}/v1/messages`, {
        method: "POST",
        rawHeaders: ["Host", host, "content-type", "application/json"],
        body: MESSAGES_BODY,
      });
      assert.equal(response.status, 403, `Host: ${host} is a registrable domain, not a loopback address`);
    }
    assert.equal(anthropic.requests.length, 0, "none of the rebinding-shaped hosts may be forwarded");
  });
});

// ---------------------------------------------------------------------------
// G4: Origin, as defence in depth
// ---------------------------------------------------------------------------

describe("host gate — a non-loopback Origin is rejected even on a loopback Host (G4)", () => {
  it("rejects Origin: http://evil.test, allows a loopback Origin, and allows no Origin at all", async () => {
    const { anthropic, subswitch, port } = await setup();

    const foreign = await rawHttpRequest(`${subswitch.url}/v1/messages`, {
      method: "POST",
      rawHeaders: ["Host", `127.0.0.1:${port}`, "Origin", "http://evil.test", "content-type", "application/json"],
      body: MESSAGES_BODY,
    });
    assert.equal(foreign.status, 403, "a cross-origin browser fetch names its origin — reject it");
    assert.equal(parseErrorBody(foreign.body).error.type, "permission_error");
    assert.ok(!foreign.body.toString("utf8").includes("evil.test"), "the Origin must not be reflected into the body");

    // Origin: null — the opaque origin a sandboxed iframe or a redirected cross-origin
    // request sends.  It names no loopback host, so it is refused with the rest.
    const opaque = await rawHttpRequest(`${subswitch.url}/v1/messages`, {
      method: "POST",
      rawHeaders: ["Host", `127.0.0.1:${port}`, "Origin", "null", "content-type", "application/json"],
      body: MESSAGES_BODY,
    });
    assert.equal(opaque.status, 403, "an opaque (null) Origin is not a loopback origin");

    const loopbackOrigin = await rawHttpRequest(`${subswitch.url}/v1/messages`, {
      method: "POST",
      rawHeaders: ["Host", `127.0.0.1:${port}`, "Origin", "http://localhost:3000", "content-type", "application/json"],
      body: MESSAGES_BODY,
    });
    assert.equal(loopbackOrigin.status, 200, "a local dev page on loopback stays allowed");

    const noOrigin = await rawHttpRequest(`${subswitch.url}/v1/messages`, {
      method: "POST",
      rawHeaders: ["Host", `127.0.0.1:${port}`, "content-type", "application/json"],
      body: MESSAGES_BODY,
    });
    assert.equal(noOrigin.status, 200, "Claude Code and curl send no Origin — they must be unaffected");

    assert.equal(anthropic.requests.length, 2, "only the two allowed requests may reach the upstream");
  });
});

// ---------------------------------------------------------------------------
// G5: the gate covers the relay-owned management namespace too
// ---------------------------------------------------------------------------

describe("host gate — /__subswitch/* is gated like every other path (G5)", () => {
  it("answers 403 for a foreign-Host health probe instead of 200", async () => {
    const { subswitch, port } = await setup();

    const rejected = await rawHttpRequest(`${subswitch.url}/__subswitch/health`, {
      method: "GET",
      rawHeaders: ["Host", `evil.test:${port}`],
    });
    assert.equal(rejected.status, 403, "the health endpoint discloses relay topology — gate it with everything else");
    assert.equal(parseErrorBody(rejected.body).error.type, "permission_error");

    const allowed = await rawHttpRequest(`${subswitch.url}/__subswitch/health`, {
      method: "GET",
      rawHeaders: ["Host", `127.0.0.1:${port}`],
    });
    assert.equal(allowed.status, 200, "the same probe from loopback is unchanged");
  });
});

// ---------------------------------------------------------------------------
// G6: the gate runs BEFORE routing — the Codex leg is never reached
// ---------------------------------------------------------------------------

describe("host gate — a Codex-routed model is rejected before the Codex leg runs (G6)", () => {
  it("answers 403 permission_error, not the 401 the auth layer would produce", async () => {
    const { anthropic, subswitch, port } = await setup();

    const response = await rawHttpRequest(`${subswitch.url}/v1/messages`, {
      method: "POST",
      rawHeaders: ["Host", `evil.test:${port}`, "content-type", "application/json"],
      body: Buffer.from(JSON.stringify({ model: "gpt-5.6-sol", max_tokens: 16, messages: [{ role: "user", content: "hi" }] })),
    });

    // Discriminating assertion: the fixture's Codex leg has no auth file, so reaching it
    // produces 401 authentication_error.  403 proves the gate fired first — the request
    // never got close to the victim's OAuth material.
    assert.equal(response.status, 403, "the gate must fire before model resolution and provider dispatch");
    assert.equal(parseErrorBody(response.body).error.type, "permission_error");
    assert.equal(anthropic.requests.length, 0);
  });
});

// ---------------------------------------------------------------------------
// G7: a request that reaches dispatch with no Host at all
//
// Node rejects an HTTP/1.1 request with no Host at parse time (measured on Node
// 22: `GET / HTTP/1.1\r\n\r\n` gets Node's own 400 and never reaches the request
// listener).  HTTP/1.0 has no Host requirement, so `req.headers.host` IS reachable
// as undefined — measured: the same handler sees `host=undefined version=1.0`.
// An empty `Host:` value reaches dispatch on HTTP/1.1 as well.
// ---------------------------------------------------------------------------

describe("host gate — a request with no usable Host is rejected (G7)", () => {
  it("answers 403 to an HTTP/1.0 request with no Host and to an empty Host on HTTP/1.1", async () => {
    const { anthropic, port } = await setup();

    const rawExchange = (payload: string): Promise<string> =>
      new Promise((resolve, reject) => {
        const socket = net.connect(Number(port), "127.0.0.1", () => socket.write(payload));
        let received = "";
        socket.on("data", (chunk: Buffer) => { received += chunk.toString("utf8"); });
        socket.on("close", () => resolve(received));
        socket.on("error", reject);
        const giveUp = setTimeout(() => { socket.destroy(); reject(new Error("no response within 5 s")); }, 5_000);
        giveUp.unref();
      });

    const noHost = await rawExchange("GET /v1/models HTTP/1.0\r\n\r\n");
    assert.match(noHost, /^HTTP\/1\.1 403 /, `HTTP/1.0 with no Host must be refused; got ${JSON.stringify(noHost.slice(0, 80))}`);
    assert.ok(noHost.includes("permission_error"), "the no-Host rejection uses the same Anthropic-shaped body");

    const emptyHost = await rawExchange("GET /v1/models HTTP/1.1\r\nHost: \r\nConnection: close\r\n\r\n");
    assert.match(emptyHost, /^HTTP\/1\.1 403 /, `an empty Host must be refused; got ${JSON.stringify(emptyHost.slice(0, 80))}`);

    assert.equal(anthropic.requests.length, 0, "neither request may be forwarded");
  });
});

// ---------------------------------------------------------------------------
// G8: a rejected upload is drained, not RST
//
// Same shape as B7 (the 413 path): the client is mid-upload when the 403 is written.
// Destroying the socket there makes the kernel send RST and the client may discard
// the 403 it was just sent, so the gate reuses drainRejectedUpload and inherits both
// of its bounds — the client reads the full body, and a client that ignores it is
// reclaimed at the 2 s drain bound rather than held for requestTimeout (600 s).
// ---------------------------------------------------------------------------

describe("host gate — a foreign-Host POST mid-upload reads its 403 and is then reclaimed (G8)", () => {
  it("delivers the complete 403 body and destroys the socket at the drain bound", async () => {
    const { port } = await setup();

    const timeline = await new Promise<{ received: string; closedAfterMs: number }>((resolve, reject) => {
      const started = Date.now();
      let received = "";
      let dribble: NodeJS.Timeout | undefined;
      const socket = net.connect(Number(port), "127.0.0.1", () => {
        socket.write(
          `POST /v1/messages HTTP/1.1\r\nHost: evil.test:${port}\r\n` +
            `content-type: application/json\r\ncontent-length: 1000000000\r\n\r\n`,
        );
        socket.write(JSON.stringify({ model: "gpt-5.6-sol", pad: "A".repeat(4096) }));
        // Keep uploading after the 403 — the case the drain bound exists for.
        dribble = setInterval(() => socket.write("B".repeat(64)), 100);
      });
      socket.on("data", (chunk: Buffer) => { received += chunk.toString("utf8"); });
      socket.on("close", () => {
        if (dribble !== undefined) clearInterval(dribble);
        resolve({ received, closedAfterMs: Date.now() - started });
      });
      socket.on("error", () => { /* RST/EPIPE after destroy is the expected end state */ });
      const giveUp = setTimeout(() => {
        if (dribble !== undefined) clearInterval(dribble);
        socket.destroy();
        reject(new Error("socket still open 8 s after the 403 — the drain bound never fired"));
      }, 8_000);
      giveUp.unref();
    });

    assert.match(timeline.received, /^HTTP\/1\.1 403 /, "the 403 status line must reach a client that is still uploading");
    assert.ok(
      timeline.received.includes("permission_error"),
      `the complete error body must survive the teardown; got ${JSON.stringify(timeline.received.slice(0, 200))}`,
    );
    assert.ok(
      timeline.closedAfterMs > 1_500 && timeline.closedAfterMs < 3_000,
      `the 2 s drain bound must reclaim the connection; socket stayed open ${timeline.closedAfterMs} ms (expected > 1_500 && < 3_000)`,
    );
  });
});
