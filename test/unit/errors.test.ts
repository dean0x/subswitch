import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { upstreamStatusToAnthropicError, proxyErrorToAnthropic, toAnthropicErrorBody, toAnthropicErrorSse, redactCredentials } from "../../src/errors.js";

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
});

describe("proxyErrorToAnthropic", () => {
  it("maps each error kind", () => {
    assert.equal(proxyErrorToAnthropic({ kind: "auth", message: "x" }).status, 401);
    assert.equal(proxyErrorToAnthropic({ kind: "translate", message: "x" }).status, 400);
    assert.equal(proxyErrorToAnthropic({ kind: "body_too_large", message: "x" }).status, 413);
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
