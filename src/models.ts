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
  /**
   * Aliases whose target is NOT in the registry (forward-compat: the router still routes them,
   * but the target won't appear in model rows and is invisible to diagnostics without this list).
   * Doctor surfaces these as a warning so the user knows the alias may resolve to nothing useful.
   */
  readonly danglingAliases: readonly { readonly alias: string; readonly target: string; readonly provider: ProviderId }[];
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
 * Canonical model registry — THE exact-membership set for routing (applies ADR-005).
 * Never delete entries: deleting silently unroutes anyone who pinned that id.
 * Mark them `retired` instead, which keeps them resolvable and lets the upstream
 * return a truthful 404.
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
 * Registry entry → routing destination.
 *
 * `family` is spread conditionally rather than assigned: exactOptionalPropertyTypes is
 * on, so an entry with no family must omit the key entirely rather than set it to
 * `undefined`. Every ResolvedModel built from an entry goes through here so that rule
 * is stated once.
 */
const toResolvedModel = (entry: ModelEntry): ResolvedModel => ({
  id: entry.id,
  provider: entry.provider,
  ...(entry.family !== undefined ? { family: entry.family } : {}),
});

/**
 * Global claim on a bare family name, derived from the per-provider partition.
 *
 * Carries the winning ModelEntry (not just its id) so consumers read `gen` and
 * `provider` straight off it. Handing back an id instead forces every consumer to
 * re-find the entry in the registry and invent a fallback for the miss — and those
 * fallbacks are unreachable, because a winner is by construction a registry entry.
 */
type FamilyClaim =
  | { readonly kind: "unique"; readonly entry: ModelEntry }
  | { readonly kind: "contested"; readonly providers: readonly ProviderId[] };

/** Both views of family derivation, produced together by selectFamilyWinners. */
interface FamilySelection {
  /**
   * Per-provider partition: provider → family → winning entry.
   * byQualified needs this — "codex:sol" must resolve even when "sol" is contested,
   * because qualifying is precisely the mechanism for disambiguating a contest.
   */
  readonly byProvider: ReadonlyMap<ProviderId, ReadonlyMap<string, ModelEntry>>;
  /** Collapsed view: family → unique winner, or the list of contesting providers. */
  readonly claims: ReadonlyMap<string, FamilyClaim>;
}

/**
 * THE family selection rule. One implementation, no exceptions.
 *
 * Per provider, per family: the entry with the highest `gen` wins. Preview and
 * retired entries never win a family alias (they stay routable by exact id).
 * First-declared wins on an exact gen tie — the update guard is `> 0`, NEVER
 * `>= 0`, because `>= 0` silently makes the LAST-declared entry win.
 *
 * Returns the per-provider partition AND the collapsed per-family claim, built in
 * one pass so they cannot disagree. The router and the display layer read the same
 * two views of this one result; neither re-derives a family winner for itself.
 * A family claimed by two providers is reported as contested rather than silently
 * arbitrated — the router refuses to resolve it, so the display must not show it.
 */
const selectFamilyWinners = (registry: readonly ModelEntry[]): FamilySelection => {
  const byProvider = new Map<ProviderId, Map<string, ModelEntry>>();

  for (const entry of registry) {
    if (entry.family === undefined || entry.preview === true || entry.retired === true) continue;

    let familyBest = byProvider.get(entry.provider);
    if (familyBest === undefined) {
      familyBest = new Map<string, ModelEntry>();
      byProvider.set(entry.provider, familyBest);
    }

    const current = familyBest.get(entry.family);
    if (current === undefined || compareGen(entry.gen, current.gen) > 0) {
      // Strictly greater: new entry is newer. Exact tie (0): first-declared stays.
      familyBest.set(entry.family, entry);
    }
  }

  const claims = new Map<string, FamilyClaim>();
  for (const [provider, familyBest] of byProvider) {
    for (const [family, entry] of familyBest) {
      const existing = claims.get(family);
      if (existing === undefined) {
        claims.set(family, { kind: "unique", entry });
      } else {
        const providers =
          existing.kind === "unique" ? [existing.entry.provider, provider] : [...existing.providers, provider];
        claims.set(family, { kind: "contested", providers });
      }
    }
  }

  return { byProvider, claims };
};

