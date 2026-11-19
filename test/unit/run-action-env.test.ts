import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { childEnvWithoutTogetherKey } from "../../src/run-action.js";
import keys from "../fixtures/together/keys.json" with { type: "json" };

describe("childEnvWithoutTogetherKey", () => {
  it("drops the Together key name in every letter case and keeps other names", () => {
    const parent = {
      TOGETHER_API_KEY: keys.primary,
      together_api_key: keys.secondary,
      Together_Api_Key: keys.primary,
      HOME: "/home/user",
    };

    assert.deepEqual(childEnvWithoutTogetherKey(parent), { HOME: "/home/user" });
  });

  it("leaves the parent env unchanged", () => {
    const parent = {
      TOGETHER_API_KEY: keys.primary,
      Together_Api_Key: keys.secondary,
      HOME: "/home/user",
    };
    const before = { ...parent };

    childEnvWithoutTogetherKey(parent);

    assert.deepEqual(parent, before);
  });
});
