import type { ProviderAuth } from "./provider-auth.js";
import type { ProxyError } from "./errors.js";
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
  readonly onKeyLoaded?: (key: string) => void;
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

  const remember = (result: TogetherKeyResult): TogetherKeyResult => {
    if (result.ok) {
      deps.onKeyLoaded?.(result.value.key);
      cached = result.value;
    }
    return result;
  };

  const beginRead = (): SharedRead => {
    const controller = new AbortController();
    const result = runKeychain(deps, controller, true).then<TogetherKeyResult>((output) => {
      if (pending?.controller !== controller) return err("missing");
      pending = undefined;
      if (controller.signal.aborted || output === undefined) return err("missing");
      return remember(parseKey(output.stdout, "keychain"));
    });
    return { controller, result, waiters: 0 };
  };

  const readKey = async (signal: AbortSignal): Promise<TogetherKeyResult> => {
    if (signal.aborted) return err("aborted");
    if (cached !== undefined) return ok(cached);
    if (pending === undefined) {
      const raw = deps.env[TOGETHER_API_KEY_ENV];
      if (raw !== undefined) {
        return remember(parseKey(raw, "env"));
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

const togetherKeyHint = `Set ${TOGETHER_API_KEY_ENV} or add the macOS Keychain item "${TOGETHER_KEYCHAIN_SERVICE}".`;

/** The reader looks in the Keychain on macOS only, so other platforms get the env var hint alone. */
export const togetherKeyHintFor = (platform: NodeJS.Platform): string =>
  platform === "darwin" ? togetherKeyHint : `Set ${TOGETHER_API_KEY_ENV} (environment variable only on this platform).`;

export const createTogetherAuth = (reader: ReturnType<typeof createTogetherKeyReader>): ProviderAuth<"together"> => ({
  refreshable: false,
  getCredentials: async (signal = new AbortController().signal) => {
    const result = await reader.readKey(signal);
    if (result.ok) return ok({ provider: "together", authHeaders: { authorization: `Bearer ${result.value.key}` } });
    if (result.error === "aborted") return err({ kind: "timeout", message: "Together request timed out" });
    const reason = result.error === "malformed" ? "Together key is malformed." : "Together key is missing.";
    return err({ kind: "auth", message: `${reason} ${togetherKeyHint}` });
  },
  forceRefresh: async () => err<ProxyError>({ kind: "auth", message: `Together uses a static key. ${togetherKeyHint}` }),
});