/**
 * Flat family → winning entry view, keeping ONLY uniquely-claimed families.
 *
 * Derived from the claims map rather than recomputed, so "which families are
 * routable by bare name" has exactly one answer. A contested family is dropped
 * here for the same reason resolveModel returns `ambiguous` for it: the bare name
 * does not route, so nothing may display it as though it did.
 */
const flattenUniqueFamilies = (
  claims: ReadonlyMap<string, FamilyClaim>,
): ReadonlyMap<string, ModelEntry> => {
  const unique = new Map<string, ModelEntry>();
  for (const [family, claim] of claims) {
    if (claim.kind === "unique") unique.set(family, claim.entry);
  }
  return unique;
};

/** One effective alias declaration, with its declaring provider and PF-007 verdict. */
interface AliasDeclaration {
  readonly alias: string;
  readonly target: string;
  /** The provider whose config block declared it — the fallback when the target is unknown. */
  readonly provider: ProviderId;
  /** True when the key or the target is a reserved Anthropic name (PF-007). */
  readonly reserved: boolean;
}

/**
 * Effective per-provider alias declarations, in PROVIDER_IDS order then key order.
 *
 * Own-property guard (Object.hasOwn) — a raw bracket read on a JSON-parsed object
 * returns inherited properties (e.g. `obj["constructor"]` returns Object) which would
 * silently misroute. First provider wins on a duplicate key.
 *
 * `reserved` marks PF-007 rejections so the router and the display layer classify
 * identically. Deduplication applies only to non-reserved keys: a reserved declaration
 * never binds the name, so a later provider's reserved declaration of the same name is
 * still a distinct rejection worth reporting.
 */
