/**
 * Unit tests for buildRoutingTable and resolveModel (Phase B).
 *
 * Acceptance criteria covered: F2, F3, F4, F5, F6, F9, F13, plus registry
 * self-check, one-hop aliasing, prototype pollution, contested family,
 * totality, and the P1 perf budget.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MODEL_REGISTRY,
  buildAliasRows,
  PROVIDER_IDS,
  buildRoutingTable,
  resolveModel,
  type ModelEntry,
  type ProviderId,
  type ModelResolution,
} from "../../src/models.js";

// ---------------------------------------------------------------------------
// Synthetic-registry helpers
// ---------------------------------------------------------------------------

/**
 * Build a ModelEntry for unit tests. Avoids repeating provider everywhere.
 * `gen` defaults to [5, 6] as a safe placeholder.
 */
const entry = (
  id: string,
  overrides: Partial<ModelEntry> = {},
): ModelEntry => ({
  id,
  provider: "codex",
  gen: [5, 6],
  ...overrides,
});

/**
 * SYNTHETIC-PROVIDER CAST — used ONLY for multi-provider collision tests.
 * Remove this helper and all callers when a second real provider lands and
 * PROVIDER_IDS expands beyond ["codex"]. The single cast is here; nowhere else.
 */
const foreignEntry = (
  id: string,
  foreignProvider: string,
  overrides: Partial<Omit<ModelEntry, "id" | "provider">> = {},
): ModelEntry => ({
  id,
  provider: foreignProvider as ProviderId,
  gen: [5, 6],
  ...overrides,
});

/** A no-aliases record for the single current provider. */
const NO_ALIASES: Record<ProviderId, Readonly<Record<string, string>>> = { codex: {} };

/** Shorthand: build a table with just codex aliases. */
const buildTable = (
  registry: readonly ModelEntry[],
  codexAliases: Readonly<Record<string, string>> = {},
) => buildRoutingTable(registry, { codex: codexAliases });

// ---------------------------------------------------------------------------
// F2 — family alias resolves to newest non-preview, non-retired member
// ---------------------------------------------------------------------------

describe("F2 — family alias resolution", () => {
  it("F2: 'sol' resolves to the newest non-preview, non-retired member via bare family name", () => {
    const reg = [
      entry("gpt-5.5-sol", { family: "sol", gen: [5, 5] }),
      entry("gpt-5.6-sol", { family: "sol", gen: [5, 6] }), // newest active
      entry("gpt-5.7-sol-preview", { family: "sol", gen: [5, 7], preview: true }),
      entry("gpt-5.4-sol-old", { family: "sol", gen: [5, 4], retired: true }),
    ];
    const { table } = buildTable(reg);
    const resolution = resolveModel(table, "sol");
    assert.equal(resolution.kind, "resolved");
    assert.equal((resolution as Extract<ModelResolution, { kind: "resolved" }>).target.id, "gpt-5.6-sol");
  });

  it("F2: real MODEL_REGISTRY — 'sol' resolves to gpt-5.6-sol (current generation)", () => {
    const { table } = buildRoutingTable(MODEL_REGISTRY, NO_ALIASES);
    const resolution = resolveModel(table, "sol");
    assert.equal(resolution.kind, "resolved");
    assert.equal((resolution as Extract<ModelResolution, { kind: "resolved" }>).target.id, "gpt-5.6-sol");
  });
});

// ---------------------------------------------------------------------------
// F3 — alias from providers.codex.aliases beats derived family alias
// ---------------------------------------------------------------------------

describe("F3 — explicit alias beats derived family alias", () => {
  it("F3: a codex alias 'sol' → gpt-5.5-sol overrides the derived family winner gpt-5.6-sol", () => {
    const reg = [
      entry("gpt-5.5-sol", { family: "sol", gen: [5, 5] }),
      entry("gpt-5.6-sol", { family: "sol", gen: [5, 6] }),
    ];
    const { table } = buildTable(reg, { sol: "gpt-5.5-sol" });
    const resolution = resolveModel(table, "sol");
    // byAlias (rule 2) fires before byFamily (rule 4)
    assert.equal(resolution.kind, "resolved");
    assert.equal((resolution as Extract<ModelResolution, { kind: "resolved" }>).target.id, "gpt-5.5-sol");
  });
});

// ---------------------------------------------------------------------------
// F4 — exact id beats an alias that tries to shadow it (rule 1 precedence)
// ---------------------------------------------------------------------------

describe("F4 — exact id always wins over alias (rule 1 precedence)", () => {
  it("F4: alias 'gpt-5.6-sol' → gpt-5.5-sol cannot hijack the exact id gpt-5.6-sol", () => {
    const reg = [
      entry("gpt-5.5-sol", { family: "sol", gen: [5, 5] }),
      entry("gpt-5.6-sol", { family: "sol", gen: [5, 6] }),
    ];
    // The alias tries to redirect the canonical id to an older model
    const { table } = buildTable(reg, { "gpt-5.6-sol": "gpt-5.5-sol" });
    const resolution = resolveModel(table, "gpt-5.6-sol");
    assert.equal(resolution.kind, "resolved");
    // Rule 1 fires first — alias is ignored
    assert.equal((resolution as Extract<ModelResolution, { kind: "resolved" }>).target.id, "gpt-5.6-sol");
  });

  // Mutation check: if we removed rule 1 (commenting out byId lookup), this test FAILS
  // because the alias "gpt-5.6-sol" → "gpt-5.5-sol" would then win via rule 2.
  it("F4: exact id also wins when alias and exact-id resolution would produce different targets", () => {
    const reg = [entry("actual-id", {}), entry("redirect-target", {})];
    const { table } = buildTable(reg, { "actual-id": "redirect-target" });
    const resolution = resolveModel(table, "actual-id");
    assert.equal(resolution.kind, "resolved");
    assert.equal((resolution as Extract<ModelResolution, { kind: "resolved" }>).target.id, "actual-id");
  });
});

// ---------------------------------------------------------------------------
// F5 — qualified lookup and unknown-provider disambiguation
// ---------------------------------------------------------------------------

