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
  // allRegistryIds spans retired AND active — used by the pressure valve to avoid
  // re-adding a retired id that is already present in the registry (just not in the
  // routable set). Without this, an alias target equal to a retired id would slip
  // through the resultSet check (which is built from non-retired ids only).
  const allRegistryIds = new Set(registry.map((e) => e.id));
  const derivedFamilyMap = buildFamilyMap(registry, new Set(nonRetiredIds));

  if (list === undefined) {
    // All non-retired registry ids in registry order
    const result = [...nonRetiredIds];
    const resultSet = new Set<string>(result);
    // Add override targets not in the FULL registry (pressure valve for forward-compat models).
    // Checks allRegistryIds — not just resultSet — so retired registry ids are excluded too.
    for (const target of overrideMap.values()) {
      if (!allRegistryIds.has(target) && !resultSet.has(target)) {
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
    readonly source: "derived" | "config" | "direct";
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

  // Direct routable ids — ids that are in the routable set but not covered as the
  // canonical of any alias row (e.g. gpt-5.5 which has no family, or a user-pinned
  // id like gpt-9-experimental that has no registry entry).  Append as a trailing
  // section with an empty alias column so the table shows the complete effective picture.
  const coveredCanonicals = new Set(rows.map((r) => r.canonical));
  for (const id of routable) {
    if (coveredCanonicals.has(id)) continue;
    const entry = registry.find((e) => e.id === id);
    const gen = entry !== undefined ? entry.gen.join(".") : "?";
    rows.push({ alias: "", canonical: id, gen, enabled: true, source: "direct" });
  }

  if (rows.length === 0) return [];

  const aliasWidth = Math.max(...rows.map((r) => r.alias.length));
  const canonWidth = Math.max(...rows.map((r) => r.canonical.length));
  const genWidth = Math.max(...rows.map((r) => `gen:${r.gen}`.length));
  const statusWidth = Math.max(...rows.map((r) => (r.enabled ? "enabled" : "disabled").length));

  return rows.map((r) => {
    const alias = r.alias.padEnd(aliasWidth);
    const canon = r.canonical.padEnd(canonWidth);
    const gen = `gen:${r.gen}`.padEnd(genWidth);
    const status = (r.enabled ? "enabled" : "disabled").padEnd(statusWidth);
    const source = r.source === "derived" ? "(derived)" : r.source === "config" ? "(config)" : "(direct)";
    return `${alias}  →  ${canon}  ${gen}  ${status}  ${source}`;
  });
};
