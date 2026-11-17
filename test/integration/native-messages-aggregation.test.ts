/** Fabricated output through the production HTTP ingress; all state and endpoints are owned. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadConfig } from "../../src/config.js";
import { noopLogger } from "../../src/logger.js";
import type { Item } from "../../src/routing/routing-types.js";
import { buildDeps, createProxyServer, listenServer } from "../../src/server.js";
import { invalidSignedCases, invalidSignedEvents, messageFrames, nativeContent, nativeEvents } from "../fixtures/native-messages.js";

async function fixture(
  output = nativeEvents(),
  destination: "anthropic" | "custom" | "kimi" = "anthropic",
  followup?: (request: Item) => Response,
) {
  const root = mkdtempSync(join(tmpdir(), "subswitch-native-aggregate-"));
  const origin = "http://127.0.0.1:1";
  const loaded = loadConfig({ configPath: join(root, "config.json"), env: {}, readFile: () => JSON.stringify({
    configVersion: 2,
    anthropic: { baseUrl: `${origin}/unexpected` },
    providers: { codex: { baseUrl: `${origin}/unexpected-codex`, oauthTokenUrl: `${origin}/unexpected-refresh`, authFile: join(root, "absent-codex.json") } },
    codexIngress: { subscriptionBaseUrl: `${origin}/unexpected-subscription`, apiBaseUrl: `${origin}/unexpected-api`,
      claude: { baseUrl: `${origin}/unexpected-claude`, oauthTokenUrl: `${origin}/unexpected-claude-refresh`,
        authFile: join(root, "absent-claude.json"), configDir: join(root, "absent-claude") } },
    accessProfiles: Object.fromEntries(["native", "other", "origin"].map(account => {
      const kimi = destination === "kimi" && account !== "origin";
      return [account, {
        provider: kimi ? "kimi" : "claude", product: kimi ? "kimi-code" : "anthropic-api",
        billing: kimi ? "subscription" : "api", account,
        ...(kimi ? { region: "global" } : {}),
        baseUrl: destination === "anthropic" || account === "origin" ? "https://api.anthropic.com" : `${origin}/${account}`,
        credential: { kind: "env", name: "FABRICATED_KEY" },
      }];
    })),
    routes: Object.fromEntries(["native", "other", "origin"].map(profile => [profile, {
      clients: ["claude-code"], primary: { profile,
        model: destination === "kimi" && profile !== "origin" ? "k3" : "claude-sonnet-5", effort: "high" },
    }])),
  }) });
  assert.ok(loaded.ok);
  const requests: Item[] = [];
  const upstreams: string[] = [];
  const deps = buildDeps(loaded.value.config, noopLogger, { env: { FABRICATED_KEY: "fabricated-profile-key" }, fetchImpl: async (url, init) => {
    assert.ok(["https://api.anthropic.com/v1/messages",
      ...(destination === "anthropic" ? [] : [`${origin}/native/v1/messages`, `${origin}/other/v1/messages`])].includes(String(url)),
      "unexpected upstream blocked before any socket");
    upstreams.push(String(url));
    assert.equal(init?.redirect, "error");
    const headers = new Headers(init?.headers);
    const kimi = destination === "kimi" && String(url) !== "https://api.anthropic.com/v1/messages";
    assert.equal(headers.get("authorization"), kimi ? "Bearer fabricated-profile-key" : null);
    assert.equal(headers.get("x-api-key"), kimi ? null : "fabricated-profile-key");
    const request = JSON.parse(String(init?.body)) as Item;
    requests.push(request);
    if (requests.length > 1 && followup) return followup(request);
    return new Response(messageFrames(requests.length === 1 ? output : nativeEvents([{ type: "text", text: "Complete" }])).join(""), {
      headers: { "content-type": "text/event-stream" },
    });
  } });
  assert.ok(deps.ok);
  const server = createProxyServer(deps.value);
  const listening = await listenServer(server, 0, "127.0.0.1");
  assert.ok(listening.ok);
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    requests,
    upstreams,
    origin,
    async send(messages: Item[], stream = false, model = "native") {
      return fetch(`http://127.0.0.1:${address.port}/v1/messages`, { method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer fabricated-incoming" },
        body: JSON.stringify({ model, stream, messages }), signal: AbortSignal.timeout(5000) });
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      deps.value.sharedRouting?.close();
      deps.value.forwardOpenai?.close();
      deps.value.forwardAnthropic.close?.();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Independent fixture client, preserving blocks by index rather than stop arrival. */
