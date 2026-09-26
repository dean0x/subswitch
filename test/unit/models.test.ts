import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_REASONING_EFFORTS,
  MODEL_REGISTRY,
  formatModelsReport,
  buildAliasRows,
  buildModelRows,
  buildRoutingTable,
  reasoningEffortsForModel,
  resolveModel,
  routableModelCount,
  type ModelEntry,
  type ModelResolution,
} from "../../src/models.js";

// ---------------------------------------------------------------------------
// routableModelCount — CPLX-02 / ARCH-10 / PERF-08
// ---------------------------------------------------------------------------

describe("routableModelCount", () => {
  it("returns the non-retired codex model count matching the live registry", () => {
    // Literal pin, deliberately. The previous form compared routableModelCount against an
    // inline re-spelling of its own filter, so both sides moved together and the canary
    // stayed green when the registry went 4 -> 5 — a control that cannot fire is not a
    // control. One side of an assertion must be INDEPENDENT of the code under test.
    // (avoids PF-011)
    //
    // MUTATION PROOF: changing this literal to 4 turns the assertion RED.
    // Update the literal — never the registry — when MODEL_REGISTRY changes.
    assert.equal(
      routableModelCount(MODEL_REGISTRY, "codex"),
      6,
      "update this literal when MODEL_REGISTRY changes",
    );
  });

  it("returns 0 when every registry entry for the provider is retired", () => {
    const reg: readonly ModelEntry[] = [
      { id: "gpt-old-a", provider: "codex", gen: [4, 0], retired: true },
      { id: "gpt-old-b", provider: "codex", gen: [4, 1], retired: true },
    ];
    assert.equal(routableModelCount(reg, "codex"), 0);
  });

  it("does not count entries belonging to a different provider", () => {
    // Hypothetical: two providers — only codex entries must count.
    const reg: readonly ModelEntry[] = [
      { id: "gpt-5.6-sol", provider: "codex", family: "sol", gen: [5, 6] },
    ];
    // Passing a provider that has no entries in this synthetic registry returns 0.
    // Cast to satisfy ProviderId — "codex" is the only valid value today, but the
    // function accepts any ProviderId; we verify the filter boundary here.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal(routableModelCount(reg, "codex"), 1);
    // The only entry is codex; count must be exactly 1.
  });

  it("MUTATION CHECK: counting retired entries would inflate the result", () => {
    // If the retired guard were removed, a retired entry would be counted.
    // This test proves the guard is load-bearing.
    const reg: readonly ModelEntry[] = [
      { id: "live", provider: "codex", gen: [5, 6] },
      { id: "gone", provider: "codex", gen: [4, 0], retired: true },
    ];
    assert.equal(
      routableModelCount(reg, "codex"),
      1,
      "retired entry must not be counted — if this fails, the retired guard is missing",
    );
  });
});

// ---------------------------------------------------------------------------
// formatModelsReport — output shape
// ---------------------------------------------------------------------------

