import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MODEL_REGISTRY,
  formatModelsReport,
  buildAliasRows,
  buildModelRows,
  buildRoutingTable,
  resolveModel,
  type ModelEntry,
  type ModelResolution,
} from "../../src/models.js";

// ---------------------------------------------------------------------------
// formatModelsReport — output shape
// ---------------------------------------------------------------------------

describe("formatModelsReport", () => {
  it("returns an array of strings", () => {
    const result = formatModelsReport({ registry: MODEL_REGISTRY, overrides: {} });
    assert.ok(Array.isArray(result));
    for (const line of result) {
      assert.equal(typeof line, "string");
    }
  });

  it("includes derived family alias names and canonicals in output", () => {
    const result = formatModelsReport({ registry: MODEL_REGISTRY, overrides: {} });
    const text = result.join("\n");
    assert.ok(text.includes("sol"), "should mention 'sol' alias");
    assert.ok(text.includes("gpt-5.6-sol"), "should mention 'gpt-5.6-sol' canonical");
  });

  it("marks alias as 'enabled' for non-retired models", () => {
    const result = formatModelsReport({ registry: MODEL_REGISTRY, overrides: {} });
    const solLine = result.find((l) => l.includes("sol") && l.includes("gpt-5.6-sol"));
    assert.ok(solLine !== undefined, "should have a line covering the sol alias");
    assert.ok(solLine.includes("enabled"), "sol alias should be marked enabled");
  });

  it("includes a provider column in every row", () => {
    const result = formatModelsReport({ registry: MODEL_REGISTRY, overrides: {} });
    // Every row should contain "codex" since all registry entries are codex-provider.
    for (const line of result) {
      assert.ok(line.includes("codex"), `row must include provider column: ${line}`);
    }
  });

  it("labels derived registry aliases as '(derived)'", () => {
    const result = formatModelsReport({ registry: MODEL_REGISTRY, overrides: {} });
    const text = result.join("\n");
    assert.ok(text.includes("(derived)"), "should label registry aliases as derived");
  });

  it("labels config override aliases as '(config)' and registry aliases as '(derived)'", () => {
    const result = formatModelsReport({
      registry: MODEL_REGISTRY,
      overrides: { "fast": "gpt-5.6-sol" },
    });
    const text = result.join("\n");
    // Should have at least one "(config)" line for the override
    assert.ok(text.includes("(config)"), "should label override alias as config");
    assert.ok(text.includes("(derived)"), "should also have derived aliases");
  });

  it("includes a '(direct)' row for gpt-5.5 (no family alias)", () => {
    // gpt-5.5 has no family field — it never appears as the canonical of an alias row.
    // It must appear as a direct row with an empty alias column so the table is complete.
    const result = formatModelsReport({ registry: MODEL_REGISTRY, overrides: {} });
    const directLine = result.find((l) => l.includes("gpt-5.5") && l.includes("(direct)"));
    assert.ok(directLine !== undefined, "gpt-5.5 (no family alias) must appear as a (direct) row");
    assert.ok(directLine.includes("enabled"), "gpt-5.5 direct row must be marked enabled");
  });

  it("does not emit a '(direct)' row for an id already covered as a canonical of an alias row", () => {
    // gpt-5.6-sol is the canonical of the 'sol' derived alias row — no double-listing.
    const result = formatModelsReport({ registry: MODEL_REGISTRY, overrides: {} });
    const solDirectLines = result.filter((l) => l.includes("gpt-5.6-sol") && l.includes("(direct)"));
    assert.equal(solDirectLines.length, 0, "gpt-5.6-sol is already the canonical of the sol alias row — no extra (direct) row");
  });

  it("does not include retired models", () => {
    const reg: readonly ModelEntry[] = [
      { id: "gpt-5.6-sol", provider: "codex", family: "sol", gen: [5, 6] },
      { id: "gpt-old", provider: "codex", family: "sol", gen: [5, 0], retired: true },
    ];
    const result = formatModelsReport({ registry: reg, overrides: {} });
    const text = result.join("\n");
    assert.ok(!text.includes("gpt-old"), "retired model must not appear in report");
  });
});

// ---------------------------------------------------------------------------
// buildAliasRows / buildModelRows — parity test
// ---------------------------------------------------------------------------