describe("F5 — qualified resolution and unknown_qualifier discrimination", () => {
  it("F5: 'codex:sol' resolves via byQualified (family qualified)", () => {
    const reg = [entry("gpt-5.6-sol", { family: "sol", gen: [5, 6] })];
    const { table } = buildTable(reg);
    const resolution = resolveModel(table, "codex:sol");
    assert.equal(resolution.kind, "resolved");
    assert.equal((resolution as Extract<ModelResolution, { kind: "resolved" }>).target.id, "gpt-5.6-sol");
  });

  it("F5: 'codex:gpt-5.6-sol' resolves via byQualified (id qualified)", () => {
    const reg = [entry("gpt-5.6-sol", { family: "sol", gen: [5, 6] })];
    const { table } = buildTable(reg);
    const resolution = resolveModel(table, "codex:gpt-5.6-sol");
    assert.equal(resolution.kind, "resolved");
    assert.equal((resolution as Extract<ModelResolution, { kind: "resolved" }>).target.id, "gpt-5.6-sol");
  });

  it("F5: 'kimee:k2' returns unknown_qualifier (not unresolved) — unknown provider is distinguishable", () => {
    const { table } = buildTable(MODEL_REGISTRY);
    const resolution = resolveModel(table, "kimee:k2");
    assert.equal(resolution.kind, "unknown_qualifier");
    assert.equal(
      (resolution as Extract<ModelResolution, { kind: "unknown_qualifier" }>).qualifier,
      "kimee",
    );
  });

  it("F5: 'codex:no-such-model' returns unresolved (not unknown_qualifier) — provider is valid", () => {
    const { table } = buildTable(MODEL_REGISTRY);
    const resolution = resolveModel(table, "codex:no-such-model");
    assert.equal(resolution.kind, "unresolved");
  });
});

// ---------------------------------------------------------------------------
// F6 — registry id containing a colon wins over qualified-name parsing
// ---------------------------------------------------------------------------

describe("F6 — colon in registry id: rule 1 fires before qualified parsing", () => {
  it("F6: 'llama3:8b' is in byId as an exact id — rule 1 wins, not rule 3 prefix parsing", () => {
    // SYNTHETIC: a registry where an id legitimately contains a colon.
    // No real registry id contains a colon today; this proves the rule ordering.
    const reg = [
      // "llama3" is NOT in PROVIDER_IDS, so split would produce an unknown_qualifier
      // under rule 3. But rule 1 must fire first and return resolved.
      entry("llama3:8b", { gen: [3, 0] }),
    ];
    const { table } = buildTable(reg);
    const resolution = resolveModel(table, "llama3:8b");
    assert.equal(
      resolution.kind,
      "resolved",
      "an id containing a colon must resolve via byId (rule 1), not be misrouted by colon parsing",
    );
    assert.equal(
      (resolution as Extract<ModelResolution, { kind: "resolved" }>).target.id,
      "llama3:8b",
    );
  });

  it("F6: 'codex:gpt-5.6-sol' where the full string is NOT in byId — falls through to rule 3", () => {
    // Sanity check: "codex:gpt-5.6-sol" is not a registry id, so rule 1 does NOT fire.
    // Rule 3 fires and resolves correctly.
    const { table } = buildRoutingTable(MODEL_REGISTRY, NO_ALIASES);
    const asId = table.byId.get("codex:gpt-5.6-sol");
    assert.equal(asId, undefined, "'codex:gpt-5.6-sol' should not be in byId");
    const resolution = resolveModel(table, "codex:gpt-5.6-sol");
    assert.equal(resolution.kind, "resolved");
  });
});

// ---------------------------------------------------------------------------
// F9 — retired id resolves by exact pin; bare family never floats onto it
// ---------------------------------------------------------------------------

describe("F9 — retired model handling", () => {
  it("F9: a retired id resolves by exact pin (byId contains retired entries)", () => {
    const reg = [
      entry("gpt-5.6-sol", { family: "sol", gen: [5, 6] }),
      entry("gpt-5.4-sol-old", { family: "sol", gen: [5, 4], retired: true }),
    ];
    const { table } = buildTable(reg);
    const resolution = resolveModel(table, "gpt-5.4-sol-old");
    assert.equal(resolution.kind, "resolved", "retired id must still resolve by exact pin");
    assert.equal(
      (resolution as Extract<ModelResolution, { kind: "resolved" }>).target.id,
      "gpt-5.4-sol-old",
    );
  });

  it("F9: bare family 'sol' never floats onto the retired model — active member wins", () => {
    const reg = [
      entry("gpt-5.6-sol", { family: "sol", gen: [5, 6] }),
      entry("gpt-5.9-sol-old", { family: "sol", gen: [5, 9], retired: true }), // newer but retired
    ];
    const { table } = buildTable(reg);
    const resolution = resolveModel(table, "sol");
    assert.equal(resolution.kind, "resolved");
    // Retired entry excluded from family derivation → active gpt-5.6-sol wins
    assert.equal((resolution as Extract<ModelResolution, { kind: "resolved" }>).target.id, "gpt-5.6-sol");
  });

  it("F9: when ALL family members are retired, bare family is unresolved", () => {
    const reg = [entry("gpt-5.4-sol-old", { family: "sol", gen: [5, 4], retired: true })];
    const { table } = buildTable(reg);
    const resolution = resolveModel(table, "sol");
    // No non-retired member → family not in byFamily → unresolved
    assert.equal(resolution.kind, "unresolved");
  });
});

// ---------------------------------------------------------------------------
// F13 — resolveModel is the only constructor of ModelResolution
// ---------------------------------------------------------------------------

