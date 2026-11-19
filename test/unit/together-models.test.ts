import assert from "node:assert/strict";
import { it } from "node:test";
import { isTogetherModelId, TOGETHER_DEFAULT_CAPABILITIES, TOGETHER_MODELS } from "../../src/together-models.js";

// No live check has confirmed price or image support yet, so every row is UNCONFIRMED.
const UNCONFIRMED = { price: false, images: false };
const row = { maxOutputTokens: 16_384, reasoningReplay: true, confirmed: UNCONFIRMED };

it("holds the six Together catalog rows with their exact data", () => {
  assert.deepEqual(TOGETHER_MODELS, [
    { ...row, name: "Qwen3.8 Flash", id: "Qwen/Qwen3.8-Flash", family: "qwen3.8-flash",
      contextWindow: 1_000_000, images: true, priceInPerMTokens: 0.15, priceOutPerMTokens: 0.47 },
    { ...row, name: "DeepSeek V4 Pro", id: "deepseek-ai/DeepSeek-V4-Pro-0813", family: "deepseek-v4-pro",
      contextWindow: 1_048_576, images: false, priceInPerMTokens: 1.32, priceOutPerMTokens: 3.96 },
    { ...row, name: "DeepSeek V4.1 Flash", id: "deepseek-ai/DeepSeek-V4.1-Flash-1017", family: "deepseek-v4.1-flash",
      contextWindow: 1_000_000, images: true, priceInPerMTokens: 0.30, priceOutPerMTokens: 1.20 },
    { ...row, name: "GLM-5.3", id: "zai-org/GLM-5.3", family: "glm-5.3",
      contextWindow: 1_048_575, images: false, priceInPerMTokens: 1.40, priceOutPerMTokens: 4.40 },
    { ...row, name: "GLM-5.3 Flash", id: "zai-org/GLM-5.3-Flash", family: "glm-5.3-flash",
      contextWindow: 1_048_575, images: true, priceInPerMTokens: 0.15, priceOutPerMTokens: 0.50 },
    { ...row, name: "Kimi K3.1 Pro", id: "moonshotai/Kimi-K3.1-Pro", family: "kimi-k3.1-pro",
      contextWindow: 1_048_576, images: true, priceInPerMTokens: 2.00, priceOutPerMTokens: 10.00 },
  ]);
});

it("turns off inline images only for GLM-5.3 and DeepSeek V4 Pro", () => {
  assert.deepEqual(
    TOGETHER_MODELS.filter((model) => !model.images).map((model) => model.id),
    ["deepseek-ai/DeepSeek-V4-Pro-0813", "zai-org/GLM-5.3"],
  );
});

it("gives each catalog row its own family and an id that passes the Together id grammar", () => {
  assert.equal(new Set(TOGETHER_MODELS.map((model) => model.family)).size, 6);
  assert.deepEqual(TOGETHER_MODELS.filter((model) => !isTogetherModelId(model.id)), []);
});

it("accepts Together model IDs that match the grammar and length limit", () => {
  for (const id of ["A", "a0", "org/Model_1.0:variant-2", "a".repeat(200)]) {
    assert.equal(isTogetherModelId(id), true, JSON.stringify(id));
  }
});

it("rejects Together model IDs outside the grammar or length limit", () => {
  for (const id of ["", "/org/model", "model name", "model\r\n", "model|suffix", "é-model", "a".repeat(201)]) {
    assert.equal(isTogetherModelId(id), false, JSON.stringify(id));
  }
});

it("leaves unknown model limits unset and permits image and reasoning replay", () => {
  assert.deepEqual(TOGETHER_DEFAULT_CAPABILITIES, {
    contextWindow: undefined,
    maxOutputTokens: undefined,
    images: true,
    reasoningReplay: true,
  });
});