describe("buildAliasRows and buildModelRows — parity", () => {
  it("every non-direct AliasTableRow has a matching ModelRow alias entry (and vice versa)", () => {
    // Use a realistic scenario with both derived and config aliases.
    const overrides = { "fast": "gpt-5.6-sol" };
    const aliasRows = buildAliasRows(MODEL_REGISTRY, overrides);
    const modelRows = buildModelRows(MODEL_REGISTRY, overrides);

    // Forward check: every non-direct alias row corresponds to a ModelRow alias entry.
    // (Parity invariant applies only to aliases with registry-present targets.)
    for (const aliasRow of aliasRows) {
      if (aliasRow.source === "direct") continue;
      const modelRow = modelRows.find((m) => m.id === aliasRow.canonical);
      assert.ok(
        modelRow !== undefined,
        `ModelRow for canonical "${aliasRow.canonical}" must exist`,
      );
      const hasAlias = modelRow.aliases.some(
        (a) => a.name === aliasRow.alias && a.source === aliasRow.source,
      );
      assert.ok(
        hasAlias,
        `ModelRow for "${aliasRow.canonical}" must have alias "${aliasRow.alias}" (source: ${aliasRow.source})`,
      );
    }

    // Reverse check: every ModelRow alias entry has a non-direct AliasTableRow.
    for (const modelRow of modelRows) {
      for (const aliasEntry of modelRow.aliases) {
        const aliasRow = aliasRows.find(
          (r) =>
            r.alias === aliasEntry.name &&
            r.canonical === modelRow.id &&
            r.source === aliasEntry.source,
        );
        assert.ok(
          aliasRow !== undefined,
          `AliasTableRow for alias "${aliasEntry.name}" → "${modelRow.id}" (source: ${aliasEntry.source}) must exist`,
        );
      }
    }
  });

  it("dangling alias target (not in registry) — buildAliasRows shows enabled=true, gen='?'", () => {
    // A dangling alias target (e.g. future model id) is routed by the router (forward-compat)
    // so the display must agree: enabled=true, not disabled.
    const overrides = { myalias: "gpt-9.9-nonexistent" };
    const aliasRows = buildAliasRows(MODEL_REGISTRY, overrides);
    const danglingRow = aliasRows.find((r) => r.alias === "myalias");
    assert.ok(danglingRow !== undefined, "dangling alias must appear in AliasTableRows");
    assert.equal(danglingRow.canonical, "gpt-9.9-nonexistent");
    assert.equal(danglingRow.source, "config");
    assert.equal(danglingRow.gen, "?", "gen must be '?' for dangling targets (not in registry)");
    assert.equal(
      danglingRow.enabled,
      true,
      "dangling alias must be enabled=true (router routes it via forward-compat; was incorrectly false before P1-3 fix)",
    );
  });

  it("dangling alias target — buildRoutingTable reports it in danglingAliases", () => {
    const overrides: Record<string, string> = { myalias: "gpt-9.9-nonexistent" };
    const { danglingAliases } = buildRoutingTable(MODEL_REGISTRY, { codex: overrides });
    assert.equal(danglingAliases.length, 1, "dangling alias must appear in danglingAliases");
    assert.equal(danglingAliases[0]?.alias, "myalias");
    assert.equal(danglingAliases[0]?.target, "gpt-9.9-nonexistent");
  });

  it("canonical-shadowing alias (alias key = registry id) — routing ignores alias due to rule 1", () => {
    // {"gpt-5.5": "gpt-5.6-sol"} — alias name equals a canonical registry id.
    // Rule 1 (byId) always fires first, so "gpt-5.5" routes to itself, not to "gpt-5.6-sol".
    // The alias IS in byAlias but is unreachable via resolveModel.
    const overrides: Record<string, string> = { "gpt-5.5": "gpt-5.6-sol" };
    const { table } = buildRoutingTable(MODEL_REGISTRY, { codex: overrides });
    const resolution = resolveModel(table, "gpt-5.5");
    assert.equal(resolution.kind, "resolved");
    assert.equal(
      (resolution as Extract<ModelResolution, { kind: "resolved" }>).target.id,
      "gpt-5.5",
      "gpt-5.5 must route to itself (rule 1 wins), NOT to the alias target gpt-5.6-sol",
    );
  });

  it("buildModelRows sets routable=true for non-retired entries", () => {
    const rows = buildModelRows(MODEL_REGISTRY, {});
    for (const row of rows) {
      if (!row.retired) {
        assert.equal(row.routable, true, `${row.id} must be routable if not retired`);
      }
    }
  });

  it("buildModelRows sets retired=true and routable=false for retired entries", () => {
    const reg: readonly ModelEntry[] = [
      { id: "gpt-5.6-sol", provider: "codex", family: "sol", gen: [5, 6] },
      { id: "gpt-old", provider: "codex", gen: [5, 0], retired: true },
    ];
    const rows = buildModelRows(reg, {});
    const oldRow = rows.find((r) => r.id === "gpt-old");
    assert.ok(oldRow !== undefined);
    assert.equal(oldRow.retired, true);
    assert.equal(oldRow.routable, false);
  });

  it("buildModelRows sets preview=true for preview entries", () => {
    const reg: readonly ModelEntry[] = [
      { id: "gpt-5.6-sol", provider: "codex", family: "sol", gen: [5, 6] },
      { id: "gpt-preview", provider: "codex", family: "sol", gen: [5, 7], preview: true },
    ];
    const rows = buildModelRows(reg, {});
    const previewRow = rows.find((r) => r.id === "gpt-preview");
    assert.ok(previewRow !== undefined);
    assert.equal(previewRow.preview, true);
    assert.equal(previewRow.routable, true); // preview is still routable by exact id
  });

  it("buildModelRows omits gen field when gen tuple is empty", () => {
    const reg: readonly ModelEntry[] = [
      { id: "gpt-unknown-gen", provider: "codex", gen: [] },
    ];
    const rows = buildModelRows(reg, {});
    const r = rows[0]!;
    assert.ok(!("gen" in r), "gen must be absent when tuple is empty");
  });

  it("buildModelRows omits family field when ModelEntry has no family key", () => {
    const rows = buildModelRows(MODEL_REGISTRY, {});
    // gpt-5.5 has no family
    const gpt55 = rows.find((r) => r.id === "gpt-5.5");
    assert.ok(gpt55 !== undefined);
    assert.ok(!("family" in gpt55), "family must be absent when ModelEntry has no family key");
  });

  it("buildModelRows includes provider field for all entries", () => {
    const rows = buildModelRows(MODEL_REGISTRY, {});
    for (const row of rows) {
      assert.equal(row.provider, "codex");
      assert.equal(row.source, "registry");
    }
  });
});

