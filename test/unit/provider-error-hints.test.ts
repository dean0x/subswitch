/** Only fabricated in-memory bodies and errors; no auth, files, or transports. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createConsoleLogger, type LogFields, type ProviderErrorHints } from "../../src/logger.js";
import { logProviderFailure, providerErrorHints } from "../../src/routing/provider-failure.js";

const secret = "fabricated-secret-token-device-code-private-prompt";
const body = (value: unknown) => ({ text: JSON.stringify(value), complete: true, truncated: false });
const hints = (error: unknown) => providerErrorHints(body({ error }));
const unknown = { rejectionEnvelope: "unrecognized", rejectionReason: "unrecognized", rejectionField: "unknown",
  rejectionCode: "unrecognized" } as const;

for (const [error, reason, field, code] of [
  [{ code: "unsupported_tool_type", param: "tools[0].type" }, "unsupported_tool_type", "tools", "unsupported_tool_type"],
  [{ message: "Unsupported tool type: custom" }, "unsupported_tool_type", "unknown", "unrecognized"],
  [{ message: "Namespace tools are not supported", param: "tools" }, "unsupported_tool_type", "tools", "unrecognized"],
  [{ code: "invalid_value", message: "Invalid value: 'custom'.", param: "tools[0].type" }, "unsupported_tool_type", "tools", "invalid_value"],
  [{ message: "Invalid function schema", param: "tools[1].parameters" }, "invalid_tool_schema", "tools", "unrecognized"],
  [{ message: "Unsupported reasoning effort", param: "reasoning.effort" }, "unsupported_effort", "reasoning", "unrecognized"],
  [{ code: "unsupported_reasoning_effort" }, "unsupported_effort", "unknown", "unsupported_reasoning_effort"],
  [{ type: "model_not_found", param: "model" }, "model_unavailable", "model", "model_not_found"],
  [{ message: "Model 'fixture' is not available" }, "model_unavailable", "unknown", "unrecognized"],
  [{ message: "Unknown parameter: 'text.verbosity'", param: "text.verbosity" }, "unsupported_field", "text", "unrecognized"],
  [{ code: "unsupported_parameter", field: "input[0].role" }, "unsupported_field", "input", "unsupported_parameter"],
  [{ code: "unknown_parameter", field: "max_output_tokens" }, "unsupported_field", "max_output_tokens", "unknown_parameter"],
  [{ code: "invalid_client" }, "identity_rejected", "unknown", "invalid_client"],
  [{ message: "Client identity is not allowed" }, "identity_rejected", "unknown", "unrecognized"],
  [{ message: "Invalid access token" }, "authentication_rejected", "unknown", "unrecognized"],
  [{ code: "invalid_api_key" }, "authentication_rejected", "unknown", "invalid_api_key"],
  [{ type: "invalid_request_error", message: secret }, "unrecognized", "unknown", "invalid_request_error"],
  [{ message: "Unsupported tool type: custom. Invalid reasoning effort." }, "ambiguous", "unknown", "unrecognized"],
  [{ code: "invalid_client", message: "Model fixture is not found" }, "ambiguous", "unknown", "invalid_client"],
  [{ code: "model_not_found", type: "invalid_client" }, "ambiguous", "unknown", "ambiguous"],
  [{ param: "tools[0]", field: "model" }, "ambiguous", "unknown", "unrecognized"],
] as const) {
  test(`fixed hints: ${reason}/${field}/${code} ${JSON.stringify(error)}`, () => {
    assert.deepEqual(hints(error), { rejectionEnvelope: "nested_error", rejectionReason: reason, rejectionField: field, rejectionCode: code });
  });
}

test("only complete bounded JSON error objects receive structured hints", () => {
  assert.deepEqual(providerErrorHints(body({ code: "model_not_found", param: "model" })), {
    rejectionEnvelope: "top_level_error", rejectionReason: "model_unavailable", rejectionField: "model", rejectionCode: "model_not_found" });
  for (const value of [null, [], 17, "error", true, {}, { error: "model_not_found" }, { error: [], code: "model_not_found" }])
    assert.deepEqual(providerErrorHints(body(value)), unknown);
  for (const text of ["", "{bad", "<html>private</html>"])
    assert.deepEqual(providerErrorHints({ text, complete: true, truncated: false }), { ...unknown, rejectionEnvelope: "non_json" });
  for (const value of [{ ...body({ error: { code: "model_not_found" } }), complete: false },
    { ...body({ error: { code: "model_not_found" } }), truncated: true },
    { text: JSON.stringify({ error: { code: "model_not_found", message: "é".repeat(33000) } }), complete: true, truncated: false }])
    assert.deepEqual(providerErrorHints(value), { ...unknown, rejectionEnvelope: "incomplete" });
});

test("redaction covers every emitted hint, hostile fields, URLs, headers, codes and long messages", () => {
  for (const param of [secret, `tools[0].${secret}`, `https://${secret}.invalid/path?token=${secret}`,
    `tools[0].type\nAuthorization: Bearer ${secret}`, `tools.${"x".repeat(161)}`, "__proto__", "constructor"])
    for (const raw of [secret, "__proto__", "constructor", `invalid_client\n${secret}`, `https://${secret}.invalid`]) {
      const result = hints({ code: raw, type: raw, message: `${secret} ${raw}`, param, headers: { authorization: secret },
        device_code: secret, token: secret, url: `https://${secret}.invalid` });
      assert.ok(!JSON.stringify(result).includes(secret));
      assert.equal(result.rejectionCode, "unrecognized");
      assert.equal(result.rejectionReason, "unrecognized");
      const lines: string[] = [];
      logProviderFailure(createConsoleLogger("info", value => lines.push(value), false), "http_response", "unknown", 400, result);
      assert.equal(lines.length, 1); assert.ok(!lines[0]!.includes(secret));
    }
  assert.equal(hints({ message: `${"x".repeat(4097)} Unsupported tool type: custom` }).rejectionReason, "unrecognized");
});

test("unknown/getter-bearing diagnostic inputs never stringify or execute accessors", () => {
  const hostile = { toString() { assert.fail("coercion forbidden"); } };
  let accessed = false;
  const getters = Object.fromEntries(Object.keys(unknown).map(key => [key, { get() { accessed = true; throw new Error(secret); } }]));
  const crafted = Object.defineProperties({}, getters);
  const output: LogFields[] = [];
  for (const input of [crafted, Object.fromEntries(Object.keys(unknown).map(key => [key, hostile])),
    Object.fromEntries(Object.keys(unknown).map(key => [key, secret])), Object.create(unknown)]) {
    logProviderFailure({ log(_level, _event, value) { output.push(value!); } }, "http_response", "unknown", 400, input as ProviderErrorHints);
    assert.deepEqual(output.pop(), { eventType: "http_response", errorCode: "unknown", status: 400, ...unknown });
  }
  assert.equal(accessed, false);
  const craftedBody = Object.defineProperty({}, "text", { get() { accessed = true; throw new Error(secret); } });
  assert.deepEqual(providerErrorHints(craftedBody as never), { ...unknown, rejectionEnvelope: "incomplete" });
  assert.equal(accessed, false);
  const throwing = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error(secret); } });
  assert.deepEqual(providerErrorHints(throwing as never), unknown);
});