async function contentOf(response: Response, stream: boolean): Promise<Item[]> {
  assert.equal(response.status, 200);
  if (!stream) {
    const message = await response.json() as Item;
    assert.deepEqual(message.usage, { input_tokens: 7, output_tokens: 9 });
    return message.content as Item[];
  }
  const events = (await response.text()).split("\n\n").flatMap(frame => {
    const data = frame.split("\n").find(line => line.startsWith("data: "));
    return data ? [JSON.parse(data.slice(6)) as Item] : [];
  });
  assert.equal(events.at(-1)?.type, "message_stop");
  const blocks: Item[] = [];
  const argumentsByIndex = new Map<number, string>();
  for (const event of events) {
    const index = Number(event.index);
    if (event.type === "content_block_start") blocks[index] = event.content_block as Item;
    if (event.type === "content_block_delta") {
      const delta = event.delta as Item, block = blocks[index]!;
      if (delta.type === "input_json_delta") argumentsByIndex.set(index, (argumentsByIndex.get(index) ?? "") + String(delta.partial_json));
      for (const field of ["text", "thinking", "signature"]) if (delta.type === `${field}_delta`) block[field] = String(block[field] ?? "") + String(delta[field]);
    }
    if (event.type === "content_block_stop" && blocks[index]?.type === "tool_use") blocks[index]!.input = JSON.parse(argumentsByIndex.get(index) ?? "{}");
  }
  return blocks;
}

