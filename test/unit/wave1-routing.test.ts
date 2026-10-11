/** SYNTHETIC fixtures: authored envelopes and provider responses, no live inference. */
import { describe, it } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { loadConfig } from "../../src/config.js";
import { SharedRouting } from "../../src/routing/shared-routing.js";
import { QuotaStore } from "../../src/routing/quota-store.js";
import { classifyFailure } from "../../src/routing/provider-failure.js";
import { readBoundedBody } from "../../src/provider-transport.js";
import { routeChain } from "../../src/routing/routing-config.js";
import {
  allowanceScope,
  type AccessProfile,
  type Item,
  type RoutePolicy,
} from "../../src/routing/routing-types.js";
import { noopLogger } from "../../src/logger.js";
import { ProfileAuth } from "../../src/routing/profile-auth.js";
import { UsageCoordinator } from "../../src/routing/usage-coordinator.js";
import { ActionStore } from "../../src/routing/action-store.js";

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of source) items.push(item);
  return items;
}
const code: AccessProfile = {
  provider: "kimi",
  product: "kimi-code",
  region: "global",
  billing: "subscription",
  account: "one",
  credential: { kind: "env", name: "CODE_KEY" },
};
const api: AccessProfile = {
  provider: "codex",
  product: "openai-api",
  billing: "api",
  account: "two",
  credential: { kind: "env", name: "API_KEY" },
};
const policy: RoutePolicy = {
  clients: ["codex", "claude-code"],
  primary: { profile: "code", model: "k3", effort: "high" },
  fallbacks: [{ profile: "api", model: "gpt-6-sol", effort: "high" }],
  affinity: "native-or-explicit",
  transientTriggers: [],
};
const envelope = (text: string, complete = true) => ({
  text,
  complete,
  truncated: !complete,
});
const quota = () =>
  classifyFailure(
    code,
    403,
    envelope(
      JSON.stringify({
        error: {
          message:
            "You've reached your 5-hour usage limit. Synthetic gate only.",
        },
      }),
    ),
    1000,
  );
const response = (events: Item[]) =>
  new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
