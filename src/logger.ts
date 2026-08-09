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

/**
 * Render one token's value: newlines stripped, then quoted (with internal escaping)
 * if it could otherwise be mistaken for sibling tokens.
 *
 * Stripping prevents record-forgery — a `\n` in an interpolated string forges a whole
 * extra record. Quoting prevents field-forgery — a value containing whitespace, `=`,
 * `"`, or `\` would otherwise parse as additional top-level fields under logfmt's
 * last-wins semantics. Embedded `"` and `\` are backslash-escaped so the surrounding
 * quotes cannot be closed by a crafted value. Real values (model ids, route names,
 * event names, status codes) contain none of these characters, so this is a no-op on
 * every log line the tree emits.
 */
const renderToken = (value: string): string => {
  const safe = value.replace(/[\r\n]/g, "");
  return /[\s="\\]/.test(safe) ? `"${safe.replace(/["\\]/g, (c) => `\\${c}`)}"` : safe;
};

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
      // `event` gets the same treatment as a field value. It is a different axis from
      // FIELD_KEYS — the closed allow-list bounds which fields may be logged and says
      // nothing about the event token — and it is interpolated into the same line, so
      // an unsanitised event name forges records exactly as an unsanitised value would.
      // Every event name in the tree is a compile-time string literal — no config value
      // and no request value can become one — which is the primary control; this is
      // defence in depth. The guarantee is fully table-derived: all provider-scoped
      // names come from providerEvents(providerId) (ProviderEvents<P> in provider-events.ts)
      // and so are keyed to the closed ProviderId union. This includes the seven auth
      // events in codex-auth.ts, which were formerly hardcoded `codex_*` literals
      // outside that table and have been brought in.
      const eventStr = `event=${pc.bold(renderToken(event))}`;
      const parts = [levelStr, eventStr];
      if (fields !== undefined) {
        for (const key of FIELD_KEYS) {
          const value = fields[key];
          if (value !== undefined) {
            // FIELD_KEYS is a closed allow-list, so no token material can reach this
            // path — but a crafted model string could still carry a newline or an `=`.
            parts.push(`${key}=${renderToken(String(value))}`);
          }
        }
      }
      const ts = color ? `${pc.dim(formatTime())} ` : "";
      write(`${ts}${parts.join(" ")}`);
    },
  };
};

export const noopLogger: Logger = { log: () => undefined };