describe("native Messages HTTP aggregation", () => {
  for (const stream of [false, true]) {
    it(`returns exact signed content and replays that returned tool history with stream=${stream}`, async () => {
      const rig = await fixture();
      try {
        const messages: Item[] = [{ role: "user", content: "Read fixture.txt" }];
        const content = await contentOf(await rig.send(messages, stream), stream);
        assert.deepEqual(content, nativeContent);
        assert.equal(JSON.stringify(content.slice(0, 2)), JSON.stringify(nativeContent.slice(0, 2)));
        messages.push({ role: "assistant", content }, { role: "user", content: [
          { type: "tool_result", tool_use_id: "toolu_fixture", content: "fabricated file content" },
          { type: "text", text: "Continue" },
        ] });
        const changed = structuredClone(messages);
        ((changed[1]!.content as Item[])[0]!).thinking = "tampered";
        for (const [history, model] of [[changed, "native"], [messages, "other"]] as const) {
          const rejected = await rig.send(history, stream, model);
          assert.equal(rejected.status, 409);
          assert.match(await rejected.text(), /foreign_opaque_state/);
        }
        assert.equal(rig.requests.length, 1, "tamper and other-profile replay must not dispatch");
        assert.deepEqual(await contentOf(await rig.send(messages, stream), stream), [{ type: "text", text: "Complete" }]);
        assert.deepEqual(rig.requests[1]!.messages, messages);
        messages.push({ role: "assistant", content: "Complete" }, { role: "user", content: "Next turn" });
        await contentOf(await rig.send(messages, stream), stream);
        assert.deepEqual(rig.requests[2]!.messages, messages);
        assert.equal(rig.requests.length, 3);
      } finally { await rig.close(); }
    });
  }

  for (const destination of ["custom", "kimi"] as const) {
    it(`keeps exact same-scope ${destination} continuation and rejects another scope before dispatch`, async () => {
      const rig = await fixture(nativeEvents(), destination);
      try {
        const messages: Item[] = [{ role: "user", content: "Read fixture.txt" }];
        const content = await contentOf(await rig.send(messages), false);
        messages.push({ role: "assistant", content }, { role: "user", content: [
          { type: "tool_result", tool_use_id: "toolu_fixture", content: "fabricated file content" },
        ] });
        const foreign = await rig.send(messages, false, "other");
        assert.equal(foreign.status, 409);
        assert.match(await foreign.text(), /foreign_opaque_state/);
        assert.equal(rig.requests.length, 1);
        assert.deepEqual(await contentOf(await rig.send(messages), false), [{ type: "text", text: "Complete" }]);
        assert.deepEqual(rig.requests[1]!.messages, messages);
        assert.deepEqual(rig.upstreams, Array(2).fill(`${rig.origin}/native/v1/messages`));
        // Unvalidated output has no native ownership claim, even at an Anthropic destination.
        const nativeImport = await rig.send(messages, false, "origin");
        assert.equal(nativeImport.status, 409);
        assert.match(await nativeImport.text(), /foreign_opaque_state/);
        assert.equal(rig.requests.length, 2, "unvalidated cross-scope history must not dispatch");
      } finally { await rig.close(); }
    });
  }

  for (const stream of [false, true]) {
    it(`preserves an empty thought with a delta-only signature with stream=${stream}`, async () => {
      const content = [{ type: "thinking", thinking: "", signature: "fabricated-deferred-signature" }];
      const rig = await fixture(nativeEvents(content, { signatureInDeltas: true }));
      try {
        const messages: Item[] = [{ role: "user", content: "Fixture" }];
        assert.deepEqual(await contentOf(await rig.send(messages, stream), stream), content);
        messages.push({ role: "assistant", content }, { role: "user", content: "Continue" });
        assert.deepEqual(await contentOf(await rig.send(messages, stream), stream), [{ type: "text", text: "Complete" }]);
        assert.deepEqual(rig.requests[1]!.messages, messages);
      } finally { await rig.close(); }
    });
  }

  it("returns the matched native stop sequence in a nonstream response", async () => {
    const events = nativeEvents([{ type: "text", text: "Complete" }]);
    events[events.length - 2]!.delta = { stop_reason: "stop_sequence", stop_sequence: "\nEND α" };
    const rig = await fixture(events);
    try {
      const response = await rig.send([{ role: "user", content: "Fixture" }]);
      assert.equal(response.status, 200);
      const message = await response.json() as Item;
      assert.equal(message.stop_reason, "stop_sequence");
      assert.equal(message.stop_sequence, "\nEND α");
    } finally { await rig.close(); }
  });

  for (const testCase of invalidSignedCases) {
    it(`returns 502 for ${testCase.name} without publishing the valid signed prefix`, async () => {
      const rig = await fixture(invalidSignedEvents(testCase), "anthropic", request => {
        const messages = request.messages as Item[];
        const content = messages[1]!.content as Item[];
        if (content[0]!.thinking === "Changed failed prefix") return new Response(
          '{"error":{"type":"invalid_request_error"}}', { status: 400 },
        );
        return new Response(messageFrames(nativeEvents([{ type: "text", text: "Complete" }])).join(""), {
          headers: { "content-type": "text/event-stream" },
        });
      });
      try {
        const messages: Item[] = [{ role: "user", content: "Read fixture.txt" }];
        const response = await rig.send(messages);
        assert.equal(response.status, 502);
        assert.deepEqual(await response.json(), { type: "error", error: { type: "api_error", message: testCase.code } });
        messages.push({ role: "assistant", content: [nativeContent[0]!, nativeContent[3]!] }, { role: "user", content: [
          { type: "tool_result", tool_use_id: "toolu_fixture", content: "fabricated file content" },
        ] });
        const foreign = await rig.send(messages, false, "other");
        assert.equal(foreign.status, 409, "emitted provenance must survive a failed response");
        assert.match(await foreign.text(), /foreign_opaque_state/);
        assert.equal(rig.requests.length, 1, "another account must not dispatch");
        // A scoped record would reject this change locally. Provenance alone leaves validation to Anthropic.
        const changed = structuredClone(messages);
        (changed[1]!.content as Item[])[0]!.thinking = "Changed failed prefix";
        const unvalidated = await rig.send(changed);
        assert.equal(unvalidated.status, 400, "failed output must not publish a scoped signed block");
        assert.match(await unvalidated.text(), /invalid_request/);
        assert.deepEqual(rig.requests[1]!.messages, changed);
        assert.deepEqual(await contentOf(await rig.send(messages), false), [{ type: "text", text: "Complete" }]);
        assert.deepEqual(rig.requests[2]!.messages, messages);
        assert.deepEqual(rig.upstreams, Array(3).fill("https://api.anthropic.com/v1/messages"));
      } finally { await rig.close(); }
    });
  }

  const failureCodes = {
    "missing terminal": "missing_provider_terminal",
    "unsupported block": "invalid_provider_block",
    "unsupported delta": "invalid_provider_delta",
    "invalid tool JSON": "invalid_provider_tool",
  } as const;
  for (const [failure, code] of Object.entries(failureCodes)) {
    it(`rejects ${failure} before returning a nonstream success`, async () => {
      const events = nativeEvents();
      if (failure === "missing terminal") events.pop();
      if (failure === "unsupported block") (events[1]!.content_block as Item).type = "future_unsupported";
      if (failure === "unsupported delta") (events[2]!.delta as Item).type = "future_unsupported_delta";
      if (failure === "invalid tool JSON") {
        const delta = events.find(event => (event.delta as Item | undefined)?.type === "input_json_delta")!.delta as Item;
        delta.partial_json = "INVALID";
      }
      const rig = await fixture(events);
      try {
        const response = await rig.send([{ role: "user", content: "Read fixture.txt" }]);
        assert.equal(response.status, 502);
        assert.deepEqual(await response.json(), { type: "error", error: { type: "api_error", message: code } });
        assert.equal(rig.requests.length, 1);
      } finally { await rig.close(); }
    });
  }
});
