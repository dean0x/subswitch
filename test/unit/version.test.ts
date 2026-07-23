import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SUBSWITCH_NAME, SUBSWITCH_VERSION } from "../../src/version.js";

const pkg = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { name: string; version: string };

describe("version constants", () => {
  it("SUBSWITCH_NAME matches package.json name", () => {
    assert.equal(SUBSWITCH_NAME, pkg.name);
  });

  it("SUBSWITCH_VERSION matches package.json version", () => {
    assert.equal(SUBSWITCH_VERSION, pkg.version);
  });
});
