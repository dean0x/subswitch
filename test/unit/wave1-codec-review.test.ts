/** Synthetic review fixtures: no inference or credentials. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { reverseRequest } from "../../src/claude-adapter.js";
import { ClaudeCache } from "../../src/claude-cache.js";
import { ReverseState } from "../../src/claude-state.js";
import { adaptRequest } from "../../src/routing/request-adapter.js";
import {
  decodePortableHistory,
  renderResponsesHistory,
} from "../../src/routing/portable-history.js";
import { SharedRouting } from "../../src/routing/shared-routing.js";
import { loadConfig } from "../../src/config.js";
import { noopLogger } from "../../src/logger.js";
import { validatedProviderEvents } from "../../src/routing/provider-stream.js";
import { systemClock } from "../../src/routing/clock.js";
import { AttemptFailure } from "../../src/routing/attempt-failure.js";
import { translateClaudeStream } from "../../src/claude-stream.js";
import type { AccessProfile, Item } from "../../src/routing/routing-types.js";

const profile: AccessProfile = {
  provider: "claude",
  product: "anthropic-api",
  billing: "api",
  account: "synthetic",
  credential: { kind: "env", name: "SYNTHETIC_KEY" },
};

const history = (custom: boolean, isError: boolean): Item => ({
  model: "claude-sonnet-5",
  tools: [
    {
      type: custom ? "custom" : "function",
      name: "read",
      ...(custom
        ? { format: { type: "text" } }
        : { parameters: { type: "object", properties: {} } }),
    },
  ],
  input: [
    {
      type: custom ? "custom_tool_call" : "function_call",
      call_id: "read-once",
      name: "read",
      ...(custom ? { input: "read file" } : { arguments: "{}" }),
    },
    {
      type: custom ? "custom_tool_call_output" : "function_call_output",
      call_id: "read-once",
      output: isError ? "file not found" : "file contents",
      is_error: isError,
    },
  ],
});

const toolResult = (body: Item): Item => {
  const messages = body["messages"] as Item[];
  return (messages.at(-1)!["content"] as Item[])[0]!;
};

describe("reviewed shared tool-result codec", () => {
  for (const custom of [false, true]) {
    it(`preserves explicit tool error flags in ${custom ? "custom" : "function"} results for legacy and routed Messages adapters`, () => {
      for (const isError of [false, true]) {
        const body = history(custom, isError);
        const legacy = reverseRequest(body).body;
        const stage = new ClaudeCache();
        const routed = adaptRequest({
          profile,
          target: {
            profile: "claude-api",
            model: "claude-sonnet-5",
            effort: "high",
          },
          body,
          ingress: "responses",
          protocol: "messages",
          transcript: decodePortableHistory(body, "responses"),
          stage,
          state: new ReverseState(undefined, undefined, stage),
          owner: "synthetic-owner",
          conversation: "synthetic-conversation",
          sessionId: "synthetic-session",
        }).outbound;
        for (const adapted of [legacy, routed]) {
          const result = toolResult(adapted);
          assert.equal(result["is_error"], isError);
          assert.equal(result["tool_use_id"], "read-once");
          assert.deepEqual(result["content"], [
            {
              type: "text",
              text: isError ? "file not found" : "file contents",
            },
          ]);
        }
      }
    });
  }
});

const adapt = (
  body: Item,
  ingress: "responses" | "messages",
  targetProfile = profile,
  model = "claude-sonnet-5-5",
) => {
  const stage = new ClaudeCache();
  return adaptRequest({
    profile: targetProfile,
    target: { profile: "synthetic-profile", model, effort: "high" },
    body,
    ingress,
    protocol: targetProfile.provider === "claude" ? "messages" : "responses",
    transcript: decodePortableHistory(body, ingress),
    stage,
    state: new ReverseState(undefined, undefined, stage),
    owner: "synthetic-owner",
    conversation: "synthetic-conversation",
    sessionId: "synthetic-session",
  }).outbound;
};

const api: AccessProfile = {
  provider: "codex",
  product: "openai-api",
  billing: "api",
  account: "synthetic",
  credential: { kind: "env", name: "SYNTHETIC_API_KEY" },
};
const kimi: AccessProfile = {
  provider: "kimi",
  product: "kimi-code",
  region: "global",
  billing: "subscription",
  account: "synthetic",
  credential: { kind: "env", name: "SYNTHETIC_CODE_KEY" },
};

describe("reviewed target capability preflight", () => {
  it("rejects known incompatible Messages identity capabilities and preserves a valid output limit", () => {
    const body = {
      model: "work",
      messages: [{ role: "user", content: "read" }],
      max_tokens: 128000,
      tools: [
        { name: "read", input_schema: { type: "object", properties: {} } },
      ],
    };
    assert.equal(adapt(body, "messages")["max_tokens"], 128000);
    for (const override of [
      { max_tokens: 128001 },
      { tool_choice: { type: "any" } },
      { thinking: { type: "disabled" } },
    ])
      assert.throws(
        () => adapt({ ...body, ...override }, "messages"),
        /target_capability_unavailable/,
      );
    assert.throws(
      () => adapt({ ...body, max_tokens: "bad" }, "messages"),
      /invalid_output_limit/,
    );
  });

  it("preserves API output limits and refuses unsupported subscription output parameters", () => {
    const body = {
      model: "work",
      messages: [{ role: "user", content: "read" }],
      max_tokens: 8192,
    };
    assert.equal(
      adapt(body, "messages", api, "gpt-6-sol")["max_output_tokens"],
      8192,
    );
    assert.throws(
      () =>
        adapt(
          { model: "work", input: "read", max_output_tokens: 8192 },
          "responses",
          {
            ...api,
            product: "chatgpt-codex",
            billing: "subscription",
            credential: { kind: "native-oauth", authFile: "/synthetic" },
          },
          "gpt-6-sol",
        ),
      /target_capability_unavailable/,
    );
  });

  it("rejects an incompatible primary before inference and skips only an incompatible fallback after quota", async () => {
    const config = (primary: string) => {
      const loaded = loadConfig({
        configPath: "/synthetic/config",
        env: {},
        readFile: () =>
          JSON.stringify({
            configVersion: 2,
            codexIngress: { enabled: true },
            accessProfiles: { kimi, claude: profile, api },
            routes: {
              work: {
                clients: ["codex"],
                primary:
                  primary === "claude"
                    ? {
                        profile: "claude",
                        model: "claude-sonnet-5-5",
                        effort: "high",
                      }
                    : { profile: "kimi", model: "k3", effort: "high" },
                fallbacks:
                  primary === "claude"
                    ? []
                    : [
                        {
                          profile: "claude",
                          model: "claude-sonnet-5-5",
                          effort: "high",
                        },
                        { profile: "api", model: "gpt-6-sol", effort: "high" },
                      ],
              },
            },
          }),
      });
      assert.ok(loaded.ok);
      return loaded.value.config;
    };
    const calls: string[] = [];
    const fetcher: typeof fetch = async (url) => {
      calls.push(String(url));
      if (String(url).includes("kimi"))
        return new Response(
          JSON.stringify({
            error: {
              message:
                "You've reached your 5-hour usage limit. Synthetic review fixture.",
            },
          }),
          { status: 403 },
        );
      return new Response(
        [
          {
            type: "response.created",
            response: { id: "synthetic", status: "in_progress", output: [] },
          },
          {
            type: "response.completed",
            response: { id: "synthetic", status: "completed", output: [] },
          },
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    };
    const env = {
      SYNTHETIC_CODE_KEY: "synthetic",
      SYNTHETIC_KEY: "synthetic",
      SYNTHETIC_API_KEY: "synthetic",
    };
    const body = {
      model: "work",
      input: "read",
      stream: true,
      tool_choice: "required",
      tools: [
        {
          type: "function",
          name: "read",
          parameters: { type: "object", properties: {} },
        },
      ],
    };
    const primary = new SharedRouting(
      config("claude"),
      noopLogger,
      systemClock,
      fetcher,
      env,
    );
    try {
      await assert.rejects(async () => {
        for await (const _ of primary.events(
          body,
          "codex",
          "work",
          new AbortController().signal,
        )) {
          /* consume */
        }
      }, /target_capability_unavailable/);
      await assert.rejects(async () => {
        for await (const _ of primary.events(
          {
            ...body,
            input: [
              {
                type: "function_call_output",
                call_id: "orphan",
                output: "invalid history",
              },
            ],
          },
          "codex",
          "work",
          new AbortController().signal,
        )) {
          /* consume */
        }
      }, /unsupported_routed_content/);
      assert.equal(calls.length, 0);
    } finally {
      primary.close();
    }
    // Capability rejection precedes authentication: an ineligible target must not
    // refresh or validate its credential before the eligible API fallback is tried.
    const fallback = new SharedRouting(
      config("kimi"),
      noopLogger,
      systemClock,
      fetcher,
      { ...env, SYNTHETIC_KEY: "synthetic\ninvalid" },
    );
    const action = fallback.actions.create("codex", "synthetic-thread");
    try {
      const events: Item[] = [];
      for await (const event of fallback.events(
        body,
        "codex",
        "work",
        new AbortController().signal,
        fallback.actions.context(action.id, "codex"),
      ))
        events.push(event);
      assert.equal(events.at(-1)?.["type"], "response.completed");
      assert.equal(calls.length, 2);
      assert.match(calls[0]!, /kimi/);
      assert.match(calls[1]!, /openai/);
    } finally {
      fallback.close();
    }
  });
});

