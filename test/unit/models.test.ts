import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MODEL_REGISTRY,
  makeModelResolver,
  formatModelsReport,
  type ModelEntry,
} from "../../src/models.js";

// ---------------------------------------------------------------------------
// Resolution order
// ---------------------------------------------------------------------------

describe("makeModelResolver — resolution order", () => {
  // Synthetic registry: two sol entries so we can test priority without
  // depending on real generations being in any specific order.
  const reg: readonly ModelEntry[] = [
    { id: "gpt-5.10-sol", provider: "codex", family: "sol", gen: [5, 10] },
    { id: "gpt-5.6-sol", provider: "codex", family: "sol", gen: [5, 6] },
    { id: "gpt-5.6-terra", provider: "codex", family: "terra", gen: [5, 6] },
  ];

  it("exact id in routable set resolves to itself even when an override tries to shadow it", () => {
    const routable = new Set(["gpt-5.10-sol", "gpt-5.6-sol"]);
    const overrides = { "gpt-5.10-sol": "gpt-5.6-sol" }; // override tries to shadow an exact id
    const resolve = makeModelResolver(reg, routable, overrides);
    // Rule 1 fires: "gpt-5.10-sol" is in routable → return itself, not the override target
    assert.equal(resolve("gpt-5.10-sol"), "gpt-5.10-sol");
  });

  it("override beats derived alias when name is not an exact routable id", () => {
    const routable = new Set(["gpt-5.10-sol", "gpt-5.6-sol"]);
    // Derived alias for "sol" would be "gpt-5.10-sol" (newest in routable)
    // Override redirects "sol" to "gpt-5.6-sol" instead — override wins
    const overrides = { "sol": "gpt-5.6-sol" };
    const resolve = makeModelResolver(reg, routable, overrides);
    assert.equal(resolve("sol"), "gpt-5.6-sol");
  });

  it("override target is used verbatim even when outside the registry", () => {
    const routable = new Set(["gpt-5.6-sol", "custom-model"]);
    const overrides = { "fast": "custom-model" };
    const resolve = makeModelResolver(reg, routable, overrides);
    assert.equal(resolve("fast"), "custom-model");
  });

  it("resolves to undefined for a name not in routable, overrides, or families", () => {
    const routable = new Set(["gpt-5.6-sol"]);
    const resolve = makeModelResolver(reg, routable, {});
    assert.equal(resolve("completely-unknown"), undefined);
  });
});

// ---------------------------------------------------------------------------
// Alias derivation — numeric tuple comparison (the headline correctness test)
// ---------------------------------------------------------------------------

