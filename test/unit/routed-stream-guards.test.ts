import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ClaudeCache } from "../../src/claude-cache.js";
import { loadConfig } from "../../src/config.js";
import { noopLogger } from "../../src/logger.js";
import { RoutingError, type AccessProfile, type Item, type OriginatingClient } from "../../src/routing/routing-types.js";
import { SharedRouting } from "../../src/routing/shared-routing.js";
import { nativeCredential } from "../fixtures/native-profile.js";

const codexModel = "gpt-6.2-sol";
const claudeModel = "claude-sonnet-5";
const responsesRequest = { model: "work", input: "synthetic", stream: true };
const messagesRequest = {
  model: "work", max_tokens: 64, stream: true,
  messages: [{ role: "user", content: "synthetic" }],
};
const sseHeaders = { "content-type": "text/event-stream" };
const responseIdentity = { id: "resp_fixture", model: codexModel };
const opening = {
  type: "response.created",
  response: { ...responseIdentity, status: "in_progress", output: [] },
};
const terminal = (output: Item[]) => ({
  type: "response.completed",
  response: { ...responseIdentity, status: "completed", output, usage: { input_tokens: 1, output_tokens: 1 } },
});
const sseData = (events: Item[]) => events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("");

function codexReply(output: Item[] = []) {
  return new Response(sseData([opening, terminal(output)]), { headers: sseHeaders });
}

function claudeReply() {
  return new Response(sseData([
    { type: "message_start", message: {
      id: "msg_fixture", type: "message", role: "assistant", model: claudeModel,
      content: [], usage: { input_tokens: 1, output_tokens: 0 },
    } },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ]), { headers: sseHeaders });
}

function routeFixture(t: TestContext, fetchImpl: typeof fetch, provider: "codex" | "claude" = "codex") {
  const profile: AccessProfile = {
    provider,
    product: provider === "codex" ? "chatgpt-codex" : "claude-code",
    billing: "subscription",
    account: "synthetic",
    credential: nativeCredential(provider, "fixture-original"),
  };
  const result = loadConfig({ env: {}, configPath: "/synthetic/config.json", readFile: () => JSON.stringify({
    configVersion: 2,
    accessProfiles: { fixture: profile },
    routes: { work: {
      clients: provider === "codex" ? ["codex", "claude-code"] : ["claude-code"],
      primary: { profile: "fixture", model: provider === "codex" ? codexModel : claudeModel, effort: "high" },
    } },
  }) });
  assert.ok(result.ok, result.ok ? undefined : result.error.message);
  const router = new SharedRouting(result.value.config, noopLogger, undefined, fetchImpl);
  t.after(() => router.close());
  return router;
}

function routedEvents(router: SharedRouting, client: OriginatingClient, body: Item, signal = new AbortController().signal) {
  const action = router.actions.create(client, "stream-guard-fixture");
  return router.events(body, client, "work", signal, router.actions.context(action.id, client));
}

async function recordTypes(events: AsyncIterable<Item>, seen: unknown[] = []) {
  for await (const event of events) {
    assert.ok(seen.length < 32, "unexpected extra events from the fixture");
    seen.push(event.type);
  }
  return seen;
}

// src/routing/routed-attempt.ts:143-147,178-193 — the retry uses the refreshed credential.
for (const { client, provider, body, reply, end } of [
  { client: "codex", provider: "codex", body: responsesRequest, reply: codexReply, end: "response.completed" },
  { client: "claude-code", provider: "claude", body: messagesRequest, reply: claudeReply, end: "message_stop" },
] as const) {
  it(`${client}: sends the refreshed bearer and the same body after a 401`, async t => {
    const sends: { bearer: string | null; body: RequestInit["body"] }[] = [];
    const router = routeFixture(t, async (_url, init) => {
      sends.push({ bearer: new Headers(init?.headers).get("authorization"), body: init?.body });
      return sends.length === 1 ? new Response("unauthorized", { status: 401 }) : reply();
    }, provider);
    const auth = router.attempts.auth;
    const refresh = t.mock.method(auth, "refresh", async (id: string, signal: AbortSignal) => {
      const original = await auth.get(id, signal);
      return { ...original, authHeaders: { ...original.authHeaders, authorization: "Bearer fixture-refreshed" } };
    });

    const types = await recordTypes(routedEvents(router, client, body));

    assert.equal(types.at(-1), end);
    assert.equal(refresh.mock.callCount(), 1);
    assert.deepEqual(sends.map(send => send.bearer), ["Bearer fixture-original", "Bearer fixture-refreshed"]);
    assert.equal(typeof sends[0]?.body, "string");
    assert.equal(sends[1]?.body, sends[0]?.body);
  });
}

const tool = {
  type: "function_call", id: "fc_fixture", call_id: "call_fixture", name: "Read",
  arguments: '{"path":"fixture.txt"}', status: "completed",
};

