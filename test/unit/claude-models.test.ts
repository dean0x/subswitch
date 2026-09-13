import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validClaudeAlias, isOpenaiModelName, buildOpenaiModelNamePredicate } from "../../src/claude-models.js";
import { MODEL_REGISTRY, type ModelEntry } from "../../src/models.js";

/** Every reserved name the registry declares: each entry's canonical id plus its family alias. */
const registryNames = (registry: readonly ModelEntry[]): readonly string[] =>
  registry.flatMap((entry) => (entry.family !== undefined ? [entry.id, entry.family] : [entry.id]));

/**
 * A registry the production code has never seen, declaring a family the hand-written
 * alternation could not have listed. The liveness control for the derivation.
 */
const SYNTHETIC_REGISTRY: readonly ModelEntry[] = [
  { id: "gpt-7-nova", provider: "codex", family: "nova", gen: [7] },
];

// ---------------------------------------------------------------------------
// isOpenaiModelName — reverse-leg reservation of OpenAI model names
// ---------------------------------------------------------------------------

describe("isOpenaiModelName", () => {
  it("reserves the fixed OpenAI naming arms and nothing that merely looks like them", () => {
    for (const name of ["gpt-5.6-sol", "gpt-4o", "GPT-6-ASTRA", "o1", "o1-preview", "o3-mini", "o4", "codex:sol", "codex:anything"])
      assert.equal(isOpenaiModelName(name), true, `'${name}' must be reserved for OpenAI routing`);
    for (const name of ["", "claude-sonnet-5", "sonnet", "opus", "haiku", "o2", "o13", "ogpt-5", "openai"])
      assert.equal(isOpenaiModelName(name), false, `'${name}' must stay available to the Claude leg`);
  });

  it("reserves a family name exactly, or followed by a variant suffix — never as a prefix of a longer word", () => {
    for (const name of ["sol", "SOL", "sol[1m]", "terra", "luna", "astra[1m]"])
      assert.equal(isOpenaiModelName(name), true, `'${name}' must be reserved for OpenAI routing`);
    for (const name of ["solaris", "terraform", "lunatic", "astral"])
      assert.equal(isOpenaiModelName(name), false, `'${name}' is not a family name and must stay available`);
  });

  it("reserves every id and every family the registry declares (invariant, not a fixed list)", () => {
    for (const name of registryNames(MODEL_REGISTRY))
      assert.equal(isOpenaiModelName(name), true, `registry name '${name}' is not reserved on the reverse leg`);
  });

  it("derives the reserved names from the registry it is handed, not from a hardcoded alternation", () => {
    const predicate = buildOpenaiModelNamePredicate(SYNTHETIC_REGISTRY);
    for (const name of ["nova", "NOVA", "nova[1m]", "gpt-7-nova"])
      assert.equal(predicate(name), true, `'${name}' must be reserved when the registry declares family 'nova'`);
    // Liveness control: the production registry declares no 'nova' family, so the production
    // predicate must NOT reserve it. A hardcoded alternation answers identically for both
    // predicates — this pair is what proves the derivation is live.
    assert.equal(isOpenaiModelName("nova"), false, "the production registry declares no 'nova' family");
  });

  it("reserves only the fixed arms when handed an empty registry", () => {
    const predicate = buildOpenaiModelNamePredicate([]);
    assert.equal(predicate("gpt-5.6-sol"), true, "the gpt- arm survives an empty registry");
    for (const name of ["", "sol", "claude-sonnet-5"])
      assert.equal(predicate(name), false, `an empty registry must not reserve '${name}'`);
  });
});

// ---------------------------------------------------------------------------
// validClaudeAlias — the only gate on codexIngress.claude.aliases
// ---------------------------------------------------------------------------

describe("validClaudeAlias", () => {
  it("reserves Astra family names for OpenAI routing, including variants", () => {
    for (const name of ["astra", "ASTRA", "astra[1m]"]) assert.equal(validClaudeAlias(name, "claude-sonnet-5"), false);
  });

  it("rejects every registry id and family as an alias key and as an alias target", () => {
    for (const name of registryNames(MODEL_REGISTRY)) {
      assert.equal(validClaudeAlias(name, "claude-sonnet-5"), false, `'${name}' must not be claimable as a Claude alias key`);
      assert.equal(validClaudeAlias("fast", name), false, `'${name}' must not be reachable as a Claude alias target`);
    }
  });

  it("accepts an alias that claims no OpenAI name and targets a claude- id", () => {
    assert.equal(validClaudeAlias("fast", "claude-sonnet-5"), true);
    assert.equal(validClaudeAlias("solaris", "claude-opus-5"), true);
  });

  it("rejects a target that is not a claude- id even when no OpenAI name is claimed", () => {
    assert.equal(validClaudeAlias("fast", "sonnet"), false);
    assert.equal(validClaudeAlias("fast", "some-other-model"), false);
  });
});
