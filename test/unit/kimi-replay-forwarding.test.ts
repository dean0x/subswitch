/** Forwarding only: actual gateway attempts/cache, fabricated auth boundary and transport. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../../src/config.js";
import { buildDeps } from "../../src/server.js";
import { noopLogger } from "../../src/logger.js";
import { aggregateFrames } from "../../src/codex-response.js";
import type { BoundCredential } from "../../src/routing/profile-auth.js";
import type { Item } from "../../src/routing/routing-types.js";
import { OrderedReplayDiagnostics, type OrderedReplayDiagnostic } from "../../src/routing/replay-cache.js";
import { ordered, response, wire } from "../helpers/kimi-ordered-route.js";
import { added, created, done, terminal, textItem } from "../helpers/kimi-responses-bridge.js";

test("buildDeps forwards closed publication/lookup diagnostics without changing real attempts", async t => {
  const outcomes: unknown[] = [];
  for (const enabled of [false, true]) {
    const diagnostics: Readonly<OrderedReplayDiagnostic>[] = [];
    const profile = { provider: "kimi", product: "kimi-code", region: "global", billing: "subscription", account: "fabricated",
      credential: { kind: "native-oauth", authFile: "/fabricated/never-read" } };
    const target = { profile: "fixture", model: "kimi-for-coding", effort: "high" };
    const config = loadConfig({ configPath: "/fabricated/config", env: {}, readFile: () => JSON.stringify({ configVersion: 2,
      accessProfiles: { fixture: profile }, routes: { work: { clients: ["claude-code"], primary: target, fallbacks: [] } } }) });
    assert(config.ok);
    let dispatches = 0;
    const sent: unknown[] = [];
    const built = buildDeps(config.value.config, noopLogger, { env: {},
      ...(enabled ? { orderedReplayDiagnostics: new OrderedReplayDiagnostics(e => diagnostics.push(e)) } : {}),
      fetchImpl: async (_url, init) => {
        dispatches++; sent.push(JSON.parse(String(init?.body)));
        const item = textItem("message", ["fabricated private reply"]);
        return response(wire([created(), added(0, { ...item, content: [], status: "in_progress" }), done(0, item), terminal([item])]));
      } });
    assert(built.ok);
    const router = built.value.sharedRouting!;
    // Native codec selection requires native-oauth. Stub only credential validation/
    // identity on the actual auth object; never replace attempts/cache or read a file.
    const credential: BoundCredential = { provider: "kimi", profile: "fixture", generation: "fabricated-generation",
      binding: "fabricated-binding", authHeaders: { authorization: "Bearer fabricated-only" } };
    const validate = t.mock.method(router.attempts.auth, "validate", (c: BoundCredential) => { assert.equal(c, credential); });
    const identity = t.mock.method(router.attempts.auth, "identity", () => ({ "user-agent": "subswitch/fabricated" }));
    try {
      const action = router.actions.context(router.actions.create("claude-code", "fabricated-conversation").id, "claude-code");
      const run = async (body: Item) => {
        const ready = await router.attempts.prepare({ profile: config.value.config.accessProfiles!.fixture!, target,
          body, protocol: "messages", conversation: "fabricated-conversation", route: "work", action,
          signal: new AbortController().signal, refreshes: new Set(), credential });
        const seen: Item[] = [];
        try { for await (const event of ready.events) seen.push(event.payload); ready.commit(); }
        finally { await ready.cancel(); }
        const result = aggregateFrames(seen.map(e => wire([e])), "codex");
        assert(result.ok && result.value.kind === "message");
        return result.value.message.content;
      };
      const first = ordered(), content = await run(first);
      const second = await run({ ...first, messages: [...first.messages as Item[],
        { role: "assistant", content }, { role: "user", content: "continue" }] });
      assert.equal(dispatches, 2);
      if (enabled) {
        assert.deepEqual(diagnostics.map(d => d.event), ["staged", "published", "lookup", "staged", "published"]);
        assert.deepEqual(diagnostics[2], { event: "lookup", reference: "last_staged", sameScope: true,
          samePrefix: true, sameStore: true, recordPresent: true, committed: true });
        for (const d of diagnostics) {
          assert(Object.isFrozen(d));
          assert.deepEqual(Object.keys(d).sort(), ["committed", "event", "recordPresent", "reference", "samePrefix", "sameScope", "sameStore"]);
        }
        assert(!JSON.stringify(diagnostics).includes("fabricated"));
      } else assert.deepEqual(diagnostics, []);
      outcomes.push({ sent, content, second, dispatches });
    } finally { validate.mock.restore(); identity.mock.restore(); router.close(); }
  }
  assert.deepEqual(outcomes[0], outcomes[1]);
});