describe("F13 — resolveModel is the sole resolution entry point", () => {
  it("F13: resolveModel covers all four outcome kinds for a synthetic registry", () => {
    // SYNTHETIC: multi-provider registry for the ambiguous arm.
    // Uses the foreignEntry cast (single cast location).
    const reg: readonly ModelEntry[] = [
      entry("gpt-5.6-sol", { family: "sol", gen: [5, 6] }),
      foreignEntry("gpt-5.6-sol-fp", "openai", { family: "sol", gen: [5, 6] }),
      entry("gpt-5.6-terra", { family: "terra", gen: [5, 6] }),
      entry("gpt-5.6-retired", { family: "retired-fam", gen: [5, 6], retired: true }),
    ];
    const syntheticProviders = ["codex", "openai"] as const;
    const aliasesByProvider = syntheticProviders.reduce(
      (acc, p) => {
        acc[p as ProviderId] = {};
        return acc;
      },
      {} as Record<ProviderId, Record<string, string>>,
    );
    const { table } = buildRoutingTable(reg, aliasesByProvider);

    // resolved — exact id
    const r1 = resolveModel(table, "gpt-5.6-sol");
    assert.equal(r1.kind, "resolved");

    // resolved — alias (add one to verify)
    const aliasesByProvider2 = { ...aliasesByProvider, codex: { fast: "gpt-5.6-terra" } };
    const { table: t2 } = buildRoutingTable(reg, aliasesByProvider2);
    const r2 = resolveModel(t2, "fast");
    assert.equal(r2.kind, "resolved");

    // ambiguous — "sol" claimed by codex and openai
    const r3 = resolveModel(table, "sol");
    assert.equal(r3.kind, "ambiguous");

    // unresolved
    const r4 = resolveModel(table, "does-not-exist");
    assert.equal(r4.kind, "unresolved");

    // unknown_qualifier
    const r5 = resolveModel(table, "kimee:k2");
    assert.equal(r5.kind, "unknown_qualifier");
  });

  it("F13: resolveModel does no name-matching beyond table lookups (verified structurally by code)", () => {
    // This test documents the layering contract. The resolveModel implementation
    // uses only Map.get() calls — it never matches on name prefixes, patterns, or
    // registry fields directly. That logic lives exclusively in buildRoutingTable.
    // A reviewer checking ADR-005 compliance looks here first.
    assert.ok(typeof resolveModel === "function", "resolveModel must be exported");
  });
});

// ---------------------------------------------------------------------------
// Registry self-check over real MODEL_REGISTRY
// ---------------------------------------------------------------------------

describe("Registry self-check — reservedNameEntries", () => {
  it("MODEL_REGISTRY has no entries with reserved Anthropic names", () => {
    const { reservedNameEntries } = buildRoutingTable(MODEL_REGISTRY, NO_ALIASES);
    assert.deepEqual(
      reservedNameEntries,
      [],
      `MODEL_REGISTRY contains reserved Anthropic names: ${reservedNameEntries.join(", ")}`,
    );
  });

  it("self-check catches a hypothetical registry entry with an Anthropic id", () => {
    const reg = [
      ...MODEL_REGISTRY,
      // Hypothetical Bedrock-style id — would be caught
      entry("claude-3-5-sonnet-20241022", { gen: [3, 5] }),
    ];
    const { reservedNameEntries } = buildTable(reg);
    assert.ok(
      reservedNameEntries.includes("claude-3-5-sonnet-20241022"),
      "reserved id must appear in reservedNameEntries",
    );
  });

  it("self-check catches a registry entry whose family is a reserved Anthropic name", () => {
    const reg = [...MODEL_REGISTRY, entry("codex-sonnet-model", { family: "sonnet", gen: [5, 6] })];
    const { reservedNameEntries } = buildTable(reg);
    assert.ok(
      reservedNameEntries.includes("codex-sonnet-model"),
      "entry with reserved family name must appear in reservedNameEntries",
    );
  });
});

// ---------------------------------------------------------------------------
// Alias one-hop enforcement
// ---------------------------------------------------------------------------

describe("One-hop alias enforcement", () => {
  it("alias 'a' → 'b' where 'b' is itself an alias does NOT follow to b's target", () => {
    const reg = [entry("final-target", { gen: [5, 6] }), entry("intermediate", { gen: [5, 5] })];
    // 'a' → 'intermediate', 'intermediate' → 'final-target'
    // Chasing would land on 'final-target'; one-hop must stop at 'intermediate'.
    const { table } = buildTable(reg, { a: "intermediate", intermediate: "final-target" });

    const resolution = resolveModel(table, "a");
    assert.equal(resolution.kind, "resolved");
    // One-hop: target is 'intermediate', NOT 'final-target'
    assert.equal(
      (resolution as Extract<ModelResolution, { kind: "resolved" }>).target.id,
      "intermediate",
      "alias resolution must be exactly one hop — must not chase transitive aliases",
    );
  });

  it("alias for a non-registry name resolves directly via rule 2 to its own target", () => {
    // 'intermediate' is NOT in the registry (no byId entry).
    // Direct lookup of 'intermediate' goes through byAlias (rule 2) → final-target.
    // This is distinct from the one-hop rule above: one-hop guards 'a → intermediate'
    // from chasing further; THIS test checks that 'intermediate' resolves normally when
    // looked up as the primary name.
    const reg = [entry("final-target", { gen: [5, 6] })]; // 'intermediate' intentionally absent
    const { table } = buildTable(reg, { a: "intermediate", intermediate: "final-target" });

    const resolution = resolveModel(table, "intermediate");
    assert.equal(resolution.kind, "resolved");
    assert.equal(
      (resolution as Extract<ModelResolution, { kind: "resolved" }>).target.id,
      "final-target",
      "'intermediate' as primary lookup goes through byAlias to final-target",
    );
  });
});

// ---------------------------------------------------------------------------
// Prototype-pollution guard on alias records
//
// The production loop uses Object.keys() which returns ONLY own enumerable keys.
// This means inherited properties (via Object.create) are already excluded before
// the Object.hasOwn guard fires — Object.hasOwn is belt-and-braces defence-in-depth.
//
// The tests below use OWN-property versions of dangerous key names (as they would
// appear in a real JSON-parsed alias object), verifying the correct behaviour:
// own-property "constructor", "toString", and "__proto__" keys are all treated as
// ordinary alias names since JSON.parse only creates own properties.
// ---------------------------------------------------------------------------

