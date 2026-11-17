/** Offline subscription fallback. All auth stores and responses are fabricated. */
import assert from "node:assert/strict";
import { it } from "node:test";
import { loadConfig } from "../../src/config.js";
import { noopLogger } from "../../src/logger.js";
import { SharedRouting } from "../../src/routing/shared-routing.js";
import type { Item } from "../../src/routing/routing-types.js";
import { nativeCredential } from "../fixtures/native-profile.js";

it("keeps Claude-subscription to Codex-subscription fallback and its pinned continuation", async () => {
  const loaded = loadConfig({ configPath: "/synthetic/subscriptions.json", env: {}, readFile: () => JSON.stringify({
    configVersion: 2,
    accessProfiles: {
      claude: { provider: "claude", product: "claude-code", billing: "subscription", account: "claude",
        credential: nativeCredential("claude", "synthetic-claude") },
      codex: { provider: "codex", product: "chatgpt-codex", billing: "subscription", account: "codex",
        credential: nativeCredential("codex", "synthetic-codex") },
    },
    routes: { work: { clients: ["claude-code"],
      primary: { profile: "claude", model: "claude-sonnet-5-5", effort: "high" },
      fallbacks: [{ profile: "codex", model: "gpt-6-sol", effort: "high" }],
    } },
  }) });
  assert.ok(loaded.ok);
  const attempts: { url: string; headers: Headers }[] = [];
  const router = new SharedRouting(loaded.value.config, noopLogger, undefined, async (url, init) => {
    attempts.push({ url: String(url), headers: new Headers(init?.headers) });
    if (attempts.length === 1) return new Response(JSON.stringify({ error: { type: "rate_limit_error" } }), { status: 429 });
    return new Response(
      'data: {"type":"response.created","response":{"id":"synthetic","status":"in_progress","output":[]}}\n\n' +
      'data: {"type":"response.completed","response":{"id":"synthetic","status":"completed","output":[]}}\n\n',
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  try {
    const action = router.actions.create("claude-code", "synthetic-thread");
    const context = router.actions.context(action.id, "claude-code");
    const run = async () => {
      const events: Item[] = [];
      for await (const event of router.events({ model: "work", messages: [{ role: "user", content: "ready" }], stream: true },
        "claude-code", "work", new AbortController().signal, context)) events.push(event);
      assert.equal(events.at(-1)?.type, "message_stop");
    };
    await run();
    assert.equal(router.actions.affinity(context, "work").chainIndex, 1);
    await run();
    assert.deepEqual(attempts.map(attempt => attempt.url), [
      "https://api.anthropic.com/v1/messages", "https://chatgpt.com/backend-api/codex/responses", "https://chatgpt.com/backend-api/codex/responses",
    ]);
    assert.deepEqual(attempts.map(attempt => attempt.headers.get("authorization")), [
      "Bearer synthetic-claude", "Bearer synthetic-codex", "Bearer synthetic-codex",
    ]);
    assert.equal(attempts[0]!.headers.has("chatgpt-account-id"), false);
    assert.equal(attempts[1]!.headers.get("chatgpt-account-id"), "synthetic-codex");
    assert.ok(attempts.every(attempt => !attempt.headers.has("x-api-key")));
  } finally {
    router.close();
  }
});
