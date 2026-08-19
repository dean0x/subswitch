import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { applyInboundPolicy, responseForClientError } from "../../src/inbound-policy.js";
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
