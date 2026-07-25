import { createColors } from "picocolors";
import { resolveColorEnabled } from "./tty.js";

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

const formatTime = (): string => {
  const d = new Date();
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  const s = d.getSeconds().toString().padStart(2, "0");
  return `${h}:${m}:${s}`;
};

/**
 * Create a structured key=value logger.
 *
 * @param minLevel - Minimum level to emit.
 * @param write    - Output sink; defaults to stderr.
 * @param color    - Apply picocolors to level/event tokens and prepend a timestamp.
 *                   Defaults to true iff stderr is a TTY and NO_COLOR is unset.
 *                   Tests pass an explicit write function and let color default to
 *                   false (tests never run in a TTY), so existing assertions hold.
 */
export const createConsoleLogger = (
  minLevel: LogLevel,
  write: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
  color: boolean = resolveColorEnabled(
    process.env as Record<string, string | undefined>,
    process.stderr.isTTY === true,
  ),
): Logger => {
  // createColors(enabled) bypasses picocolors' own TTY detection so that the
  // `color` parameter is the single source of truth.
  const pc = createColors(color);
  const colorLevelStr = (level: LogLevel): string => {
    switch (level) {
      case "debug":
        return `level=${pc.dim(level)}`;
      case "info":
        return `level=${pc.cyan(level)}`;
      case "warn":
        return `level=${pc.yellow(level)}`;
      case "error":
        return `level=${pc.red(level)}`;
    }
  };

  return {
    log(level, event, fields) {
      if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
      const levelStr = colorLevelStr(level);
      const eventStr = `event=${pc.bold(event)}`;
      const parts = [levelStr, eventStr];
      if (fields !== undefined) {
        for (const key of FIELD_KEYS) {
          const value = fields[key];
          if (value !== undefined) {
            // Strip newlines to prevent log-injection via crafted model strings or other
            // field values. FIELD_KEYS is a closed allow-list so no token material can
            // reach this path, but newlines in a model field could still forge a log line.
            const safe = String(value).replace(/[\r\n]/g, "");
            parts.push(`${key}=${safe}`);
          }
        }
      }
      const ts = color ? `${pc.dim(formatTime())} ` : "";
      write(`${ts}${parts.join(" ")}`);
    },
  };
};

export const noopLogger: Logger = { log: () => undefined };
