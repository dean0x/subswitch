// Model registry and resolver for subswitch.
// Intentionally no imports from the rest of the repo — config.ts imports this,
// and that dependency edge must stay one-way.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ModelEntry {
  readonly id: string;
  /**
   * Family alias key (e.g. "sol", "terra", "luna"). Omit the key entirely for
   * entries with no family alias (e.g. gpt-5.5).
   *
   * exactOptionalPropertyTypes is on — never write `family: undefined`.
   */
  readonly family?: string;
  readonly gen: readonly number[];
  /** Preview models are excluded from alias derivation but still routable by exact id. */
  readonly preview?: boolean;
  /** Retired models are excluded from alias derivation and from the default routable set. */
  readonly retired?: boolean;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Canonical model registry. Declared in registry order so ALL_MODEL_IDS is
 * byte-identical to the current DEFAULT_CODEX_MODELS. Never delete entries —
 * deleting silently unroutes anyone who pinned that id.
 */
export const MODEL_REGISTRY: readonly ModelEntry[] = [
  { id: "gpt-5.6-sol", family: "sol", gen: [5, 6] },
  { id: "gpt-5.6-terra", family: "terra", gen: [5, 6] },
  { id: "gpt-5.6-luna", family: "luna", gen: [5, 6] },
  { id: "gpt-5.5", gen: [5, 5] },
];

/** All registry model ids in registry order. Byte-identical to the current DEFAULT_CODEX_MODELS. */
export const ALL_MODEL_IDS: readonly string[] = MODEL_REGISTRY.map((e) => e.id);

// ---------------------------------------------------------------------------
// Anthropic-leg model names
// ---------------------------------------------------------------------------

/**
 * Names Claude Code treats as Anthropic models. Prefix-matched so generation and
 * variant suffixes are covered too (`sonnet[1m]`, `opusplan`, `claude-3-7-sonnet-…`).
 *
 * - `inherit`: Claude Code's "inherit parent model" sentinel.
 * - `sonnet`, `opus`, `haiku`: Claude tier short-names.
 * - `claude-`: any Claude model id.
 */
const ANTHROPIC_NAME_RE = /^(inherit|sonnet|opus|haiku|claude-)/i;

/**
 * True when `name` is a model name that belongs on the Anthropic leg.
 *
 * Single source of truth for two call sites that must never disagree:
 * - `config.ts` REJECTS such a name as a `codex.aliases` key or target. A key would
 *   resolve main-thread traffic onto Codex; a target is added to the routable set by
 *   `normalizeModelList`'s pressure valve, and `decideRoute`'s exact-membership check
 *   would then match the raw Anthropic model id and send the main thread to Codex.
 * - `agent-scan.ts` SKIPS such a name, so doctor never flags a Claude subagent.
 */
export const isAnthropicModelName = (name: string): boolean => ANTHROPIC_NAME_RE.test(name);

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Compare two generation tuples element-wise.
 * Returns positive if a is newer, negative if b is newer, 0 on exact tie.
 *
 * Numeric element comparison — NOT string comparison.
 * [5,10] > [5,6] and [6,0] > [5,99]; longer tuple wins on equal prefix ([5,6,1] > [5,6]).
 * On exact tie the caller must keep the first-declared winner (do NOT update on 0).
 *
 * noUncheckedIndexedAccess: every element read uses ?? 0.
 */
const compareGen = (a: readonly number[], b: readonly number[]): number => {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    if (ai !== bi) return ai - bi;
  }
  return 0;
};

/**
 * Build a family → canonical-id map scoped to a routable set.
 * Newest (highest gen) non-preview, non-retired entry per family that is IN the
 * routable set wins. First-declared wins on exact gen tie (compareGen === 0).
 */
const buildFamilyMap = (registry: readonly ModelEntry[], routable: ReadonlySet<string>): Map<string, string> => {
  const familyBest = new Map<string, ModelEntry>();

  for (const entry of registry) {
    if (entry.family === undefined || entry.preview === true || entry.retired === true) continue;
    if (!routable.has(entry.id)) continue;

    const current = familyBest.get(entry.family);
    if (current === undefined) {
      familyBest.set(entry.family, entry);
    } else if (compareGen(entry.gen, current.gen) > 0) {
      // Strictly greater: new entry is newer. Exact tie (0): first-declared stays.
      familyBest.set(entry.family, entry);
    }
  }

  const result = new Map<string, string>();
  for (const [family, entry] of familyBest.entries()) {
    result.set(family, entry.id);
  }
  return result;
};