// src/routing/shared-routing.ts:398-414 — preflight continuation before the replay commit.
for (const stream of [true, false]) {
  it(`withholds tool events and replay state if continuation preflight fails (stream=${stream})`, async t => {
    const router = routeFixture(t, async () => new Response(sseData([
      opening,
      { type: "response.function_call_arguments.done", item_id: tool.id, output_index: 0, arguments: tool.arguments },
      { type: "response.output_item.done", output_index: 0, item: tool },
      terminal([tool]),
    ]), { headers: sseHeaders }));
    const cache = new ClaudeCache();
    const existing = { request: {}, input: [] };
    cache.put("snapshot", "existing", existing);
    Object.defineProperty(router.attempts, "replay", { value: cache });
    const writes = t.mock.method(cache, "putBatch");
    const prepare = router.continuations.preparePut.bind(router.continuations);
    const preflight = t.mock.method(router.continuations, "preparePut", (...args: Parameters<typeof prepare>) => {
      if (args[0].output.length > 0) throw new RoutingError("continuation_store_full", 503);
      return prepare(...args);
    });
    const seen: unknown[] = [];

    await assert.rejects(recordTypes(routedEvents(router, "codex", { ...responsesRequest, stream }), seen),
      { code: "continuation_store_full", status: 503 });

    assert.deepEqual(preflight.mock.calls.map(({ arguments: [state] }) => state.output), [[], [tool]]);
    assert.deepEqual(seen, stream ? ["response.created"] : []);
    assert.equal(writes.mock.callCount(), 0);
    assert.equal(cache.size, 1);
    assert.deepEqual(cache.get("snapshot", "existing"), existing);
  });
}

// src/routing/routed-attempt.ts:296-315 — cleanup has a 100 ms limit even if cancel stays pending.
it("reports request cancellation even if the pending Codex read and body cancel never settle", async t => {
  const caller = new AbortController();
  const timer = new AbortController();
  let signalSecondPull: () => void;
  const secondPull = new Promise<void>(resolve => { signalSecondPull = resolve; });
  const pending = new Promise<void>(() => {});
  let pulls = 0;
  let cancels = 0;
  const router = routeFixture(t, async () => new Response(new ReadableStream<Uint8Array>({
    pull(stream) {
      if (++pulls === 1) stream.enqueue(Buffer.from(sseData([opening])));
      else { signalSecondPull(); return pending; }
    },
    cancel() { cancels++; return pending; },
  }, { highWaterMark: 0 }), { headers: sseHeaders }));
  const events = routedEvents(router, "codex", responsesRequest, caller.signal);
  const deadline = delay(2000, undefined, { signal: timer.signal }).then(() => assert.fail("Codex cancellation did not settle within 2 s"));
  try {
    const first = await Promise.race([events.next(), deadline]);
    assert.equal(first.value?.type, "response.created");
    await Promise.race([
      Promise.all([
        assert.rejects(events.next(), { code: "request_cancelled", status: 499 }),
        secondPull.then(() => caller.abort()),
      ]),
      deadline,
    ]);
    assert.equal(cancels, 1);
  } finally {
    caller.abort();
    timer.abort();
  }
});

// src/routing/provider-stream.ts:133,162,201 — reject unsupported events and duplicate starts.
for (const [badEvent, code] of [
  [opening, "duplicate_provider_start"],
  [{ type: "response.unknown" }, "unsupported_provider_event"],
] as const) {
  it(`rejects ${code} with 502 and publishes no aggregate`, async t => {
    const router = routeFixture(t, async () => new Response(sseData([
      opening, badEvent, terminal([]),
    ]), { headers: sseHeaders }));
    const seen: unknown[] = [];

    await assert.rejects(recordTypes(routedEvents(router, "codex", { ...responsesRequest, stream: false }), seen),
      { code, status: 502 });
    assert.deepEqual(seen, []);
  });
}

// src/routing/provider-stream.ts:95-102 — skip the reserved event name even if the record has data.
it("skips a reserved comment event with data and emits one Responses completion", async t => {
  const wire = sseData([opening]) +
    'event: __subswitch_comment\ndata: {"type":"response.unknown"}\n\n' +
    sseData([terminal([])]);
  const router = routeFixture(t, async () => new Response(wire, { headers: sseHeaders }));

  const seen = await recordTypes(routedEvents(router, "codex", responsesRequest));

  assert.deepEqual(seen, ["response.created", "response.completed"]);
});

// src/routing/provider-stream.ts:365-375 — validate terminal function arguments before conversion.
it("rejects malformed Codex terminal arguments without a Messages stop", async t => {
  const router = routeFixture(t, async () => codexReply([{ ...tool, arguments: '{"path":' }]));
  const seen: unknown[] = [];

  await assert.rejects(recordTypes(routedEvents(router, "claude-code", messagesRequest), seen),
    { code: "invalid_provider_tool", status: 502 });
  assert.deepEqual(seen, ["message_start"]);
});
