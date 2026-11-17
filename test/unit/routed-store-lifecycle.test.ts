import { nativeCredential } from "../fixtures/native-profile.js";
/** Synthetic store bounds and upstreams; no live inference or credentials. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ClaudeCache } from "../../src/claude-cache.js";
import { loadConfig } from "../../src/config.js";
import { noopLogger } from "../../src/logger.js";
import { ContinuationStore, type Continuation } from "../../src/routing/continuation-store.js";
import { StagedCache } from "../../src/routing/replay-cache.js";
import { SharedRouting } from "../../src/routing/shared-routing.js";
import { RoutingError, type Item } from "../../src/routing/routing-types.js";

const state: Continuation = {
  conversation: "conversation", route: "work", request: { input: "question" },
  output: [], owner: "owner", protocol: "responses", scope: "single-target",
};
const lost = (error: unknown) => error instanceof RoutingError &&
  error.code === "continuation_state_lost" && error.status === 409;

function router(fetchImpl: typeof fetch, nativeMessages = false): SharedRouting {
  const loaded = loadConfig({ configPath: "/synthetic/config.json", env: {}, readFile: () => JSON.stringify({
    configVersion: 2,
    accessProfiles: { api: { provider: nativeMessages ? "claude" : "codex",
      product: nativeMessages ? "claude-code" : "chatgpt-codex", billing: "subscription", account: "synthetic",
      credential: nativeCredential(nativeMessages ? "claude" : "codex", "synthetic-key") },
      ...(nativeMessages ? { other: { provider: "claude", product: "claude-code", billing: "subscription", account: "other",
        credential: nativeCredential("claude", "synthetic-other") } } : {}) },
    routes: { work: { clients: ["codex", "claude-code"], primary: { profile: "api",
      model: nativeMessages ? "claude-sonnet-5-5" : "gpt-6-sol", effort: "high" } },
      ...(nativeMessages ? { other: { clients: ["claude-code"], primary: {
        profile: "other", model: "claude-sonnet-5-5", effort: "high" } } } : {}) },
  }) });
  if (!loaded.ok) assert.fail(loaded.error.message);
  return new SharedRouting(loaded.value.config, noopLogger, undefined, fetchImpl);
}
async function collect(events: AsyncIterable<Item>): Promise<Item[]> {
  const values: Item[] = [];
  for await (const event of events) values.push(event);
  return values;
}

describe("routed continuation lifetime", () => {
  it("reclaims completed LRU entries and reports lost state for an evicted response", () => {
    const store = new ContinuationStore({ maxEntries: 2, maxBytes: 4096 });
    const oldest = store.put(state), recent = store.put(state);
    assert.deepEqual(store.get(oldest, undefined, "work", "responses"), state);
    const next = store.put(state);
    assert.throws(() => store.get(recent, undefined, "work", "responses"), lost);
    assert.throws(() => store.route(recent), lost);
    assert.deepEqual(store.get(next, undefined, "work", "responses"), state);
    assert.deepEqual(store.get(oldest, undefined, "work", "responses"), state);
  });

  it("reclaims byte capacity without altering an active history copy", () => {
    const bytes = Buffer.byteLength(JSON.stringify(state));
    const store = new ContinuationStore({ maxEntries: 10, maxBytes: bytes * 2 - 1 });
    const prior = store.put(state);
    const active = store.get(prior, undefined, "work", "responses");
    const next = store.put({ ...state, output: [{ type: "message" }] });
    assert.throws(() => store.get(prior, undefined, "work", "responses"), lost);
    assert.deepEqual(active, state);
    assert.equal(store.route(next), "work");
  });

  it("does not evict history for an abandoned publication or an oversized response", () => {
    const store = new ContinuationStore({ maxEntries: 1, maxBytes: 512 });
    const prior = store.put(state);
    store.preparePut(state, "unpublished");
    assert.throws(() => store.preparePut({ ...state, output: [{ text: "x".repeat(512) }] }, "large"),
      (error: unknown) => error instanceof RoutingError && error.code === "continuation_too_large" && error.status === 413);
    assert.deepEqual(store.get(prior, undefined, "work", "responses"), state);
    assert.throws(() => store.get("unpublished", undefined, "work", "responses"), lost);
  });

  it("checks known continuation bytes before provider inference", async () => {
    let calls = 0;
    const routing = router(async () => { calls++; throw new Error("provider must not run"); });
    try {
      const body = { model: "work", input: "x".repeat(32 * 1024 * 1024 - 160), stream: false };
      assert(Buffer.byteLength(JSON.stringify(body)) < 32 * 1024 * 1024);
      await assert.rejects(collect(routing.events(body, "codex", "work", new AbortController().signal)),
        (error: unknown) => error instanceof RoutingError && error.code === "continuation_too_large" && error.status === 413);
      assert.equal(calls, 0);
    } finally { routing.close(); }
  });
});

describe("routed replay lifetime", () => {
  it("finishes new inference after both process-wide stores reach their entry limits", async () => {
    let calls = 0;
    const routing = router(async () => {
      const output = Array.from({ length: calls++ === 0 ? 2048 : 1 }, (_, index) => ({
        type: "reasoning", encrypted_content: `${calls}:${index}`, summary: [],
      }));
      return new Response([
        { type: "response.created", response: { id: "upstream", status: "in_progress", output: [] } },
        { type: "response.completed", response: { id: "upstream", status: "completed", output } },
      ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
      { headers: { "content-type": "text/event-stream" } });
    });
    const oldest = routing.continuations.put(state);
    for (let index = 1; index < 2048; index++) routing.continuations.put(state);
    try {
      for (let index = 0; index < 2; index++) {
        const events = await collect(routing.events({ model: "work", input: "question", stream: false },
          "codex", "work", new AbortController().signal));
        assert.equal(events.at(-1)?.type, "response.completed");
      }
      assert.equal(calls, 2);
      assert.throws(() => routing.continuations.route(oldest), lost);
    } finally { routing.close(); }
  });

  it("reimports evicted Claude Code history in the same scope and rejects another scope before inference", async () => {
    let calls = 0;
    const requests: Item[] = [];
    const routing = router(async (url, init) => {
      assert.equal(String(url), "https://api.anthropic.com/v1/messages");
      requests.push(JSON.parse(String(init?.body)) as Item);
      calls++;
      const events: Item[] = [{ type: "message_start", message: {
        id: `message-${calls}`, type: "message", role: "assistant", content: [],
        model: "claude-sonnet-5-5", usage: { input_tokens: 1, output_tokens: 0 },
      } }];
      for (let index = 0; index < (calls < 3 ? 1024 : 1); index++) {
        events.push({ type: "content_block_start", index, content_block: {
          type: "thinking", thinking: "synthetic", signature: `${calls}:${index}`,
        } }, { type: "content_block_stop", index });
      }
      events.push({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
        { type: "message_stop" });
      return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
        { headers: { "content-type": "text/event-stream" } });
    }, true);
    const body = { model: "work", max_tokens: 16000, messages: [{ role: "user", content: "question" }] };
    try {
      for (let index = 0; index < 3; index++) {
        const events = await collect(routing.events(body, "claude-code", "work", new AbortController().signal));
        assert.equal(events.at(-1)?.type, "message_stop");
      }
      const followup = { ...body, messages: [
        ...body.messages, { role: "assistant", content: [{ type: "thinking", thinking: "synthetic", signature: "1:0" }] },
        { role: "user", content: "follow up" },
      ] };
      // An LRU miss has the same import contract as a fresh process at the Anthropic origin.
      const replay = await collect(routing.events(followup, "claude-code", "work", new AbortController().signal));
      assert.equal(replay.at(-1)?.type, "message_stop");
      assert.equal(calls, 4, "same-scope history must reach Anthropic for validation");
      assert.deepEqual(requests[3]!.messages, followup.messages);
      await assert.rejects(collect(routing.events({ ...followup, model: "other" },
        "claude-code", "other", new AbortController().signal)),
      (error: unknown) => error instanceof RoutingError && error.code === "foreign_opaque_state" && error.status === 409);
      assert.equal(calls, 4, "known other-scope history must not reach inference");
    } finally { routing.close(); }
  });

  it("publishes a bounded batch after reclaiming completed LRU entries", () => {
    const shared = new ClaudeCache({ maxEntries: 2, maxBytes: 4096 });
    shared.put("adapted", "oldest", true);
    shared.put("adapted", "recent", true);
    shared.get("adapted", "oldest");
    const stage = new StagedCache(shared);
    stage.put("adapted", "new", true);
    stage.commit();
    assert.equal(shared.size, 2);
    assert.equal(shared.get("adapted", "recent"), undefined);
    assert.equal(shared.get("adapted", "oldest"), true);
    assert.equal(shared.get("adapted", "new"), true);
  });

  it("reclaims shared byte capacity without exceeding the replay budget", () => {
    const shared = new ClaudeCache({ maxEntries: 10, maxBytes: 80 });
    const prior = "a".repeat(40), next = "b".repeat(40);
    shared.put("adapted", prior, true);
    const stage = new StagedCache(shared);
    stage.put("adapted", next, true);
    stage.commit();
    assert.equal(shared.get("adapted", prior), undefined);
    assert.equal(shared.get("adapted", next), true);
    assert.equal(shared.size, 1);
    assert.equal(shared.byteSize, Buffer.byteLength(`adapted:${next}`) + Buffer.byteLength("true"));
    assert(shared.byteSize <= 80);
  });

  it("retains all shared history when a batch alone exceeds the replay partition", () => {
    const shared = new ClaudeCache({ maxEntries: 2, maxBytes: 80 });
    shared.put("adapted", "prior", true);
    const bytes = shared.byteSize;
    const stage = new StagedCache(shared);
    stage.put("snapshot", "large", { request: { text: "x".repeat(80) }, input: [] });
    assert.throws(() => stage.commit(),
      (error: unknown) => error instanceof RoutingError && error.code === "continuation_store_full" && error.status === 503);
    assert.equal(shared.size, 1);
    assert.equal(shared.byteSize, bytes);
    assert.equal(shared.get("adapted", "prior"), true);
    assert.equal(shared.get("snapshot", "large"), undefined);
  });

  it("keeps active replay reads local when another completed response evicts their shared entry", () => {
    const shared = new ClaudeCache({ maxEntries: 1, maxBytes: 4096 });
    shared.put("replay", "prior", { content: [], output: [] });
    const active = new StagedCache(shared);
    assert.deepEqual(active.get("replay", "prior"), { content: [], output: [] });
    shared.put("adapted", "next", true);
    assert.equal(shared.get("replay", "prior"), undefined);
    assert.deepEqual(active.get("replay", "prior"), { content: [], output: [] });
  });

  it("maps a real strict-cache commit failure to 503 and keeps all shared state unchanged", () => {
    const shared = new ClaudeCache({ maxEntries: 1, maxBytes: 4096 }, true);
    const original = { request: { input: "original" }, input: [] };
    shared.put("snapshot", "prior", original);
    const bytes = shared.byteSize;
    const stage = new StagedCache(shared);
    stage.put("snapshot", "prior", { request: {}, input: [] });
    stage.put("adapted", "next", true);
    assert.throws(() => stage.commit(),
      (error: unknown) => error instanceof RoutingError && error.code === "continuation_store_full" && error.status === 503);
    assert.equal(shared.size, 1);
    assert.equal(shared.byteSize, bytes);
    assert.deepEqual(shared.get("snapshot", "prior"), original);
    assert.equal(shared.get("adapted", "next"), undefined);
  });

  it("keeps an uncommitted attempt out of shared replay state", () => {
    const shared = new ClaudeCache({ maxEntries: 2, maxBytes: 4096 }, true);
    const stage = new StagedCache(shared);
    stage.put("replay", "abandoned", { content: [], output: [] });
    assert.deepEqual(stage.get("replay", "abandoned"), { content: [], output: [] });
    assert.equal(shared.size, 0);
    assert.equal(shared.byteSize, 0);
    assert.equal(shared.get("replay", "abandoned"), undefined);
  });

  it("maps local write exhaustion to 503 and releases the active reservation", () => {
    const shared = new ClaudeCache(), stage = new StagedCache(shared);
    stage.reserveSnapshot("claim", { request: { owner: "original" }, input: [] });
    stage.preflight();
    assert.equal(shared.size, 1);
    for (let index = 1; index < 2048; index++) stage.put("adapted", `local-${index}`, true);
    assert.throws(() => stage.put("adapted", "overflow", true),
      (error: unknown) => error instanceof RoutingError && error.code === "continuation_store_full" && error.status === 503);
    stage.discard();
    assert.equal(shared.size, 0);
    assert.equal(shared.byteSize, 0);
  });

  it("maps active-history read exhaustion to the same 503 without a shared write", () => {
    const shared = new ClaudeCache(), stage = new StagedCache(shared);
    shared.put("adapted", "prior", true);
    const bytes = shared.byteSize;
    for (let index = 0; index < 2048; index++) stage.put("adapted", `local-${index}`, true);
    assert.throws(() => stage.get("adapted", "prior"),
      (error: unknown) => error instanceof RoutingError && error.code === "continuation_store_full" && error.status === 503);
    stage.discard();
    assert.equal(shared.size, 1);
    assert.equal(shared.byteSize, bytes);
    assert.equal(shared.get("adapted", "prior"), true);
  });

  for (const operation of ["put", "reserveSnapshot", "retainSnapshot", "commit"] as const) {
    it(`refuses ${operation} after discard without changing shared state`, () => {
      const shared = new ClaudeCache(), stage = new StagedCache(shared);
      shared.put("adapted", "prior", true);
      const bytes = shared.byteSize;
      stage.reserveSnapshot("claim", { request: { owner: "original" }, input: [] });
      stage.preflight();
      stage.discard();
      const write = () => {
        if (operation === "put") stage.put("snapshot", "after-discard", { request: {}, input: [] });
        else if (operation === "commit") stage.commit();
        else stage[operation]("after-discard", { request: {}, input: [] });
      };
      assert.throws(write, (error: unknown) => error instanceof RoutingError &&
        error.code === "request_cancelled" && error.status === 499);
      assert.equal(shared.size, 1);
      assert.equal(shared.byteSize, bytes);
      assert.equal(shared.get("adapted", "prior"), true);
      assert.equal(shared.get("snapshot", "claim"), undefined);
      assert.equal(shared.get("snapshot", "after-discard"), undefined);
    });
  }

  it("checks a strict shared budget before inference without publishing or evicting", () => {
    const shared = new ClaudeCache({ maxEntries: 1, maxBytes: 4096 }, true);
    shared.put("adapted", "prior", true);
    const stage = new StagedCache(shared);
    stage.put("adapted", "next", true);
    assert.throws(() => stage.preflight(),
      (error: unknown) => error instanceof RoutingError && error.code === "continuation_store_full" && error.status === 503);
    assert.equal(shared.size, 1);
    assert.equal(shared.get("adapted", "prior"), true);
    assert.equal(shared.get("adapted", "next"), undefined);
  });
});
