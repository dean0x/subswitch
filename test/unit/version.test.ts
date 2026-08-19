import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SUBSWITCH_NAME, SUBSWITCH_VERSION } from "../../src/version.js";

const readRepoFile = (relative: string): string =>
  readFileSync(new URL(`../../${relative}`, import.meta.url), "utf8");

const pkg = JSON.parse(readRepoFile("package.json")) as {
  name: string;
  version: string;
};

const lock = JSON.parse(readRepoFile("package-lock.json")) as {
  version: string;
  packages: Record<string, { version?: string }>;
};

/**
 * Keep a Changelog orders release sections newest-first, so the first
 * `## [X.Y.Z]` heading is the release being cut. `## [Unreleased]` does not
 * match the numeric pattern and is skipped.
 */
const newestChangelogVersion = /^## \[(\d+\.\d+\.\d+)\]/m.exec(
  readRepoFile("CHANGELOG.md"),
)?.[1];

describe("version constants", () => {
  it("SUBSWITCH_NAME matches package.json name", () => {
    assert.equal(SUBSWITCH_NAME, pkg.name);
  });

  it("SUBSWITCH_VERSION matches package.json version", () => {
    assert.equal(SUBSWITCH_VERSION, pkg.version);
  });
});

// A release literal lives in five places: src/version.ts, package.json, both
// version fields in package-lock.json, and the newest CHANGELOG.md heading. All
// five are pinned to package.json here and above, so a bump that misses the
// lockfile or the changelog heading turns this file RED (avoids PF-014).
describe("release version literals", () => {
  it("package-lock.json top-level version matches package.json version", () => {
    assert.equal(lock.version, pkg.version);
  });

  it('package-lock.json packages[""] version matches package.json version', () => {
    assert.equal(lock.packages[""]?.version, pkg.version);
  });

  it("CHANGELOG.md has a dated release heading", () => {
    assert.ok(
      newestChangelogVersion,
      "CHANGELOG.md has no `## [X.Y.Z]` release heading",
    );
  });

  it("newest CHANGELOG.md release heading matches package.json version", () => {
    assert.equal(newestChangelogVersion, pkg.version);
  });
});
