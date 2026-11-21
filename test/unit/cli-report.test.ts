import assert from "node:assert/strict";
import { it } from "node:test";
import { loadConfig, enumerateDestinations } from "../../src/config.js";
import { formatProviderBanner, modelProviderRows } from "../../src/cli-report.js";
import { keychainBackedCodex } from "../fixtures/native-keychain.js";

const config = loadConfig({ configPath: "/fixture/config.json", readFile: () => "{}", env: {} });
assert.ok(config.ok);

it("shows only the host for an active Keychain credential in the banner", () => {
  const credential = keychainBackedCodex(true)(config.value.config, "codex");
  assert.equal(formatProviderBanner("codex", 1, credential), "  codex     1 model  → upstream.example.test");
});

it("shows no host for an inactive Keychain credential in the banner", () => {
  const credential = keychainBackedCodex(false)(config.value.config, "codex");
  assert.equal(formatProviderBanner("codex", 1, credential), "  codex     1 model  (not turned on)");
});

it("lists model provider metadata without any Keychain fields", () => {
  const destinations = enumerateDestinations(config.value.config, keychainBackedCodex(true));
  assert.equal(destinations.some((d) => d.routing === "registry" && d.credential.kind === "native-keychain"), true);
  assert.deepEqual(modelProviderRows(destinations).find((row) => row.id === "codex"), {
    id: "codex", displayName: "Codex", routing: "registry",
  });
});
