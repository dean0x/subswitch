import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ModelPeekSchema } from "../../src/anthropic-wire-types.js";

describe("ModelPeekSchema", () => {
  it("accepts a normal model id", () => {
    const result = ModelPeekSchema.safeParse({ model: "gpt-5.6-sol" });
    assert.ok(result.success);
    assert.equal(result.data.model, "gpt-5.6-sol");
  });

  it("rejects a model string longer than 200 characters (log-injection guard)", () => {
    const longModel = "x".repeat(201);
    const result = ModelPeekSchema.safeParse({ model: longModel });
    assert.ok(!result.success, "model string > 200 chars must be rejected");
  });

  it("accepts a model string exactly 200 characters long", () => {
    const maxModel = "x".repeat(200);
    const result = ModelPeekSchema.safeParse({ model: maxModel });
    assert.ok(result.success, "model string of exactly 200 chars must be accepted");
  });
});