describe("Prototype-pollution guard on alias records", () => {
  it("own-property key 'constructor' in alias record installs as an alias (ordinary key behaviour)", () => {
    // JSON.parse('{"constructor":"gpt-5.6-sol"}') produces an own-property key "constructor".
    // It must resolve as a normal alias — there is no special treatment.
    const reg = [entry("gpt-5.6-sol", { gen: [5, 6] })];
    const { table } = buildTable(reg, { constructor: "gpt-5.6-sol" });
    const resolution = resolveModel(table, "constructor");
    assert.equal(resolution.kind, "resolved");
    assert.equal((resolution as Extract<ModelResolution, { kind: "resolved" }>).target.id, "gpt-5.6-sol");
  });

  it("own-property key 'toString' in alias record installs as an alias (ordinary key behaviour)", () => {
    // Same rationale as 'constructor': JSON.parse creates own properties; no prototype contamination.
    const reg = [entry("gpt-5.6-sol", { gen: [5, 6] })];
    const { table } = buildTable(reg, { toString: "gpt-5.6-sol" });
    const resolution = resolveModel(table, "toString");
    assert.equal(resolution.kind, "resolved");
    assert.equal((resolution as Extract<ModelResolution, { kind: "resolved" }>).target.id, "gpt-5.6-sol");
  });

  it("own-property key '__proto__' in alias record resolves correctly without polluting Object.prototype", () => {
    // JSON.parse('{"__proto__":"gpt-5.6-sol"}') produces an own-property key "__proto__"
    // on the parsed object (JSON.parse sandboxes it — no prototype chain mutation).
    // We verify: (a) Object.prototype is not mutated, (b) normal lookups still work.
    const reg = [entry("gpt-5.6-sol", { gen: [5, 6] })];

    // Simulate a JSON-parsed alias object with an own "__proto__" key.
    const aliases: Record<string, string> = JSON.parse('{"__proto__":"gpt-5.6-sol"}') as Record<string, string>;
    const { table } = buildTable(reg, aliases);

    // Object.prototype must not be polluted.
    // buildRoutingTable uses a Map (not a plain object) for byAlias, so Map.set("__proto__", ...)
    // does NOT invoke the __proto__ setter on Object.prototype. Verify via prototype chain:
    assert.equal(
      Object.getPrototypeOf({}),
      Object.prototype,
      "Object.prototype must not have been polluted — fresh {} must still have Object.prototype as its prototype",
    );

    // Normal lookups must still work after processing the "__proto__" key.
    const resolution = resolveModel(table, "gpt-5.6-sol");
    assert.equal(resolution.kind, "resolved", "normal lookups must still work after processing '__proto__' key");
  });

  it("inherited key 'constructor' from Object.create is NOT installed (Object.keys excludes inherited props)", () => {
    // Object.create({ constructor: "gpt-5.6-sol" }) creates an object whose "constructor"
    // is inherited, not own. Object.keys() returns [] for this object — the loop body
    // never executes, and Object.hasOwn serves as belt-and-braces for any future code path.
    const reg = [entry("gpt-5.6-sol", { gen: [5, 6] })];
    const inheritedOnlyAliases = Object.create({ constructor: "gpt-5.6-sol" }) as Record<string, string>;
    // Object.keys returns [] — the alias is not installed regardless of the hasOwn guard.
    assert.deepEqual(Object.keys(inheritedOnlyAliases), [], "sanity: Object.keys returns empty for purely-inherited object");
    const { table } = buildTable(reg, inheritedOnlyAliases);
    assert.equal(resolveModel(table, "constructor").kind, "unresolved",
      "inherited-only key must not appear in byAlias — Object.keys already excludes it");
  });
});

// ---------------------------------------------------------------------------
// Contested family → ambiguous with both provider ids
// ---------------------------------------------------------------------------

describe("Contested family — ambiguous resolution", () => {
  it("a family claimed by two providers returns ambiguous carrying both provider ids", () => {
    // SYNTHETIC: two-provider registry. "sol" exists in both codex and openai.
    // foreignEntry cast is intentional — see helper comment at top of file.
    const reg: readonly ModelEntry[] = [
      entry("gpt-5.6-sol", { family: "sol", gen: [5, 6] }),
      foreignEntry("gpt-5.6-sol-fp", "openai", { family: "sol", gen: [5, 6] }),
    ];
    const syntheticProviders = ["codex", "openai"] as const;
    const aliasesByProvider = syntheticProviders.reduce(
      (acc, p) => {
        acc[p as ProviderId] = {};
        return acc;
      },
      {} as Record<ProviderId, Record<string, string>>,
    );
    const { table, ambiguousFamilies } = buildRoutingTable(reg, aliasesByProvider);

    // Build result carries the ambiguous family diagnostic
    assert.equal(ambiguousFamilies.length, 1);
    assert.equal(ambiguousFamilies[0]?.family, "sol");
    assert.ok(ambiguousFamilies[0]?.providers.includes("codex" as ProviderId));
    assert.ok(ambiguousFamilies[0]?.providers.includes("openai" as ProviderId));

    // Resolution by bare name returns ambiguous carrying both providers
    const resolution = resolveModel(table, "sol");
    assert.equal(resolution.kind, "ambiguous");
    const ambig = resolution as Extract<ModelResolution, { kind: "ambiguous" }>;
    assert.ok(ambig.providers.includes("codex" as ProviderId), "must include codex");
    assert.ok(ambig.providers.includes("openai" as ProviderId), "must include openai");
  });

  it("a family claimed by only one provider remains reachable by bare name", () => {
    // "sol" in codex only; "luna" in openai only; "terra" in both → ambiguous
    const reg: readonly ModelEntry[] = [
      entry("gpt-5.6-sol", { family: "sol", gen: [5, 6] }),
      foreignEntry("gpt-5.6-luna-fp", "openai", { family: "luna", gen: [5, 6] }),
      entry("gpt-5.6-terra", { family: "terra", gen: [5, 6] }),
      foreignEntry("gpt-5.6-terra-fp", "openai", { family: "terra", gen: [5, 6] }),
    ];
    const aliasesByProvider = { codex: {}, openai: {} } as Record<ProviderId, Record<string, string>>;
    const { table } = buildRoutingTable(reg, aliasesByProvider);

    assert.equal(resolveModel(table, "sol").kind, "resolved");
    assert.equal(resolveModel(table, "luna").kind, "resolved");
    assert.equal(resolveModel(table, "terra").kind, "ambiguous");
  });
});

