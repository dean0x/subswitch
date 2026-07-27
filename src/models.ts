// Model registry and resolver for subswitch.
// Intentionally no imports from the rest of the repo — config.ts imports this,
// and that dependency edge must stay one-way.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Closed tuple of all supported provider identifiers. */
export const PROVIDER_IDS = ["codex"] as const;
/**
 * Discriminator for provider-specific handler dispatch. A closed union ensures
 * `Record<ProviderId, ProviderHandler>` is a compile-time completeness proof
 * (added in later phases) — a defaulted or optional discriminator would allow
 * silent gaps that only surface at runtime.
 */
export type ProviderId = (typeof PROVIDER_IDS)[number];

export interface ModelEntry {
  readonly id: string;
  /**
   * Provider this model belongs to. Required — not optional, not defaulted.
   * A closed union against PROVIDER_IDS makes the handler dispatch table a
   * compile-time completeness proof in later phases.
   */
  readonly provider: ProviderId;
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
// Routing table types (Phase B — additive, wired in Phase C/D)
// ---------------------------------------------------------------------------

/**
 * A fully-resolved model destination. Carries id + provider so the caller can
 * dispatch to the right handler and log `route=codex:messages:gpt-5.6-sol`.
 * family is optional (omitted for entries with no family field).
 */
export interface ResolvedModel {
  readonly id: string;
  readonly provider: ProviderId;
  readonly family?: string;
}

/**
 * Per-family routing decision.
 * - unique: exactly one provider claims this family → routable by bare name.
 * - ambiguous: two or more providers claim it → caller must use a qualified name.
 */
export type FamilyResolution =
  | { readonly kind: "unique"; readonly model: ResolvedModel }
  | { readonly kind: "ambiguous"; readonly providers: readonly ProviderId[] };

/** Immutable routing table built once at startup by buildRoutingTable. */
export interface RoutingTable {
  /** Exact-membership set (ADR-005). Maps canonical id → provider. */
  readonly byId: ReadonlyMap<string, ProviderId>;
  /** Per-family resolution (unique claimant or ambiguous). */
  readonly byFamily: ReadonlyMap<string, FamilyResolution>;
  /** Qualified lookups: "codex:gpt-5.6-sol" and "codex:sol" both resolve here. */
  readonly byQualified: ReadonlyMap<string, ResolvedModel>;
  /** Alias lookups: built with Object.hasOwn guard (prototype-pollution safe). */
  readonly byAlias: ReadonlyMap<string, ResolvedModel>;
}

/** Result of buildRoutingTable — table plus diagnostic lists. */
export interface RoutingTableBuild {
  readonly table: RoutingTable;
  /** Aliases rejected because their key or target is a reserved Anthropic name (PF-007). */
  readonly rejectedAliases: readonly { readonly alias: string; readonly target: string }[];
  /** Families claimed by more than one provider. */
  readonly ambiguousFamilies: readonly {
    readonly family: string;
    readonly providers: readonly ProviderId[];
  }[];
  /** Registry entries whose id or family is a reserved Anthropic name (self-check). */
  readonly reservedNameEntries: readonly string[];
}

/**
 * Resolution outcome returned by resolveModel.
 *
 * - resolved: name mapped to a concrete destination.
 * - ambiguous: family name claimed by multiple providers; caller should error with provider list.
 * - unresolved: name not found (typo, or known-provider qualified name with bad id/family).
 * - unknown_qualifier: name looks like provider:id but the prefix is not in PROVIDER_IDS.
 *   Distinguishable from unresolved so Phase D can emit "unknown provider 'X'" vs "unknown model".
 */
export type ModelResolution =
  | { readonly kind: "resolved"; readonly target: ResolvedModel }
  | { readonly kind: "ambiguous"; readonly name: string; readonly providers: readonly ProviderId[] }
  | { readonly kind: "unresolved" }
  | { readonly kind: "unknown_qualifier"; readonly qualifier: string };

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Canonical model registry. Declared in registry order so ALL_MODEL_IDS is
 * byte-identical to the current DEFAULT_CODEX_MODELS. Never delete entries —
 * deleting silently unroutes anyone who pinned that id.
 */
export const MODEL_REGISTRY: readonly ModelEntry[] = [
  { id: "gpt-5.6-sol", provider: "codex", family: "sol", gen: [5, 6] },
  { id: "gpt-5.6-terra", provider: "codex", family: "terra", gen: [5, 6] },
  { id: "gpt-5.6-luna", provider: "codex", family: "luna", gen: [5, 6] },
  { id: "gpt-5.5", provider: "codex", gen: [5, 5] },
];

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
// Intentionally prefix-based (not exact) so variant tier names like `sonnet[1m]`
// or `opusplan` are also caught. An exact match would let such names slip through
// config validation and reopen the main-thread→Codex misroute hole.
const ANTHROPIC_NAME_RE = /^(inherit|sonnet|opus|haiku|claude-)/i;

/**
 * True when `name` must never be resolvable in the routing table.
 *
 * One-way exclusion: a name matching this regex is reserved for the Anthropic leg and
 * cannot appear as an alias key, alias target, or explicit model id in Codex config.
 * It is NOT a provider classifier — a model belonging to "sonnet" family could in theory
 * be hosted on any provider; this guard only says Claude Code's main thread must never
 * be misrouted to a non-Anthropic handler.
 *
 * Single source of truth for two call sites that must never disagree:
 * - `config.ts` REJECTS such a name as a `codex.aliases` key or target.
 * - `agent-scan.ts` SKIPS such a name so doctor never flags a Claude subagent.
 */
export const isReservedAnthropicName = (name: string): boolean => ANTHROPIC_NAME_RE.test(name);

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
// Routing table builder (Phase B)
// ---------------------------------------------------------------------------

/**
 * Build an immutable routing table from the registry and per-provider alias maps.
 *
 * TOTAL: never throws. Problems are reported as data in the returned build object.
 * PURE: no I/O, no credential checks, no filesystem, no clock. Deterministic.
 *
 * Credential state is deliberately NOT an input. Routing must not depend on whether
 * a provider is configured — gating on credentials would turn a 401 "run codex login"
 * into an opaque 404, collapsing two distinguishable failure modes into one.
 *
 * @param registry        Model registry (pass MODEL_REGISTRY in production).
 * @param aliasesByProvider Per-provider alias maps. Required key for every ProviderId
 *                          so the type system enforces completeness when providers are added.
 */
export const buildRoutingTable = (
  registry: readonly ModelEntry[],
  aliasesByProvider: Readonly<Record<ProviderId, Readonly<Record<string, string>>>>,
): RoutingTableBuild => {
  // --- 1. Registry self-check ---
  // Any entry whose id or family is a reserved Anthropic name is reported.
  // The registry has never been validated against this — hypothetical Bedrock ids
  // (e.g. "anthropic.claude-3-5-sonnet-*") would be literally Anthropic names.
  const reservedNameEntries: string[] = [];
  for (const entry of registry) {
    if (isReservedAnthropicName(entry.id) || (entry.family !== undefined && isReservedAnthropicName(entry.family))) {
      reservedNameEntries.push(entry.id);
    }
  }

  // --- 2. byId: all registry entries (including retired and preview) ---
  // Retired entries stay in byId so a pin on a retired id keeps routing and gives a
  // truthful upstream 404 naming the provider, rather than silently dropping through.
  const byId = new Map<string, ProviderId>();
  for (const entry of registry) {
    if (!byId.has(entry.id)) {
      byId.set(entry.id, entry.provider);
    }
  }

  // --- 3. Per-provider family maps → merged byFamily ---
  // Build per-provider so a contested family (same name in two providers) is detectable.
  // Retired and preview entries are excluded — they must not float a bare family name.
  // First-declared wins on exact gen tie (compareGen === 0).
  const perProviderFamilyBest = new Map<ProviderId, Map<string, ModelEntry>>();

  for (const entry of registry) {
    if (entry.family === undefined || entry.preview === true || entry.retired === true) continue;
    let providerMap = perProviderFamilyBest.get(entry.provider);
    if (providerMap === undefined) {
      providerMap = new Map<string, ModelEntry>();
      perProviderFamilyBest.set(entry.provider, providerMap);
    }
    const current = providerMap.get(entry.family);
    if (current === undefined) {
      providerMap.set(entry.family, entry);
    } else if (compareGen(entry.gen, current.gen) > 0) {
      // Strictly greater: new entry is newer. On tie (0): first-declared stays.
      providerMap.set(entry.family, entry);
    }
  }

  // Merge per-provider maps into global byFamily.
  // A family claimed by exactly one provider → unique. Multiple providers → ambiguous.
  const byFamily = new Map<string, FamilyResolution>();
  const familyProviders = new Map<string, ProviderId[]>(); // tracks claimants for dedup

  for (const [provider, providerMap] of perProviderFamilyBest) {
    for (const [family, entry] of providerMap) {
      const claimants = familyProviders.get(family);
      if (claimants === undefined) {
        const model: ResolvedModel =
          entry.family !== undefined
            ? { id: entry.id, provider: entry.provider, family: entry.family }
            : { id: entry.id, provider: entry.provider };
        byFamily.set(family, { kind: "unique", model });
        familyProviders.set(family, [provider]);
      } else {
        // Contest — mark ambiguous
        const updatedClaimants = [...claimants, provider];
        familyProviders.set(family, updatedClaimants);
        byFamily.set(family, { kind: "ambiguous", providers: updatedClaimants });
      }
    }
  }

  // Collect ambiguous families for the build diagnostic.
  const ambiguousFamilies: { readonly family: string; readonly providers: readonly ProviderId[] }[] = [];
  for (const [family, resolution] of byFamily) {
    if (resolution.kind === "ambiguous") {
      ambiguousFamilies.push({ family, providers: resolution.providers });
    }
  }

  // --- 4. byQualified: "provider:id" and "provider:family" lookups ---
  // Supports rule-3 qualified resolution at request time without re-splitting names.
  const byQualified = new Map<string, ResolvedModel>();

  // All registry ids as "provider:id"
  for (const entry of registry) {
    const qualified = `${entry.provider}:${entry.id}`;
    if (!byQualified.has(qualified)) {
      const model: ResolvedModel =
        entry.family !== undefined
          ? { id: entry.id, provider: entry.provider, family: entry.family }
          : { id: entry.id, provider: entry.provider };
      byQualified.set(qualified, model);
    }
  }

  // Per-provider family winners as "provider:family" (unique claimants only)
  for (const [provider, providerMap] of perProviderFamilyBest) {
    for (const [family, entry] of providerMap) {
      const familyResolution = byFamily.get(family);
      if (familyResolution?.kind !== "unique") continue; // skip ambiguous
      const qualified = `${provider}:${family}`;
      if (!byQualified.has(qualified)) {
        const model: ResolvedModel =
          entry.family !== undefined
            ? { id: entry.id, provider: entry.provider, family: entry.family }
            : { id: entry.id, provider: entry.provider };
        byQualified.set(qualified, model);
      }
    }
  }

  // --- 5. byAlias: per-provider alias maps with prototype-pollution guard ---
  // Uses Object.hasOwn on each key — a raw bracket lookup on a JSON-parsed object
  // returns inherited properties (e.g. obj["constructor"] returns Object).
  // Alias resolution is exactly ONE hop. "a → b" where b is itself an alias does NOT
  // chase to b's target. Without this bound, the first person wanting a→b→id writes
  // an unbounded loop with a cycle risk. (Project rule: every loop has an explicit bound.)
  const byAlias = new Map<string, ResolvedModel>();
  const rejectedAliases: { readonly alias: string; readonly target: string }[] = [];

  for (const providerId of PROVIDER_IDS) {
    const providerAliases = aliasesByProvider[providerId];
    for (const key of Object.keys(providerAliases)) {
      if (!Object.hasOwn(providerAliases, key)) continue;
      const target = providerAliases[key];
      if (target === undefined) continue;

      // PF-007: reject if key OR target is a reserved Anthropic name.
      // A key would route main-thread traffic to Codex; a target becomes routable via
      // the alias map, which decideRoute's exact-membership check would then match.
      if (isReservedAnthropicName(key) || isReservedAnthropicName(target)) {
        rejectedAliases.push({ alias: key, target });
        continue;
      }

      if (byAlias.has(key)) continue; // first provider wins on duplicate keys

      // Build ResolvedModel from the target. If the target is a known registry entry,
      // carry its family. Otherwise assume it belongs to the declaring provider
      // (forward-compat: unknown ids may land when the registry catches up).
      const targetEntry = registry.find((e) => e.id === target);
      const targetProvider = byId.get(target) ?? providerId;
      const model: ResolvedModel =
        targetEntry?.family !== undefined
          ? { id: target, provider: targetProvider, family: targetEntry.family }
          : { id: target, provider: targetProvider };
      byAlias.set(key, model);
    }
  }

  const table: RoutingTable = {
    byId,
    byFamily,
    byQualified,
    byAlias,
  };

  return { table, rejectedAliases, ambiguousFamilies, reservedNameEntries };
};

// ---------------------------------------------------------------------------
// Request-time resolver (Phase B)
// ---------------------------------------------------------------------------

/**
 * Resolve a model name to a concrete destination using a pre-built routing table.
 *
 * This is the ONLY constructor of ModelResolution. Phase D's decideRoute calls this
 * and never does name-matching itself (ADR-005: resolution strictly before dispatch).
 *
 * Resolution order — exactly five rules, in this order:
 *
 * 1. Exact id in byId → resolved. Canonical ids ALWAYS win; no alias can hijack one.
 * 2. Alias in byAlias → resolved (one hop; Map built with Object.hasOwn — pollution safe).
 * 3. Qualified "provider:id" → resolved only when the prefix is in PROVIDER_IDS.
 *    An unrecognised prefix returns unknown_qualifier, not unresolved, so callers can
 *    distinguish "typo in a model name" from "typo in a provider name".
 * 4. Family lookup → unique claimant: resolved; contested: ambiguous.
 * 5. Otherwise → unresolved.
 *
 * Colon hazard: rule 1 fires before qualified parsing, so a registry id that legitimately
 * contains a colon (e.g. "llama3:8b") wins without ever reaching rule 3.
 */
export const resolveModel = (table: RoutingTable, name: string): ModelResolution => {
  // Rule 1: exact id — ALWAYS wins (ADR-005)
  const exactProvider = table.byId.get(name);
  if (exactProvider !== undefined) {
    // Look up the full ResolvedModel from byQualified (carries family if present).
    const qualified = `${exactProvider}:${name}`;
    const fullModel = table.byQualified.get(qualified);
    const model: ResolvedModel =
      fullModel !== undefined ? fullModel : { id: name, provider: exactProvider };
    return { kind: "resolved", target: model };
  }

  // Rule 2: alias (Map built with Object.hasOwn — prototype-pollution safe at build time)
  // Alias resolution is exactly ONE hop: if target is itself an alias we do NOT follow it.
  const aliasModel = table.byAlias.get(name);
  if (aliasModel !== undefined) {
    return { kind: "resolved", target: aliasModel };
  }

  // Rule 3: qualified "provider:id" or "provider:family"
  // A split counts as qualified ONLY when the prefix is a member of PROVIDER_IDS.
  // This prevents "llama3:8b" from being parsed as provider "llama3".
  const colonIndex = name.indexOf(":");
  if (colonIndex !== -1) {
    const prefix = name.slice(0, colonIndex);
    if ((PROVIDER_IDS as readonly string[]).includes(prefix)) {
      const qualifiedModel = table.byQualified.get(name);
      if (qualifiedModel !== undefined) {
        return { kind: "resolved", target: qualifiedModel };
      }
      // Known provider prefix but id/family not found — plain unresolved (not unknown_qualifier)
      return { kind: "unresolved" };
    }
    // Unknown prefix — not a provider name → distinguishable from "model not found" (F5)
    return { kind: "unknown_qualifier", qualifier: prefix };
  }

  // Rule 4: family
  const familyResolution = table.byFamily.get(name);
  if (familyResolution !== undefined) {
    if (familyResolution.kind === "unique") {
      return { kind: "resolved", target: familyResolution.model };
    }
    return { kind: "ambiguous", name, providers: familyResolution.providers };
  }

  // Rule 5: unresolved
  return { kind: "unresolved" };
};

// ---------------------------------------------------------------------------
// Report formatting — model-centric and alias-centric views
// ---------------------------------------------------------------------------

/** An alias entry attached to a ModelRow (name + how it was derived). */
export interface AliasEntry {
  readonly name: string;
  readonly source: "derived" | "config";
}

/**
 * Model-centric row: one entry per registry model, with all aliases attached.
 * Used for JSON output (models --json) and parity testing.
 *
 * exactOptionalPropertyTypes: family and gen use conditional spreads so the
 * field is truly absent (not undefined) when unknown.
 */
export interface ModelRow {
  readonly id: string;
  readonly provider: ProviderId;
  readonly aliases: readonly AliasEntry[];
  /** Present when the registry entry has a family key. */
  readonly family?: string;
  /** Present when the generation is known (always for registry entries); absent means unknown. */
  readonly gen?: readonly number[];
  /** True when the model is not retired. */
  readonly routable: boolean;
  /** Always-present boolean — consumers write `if (m.preview)` with no `?? false`. */
  readonly preview: boolean;
  /** Always-present boolean — consumers write `if (m.retired)` with no `?? false`. */
  readonly retired: boolean;
  /** Always "registry" for MODEL_REGISTRY entries. */
  readonly source: "registry";
}

/** Alias-centric row: one entry per alias or one direct row per aliasless model. */
export interface AliasTableRow {
  /** Empty string for "direct" rows (models with no alias coverage). */
  readonly alias: string;
  readonly canonical: string;
  readonly provider: ProviderId;
  /** Display generation string: "5.6", "5.5", or "?" if unknown. */
  readonly gen: string;
  /** True for non-retired models. */
  readonly enabled: boolean;
  readonly source: "derived" | "config" | "direct";
}

/**
 * Build alias-centric rows for human-readable table display.
 *
 * One row per alias (config overrides first, then derived family aliases), plus
 * one "direct" row per non-retired model that has no alias coverage.
 *
 * Invariant with buildModelRows: the alias names in every ModelRow correspond
 * exactly to the non-direct AliasTableRows that share the same canonical.
 */
export const buildAliasRows = (
  registry: readonly ModelEntry[],
  overrides: Record<string, string>,
): readonly AliasTableRow[] => {
  const overrideMap = buildOverrideMap(overrides);
  const allNonRetired = new Set(registry.filter((e) => e.retired !== true).map((e) => e.id));
  const familyMap = buildFamilyMap(registry, allNonRetired);

  const rows: AliasTableRow[] = [];
  const coveredAliases = new Set<string>();
  const coveredCanonicals = new Set<string>();

  // Config override aliases first (they shadow derived aliases of the same name)
  for (const [alias, canonical] of overrideMap.entries()) {
    const entry = registry.find((e) => e.id === canonical);
    const genStr = entry !== undefined ? entry.gen.join(".") : "?";
    const provider: ProviderId = entry?.provider ?? PROVIDER_IDS[0];
    rows.push({ alias, canonical, provider, gen: genStr, enabled: allNonRetired.has(canonical), source: "config" });
    coveredAliases.add(alias);
    coveredCanonicals.add(canonical);
  }

  // Derived family aliases (skip any alias already covered by a config override)
  for (const [family, canonical] of familyMap.entries()) {
    if (coveredAliases.has(family)) continue;
    const entry = registry.find((e) => e.id === canonical);
    const genStr = entry !== undefined ? entry.gen.join(".") : "?";
    const provider: ProviderId = entry?.provider ?? PROVIDER_IDS[0];
    rows.push({ alias: family, canonical, provider, gen: genStr, enabled: true, source: "derived" });
    coveredAliases.add(family);
    coveredCanonicals.add(canonical);
  }

  // Direct rows for non-retired models with no alias coverage
  for (const id of allNonRetired) {
    if (coveredCanonicals.has(id)) continue;
    const entry = registry.find((e) => e.id === id);
    if (entry === undefined) continue;
    rows.push({ alias: "", canonical: id, provider: entry.provider, gen: entry.gen.join("."), enabled: true, source: "direct" });
  }

  return rows;
};

/**
 * Build model-centric rows for JSON output and parity testing.
 *
 * One row per registry entry. Aliases include all config overrides pointing to
 * this model (source: "config") and all derived family aliases where this model
 * is the family winner (source: "derived"). Order within aliases: config first.
 *
 * Invariant with buildAliasRows: the alias names on each ModelRow correspond
 * exactly to the non-direct AliasTableRows that share the same canonical.
 */
export const buildModelRows = (
  registry: readonly ModelEntry[],
  overrides: Record<string, string>,
): readonly ModelRow[] => {
  const overrideMap = buildOverrideMap(overrides);
  const allNonRetired = new Set(registry.filter((e) => e.retired !== true).map((e) => e.id));
  const familyMap = buildFamilyMap(registry, allNonRetired);

  // Collect aliases per model id
  const aliasesByModel = new Map<string, AliasEntry[]>();
  for (const entry of registry) {
    aliasesByModel.set(entry.id, []);
  }

  // Config overrides first
  for (const [alias, targetId] of overrideMap.entries()) {
    const list = aliasesByModel.get(targetId);
    if (list !== undefined) list.push({ name: alias, source: "config" });
  }

  // Derived family aliases (skip if shadowed by a config override with the same alias name)
  for (const [family, canonicalId] of familyMap.entries()) {
    if (overrideMap.has(family)) continue;
    const list = aliasesByModel.get(canonicalId);
    if (list !== undefined) list.push({ name: family, source: "derived" });
  }

  return registry.map((entry) => {
    const aliases = aliasesByModel.get(entry.id) ?? [];
    const row: ModelRow = {
      id: entry.id,
      provider: entry.provider,
      aliases,
      ...(entry.family !== undefined ? { family: entry.family } : {}),
      ...(entry.gen.length > 0 ? { gen: entry.gen } : {}),
      routable: entry.retired !== true,
      preview: entry.preview === true,
      retired: entry.retired === true,
      source: "registry",
    };
    return row;
  });
};

/** Input for formatModelsReport. Config-free so cli.ts and doctor.ts can call without circular imports. */
export interface FormatModelsReportInput {
  readonly registry: readonly ModelEntry[];
  readonly overrides: Record<string, string>;
}

/**
 * Format a human-readable, colorless alias table.
 * Callers wrap with their own display logic (picocolors, indentation, etc.).
 *
 * Columns: alias → canonical  provider  gen:X.Y  enabled|disabled  (derived)|(config)|(direct)
 */
export const formatModelsReport = (input: FormatModelsReportInput): readonly string[] => {
  const rows = buildAliasRows(input.registry, input.overrides);
  if (rows.length === 0) return [];

  const aliasWidth = Math.max(...rows.map((r) => r.alias.length));
  const canonWidth = Math.max(...rows.map((r) => r.canonical.length));
  const providerWidth = Math.max(...rows.map((r) => r.provider.length));
  const genWidth = Math.max(...rows.map((r) => `gen:${r.gen}`.length));
  const statusWidth = Math.max(...rows.map((r) => (r.enabled ? "enabled" : "disabled").length));

  return rows.map((r) => {
    const alias = r.alias.padEnd(aliasWidth);
    const canon = r.canonical.padEnd(canonWidth);
    const provider = r.provider.padEnd(providerWidth);
    const gen = `gen:${r.gen}`.padEnd(genWidth);
    const status = (r.enabled ? "enabled" : "disabled").padEnd(statusWidth);
    const source = r.source === "derived" ? "(derived)" : r.source === "config" ? "(config)" : "(direct)";
    return `${alias}  →  ${canon}  ${provider}  ${gen}  ${status}  ${source}`;
  });
};