describe("makeModelResolver — alias derivation with synthetic registry", () => {
  it("gen [5,10] beats [5,6] — string compare would get this wrong", () => {
    const reg: readonly ModelEntry[] = [
      { id: "model-5.6", provider: "codex", family: "fam", gen: [5, 6] },
      { id: "model-5.10", provider: "codex", family: "fam", gen: [5, 10] },
    ];
    const routable = new Set(["model-5.6", "model-5.10"]);
    const resolve = makeModelResolver(reg, routable, {});
    assert.equal(resolve("fam"), "model-5.10");
  });

  it("[6,0] beats [5,99]", () => {
    const reg: readonly ModelEntry[] = [
      { id: "model-5.99", provider: "codex", family: "fam", gen: [5, 99] },
      { id: "model-6.0", provider: "codex", family: "fam", gen: [6, 0] },
    ];
    const routable = new Set(["model-5.99", "model-6.0"]);
    const resolve = makeModelResolver(reg, routable, {});
    assert.equal(resolve("fam"), "model-6.0");
  });

  it("longer tuple wins on equal prefix ([5,6,1] > [5,6])", () => {
    const reg: readonly ModelEntry[] = [
      { id: "model-5.6", provider: "codex", family: "fam", gen: [5, 6] },
      { id: "model-5.6.1", provider: "codex", family: "fam", gen: [5, 6, 1] },
    ];
    const routable = new Set(["model-5.6", "model-5.6.1"]);
    const resolve = makeModelResolver(reg, routable, {});
    assert.equal(resolve("fam"), "model-5.6.1");
  });

  it("preview model is excluded from alias derivation but resolves by exact id", () => {
    const reg: readonly ModelEntry[] = [
      { id: "model-5.6", provider: "codex", family: "fam", gen: [5, 6] },
      { id: "model-5.11-preview", provider: "codex", family: "fam", gen: [5, 11], preview: true },
    ];
    const routable = new Set(["model-5.6", "model-5.11-preview"]);
    const resolve = makeModelResolver(reg, routable, {});
    assert.equal(resolve("fam"), "model-5.6"); // preview excluded from alias derivation
    assert.equal(resolve("model-5.11-preview"), "model-5.11-preview"); // exact id still resolves
  });

  it("retired model is excluded from alias derivation but resolves by exact id", () => {
    const reg: readonly ModelEntry[] = [
      { id: "model-5.6", provider: "codex", family: "fam", gen: [5, 6] },
      { id: "model-5.7-old", provider: "codex", family: "fam", gen: [5, 7], retired: true },
    ];
    const routable = new Set(["model-5.6", "model-5.7-old"]);
    const resolve = makeModelResolver(reg, routable, {});
    assert.equal(resolve("fam"), "model-5.6"); // retired excluded from alias derivation
    assert.equal(resolve("model-5.7-old"), "model-5.7-old"); // exact id still resolves
  });

  it("entry without a family key gets no alias — only exact-id resolution", () => {
    const reg: readonly ModelEntry[] = [
      { id: "no-family-model", provider: "codex", gen: [5, 6] }, // family key intentionally omitted
    ];
    const routable = new Set(["no-family-model"]);
    const resolve = makeModelResolver(reg, routable, {});
    assert.equal(resolve("no-family-model"), "no-family-model"); // exact match works
    assert.equal(resolve("anything-else"), undefined); // no alias created
  });

  it("first-declared wins on exact gen tie", () => {
    const reg: readonly ModelEntry[] = [
      { id: "model-a", provider: "codex", family: "fam", gen: [5, 6] },
      { id: "model-b", provider: "codex", family: "fam", gen: [5, 6] }, // same gen — model-a was first
    ];
    const routable = new Set(["model-a", "model-b"]);
    const resolve = makeModelResolver(reg, routable, {});
    assert.equal(resolve("fam"), "model-a");
  });
});

// ---------------------------------------------------------------------------
// Scoping — family alias resolves only within the routable set (ADR-005)
// ---------------------------------------------------------------------------

describe("makeModelResolver — scoping to routable set", () => {
  it("a narrowed routable set pins to the allowed model, not the newest registry entry", () => {
    const reg: readonly ModelEntry[] = [
      { id: "model-5.6", provider: "codex", family: "sol", gen: [5, 6] },
      { id: "model-5.10", provider: "codex", family: "sol", gen: [5, 10] },
    ];
    // v0.1.0 user who pinned only model-5.6 — model-5.10 added later to registry
    const routable = new Set(["model-5.6"]);
    const resolve = makeModelResolver(reg, routable, {});
    // "sol" must resolve to model-5.6 (routable), not model-5.10 (not in routable)
    assert.equal(resolve("sol"), "model-5.6");
  });

  it("family alias is undefined when no routable member exists for that family", () => {
    const reg: readonly ModelEntry[] = [
      { id: "model-sol", provider: "codex", family: "sol", gen: [5, 6] },
    ];
    const routable = new Set<string>([]); // empty — nothing is routable
    const resolve = makeModelResolver(reg, routable, {});
    assert.equal(resolve("sol"), undefined);
  });
});

// ---------------------------------------------------------------------------
// formatModelsReport — output shape
// ---------------------------------------------------------------------------

