import assert from "node:assert/strict";
import { it } from "node:test";
import { isTogetherModelId, TOGETHER_DEFAULT_CAPABILITIES } from "../../src/together-models.js";

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
