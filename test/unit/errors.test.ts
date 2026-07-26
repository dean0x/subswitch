import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { upstreamStatusToAnthropicError, proxyErrorToAnthropic, toAnthropicErrorBody, toAnthropicErrorSse } from "../../src/errors.js";

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
