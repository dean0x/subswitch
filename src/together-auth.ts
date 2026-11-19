import { abortable } from "./abortable.js";
import { err, ok, type Result } from "./result.js";

export const TOGETHER_API_KEY_ENV = "TOGETHER_API_KEY";
export const TOGETHER_KEYCHAIN_SERVICE = "Subswitch Together API key";
export const TOGETHER_KEYCHAIN_ACCOUNT = "subswitch";
const SECURITY_PATH = "/usr/bin/security";
const KEYCHAIN_TIMEOUT_MS = 10_000;
const KEYCHAIN_MAX_BYTES = 8 * 1024;

interface KeychainExecOptions {
  readonly env: { readonly HOME?: string };
  readonly timeout: number;
  readonly maxBuffer: number;
  readonly encoding: "utf8";
  readonly killSignal: "SIGKILL";
  readonly signal: AbortSignal;
}

export interface TogetherKeyReaderDeps {
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly platform: NodeJS.Platform;
  /** Use execFile semantics: reject on any failed exit. */
  readonly exec: (file: string, args: string[], options: KeychainExecOptions) => Promise<{ stdout: string }>;
  /** Start a one-shot timer and return its cancel function. */
  readonly setTimer: (expire: () => void, delayMs: number) => () => void;
}

type KeySource = "env" | "keychain";
type TogetherKey = { readonly key: string; readonly source: KeySource };
type TogetherKeyResult = Result<TogetherKey, "missing" | "malformed" | "aborted">;

const parseKey = (raw: string, source: KeySource): TogetherKeyResult => {
  const key = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  if (key.length < 16 || key.length > 512 || /[^\x21-\x7E]/.test(key)) return err("malformed");
  return ok({ key, source });
};

export const envKeyPresent = (env: Readonly<NodeJS.ProcessEnv>): boolean => {
  const raw = env[TOGETHER_API_KEY_ENV];
  return raw !== undefined && parseKey(raw, "env").ok;
};

const runKeychain = async (
  deps: TogetherKeyReaderDeps, controller: AbortController, readValue: boolean,
): Promise<{ stdout: string } | undefined> => {
  const args = ["find-generic-password", "-s", TOGETHER_KEYCHAIN_SERVICE, "-a", TOGETHER_KEYCHAIN_ACCOUNT];
  if (readValue) args.push("-w");
  const { signal } = controller;
  const cancelTimer = deps.setTimer(() => controller.abort(), KEYCHAIN_TIMEOUT_MS);
  try {
    const result = await abortable(deps.exec(SECURITY_PATH, args, {
      env: deps.env.HOME === undefined ? {} : { HOME: deps.env.HOME },
      timeout: KEYCHAIN_TIMEOUT_MS,
      maxBuffer: KEYCHAIN_MAX_BYTES,
      encoding: "utf8",
      killSignal: "SIGKILL",
      signal,
    }), signal);
    return signal.aborted ? undefined : result;
  } catch {
    // An exec error can contain the key in stdout or in the error text.
    return undefined;
  } finally {
    cancelTimer();
  }
};

interface SharedRead {
  readonly controller: AbortController;
  readonly result: Promise<TogetherKeyResult>;
  waiters: number;
}

export const createTogetherKeyReader = (deps: TogetherKeyReaderDeps) => {
  let cached: TogetherKey | undefined;
  let pending: SharedRead | undefined;

  const beginRead = (): SharedRead => {
    const controller = new AbortController();
    const result = runKeychain(deps, controller, true).then<TogetherKeyResult>((output) => {
      if (pending?.controller !== controller) return err("missing");
      pending = undefined;
      if (controller.signal.aborted || output === undefined) return err("missing");
      const key = parseKey(output.stdout, "keychain");
      if (key.ok) cached = key.value;
      return key;
    });
    return { controller, result, waiters: 0 };
  };

  const readKey = async (signal: AbortSignal): Promise<TogetherKeyResult> => {
    if (signal.aborted) return err("aborted");
    if (cached !== undefined) return ok(cached);
    if (pending === undefined) {
      const raw = deps.env[TOGETHER_API_KEY_ENV];
      if (raw !== undefined) {
        const key = parseKey(raw, "env");
        if (key.ok) cached = key.value;
        return key;
      }
      if (deps.platform !== "darwin") return err("missing");
      pending = beginRead();
    }
    const read = pending;
    read.waiters++;
    try {
      return await abortable(read.result, signal);
    } catch {
      return err("aborted");
    } finally {
      read.waiters--;
      if (read.waiters === 0 && pending === read) {
        pending = undefined;
        read.controller.abort();
      }
    }
  };

  const keychainItemExists = async (): Promise<boolean> => {
    if (deps.platform !== "darwin") return false;
    return (await runKeychain(deps, new AbortController(), false)) !== undefined;
  };

  return { readKey, keychainItemExists };
};
