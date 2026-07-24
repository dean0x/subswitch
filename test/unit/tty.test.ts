import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveColorEnabled } from "../../src/tty.js";

describe("resolveColorEnabled", () => {
  it("returns isTTY=true when no color env vars set", () => {
    assert.equal(resolveColorEnabled({}, true), true);
  });

  it("returns isTTY=false when no color env vars set", () => {
    assert.equal(resolveColorEnabled({}, false), false);
  });

  it("FORCE_COLOR=1 enables color regardless of isTTY=false", () => {
    assert.equal(resolveColorEnabled({ FORCE_COLOR: "1" }, false), true);
  });

  it("FORCE_COLOR=1 beats NO_COLOR presence (FORCE_COLOR wins)", () => {
    assert.equal(resolveColorEnabled({ FORCE_COLOR: "1", NO_COLOR: "" }, false), true);
  });

  it("FORCE_COLOR=0 does not force color — falls through to isTTY=true", () => {
    assert.equal(resolveColorEnabled({ FORCE_COLOR: "0" }, true), true);
  });

  it("FORCE_COLOR=0 does not force color — falls through to isTTY=false", () => {
    assert.equal(resolveColorEnabled({ FORCE_COLOR: "0" }, false), false);
  });

  it("FORCE_COLOR empty string does not force color", () => {
    assert.equal(resolveColorEnabled({ FORCE_COLOR: "" }, false), false);
  });

  it("NO_COLOR present with empty string disables color (presence semantics)", () => {
    assert.equal(resolveColorEnabled({ NO_COLOR: "" }, true), false);
  });

  it("NO_COLOR present with any value disables color (value irrelevant)", () => {
    assert.equal(resolveColorEnabled({ NO_COLOR: "1" }, true), false);
  });

  it("NO_COLOR present disables color even when isTTY=true", () => {
    assert.equal(resolveColorEnabled({ NO_COLOR: "anything" }, true), false);
  });

  it("NO_COLOR absent, isTTY=false → false", () => {
    assert.equal(resolveColorEnabled({}, false), false);
  });
});
