import { createConsoleLogger, renderLogLine, type LogFields, type Logger, type LogLevel } from "./logger.js";
import { appendPrivateLineSync, appendRotatingPrivateFile, type PrivateFileRotation } from "./private-file.js";

const RELAY_LOG = { stem: "relay", extension: "log" } as const;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_QUEUED_BYTES = 256 * 1024;
const FILE_COUNT = 4;
const REFUSAL_WINDOW_MS = 60_000;
const MAX_REFUSAL_LINES = 8;
const MAX_SUPPRESSED_REFUSAL_LINES = Number.MAX_SAFE_INTEGER;

const isRefusalLine = (event: string, fields?: LogFields): boolean =>
  event === "host_rejected" || (fields?.route === "host_rejected" &&
    (event === "request_complete" || event === "client_disconnected"));

const isoLine = (line: string): string => `${new Date().toISOString()} ${line}\n`;

export interface RelayLogOptions {
  readonly directory: string;
  readonly mode: "foreground" | "detach";
  readonly minLevel: LogLevel;
  readonly console?: Logger;
  readonly writeStderr?: (line: string) => void;
  readonly append?: (target: PrivateFileRotation, batch: string) => Promise<void>;
  /** Monotonic time in milliseconds. */
  readonly now?: () => number;
}

export interface RelayLogger {
  readonly logger: Logger;
  readonly flush: () => Promise<void>;
}

export type RelayStopFields = Required<Pick<LogFields, "pid" | "exitCode">> & Pick<LogFields, "signal">;

export function createRelayLogger(options: RelayLogOptions): RelayLogger {
  const target = { ...RELAY_LOG, directory: options.directory, maxBytes: MAX_FILE_BYTES, fileCount: FILE_COUNT };
  const append = options.append ?? appendRotatingPrivateFile;
  const writeStderr = options.writeStderr ?? ((line) => process.stderr.write(line));
  const now = options.now ?? (() => performance.now());
  const console = options.mode === "foreground"
    ? options.console ?? createConsoleLogger(options.minLevel)
    : undefined;
  let pending = Promise.resolve();
  let lines: string[] = [];
  let queuedBytes = 0;
  let drops = 0;
  let warned = false;
  let refusalWindowEnd: number | undefined;
  let refusalLines = 0;
  let suppressedRefusalLines = 0;

  const warnOnce = (): void => {
    if (warned) return;
    warned = true;
    try {
      writeStderr("subswitch: relay log unavailable\n");
    } catch {
      // Diagnostics must not interrupt the relay.
    }
  };

  const drain = async (): Promise<void> => {
    const batch = lines;
    const dropped = drops;
    lines = [];
    queuedBytes = 0;
    drops = 0;
    try {
      const notice = dropped === 0 ? "" : isoLine(`${renderLogLine("warn", "log_lines_dropped")} count=${dropped}`);
      await append(target, notice + batch.join(""));
    } catch {
      drops += dropped + batch.length;
      warnOnce();
    }
  };

  const enqueue = (text: string): void => {
    const line = isoLine(text);
    const bytes = Buffer.byteLength(line);
    if (queuedBytes + bytes > MAX_QUEUED_BYTES) {
      drops++;
      return;
    }
    if (lines.length === 0) pending = pending.then(drain);
    lines.push(line);
    queuedBytes += bytes;
  };

  // Report the prior window on the next log call, without a timer.
  const expireRefusalWindow = (): void => {
    if (refusalWindowEnd === undefined || now() < refusalWindowEnd) return;
    if (suppressedRefusalLines > 0) {
      enqueue(`${renderLogLine("warn", "host_refusal_lines_dropped")} count=${suppressedRefusalLines}`);
    }
    refusalWindowEnd = undefined;
    refusalLines = 0;
    suppressedRefusalLines = 0;
  };

  const file = createConsoleLogger(options.minLevel, enqueue, false);
  const refusalFile = createConsoleLogger(options.minLevel, (text) => {
    refusalWindowEnd ??= now() + REFUSAL_WINDOW_MS;
    if (refusalLines >= MAX_REFUSAL_LINES) {
      suppressedRefusalLines = Math.min(suppressedRefusalLines + 1, MAX_SUPPRESSED_REFUSAL_LINES);
      return;
    }
    refusalLines++;
    enqueue(text);
  }, false);

  return {
    logger: {
      log(level, event, fields) {
        try {
          expireRefusalWindow();
          const sink = isRefusalLine(event, fields) ? refusalFile : file;
          sink.log(level, event, fields);
        } catch {
          warnOnce();
        }
        try {
          console?.log(level, event, fields);
        } catch {
          // The file sink stays available if stderr fails.
        }
      },
    },
    flush: () => pending,
  };
}

export function writeStopLineSync(directory: string | undefined, fields: RelayStopFields, copyToStderr = false): void {
  try {
    const { pid, exitCode, signal } = fields;
    const line = isoLine(renderLogLine("info", "relay_stopped", { pid, exitCode, ...(signal === undefined ? {} : { signal }) }));
    if (directory !== undefined) appendPrivateLineSync({ ...RELAY_LOG, directory }, line);
    if (copyToStderr) process.stderr.write(line);
  } catch {
    // The exit path is best effort.
  }
}

export function writeFatalLineSync(directory: string, pid: number): void {
  try {
    appendPrivateLineSync({ ...RELAY_LOG, directory }, isoLine(renderLogLine("error", "relay_fatal", { pid })));
  } catch {
    // The exit path is best effort.
  }
}
