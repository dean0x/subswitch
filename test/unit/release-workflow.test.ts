import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";

const repoRoot = new URL("../../", import.meta.url);
const workflowsDir = new URL(".github/workflows/", repoRoot);

const workflowFiles = readdirSync(workflowsDir).filter((name) =>
  /\.ya?ml$/.test(name),
);

const readWorkflow = (name: string): string =>
  readFileSync(new URL(name, workflowsDir), "utf8");

/**
 * The npm package publishes through npm trusted publishing (OIDC). A token
 * name in any workflow would bring back a token path for the publish.
 * `_auth` also matches `_authToken`.
 */
const TOKEN_NAMES = [
  "NPM_TOKEN",
  "NODE_AUTH_TOKEN",
  "_auth",
  "_password",
] as const;

/** Trusted publishing needs npm 11.5.1 or newer. */
const MIN_TRUSTED_NPM = [11, 5, 1] as const;

const atLeast = (
  version: readonly number[],
  min: readonly number[],
): boolean => {
  for (const [i, part] of min.entries()) {
    const got = version[i] ?? 0;
    if (got !== part) return got > part;
  }
  return true;
};

describe("release workflow", () => {
  it("finds the workflow files", () => {
    assert.ok(workflowFiles.includes("release.yml"));
  });

  for (const name of workflowFiles) {
    it(`${name} names no npm token`, () => {
      const text = readWorkflow(name);
      for (const token of TOKEN_NAMES) {
        assert.ok(!text.includes(token), `${name} names ${token}`);
      }
    });
  }

  it("the repo root has no .npmrc", () => {
    assert.equal(existsSync(new URL(".npmrc", repoRoot)), false);
  });

  it("release.yml uses no secrets", () => {
    assert.ok(!readWorkflow("release.yml").includes("secrets."));
  });

  it("release.yml gives setup-node no registry-url", () => {
    // With registry-url, setup-node writes an npm token line to .npmrc.
    assert.doesNotMatch(readWorkflow("release.yml"), /^\s*registry-url:/m);
  });

  it("release.yml runs no dependency install scripts", () => {
    const text = readWorkflow("release.yml");
    assert.match(text, /^\s*run: npm ci --ignore-scripts\s*$/m);
    assert.doesNotMatch(text, /^\s*run: npm ci\s*$/m);
  });

  it("release.yml restores no npm cache", () => {
    assert.doesNotMatch(readWorkflow("release.yml"), /^\s*cache:/m);
  });

  it("release.yml can request the workflow identity token", () => {
    assert.match(readWorkflow("release.yml"), /^\s*id-token:\s*write\s*$/m);
  });

  it("release.yml publishes with a pinned npm that has trusted publishing", () => {
    const match =
      /^\s*run: npx -y npm@(\d+)\.(\d+)\.(\d+) publish --provenance --access public\s*$/m.exec(
        readWorkflow("release.yml"),
      );
    assert.ok(match, "no pinned npx npm publish step");
    const version = match.slice(1, 4).map(Number);
    assert.ok(
      atLeast(version, MIN_TRUSTED_NPM),
      `npm ${version.join(".")} is older than ${MIN_TRUSTED_NPM.join(".")}`,
    );
  });

  it("the version check orders npm versions", () => {
    assert.equal(atLeast([11, 5, 1], MIN_TRUSTED_NPM), true);
    assert.equal(atLeast([11, 19, 1], MIN_TRUSTED_NPM), true);
    assert.equal(atLeast([12, 0, 0], MIN_TRUSTED_NPM), true);
    assert.equal(atLeast([11, 5, 0], MIN_TRUSTED_NPM), false);
    assert.equal(atLeast([11, 4, 9], MIN_TRUSTED_NPM), false);
    assert.equal(atLeast([10, 9, 4], MIN_TRUSTED_NPM), false);
  });
});
