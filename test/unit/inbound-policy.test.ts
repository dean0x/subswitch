import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { applyInboundPolicy, hostGateVerdict, responseForClientError } from "../../src/inbound-policy.js";
import { createConsoleLogger } from "../../src/logger.js";

// ── I-055: prototype-safe responseForClientError lookup ─────────────────────
describe("responseForClientError — prototype-safe lookup", () => {
  it('returns MALFORMED for "constructor" (prototype property, not a response descriptor)', () => {
    const r = responseForClientError("constructor");
    assert.equal(r.status, 400, '"constructor" must yield the 400 MALFORMED fallback');
    assert.equal(r.reason, "Bad Request");
    assert.equal(r.type, "invalid_request_error");
  });

  it('returns MALFORMED for "__proto__" (prototype property, not a response descriptor)', () => {
    const r = responseForClientError("__proto__");
    assert.equal(r.status, 400, '"__proto__" must yield the 400 MALFORMED fallback');
    assert.equal(r.reason, "Bad Request");
  });

  it("returns the mapped entry for ERR_HTTP_REQUEST_TIMEOUT (known code)", () => {
    const r = responseForClientError("ERR_HTTP_REQUEST_TIMEOUT");
    assert.equal(r.status, 408, "timeout code must map to 408");
  });

  it("returns the mapped entry for HPE_HEADER_OVERFLOW (known code)", () => {
    const r = responseForClientError("HPE_HEADER_OVERFLOW");
    assert.equal(r.status, 431, "header-overflow code must map to 431");
  });

  it("returns MALFORMED for an unknown string", () => {
    const r = responseForClientError("HPE_TOTALLY_UNKNOWN");
    assert.equal(r.status, 400);
  });
});

// ── I-074: applyInboundPolicy idempotency guard ──────────────────────────────
describe("applyInboundPolicy — idempotency guard", () => {
  it("registers exactly one clientError listener even when called twice on the same server", () => {
    const server = http.createServer();
    const logger = createConsoleLogger("warn");
    applyInboundPolicy(server, logger);
    applyInboundPolicy(server, logger);
    assert.equal(
      server.listenerCount("clientError"),
      1,
      "double call must not double-register the clientError handler",
    );
    server.close();
  });

  it("registers exactly one request listener even when called twice", () => {
    const server = http.createServer();
    const logger = createConsoleLogger("warn");
    applyInboundPolicy(server, logger);
    applyInboundPolicy(server, logger);
    // The WeakMap baseline listener registers on 'request' — one per server.
    assert.equal(
      server.listenerCount("request"),
      1,
      "double call must not double-register the request baseline listener",
    );
    server.close();
  });
});

