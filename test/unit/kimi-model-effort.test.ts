/** Fabricated requests only: current Kimi Code model and effort contract. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../../src/config.js";
import { ClaudeCache } from "../../src/claude-cache.js";
import { ReverseState } from "../../src/claude-state.js";
import { KIMI_MODELS, modelEfforts } from "../../src/routing/destination-catalog.js";
import { adaptRequest } from "../../src/routing/request-adapter.js";
import { decodePortableHistory } from "../../src/routing/portable-history.js";
import type { AccessProfile, Item } from "../../src/routing/routing-types.js";

const profile: AccessProfile = {
  provider: "kimi", product: "kimi-code", region: "global", billing: "subscription",
  account: "fabricated", credential: { kind: "native-oauth", authFile: "/fabricated/kimi/auth.json" },
};
function config(model: string, effort: string) {
  return loadConfig({ configPath: "/fabricated/config.json", env: {}, readFile: () => JSON.stringify({
    configVersion: 2, accessProfiles: { kimi: profile },
    routes: { greeting: { clients: ["codex", "claude-code"], primary: { profile: "kimi", model, effort }, fallbacks: [], affinity: "native-or-explicit", transientTriggers: [] } },
  }) });
}

test("current K3.1 IDs accept canonical efforts; fixed-thinking Highspeed and unknown values fail explicitly", () => {
  for (const model of KIMI_MODELS["kimi-code"]) {
    for (const effort of ["low", "high", "max"]) {
      const loaded = config(model, effort);
      assert.equal(loaded.ok, model !== "kimi-for-coding-highspeed", `${model}/${effort}`);
      if (!loaded.ok) assert.match(loaded.error.message, /unsupported_effort/);
    }
  }
  assert.deepEqual(modelEfforts(profile, "kimi-for-coding-highspeed"), []);
  for (const effort of ["medium", "xhigh", "ultra", "none", "off", "unexpected"]) {
    const loaded = config("k3.1-pro", effort);
    assert.equal(loaded.ok, false);
    if (!loaded.ok) assert.match(loaded.error.message, /unsupported_effort/);
  }
  assert.equal(config("K3.1 Pro", "high").ok, false, "do not send misspelled IDs that can fall back upstream");
});

for (const protocol of ["messages", "responses"] as const) {
  for (const effort of ["low", "high", "max"]) {
    test(`${protocol} preserves caller instructions/tools/history and sends exact ${effort} to K3.1`, () => {
      const body: Item = protocol === "messages" ? {
        model: "greeting", max_tokens: 256, system: "Caller instruction",
        messages: [{ role: "user", content: "Caller history" }],
        tools: [{ name: "caller_read", input_schema: { type: "object", properties: {} } }],
        thinking: { type: "disabled", budget_tokens: 9999 }, output_config: { effort: "medium" },
      } : {
        model: "greeting", max_output_tokens: 256, instructions: "Caller instruction",
        input: [{ role: "user", content: "Caller history" }],
        tools: [{ type: "function", name: "caller_read", parameters: { type: "object", properties: {} } }],
        reasoning: { effort: "none" },
      };
      const before = JSON.stringify(body), stage = new ClaudeCache();
      const outbound = adaptRequest({ profile, target: { profile: "kimi", model: "k3.1-pro", effort },
        body, ingress: protocol, protocol, transcript: decodePortableHistory(body, protocol),
        stage, state: new ReverseState(undefined, undefined, stage), owner: "owner",
        conversation: "conversation", sessionId: "session",
      }).outbound;
      assert.equal(outbound.model, "k3.1-pro");
      assert.equal(outbound[protocol === "messages" ? "max_tokens" : "max_output_tokens"], 256);
      assert.equal(outbound[protocol === "messages" ? "system" : "instructions"], "Caller instruction");
      assert.deepEqual(outbound.tools, body.tools);
      assert.deepEqual(outbound[protocol === "messages" ? "messages" : "input"], body[protocol === "messages" ? "messages" : "input"]);
      assert.deepEqual(outbound[protocol === "messages" ? "output_config" : "reasoning"], { effort });
      if (protocol === "messages") assert.deepEqual(outbound.thinking, { type: "enabled" });
      assert.equal(JSON.stringify(body), before);
    });
  }
}
