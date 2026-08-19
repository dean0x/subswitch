import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  upstreamStatusToAnthropicError,
  proxyErrorToAnthropic,
  toAnthropicErrorBody,
  toAnthropicErrorSse,
  redactCredentials,
  SYNTHESIZED_HEADER,
  SYNTHESIZED_MARKER,
} from "../../src/errors.js";

/**
 * U3.3 — the synthesized marker's wire name and value.
 *
 * README documents `x-subswitch-synthesized: 1` as an operator contract, and every
 * emitter plus the response-direction stripper in anthropic-passthrough.ts now derives
 * from these two constants (ADR-008 chokepoint; ADR-010's third application).  Because
 * the name exists once in src/, this assertion is the single place a rename is caught.
 *
 * The literals below are restated deliberately rather than imported a second time: an
 * assertion whose two sides derive from the same source moves with it and guards nothing
 * (PF-011, self-referential pin).  Duplicating the string here is the point — a deliberate
 * rename must edit both sides and read this comment on the way past.
 *
 * Mutation that MUST turn this red: change either constant in src/errors.ts.
 */
describe("synthesized marker constants", () => {
  it("U3.3 — SYNTHESIZED_HEADER/SYNTHESIZED_MARKER match the documented wire contract", () => {
    assert.equal(
      SYNTHESIZED_HEADER,
      "x-subswitch-synthesized",
      "the synthesized marker's header name is an operator contract documented in README — " +
        "renaming it breaks every log filter and dashboard keyed on it, and must be a deliberate act",
    );
    assert.equal(
      SYNTHESIZED_MARKER,
      "1",
      "the synthesized marker's value is documented in README as `x-subswitch-synthesized: 1`",
    );
  });
});

describe("upstreamStatusToAnthropicError", () => {
  it("maps the documented statuses", () => {
    assert.deepEqual(upstreamStatusToAnthropicError(400), { status: 400, type: "invalid_request_error" });
    assert.deepEqual(upstreamStatusToAnthropicError(401), { status: 401, type: "authentication_error" });
    assert.deepEqual(upstreamStatusToAnthropicError(403), { status: 403, type: "permission_error" });
    assert.deepEqual(upstreamStatusToAnthropicError(429), { status: 429, type: "rate_limit_error" });
    assert.deepEqual(upstreamStatusToAnthropicError(500), { status: 500, type: "api_error" });
    assert.deepEqual(upstreamStatusToAnthropicError(503), { status: 503, type: "api_error" });
  });

  it("maps other 4xx to invalid_request and non-errors to 502", () => {
    assert.deepEqual(upstreamStatusToAnthropicError(422), { status: 422, type: "invalid_request_error" });
    assert.deepEqual(upstreamStatusToAnthropicError(200), { status: 502, type: "api_error" });
  });

  /**
   * I-034 / ADR-010: the same HTTP status must carry the same error.type whether the relay
   * or the origin produced it.  404 must map to not_found_error (matching the relay's own
   * /__subswitch/* 404) and 413 must map to request_too_large (matching the relay's own
   * body-too-large response) — not to invalid_request_error, which is the generic 4xx fallback.
   */
  it("I-034 — 404 maps to not_found_error and 413 maps to request_too_large (ADR-010)", () => {
    assert.deepEqual(upstreamStatusToAnthropicError(404), { status: 404, type: "not_found_error" });
    assert.deepEqual(upstreamStatusToAnthropicError(413), { status: 413, type: "request_too_large" });
  });
});

describe("proxyErrorToAnthropic", () => {
  it("maps each error kind", () => {
    assert.equal(proxyErrorToAnthropic({ kind: "auth", message: "x" }).status, 401);
    assert.equal(proxyErrorToAnthropic({ kind: "translate", message: "x" }).status, 400);
    assert.equal(proxyErrorToAnthropic({ kind: "timeout", message: "x" }).status, 504);
    assert.equal(proxyErrorToAnthropic({ kind: "upstream", message: "x", status: 429 }).type, "rate_limit_error");
    assert.equal(proxyErrorToAnthropic({ kind: "upstream", message: "x" }).status, 502);
  });
});

describe("anthropic error shaping", () => {
  it("produces the documented JSON body", () => {
    const body = JSON.parse(toAnthropicErrorBody("rate_limit_error", "slow down"));
    assert.deepEqual(body, { type: "error", error: { type: "rate_limit_error", message: "slow down" } });
  });

  it("produces a well-formed SSE error event", () => {
    const sse = toAnthropicErrorSse("api_error", "boom");
    assert.match(sse, /^event: error\n/);
    assert.match(sse, /\n\n$/);
    const data = JSON.parse(sse.split("\n")[1]!.slice(6));
    assert.equal(data.error.type, "api_error");
  });
});

