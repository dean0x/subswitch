import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { type Result, ok, err } from "./result.js";
import type { ProxyError } from "./errors.js";
import type { LogLevel } from "./logger.js";
import { MODEL_REGISTRY, isReservedAnthropicName } from "./models.js";

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
 *  - doctor.ts can read config.codex.* without being modified (Phase E constraint).
 *  - authFile is always tilde-expanded (resolveConfig applies expandHome).
 *  - codex.models is always derived from MODEL_REGISTRY (not user-configurable).
 *
 * Coders note: when Phase F removes config.codex.models and updates doctor.ts,
 * the codex.models field can be removed here. For now it is a derived field that
 * keeps doctor running.
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
  /**
   * Codex provider settings. Doctor reads these fields directly — do not remove
   * or rename without updating src/doctor.ts (Phase F task).
   */
  readonly codex: {
    readonly baseUrl: string;
    readonly oauthTokenUrl: string;
    /** Tilde-expanded at resolveConfig time. */
    readonly authFile: string;
    readonly userAgent: string;
    readonly aliases: Readonly<Record<string, string>>;
    /**
     * All non-retired Codex model ids in registry order.
     * Derived from MODEL_REGISTRY — never from user config.
     * Doctor displays this as the routable set. Phase F will update doctor.ts
     * to read from the routing table instead and this field will be removed.
     */
    readonly models: readonly string[];
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
  };
}

export type Limits = Config["limits"];

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
// resolveConfig — FileConfig → Config transformation
// ---------------------------------------------------------------------------

/**
 * Transform a parsed FileConfig into the runtime Config.
 *
 * Pure: no I/O. All effectful operations (file reads, env access) happen in loadConfig.
 *
 * Maps providers.codex.* → codex.* for doctor.ts compatibility.
 * Expands tilde in authFile.
 * Derives codex.models from MODEL_REGISTRY (routing is now registry-based).
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
      // Derived from registry — not configurable. Routing is registry-based (ADR-005).
      models: MODEL_REGISTRY.filter((e) => e.retired !== true).map((e) => e.id),
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

  // Step 3: validate against FileConfigSchema and resolve to runtime Config.
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
  });
};

export const logLevelOf = (config: Config): LogLevel => config.logLevel;
