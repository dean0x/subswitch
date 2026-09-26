/** The destination registry for Codex ingress. Forward-ingress reservation rules stay independent. */
import { isPlainObject } from "./plain-object.js";
import { compareGen, MODEL_REGISTRY, type ModelEntry } from "./models.js";
/** The reasoning efforts every catalogued Claude model accepts on `output_config.effort`. */
export const CLAUDE_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ClaudeReasoningEffort = (typeof CLAUDE_REASONING_EFFORTS)[number];

/**
 * One reverse-leg destination. Every capability field is REQUIRED, so a new model
 * (e.g. a future Sonnet 5.5) cannot be catalogued without deciding each one.
 * Values come from platform.claude.com (fetched 2026-09-26).
 */
export interface ClaudeModel {
  readonly id: string;
  readonly family: string;
  readonly gen: readonly number[];
  readonly contextWindow: number;
  /** The Messages API `max_tokens` ceiling; the adapter clamps outgoing requests to it. */
  readonly maxOutputTokens: number;
  /** Adaptive thinking cannot be switched off: `thinking: {type: "disabled"}` is a 400. */
  readonly thinkingAlwaysOn: boolean;
  /** Accepts `tool_choice` `{type: "any"}` / `{type: "tool"}`; when false both are a 400. */
  readonly forcedToolChoice: boolean;
  /** The effort the model uses when none is sent, advertised as Codex's default level. */
  readonly defaultEffort: ClaudeReasoningEffort;
}

export const CLAUDE_MODELS: readonly ClaudeModel[] = [
  {
    id: "claude-sonnet-5",
    family: "sonnet",
    gen: [5],
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    thinkingAlwaysOn: false,
    forcedToolChoice: true,
    defaultEffort: "high",
  },
  {
    id: "claude-opus-5",
    family: "opus",
    gen: [5],
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    thinkingAlwaysOn: false,
    forcedToolChoice: true,
    defaultEffort: "high",
  },
  {
    id: "claude-opus-5-5",
    family: "opus",
    gen: [5, 5],
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    thinkingAlwaysOn: true,
    forcedToolChoice: false,
    defaultEffort: "medium",
  },
  {
    id: "claude-fable-5",
    family: "fable",
    gen: [5],
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    thinkingAlwaysOn: true,
    forcedToolChoice: true,
    defaultEffort: "high",
  },
  {
    id: "claude-fable-5-1",
    family: "fable",
    gen: [5, 1],
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    thinkingAlwaysOn: true,
    forcedToolChoice: false,
    defaultEffort: "high",
  },
];

/** The catalog entry for a canonical id; undefined for an alias-bridged target the catalog does not know. */
export const claudeModel = (id: string): ClaudeModel | undefined => CLAUDE_MODELS.find((model) => model.id === id);

/**
 * True for names in the Claude namespace (`claude-*`, or the provider-qualified `claude:*`),
 * case-insensitively. No OpenAI model lives there, so the reverse leg answers an unresolved
 * name in it with a clear error rather than forwarding it to OpenAI. This rejects, it never
 * routes: routing stays exact membership (applies ADR-005).
 */
export const isClaudeModelName = (name: string): boolean => /^claude[-:]/i.test(name);

/** Longest client-supplied model name echoed back in an error message. */
const DISPLAY_NAME_MAX_CHARS = 64;
/** Characters a model name legitimately contains; anything else becomes `?`. */
const UNSAFE_MODEL_NAME_CHARS = /[^A-Za-z0-9._:[\]-]/g;

/**
 * A client-supplied model name made safe to echo in an error message: bounded, and with
 * control characters, whitespace, quotes, backticks and markup replaced by `?`, so a crafted
 * name can neither forge log or terminal output nor smuggle markup into the reply.
 */
export const displayModelName = (name: string): string =>
  name.length > DISPLAY_NAME_MAX_CHARS
    ? `${name.slice(0, DISPLAY_NAME_MAX_CHARS).replace(UNSAFE_MODEL_NAME_CHARS, "?")}...`
    : name.replace(UNSAFE_MODEL_NAME_CHARS, "?");

/** Escape regex metacharacters so a registry name matches literally (e.g. the `.` in `gpt-5.6-sol`). */
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Build the reverse-leg reservation predicate from a model registry.
 *
 * The registry is THE exact-membership set (applies ADR-005/ADR-006), so the names it
 * reserves are derived from it rather than hand-listed. A hand-written alternation is a
 * mirror leg that restarts at the pre-ADR baseline (avoids PF-028): a family added to
 * MODEL_REGISTRY that the regex never learned about could be claimed by a Claude alias
 * and hijacked on the reverse leg — the mirror image of PF-007, and `validClaudeAlias`
 * is the ONLY gate on `codexIngress.claude.aliases`.
 *
 * The three fixed arms have no registry counterpart and stay literal:
 * - `gpt-`, `o1`/`o3`/`o4`: OpenAI's naming space, including ids the registry does not list yet.
 * - `codex:`: the provider-qualified form, reserved whatever follows it.
 *
 * Registry names match exactly or with a variant suffix (`sol`, `sol[1m]`) — never as the
 * prefix of a longer word, so `solaris` stays available to the Claude leg.
 *
 * Exported so a test can build a predicate over a synthetic registry and prove the
 * derivation is live; production callers use the module-level `isOpenaiModelName`.
 *
 * TOTAL: never throws. PURE: depends only on its argument.
 */