/**
 * U3.1 — table-driven tests of redactCredentials directly.
 *
 * Mutation that MUST turn this red: remove either `.replace` call inside redactCredentials.
 * PF-011: proven RED against the named mutation before trusting green.
 */
describe("redactCredentials", () => {
  it("U3.1 — redacts bearer tokens, JWTs, a combined Bearer-JWT case, and passes clean text through", () => {
    // Bearer token (non-JWT value)
    assert.equal(
      redactCredentials("error: Bearer sk-ant-api03-ABCDEF1234"),
      "error: Bearer <redacted>",
      "Bearer non-JWT token must be redacted",
    );
    // JWT alone (starts with eyJ, three dot-separated base64url parts)
    assert.equal(
      redactCredentials("token: eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyMTIzIn0.sig"),
      "token: <redacted-jwt>",
      "standalone JWT must be redacted",
    );
    // Combined: Bearer followed by a JWT — Bearer must consume it whole, no dangling prefix
    assert.equal(
      redactCredentials("auth: Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyMTIzIn0.sig"),
      "auth: Bearer <redacted>",
      "Bearer JWT combined case: Bearer pattern must win, leaving no dangling 'Bearer ' prefix",
    );
    // Clean string — passes through unchanged
    assert.equal(
      redactCredentials("the upstream returned a server error"),
      "the upstream returned a server error",
      "string with nothing to redact must pass through unchanged",
    );
    // Empty string
    assert.equal(redactCredentials(""), "", "empty string must pass through unchanged");
  });
});

/**
 * U3.1a — BEARER_PATTERN must NOT fire on short words that follow "Bearer" in prose.
 *
 * Regression guard for SEC-06/REGR-03: the pre-fix pattern had a one-character minimum,
 * causing "bearer token" in error messages to be redacted and mangling 401/403 bodies.
 *
 * Mutation that MUST turn this red: drop the {12,} minimum (revert to `+`).
 * PF-011: proven RED against the named mutation before trusting green.
 */
describe("redactCredentials — prose false-positive guard", () => {
  it("U3.1a — short words after 'Bearer' in prose pass through unchanged", () => {
    // The canonical SEC-06 repro: "bearer token" was being redacted, mangling 401/403 bodies.
    assert.equal(
      redactCredentials("Missing bearer token in Authorization header"),
      "Missing bearer token in Authorization header",
      "'bearer token' in prose must pass through — 'token' (5 chars) is below the 12-char minimum",
    );
    // Additional short words that should not trigger redaction
    assert.equal(
      redactCredentials("No valid Bearer auth provided"),
      "No valid Bearer auth provided",
      "'Bearer auth' in prose must pass through — 'auth' (4 chars) is below the 12-char minimum",
    );
  });

  it("U3.1b — tokens of exactly 12+ chars are still redacted; 11 chars and below pass through", () => {
    // Exactly 11 chars — just below boundary; must NOT be redacted
    assert.equal(
      redactCredentials("Bearer ABCDEFGHIJK"),
      "Bearer ABCDEFGHIJK",
      "11-char token must NOT be redacted (below 12-char minimum)",
    );
    // Exactly 12 chars — at boundary; MUST be redacted
    assert.equal(
      redactCredentials("Bearer ABCDEFGHIJKL"),
      "Bearer <redacted>",
      "12-char token MUST be redacted (at the minimum)",
    );
    // Realistic JWT bearer token — must still be redacted
    assert.equal(
      redactCredentials("Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.signature"),
      "Authorization: Bearer <redacted>",
      "realistic JWT bearer token must still be redacted after the minimum-length fix",
    );
  });
});

/**
 * U3.2 — toAnthropicErrorBody strips credentials AND the envelope stays intact.
 *
 * Mutation that MUST turn this red: remove the redactCredentials call inside toAnthropicErrorBody.
 * PF-011: proven RED against the named mutation before trusting green.
 */
describe("toAnthropicErrorBody credential redaction", () => {
  it("U3.2 — strips Bearer JWT from message and preserves the {type,error:{type,message}} envelope", () => {
    const jwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyMTIzIn0.sig";
    const body = JSON.parse(toAnthropicErrorBody("api_error", `upstream returned: Bearer ${jwt}`)) as {
      type: string;
      error: { type: string; message: string };
    };
    // Envelope shape must be intact
    assert.equal(body.type, "error", "outer type must be 'error'");
    assert.equal(body.error.type, "api_error", "error.type must be preserved");
    // JWT must be gone
    assert.ok(!body.error.message.includes("eyJ"), "JWT (eyJ prefix) must not appear in error message");
    assert.ok(!body.error.message.includes(jwt), "full JWT must not appear in error message");
    // Surrounding context must be retained
    assert.ok(body.error.message.includes("upstream returned:"), "surrounding context must be preserved");
  });
});