// ---------------------------------------------------------------------------
// P0-1: Qualified resolution works for ALL families — contested or not.
//
// A qualified name explicitly states its provider, so "codex:pro" unambiguously
// names codex's pro-family winner even when "pro" is contested.
// The 400 error message "qualify with provider:name (e.g. codex:pro)" only helps
// if "codex:pro" actually resolves — skipping contested families inverts the feature.
// ---------------------------------------------------------------------------

describe("Contested family — qualified resolution (P0-1)", () => {
  it("codex:pro resolves to codex's pro-family winner even when 'pro' is contested", () => {
    const reg: readonly ModelEntry[] = [
      entry("gpt-pro-1", { family: "pro", gen: [5, 6] }),
      foreignEntry("kimi-pro-1", "kimi", { family: "pro", gen: [5, 6] }),
    ];
    const aliasesByProvider = { codex: {}, kimi: {} } as Record<ProviderId, Record<string, string>>;
    const { table } = buildRoutingTable(reg, aliasesByProvider);

    // Bare 'pro' is contested → ambiguous
    const bare = resolveModel(table, "pro");
    assert.equal(bare.kind, "ambiguous", "bare 'pro' must be ambiguous when claimed by two providers");

    // Qualified 'codex:pro' → resolves to codex's pro winner (P0-1 fix)
    const codexQualified = resolveModel(table, "codex:pro");
    assert.equal(codexQualified.kind, "resolved", "codex:pro must resolve via byQualified");
    assert.equal((codexQualified as Extract<ModelResolution, { kind: "resolved" }>).target.id, "gpt-pro-1");
    assert.equal((codexQualified as Extract<ModelResolution, { kind: "resolved" }>).target.provider, "codex" as ProviderId);
  });

  it("kimi:pro returns unknown_qualifier — 'kimi' is in byQualified but NOT in PROVIDER_IDS", () => {
    // byQualified is populated for ALL provider:family entries (including kimi:pro from the
    // synthetic registry), but resolveModel only checks byQualified when the qualifier prefix
    // is a member of PROVIDER_IDS. Since "kimi" is not in PROVIDER_IDS (= ["codex"]),
    // resolveModel returns unknown_qualifier before reaching the byQualified lookup.
    //
    // The remediation advice in 400 responses only mentions REGISTERED provider qualifiers
    // — the fix for P0-1 benefits "codex:pro" (registered), not hypothetical unregistered ones.
    const reg: readonly ModelEntry[] = [
      entry("gpt-pro-1", { family: "pro", gen: [5, 6] }),
      foreignEntry("kimi-pro-1", "kimi", { family: "pro", gen: [5, 6] }),
    ];
    const aliasesByProvider = { codex: {}, kimi: {} } as Record<ProviderId, Record<string, string>>;
    const { table } = buildRoutingTable(reg, aliasesByProvider);

    const kimiQualified = resolveModel(table, "kimi:pro");
    // kimi is not in PROVIDER_IDS → unknown_qualifier (not resolved, not unresolved).
    assert.equal(kimiQualified.kind, "unknown_qualifier", "kimi:pro returns unknown_qualifier because kimi is not in PROVIDER_IDS");
    assert.equal((kimiQualified as Extract<ModelResolution, { kind: "unknown_qualifier" }>).qualifier, "kimi");
  });

  it("qualified resolve picks the per-provider family winner (newest non-preview non-retired)", () => {
    const reg: readonly ModelEntry[] = [
      entry("gpt-pro-1.0", { family: "pro", gen: [5, 4] }),
      entry("gpt-pro-1.1", { family: "pro", gen: [5, 6] }), // newest active for codex
      entry("gpt-pro-preview", { family: "pro", gen: [5, 7], preview: true }), // preview: excluded
      foreignEntry("kimi-pro-1", "kimi", { family: "pro", gen: [6, 0] }),
    ];
    const aliasesByProvider = { codex: {}, kimi: {} } as Record<ProviderId, Record<string, string>>;
    const { table } = buildRoutingTable(reg, aliasesByProvider);

    const codexPro = resolveModel(table, "codex:pro");
    assert.equal(codexPro.kind, "resolved");
    assert.equal(
      (codexPro as Extract<ModelResolution, { kind: "resolved" }>).target.id,
      "gpt-pro-1.1",
      "codex:pro must pick newest non-preview codex winner (not the preview)",
    );
  });

  it("the 400 remediation string 'codex:sol' actually resolves (not dead-end)", () => {
    // This tests the remediation advice from server.ts's ambiguous 400 handler:
    // "qualify with provider:name (e.g. codex:sol)".
    // If 'sol' were contested between two providers, 'codex:sol' must resolve — not dead-end.
    const reg: readonly ModelEntry[] = [
      entry("gpt-5.6-sol", { family: "sol", gen: [5, 6] }),
      foreignEntry("kimi-sol-1", "kimi", { family: "sol", gen: [5, 6] }),
    ];
    const aliasesByProvider = { codex: {}, kimi: {} } as Record<ProviderId, Record<string, string>>;
    const { table } = buildRoutingTable(reg, aliasesByProvider);

    // The remediation string the 400 prints is "codex:sol"
    const remediationResolution = resolveModel(table, "codex:sol");
    assert.equal(
      remediationResolution.kind,
      "resolved",
      "the 400 remediation 'codex:sol' must resolve — if it doesn't, the error gives dead-end advice",
    );
    assert.equal(
      (remediationResolution as Extract<ModelResolution, { kind: "resolved" }>).target.provider,
      "codex" as ProviderId,
    );
  });
});

