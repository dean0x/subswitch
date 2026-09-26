import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validClaudeAlias,
  isOpenaiModelName,
  buildOpenaiModelNamePredicate,
  claudeResolver,
  augmentCodexModels,
  isClaudeModelName,
  CLAUDE_MODELS,
} from "../../src/claude-models.js";
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

  it("reserves the GPT-6 Sol and Luna ids and their variants against the Claude leg", () => {
    for (const name of ["gpt-6-sol", "gpt-6-luna", "GPT-6-SOL", "gpt-6-luna[1m]"])
      assert.equal(isOpenaiModelName(name), true, `'${name}' must be reserved for OpenAI routing`);
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

// ---------------------------------------------------------------------------
// CLAUDE_MODELS — the reverse-leg catalog and its per-model capabilities
// ---------------------------------------------------------------------------

/**
 * Independent literal pin of every catalog entry's capabilities (avoids PF-011's
 * self-referential pin): these values come from platform.claude.com (fetched 2026-09-26),
 * not from CLAUDE_MODELS, so a wrong or drifted field turns this red.
 */
const EXPECTED_CAPABILITIES = {
  "claude-sonnet-5": { maxOutputTokens: 128_000, thinkingAlwaysOn: false, forcedToolChoice: true, defaultEffort: "high" },
  "claude-opus-5": { maxOutputTokens: 128_000, thinkingAlwaysOn: false, forcedToolChoice: true, defaultEffort: "high" },
  "claude-opus-5-5": { maxOutputTokens: 128_000, thinkingAlwaysOn: true, forcedToolChoice: false, defaultEffort: "medium" },
  "claude-fable-5": { maxOutputTokens: 128_000, thinkingAlwaysOn: true, forcedToolChoice: true, defaultEffort: "high" },
  "claude-fable-5-1": { maxOutputTokens: 128_000, thinkingAlwaysOn: true, forcedToolChoice: false, defaultEffort: "high" },
} as const;

describe("CLAUDE_MODELS", () => {
  it("registers exactly the published Claude ids — no unpublished Sonnet 5.5, Haiku or Mythos", () => {
    assert.deepEqual(CLAUDE_MODELS.map((model) => model.id).sort(), Object.keys(EXPECTED_CAPABILITIES).sort());
  });

  it("declares every capability for every entry, matching the published model behaviour", () => {
    for (const model of CLAUDE_MODELS) {
      const expected = EXPECTED_CAPABILITIES[model.id as keyof typeof EXPECTED_CAPABILITIES];
      assert.deepEqual(
        {
          maxOutputTokens: model.maxOutputTokens,
          thinkingAlwaysOn: model.thinkingAlwaysOn,
          forcedToolChoice: model.forcedToolChoice,
          defaultEffort: model.defaultEffort,
        },
        expected,
        `capabilities of ${model.id}`,
      );
    }
  });
});

describe("claudeResolver", () => {
  it("resolves the opus family to Opus 5.5 while Opus 5 stays reachable by exact id", () => {
    const resolve = claudeResolver({});
    assert.equal(resolve("opus"), "claude-opus-5-5");
    assert.equal(resolve("claude:opus"), "claude-opus-5-5");
    assert.equal(resolve("claude-opus-5-5"), "claude-opus-5-5");
    assert.equal(resolve("claude-opus-5"), "claude-opus-5");
    assert.equal(resolve("sonnet"), "claude-sonnet-5");
    assert.equal(resolve("fable"), "claude-fable-5-1");
  });

  it("does not resolve the announced-but-unpublished Sonnet 5.5", () => {
    assert.equal(claudeResolver({})("claude-sonnet-5-5"), undefined);
  });
});

describe("isClaudeModelName", () => {
  it("claims the claude- and claude: namespaces case-insensitively and nothing else", () => {
    for (const name of ["claude-sonnet-5-5", "CLAUDE-OPUS-9", "Claude-x", "claude:anything"])
      assert.equal(isClaudeModelName(name), true, `'${name}' is in the Claude namespace`);
    for (const name of ["", "claude", "claudette", "sonnet", "gpt-6-sol", "my-claude-sonnet"])
      assert.equal(isClaudeModelName(name), false, `'${name}' is not in the Claude namespace`);
  });
});

describe("augmentCodexModels", () => {
  const template = { slug: "gpt-6-sol", tool_mode: "code_mode_only", default_reasoning_level: "low" };
  const slugs = (aliases: Record<string, string> = {}) =>
    new Map(
      (augmentCodexModels({ models: [template] }, aliases)["models"] as Record<string, unknown>[]).map((row) => [
        row["slug"],
        row,
      ]),
    );

  it("advertises claude-opus-5-5 and its opus alias", () => {
    const rows = slugs();
    assert.ok(rows.has("claude-opus-5-5"));
    assert.equal(rows.get("opus")?.["description"], "Claude via SubSwitch (claude-opus-5-5)");
    assert.ok(rows.has("claude-opus-5"), "Opus 5 keeps its exact-id row");
  });

  it("advertises each model's own default reasoning level", () => {
    const rows = slugs();
    for (const [slug, level] of [
      ["claude-opus-5-5", "medium"],
      ["opus", "medium"],
      ["claude-opus-5", "high"],
      ["claude-sonnet-5", "high"],
      ["sonnet", "high"],
      ["claude-fable-5", "high"],
      ["claude-fable-5-1", "high"],
      ["fable", "high"],
    ] as const)
      assert.equal(rows.get(slug)?.["default_reasoning_level"], level, `default level of ${slug}`);
  });

  it("offers low through max, never none, on every Claude row", () => {
    for (const [slug, row] of slugs()) {
      if (slug === "gpt-6-sol") continue;
      assert.deepEqual(
        (row["supported_reasoning_levels"] as { effort: string }[]).map((level) => level.effort),
        ["low", "medium", "high", "xhigh", "max"],
        `levels of ${slug}`,
      );
    }
  });

  it("carries a custom alias of a registered model with that model's defaults", () => {
    assert.equal(slugs({ deep: "claude-opus-5-5" }).get("deep")?.["default_reasoning_level"], "medium");
  });
});
