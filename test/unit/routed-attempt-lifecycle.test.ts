/** Direct caller-owned stages. No dispatcher or compensating cancel can release a claim. */
import assert from "node:assert/strict";
import { it } from "node:test";
import { ClaudeCache } from "../../src/claude-cache.js";
import { noopLogger } from "../../src/logger.js";
import { ProfileAuth } from "../../src/routing/profile-auth.js";
import { RoutedAttempts } from "../../src/routing/routed-attempt.js";
import { StagedCache } from "../../src/routing/replay-cache.js";
import { foreignThinking, rememberThinking } from "../../src/routing/signed-thinking.js";
import { RoutingError, type AccessProfile } from "../../src/routing/routing-types.js";
import { nativeCredential } from "../fixtures/native-profile.js";

const thought = { type: "thinking", thinking: "x".repeat(1024), signature: "caller-owned-import" };

async function preparedImport() {
  const profile: AccessProfile = { provider: "claude", product: "claude-code", billing: "subscription",
    account: "synthetic", credential: nativeCredential("claude", "stage-lifetime") };
  const shared = new ClaudeCache({ maxEntries: 2, maxBytes: 2048 }, true);
  const attempts = new RoutedAttempts(new ProfileAuth({ native: profile }, noopLogger), noopLogger,
    async () => new Response([
      { type: "message_start", message: { id: "synthetic", type: "message", role: "assistant", content: [] } },
      { type: "message_delta", delta: { stop_reason: "end_turn" } }, { type: "message_stop" },
    ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } }));
  Object.defineProperty(attempts, "replay", { value: shared });
  const controller = new AbortController();
  const ready = await attempts.prepare({ profile, target: { profile: "native", model: "claude-sonnet-5", effort: "high" },
    body: { model: "work", max_tokens: 128, messages: [{ role: "user", content: "first" },
      { role: "assistant", content: [thought] }, { role: "user", content: "continue" }] },
    protocol: "messages", conversation: "original", allowNativeThinkingReplay: true,
    signal: controller.signal, refreshes: new Set() });
  assert.equal(shared.size, 1, "prepare must hold a real cold-import claim");
  assert.equal(foreignThinking(shared, thought.signature, "other", "other"), true);
  return { shared, ready, controller };
}

function assertClaimReleased(shared: ClaudeCache) {
  const next = new StagedCache(shared);
  try {
    assert.doesNotThrow(() => {
      rememberThinking(next, "other", "other", thought);
      next.preflight();
    }, "another caller must acquire the same signature without cancel()");
  } finally { next.dispose(); }
}

it("releases a real import claim after a real commit fails without cancel", async () => {
  const { shared, ready } = await preparedImport();
  for await (const _event of ready.events) { /* finish the synthetic native response */ }
  // The pending claim fits. The full imported block plus this concurrent entry does not.
  const competing = "x".repeat(1024);
  shared.put("adapted", competing, true);
  assert.throws(() => ready.commit(), (error: unknown) => error instanceof RoutingError &&
    error.code === "continuation_store_full" && error.status === 503);
  assert.equal(shared.get("adapted", competing), true);
  shared.delete("adapted", competing);
  assertClaimReleased(shared);
});

it("releases a real import claim on abort after prepare without commit or cancel", async () => {
  const { shared, controller } = await preparedImport();
  controller.abort();
  assertClaimReleased(shared);
});
