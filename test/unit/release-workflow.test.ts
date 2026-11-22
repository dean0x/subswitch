import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

const workflowsDir = new URL("../../.github/workflows/", import.meta.url);

const workflowFiles = readdirSync(workflowsDir).filter((name) =>
  /\.ya?ml$/.test(name),
);

const readWorkflow = (name: string): string =>
  readFileSync(new URL(name, workflowsDir), "utf8");

/**
 * The npm package publishes through npm trusted publishing (OIDC). A token
 * name in any workflow would bring back a token path for the publish.
 */
const TOKEN_NAMES = ["NPM_TOKEN", "NODE_AUTH_TOKEN", "_authToken"] as const;

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

  it("release.yml gives setup-node no registry-url", () => {
    // With registry-url, setup-node writes an npm token line to .npmrc.
    assert.doesNotMatch(readWorkflow("release.yml"), /^\s*registry-url:/m);
  });

  it("release.yml can request the workflow identity token", () => {
    assert.match(readWorkflow("release.yml"), /^\s*id-token:\s*write\s*$/m);
  });

  it("release.yml publishes with a pinned npm 11", () => {
    assert.match(
      readWorkflow("release.yml"),
      /^\s*run: npx -y npm@11\.\d+\.\d+ publish --provenance --access public\s*$/m,
    );
  });
});