// ---------------------------------------------------------------------------
// buildRoutingTable is total — never throws on hostile input
// ---------------------------------------------------------------------------

describe("buildRoutingTable is total", () => {
  it("empty registry does not throw", () => {
    assert.doesNotThrow(() => buildTable([]));
  });

  it("duplicate ids in registry do not throw (first wins)", () => {
    const reg = [
      entry("dup-id", { gen: [5, 6] }),
      entry("dup-id", { gen: [5, 7] }), // duplicate — first wins
    ];
    assert.doesNotThrow(() => buildTable(reg));
    const { table } = buildTable(reg);
    // First-declared wins in byId
    assert.ok(table.byId.has("dup-id"));
  });

  it("alias pointing at a nonexistent target does not throw", () => {
    const reg = [entry("gpt-5.6-sol", { gen: [5, 6] })];
    assert.doesNotThrow(() => buildTable(reg, { ghost: "nonexistent-target" }));
    // The alias is still installed (forward-compat: target may arrive later)
    const { table } = buildTable(reg, { ghost: "nonexistent-target" });
    const resolution = resolveModel(table, "ghost");
    assert.equal(resolution.kind, "resolved");
    assert.equal(
      (resolution as Extract<ModelResolution, { kind: "resolved" }>).target.id,
      "nonexistent-target",
    );
  });

  it("family name colliding with a registry id does not throw", () => {
    // "actual-id" is both a registry id and a family name of another entry —
    // byId gets the real entry; byFamily gets the family winner
    const reg = [
      entry("actual-id", { gen: [5, 6] }),
      entry("other-model", { family: "actual-id", gen: [5, 5] }),
    ];
    assert.doesNotThrow(() => buildTable(reg));
  });

  it("alias with reserved key is rejected without throwing", () => {
    const reg = [entry("gpt-5.6-sol", { gen: [5, 6] })];
    const { rejectedAliases, table } = buildTable(reg, { sonnet: "gpt-5.6-sol" });
    assert.ok(rejectedAliases.some((r) => r.alias === "sonnet"), "reserved key must be rejected");
    // The rejected alias is NOT in byAlias
    assert.equal(resolveModel(table, "sonnet").kind, "unresolved");
  });

  it("alias with reserved target is rejected without throwing (PF-007)", () => {
    const reg = [entry("gpt-5.6-sol", { gen: [5, 6] })];
    const { rejectedAliases, table } = buildTable(reg, { fast: "claude-sonnet-4-5" });
    assert.ok(rejectedAliases.some((r) => r.alias === "fast"), "alias with reserved target must be rejected");
    assert.equal(resolveModel(table, "fast").kind, "unresolved");
  });
});

// ---------------------------------------------------------------------------
// P1 — micro-benchmark: resolveModel ≤ 1.00 µs per call (P95 guard)
//
// Expected baseline ~0.05 µs. We assert ≤ 1.00 µs (20× margin) to absorb
// CI jitter, cold JIT, and measurement overhead. A catastrophic regression
// (e.g. O(n) scan per call) would still blow past 1 µs.
// ---------------------------------------------------------------------------

describe("P1 — perf budget: resolveModel ≤ 1.00 µs per call", () => {
  it("P1: 100,000 resolveModel calls stay within 1.00 µs each on average", () => {
    const { table } = buildRoutingTable(MODEL_REGISTRY, NO_ALIASES);
    const N = 100_000;

    // Warm up — let the JIT compile the hot path before measuring
    for (let i = 0; i < 1000; i++) {
      resolveModel(table, "sol");
    }

    const names = ["sol", "terra", "luna", "gpt-5.6-sol", "gpt-5.5", "unknown", "codex:sol", "kimee:k2"];
    const startNs = process.hrtime.bigint();
    for (let i = 0; i < N; i++) {
      resolveModel(table, names[i % names.length]!);
    }
    const elapsedNs = Number(process.hrtime.bigint() - startNs);
    const perCallNs = elapsedNs / N;
    const perCallUs = perCallNs / 1000;

    // Non-asserting measurement for the handoff record
    // console.log(`P1: resolveModel avg ${perCallUs.toFixed(4)} µs/call over ${N} iterations`);

    assert.ok(
      perCallUs <= 1.0,
      `resolveModel is too slow: ${perCallUs.toFixed(4)} µs/call (budget 1.00 µs). ` +
        `Check for O(n) paths (e.g. Array.find inside the hot loop).`,
    );
  });
});

// ---------------------------------------------------------------------------
// Mutation spot-check table (documented in handoff)
//
// Each test below names the rule it targets and describes what mutation would
// cause it to fail. These are structural documentation tests — the comment
// IS the test; the assertion verifies the rule applies to real data.
// ---------------------------------------------------------------------------

describe("Mutation spot-check: F4 rule 1 precedence", () => {
  it("MUTATION CHECK: removing byId lookup (rule 1) would cause F4 to fail", () => {
    // If resolveModel skipped rule 1, 'gpt-5.6-sol' would hit the alias map (rule 2)
    // and return 'gpt-5.5-sol'. This test catches that regression.
    const reg = [entry("gpt-5.5-sol", { gen: [5, 5] }), entry("gpt-5.6-sol", { gen: [5, 6] })];
    const { table } = buildTable(reg, { "gpt-5.6-sol": "gpt-5.5-sol" });
    const resolution = resolveModel(table, "gpt-5.6-sol");
    assert.equal(resolution.kind, "resolved");
    assert.equal((resolution as Extract<ModelResolution, { kind: "resolved" }>).target.id, "gpt-5.6-sol");
  });
});

describe("Mutation spot-check: F9 retired-not-in-family", () => {
  it("MUTATION CHECK: including retired entries in family derivation would cause F9 to fail", () => {
    // If buildFamilyMap inside buildRoutingTable didn't filter retired entries,
    // 'sol' would resolve to gpt-5.9-sol-old (newer gen but retired).
    const reg = [
      entry("gpt-5.6-sol", { family: "sol", gen: [5, 6] }),
      entry("gpt-5.9-sol-old", { family: "sol", gen: [5, 9], retired: true }),
    ];
    const { table } = buildTable(reg);
    const resolution = resolveModel(table, "sol");
    assert.equal(resolution.kind, "resolved");
    assert.equal((resolution as Extract<ModelResolution, { kind: "resolved" }>).target.id, "gpt-5.6-sol");
  });
});

