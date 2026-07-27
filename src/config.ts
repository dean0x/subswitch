import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { type Result, ok, err } from "./result.js";
import type { ProxyError } from "./errors.js";
import type { LogLevel } from "./logger.js";
import { isReservedAnthropicName, PROVIDER_IDS, type ProviderId } from "./models.js";

export const DEFAULT_PORT = 4141 as const;

/**
 * Default Codex auth file path (tilde-unexpanded).
 * Exported so callers derive the path via expandHome() rather than
 * hardcoding join(homedir(), ".codex", "auth.json") independently.
 */
export const DEFAULT_CODEX_AUTH_FILE = "~/.codex/auth.json";

// ---------------------------------------------------------------------------
// Sub-schemas (FileConfig layer)
// ---------------------------------------------------------------------------

const AnthropicSchema = z
  .object({
    baseUrl: z.url().default("https://api.anthropic.com"),
    /** Connection timeout for all upstream requests to the Anthropic leg. */
    connectTimeoutMs: z.number().int().positive().default(10_000),
    /** Stream idle timeout for the Anthropic passthrough. */
    streamIdleTimeoutMs: z.number().int().positive().default(300_000),
    /** Maximum sockets in the keep-alive pool for the Anthropic passthrough. */
    maxUpstreamSockets: z.number().int().positive().default(32),
  })
  .prefault({});

const AliasesSchema = z
  .record(z.string().min(1), z.string().min(1))
  .refine((aliases) => !Object.keys(aliases).some(isReservedAnthropicName), {
    message:
      "alias keys matching 'claude-*' or Anthropic tier words (sonnet, opus, haiku, inherit) are rejected — they would silently misroute Anthropic traffic to Codex",
  })
  .refine((aliases) => !Object.values(aliases).some(isReservedAnthropicName), {
    message:
      "alias targets matching 'claude-*' or Anthropic tier words (sonnet, opus, haiku, inherit) are rejected — the target becomes routable and would silently misroute Anthropic traffic to Codex",
  })
  .default({});

const CodexProviderSchema = z
  .object({
    baseUrl: z.url().default("https://chatgpt.com/backend-api/codex"),
    oauthTokenUrl: z.url().default("https://auth.openai.com/oauth/token"),
    authFile: z.string().min(1).default(DEFAULT_CODEX_AUTH_FILE),
    // default UA format verified from codex-cli 0.144.6 live capture 2026-07-22;
    // machine-telemetry (OS/arch/terminal) intentionally omitted — set providers.codex.userAgent
    // to override (vendor-drift pressure valve).
    userAgent: z.string().min(1).default("codex_cli_rs/0.144.6"),
    // codex.aliases maps user-defined alias names to canonical model ids.
    // Both sides are checked against isReservedAnthropicName (PF-007).
    aliases: AliasesSchema,
    reasoningCache: z
      .object({
        maxEntries: z.number().int().positive().default(4096),
        maxBytes: z.number().int().positive().default(64 * 1024 * 1024),
      })
      .prefault({}),
    /** Per-Codex-request total time limit. */
    requestTimeoutMs: z.number().int().positive().default(600_000),
    /** Codex stream idle timeout — resets on each SSE data chunk. */
    streamIdleTimeoutMs: z.number().int().positive().default(300_000),
    /** Maximum bytes per individual SSE event from the Codex upstream. */
    maxSseEventBytes: z.number().int().positive().default(4 * 1024 * 1024),
  })
  .prefault({});

const ProvidersSchema = z
  .object({
    codex: CodexProviderSchema,
  })
  .prefault({});

const LimitsSchema = z
  .object({
    /** Maximum request body bytes buffered before the Codex routing decision. */
    maxBodyBytes: z.number().int().positive().default(32 * 1024 * 1024),
    /** Interval between SSE ping frames sent to clients during long Codex streams. */
    pingIntervalMs: z.number().int().positive().default(15_000),
    /** Maximum concurrent in-flight requests; 503 is returned when the limit is exceeded. */
    maxConcurrentRequests: z.number().int().positive().default(32),
  })
  .prefault({});

const FileConfigSchema = z.object({
  port: z.number().int().min(1).max(65535).default(DEFAULT_PORT),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
  anthropic: AnthropicSchema,
  providers: ProvidersSchema,
  limits: LimitsSchema,
});

/** Raw on-disk config shape — what FileConfigSchema.safeParse() produces. */
export type FileConfig = z.infer<typeof FileConfigSchema>;

