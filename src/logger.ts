import { createColors } from "picocolors";
import type { AnthropicErrorType } from "./errors.js";
import { resolveColorEnabled } from "./tty.js";
import type { LimitObservation } from "./limit-observation.js";
import type { SUBSWITCH_VERSION } from "./version.js";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LoggedUpstreamErrorType = AnthropicErrorType | "overloaded_error" | "other" | "none";

/**
 * The closed field set is the redaction mechanism: nothing that can carry
 * token material or request content is representable here.
 */
export interface LogFields {
  readonly model?: string;
  readonly path?: string;
  readonly route?: string;
  readonly status?: number | null;
  readonly upstreamErrorType?: LoggedUpstreamErrorType;
  readonly latencyMs?: number;
  readonly eventType?: string;
  readonly errorCode?: string;
  readonly effort?: string;
  /** Number of cached input tokens from the Codex backend response.completed usage.
   *  Proves prompt_cache_key is effective. Non-reversible (a count, not content). */
  readonly cachedTokens?: number;
  readonly requestedTokens?: number;
  readonly appliedTokens?: number;
  /** First 8 hex chars of the derived conversation key (the session_id prefix).
   *  Verifies key stability across turns without revealing the full key.
   *  Truncated: non-reversible. */
  readonly sessionKey?: string;
  /** How the request body was handled for routing.
   *  "buffered"  — body fit within the routing window; fully read before dispatch.
   *  "streamed"  — body exceeded the window; prefix sniffed, remainder piped to upstream. */
  readonly bodyMode?: string;
  readonly attemptOrder?: number;
  readonly targetProfile?: string;
  readonly product?: string;
  readonly commitState?: "uncommitted" | "committed";
  readonly quotaWindow?: string;
  readonly observationAgeMs?: number;
  readonly retryEligible?: boolean;
  readonly evidence?: "documented" | "source-inspected" | "live-observed" | "unknown";
  readonly pid?: number;
  readonly signal?: "SIGINT" | "SIGTERM" | "SIGHUP";
  readonly exitCode?: number;
  readonly version?: typeof SUBSWITCH_VERSION;
}

export interface Logger {
  log(level: LogLevel, event: string, fields?: LogFields): void;
  /** Separate private diagnostic artifacts; accepts only the sanitized projection. */
  recordLimit?(observation: LimitObservation): void;
  trackLimitTask?(task: Promise<void>): void;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export const FIELD_KEYS = [
  "model",
  "path",
  "route",
  "status",
  "upstreamErrorType",
  "latencyMs",
  "eventType",
  "errorCode",
  "effort",
  "cachedTokens",
  "requestedTokens",
  "appliedTokens",
  "sessionKey",
  "bodyMode",
  "attemptOrder", "targetProfile", "product", "commitState", "quotaWindow", "observationAgeMs", "retryEligible", "evidence",
  "pid",
  "signal",
  "exitCode",
  "version",
] as const satisfies readonly (keyof LogFields)[];
// Completeness proof lives in test/unit/logger.types.test.ts (module-level type
// proofs follow the *.types.test.ts convention; in-src guards are function-local
// switch exhaustiveness checks only).

/**
 * Render one token's value: control characters stripped, then quoted (with internal
 * escaping) if it could otherwise be mistaken for sibling tokens.
 *
 * This is the single render site for every log field value and event token (ADR-008).
 * No other site strips or escapes — fix here and both paths are covered.
 *
 * Invariant: no C0 control character (U+0000–U+001F), DEL (U+007F), or C1 control
 * character (U+0080–U+009F) reaches the sink. Stripping the full range (not just \r\n)
 * prevents record-forgery via terminal escape sequences: OSC 0 rewrites the window
 * title; cursor-movement + erase sequences overwrite previously printed log lines,
 * defeating anti-forgery without a newline. Quoting prevents field-forgery — a value
 * containing whitespace, `=`, `"`, or `\` would otherwise parse as additional
 * top-level fields under logfmt's last-wins semantics. Embedded `"` and `\` are
 * backslash-escaped so the surrounding quotes cannot be closed by a crafted value.
 * Real values (model ids, route names, event names, status codes) contain none of
 * these characters, so this is a no-op on every log line the tree emits.
 */
export const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

const renderToken = (value: string): string => {
  const safe = value.replace(CONTROL_CHARS, "");
  return /[\s="\\]/.test(safe) ? `"${safe.replace(/["\\]/g, (c) => `\\${c}`)}"` : safe;
};

/** Render the line without a timestamp or color. */
export function renderLogLine(level: LogLevel, event: string, fields?: LogFields): string {
  const parts = [`level=${level}`, `event=${renderToken(event)}`];
  if (fields !== undefined) {
    for (const key of FIELD_KEYS) {
      const value = fields[key];
      if (value !== undefined) parts.push(`${key}=${renderToken(String(value))}`);
    }
  }
  return parts.join(" ");
}

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
      const line = renderLogLine(level, event, fields);
      if (!color) {
        write(line);
        return;
      }
      const token = renderToken(event);
      const prefix = `level=${level} event=${token}`;
      write(`${pc.dim(formatTime())} ${colorLevelStr(level)} event=${pc.bold(token)}${line.slice(prefix.length)}`);
    },
  };
};

export const noopLogger: Logger = { log: () => undefined };