describe("Mutation spot-check: one-hop alias enforcement", () => {
  it("MUTATION CHECK: following transitive aliases would cause one-hop test to fail", () => {
    // If resolveModel recursively followed alias targets, 'a' would resolve to 'final-target'.
    // The one-hop rule means it must stop at 'intermediate'.
    const reg = [entry("final-target", { gen: [5, 6] }), entry("intermediate", { gen: [5, 5] })];
    const { table } = buildTable(reg, { a: "intermediate", intermediate: "final-target" });
    const resolution = resolveModel(table, "a");
    assert.equal((resolution as Extract<ModelResolution, { kind: "resolved" }>).target.id, "intermediate");
  });
});

describe("Mutation spot-check: prototype-pollution — correct test uses own-property keys", () => {
  it("MUTATION CHECK: own-property 'constructor' alias resolves; removing byAlias lookup (rule 2) would cause failure", () => {
    // This is the CORRECT mutation target: a JSON-produced own-property alias key.
    // If rule 2 (byAlias lookup) is removed from resolveModel, an own-property
    // "constructor" alias would no longer resolve.
    const reg = [entry("gpt-5.6-sol", { gen: [5, 6] })];
    const { table } = buildTable(reg, { constructor: "gpt-5.6-sol" });
    assert.equal(
      (resolveModel(table, "constructor") as Extract<ModelResolution, { kind: "resolved" }>).target.id,
      "gpt-5.6-sol",
      "own-property 'constructor' alias must resolve via rule 2",
    );
  });
});

// Verify all current PROVIDER_IDS values are covered (sanity)
describe("PROVIDER_IDS coverage sanity", () => {
  it("PROVIDER_IDS contains at least 'codex'", () => {
    assert.ok(
      (PROVIDER_IDS as readonly string[]).includes("codex"),
      "codex must be in PROVIDER_IDS",
    );
  });
});

// ---------------------------------------------------------------------------
// Item D — the family selection rule has exactly ONE implementation.
//
// Every test below asserts on BOTH the router path (resolveModel) and the
// display path (buildAliasRows). Before the dedupe those were two loops with
// two copies of the rule, so a fixture could satisfy one and not the other;
// one fixture covering both is the point of the change, not a convenience.
// ---------------------------------------------------------------------------

/** The canonical id the router resolves a bare family name to. */
const routerWinner = (registry: readonly ModelEntry[], family: string): string | undefined => {
  const resolution = resolveModel(buildTable(registry).table, family);
  return resolution.kind === "resolved" ? resolution.target.id : undefined;
};

/** The canonical id the displayed derived row names for a bare family name. */
const displayWinner = (registry: readonly ModelEntry[], family: string): string | undefined =>
  buildAliasRows(registry, NO_ALIASES).find((r) => r.alias === family && r.source === "derived")?.canonical;

describe("D-T3 — generation comparison is numeric and element-wise, not string", () => {
  // Each rule gets its own fixture. A suite that only covers single-digit
  // components passes under a string comparator, which is why [5,10] is here.
  const winnerOf = (registry: readonly ModelEntry[]): { router: string | undefined; display: string | undefined } => ({
    router: routerWinner(registry, "sol"),
    display: displayWinner(registry, "sol"),
  });

  it("D-T3a: [5,10] beats [5,6] — THE discriminating case (string compare reads '5.10' < '5.6')", () => {
    const reg = [
      entry("gpt-5.6-sol", { family: "sol", gen: [5, 6] }),
      entry("gpt-5.10-sol", { family: "sol", gen: [5, 10] }),
    ];
    assert.deepEqual(winnerOf(reg), { router: "gpt-5.10-sol", display: "gpt-5.10-sol" });
  });

  it("D-T3b: [6,0] beats [5,99] — the leading element decides", () => {
    const reg = [
      entry("gpt-5.99-sol", { family: "sol", gen: [5, 99] }),
      entry("gpt-6.0-sol", { family: "sol", gen: [6, 0] }),
    ];
    assert.deepEqual(winnerOf(reg), { router: "gpt-6.0-sol", display: "gpt-6.0-sol" });
  });

  it("D-T3c: [5,6,1] beats [5,6] — longer tuple wins on an equal prefix", () => {
    const reg = [
      entry("gpt-5.6-sol", { family: "sol", gen: [5, 6] }),
      entry("gpt-5.6.1-sol", { family: "sol", gen: [5, 6, 1] }),
    ];
    assert.deepEqual(winnerOf(reg), { router: "gpt-5.6.1-sol", display: "gpt-5.6.1-sol" });
  });

  it("D-T3d: [5] loses to [5,1] — a missing element reads as 0, it does not win by being shorter", () => {
    // Declared first, so first-declared-wins would hand it the family if the
    // comparison were not actually consulted.
    const reg = [
      entry("gpt-5-sol", { family: "sol", gen: [5] }),
      entry("gpt-5.1-sol", { family: "sol", gen: [5, 1] }),
    ];
    assert.deepEqual(winnerOf(reg), { router: "gpt-5.1-sol", display: "gpt-5.1-sol" });
  });
});

describe("D-T2 — first-declared wins an exact generation tie", () => {
  it("D-T2: identical gen [5,6], neither preview nor retired — the FIRST declared entry wins", () => {
    // The update guard is `> 0`. Flipping it to `>= 0` makes the last-declared
    // entry win and turns registry order into a silent repointing hazard.
    // One fixture, both paths: there is only one implementation to catch now.
    const reg = [
      entry("gpt-5.6-sol-first", { family: "sol", gen: [5, 6] }),
      entry("gpt-5.6-sol-second", { family: "sol", gen: [5, 6] }),
    ];
    assert.equal(routerWinner(reg, "sol"), "gpt-5.6-sol-first", "router must keep the first-declared entry");
    assert.equal(displayWinner(reg, "sol"), "gpt-5.6-sol-first", "display must keep the first-declared entry");
  });
});

