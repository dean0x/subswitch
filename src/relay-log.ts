import { createConsoleLogger, renderLogLine, type LogFields, type Logger, type LogLevel } from "./logger.js";
import { appendPrivateLineSync, appendRotatingPrivateFile, type PrivateFileRotation } from "./private-file.js";

const RELAY_LOG = { stem: "relay", extension: "log" } as const;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_QUEUED_BYTES = 256 * 1024;
const FILE_COUNT = 4;

const isoLine = (line: string): string => `${new Date().toISOString()} ${line}\n`;

export interface RelayLogOptions {
  readonly directory: string;
  readonly mode: "foreground" | "detach";
  readonly minLevel: LogLevel;
  readonly console?: Logger;
  readonly writeStderr?: (line: string) => void;
  readonly append?: (target: PrivateFileRotation, batch: string) => Promise<void>;
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
  const console = options.mode === "foreground"
    ? options.console ?? createConsoleLogger(options.minLevel)
    : undefined;
  let pending = Promise.resolve();
  let lines: string[] = [];
  let queuedBytes = 0;
  let drops = 0;
  let warned = false;

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

  const file = createConsoleLogger(options.minLevel, (text) => {
    const line = isoLine(text);
    const bytes = Buffer.byteLength(line);
    if (queuedBytes + bytes > MAX_QUEUED_BYTES) {
      drops++;
      return;
    }
    if (lines.length === 0) pending = pending.then(drain);
    lines.push(line);
    queuedBytes += bytes;
  }, false);

  return {
    logger: {
      log(level, event, fields) {
        try {
          file.log(level, event, fields);
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