const collectAliasDeclarations = (
  aliasesByProvider: Readonly<Record<ProviderId, Readonly<Record<string, string>>>>,
): readonly AliasDeclaration[] => {
  const declarations: AliasDeclaration[] = [];
  const bound = new Set<string>();

  for (const provider of PROVIDER_IDS) {
    const providerAliases = aliasesByProvider[provider];
    for (const alias of Object.keys(providerAliases)) {
      if (!Object.hasOwn(providerAliases, alias)) continue;
      const target = providerAliases[alias];
      if (target === undefined) continue;

      const reserved = isReservedAnthropicName(alias) || isReservedAnthropicName(target);
      if (!reserved) {
        if (bound.has(alias)) continue; // first provider wins on duplicate keys
        bound.add(alias);
      }
      declarations.push({ alias, target, provider, reserved });
    }
  }

  return declarations;
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

  // --- 3. Family derivation (THE rule lives in selectFamilyWinners) ---
  // The per-provider partition makes a contested family detectable rather than
  // silently arbitrated; the collapsed claims map is derived from it in the same pass.
  // The display layer reads these same two views — see buildAliasRows.
  const { byProvider: perProviderFamilyBest, claims } = selectFamilyWinners(registry);

  const byFamily = new Map<string, FamilyResolution>();
  const ambiguousFamilies: { readonly family: string; readonly providers: readonly ProviderId[] }[] = [];

  for (const [family, claim] of claims) {
    if (claim.kind === "unique") {
      byFamily.set(family, { kind: "unique", model: toResolvedModel(claim.entry) });
    } else {
      byFamily.set(family, { kind: "ambiguous", providers: claim.providers });
      ambiguousFamilies.push({ family, providers: claim.providers });
    }
  }

  // --- 4. byQualified: "provider:id" and "provider:family" lookups ---
  // Supports rule-3 qualified resolution at request time without re-splitting names.
  const byQualified = new Map<string, ResolvedModel>();

  // All registry ids as "provider:id"
  for (const entry of registry) {
    const qualified = `${entry.provider}:${entry.id}`;
    if (!byQualified.has(qualified)) {
      byQualified.set(qualified, toResolvedModel(entry));
    }
  }

  // Per-provider family winners as "provider:family" (ALL families — contested and unique alike).
  //
  // A qualified name explicitly states its provider, so a contested family is not ambiguous
  // in this context: "codex:pro" unambiguously means the codex provider's pro-family winner.
  // Skipping contested families here inverts the feature — qualifying is precisely the
  // mechanism for disambiguating a contested family, and omitting these entries means the
  // 400 "qualify with provider:name (e.g. codex:sol)" advice leads straight to unresolved.
  for (const [provider, providerMap] of perProviderFamilyBest) {
    for (const [family, entry] of providerMap) {
      const qualified = `${provider}:${family}`;
      if (!byQualified.has(qualified)) {
        byQualified.set(qualified, toResolvedModel(entry));
      }
    }
  }

  // --- 5. byAlias: effective alias declarations (prototype-pollution guarded) ---
  // Iteration order, the own-property guard and the first-provider-wins rule all live in
  // collectAliasDeclarations — the display layer reads the same list, so the two cannot
  // disagree about which declarations are effective or which are PF-007 rejections.
  // Alias resolution is exactly ONE hop. "a → b" where b is itself an alias does NOT
  // chase to b's target. Without this bound, the first person wanting a→b→id writes
  // an unbounded loop with a cycle risk. (Project rule: every loop has an explicit bound.)
  const byAlias = new Map<string, ResolvedModel>();
  const rejectedAliases: { readonly alias: string; readonly target: string }[] = [];
  const danglingAliases: { readonly alias: string; readonly target: string; readonly provider: ProviderId }[] = [];

  for (const { alias, target, provider, reserved } of collectAliasDeclarations(aliasesByProvider)) {
    // PF-007: a reserved key would route main-thread traffic to Codex; a reserved target
    // becomes routable via the alias map, which decideRoute's exact-membership check
    // would then match.
    if (reserved) {
      rejectedAliases.push({ alias, target });
      continue;
    }

    // Build ResolvedModel from the target. If the target is a known registry entry,
    // carry its family. Otherwise assume it belongs to the declaring provider
    // (forward-compat: unknown ids may land when the registry catches up).
    const targetEntry = registry.find((e) => e.id === target);
    const targetProvider = byId.get(target) ?? provider;
    const model: ResolvedModel =
      targetEntry?.family !== undefined
        ? { id: target, provider: targetProvider, family: targetEntry.family }
        : { id: target, provider: targetProvider };
    byAlias.set(alias, model);

    // Track dangling aliases (target not in registry).
    // The router still routes them (forward-compat), but they are invisible to
    // buildModelRows and buildAliasRows disagrees with the router on enabled state.
    if (!byId.has(target)) {
      danglingAliases.push({ alias, target, provider });
    }
  }

  const table: RoutingTable = {
    byId,
    byFamily,
    byQualified,
    byAlias,
  };

  return { table, rejectedAliases, danglingAliases, ambiguousFamilies, reservedNameEntries };
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
  /**
   * Display generation string: dot-joined gen tuple (e.g. "5.6", "5.5"),
   * `""` when the gen tuple is empty, or `"?"` when the canonical is absent
   * from the registry (dangling alias target).
   */
  readonly gen: string;
  /** True for non-retired models. */
  readonly enabled: boolean;
  readonly source: "derived" | "config" | "direct";
}

/**
 * Build alias-centric rows for human-readable table display.
 *
 * One row per alias (config declarations first, then derived family aliases), plus
 * one "direct" row per non-retired model that has no alias coverage.
 *
 * Invariant with buildModelRows: the alias names in every ModelRow correspond
 * exactly to the non-direct AliasTableRows that share the same canonical.
 */