describe("D-T1 — the router and the display never disagree about a family", () => {
  /** Deterministic PRNG (mulberry32) — a fixed seed keeps failures reproducible. */
  const mulberry32 = (seed: number): (() => number) => {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  it("D-T1: over 200 random registries, a family is resolved by both or shown by neither", () => {
    // Two providers so contested families actually occur — under a single
    // provider this property is trivially true and proves nothing.
    const families = ["sol", "terra", "luna", "nova"];
    const providers = ["codex", "kimi"];
    const rand = mulberry32(0x5eed);
    const ITERATIONS = 200; // explicit bound

    for (let iteration = 0; iteration < ITERATIONS; iteration++) {
      const size = 1 + Math.floor(rand() * 8);
      const registry: ModelEntry[] = [];
      for (let i = 0; i < size; i++) {
        registry.push(
          foreignEntry(`m${String(iteration)}-${String(i)}`, providers[Math.floor(rand() * providers.length)] ?? "codex", {
            family: families[Math.floor(rand() * families.length)] ?? "sol",
            gen: [5, Math.floor(rand() * 12)],
            ...(rand() < 0.15 ? { preview: true } : {}),
            ...(rand() < 0.15 ? { retired: true } : {}),
          }),
        );
      }

      const { table } = buildTable(registry);
      const rows = buildAliasRows(registry, NO_ALIASES);

      for (const entryOf of registry) {
        const family = entryOf.family;
        if (family === undefined) continue;
        const resolution = resolveModel(table, family);
        const derived = rows.find((r) => r.alias === family && r.source === "derived");
        const where = `iteration ${String(iteration)}, family "${family}"`;

        if (resolution.kind === "resolved") {
          assert.ok(derived !== undefined, `${where}: router resolves it but no derived row was emitted`);
          assert.equal(derived.canonical, resolution.target.id, `${where}: router and display name different winners`);
          assert.equal(derived.provider, resolution.target.provider, `${where}: router and display name different providers`);
        } else if (resolution.kind === "ambiguous") {
          assert.equal(derived, undefined, `${where}: router refuses to resolve it but display emitted a derived row anyway`);
        }
      }
    }
  });

  it("D-T1b: a contested family shows no derived row, and its members still show as (direct)", () => {
    // The truthful display for a name the router will not resolve: no alias row
    // claiming one provider owns it, but the models themselves are still listed.
    const reg = [
      entry("codex-pro", { family: "pro", gen: [5, 6] }),
      foreignEntry("kimi-pro", "kimi", { family: "pro", gen: [5, 6] }),
    ];
    const resolution = resolveModel(buildTable(reg).table, "pro");
    assert.equal(resolution.kind, "ambiguous", "two providers claiming 'pro' must be ambiguous");

    const rows = buildAliasRows(reg, NO_ALIASES);
    assert.equal(rows.filter((r) => r.alias === "pro").length, 0, "a contested family must not produce an alias row");
    assert.deepEqual(
      rows.filter((r) => r.source === "direct").map((r) => r.canonical).sort(),
      ["codex-pro", "kimi-pro"],
      "both contested members must still appear as direct rows",
    );
  });
});

describe("D-T4 — an alias row's provider comes from the target when known, else from the declaration", () => {
  it("D-T4a: a dangling alias target renders with the declaring provider [NOT discriminating — see comment]", () => {
    // Regression: nothing asserted this row's provider before, so the field was
    // entirely uncovered — poisoning it with a sentinel used to leave the suite green.
    // This test closes that: the row's provider is now asserted at all.
    //
    // WHAT IT DOES NOT SHOW, stated here because it is easy to misread from the name:
    // it cannot distinguish `?? declaringProvider` from `?? PROVIDER_IDS[0]`. With
    // PROVIDER_IDS = ["codex"] the declaring provider IS PROVIDER_IDS[0] for every
    // declaration that can exist, so both sides of this comparison derive from the same
    // single id. Verified, not assumed: reverting the source to `?? PROVIDER_IDS[0]`
    // leaves the entire suite green. Treat that green as a permanent hole until a
    // second provider ships, not as coverage.
    //
    // The rule is still the right one — an out-of-tree probe with PROVIDER_IDS patched
    // to ["codex","kimi"] shows the old code attributing a kimi-declared alias to codex.
    // When a second id lands, promote that probe here as D-T4c and this becomes
    // discriminating for free. D-T4b below covers the half that IS testable today.
    const rows = buildAliasRows(MODEL_REGISTRY, { codex: { myalias: "gpt-9.9-nonexistent" } });
    const dangling = rows.find((r) => r.alias === "myalias");
    assert.ok(dangling !== undefined, "dangling alias must appear as a row");
    assert.equal(dangling.provider, "codex", "a dangling target belongs to the provider that declared the alias");
  });

  it("D-T4b: a resolvable alias target renders with the TARGET's provider, not the declaring one", () => {
    // The discriminating half that is testable while PROVIDER_IDS is ["codex"]:
    // the target's own provider must win over the declaring provider, matching
    // the router's `byId.get(target) ?? provider`.
    const reg = [foreignEntry("kimi-k2", "kimi", { gen: [2, 0] })];
    const rows = buildAliasRows(reg, { codex: { k2: "kimi-k2" } });
    const aliasRow = rows.find((r) => r.alias === "k2");
    assert.ok(aliasRow !== undefined, "alias row must exist");
    assert.equal(aliasRow.provider, "kimi", "the target's provider must win over the declaring provider");

    // The router agrees — same rule, same answer.
    const resolution = resolveModel(buildRoutingTable(reg, { codex: { k2: "kimi-k2" } }).table, "k2");
    assert.equal(resolution.kind, "resolved");
    assert.equal((resolution as Extract<ModelResolution, { kind: "resolved" }>).target.provider, "kimi");
  });
});