const stream = (tools: Item[], pending: Item[]) =>
  new Response(
    [
      {
        type: "response.created",
        response: { id: "synthetic", status: "in_progress", output: [] },
      },
      ...pending,
      {
        type: "response.completed",
        response: { id: "synthetic", status: "completed", output: tools },
      },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
const consume = async (response: Response) => {
  const controller = new AbortController();
  let events = 0;
  for await (const _ of validatedProviderEvents(
    response,
    api,
    "responses",
    controller.signal,
    controller,
    systemClock,
    () => undefined,
  ))
    events++;
  return events;
};

describe("reviewed indexed tool-terminal validation", () => {
  const tool = {
    type: "function_call",
    id: "fc_one",
    call_id: "call_one",
    name: "read",
    arguments: "{}",
  };
  it("keeps all supplied identifiers consistent and rejects ambiguous IDs or wrong tool event kinds", async () => {
    for (const response of [
      stream(
        [tool],
        [
          {
            type: "response.output_item.done",
            item: tool,
            item_id: "wrong",
            output_index: 0,
          },
        ],
      ),
      stream(
        [tool],
        [
          {
            type: "response.function_call_arguments.done",
            item_id: "fc_one",
            call_id: "wrong",
            arguments: "{}",
          },
        ],
      ),
      stream([tool, { ...tool, call_id: "call_two" }], []),
      stream(
        [
          {
            type: "custom_tool_call",
            id: "custom_one",
            call_id: "call_one",
            name: "read",
            input: "read",
          },
        ],
        [
          {
            type: "response.function_call_arguments.done",
            item_id: "custom_one",
          },
        ],
      ),
    ])
      await assert.rejects(consume(response), /inconsistent_provider_tool/);
  });
  it("rejects duplicate executable completion metadata before delivering any executable event", async () => {
    const outputDone = {
      type: "response.output_item.done",
      item: tool,
      output_index: 0,
    };
    const argumentsDone = {
      type: "response.function_call_arguments.done",
      item_id: "fc_one",
      arguments: "{}",
    };
    for (const pending of [
      [outputDone, { ...outputDone }],
      [
        argumentsDone,
        {
          type: "response.function_call_arguments.done",
          call_id: "call_one",
          arguments: "{}",
        },
      ],
    ]) {
      const controller = new AbortController();
      const delivered: string[] = [];
      await assert.rejects(async () => {
        for await (const event of validatedProviderEvents(
          stream([tool], pending),
          api,
          "responses",
          controller.signal,
          controller,
          systemClock,
          () => undefined,
        ))
          delivered.push(JSON.parse(event.data).type);
      }, /duplicate_provider_tool_completion/);
      assert.deepEqual(delivered, ["response.created"]);
    }
  });
  it("validates large terminal tool sets with distinct completion kinds", async () => {
    const tools = Array.from({ length: 4000 }, (_, index) => ({
      ...tool,
      id: `fc_${index}`,
      call_id: `call_${index}`,
    }));
    const pending = tools.flatMap((item, output_index) => [
      {
        type: "response.function_call_arguments.done",
        item_id: item.id,
        output_index,
        arguments: "{}",
      },
      { type: "response.output_item.done", item, output_index },
    ]);
    assert.equal(await consume(stream(tools, pending)), 8002);
  });
});

describe("reviewed reasoning replay ownership", () => {
  it("requires the recorded thinking type and exact signed fields", () => {
    const blocks = [
      {
        type: "thinking",
        thinking: "signed thought",
        signature: "synthetic-signature",
      },
      { type: "redacted_thinking", data: "synthetic-redacted" },
    ];
    const replay = (recorded: Item, supplied: Item) => {
      const stage = new ClaudeCache();
      const signature = recorded["signature"] ?? recorded["data"];
      stage.put(
        "snapshot",
        `signature:synthetic-owner:synthetic-conversation:${signature}`,
        { request: {}, input: [recorded] },
      );
      const body = {
        model: "work",
        messages: [
          { role: "assistant", content: [supplied] },
          { role: "user", content: "continue" },
        ],
      };
      return adaptRequest({
        profile,
        target: { profile: "claude", model: "claude-sonnet-5", effort: "high" },
        body,
        ingress: "messages",
        protocol: "messages",
        transcript: decodePortableHistory(body, "messages"),
        stage,
        state: new ReverseState(undefined, undefined, stage),
        owner: "synthetic-owner",
        conversation: "synthetic-conversation",
        sessionId: "synthetic-session",
      });
    };
    for (const block of blocks)
      assert.doesNotThrow(() => replay(block, { ...block }));
    assert.throws(
      () =>
        replay(blocks[0]!, {
          type: "redacted_thinking",
          data: "synthetic-signature",
        }),
      /foreign_opaque_state/,
    );
    assert.throws(
      () =>
        replay(blocks[1]!, {
          type: "thinking",
          signature: "synthetic-redacted",
          thinking: "invented",
        }),
      /foreign_opaque_state/,
    );
    assert.throws(
      () => replay(blocks[0]!, { ...blocks[0], thinking: "edited" }),
      /foreign_opaque_state/,
    );
    assert.throws(
      () => replay(blocks[0]!, { ...blocks[0], data: "extra" }),
      /foreign_opaque_state/,
    );
    assert.throws(
      () => replay(blocks[1]!, { ...blocks[1], signature: "extra" }),
      /foreign_opaque_state/,
    );
  });
});

describe("reviewed source transport classification", () => {
  const failedBody = () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error("synthetic upstream read failure"));
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );

  it("distinguishes an upstream reader failure from malformed or oversized SSE", async () => {
    await assert.rejects(
      consume(failedBody()),
      (error: unknown) =>
        error instanceof AttemptFailure && error.failure.kind === "transport",
    );
    for (const malformed of [
      "data: invalid JSON\n\n",
      `data: ${"x".repeat(4 * 1024 * 1024 + 1)}\n\n`,
    ]) {
      await assert.rejects(
        consume(
          new Response(malformed, {
            headers: { "content-type": "text/event-stream" },
          }),
        ),
        (error: unknown) => !(error instanceof AttemptFailure),
      );
    }
  });

  it("keeps MIME, originating protocol, and missing-start violations as protocol failures", async () => {
    const responses = [
      new Response("{}", { headers: { "content-type": "application/json" } }),
      new Response(
        `data: ${JSON.stringify({
          type: "message_start",
          message: {
            id: "synthetic",
            type: "message",
            role: "assistant",
            content: [],
          },
        })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      ),
      new Response(
        `data: ${JSON.stringify({
          type: "response.in_progress",
          response: {
            id: "synthetic",
            status: "in_progress",
            output: [],
          },
        })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      ),
    ];
    for (const response of responses)
      await assert.rejects(
        consume(response),
        (error: unknown) =>
          !(error instanceof AttemptFailure) &&
          error instanceof Error &&
          /provider_response_json|provider_protocol_mismatch|provider_start_required/.test(
            error.message,
          ),
      );
  });

  it("keeps client cancellation distinct from an upstream transport failure", async () => {
    const controller = new AbortController();
    const response = new Response(
      new ReadableStream({
        start() {
          /* Wait for cancellation. */
        },
      }),
      {
        headers: { "content-type": "text/event-stream" },
      },
    );
    const pending = (async () => {
      for await (const _ of validatedProviderEvents(
        response,
        api,
        "responses",
        controller.signal,
        controller,
        systemClock,
        () => undefined,
      )) {
        /* consume */
      }
    })();
    controller.abort();
    await assert.rejects(
      pending,
      (error: unknown) => !(error instanceof AttemptFailure),
    );
  });

  it("uses pre-start transport fallback only when explicitly configured and never after commitment", async () => {
    for (const [allowTransport, commitFirst] of [
      [false, false],
      [true, false],
      [true, true],
    ]) {
      const loaded = loadConfig({
        configPath: "/synthetic/config",
        env: {},
        readFile: () =>
          JSON.stringify({
            configVersion: 2,
            codexIngress: { enabled: true },
            accessProfiles: { kimi, api },
            routes: {
              work: {
                clients: ["codex"],
                primary: { profile: "kimi", model: "k3", effort: "high" },
                fallbacks: [
                  { profile: "api", model: "gpt-6-sol", effort: "high" },
                ],
                transientTriggers: allowTransport ? ["transport"] : [],
              },
            },
          }),
      });
      assert.ok(loaded.ok);
      const calls: string[] = [];
      const fetcher: typeof fetch = async (url) => {
        calls.push(String(url));
        if (String(url).includes("openai")) return stream([], []);
        if (!commitFirst) return failedBody();
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  `data: ${JSON.stringify({ type: "response.created", response: { id: "synthetic", status: "in_progress", output: [] } })}\n\n`,
                ),
              );
              setTimeout(
                () =>
                  controller.error(
                    new Error("synthetic committed read failure"),
                  ),
                20,
              );
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      };
      const routing = new SharedRouting(
        loaded.value.config,
        noopLogger,
        systemClock,
        fetcher,
        { SYNTHETIC_CODE_KEY: "synthetic", SYNTHETIC_API_KEY: "synthetic" },
      );
      const action = routing.actions.create("codex", "synthetic-thread");
      const events: Item[] = [];
      const run = async () => {
        for await (const event of routing.events(
          { model: "work", input: "hello", stream: true },
          "codex",
          "work",
          new AbortController().signal,
          routing.actions.context(action.id, "codex"),
        ))
          events.push(event);
      };
      try {
        if (allowTransport && !commitFirst) {
          await run();
          assert.equal(calls.length, 2);
          assert.equal(events.at(-1)?.["type"], "response.completed");
        } else {
          await assert.rejects(
            run(),
            (error: unknown) =>
              error instanceof AttemptFailure &&
              error.failure.kind === "transport",
          );
          assert.equal(calls.length, 1);
          assert.equal(events.length, commitFirst ? 1 : 0);
        }
      } finally {
        routing.close();
      }
    }
  });
});