const result = (id: string, output: Item[] = []) => [
  {
    type: "response.created",
    response: { id, status: "in_progress", output: [] },
  },
  ...output.map((item) => ({
    type: "response.output_item.done",
    item,
    output_index: 0,
  })),
  { type: "response.completed", response: { id, status: "completed", output } },
];
const text = (value: string): Item => ({
  type: "message",
  role: "assistant",
  content: [{ type: "output_text", text: value }],
});
const full = (routes: Record<string, RoutePolicy> = { work: policy }) => {
  const loaded = loadConfig({
    configPath: "/synthetic/config.json",
    env: {},
    readFile: () =>
      JSON.stringify({
        configVersion: 2,
        accessProfiles: { code, api },
        routes,
        codexIngress: { enabled: true },
      }),
  });
  if (!loaded.ok) throw new Error(loaded.error.message);
  return loaded.value.config;
};
describe("Wave 1 configuration and failures (synthetic)", () => {
  it("rejects billing/key mismatches, unsafe endpoints, missing regions and alias chains", () => {
    const invalid = [
      { ...code, billing: "api" },
      { ...code, region: undefined },
      {
        ...code,
        credential: { kind: "native-oauth", authFile: "/synthetic/auth.json" },
      },
      { ...code, baseUrl: "http://example.invalid" },
      { ...code, baseUrl: "https://example.invalid" },
    ];
    for (const profile of invalid) {
      const loaded = loadConfig({
        configPath: "/synthetic/config.json",
        env: {},
        readFile: () =>
          JSON.stringify({
            configVersion: 2,
            accessProfiles: { code: profile },
          }),
      });
      assert.equal(loaded.ok, false);
    }
    const chain = loadConfig({
      configPath: "/synthetic/config.json",
      env: {},
      readFile: () =>
        JSON.stringify({
          configVersion: 2,
          accessProfiles: { api },
          providers: { codex: { aliases: { a: "b", b: "gpt-6-sol" } } },
          routes: {
            work: {
              ...policy,
              primary: { profile: "api", model: "a", effort: "high" },
              fallbacks: [],
            },
          },
        }),
    });
    assert.equal(chain.ok, false);
    if (!chain.ok) assert.match(chain.error.message, /alias chains/);
  });
  it("rejects unverified exact-model equivalence without blocking explicit fallback", () => {
    const platform = { ...code, product: "kimi-platform", billing: "api" };
    const loaded = loadConfig({
      configPath: "/synthetic/config.json",
      env: {},
      readFile: () =>
        JSON.stringify({
          configVersion: 2,
          accessProfiles: { code, platform },
          routes: {
            work: {
              ...policy,
              sameModelApi: {
                profile: "platform",
                model: "kimi-k3",
                effort: "high",
              },
            },
          },
        }),
    });
    assert.equal(loaded.ok, false);
    if (!loaded.ok)
      assert.match(loaded.error.message, /unverified_model_equivalence/);
  });
  it("preserves first unique target and distinct access profiles", () => {
    assert.equal(
      routeChain({
        ...policy,
        fallbacks: [policy.primary, ...policy.fallbacks, ...policy.fallbacks],
      }).length,
      2,
    );
  });
  it("requires exact product/status signatures and complete envelopes", () => {
    assert.equal(quota().kind, "quota");
    assert.equal(
      classifyFailure(
        code,
        429,
        envelope('{"error":{"message":"quota"}}'),
        1000,
      ).kind,
      "unknown",
    );
    assert.equal(
      classifyFailure(
        code,
        403,
        envelope('{"error":{"message":"quota"}}', false),
        1000,
      ).kind,
      "unknown",
    );
    assert.equal(
      classifyFailure(
        code,
        403,
        envelope(
          '{"error":{"message":"You\'ve reached your concurrent request limit. Synthetic gate."}}',
        ),
        1000,
      ).kind,
      "concurrency",
    );
    assert.equal(
      classifyFailure(
        code,
        401,
        envelope(
          '{"error":{"message":"Your current subscription does not have access to k3. Synthetic gate."}}',
        ),
        1000,
      ).kind,
      "permission",
    );
  });
  it("enforces the byte cap and distinguishes exact EOF from truncation", async () => {
    const bounded = await readBoundedBody(
      new Response("é".repeat(500)).body,
      64,
    );
    assert.equal(Buffer.byteLength(bounded.text), 64);
    assert.equal(bounded.truncated, true);
    assert.equal(bounded.complete, false);
    const exact = await readBoundedBody(new Response("abcd").body, 4);
    assert.deepEqual(exact, { text: "abcd", complete: true, truncated: false });
  });
});
describe("commitment, cancellation and ownership (synthetic)", () => {
  it("falls back on a recognized first-event error without exposing the abandoned response ID", async () => {
    let attempts = 0;
    const router = new SharedRouting(
      full(),
      noopLogger,
      undefined,
      async () => {
        if (++attempts === 1)
          return response([
            {
              type: "error",
              error: {
                status: 403,
                message:
                  "You've reached your 5-hour usage limit. Synthetic gate.",
              },
            },
          ]);
        return response(result("foreign-upstream-id", [text("ready")]));
      },
      { CODE_KEY: "synthetic-code", API_KEY: "synthetic-api" },
    );
    const a = router.actions.create("codex", "thread");
    const events = await collect(
      router.events(
        { model: "work", stream: true },
        "codex",
        "work",
        new AbortController().signal,
        router.actions.context(a.id, "codex"),
      ),
    );
    assert.equal(attempts, 2);
    assert.equal(events.filter((e) => e.type === "response.created").length, 1);
    assert.doesNotMatch(JSON.stringify(events), /foreign-upstream-id/);
    router.close();
  });
  it("holds a non-streaming attempt through completion and may replace its pre-output quota failure", async () => {
    let attempts = 0;
    const router = new SharedRouting(
      full(),
      noopLogger,
      undefined,
      async () => {
        if (++attempts === 1)
          return response([
            {
              type: "response.created",
              response: { id: "abandoned", status: "in_progress", output: [] },
            },
            {
              type: "error",
              error: {
                status: 403,
                message:
                  "You've reached your 5-hour usage limit. Synthetic gate.",
              },
            },
          ]);
        return response(result("fallback", [text("ready")]));
      },
      { CODE_KEY: "synthetic", API_KEY: "synthetic" },
    );
    const a = router.actions.create("codex", "thread");
    const events = await collect(
      router.events(
        { model: "work", stream: false },
        "codex",
        "work",
        new AbortController().signal,
        router.actions.context(a.id, "codex"),
      ),
    );
    assert.equal(attempts, 2);
    assert.equal(events.filter((e) => e.type === "response.created").length, 1);
    assert.doesNotMatch(JSON.stringify(events), /abandoned/);
    router.close();
  });
  it("never routes unknown or auth/permission errors into paid fallback", async () => {
    for (const [status, body] of [
      [429, "<html>quota</html>"],
      [401, '{"error":{"message":"bad key"}}'],
      [
        401,
        '{"error":{"message":"Your current subscription does not have access to k3. Synthetic gate."}}',
      ],
    ] as const) {
      let attempts = 0;
      const router = new SharedRouting(
        full(),
        noopLogger,
        undefined,
        async () => {
          attempts++;
          return new Response(body, { status });
        },
        { CODE_KEY: "synthetic", API_KEY: "synthetic" },
      );
      const a = router.actions.create("codex", "thread");
      await assert.rejects(
        collect(
          router.events(
            { model: "work" },
            "codex",
            "work",
            new AbortController().signal,
            router.actions.context(a.id, "codex"),
          ),
        ),
      );
      assert.equal(attempts, 1);
      router.close();
    }
  });
  it("enforces the shared total deadline with an injected monotonic clock", async () => {
    let elapsed = 0,
      calls = 0;
    const callbacks = new Map<number, () => void>();
    const router = new SharedRouting(
      full(),
      noopLogger,
      {
        now: () => 1000 + elapsed,
        monotonic: () => elapsed,
        random: () => 0.5,
        schedule: (callback, delay) => {
          callbacks.set(delay, callback);
          return () => {
            callbacks.delete(delay);
          };
        },
      },
      async (_url, init) => {
        calls++;
        return new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          ),
        );
      },
      { CODE_KEY: "synthetic", API_KEY: "synthetic" },
    );
    const action = router.actions.create("codex", "thread");
    const pending = collect(
      router.events(
        { model: "work" },
        "codex",
        "work",
        new AbortController().signal,
        router.actions.context(action.id, "codex"),
      ),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    elapsed = 600000;
    callbacks.get(600000)!();
    await assert.rejects(pending, /request_timeout/);
    assert.equal(calls, 1);
    assert.equal(callbacks.size, 0);
    router.close();
  });
  it("does not start fallback after cancellation during fetch", async () => {
    const controller = new AbortController();
    let attempts = 0;
    const router = new SharedRouting(
      full(),
      noopLogger,
      undefined,
      async () => {
        attempts++;
        controller.abort();
        throw new Error("synthetic_disconnect");
      },
      { CODE_KEY: "synthetic", API_KEY: "synthetic" },
    );
    const a = router.actions.create("codex", "thread");
    await assert.rejects(
      collect(
        router.events(
          { model: "work" },
          "codex",
          "work",
          controller.signal,
          router.actions.context(a.id, "codex"),
        ),
      ),
    );
    assert.equal(attempts, 1);
    router.close();
  });
  it("rejects excessive comments and oversized single-chunk SSE events before commitment", async () => {
    for (const raw of [
      ": comment\n\n".repeat(17),
      `data: ${"x".repeat(4 * 1024 * 1024 + 1)}\n\n`,
    ]) {
      let attempts = 0;
      const router = new SharedRouting(
        full(),
        noopLogger,
        undefined,
        async () => {
          attempts++;
          return new Response(raw, {
            headers: { "content-type": "text/event-stream" },
          });
        },
        { CODE_KEY: "synthetic", API_KEY: "synthetic" },
      );
      const a = router.actions.create("codex", "thread");
      let events = 0;
      await assert.rejects(
        (async () => {
          for await (const _ of router.events(
            { model: "work" },
            "codex",
            "work",
            new AbortController().signal,
            router.actions.context(a.id, "codex"),
          ))
            events++;
        })(),
      );
      assert.equal(events, 0);
      assert.equal(attempts, 1);
      router.close();
    }
  });
  it("delivers the first valid event while the upstream completion is paused", async () => {
    const encoder = new TextEncoder();
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        source = c;
        c.enqueue(
          encoder.encode(
            'data: {"type":"response.created","response":{"id":"same","status":"in_progress","output":[]}}\n\n',
          ),
        );
      },
    });
    const router = new SharedRouting(
      full(),
      noopLogger,
      undefined,
      async () =>
        new Response(stream, {
          headers: { "content-type": "text/event-stream" },
        }),
      { CODE_KEY: "synthetic", API_KEY: "synthetic" },
    );
    const a = router.actions.create("codex", "thread"),
      iterator = router.events(
        { model: "work", stream: true },
        "codex",
        "work",
        new AbortController().signal,
        router.actions.context(a.id, "codex"),
      );
    const first = await iterator.next();
    assert.equal(first.value?.type, "response.created");
    source.enqueue(
      encoder.encode(
        'data: {"type":"response.completed","response":{"id":"same","status":"completed","output":[]}}\n\n',
      ),
    );
    source.close();
    await collect(iterator);
    router.close();
  });
  it("withholds executable tools on an incomplete terminal", async () => {
    const tool = {
      type: "function_call",
      id: "fc",
      call_id: "once",
      name: "Read",
      arguments: "{}",
      status: "completed",
    };
    const router = new SharedRouting(
      full(),
      noopLogger,
      undefined,
      async () =>
        response([
          {
            type: "response.created",
            response: { id: "same", status: "in_progress", output: [] },
          },
          { type: "response.output_item.done", item: tool },
          {
            type: "response.incomplete",
            response: {
              id: "same",
              status: "incomplete",
              output: [tool],
              incomplete_details: { reason: "max_output_tokens" },
            },
          },
        ]),
      { CODE_KEY: "synthetic", API_KEY: "synthetic" },
    );
    const a = router.actions.create("codex", "thread"),
      seen: Item[] = [];
    await assert.rejects(
      (async () => {
        for await (const e of router.events(
          { model: "work", stream: true },
          "codex",
          "work",
          new AbortController().signal,
          router.actions.context(a.id, "codex"),
        ))
          seen.push(e);
      })(),
    );
    assert.equal(
      seen.filter((e) => e.type === "response.output_item.done").length,
      0,
    );
    router.close();
  });
  it("reloads a native account replacement and isolates its allowance scope", async () => {
    const temp = await mkdtemp(join(tmpdir(), "subswitch-owned-auth-")),
      path = join(temp, "auth.json");
    const profile: AccessProfile = {
      provider: "codex",
      product: "chatgpt-codex",
      billing: "subscription",
      account: "slot",
      credential: { kind: "native-oauth", authFile: path },
    };
    const token = (account: string) =>
      `e30.${Buffer.from(JSON.stringify({ exp: Date.now() / 1000 + 3600, "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url")}.synthetic`;
    const save = (account: string) =>
      writeFile(
        path,
        JSON.stringify({
          tokens: {
            access_token: token(account),
            account_id: account,
            refresh_token: "",
          },
        }),
        { mode: 0o600 },
      );
    try {
      await save("synthetic-account-one");
      const auth = new ProfileAuth({ native: profile }, noopLogger);
      const one = await auth.get("native", new AbortController().signal),
        firstScope = auth.scope(one);
      await save("synthetic-account-two");
      const two = await auth.get("native", new AbortController().signal);
      assert.notEqual(one.generation, two.generation);
      assert.notDeepEqual(firstScope, auth.scope(two));
      assert.equal(
        two.authHeaders["chatgpt-account-id"],
        "synthetic-account-two",
      );
      assert.throws(() => auth.validate(one), /credential_binding_mismatch/);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
  it("keeps coding keys sharing an allowance grouped after a key-owner change", async () => {
    const environment = { KEY_ONE: "synthetic-one", KEY_TWO: "synthetic-two" };
    const auth = new ProfileAuth(
      {
        one: { ...code, credential: { kind: "env", name: "KEY_ONE" } },
        two: { ...code, credential: { kind: "env", name: "KEY_TWO" } },
      },
      noopLogger,
      environment,
    );
    const one = await auth.get("one", new AbortController().signal),
      two = await auth.get("two", new AbortController().signal);
    const before = auth.scope(one);
    assert.deepEqual(before, auth.scope(two));
    environment.KEY_ONE = "synthetic-replaced";
    const changed = await auth.get("one", new AbortController().signal);
    assert.notDeepEqual(before, auth.scope(changed));
    assert.deepEqual(auth.scope(changed), auth.scope(two));
  });
  it("validates profile binding immediately before authentication and distinguishes changed keys", async () => {
    const environment = { CODE_KEY: "synthetic-one" },
      profiles = { code };
    const auth = new ProfileAuth(profiles, noopLogger, environment);
    const first = await auth.get("code", new AbortController().signal);
    auth.validate(first);
    environment.CODE_KEY = "synthetic-two";
    assert.throws(() => auth.validate(first), /credential_owner_changed/);
    const second = await auth.get("code", new AbortController().signal);
    assert.notEqual(first.generation, second.generation);
    profiles.code = { ...code, account: "different" };
    assert.throws(() => auth.validate(second), /credential_binding_mismatch/);
  });
});
describe("metadata and action admission (synthetic)", () => {
  it("retains a newer inference blocker when an earlier metadata query returns", async () => {
    let now = 1000;
    const quotaStore = new QuotaStore({
      now: () => now,
      monotonic: () => now,
      random: () => 0.5,
    });
    let resolve!: (snapshot: {
      windows: {
        id: string;
        exhausted: false;
        observedAt: number;
        source: "usage";
      }[];
      complete: boolean;
      serviceableCredits: boolean;
    }) => void;
    const coordinator = new UsageCoordinator(
      quotaStore,
      async () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const pending = coordinator.refresh(allowanceScope(code));
    now = 2000;
    quotaStore.fail(quota());
    now = 3000;
    resolve({
      windows: [
        { id: "five-hour", exhausted: false, observedAt: now, source: "usage" },
      ],
      complete: true,
      serviceableCredits: true,
    });
    assert.equal(await pending, false);
    assert.equal(quotaStore.readiness(allowanceScope(code)), "exhausted");
  });
  it("closes admission while existing requests settle and cancels only its own action", () => {
    const store = new ActionStore(),
      first = store.create("codex", "thread"),
      second = store.create("codex", "thread");
    const a = new AbortController(),
      b = new AbortController();
    const finishA = store.admit(store.context(first.id, "codex"), a),
      finishB = store.admit(store.context(second.id, "codex"), b);
    store.complete(first.id);
    assert.throws(
      () => store.context(first.id, "codex"),
      /action_admission_closed/,
    );
    store.cancel(second.id);
    assert.equal(b.signal.aborted, true);
    assert.equal(a.signal.aborted, false);
    finishA();
    finishB();
    assert.throws(() => store.context(first.id, "codex"), /action_state_lost/);
  });
});
describe("quota recovery and action affinity (synthetic)", () => {
  it("backs off a failed recovery probe without erasing overlapping window facts", () => {
    let now = 1000;
    const store = new QuotaStore({
      now: () => now,
      monotonic: () => now,
      random: () => 0.5,
    });
    store.fail(quota());
    now = 62000;
    assert.equal(store.reserve(allowanceScope(code)), true);
    store.recoveryFailure(allowanceScope(code));
    assert.equal(store.readiness(allowanceScope(code)), "exhausted");
    assert.equal(store.observations(allowanceScope(code))[0]?.exhausted, true);
    now = 181000;
    assert.equal(store.reserve(allowanceScope(code)), false);
    now = 183000;
    assert.equal(store.reserve(allowanceScope(code)), true);
  });
  it("reserves one half-open probe and preserves independent blockers and stale observations", () => {
    let now = 1000;
    const store = new QuotaStore({
      now: () => now,
      monotonic: () => now,
      random: () => 0.5,
    });
    const failure = quota();
    failure.windows = [
      {
        id: "five-hour",
        exhausted: true,
        resetAt: 61000,
        observedAt: now,
        source: "inference",
      },
      {
        id: "weekly",
        exhausted: true,
        resetAt: 900000,
        observedAt: now,
        source: "inference",
      },
    ];
    store.fail(failure);
    assert.equal(
      store.observe(
        allowanceScope(code),
        [
          {
            id: "five-hour",
            exhausted: false,
            observedAt: 1000,
            source: "usage",
          },
        ],
        999,
      ),
      false,
    );
    now = 62000;
    assert.equal(store.reserve(allowanceScope(code)), true);
    assert.equal(store.reserve(allowanceScope(code)), false);
    store.success(allowanceScope(code));
    assert.equal(store.readiness(allowanceScope(code)), "available");
    assert.equal(
      store
        .observations(allowanceScope(code))
        .filter((w) => w.exhausted === true).length,
      2,
    );
  });
  it("keeps action A on fallback while restored primary serves same-thread action B", async () => {
    let now = 1000,
      codeAttempts = 0;
    const calls: { url: string; body: Item }[] = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      const body = JSON.parse(String(init?.body));
      calls.push({ url: String(url), body });
      if (String(url).includes("kimi")) {
        if (++codeAttempts === 1)
          return new Response(
            JSON.stringify({
              error: {
                message:
                  "You've reached your 5-hour usage limit. Synthetic gate.",
              },
            }),
            { status: 403 },
          );
        return response(result("collision", [text("primary-B")]));
      }
      if (
        Array.isArray(body.input) &&
        body.input.some((i: Item) => i.type === "function_call_output")
      )
        return response(result("collision", [text("fallback-A-completed")]));
      return response(
        result("collision", [
          {
            type: "function_call",
            id: "tool",
            call_id: "read-once",
            name: "read",
            arguments: "{}",
            status: "completed",
          },
        ]),
      );
    };
    const router = new SharedRouting(
      full(),
      noopLogger,
      { now: () => now, monotonic: () => now, random: () => 0.5 },
      fetchImpl,
      { CODE_KEY: "synthetic-code", API_KEY: "synthetic-api" },
    );
    const a = router.actions.create("codex", "thread");
    const ac = router.actions.context(a.id, "codex");
    const initial = {
      model: "work",
      stream: true,
      input: [{ role: "user", content: "Read once." }],
    };
    const aEvents = await collect(
      router.events(initial, "codex", "work", new AbortController().signal, ac),
    );
    const aResponse = aEvents.at(-1)?.response as Item;
    assert.match(String(aResponse.id), /^resp_subswitch_route_/);
    assert.equal(router.actions.affinity(ac, "work").chainIndex, 1);
    now += 61000;
    const b = router.actions.create("codex", "thread");
    const bc = router.actions.context(b.id, "codex");
    await collect(
      router.events(initial, "codex", "work", new AbortController().signal, bc),
    );
    const resumed = await collect(
      router.events(
        {
          model: "work",
          stream: true,
          previous_response_id: aResponse.id,
          input: [
            {
              type: "function_call_output",
              call_id: "read-once",
              output: "unpredictable-read-result",
            },
          ],
        },
        "codex",
        "work",
        new AbortController().signal,
        ac,
      ),
    );
    assert.equal(calls.length, 4);
    assert.match(calls[2]!.url, /kimi/);
    assert.match(calls[3]!.url, /openai/);
    assert.equal(calls[3]!.body.previous_response_id, undefined);
    assert.equal(
      (calls[3]!.body.input as Item[]).filter((i) => i.type === "function_call")
        .length,
      1,
    );
    assert.equal(
      ((resumed.at(-1)?.response as Item).output as Item[])[0]?.type,
      "message",
    );
    router.close();
  });
  it("requires action identity, while warmup consumes no credential or quota", async () => {
    let calls = 0;
    const router = new SharedRouting(
      full(),
      noopLogger,
      undefined,
      async () => {
        calls++;
        throw new Error();
      },
      {},
    );
    const warmup = await collect(
      router.events(
        { model: "work", generate: false },
        "codex",
        "work",
        new AbortController().signal,
      ),
    );
    assert.equal(warmup.length, 2);
    assert.equal(calls, 0);
    await assert.rejects(
      collect(
        router.events(
          { model: "work" },
          "codex",
          "work",
          new AbortController().signal,
        ),
      ),
      /profile_credentials_missing|action_identity_required/,
    );
    router.close();
  });
  it("stops on a committed quota failure and never starts another attempt", async () => {
    let attempts = 0;
    const router = new SharedRouting(
      full(),
      noopLogger,
      undefined,
      async () => {
        attempts++;
        return response([
          {
            type: "response.created",
            response: { id: "x", status: "in_progress", output: [] },
          },
          {
            type: "error",
            error: {
              status: 403,
              message:
                "You've reached your 5-hour usage limit. Synthetic gate.",
            },
          },
        ]);
      },
      { CODE_KEY: "synthetic", API_KEY: "synthetic" },
    );
    const a = router.actions.create("codex", "thread");
    await assert.rejects(
      collect(
        router.events(
          { model: "work", stream: true },
          "codex",
          "work",
          new AbortController().signal,
          router.actions.context(a.id, "codex"),
        ),
      ),
      /quota/,
    );
    assert.equal(attempts, 1);
    router.close();
  });
});