// ── I-047: hostGateVerdict — the pure half of the loopback Host/Origin gate ──
//
// The integration controls in test/integration/host-gate.test.ts pin the wire
// behaviour; these pin the parse, which is where the interesting cases live.
// Every allow case below is a spelling a real loopback client produces; every
// reject case is one an attacker (or a mistake) produces.
describe("hostGateVerdict — Host authority parsing", () => {
  const verdictFor = (host: string): ReturnType<typeof hostGateVerdict> => hostGateVerdict({ host });

  it("allows every loopback spelling a real client sends", () => {
    for (const host of [
      "127.0.0.1:4141",
      "127.0.0.1",
      "127.1.2.3:4141",     // all of 127.0.0.0/8 is loopback
      "localhost",
      "localhost:4141",
      "LOCALHOST:4141",     // Host is case-insensitive
      "[::1]:4141",         // bracketed IPv6 with port
      "[::1]",              // bracketed IPv6 without port
      "::1",                // bare IPv6 literal (no brackets, no port)
      "[::ffff:127.0.0.1]:4141", // IPv4-mapped IPv6 loopback — the same address as 127.0.0.1
      "::ffff:127.0.0.1",
    ]) {
      assert.equal(verdictFor(host).kind, "allow", `Host: ${host} names this relay's own listener`);
    }
  });

  it("rejects a hostname that merely starts with a loopback literal", () => {
    // The rebinding domain shape (nip.io, sslip.io, and any attacker-registered
    // equivalent).  A prefix test such as `startsWith("127.")` accepts all of these.
    for (const host of ["127.0.0.1.evil.test", "127.0.0.1.evil.test:4141", "localhost.evil.test", "localhosts"]) {
      const verdict = verdictFor(host);
      assert.equal(verdict.kind, "reject", `Host: ${host} is a registrable domain, not a loopback address`);
      assert.equal(verdict.kind === "reject" ? verdict.reason : "", "foreign_host");
    }
  });

  it("rejects a foreign host, with and without a port", () => {
    for (const host of ["evil.test", "evil.test:4141", "EVIL.TEST", "api.anthropic.com", "192.168.1.5:4141", "0.0.0.0:4141"]) {
      assert.equal(verdictFor(host).kind, "reject", `Host: ${host} is not this relay`);
    }
  });

  it("rejects an unparseable authority rather than guessing at it", () => {
    for (const host of [
      "evil.test:notaport",
      "[::1",               // unterminated bracket
      "[::1]junk",          // trailing garbage after the bracket
      "[]:4141",            // empty bracketed host
      "127.0.0.999",        // octet out of range
      "127.1",              // inet_aton short form — browsers normalise it away
      "2130706433",         // decimal form of 127.0.0.1 — likewise
      "::ffff:127.0.0.1:4141", // unbracketed IPv6 with a port is ambiguous (RFC 3986 requires brackets)
    ]) {
      assert.equal(verdictFor(host).kind, "reject", `Host: ${host} must not be read as loopback`);
    }
  });

  it("rejects a missing or empty Host with the missing_host reason", () => {
    // Node answers an HTTP/1.1 request with no Host itself (400, before the request
    // listener), but HTTP/1.0 has no Host requirement and reaches dispatch with
    // `host` undefined — measured on Node 22.
    for (const headers of [{}, { host: "" }, { host: "   " }]) {
      const verdict = hostGateVerdict(headers);
      assert.equal(verdict.kind, "reject");
      assert.equal(verdict.kind === "reject" ? verdict.reason : "", "missing_host");
    }
  });
});

describe("hostGateVerdict — Origin defence in depth", () => {
  const LOOPBACK = { host: "127.0.0.1:4141" };

  it("allows a request with no Origin at all (Claude Code, curl)", () => {
    assert.equal(hostGateVerdict(LOOPBACK).kind, "allow");
  });

  it("allows a loopback Origin", () => {
    for (const origin of ["http://localhost:3000", "http://127.0.0.1:4141", "https://127.0.0.1", "http://[::1]:8080"]) {
      assert.equal(hostGateVerdict({ ...LOOPBACK, origin }).kind, "allow", `Origin: ${origin} is a loopback page`);
    }
  });

  it("rejects a non-loopback or opaque Origin", () => {
    for (const origin of ["http://evil.test", "https://evil.test:8443", "null", "http://a.test, http://b.test", "not a url"]) {
      const verdict = hostGateVerdict({ ...LOOPBACK, origin });
      assert.equal(verdict.kind, "reject", `Origin: ${origin} is not a loopback origin`);
      assert.equal(verdict.kind === "reject" ? verdict.reason : "", "foreign_origin");
    }
  });

  it("reports the Host reason first when both headers are foreign", () => {
    const verdict = hostGateVerdict({ host: "evil.test:4141", origin: "http://evil.test" });
    assert.equal(verdict.kind === "reject" ? verdict.reason : "", "foreign_host");
  });
});

describe("hostGateVerdict — the rejected value is safe to log and absent from the message", () => {
  it("caps the observed value and strips anything outside the authority charset", () => {
    const verdict = hostGateVerdict({ host: `evil]0;PWNED.test "x" ${"a".repeat(200)}` });
    assert.equal(verdict.kind, "reject");
    if (verdict.kind !== "reject") return;
    assert.ok(verdict.observed.length <= 64, `observed must be length-capped; got ${verdict.observed.length}`);
    assert.match(
      verdict.observed,
      /^[a-z0-9.:/[\]?_-]*$/,
      `observed must be restricted to a safe charset; got ${JSON.stringify(verdict.observed)}`,
    );
  });

  it("never puts the client-supplied value into the client-visible message", () => {
    const host = hostGateVerdict({ host: "evil.test:4141" });
    assert.ok(host.kind === "reject" && !host.message.includes("evil.test"), "the Host must not be reflected");
    const origin = hostGateVerdict({ host: "127.0.0.1:4141", origin: "http://evil.test" });
    assert.ok(origin.kind === "reject" && !origin.message.includes("evil.test"), "the Origin must not be reflected");
  });
});
