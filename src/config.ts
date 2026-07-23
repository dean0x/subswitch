import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { type Result, ok, err } from "./result.js";
import type { ProxyError } from "./errors.js";
import type { LogLevel } from "./logger.js";

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
  port: z.number().int().min(1).max(65535).default(4141),
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
      models: z.array(z.string().min(1)).default(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"]),
      // default UA format verified from codex-cli 0.144.6 live capture 2026-07-22;
      // machine-telemetry (OS/arch/terminal) intentionally omitted — set codex.userAgent
      // to override (vendor-drift pressure valve).
      userAgent: z.string().min(1).default("codex_cli_rs/0.144.6"),
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

  try {
    raw = JSON.parse(readFile(resolvedPath));
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

  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    return err({
      kind: "translate",
      message: `invalid config: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    });
  }

  const config = parsed.data;
  return ok({
    config: { ...config, codex: { ...config.codex, authFile: expandHome(config.codex.authFile) } },
    configPath: resolvedPath,
    fileFound,
  });
};

export const logLevelOf = (config: Config): LogLevel => config.logLevel;
