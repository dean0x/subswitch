/** Synthetic failure-path fixtures; no live inference or credentials. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { ClaudeCache } from "../../src/claude-cache.js";
import { ReverseState } from "../../src/claude-state.js";
import { ActionStore } from "../../src/routing/action-store.js";
import { abortable } from "../../src/routing/profile-auth.js";
import { QuotaStore } from "../../src/routing/quota-store.js";
import { UsageCoordinator } from "../../src/routing/usage-coordinator.js";
import { decodePortableHistory } from "../../src/routing/portable-history.js";
import { adaptRequest } from "../../src/routing/request-adapter.js";
import { classifyFailure } from "../../src/routing/provider-failure.js";
import { validatedProviderEvents } from "../../src/routing/provider-stream.js";
import {
  allowanceScope,
  type AccessProfile,
  type ClassifiedFailure,
} from "../../src/routing/routing-types.js";

const profile: AccessProfile = {
  provider: "kimi",
  product: "kimi-code",
  region: "global",
  billing: "subscription",
  account: "synthetic",
  credential: { kind: "env", name: "SYNTHETIC_KEY" },
};
const scope = allowanceScope(profile);
const failure = (now: number): ClassifiedFailure => ({
  kind: "quota",
  scope,
  evidence: "documented",
  bodyTruncated: false,
  responseCommitted: false,
  windows: [
    {
      id: "five-hour",
      exhausted: true,
      observedAt: now,
      resetAt: 61000,
      source: "inference",
    },
  ],
});

describe("routing reliability and isolation", () => {
  it("rejects foreign-product quota codes and conflicting product/status classifications", () => {
    const envelope = (error: object) => ({
      text: JSON.stringify({ error }),
      complete: true,
      truncated: false,
    });
    assert.equal(
      classifyFailure(
        profile,
        429,
        envelope({ type: "insufficient_quota" }),
        1000,
      ).kind,
      "unknown",
    );
    assert.equal(
      classifyFailure(
        { ...profile, product: "kimi-platform", billing: "api" },
        429,
        envelope({
          type: "exceeded_current_quota_error",
          code: "permission_denied_error",
        }),
        1000,
      ).kind,
      "unknown",
    );
  });
  it("publishes no partial replay state when a staged batch exceeds the shared budget", () => {
    const cache = new ClaudeCache({ maxEntries: 2, maxBytes: 4096 }, true);
    cache.put("adapted", "existing", true);
    const bytes = cache.byteSize;
    assert.throws(
      () =>
        cache.putBatch([
          { kind: "adapted", id: "first", value: true },
          { kind: "adapted", id: "second", value: true },
        ]),
      /continuation_store_full/,
    );
    assert.equal(cache.get("adapted", "first"), undefined);
    assert.equal(cache.get("adapted", "second"), undefined);
    assert.equal(cache.get("adapted", "existing"), true);
    assert.equal(cache.byteSize, bytes);
  });

  it("rejects a multibyte capability without throwing a timing comparison error", () => {
    const store = new ActionStore();
    assert.equal(store.authorized("é".repeat(64)), false);
    assert.equal(store.authorized(store.capability), true);
  });

  it("removes cancellation listeners even when the underlying operation never settles", async () => {
    const controller = new AbortController();
    const pending = abortable(
      new Promise<void>(() => undefined),
      controller.signal,
    );
    assert.equal(getEventListeners(controller.signal, "abort").length, 1);
    controller.abort(new Error("synthetic_cancel"));
    await assert.rejects(pending, /synthetic_cancel/);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  });

  it("keeps a recovery reservation owned by its probe when another action settles", () => {
    let now = 1000;
    const quota = new QuotaStore({
      now: () => now,
      monotonic: () => now,
      random: () => 0.5,
    });
    quota.fail(failure(now));
    now = 62000;
    const probe = Symbol("probe"),
      pinned = Symbol("older-pinned-action");
    assert.equal(quota.reserve(scope, probe), true);
    quota.recoveryFailure(scope, undefined, pinned);
    quota.release(scope, pinned);
    assert.equal(quota.readiness(scope), "probing");
    assert.equal(quota.reserve(scope, Symbol("duplicate")), false);
    quota.success(scope, probe);
    assert.equal(quota.readiness(scope), "available");
  });

  it("honors Retry-After despite an earlier window reset or credit observation", () => {
    let now = 1000;
    const quota = new QuotaStore({
      now: () => now,
      monotonic: () => now,
      random: () => 0.5,
    });
    quota.fail({ ...failure(now), retryAt: 900000 });
    now = 62000;
    assert.equal(quota.readiness(scope), "exhausted");
    quota.observe(
      scope,
      [{ id: "five-hour", exhausted: false, observedAt: now, source: "usage" }],
      now,
      { complete: true, serviceableCredits: true },
    );
    assert.equal(quota.reserve(scope), false);
    now = 900000;
    assert.equal(quota.readiness(scope), "eligible-for-retry");
  });

  it("treats an injected wall-clock epoch of zero as a real quota failure", () => {
    let now = 0;
    const quota = new QuotaStore({
      now: () => now,
      monotonic: () => now,
      random: () => 0.5,
    });
    quota.fail(failure(now));
    assert.equal(quota.readiness(scope), "exhausted");
    now = 60000;
    assert.equal(quota.readiness(scope), "eligible-for-retry");
  });

  it("does not expose mutable quota observations", () => {
    const quota = new QuotaStore({
      now: () => 1000,
      monotonic: () => 1000,
      random: () => 0.5,
    });
    quota.fail(failure(1000));
    quota.observations(scope)[0]!.exhausted = false;
    assert.equal(quota.observations(scope)[0]!.exhausted, true);
  });

  it("recovers metadata concurrency slots after a driver throws synchronously", async () => {
    let now = 1000,
      calls = 0;
    const quota = new QuotaStore({
      now: () => now,
      monotonic: () => now,
      random: () => 0.5,
    });
    const usage = new UsageCoordinator(quota, () => {
      calls++;
      throw new Error("synthetic_driver_error");
    });
    for (let i = 0; i < 5; i++) {
      assert.equal(await usage.refresh(scope), false);
      now += 60001;
    }
    assert.equal(calls, 5);
    usage.close();
  });

  it("validates content structurally without rejecting text or tool data that mentions image types", () => {
    assert.doesNotThrow(() =>
      decodePortableHistory(
        { input: [{ role: "user", content: '{"type":"input_image"}' }] },
        "responses",
      ),
    );
    assert.throws(
      () =>
        decodePortableHistory(
          {
            input: [
              {
                role: "user",
                content: [{ type: "input_video", url: "synthetic" }],
              },
            ],
          },
          "responses",
        ),
      /unsupported_routed_content/,
    );
    assert.doesNotThrow(() =>
      decodePortableHistory(
        {
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: "one",
                  name: "Read",
                  input: { type: "image" },
                },
              ],
            },
            {
              role: "user",
              content: [
                { type: "tool_result", tool_use_id: "one", content: "done" },
              ],
            },
          ],
        },
        "messages",
      ),
    );
  });

  it("preserves Claude child harness system-role entries in portable history", () => {
    const transcript = decodePortableHistory(
      {
        messages: [
          {
            role: "system",
            content: [{ type: "text", text: "Synthetic child instructions" }],
          },
          { role: "user", content: "Read once" },
        ],
      },
      "messages",
    );
    assert.equal(transcript.entries[0]?.["role"], "system");
    assert.equal(transcript.entries.length, 2);
  });

  it("renders leading child instructions for Messages without mutating ingress history", () => {
    const body = {
      system: [{ type: "text", text: "Initial instructions" }],
      messages: [
        { role: "system", content: "Child instructions" },
        { role: "user", content: "Read once" },
      ],
    };
    const adapt = (source: typeof body) =>
      adaptRequest({
        profile,
        target: { profile: "synthetic", model: "k3", effort: "high" },
        body: source,
        ingress: "messages",
        protocol: "messages",
        transcript: decodePortableHistory(source, "messages"),
        stage: new ClaudeCache(),
        state: new ReverseState(),
        owner: "synthetic",
        conversation: "thread",
        sessionId: "synthetic",
      });
    const { outbound } = adapt(body);
    assert.deepEqual(outbound["system"], [
      { type: "text", text: "Initial instructions" },
      { type: "text", text: "Child instructions" },
    ]);
    assert.deepEqual(outbound["messages"], [
      { role: "user", content: "Read once" },
    ]);
    assert.equal(body.system.length, 1);
    assert.equal(body.messages.length, 2);
    assert.throws(
      () => adapt({ ...body, messages: [...body.messages].reverse() }),
      /continuity_unavailable/,
    );
  });

  it("bounds pending executable tool events before a missing provider terminal", async () => {
    const encoder = new TextEncoder();
    const start = encoder.encode(
      'data: {"type":"response.created","response":{"id":"synthetic","status":"in_progress","output":[]}}\n\n',
    );
    const pending = encoder.encode(
      `data: ${JSON.stringify({ type: "response.function_call_arguments.done", arguments: "x".repeat(1024 * 1024) })}\n\n`,
    );
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls === 0) controller.enqueue(start);
        else if (pulls <= 33) controller.enqueue(pending);
        else controller.close();
        pulls++;
      },
    });
    const controller = new AbortController();
    const response = new Response(body, {
      headers: { "content-type": "text/event-stream" },
    });
    let delivered = 0;
    await assert.rejects(
      (async () => {
        for await (const _event of validatedProviderEvents(
          response,
          profile,
          "responses",
          controller.signal,
          controller,
          { now: () => 1000, monotonic: () => 1000, random: () => 0.5 },
          () => assert.fail("terminal was never validated"),
        ))
          delivered++;
      })(),
      /provider_state_too_large/,
    );
    assert.equal(delivered, 1);
  });
  it("rejects a completed tool event absent from the provider terminal", async () => {
    const tool = {
      type: "function_call",
      id: "tool",
      call_id: "call",
      name: "Read",
      arguments: "{}",
    };
    const raw = [
      {
        type: "response.created",
        response: { id: "synthetic", status: "in_progress", output: [] },
      },
      { type: "response.output_item.done", item: tool },
      {
        type: "response.completed",
        response: { id: "synthetic", status: "completed", output: [] },
      },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join("");
    const controller = new AbortController();
    const seen: string[] = [];
    await assert.rejects(
      (async () => {
        for await (const event of validatedProviderEvents(
          new Response(raw, {
            headers: { "content-type": "text/event-stream" },
          }),
          profile,
          "responses",
          controller.signal,
          controller,
          { now: () => 1000, monotonic: () => 1000, random: () => 0.5 },
          () => assert.fail("invalid terminal was accepted"),
        ))
          seen.push(event.event ?? "");
      })(),
      /inconsistent_provider_tool/,
    );
    assert.equal(seen.length, 1);
  });
});
