/** Fabricated transport and credentials only; never invokes a network transport. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createConsoleLogger, type Logger, type LogFields } from "../../src/logger.js";
import { logProviderFailure } from "../../src/routing/provider-failure.js";
import { ProfileAuth } from "../../src/routing/profile-auth.js";
import { AttemptFailure, RoutedAttempts } from "../../src/routing/routed-attempt.js";
import { RoutingError, type AccessProfile, type Item, type WireProtocol } from "../../src/routing/routing-types.js";

const secret = "fabricated-private-token-code-prompt";
const profile: AccessProfile = {
  provider: "kimi", product: "kimi-code", region: "global", billing: "subscription",
  account: "fabricated", credential: { kind: "env", name: "FABRICATED_ONLY" },
};
const sse = (event: Item) => new Response(`data: ${JSON.stringify(event)}\n\n`, {
  headers: { "content-type": "text/event-stream", "x-fabricated-secret": secret },
});

async function attempt(protocol: WireProtocol, transport: typeof fetch, logger: Logger, signal = AbortSignal.timeout(2000), bodyOverride?: Item) {
  const auth = new ProfileAuth({ fixture: profile }, logger, { FABRICATED_ONLY: secret });
  const attempts = new RoutedAttempts(auth, logger, transport);
  const body: Item = protocol === "messages"
    ? { model: "fixture", max_tokens: 256, system: secret, messages: [{ role: "user", content: secret }] }
    : { model: "fixture", max_output_tokens: 256, instructions: secret, input: [{ role: "user", content: secret }] };
  const prepared = await attempts.prepare({
    profile, target: { profile: "fixture", model: "kimi-for-coding", effort: "high" },
    body: bodyOverride ?? body, protocol, conversation: "fabricated-conversation", signal, refreshes: new Set(),
  });
  try {
    for await (const _ of prepared.events) assert.fail("error must not yield a provider event");
  } finally {
    await prepared.cancel();
  }
}

for (const protocol of ["messages", "responses"] as const) {
  for (const origin of ["http_response", "sse_error"] as const) {
    test(`${protocol}: unclassified ${origin} retains failure semantics and logs only origin/category/actual HTTP status`, async t => {
      t.mock.method(globalThis, "fetch", () => assert.fail("real transport forbidden"));
      const lines: string[] = [], fields: LogFields[] = [];
      const consoleLogger = createConsoleLogger("info", line => lines.push(line), false);
      const logger: Logger = { log(level, event, value) {
        assert.equal(event, "route_provider_failure");
        fields.push(value!); consoleLogger.log(level, event, value);
      } };
      let calls = 0;
      const envelope = { type: secret, status: 400, message: secret,
        url: `https://${secret}.invalid`, headers: { authorization: secret }, device_code: secret };
      await assert.rejects(attempt(protocol, async () => {
        calls++;
        return origin === "http_response"
          ? Response.json({ error: envelope }, { status: 400, headers: { "x-fabricated-secret": secret } })
          : sse(protocol === "messages" ? { type: "error", error: envelope }
            : { type: "response.failed", response: { error: envelope } });
      }, logger), error => {
        assert.ok(error instanceof AttemptFailure);
        assert.equal(error.failure.kind, "unknown");
        assert.equal(error.failure.status, 400, "original classifier status remains intact");
        assert.equal(error.clientCode, "route_unknown"); assert.equal(error.clientStatus, 400);
        assert.deepEqual(error.failure.windows, []);
        assert.equal(error.failure.responseCommitted, false);
        return true;
      });
      assert.equal(calls, 1, "diagnostics must not retry");
      const hints = origin === "http_response" ? {
        rejectionEnvelope: "nested_error", rejectionReason: "unrecognized", rejectionField: "unknown", rejectionCode: "unrecognized",
      } : {};
      assert.deepEqual(fields, [{ eventType: origin, errorCode: "unknown", status: origin === "http_response" ? 400 : 200, ...hints }]);
      assert.equal(lines.length, 1); assert.ok(!lines[0]!.includes(secret));
      assert.equal(lines[0], `level=info event=route_provider_failure status=${origin === "http_response" ? 400 : 200} eventType=${origin} errorCode=unknown${origin === "http_response" ? " rejectionEnvelope=nested_error rejectionReason=unrecognized rejectionField=unknown rejectionCode=unrecognized" : ""}`);
    });
  }
}

test("diagnostic status is numeric/null without coercion; forged stages and categories cannot escape", () => {
  const fields: LogFields[] = [];
  const logger: Logger = { log(_level, _event, value) { fields.push(value!); } };
  const hostile = { toString() { assert.fail("must not coerce arbitrary input"); } };
  for (const value of [undefined, null, 0, 99, 600, 200.1, NaN, Infinity, "401", secret, hostile]) {
    logProviderFailure(logger, "sse_error", "unknown", value);
    assert.deepEqual(fields.pop(), { eventType: "sse_error", errorCode: "unknown", status: null });
  }
  for (const value of [100, 200, 401, 599]) {
    logProviderFailure(logger, "http_response", "permission", value);
    assert.deepEqual(fields.pop(), { eventType: "http_response", errorCode: "permission", status: value });
  }
  for (const value of [secret, hostile, "constructor", "__proto__"]) {
    logProviderFailure(logger, value as never, value as never, null);
    assert.deepEqual(fields.pop(), { eventType: "unknown", errorCode: "unknown", status: null });
  }
  const lines: string[] = [];
  logProviderFailure(createConsoleLogger("info", line => lines.push(line), false), "sse_error", "unknown", secret);
  assert.equal(lines[0], "level=info event=route_provider_failure status=null eventType=sse_error errorCode=unknown");
});

test("a broken diagnostic sink cannot replace the original provider failure", async () => {
  await assert.rejects(attempt("messages", async () => Response.json({}, { status: 403 }), {
    log() { throw new Error(secret); },
  }), error => error instanceof AttemptFailure && error.clientCode === "route_unknown" && error.clientStatus === 403);
});

test("malformed HTTP JSON still logs its HTTP outcome without retaining parser input", async () => {
  const lines: string[] = [];
  await assert.rejects(attempt("messages", async () => new Response(`{${secret}`, { status: 502 }),
    createConsoleLogger("info", line => lines.push(line), false)),
  error => error instanceof AttemptFailure && error.failure.kind === "unknown");
  assert.deepEqual(lines, ["level=info event=route_provider_failure status=502 eventType=http_response errorCode=unknown"]);
});

test("SSE envelope status cannot impersonate the HTTP response status", async () => {
  for (const status of [undefined, null, "403", secret, -1, 0, 999]) {
    const fields: LogFields[] = [];
    await assert.rejects(attempt("messages", async () => sse({ type: "error", error: { status, message: secret } }), {
      log(_level, _event, value) { fields.push(value!); },
    }), error => error instanceof AttemptFailure && error.failure.kind === "unknown");
    assert.deepEqual(fields, [{ eventType: "sse_error", errorCode: "unknown", status: 200 }]);
  }
});

test("transport, abort and malformed SSE keep their existing errors without a fabricated HTTP failure diagnostic", async () => {
  for (const scenario of ["transport", "abort", "invalid_json", "invalid_schema"] as const) {
    const lines: string[] = [];
    const controller = new AbortController();
    await assert.rejects(attempt("messages", async () => {
      if (scenario === "transport") throw new Error(secret);
      if (scenario === "abort") {
        controller.abort(new Error(secret));
        throw new Error(secret);
      }
      return scenario === "invalid_json"
        ? new Response(`data: {${secret}\n\n`, { headers: { "content-type": "text/event-stream" } })
        : sse({ error: { message: secret } });
    }, createConsoleLogger("info", line => lines.push(line), false), controller.signal), error => {
      if (scenario === "transport") return error instanceof AttemptFailure && error.failure.kind === "transport";
      return error instanceof RoutingError && error.code === (scenario === "abort" ? "request_cancelled" : "invalid_provider_event");
    });
    assert.deepEqual(lines, []);
  }
});

test("400 hints leave exact caller tools/history/request bytes, classifier and quota observations intact", async t => {
  t.mock.method(globalThis, "fetch", () => assert.fail("real transport forbidden"));
  const requests: string[] = [], failures: unknown[] = [], observations: unknown[] = [], fields: LogFields[] = [];
  const body: Item = { model: "fixture", instructions: secret, input: [{ role: "user", content: secret }],
    tools: [{ type: "custom", name: "fixture", format: { type: "grammar", syntax: "lark", definition: secret } },
      { type: "namespace", name: "fixture", tools: [{ type: "function", name: "fixture", parameters: { type: "object" } }] }],
    reasoning: { effort: "high" }, text: { verbosity: "low" }, parallel_tool_calls: true };
  const original = structuredClone(body);
  for (const capture of [false, true]) {
    let calls = 0;
    const logger: Logger = { log(_level, _event, value) { if (capture) fields.push(value!); },
      recordLimit(value) { observations.push(value); } };
    await assert.rejects(attempt("responses", async (_url, options) => {
      calls++; requests.push(String(options?.body));
      return Response.json({ error: { code: "invalid_value", param: "tools[0].type",
        message: `Invalid value: 'custom'. ${secret}` } }, { status: 400 });
    }, logger, undefined, body), error => {
      assert.ok(error instanceof AttemptFailure);
      failures.push(error.failure);
      assert.equal(error.clientCode, "route_unknown"); assert.equal(error.clientStatus, 400);
      return true;
    });
    assert.equal(calls, 1);
  }
  assert.equal(requests[0], requests[1]);
  assert.deepEqual(JSON.parse(requests[0]!).tools, body["tools"]);
  assert.deepEqual(JSON.parse(requests[0]!).input, body["input"]);
  assert.deepEqual(body, original);
  assert.deepEqual(failures[0], failures[1]);
  assert.equal((failures[0] as { kind: string }).kind, "unknown");
  assert.deepEqual((failures[0] as { windows: unknown[] }).windows, []);
  assert.equal(observations.length, 2, "existing sanitized limit diagnostics still run once per response");
  const withoutTime = (value: unknown) => {
    const { observedAt: _time, ...rest } = value as Record<string, unknown>;
    return rest;
  };
  assert.deepEqual(withoutTime(observations[0]), withoutTime(observations[1]));
  assert.deepEqual(fields, [{ eventType: "http_response", errorCode: "unknown", status: 400,
    rejectionEnvelope: "nested_error", rejectionReason: "unsupported_tool_type", rejectionField: "tools", rejectionCode: "invalid_value" }]);
});

test("400 malformed and oversized bodies keep unknown failures and expose only safe envelope hints", async () => {
  for (const [text, envelope] of [[`{${secret}`, "non_json"], [`<html>${secret}</html>`, "non_json"],
    ["[]", "unrecognized"], [JSON.stringify({ error: { code: "invalid_client", message: secret.repeat(2000) } }), "incomplete"]]) {
    const fields: LogFields[] = [];
    await assert.rejects(attempt("responses", async () => new Response(text, { status: 400 }), {
      log(_level, _event, value) { fields.push(value!); },
    }), error => error instanceof AttemptFailure && error.clientCode === "route_unknown" && error.clientStatus === 400);
    assert.deepEqual(fields, [{ eventType: "http_response", errorCode: "unknown", status: 400,
      rejectionEnvelope: envelope, rejectionReason: "unrecognized", rejectionField: "unknown", rejectionCode: "unrecognized" }]);
  }
});

test("body transport failure after headers retains existing error and makes no fabricated rejection claim", async () => {
  const error = new Error(secret), fields: LogFields[] = [];
  await assert.rejects(attempt("responses", async () => new Response(new ReadableStream({
    start(controller) { controller.error(error); },
  }), { status: 400 }), { log(_level, _event, value) { fields.push(value!); } }), error);
  assert.deepEqual(fields, []);
});
