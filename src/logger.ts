export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * The closed field set is the redaction mechanism: nothing that can carry
 * token material or request content is representable here.
 */
export interface LogFields {
  readonly model?: string;
  readonly path?: string;
  readonly route?: string;
  readonly status?: number;
  readonly latencyMs?: number;
  readonly eventType?: string;
  readonly errorCode?: string;
  readonly effort?: string;
  /** Number of cached input tokens from the Codex backend response.completed usage.
   *  Proves prompt_cache_key is effective. Non-reversible (a count, not content). */
  readonly cachedTokens?: number;
  /** First 8 hex chars of the derived conversation key (the session_id prefix).
   *  Verifies key stability across turns without revealing the full key.
   *  Truncated: non-reversible. */
  readonly sessionKey?: string;
}

export interface Logger {
  log(level: LogLevel, event: string, fields?: LogFields): void;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const FIELD_KEYS = [
  "model",
  "path",
  "route",
  "status",
  "latencyMs",
  "eventType",
  "errorCode",
  "effort",
  "cachedTokens",
  "sessionKey",
] as const;

export const createConsoleLogger = (
  minLevel: LogLevel,
  write: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): Logger => ({
  log(level, event, fields) {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
    const parts = [`level=${level}`, `event=${event}`];
    if (fields !== undefined) {
      for (const key of FIELD_KEYS) {
        const value = fields[key];
        if (value !== undefined) parts.push(`${key}=${String(value)}`);
      }
    }
    write(parts.join(" "));
  },
});

export const noopLogger: Logger = { log: () => undefined };
