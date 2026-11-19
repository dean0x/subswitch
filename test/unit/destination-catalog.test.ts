import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { modelEfforts } from "../../src/routing/destination-catalog.js";
import type { AccessProfile } from "../../src/routing/routing-types.js";

const codexProfile: AccessProfile = {
  provider: "codex",
  product: "chatgpt-codex",
  billing: "subscription",
  account: "synthetic",
  credential: { kind: "native-oauth", authFile: "/synthetic/auth.json" },
};

// Together catalog ids, spelled here so the test does not read the catalog under test.
const TOGETHER_IDS = [
  "Qwen/Qwen3.8-Flash",
  "deepseek-ai/DeepSeek-V4-Pro-0813",
  "deepseek-ai/DeepSeek-V4.1-Flash-1017",
  "zai-org/GLM-5.3",
  "zai-org/GLM-5.3-Flash",
  "moonshotai/Kimi-K3.1-Pro",
];

describe("modelEfforts on a codex profile", () => {
  it("gives no efforts for a Together catalog id, so a codex route to it is refused", () => {
    for (const id of TOGETHER_IDS) assert.equal(modelEfforts(codexProfile, id), undefined, id);
  });

  it("keeps the registry efforts for a codex model id", () => {
    assert.deepEqual(modelEfforts(codexProfile, "gpt-6-astra"), ["low", "medium", "high", "xhigh", "max"]);
  });
});