// ---------------------------------------------------------------------------
// Resolved Config interface (runtime shape)
// ---------------------------------------------------------------------------

/**
 * Resolved runtime config. Hand-written (NOT z.infer) so:
 *  - authFile is always tilde-expanded (resolveConfig applies expandHome).
 */
export interface Config {
  readonly port: number;
  readonly logLevel: LogLevel;
  readonly anthropic: {
    readonly baseUrl: string;
    readonly connectTimeoutMs: number;
    readonly streamIdleTimeoutMs: number;
    readonly maxUpstreamSockets: number;
  };
  /** Codex provider settings. */
  readonly codex: {
    readonly baseUrl: string;
    readonly oauthTokenUrl: string;
    /** Tilde-expanded at resolveConfig time. */
    readonly authFile: string;
    readonly userAgent: string;
    readonly aliases: Readonly<Record<string, string>>;
    readonly reasoningCache: {
      readonly maxEntries: number;
      readonly maxBytes: number;
    };
    readonly requestTimeoutMs: number;
    readonly streamIdleTimeoutMs: number;
    readonly maxSseEventBytes: number;
  };
  readonly limits: {
    readonly maxBodyBytes: number;
    readonly pingIntervalMs: number;
    readonly maxConcurrentRequests: number;
  };
}

export type Limits = Config["limits"];

// ---------------------------------------------------------------------------
// Per-provider config accessor
// ---------------------------------------------------------------------------

/** The provider-neutral slice of config that doctor, health, and the CLI banner need. */
export interface ProviderRuntimeConfig {
  /** Human-facing name for CLI and JSON output (e.g. "Codex"). */
  readonly displayName: string;
  /** Tilde-expanded credential file path. */
  readonly authFile: string;
  /** Provider API base URL. */
  readonly baseUrl: string;
  /** Shell command that obtains this provider's credential, quoted in doctor remediation. */
  readonly loginCommand: string;
}

/**
 * Total map from ProviderId to its config slice.
 *
 * A Record over the closed ProviderId union — NOT a switch with a default arm.
 * Adding a ProviderId without adding an accessor here is a compile error, and
 * there is no unreachable fallback returning empty-string sentinels that callers
 * then have to guard against.
 */
const PROVIDER_CONFIG_ACCESSORS: Readonly<Record<ProviderId, (config: Config) => ProviderRuntimeConfig>> = {
  codex: (config) => ({
    displayName: "Codex",
    authFile: config.codex.authFile,
    baseUrl: config.codex.baseUrl,
    loginCommand: "codex login",
  }),
};

/**
 * Resolve the config slice for one provider.
 *
 * Single source of truth for "where does provider X keep its credentials and
 * base URL" — doctor, the health endpoint, the serve banner, and `models --json`
 * all read through here so they cannot drift apart.
 */
export const providerConfigFor = (config: Config, id: ProviderId): ProviderRuntimeConfig =>
  PROVIDER_CONFIG_ACCESSORS[id](config);

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Expand a leading `~` or `~/` to the user's home directory.
 * Exported for use in init.ts (collectPreconditionWarnings auth path).
 */
export const expandHome = (path: string): string =>
  path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;

// ---------------------------------------------------------------------------
// Legacy shape detection
// ---------------------------------------------------------------------------

/**
 * Keys that moved when the config was restructured to `providers.<id>.*`,
 * mapped to their new location. Zod's default object behaviour STRIPS unknown
 * keys, so without this check a pre-restructure config parses successfully and
 * every setting in it is silently discarded — custom aliases vanish, custom
 * baseUrl/authFile/userAgent revert to defaults, and nothing is reported.
 *
 * Silent reversion is the worst failure mode available here, so a legacy key is
 * a hard error naming its replacement rather than a warning.
 */
const LEGACY_KEY_MOVES: readonly (readonly [path: string, replacement: string])[] = [
  ["codex", "providers.codex"],
  ["reasoningCache", "providers.codex.reasoningCache"],
  ["limits.connectTimeoutMs", "anthropic.connectTimeoutMs"],
  ["limits.maxUpstreamSockets", "anthropic.maxUpstreamSockets"],
  ["limits.streamIdleTimeoutMs", "anthropic.streamIdleTimeoutMs and/or providers.codex.streamIdleTimeoutMs"],
  ["limits.requestTimeoutMs", "providers.codex.requestTimeoutMs"],
  ["limits.maxSseEventBytes", "providers.codex.maxSseEventBytes"],
];

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Read a dotted path using own-property checks only (prototype-pollution safe). */
const hasOwnPath = (root: Record<string, unknown>, path: string): boolean => {
  let node: unknown = root;
  for (const segment of path.split(".")) {
    if (!isPlainObject(node) || !Object.hasOwn(node, segment)) return false;
    node = node[segment];
  }
  return true;
};

