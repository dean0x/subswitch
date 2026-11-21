import assert from "node:assert/strict";
import { it } from "node:test";
import { proxyErrorToAnthropic } from "../../src/errors.js";
import {
  createGeminiAccountBlockLatch, GEMINI_ERRORS, renderGeminiUpstreamError, toGeminiProxyError,
} from "../../src/gemini-errors.js";

it("sets the account latch for a reported TOS violation and for an unparsed 403", () => {
  for (const reason of ["TOS_VIOLATION", undefined, "FAKE-UNKNOWN-REASON", { reason: "UNSUPPORTED_CLIENT" }]) {
    const latch = createGeminiAccountBlockLatch();
    assert.equal(latch.isBlocked(), false);
    const reply = renderGeminiUpstreamError(403, reason, new Headers(), latch);
    assert.equal(latch.isBlocked(), true);
    assert.equal(reply.errorCode, reason === "TOS_VIOLATION" ? "TOS_VIOLATION" : "account_blocked");
    assert.equal(latch.isBlocked(), true);
  }
});

it("maps reported reasons and other statuses to fixed replies without a block", () => {
  const latch = createGeminiAccountBlockLatch();
  for (const [status, reason, code, expectedStatus, message] of [
    [403, "UNSUPPORTED_CLIENT", "UNSUPPORTED_CLIENT", 403, "Gemini refused this client. Check for a Subswitch update."],
    [403, "VALIDATION_REQUIRED", "VALIDATION_REQUIRED", 403, "Gemini requires account validation. Open `agy` in your own Terminal."],
    [429, "RESOURCE_EXHAUSTED", "RESOURCE_EXHAUSTED", 429, "Gemini has no quota for this request. Retry later."],
    [429, undefined, "rate_limited", 429, "Gemini limited the request rate. Retry later."],
    [401, "FAKE-UPSTREAM-DETAIL", "sign_in_again", 401, "The Gemini sign-in is not usable. Sign in again with `agy` in your own Terminal."],
    [599, "FAKE-UPSTREAM-DETAIL", "upstream_error", 502, "Gemini did not complete the request. Retry later."],
  ] as const) {
    const reply = renderGeminiUpstreamError(status, reason, new Headers(), latch);
    assert.equal(reply.errorCode, code);
    assert.equal(reply.status, expectedStatus);
    assert.equal(reply.message, message);
    assert.equal(latch.isBlocked(), false);
  }
});

it("passes only a bounded digit-only retry-after header", () => {
  const latch = createGeminiAccountBlockLatch();
  const render = (value: string) => renderGeminiUpstreamError(429, "RESOURCE_EXHAUSTED", new Headers({
    "retry-after": value, location: "https://example.invalid/FAKE-LINK", "x-detail": "FAKE-UPSTREAM-DETAIL",
  }), latch).headers;
  for (const value of ["0", "120", "999999"]) assert.deepEqual(render(value), { "retry-after": value });
  for (const value of ["", "-1", "1.0", "1e2", "1000000", "1, 2", "1FAKE", "Wed, 21 Oct 2015 07:28:00 GMT"]) {
    assert.deepEqual(render(value), {});
  }
});

it("uses a closed table with fixed client and log mappings", () => {
  assert.deepEqual(Object.keys(GEMINI_ERRORS).sort(), [
    "RESOURCE_EXHAUSTED", "TOS_VIOLATION", "UNSUPPORTED_CLIENT", "VALIDATION_REQUIRED", "account_blocked",
    "cancelled", "denied", "exec_failed", "image_unsupported", "invalid_record", "invalid_request", "malformed",
    "missing", "output_too_large", "rate_limited", "sign_in_again", "signature_missing", "timeout",
    "unsupported_platform", "upstream_error",
  ]);
  for (const code of Object.keys(GEMINI_ERRORS) as (keyof typeof GEMINI_ERRORS)[]) {
    const entry = GEMINI_ERRORS[code];
    const error = toGeminiProxyError(code);
    assert.equal(proxyErrorToAnthropic(error).status, entry.status);
    assert.match(entry.event, /^gemini_(?:upstream_error|credential_load_failed|token_refresh_failed|translate_warning)$/);
    assert.equal(error.message, `${entry.text} ${entry.hint}`);
  }
});