/**
 * Build an override alias Map from the config overrides object.
 * Uses Object.keys + Object.hasOwn to guard against prototype-pollution reads —
 * a raw brackets access on a JSON-parsed object returns inherited properties
 * (e.g. `obj["constructor"]` returns Object) which would silently misroute.
 */
const buildOverrideMap = (overrides: Record<string, string>): Map<string, string> => {
  const map = new Map<string, string>();
  for (const key of Object.keys(overrides)) {
    if (Object.hasOwn(overrides, key)) {
      const val = overrides[key];
      if (val !== undefined) map.set(key, val);
    }
  }
  return map;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a model name resolver for request-time use.
 *
 * Resolution order (exact contract — ADR-005 preserving):
 * 1. name is in routable set → itself (exact id always wins; no alias can hijack a real id)
 * 2. overrides has own-property name → its target (prototype-pollution safe)
 * 3. name is a family → newest non-preview, non-retired entry **in the routable set**
 *    (rule 3 scoping is the key invariant — "a pin pins")
 * 4. undefined → falls through to Anthropic, exactly as today
 *
 * @param registry  Model registry. Pass MODEL_REGISTRY in production; use a synthetic
 *                  registry in tests that need to check gen-tuple edge cases.
 * @param routable  Set of canonical ids permitted to go to Codex.
 * @param overrides config.codex.aliases — user-defined alias overrides.
 */
export const makeModelResolver = (
  registry: readonly ModelEntry[],
  routable: ReadonlySet<string>,
  overrides: Record<string, string>,
): (name: string) => string | undefined => {
  const overrideMap = buildOverrideMap(overrides);
  const familyMap = buildFamilyMap(registry, routable);

  return (name: string): string | undefined => {
    // Rule 1: exact id in routable set — always wins
    if (routable.has(name)) return name;
    // Rule 2: own-property alias override (Map already built with hasOwn guard)
    const overrideTarget = overrideMap.get(name);
    if (overrideTarget !== undefined) return overrideTarget;
    // Rule 3: derived family alias, scoped to routable set
    const familyTarget = familyMap.get(name);
    if (familyTarget !== undefined) return familyTarget;
    // Rule 4: falls through — caller should route to Anthropic
    return undefined;
  };
};

/**
 * Normalize a model list through the full alias table.
 *
 * When list is undefined (codex.models key absent from config):
 *   Returns every non-retired registry id in registry order, plus any override
 *   targets not already in the registry (pressure valve — ensures override targets
 *   are routable even when models is not explicitly listed).
 *
 * When list is defined (codex.models explicitly present in config):
 *   Each entry is resolved: override alias → target, derived family → canonical,
 *   or verbatim for unknowns. Unknown ids are NEVER dropped (forward-compat).
 *   First-occurrence wins on dedup (alias + canonical collapse to one entry).
 *
 * Uses the FULL-REGISTRY alias table (no routable-set scoping) — normalization
 * determines what the routable set IS; the resolver's scoping is separate.
 *
 * @param registry Defaults to MODEL_REGISTRY. Injectable so tests can prove the
 *                 "a pin pins" property against a *future* registry — the property
 *                 spans normalization and resolution, so both halves must be
 *                 exercisable with the same synthetic registry.
 */
export const normalizeModelList = (
  list: readonly string[] | undefined,
  overrides: Record<string, string>,
  registry: readonly ModelEntry[] = MODEL_REGISTRY,
): readonly string[] => {
  const overrideMap = buildOverrideMap(overrides);

  // Full-registry family map — no routable scoping here; normalization establishes the routable set
  const nonRetiredIds = registry.filter((e) => e.retired !== true).map((e) => e.id);
  const derivedFamilyMap = buildFamilyMap(registry, new Set(nonRetiredIds));

  if (list === undefined) {
    // All non-retired registry ids in registry order
    const result = [...nonRetiredIds];
    const resultSet = new Set<string>(result);
    // Add override targets not already in registry (pressure valve for forward-compat models)
    for (const target of overrideMap.values()) {
      if (!resultSet.has(target)) {
        result.push(target);
        resultSet.add(target); // prevent dup if multiple overrides point to the same non-registry target
      }
    }
    return result;
  }

  // List present: normalize through alias table, deduplicate, preserve unknowns verbatim.
  // A real registry id always resolves to itself — mirrors makeModelResolver rule 1, so a
  // config alias can never hijack a real model id on either side of the pipeline. Without
  // this, `models: ["gpt-5.5"]` + `aliases: {"gpt-5.5": "gpt-5.6-sol"}` would make gpt-5.5
  // unroutable and silently send its traffic upstream as gpt-5.6-sol.
  const registryIds = new Set(registry.map((e) => e.id));
  const resolveEntry = (name: string): string =>
    registryIds.has(name) ? name : (overrideMap.get(name) ?? derivedFamilyMap.get(name) ?? name);

  const seen = new Set<string>();
  const result: string[] = [];

  for (const item of list) {
    const canonical = resolveEntry(item);
    if (!seen.has(canonical)) {
      seen.add(canonical);
      result.push(canonical);
    }
  }

  return result;
};

// ---------------------------------------------------------------------------
// Report formatting
// ---------------------------------------------------------------------------

/** Input for formatModelsReport. Config-free so cli.ts and doctor.ts can call without circular imports. */
export interface FormatModelsReportInput {
  readonly registry: readonly ModelEntry[];
  readonly routable: ReadonlySet<string>;
  readonly overrides: Record<string, string>;
}

/**
 * Format a human-readable, colorless report of model aliases.
 * Callers wrap with their own display logic (picocolors, indentation, etc.).
 *
 * Rows: one per alias — config overrides first, then derived family aliases.
 * Columns: alias → canonical  gen:X.Y  enabled|disabled  (derived)|(config)
 */
export const formatModelsReport = (input: FormatModelsReportInput): readonly string[] => {
  const { registry, routable, overrides } = input;
  const overrideMap = buildOverrideMap(overrides);

  // Full-registry family map for display purposes (no routable scoping — so we can
  // show disabled aliases too, using the registry to find what they WOULD resolve to)
  const allNonRetired = new Set(registry.filter((e) => e.retired !== true).map((e) => e.id));
  const fullFamilyMap = buildFamilyMap(registry, allNonRetired);

  type Row = {
    readonly alias: string;
    readonly canonical: string;
    readonly gen: string;
    readonly enabled: boolean;
    readonly source: "derived" | "config";
  };

  const rows: Row[] = [];
  const coveredAliases = new Set<string>();

  // Config override aliases first (they shadow derived aliases of the same name)
  for (const [alias, canonical] of overrideMap.entries()) {
    const entry = registry.find((e) => e.id === canonical);
    const gen = entry !== undefined ? entry.gen.join(".") : "?";
    rows.push({ alias, canonical, gen, enabled: routable.has(canonical), source: "config" });
    coveredAliases.add(alias);
  }

  // Derived family aliases (skip any alias already covered by a config override)
  for (const [family, canonical] of fullFamilyMap.entries()) {
    if (coveredAliases.has(family)) continue;
    const entry = registry.find((e) => e.id === canonical);
    const gen = entry !== undefined ? entry.gen.join(".") : "?";
    rows.push({ alias: family, canonical, gen, enabled: routable.has(canonical), source: "derived" });
  }

  if (rows.length === 0) return [];

  const aliasWidth = Math.max(...rows.map((r) => r.alias.length));
  const canonWidth = Math.max(...rows.map((r) => r.canonical.length));

  return rows.map((r) => {
    const alias = r.alias.padEnd(aliasWidth);
    const canon = r.canonical.padEnd(canonWidth);
    const gen = `gen:${r.gen}`;
    const status = r.enabled ? "enabled" : "disabled";
    const source = r.source === "derived" ? "(derived)" : "(config)";
    return `${alias}  →  ${canon}  ${gen}  ${status}  ${source}`;
  });
};