/**
 * Detect keys from the pre-`providers.*` config layout.
 *
 * Pure: no I/O. Returns the legacy paths present, in declaration order, each
 * paired with its replacement. Empty array means the config has no legacy keys.
 */
export const detectLegacyConfigKeys = (
  raw: unknown,
): readonly { readonly path: string; readonly replacement: string }[] => {
  if (!isPlainObject(raw)) return [];
  const found: { readonly path: string; readonly replacement: string }[] = [];
  for (const [path, replacement] of LEGACY_KEY_MOVES) {
    if (hasOwnPath(raw, path)) found.push({ path, replacement });
  }
  // `codex.models` was deleted outright — the routable set now comes from the registry.
  if (hasOwnPath(raw, "codex.models")) {
    found.push({
      path: "codex.models",
      replacement: "(removed — routing now follows the built-in model registry; use providers.codex.aliases for custom names)",
    });
  }
  return found;
};

// ---------------------------------------------------------------------------
// resolveConfig — FileConfig → Config transformation
// ---------------------------------------------------------------------------

/**
 * Transform a parsed FileConfig into the runtime Config.
 *
 * Pure: no I/O. All effectful operations (file reads, env access) happen in loadConfig.
 *
 * Maps providers.codex.* → codex.*.
 * Expands tilde in authFile.
 */
export const resolveConfig = (file: FileConfig): Config => {
  const codex = file.providers.codex;
  return {
    port: file.port,
    logLevel: file.logLevel,
    anthropic: file.anthropic,
    codex: {
      baseUrl: codex.baseUrl,
      oauthTokenUrl: codex.oauthTokenUrl,
      authFile: expandHome(codex.authFile),
      userAgent: codex.userAgent,
      aliases: codex.aliases,
      reasoningCache: codex.reasoningCache,
      requestTimeoutMs: codex.requestTimeoutMs,
      streamIdleTimeoutMs: codex.streamIdleTimeoutMs,
      maxSseEventBytes: codex.maxSseEventBytes,
    },
    limits: file.limits,
  };
};

// ---------------------------------------------------------------------------
// loadConfig — discovers, reads, parses, and resolves the config file
// ---------------------------------------------------------------------------

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
   * Providers the user explicitly opted into by writing a `providers.<id>` block.
   *
   * Zod fills every provider's defaults, so the resolved `Config` cannot answer
   * "did the user ask for this provider?" — but doctor's severity rules depend on
   * it. A provider the user never configured must stay informational rather than
   * failing the exit code. (avoids PF-006)
   */
  readonly configuredProviders: ReadonlySet<ProviderId>;
}

/**
 * Which `providers.<id>` blocks are literally present in the raw config object.
 * Own-property checks only — a JSON-parsed object's inherited keys must never
 * count as user intent.
 */
const detectConfiguredProviders = (raw: unknown): ReadonlySet<ProviderId> => {
  const found = new Set<ProviderId>();
  if (!isPlainObject(raw)) return found;
  const providers = Object.hasOwn(raw, "providers") ? raw["providers"] : undefined;
  if (!isPlainObject(providers)) return found;
  for (const id of PROVIDER_IDS) {
    if (Object.hasOwn(providers, id)) found.add(id);
  }
  return found;
};

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

  // Step 3: reject the pre-`providers.*` layout before parsing. Zod strips unknown
  // keys, so a legacy config would otherwise parse clean and silently run on defaults.
  const legacy = detectLegacyConfigKeys(raw);
  if (legacy.length > 0) {
    return err({
      kind: "translate",
      message:
        `outdated config layout in ${resolvedPath} — ` +
        legacy.map((l) => `move \`${l.path}\` to \`${l.replacement}\``).join("; ") +
        `. Edit the file to match subswitch.config.example.json, or delete it to run on defaults.`,
    });
  }

  // Step 4: validate against FileConfigSchema and resolve to runtime Config.
  const parsed = FileConfigSchema.safeParse(raw);
  if (!parsed.success) {
    return err({
      kind: "translate",
      message: `invalid config: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    });
  }

  return ok({
    config: resolveConfig(parsed.data),
    configPath: resolvedPath,
    fileFound,
    configuredProviders: detectConfiguredProviders(raw),
  });
};

export const logLevelOf = (config: Config): LogLevel => config.logLevel;
