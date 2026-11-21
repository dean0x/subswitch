import { abortable } from "./abortable.js";
import { err, ok, type Result } from "./result.js";

const SECURITY_PATH = "/usr/bin/security";
const KEYCHAIN_TIMEOUT_MS = 10_000;
const KEYCHAIN_MAX_BYTES = 64 * 1024;

export interface KeychainItem {
  readonly service: string;
  readonly account: string;
}

type FindArgs = readonly ["find-generic-password", "-s", string, "-a", string];
type KeychainArgs = readonly [...FindArgs, string] | readonly [...FindArgs, "-w", string];

interface KeychainExecOptions {
  readonly env: { readonly HOME?: string };
  readonly encoding: "utf8";
  readonly shell: false;
  readonly timeout: number;
  readonly maxBuffer: number;
  readonly killSignal: "SIGKILL";
  readonly signal: AbortSignal;
}

export interface KeychainReaderDeps {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly loginKeychainPath: string;
  /** Use execFile semantics: reject on any failed exit. */
  readonly exec: (
    file: typeof SECURITY_PATH, args: KeychainArgs, options: KeychainExecOptions,
  ) => Promise<{ readonly stdout: string }>;
  /** Start a one-shot timer and return its cancel function. */
  readonly setTimer: (expire: () => void, delayMs: number) => () => void;
}

export const keychainReadErrors = {
  missing: { latchUntilRestart: false },
  denied: { latchUntilRestart: true },
  timeout: { latchUntilRestart: true },
  output_too_large: { latchUntilRestart: false },
  malformed: { latchUntilRestart: false },
  unsupported_platform: { latchUntilRestart: false },
  exec_failed: { latchUntilRestart: true },
} as const;

export type KeychainReadError = keyof typeof keychainReadErrors;
type KeychainResult<T> = Result<T, KeychainReadError>;

const classifyExecError = (cause: unknown): KeychainReadError => {
  if (typeof cause !== "object" || cause === null) return "exec_failed";
  if ("signal" in cause && cause.signal != null) return "exec_failed";
  if (!("code" in cause)) return "exec_failed";
  // The four numeric statuses are OSStatus low bytes (reported, not live).
  switch (cause.code) {
    case 44: return "missing";
    case 128: // User canceled.
    case 36: // Interaction not allowed.
    case 51: return "denied"; // Authorization failed.
    case "ERR_CHILD_PROCESS_STDIO_MAXBUFFER": return "output_too_large";
    default: return "exec_failed";
  }
};

const parseSecret = (stdout: string): KeychainResult<string> => {
  const value = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
  if (value.trim().length === 0 || /[\x00-\x1f\x7f]/.test(value)) return err("malformed");
  return ok(value);
};

const parseModificationTime = (stdout: string): KeychainResult<{ readonly modifiedAtMs: number }> => {
  const fields = stdout.split("\n").filter((line) => /^[ \t]*"mdat"/.test(line));
  if (fields.length !== 1) return err("malformed");
  const match = /^[ \t]*"mdat"<timedate>=0x([0-9a-fA-F]{32})[ \t]+"([0-9]{14}Z)\\000"[ \t]*$/.exec(fields[0] ?? "");
  const hex = match?.[1];
  const date = match?.[2];
  if (hex === undefined || date === undefined || Buffer.from(hex, "hex").toString("latin1") !== `${date}\0`) {
    return err("malformed");
  }
  const iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`
    + `T${date.slice(8, 10)}:${date.slice(10, 12)}:${date.slice(12, 14)}.000Z`;
  const modifiedAtMs = Date.parse(iso);
  // Date.parse accepts some invalid dates and moves them into the next month.
  if (!Number.isFinite(modifiedAtMs) || new Date(modifiedAtMs).toISOString() !== iso) return err("malformed");
  return ok({ modifiedAtMs });
};

// A selector must name an item. Keep option and command names out of both argument slots.
const isItemName = (value: string): boolean => value.trim().length > 0
  && !/^(?:-|(?:add|delete)(?:-|$))|[\x00-\x1f\x7f]/.test(value);

export const createKeychainReader = (deps: KeychainReaderDeps) => {
  const run = async <T>(
    item: KeychainItem, reveal: boolean, parse: (stdout: string) => KeychainResult<T>,
  ): Promise<KeychainResult<T>> => {
    if (deps.platform !== "darwin") return err("unsupported_platform");
    const path = deps.loginKeychainPath;
    const { service, account } = item;
    if (!path.startsWith("/") || !isItemName(service) || !isItemName(account)) return err("malformed");
    const find: FindArgs = ["find-generic-password", "-s", service, "-a", account];
    const args: KeychainArgs = reveal ? [...find, "-w", path] : [...find, path];
    const controller = new AbortController();
    const { signal } = controller;
    // Use our own deadline to tell a timeout from an unrelated signal end.
    const cancelTimer = deps.setTimer(() => controller.abort(), KEYCHAIN_TIMEOUT_MS);
    try {
      const { stdout } = await abortable(deps.exec(SECURITY_PATH, args, {
        env: deps.env.HOME === undefined ? {} : { HOME: deps.env.HOME },
        encoding: "utf8", shell: false, timeout: KEYCHAIN_TIMEOUT_MS, maxBuffer: KEYCHAIN_MAX_BYTES,
        killSignal: "SIGKILL", signal,
      }), signal);
      if (Buffer.byteLength(stdout, "utf8") > KEYCHAIN_MAX_BYTES) return err("output_too_large");
      return parse(stdout);
    } catch (cause) {
      // Never pass on the exec error. It can include process output.
      return err(signal.aborted ? "timeout" : classifyExecError(cause));
    } finally {
      cancelTimer();
    }
  };

  return {
    readSecret: (item: KeychainItem) => run(item, true, parseSecret),
    probe: (item: KeychainItem) => run(item, false, parseModificationTime),
  };
};