// ---------------------------------------------------------------------------
// Preview exclusion from family alias derivation (P1-8)
// ---------------------------------------------------------------------------

describe("Preview exclusion from family alias derivation", () => {
  it("newest family member being preview means the non-preview member wins the bare alias", () => {
    // If the newest entry is preview, the bare family alias must NOT point to it —
    // preview models are excluded from alias derivation. The older non-preview wins.
    const reg: readonly ModelEntry[] = [
      { id: "gpt-5.6-sol", provider: "codex", family: "sol", gen: [5, 6] },
      { id: "gpt-5.7-sol-preview", provider: "codex", family: "sol", gen: [5, 7], preview: true },
    ];
    const { table } = buildRoutingTable(reg, { codex: {} });

    // Bare 'sol' must resolve to the older non-preview model
    const bare = resolveModel(table, "sol");
    assert.equal(bare.kind, "resolved");
    assert.equal(
      (bare as Extract<ModelResolution, { kind: "resolved" }>).target.id,
      "gpt-5.6-sol",
      "bare 'sol' must not float onto the preview model",
    );

    // The preview model IS still routable by exact id
    const exact = resolveModel(table, "gpt-5.7-sol-preview");
    assert.equal(exact.kind, "resolved", "preview model must still be routable by exact id");
    assert.equal(
      (exact as Extract<ModelResolution, { kind: "resolved" }>).target.id,
      "gpt-5.7-sol-preview",
    );
  });

  it("MUTATION CHECK: including preview entries in family derivation would cause this test to fail", () => {
    // If buildFamilyMap did not filter preview entries, 'sol' would resolve to
    // gpt-5.7-sol-preview (newer gen) instead of gpt-5.6-sol.
    const reg: readonly ModelEntry[] = [
      { id: "gpt-5.6-sol", provider: "codex", family: "sol", gen: [5, 6] },
      { id: "gpt-5.7-sol-preview", provider: "codex", family: "sol", gen: [5, 7], preview: true },
    ];
    const { table } = buildRoutingTable(reg, { codex: {} });
    const resolution = resolveModel(table, "sol");
    assert.equal((resolution as Extract<ModelResolution, { kind: "resolved" }>).target.id, "gpt-5.6-sol");
  });
});

// ---------------------------------------------------------------------------
// CANARY TESTS — expected to fail when a new generation ships.
//
// When gpt-5.7-sol (or similar) is added to MODEL_REGISTRY, these tests fail.
// That is intentional — it is the mitigation against "adding a registry line
// silently repoints everyone." Update these expected values when bumping the registry.
// ---------------------------------------------------------------------------

describe("canary — current generation resolution via routing table (update when registry bumps)", () => {
  const { table } = buildRoutingTable(MODEL_REGISTRY, { codex: {} });

  it("'sol' resolves to gpt-5.6-sol — current 5.6 generation", () => {
    const resolution = resolveModel(table, "sol");
    assert.equal(resolution.kind, "resolved");
    if (resolution.kind === "resolved") {
      assert.equal(resolution.target.id, "gpt-5.6-sol");
    }
  });

  it("'terra' resolves to gpt-5.6-terra — current 5.6 generation", () => {
    const resolution = resolveModel(table, "terra");
    assert.equal(resolution.kind, "resolved");
    if (resolution.kind === "resolved") {
      assert.equal(resolution.target.id, "gpt-5.6-terra");
    }
  });

  it("'luna' resolves to gpt-5.6-luna — current 5.6 generation", () => {
    const resolution = resolveModel(table, "luna");
    assert.equal(resolution.kind, "resolved");
    if (resolution.kind === "resolved") {
      assert.equal(resolution.target.id, "gpt-5.6-luna");
    }
  });

  it("'gpt-5.5' resolves by exact id (no family alias)", () => {
    const resolution = resolveModel(table, "gpt-5.5");
    assert.equal(resolution.kind, "resolved");
    if (resolution.kind === "resolved") {
      assert.equal(resolution.target.id, "gpt-5.5");
    }
  });
});
