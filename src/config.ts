import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { type Result, ok, err } from "./result.js";
import type { ProxyError } from "./errors.js";
import type { LogLevel } from "./logger.js";
import { MODEL_REGISTRY, ALL_MODEL_IDS, normalizeModelList, isAnthropicModelName } from "./models.js";

export const DEFAULT_PORT = 4141 as const;
// Derived from the canonical registry so there is exactly one source of truth.
// Keep the exported name — src/init.ts:65 and test/unit/init-wizard.test.ts:17 import it.
export const DEFAULT_CODEX_MODELS = ALL_MODEL_IDS;

const LimitsSchema = z.object({
  maxBodyBytes: z.number().int().positive().default(32 * 1024 * 1024),
  connectTimeoutMs: z.number().int().positive().default(10_000),
  streamIdleTimeoutMs: z.number().int().positive().default(300_000),
  requestTimeoutMs: z.number().int().positive().default(600_000),
  pingIntervalMs: z.number().int().positive().default(15_000),
  maxSseEventBytes: z.number().int().positive().default(4 * 1024 * 1024),
  maxUpstreamSockets: z.number().int().positive().default(32),
});

const ConfigSchema = z.object({
  port: z.number().int().min(1).max(65535).default(DEFAULT_PORT),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
  anthropic: z
    .object({
      baseUrl: z.url().default("https://api.anthropic.com"),
    })
    .prefault({}),
  codex: z
    .object({
      baseUrl: z.url().default("https://chatgpt.com/backend-api/codex"),
      oauthTokenUrl: z.url().default("https://auth.openai.com/oauth/token"),
      authFile: z.string().min(1).default("~/.codex/auth.json"),
      // default UA format verified from codex-cli 0.144.6 live capture 2026-07-22;
      // machine-telemetry (OS/arch/terminal) intentionally omitted — set codex.userAgent
      // to override (vendor-drift pressure valve).
      userAgent: z.string().min(1).default("codex_cli_rs/0.144.6"),
      // codex.aliases maps user-defined alias names to canonical model ids.
      // Entries override derived family aliases (see src/models.ts makeModelResolver rule 2).
      //
      // BOTH sides are checked against isAnthropicModelName, because either one silently
      // misroutes the main thread to Codex under the exact-match routing rule (ADR-005):
      //  - a 'claude-*' / tier-word KEY resolves inbound Anthropic traffic to a Codex id;
      //  - a 'claude-*' / tier-word TARGET is added to the routable set by
      //    normalizeModelList's pressure valve, so decideRoute then matches the raw
      //    Anthropic model id by exact membership and routes it to Codex.
      aliases: z
        .record(z.string().min(1), z.string().min(1))
        .refine((aliases) => !Object.keys(aliases).some(isAnthropicModelName), {
          message:
            "alias keys matching 'claude-*' or Anthropic tier words (sonnet, opus, haiku, inherit) are rejected — they would silently misroute Anthropic traffic to Codex",
        })
        .refine((aliases) => !Object.values(aliases).some(isAnthropicModelName), {
          message:
            "alias targets matching 'claude-*' or Anthropic tier words (sonnet, opus, haiku, inherit) are rejected — the target becomes routable and would silently misroute Anthropic traffic to Codex",
        })
        .default({}),
      // models: authoritative and narrowing when present; absent = all non-retired registry ids.
      // min(1): an empty list would silently disable all Codex routing while the ready banner
      // still prints "routing: → Codex". Reject it explicitly so the user sees a config error.
      // Thunk default keeps Config["codex"]["models"] typed string[] — no consumer type churn.
      models: z
        .array(z.string().min(1))
        .min(1)
        .default(() => [...ALL_MODEL_IDS]),
    })
    .prefault({}),
  reasoningCache: z
    .object({
      maxEntries: z.number().int().positive().default(4096),
      maxBytes: z.number().int().positive().default(64 * 1024 * 1024),
    })
    .prefault({}),
  limits: LimitsSchema.prefault({}),
});

export type Config = z.infer<typeof ConfigSchema>;
export type Limits = z.infer<typeof LimitsSchema>;

const expandHome = (path: string): string =>
  path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;

export interface LoadConfigOptions {
  /** Explicit config file path. Takes precedence over SUBSWITCH_CONFIG and the implicit cwd default. */
  readonly configPath?: string;
  /** Injectable file reader. Defaults to `readFileSync`. Used by tests to supply inline config. */
  readonly readFile?: (path: string) => string;
  /** Injectable environment variable map. Defaults to `process.env`. Used by tests. */
  readonly env?: Record<string, string | undefined>;
}

