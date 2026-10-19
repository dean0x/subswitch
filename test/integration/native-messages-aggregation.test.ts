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
import { messageFrames, nativeContent, nativeEvents } from "../fixtures/native-messages.js";

async function fixture(output = nativeEvents()) {
  const root = mkdtempSync(join(tmpdir(), "subswitch-native-aggregate-"));
  const origin = "http://127.0.0.1:1";
  const loaded = loadConfig({ configPath: join(root, "config.json"), env: {}, readFile: () => JSON.stringify({
    configVersion: 2,
    anthropic: { baseUrl: `${origin}/unexpected` },
    providers: { codex: { baseUrl: `${origin}/unexpected-codex`, oauthTokenUrl: `${origin}/unexpected-refresh`, authFile: join(root, "absent-codex.json") } },
    codexIngress: { subscriptionBaseUrl: `${origin}/unexpected-subscription`, apiBaseUrl: `${origin}/unexpected-api`,
      claude: { baseUrl: `${origin}/unexpected-claude`, oauthTokenUrl: `${origin}/unexpected-claude-refresh`,
        authFile: join(root, "absent-claude.json"), configDir: join(root, "absent-claude") } },
    accessProfiles: Object.fromEntries(["native", "other"].map(account => [account, {
      provider: "claude", product: "anthropic-api", billing: "api", account,
      baseUrl: `${origin}/${account}`, credential: { kind: "env", name: "FABRICATED_KEY" },
    }])),
    routes: Object.fromEntries(["native", "other"].map(profile => [profile, {
      clients: ["claude-code"], primary: { profile, model: "claude-sonnet-5", effort: "high" },
    }])),
  }) });
  assert.ok(loaded.ok);
  const requests: Item[] = [];
  const deps = buildDeps(loaded.value.config, noopLogger, { env: { FABRICATED_KEY: "fabricated-profile-key" }, fetchImpl: async (url, init) => {
    assert.equal(String(url), `${origin}/native/v1/messages`, "unexpected upstream blocked before any socket");
    assert.equal(init?.redirect, "error");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), null);
    assert.equal(headers.get("x-api-key"), "fabricated-profile-key");
    requests.push(JSON.parse(String(init?.body)) as Item);
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
  if (!stream) return (await response.json() as Item).content as Item[];
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
        const preserved = JSON.stringify(messages);
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
        assert.equal(JSON.stringify(messages), preserved);
        messages.push({ role: "assistant", content: "Complete" }, { role: "user", content: "Next turn" });
        await contentOf(await rig.send(messages, stream), stream);
        assert.deepEqual(rig.requests[2]!.messages, messages);
        assert.equal(rig.requests.length, 3);
      } finally { await rig.close(); }
    });
  }

  for (const failure of ["missing terminal", "unsupported block", "unsupported delta", "invalid tool JSON"]) {
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
        assert.match(await response.text(), /missing_provider_terminal|invalid_provider_block|invalid_provider_delta|invalid_provider_tool/);
        assert.equal(rig.requests.length, 1);
      } finally { await rig.close(); }
    });
  }
});