describe("reviewed refusal text and terminals", () => {
  const refusal = {
    type: "message",
    id: "refusal-message",
    role: "assistant",
    status: "completed",
    content: [{ type: "refusal", refusal: "I cannot help with that." }],
  };
  const configured = () => {
    const loaded = loadConfig({
      configPath: "/synthetic/config",
      env: {},
      readFile: () =>
        JSON.stringify({
          configVersion: 2,
          codexIngress: { enabled: true },
          accessProfiles: { api },
          routes: {
            work: {
              clients: ["codex", "claude-code"],
              primary: { profile: "api", model: "gpt-6-sol", effort: "high" },
            },
          },
        }),
    });
    assert.ok(loaded.ok);
    return loaded.value.config;
  };
  const refusalEvents = (
    terminalType = "response.completed",
    output: Item[] = [refusal],
  ): Item[] => [
    {
      type: "response.created",
      response: { id: "synthetic", status: "in_progress", output: [] },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...refusal, status: "in_progress", content: [] },
    },
    {
      type: "response.content_part.added",
      output_index: 0,
      item_id: "refusal-message",
      content_index: 0,
      part: { type: "refusal", refusal: "" },
    },
    {
      type: "response.refusal.delta",
      output_index: 0,
      item_id: "refusal-message",
      content_index: 0,
      delta: "I cannot help with that.",
    },
    {
      type: "response.refusal.done",
      output_index: 0,
      item_id: "refusal-message",
      content_index: 0,
      refusal: "I cannot help with that.",
    },
    { type: "response.output_item.done", output_index: 0, item: refusal },
    {
      type: terminalType,
      response: {
        id: "synthetic",
        status:
          terminalType === "response.completed" ? "completed" : "incomplete",
        output,
        ...(terminalType === "response.incomplete"
          ? { incomplete_details: { reason: "max_output_tokens" } }
          : {}),
      },
    },
  ];
  const responseFor = (events: Item[]) =>
    new Response(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
      { headers: { "content-type": "text/event-stream" } },
    );

  it("delivers refusal text while upstream is paused and preserves the refusal stop reason", async () => {
    const events = refusalEvents();
    let upstream!: ReadableStreamDefaultController<Uint8Array>;
    let completed = false;
    const routing = new SharedRouting(
      configured(),
      noopLogger,
      systemClock,
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              upstream = controller;
              controller.enqueue(
                new TextEncoder().encode(
                  events
                    .slice(0, 4)
                    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
                    .join(""),
                ),
              );
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
      { SYNTHETIC_API_KEY: "synthetic" },
    );
    const iterator = routing.events(
      {
        model: "work",
        messages: [{ role: "user", content: "request" }],
        stream: true,
      },
      "claude-code",
      "work",
      new AbortController().signal,
    );
    try {
      const first: Item[] = [];
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          (async () => {
            while (
              !first.some((event) => event["type"] === "content_block_delta")
            )
              first.push((await iterator.next()).value!);
          })(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("refusal text buffered until terminal")),
              2000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      assert.equal(completed, false);
      assert.deepEqual(
        first.find((event) => event["type"] === "content_block_delta")![
          "delta"
        ],
        { type: "text_delta", text: "I cannot help with that." },
      );
      upstream.enqueue(
        new TextEncoder().encode(
          events
            .slice(4)
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join(""),
        ),
      );
      completed = true;
      upstream.close();
      for await (const event of iterator) first.push(event);
      assert.equal(
        (
          first.find((event) => event["type"] === "message_delta")![
            "delta"
          ] as Item
        )["stop_reason"],
        "refusal",
      );
    } finally {
      await iterator.return(undefined);
      routing.close();
    }
  });

  it("retains cached refusal blocks on same-protocol continuation and renders their text for Messages", async () => {
    const calls: Item[] = [];
    const routing = new SharedRouting(
      configured(),
      noopLogger,
      systemClock,
      async (_, init) => {
        calls.push(JSON.parse(String(init?.body)) as Item);
        return calls.length === 1
          ? responseFor(refusalEvents())
          : stream([], []);
      },
      { SYNTHETIC_API_KEY: "synthetic" },
    );
    try {
      let previous = "";
      for await (const event of routing.events(
        { model: "work", input: "request", stream: true },
        "codex",
        "work",
        new AbortController().signal,
      ))
        if (event["type"] === "response.completed")
          previous = (event["response"] as Item)["id"] as string;
      const followup = {
        previous_response_id: previous,
        input: "next",
        stream: true,
      };
      assert.equal(routing.match(followup, "codex"), "work");
      for await (const _ of routing.events(
        followup,
        "codex",
        "work",
        new AbortController().signal,
      )) {
        /* consume */
      }
      assert.deepEqual((calls[1]!["input"] as Item[])[1], refusal);
      assert.equal(calls[1]!["previous_response_id"], undefined);
      const transcript = decodePortableHistory(calls[1]!, "responses");
      assert.deepEqual(
        (renderResponsesHistory(transcript)["input"] as Item[])[1],
        refusal,
      );
      const converted = reverseRequest({
        ...calls[1],
        model: "claude-sonnet-5",
      }).body;
      assert.deepEqual(
        ((converted["messages"] as Item[])[1]!["content"] as Item[])[0],
        { type: "text", text: "I cannot help with that." },
      );
      assert.throws(
        () =>
          decodePortableHistory(
            { input: [{ role: "user", content: refusal.content }] },
            "responses",
          ),
        /unsupported_routed_content/,
      );
    } finally {
      routing.close();
    }
  });

  it("honors max-output limits and preserves authoritative completed tools alongside refusal text", async () => {
    for (const withTool of [false, true]) {
      const tool = {
        type: "function_call",
        id: "fc_refusal",
        call_id: "call_refusal",
        name: "read",
        arguments: "{}",
      };
      const events = refusalEvents(
        withTool ? "response.completed" : "response.incomplete",
        withTool ? [refusal, tool] : [refusal],
      );
      if (withTool)
        events.splice(
          6,
          0,
          {
            type: "response.output_item.added",
            output_index: 1,
            item: { ...tool, arguments: "" },
          },
          {
            type: "response.function_call_arguments.delta",
            item_id: tool.id,
            output_index: 1,
            delta: "{}",
          },
          {
            type: "response.function_call_arguments.done",
            item_id: tool.id,
            output_index: 1,
            arguments: "{}",
          },
          { type: "response.output_item.done", output_index: 1, item: tool },
        );
      const routing = new SharedRouting(
        configured(),
        noopLogger,
        systemClock,
        async () => responseFor(events),
        { SYNTHETIC_API_KEY: "synthetic" },
      );
      try {
        const received: Item[] = [];
        for await (const event of routing.events(
          {
            model: "work",
            messages: [{ role: "user", content: "request" }],
            stream: true,
            ...(withTool
              ? {
                  tools: [
                    {
                      name: "read",
                      input_schema: { type: "object", properties: {} },
                    },
                  ],
                }
              : {}),
          },
          "claude-code",
          "work",
          new AbortController().signal,
        ))
          received.push(event);
        assert.equal(
          (
            received.find((event) => event["type"] === "message_delta")![
              "delta"
            ] as Item
          )["stop_reason"],
          withTool ? "tool_use" : "max_tokens",
        );
      } finally {
        routing.close();
      }
    }
  });

  for (const reason of ["max_tokens", "refusal"]) {
    for (const streaming of [true, false]) {
      it(`preserves routed Claude ${reason} terminals with tools when stream=${streaming}`, async () => {
        const loaded = loadConfig({
          configPath: "/synthetic/config",
          env: {},
          readFile: () =>
            JSON.stringify({
              configVersion: 2,
              accessProfiles: { claude: profile },
              routes: {
                work: {
                  clients: ["codex"],
                  primary: {
                    profile: "claude", model: "claude-sonnet-5-5", effort: "high",
                  },
                  fallbacks: [],
                  affinity: "native-or-explicit",
                  transientTriggers: [],
                },
              },
            }),
        });
        assert.ok(loaded.ok);
        const routing = new SharedRouting(
          loaded.value.config, noopLogger, systemClock,
          async (_, init) => {
            const body = JSON.parse(String(init?.body)) as Item;
            const tool = (body["tools"] as Item[])[0]!;
            const events = [
              {
                type: "message_start",
                message: {
                  id: "synthetic", type: "message", role: "assistant", content: [],
                },
              },
              {
                type: "content_block_start", index: 0,
                content_block: { type: "text", text: "" },
              },
              {
                type: "content_block_delta", index: 0,
                delta: { type: "text_delta", text: "Retained text." },
              },
              { type: "content_block_stop", index: 0 },
              {
                type: "content_block_start", index: 1,
                content_block: {
                  type: "tool_use", id: "unfinished", name: tool["name"], input: {},
                },
              },
              {
                type: "content_block_delta", index: 1,
                delta: { type: "input_json_delta", partial_json: "{}" },
              },
              { type: "content_block_stop", index: 1 },
              {
                type: "message_delta",
                delta: { stop_reason: reason },
                usage: { output_tokens: 5 },
              },
              { type: "message_stop" },
            ];
            return new Response(
              events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
              { headers: { "content-type": "text/event-stream" } },
            );
          },
          { SYNTHETIC_KEY: "synthetic" },
        );
        try {
          const action = routing.actions.create("codex", "thread");
          const received: Item[] = [];
          for await (const event of routing.events(
            {
              model: "work", stream: streaming, input: "request",
              tools: [{
                type: "function", name: "read",
                parameters: { type: "object", properties: {} },
              }],
            },
            "codex", "work", new AbortController().signal,
            routing.actions.context(action.id, "codex"),
          ))
            received.push(event);
          assert.equal(received.at(-1)?.["type"], "response.incomplete");
          const response = received.at(-1)!["response"] as Item;
          assert.equal(response["status"], "incomplete");
          assert.deepEqual(response["incomplete_details"], {
            reason: reason === "max_tokens" ? "max_output_tokens" : "content_filter",
          });
          const output = response["output"] as Item[];
          assert.ok(!output.some((item) => item["type"] === "function_call"));
          const message = output.find((item) => item["type"] === "message")!;
          assert.equal((message["content"] as Item[])[0]!["text"], "Retained text.");
          assert.ok(
            !received.some((event) =>
              event["type"] === "response.function_call_arguments.done" ||
              (event["type"] === "response.output_item.done" &&
                (event["item"] as Item)["type"] === "function_call"),
            ),
          );
        } finally {
          routing.close();
        }
      });
    }
  }

  it("translates late Claude refusal into an explicit incomplete terminal with retained streamed text and no executable tools", async () => {
    const request = reverseRequest({
      model: "claude-sonnet-5",
      input: "request",
      tools: [
        {
          type: "function",
          name: "read",
          parameters: { type: "object", properties: {} },
        },
      ],
    });
    const wire = [...request.tools.keys()][0]!;
    const events = [
      {
        type: "message_start",
        message: {
          id: "synthetic",
          type: "message",
          role: "assistant",
          content: [],
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "I cannot help with that." },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "tool_use",
          id: "call_unfinished",
          name: wire,
          input: {},
        },
      },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "refusal" } },
      { type: "message_stop" },
    ];
    let close!: () => void;
    const gate = new Promise<void>((resolve) => {
      close = resolve;
    });
    const source = async function* () {
      for (const event of events.slice(0, 3))
        yield { data: JSON.stringify(event), event: event.type };
      await gate;
      for (const event of events.slice(3))
        yield { data: JSON.stringify(event), event: event.type };
    };
    const state = new ReverseState();
    const iterator = translateClaudeStream(source(), {
      id: "response_synthetic",
      model: "claude-sonnet-5",
      request,
      state,
      maxBytes: 64 * 1024 * 1024,
    });
    const delivered: Item[] = [];
    while (
      !delivered.some((event) => event["type"] === "response.output_text.delta")
    )
      delivered.push((await iterator.next()).value!);
    assert.equal(delivered.at(-1)!["delta"], "I cannot help with that.");
    assert.ok(
      !delivered.some((event) => event["type"] === "response.incomplete"),
    );
    close();
    for await (const event of iterator) delivered.push(event);
    const terminal = delivered.at(-1)!;
    assert.equal(terminal["type"], "response.incomplete");
    const response = terminal["response"] as Item;
    assert.deepEqual(response["incomplete_details"], {
      reason: "content_filter",
    });
    assert.ok(
      !delivered.some(
        (event) => event["type"] === "response.function_call_arguments.done",
      ),
    );
    const output = response["output"] as Item[];
    assert.equal(
      output.filter((item) => item["type"] === "function_call").length,
      0,
    );
    assert.deepEqual(
      output.find((item) => item["type"] === "message")!["content"],
      [
        {
          type: "output_text",
          text: "I cannot help with that.",
          annotations: [],
        },
      ],
    );
    assert.doesNotThrow(() =>
      reverseRequest(
        {
          model: "claude-sonnet-5",
          input: [
            { role: "user", content: "request" },
            ...output,
            { role: "user", content: "next" },
          ],
        },
        [],
        state,
      ),
    );
  });
});