describe("formatModelsReport", () => {
  it("returns an array of strings", () => {
    const result = formatModelsReport({ registry: MODEL_REGISTRY, aliasesByProvider: { codex: {} } });
    assert.ok(Array.isArray(result));
    for (const line of result) {
      assert.equal(typeof line, "string");
    }
  });

  it("includes derived family alias names and canonicals in output", () => {
    const result = formatModelsReport({ registry: MODEL_REGISTRY, aliasesByProvider: { codex: {} } });
    const text = result.join("\n");
    assert.ok(text.includes("sol"), "should mention 'sol' alias");
    assert.ok(text.includes("gpt-6-sol"), "should mention 'gpt-6-sol' canonical");
  });

  it("marks alias as 'enabled' for non-retired models", () => {
    const result = formatModelsReport({ registry: MODEL_REGISTRY, aliasesByProvider: { codex: {} } });
    const solLine = result.find((l) => l.includes("sol") && l.includes("gpt-6-sol"));
    assert.ok(solLine !== undefined, "should have a line covering the sol alias");
    assert.ok(solLine.includes("enabled"), "sol alias should be marked enabled");
  });

  it("includes a provider column in every row", () => {
    const result = formatModelsReport({ registry: MODEL_REGISTRY, aliasesByProvider: { codex: {} } });
    // Every row should contain "codex" since all registry entries are codex-provider.
    for (const line of result) {
      assert.ok(line.includes("codex"), `row must include provider column: ${line}`);
    }
  });

  it("labels derived registry aliases as '(derived)'", () => {
    const result = formatModelsReport({ registry: MODEL_REGISTRY, aliasesByProvider: { codex: {} } });
    const text = result.join("\n");
    assert.ok(text.includes("(derived)"), "should label registry aliases as derived");
  });

  it("labels config override aliases as '(config)' and registry aliases as '(derived)'", () => {
    const result = formatModelsReport({
      registry: MODEL_REGISTRY,
      aliasesByProvider: { codex: { "fast": "gpt-5.6-sol" } },
    });
    const text = result.join("\n");
    // Should have at least one "(config)" line for the override
    assert.ok(text.includes("(config)"), "should label override alias as config");
    assert.ok(text.includes("(derived)"), "should also have derived aliases");
  });

  it("includes a '(direct)' row for a live model with no family alias", () => {
    // A family-less entry never appears as the canonical of an alias row. It must appear
    // as a direct row with an empty alias column so the table is complete.
    const reg: readonly ModelEntry[] = [
      { id: "gpt-5.6-sol", provider: "codex", family: "sol", gen: [5, 6] },
      { id: "gpt-9-plain", provider: "codex", gen: [9] },
    ];
    const result = formatModelsReport({ registry: reg, aliasesByProvider: { codex: {} } });
    const directLine = result.find((l) => l.includes("gpt-9-plain") && l.includes("(direct)"));
    assert.ok(directLine !== undefined, "a family-less live model must appear as a (direct) row");
    assert.ok(directLine.includes("enabled"), "the direct row must be marked enabled");
  });

  it("omits the retired gpt-5.5 from the human-readable table", () => {
    // gpt-5.5 leaves ChatGPT/Codex on 2026-10-14. It is marked retired rather than deleted,
    // so it stays routable by exact id but is no longer advertised as an option.
    const result = formatModelsReport({ registry: MODEL_REGISTRY, aliasesByProvider: { codex: {} } });
    assert.equal(result.some((l) => l.includes("gpt-5.5")), false, "retired gpt-5.5 must not be listed");
  });

  it("does not emit a '(direct)' row for an id already covered as a canonical of an alias row", () => {
    // gpt-6-sol is the canonical of the 'sol' derived alias row — no double-listing.
    const result = formatModelsReport({ registry: MODEL_REGISTRY, aliasesByProvider: { codex: {} } });
    const solDirectLines = result.filter((l) => l.includes("gpt-6-sol") && l.includes("(direct)"));
    assert.equal(solDirectLines.length, 0, "gpt-6-sol is already the canonical of the sol alias row — no extra (direct) row");
  });

  it("keeps a superseded family member visible as a '(direct)' row", () => {
    // gpt-5.6-sol lost the 'sol' alias to gpt-6-sol but is still served and routable by
    // exact id, so the table must still list it — otherwise a pinned agent's model vanishes.
    const result = formatModelsReport({ registry: MODEL_REGISTRY, aliasesByProvider: { codex: {} } });
    const directLine = result.find((l) => l.includes("gpt-5.6-sol") && l.includes("(direct)"));
    assert.ok(directLine !== undefined, "gpt-5.6-sol must appear as a (direct) row once GPT-6 holds 'sol'");
    assert.ok(directLine.includes("enabled"), "gpt-5.6-sol direct row must be marked enabled");
  });

  it("does not include retired models", () => {
    const reg: readonly ModelEntry[] = [
      { id: "gpt-5.6-sol", provider: "codex", family: "sol", gen: [5, 6] },
      { id: "gpt-old", provider: "codex", family: "sol", gen: [5, 0], retired: true },
    ];
    const result = formatModelsReport({ registry: reg, aliasesByProvider: { codex: {} } });
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
    const aliasRows = buildAliasRows(MODEL_REGISTRY, { codex: overrides });
    const modelRows = buildModelRows(MODEL_REGISTRY, { codex: overrides });

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
    const aliasRows = buildAliasRows(MODEL_REGISTRY, { codex: overrides });
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
    const rows = buildModelRows(MODEL_REGISTRY, { codex: {} });
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
    const rows = buildModelRows(reg, { codex: {} });
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
    const rows = buildModelRows(reg, { codex: {} });
    const previewRow = rows.find((r) => r.id === "gpt-preview");
    assert.ok(previewRow !== undefined);
    assert.equal(previewRow.preview, true);
    assert.equal(previewRow.routable, true); // preview is still routable by exact id
  });

  it("buildModelRows omits gen field when gen tuple is empty", () => {
    const reg: readonly ModelEntry[] = [
      { id: "gpt-unknown-gen", provider: "codex", gen: [] },
    ];
    const rows = buildModelRows(reg, { codex: {} });
    const r = rows[0]!;
    assert.ok(!("gen" in r), "gen must be absent when tuple is empty");
  });

  it("buildModelRows omits family field when ModelEntry has no family key", () => {
    const rows = buildModelRows(MODEL_REGISTRY, { codex: {} });
    // gpt-5.5 has no family
    const gpt55 = rows.find((r) => r.id === "gpt-5.5");
    assert.ok(gpt55 !== undefined);
    assert.ok(!("family" in gpt55), "family must be absent when ModelEntry has no family key");
  });

  it("buildModelRows includes provider field for all entries", () => {
    const rows = buildModelRows(MODEL_REGISTRY, { codex: {} });
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
// reasoningEffortsForModel — per-model effort vocabulary
// ---------------------------------------------------------------------------

describe("reasoningEffortsForModel", () => {
  // Synthetic registry with made-up ids. The accessor takes the registry as its first
  // parameter — like every other consumer in this module — so the per-model rule is
  // testable without pinning whichever real ids happen to declare reasoningEfforts.
  const SYNTHETIC_REGISTRY: readonly ModelEntry[] = [
    { id: "gpt-9-nova", provider: "codex", family: "nova", gen: [9], reasoningEfforts: ["gentle", "fierce"] },
    { id: "gpt-9-plain", provider: "codex", gen: [9] },
  ];

  it("returns the declaring entry's own list", () => {
    assert.deepEqual(reasoningEffortsForModel(SYNTHETIC_REGISTRY, "gpt-9-nova"), ["gentle", "fierce"]);
  });

  // TOTAL: the accessor never returns undefined, so callers make ONE positive
  // membership test instead of branching between two spellings of the vocabulary.
  it("falls back to the default set when the entry declares no reasoningEfforts", () => {
    assert.deepEqual(reasoningEffortsForModel(SYNTHETIC_REGISTRY, "gpt-9-plain"), [...DEFAULT_REASONING_EFFORTS]);
  });

  it("falls back to the default set for an id absent from the registry", () => {
    assert.deepEqual(reasoningEffortsForModel(SYNTHETIC_REGISTRY, "gpt-9-nonexistent"), [...DEFAULT_REASONING_EFFORTS]);
  });

  it("declares the backend-wide effort set as the single vocabulary (avoids PF-014)", () => {
    assert.deepEqual([...DEFAULT_REASONING_EFFORTS], ["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
  });
});

// ---------------------------------------------------------------------------
// buildRoutingTable — reasoningEfforts registry self-check (reliability-09)
// ---------------------------------------------------------------------------

describe("buildRoutingTable — reasoningEfforts self-check", () => {
  it("diagnoses an entry whose reasoningEfforts are not a subset of the default set", () => {
    const reg: readonly ModelEntry[] = [
      { id: "gpt-9-typo", provider: "codex", family: "typo", gen: [9], reasoningEfforts: ["xhig"] },
    ];
    const build = buildRoutingTable(reg, { codex: {} });
    assert.deepEqual(build.unknownReasoningEfforts, [{ id: "gpt-9-typo", efforts: ["xhig"] }]);
    // TOTAL: a typo is reported as data, never thrown, and the entry still routes.
    assert.equal(build.table.byId.get("gpt-9-typo"), "codex");
  });

  it("reports only the offending values, leaving valid neighbours out", () => {
    const reg: readonly ModelEntry[] = [
      { id: "gpt-9-mixed", provider: "codex", gen: [9], reasoningEfforts: ["low", "xhig", "maxx"] },
    ];
    assert.deepEqual(buildRoutingTable(reg, { codex: {} }).unknownReasoningEfforts, [
      { id: "gpt-9-mixed", efforts: ["xhig", "maxx"] },
    ]);
  });

  it("says nothing about entries that declare a valid subset, or none at all", () => {
    const reg: readonly ModelEntry[] = [
      { id: "gpt-9-narrow", provider: "codex", gen: [9], reasoningEfforts: ["low", "high"] },
      { id: "gpt-9-plain", provider: "codex", gen: [9] },
    ];
    assert.deepEqual(buildRoutingTable(reg, { codex: {} }).unknownReasoningEfforts, []);
  });

  it("reports nothing for the live registry", () => {
    assert.deepEqual(buildRoutingTable(MODEL_REGISTRY, { codex: {} }).unknownReasoningEfforts, []);
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

  const resolvedId = (name: string): string | undefined => {
    const resolution = resolveModel(table, name);
    return resolution.kind === "resolved" ? resolution.target.id : undefined;
  };

  it("'sol' resolves to gpt-6-sol — GPT-6 generation", () => {
    assert.equal(resolvedId("sol"), "gpt-6-sol");
  });

  it("'terra' resolves to gpt-5.6-terra — GPT-6 has no Terra, so 5.6 keeps the alias", () => {
    assert.equal(resolvedId("terra"), "gpt-5.6-terra");
  });

  it("'luna' resolves to gpt-6-luna — GPT-6 generation", () => {
    assert.equal(resolvedId("luna"), "gpt-6-luna");
  });

  it("superseded gpt-5.6-sol and gpt-5.6-luna still resolve by exact id", () => {
    // Losing the family alias must not unroute an agent pinned to the older canonical id.
    assert.equal(resolvedId("gpt-5.6-sol"), "gpt-5.6-sol");
    assert.equal(resolvedId("gpt-5.6-luna"), "gpt-5.6-luna");
  });

  it("retired 'gpt-5.5' still resolves by exact id and by its qualified id", () => {
    // Retiring must never unroute a pin: a pinned agent keeps reaching Codex and gets the
    // upstream's own answer rather than being silently re-sent to Anthropic.
    assert.equal(resolvedId("gpt-5.5"), "gpt-5.5");
    assert.equal(resolvedId("codex:gpt-5.5"), "gpt-5.5");
  });

  it("gpt-5.5 is marked retired and not routable in the model rows", () => {
    const row = buildModelRows(MODEL_REGISTRY, { codex: {} }).find((r) => r.id === "gpt-5.5");
    assert.ok(row !== undefined, "gpt-5.5 must stay in the registry — never delete, mark retired");
    assert.equal(row.retired, true);
    assert.equal(row.routable, false);
    assert.deepEqual(row.aliases, [], "a retired model wins no family alias");
  });

  it("every live gpt-5.6 entry stays routable (only gpt-5.5 is retired)", () => {
    const rows = buildModelRows(MODEL_REGISTRY, { codex: {} });
    for (const id of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
      assert.equal(rows.find((r) => r.id === id)?.routable, true, `${id} must remain routable`);
    }
  });
});