export interface LoadConfigResult {
  readonly config: Config;
  readonly configPath: string;
  readonly fileFound: boolean;
  /**
   * True when codex.models was explicitly provided in the config file AND it contains
   * at least one generation-specific id (e.g. "gpt-5.6-sol") whose family has a
   * floating alias ("sol"). Computed from raw JSON before normalization — only
   * computable here. Consumed by doctor (Phase C) to nudge toward aliases.
   */
  readonly codexModelsPinned: boolean;
}

/**
 * Load subswitch.config.json (all fields optional) merged over defaults.
 *
 * Path precedence (highest to lowest):
 *   1. explicit `configPath` option
 *   2. `SUBSWITCH_CONFIG` env var (tilde-expanded)
 *   3. implicit `<cwd>/subswitch.config.json`
 *
 * Only the implicit cwd default silently falls back to pure defaults on ENOENT.
 * An explicitly-requested path (option or SUBSWITCH_CONFIG) that is missing is an error.
 */
export const loadConfig = (options: LoadConfigOptions = {}): Result<LoadConfigResult, ProxyError> => {
  const env = options.env ?? process.env;
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, "utf8"));

  let resolvedPath: string;
  let isExplicit: boolean;

  if (options.configPath !== undefined) {
    resolvedPath = options.configPath;
    isExplicit = true;
  } else if (env["SUBSWITCH_CONFIG"] !== undefined && env["SUBSWITCH_CONFIG"] !== "") {
    resolvedPath = expandHome(env["SUBSWITCH_CONFIG"]);
    isExplicit = true;
  } else {
    resolvedPath = join(process.cwd(), "subswitch.config.json");
    isExplicit = false;
  }

  let raw: unknown = {};
  let fileFound = false;

  // Step 1: read the file (isolates ENOENT / permission errors from JSON errors).
  let rawString: string | undefined;
  try {
    rawString = readFile(resolvedPath);
    fileFound = true;
  } catch (cause) {
    const isEnoent = cause instanceof Error && (cause as NodeJS.ErrnoException).code === "ENOENT";
    if (isEnoent && isExplicit) {
      return err({ kind: "translate", message: `config file not found at ${resolvedPath}` });
    }
    if (!isEnoent) {
      return err({ kind: "translate", message: `failed to read config at ${resolvedPath}: ${String(cause)}` });
    }
    // Implicit cwd ENOENT — silently fall back to pure defaults.
  }

  // Step 2: parse JSON (only when a file was successfully read).
  if (rawString !== undefined) {
    try {
      raw = JSON.parse(rawString);
    } catch {
      return err({
        kind: "translate",
        message: `malformed JSON in ${resolvedPath} — fix or delete the file`,
      });
    }
  }

  // Step 3: extract raw codex.models BEFORE schema parse.
  // codexModelsPinned is only computable here — after normalization the distinction
  // between "absent" and "present with defaults" is lost.
  const rawCodexModels = extractRawCodexModels(raw);
  const codexModelsPinned = computeCodexModelsPinned(rawCodexModels);

  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    return err({
      kind: "translate",
      message: `invalid config: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    });
  }

  const config = parsed.data;

  // Step 4: normalize codex.models through the alias table.
  // rawCodexModels is undefined when codex.models was absent → normalizeModelList adds all
  // non-retired registry ids plus any override targets (pressure valve).
  // rawCodexModels is present → expands aliases, preserves unknowns verbatim.
  const normalizedModels = normalizeModelList(rawCodexModels, config.codex.aliases);

  return ok({
    config: {
      ...config,
      codex: {
        ...config.codex,
        authFile: expandHome(config.codex.authFile),
        models: [...normalizedModels],
      },
    },
    configPath: resolvedPath,
    fileFound,
    codexModelsPinned,
  });
};

export const logLevelOf = (config: Config): LogLevel => config.logLevel;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extract the raw codex.models array from unparsed JSON before schema normalization.
 * Returns undefined when codex.models is absent from the JSON — this distinguishes
 * "absent → use all defaults" from "present with values → authoritative and narrowing".
 */
const extractRawCodexModels = (raw: unknown): readonly string[] | undefined => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const rawObj = raw as Record<string, unknown>;
  const codex = rawObj["codex"];
  if (typeof codex !== "object" || codex === null || Array.isArray(codex)) return undefined;
  const codexObj = codex as Record<string, unknown>;
  const models = codexObj["models"];
  if (!Array.isArray(models)) return undefined;
  return (models as unknown[]).filter((m): m is string => typeof m === "string");
};

/**
 * True when models were explicitly listed AND at least one entry is a generation-specific
 * id (e.g. "gpt-5.6-sol") whose family has a floating alias ("sol").
 * Used by doctor (Phase C) to nudge users toward using family aliases instead of pinning.
 */
const computeCodexModelsPinned = (rawModels: readonly string[] | undefined): boolean =>
  rawModels !== undefined &&
  rawModels.some((m) => MODEL_REGISTRY.some((e) => e.id === m && e.family !== undefined));