describe("formatModelsReport", () => {
  const fullRoutable = new Set(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"]);

  it("returns an array of strings", () => {
    const result = formatModelsReport({ registry: MODEL_REGISTRY, routable: fullRoutable, overrides: {} });
    assert.ok(Array.isArray(result));
    for (const line of result) {
      assert.equal(typeof line, "string");
    }
  });

  it("includes derived family alias names and canonicals in output", () => {
    const result = formatModelsReport({ registry: MODEL_REGISTRY, routable: fullRoutable, overrides: {} });
    const text = result.join("\n");
    assert.ok(text.includes("sol"), "should mention 'sol' alias");
    assert.ok(text.includes("gpt-5.6-sol"), "should mention 'gpt-5.6-sol' canonical");
  });

  it("marks alias as 'enabled' when canonical is in routable set", () => {
    const result = formatModelsReport({ registry: MODEL_REGISTRY, routable: fullRoutable, overrides: {} });
    const solLine = result.find((l) => l.includes("sol") && l.includes("gpt-5.6-sol"));
    assert.ok(solLine !== undefined, "should have a line covering the sol alias");
    assert.ok(solLine.includes("enabled"), "sol alias should be marked enabled");
  });

  it("marks alias as 'disabled' when canonical is not in routable set", () => {
    const emptyRoutable = new Set<string>([]);
    const result = formatModelsReport({ registry: MODEL_REGISTRY, routable: emptyRoutable, overrides: {} });
    // Assert unconditionally — guarding these behind `if (result.length > 0)` would let
    // the test pass vacuously if the report ever stopped emitting rows.
    assert.equal(result.length, 3, "sol, terra and luna each get a row regardless of routability");
    for (const line of result) {
      assert.ok(line.includes("disabled"), `every alias must be disabled with an empty routable set: ${line}`);
      assert.ok(!line.includes("enabled"), `no alias may be enabled with an empty routable set: ${line}`);
    }
  });

  it("labels derived registry aliases as '(derived)'", () => {
    const result = formatModelsReport({ registry: MODEL_REGISTRY, routable: fullRoutable, overrides: {} });
    const text = result.join("\n");
    assert.ok(text.includes("(derived)"), "should label registry aliases as derived");
  });

  it("labels config override aliases as '(config)' and registry aliases as '(derived)'", () => {
    const result = formatModelsReport({
      registry: MODEL_REGISTRY,
      routable: new Set(["gpt-5.6-sol", "custom-model"]),
      overrides: { "fast": "custom-model" },
    });
    const text = result.join("\n");
    // Should have at least one "(config)" line for the override
    assert.ok(text.includes("(config)"), "should label override alias as config");
  });

  it("includes a '(direct)' row for a routable id that has no family alias (gpt-5.5)", () => {
    // gpt-5.5 has no family field — it never appears as the canonical of an alias row.
    // It must appear as a direct row with an empty alias column so the table is complete.
    const result = formatModelsReport({ registry: MODEL_REGISTRY, routable: fullRoutable, overrides: {} });
    const directLine = result.find((l) => l.includes("gpt-5.5") && l.includes("(direct)"));
    assert.ok(directLine !== undefined, "gpt-5.5 (no family alias) must appear as a (direct) row");
    assert.ok(directLine.includes("enabled"), "gpt-5.5 direct row must be marked enabled when it is routable");
  });

  it("includes a '(direct)' row for a non-registry routable id with no alias coverage", () => {
    // Simulates a config with {"codex":{"models":["gpt-9-experimental"]}}.
    // The id is unknown to the registry and has no alias — without a direct row the table
    // shows only disabled alias rows, making it appear as though nothing is enabled.
    const result = formatModelsReport({
      registry: MODEL_REGISTRY,
      routable: new Set(["gpt-9-experimental"]),
      overrides: {},
    });
    const directLine = result.find((l) => l.includes("gpt-9-experimental") && l.includes("(direct)"));
    assert.ok(directLine !== undefined, "non-registry routable id must appear as a (direct) row");
    assert.ok(directLine.includes("enabled"), "direct row must be marked enabled");
    // The alias rows for sol/terra/luna must still appear, now as disabled.
    assert.ok(result.some((l) => l.includes("sol") && l.includes("disabled")), "sol alias must still appear as disabled");
  });

  it("does not emit a '(direct)' row for an id that is already the canonical of an alias row", () => {
    // gpt-5.6-sol is the canonical of the 'sol' derived alias row — no double-listing.
    const result = formatModelsReport({
      registry: MODEL_REGISTRY,
      routable: new Set(["gpt-5.6-sol"]),
      overrides: {},
    });
    const solDirectLines = result.filter((l) => l.includes("gpt-5.6-sol") && l.includes("(direct)"));
    assert.equal(solDirectLines.length, 0, "gpt-5.6-sol is already the canonical of the sol alias row — no extra (direct) row");
  });
});

// ---------------------------------------------------------------------------
// Prototype-pollution guard
// ---------------------------------------------------------------------------

describe("makeModelResolver — prototype-pollution guard", () => {
  it("'constructor' does not resolve to an inherited property with empty overrides", () => {
    const routable = new Set<string>([]);
    const resolve = makeModelResolver(MODEL_REGISTRY, routable, {});
    // {} inherits Object.prototype.constructor but hasOwn({}, "constructor") is false
    assert.equal(resolve("constructor"), undefined);
  });

  it("'__proto__' does not resolve to an inherited property with empty overrides", () => {
    const routable = new Set<string>([]);
    const resolve = makeModelResolver(MODEL_REGISTRY, routable, {});
    assert.equal(resolve("__proto__"), undefined);
  });

  it("'toString' does not resolve to an inherited property with empty overrides", () => {
    const routable = new Set<string>([]);
    const resolve = makeModelResolver(MODEL_REGISTRY, routable, {});
    assert.equal(resolve("toString"), undefined);
  });

  it("an own-property 'constructor' override resolves correctly (Object.hasOwn distinguishes own from inherited)", () => {
    // If the user explicitly writes "constructor" as an alias key in their config,
    // it should resolve — because Object.hasOwn on the explicit object returns true.
    const routable = new Set<string>(["gpt-5.6-sol"]);
    const overridesWithConstructor = { "constructor": "gpt-5.6-sol" };
    const resolve = makeModelResolver(MODEL_REGISTRY, routable, overridesWithConstructor);
    assert.equal(resolve("constructor"), "gpt-5.6-sol");
  });
});

// ---------------------------------------------------------------------------
// CANARY TEST — expected to fail when a new generation ships.
//
// When gpt-5.7-sol (or similar) is added to MODEL_REGISTRY, this test fails.
// That is intentional — it is the mitigation against "adding a registry line
// silently repoints everyone." Update ALL_MODEL_IDS expected values and this
// test when bumping the registry.
// ---------------------------------------------------------------------------

describe("canary — current generation resolution (update when registry bumps)", () => {
  const routable = new Set(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"]);

  it("'sol' resolves to gpt-5.6-sol — current 5.6 generation", () => {
    const resolve = makeModelResolver(MODEL_REGISTRY, routable, {});
    assert.equal(resolve("sol"), "gpt-5.6-sol");
  });

  it("'terra' resolves to gpt-5.6-terra — current 5.6 generation", () => {
    const resolve = makeModelResolver(MODEL_REGISTRY, routable, {});
    assert.equal(resolve("terra"), "gpt-5.6-terra");
  });

  it("'luna' resolves to gpt-5.6-luna — current 5.6 generation", () => {
    const resolve = makeModelResolver(MODEL_REGISTRY, routable, {});
    assert.equal(resolve("luna"), "gpt-5.6-luna");
  });
});