export const buildOpenaiModelNamePredicate = (registry: readonly ModelEntry[]): ((name: string) => boolean) => {
  const names = [
    ...new Set(registry.flatMap((entry) => (entry.family !== undefined ? [entry.id, entry.family] : [entry.id]))),
  ].filter((name) => name.length > 0);
  // Appended only when the registry declares names: an empty alternation arm matches the
  // empty prefix of EVERY name, which would reserve the entire namespace against the Claude leg.
  const registryArm = names.length > 0 ? `|(?:${names.map(escapeRegExp).join("|")})(?:$|\\[)` : "";
  const pattern = new RegExp(`^(?:gpt-|o[134](?:-|$)|codex:${registryArm})`, "i");
  return (name: string): boolean => pattern.test(name);
};

/** Built once at module load from the canonical registry. */
export const isOpenaiModelName: (name: string) => boolean = buildOpenaiModelNamePredicate(MODEL_REGISTRY);

export const validClaudeAlias = (name: string, target: string): boolean =>
  !isOpenaiModelName(name) && !isOpenaiModelName(target) && target.startsWith("claude-");

export function claudeResolver(aliases: Readonly<Record<string, string>>) {
  const names = new Map<string, string>();
  const rejectedAliases: string[] = [];
  const families = new Map<string, ClaudeModel>();
  for (const model of CLAUDE_MODELS) {
    names.set(model.id, model.id);
    names.set(`claude:${model.id}`, model.id);
    const current = families.get(model.family);
    if (!current || compareGen(model.gen, current.gen) > 0) families.set(model.family, model);
  }
  for (const model of families.values()) {
    names.set(model.family, model.id);
    names.set(`claude:${model.family}`, model.id);
  }
  for (const [name, target] of Object.entries(aliases)) {
    if (!validClaudeAlias(name, target)) {
      rejectedAliases.push(name);
      continue;
    }
    names.set(name, target);
    names.set(target, target);
    names.set(`claude:${name}`, target);
  }
  // Canonical IDs retain precedence over aliases, matching the forward resolver.
  for (const id of [
    ...CLAUDE_MODELS.map((model) => model.id),
    ...Object.entries(aliases)
      .filter(([name, target]) => validClaudeAlias(name, target))
      .map(([, target]) => target),
  ]) {
    names.set(id, id);
    names.set(`claude:${id}`, id);
  }
  return Object.assign((name: string): string | undefined => names.get(name), { rejectedAliases });
}

export function claudeModelRows(aliases: Readonly<Record<string, string>>) {
  const resolve = claudeResolver(aliases);
  const ids = new Set([...CLAUDE_MODELS.map((model) => model.id), ...Object.values(aliases)]);
  return [...ids].map((id) => ({
    id,
    provider: "claude",
    registered: CLAUDE_MODELS.some((model) => model.id === id),
    aliases: [
      ...new Set([
        ...CLAUDE_MODELS.filter((model) => model.id === id && resolve(model.family) === id).map(
          (model) => model.family,
        ),
        ...Object.entries(aliases)
          .filter(([, target]) => target === id)
          .map(([name]) => name),
      ]),
    ],
  }));
}

/** Preserve OpenAI's evolving catalog and derive only the native tool-surface fields for Claude. */
export function augmentCodexModels(
  body: Record<string, unknown>,
  aliases: Readonly<Record<string, string>>,
): Record<string, unknown> {
  const models = Array.isArray(body["models"]) && body["models"].every(isPlainObject) ? body["models"] : undefined;
  if (!models?.length) return body;
  const template = models.find((model) => model["tool_mode"] === "code_mode_only") ?? models[0]!;
  const present = new Set(models.map((model) => model["slug"]));
  const additions = claudeModelRows(aliases).flatMap((row) => {
    const capability = claudeModel(row.id);
    if (!capability) return []; // Custom aliases route, but unverified capabilities are not advertised.
    return [row.id, ...row.aliases]
      .filter((slug) => !present.has(slug))
      .map((slug) => ({
        ...template,
        slug,
        display_name: slug,
        description: `Claude via SubSwitch (${row.id})`,
        supported_in_api: true,
        context_window: capability.contextWindow,
        max_context_window: capability.contextWindow,
        default_reasoning_level: capability.defaultEffort,
        // `none` is never offered: it cannot be honoured on thinking-always-on models.
        supported_reasoning_levels: CLAUDE_REASONING_EFFORTS.map((effort) => ({
          effort,
          description: effort,
        })),
        model_messages: null,
        base_instructions:
          "You are a coding assistant running in Codex. Follow the user's task and the native tool definitions.",
        supports_search_tool: false,
        input_modalities: ["text"],
        additional_speed_tiers: [],
        service_tiers: [],
        default_service_tier: null,
      }));
  });
  return { ...body, models: [...models, ...additions] };
}