export const buildAliasRows = (
  registry: readonly ModelEntry[],
  aliasesByProvider: Readonly<Record<ProviderId, Readonly<Record<string, string>>>>,
): readonly AliasTableRow[] => {
  // Same rule, same claims, same declaration list the router reads — see buildRoutingTable.
  const familyWinners = flattenUniqueFamilies(selectFamilyWinners(registry).claims);

  const rows: AliasTableRow[] = [];
  const coveredAliases = new Set<string>();
  const coveredCanonicals = new Set<string>();

  // Config alias declarations first (they shadow derived aliases of the same name).
  for (const declaration of collectAliasDeclarations(aliasesByProvider)) {
    // PF-007 rejections are dropped by the router, so they must not appear here as
    // routable rows — that is exactly the display↔routing divergence this module avoids.
    if (declaration.reserved) continue;

    const { alias, target, provider: declaringProvider } = declaration;
    const entry = registry.find((e) => e.id === target);
    // A dangling target has no registry entry, so its generation is genuinely unknown
    // and its provider is the one that declared it — matching the router's own
    // forward-compat rule (`byId.get(target) ?? provider`).
    const genStr = entry !== undefined ? entry.gen.join(".") : "?";
    const provider: ProviderId = entry?.provider ?? declaringProvider;
    // Enabled: if the target is in the registry, use its retired flag. If not (dangling),
    // enabled=true because the router still routes it via forward-compat (unknown target
    // is assumed to belong to the declaring provider and is treated as routable).
    const enabled = entry !== undefined ? entry.retired !== true : true;
    rows.push({ alias, canonical: target, provider, gen: genStr, enabled, source: "config" });
    coveredAliases.add(alias);
    coveredCanonicals.add(target);
  }

  // Derived family aliases (skip any alias already covered by a config declaration).
  // A family winner IS a registry entry, so gen and provider are read straight off it —
  // there is no "target missing from the registry" case to fall back from.
  for (const [family, entry] of familyWinners) {
    if (coveredAliases.has(family)) continue;
    rows.push({
      alias: family,
      canonical: entry.id,
      provider: entry.provider,
      gen: entry.gen.join("."),
      enabled: true,
      source: "derived",
    });
    coveredAliases.add(family);
    coveredCanonicals.add(entry.id);
  }

  // Direct rows for non-retired models with no alias coverage
  for (const entry of registry) {
    if (entry.retired === true || coveredCanonicals.has(entry.id)) continue;
    coveredCanonicals.add(entry.id);
    rows.push({
      alias: "",
      canonical: entry.id,
      provider: entry.provider,
      gen: entry.gen.join("."),
      enabled: true,
      source: "direct",
    });
  }

  return rows;
};

/**
 * Build model-centric rows for JSON output and parity testing.
 *
 * One row per registry entry. Aliases include all config declarations pointing to
 * this model (source: "config") and all derived family aliases where this model
 * is the family winner (source: "derived"). Order within aliases: config first.
 *
 * Invariant with buildAliasRows: the alias names on each ModelRow correspond
 * exactly to the non-direct AliasTableRows that share the same canonical.
 */
export const buildModelRows = (
  registry: readonly ModelEntry[],
  aliasesByProvider: Readonly<Record<ProviderId, Readonly<Record<string, string>>>>,
): readonly ModelRow[] => {
  // Same rule, same claims, same declaration list the router reads — see buildRoutingTable.
  const familyWinners = flattenUniqueFamilies(selectFamilyWinners(registry).claims);

  // Collect aliases per model id
  const aliasesByModel = new Map<string, AliasEntry[]>();
  for (const entry of registry) {
    aliasesByModel.set(entry.id, []);
  }

  // Config alias declarations first. PF-007 rejections are skipped for the same reason
  // buildAliasRows skips them: the router does not bind them, so nothing may show them.
  const configAliases = new Set<string>();
  for (const { alias, target, reserved } of collectAliasDeclarations(aliasesByProvider)) {
    if (reserved) continue;
    configAliases.add(alias);
    const list = aliasesByModel.get(target);
    if (list !== undefined) list.push({ name: alias, source: "config" });
  }

  // Derived family aliases (skip if shadowed by a config declaration with the same name)
  for (const [family, entry] of familyWinners) {
    if (configAliases.has(family)) continue;
    const list = aliasesByModel.get(entry.id);
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
  readonly aliasesByProvider: Readonly<Record<ProviderId, Readonly<Record<string, string>>>>;
}

/**
 * Format a human-readable, colorless alias table.
 * Callers wrap with their own display logic (picocolors, indentation, etc.).
 *
 * Columns: alias → canonical  provider  gen:X.Y  enabled|disabled  (derived)|(config)|(direct)
 */
export const formatModelsReport = (input: FormatModelsReportInput): readonly string[] => {
  const rows = buildAliasRows(input.registry, input.aliasesByProvider);
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
