import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { z } from "zod";
import { abortable } from "./abortable.js";
import type { registerExactCredential, ProxyError } from "./errors.js";
import { GEMINI_KEYCHAIN_ACCOUNT, GEMINI_KEYCHAIN_SERVICE } from "./gemini-constants.js";
import { GEMINI_ERRORS, toGeminiProxyError, type GeminiAccountBlockLatch, type GeminiErrorCode } from "./gemini-errors.js";
import { keychainReadErrors, type createKeychainReader, type KeychainReadError } from "./keychain-read.js";
import type { Logger } from "./logger.js";
import type { ProviderAuth, ProviderCredential } from "./provider-auth.js";
import { err, ok, type Result } from "./result.js";

const ITEM = { service: GEMINI_KEYCHAIN_SERVICE, account: GEMINI_KEYCHAIN_ACCOUNT };
const PREFIX = "go-keyring-base64:";
const PROBE_INTERVAL_MS = 60_000;
const MAX_ACCESS_LENGTH = 8192;
const REFUSED_LIMIT = 16;
const BEARER_VALUE = /^[A-Za-z0-9._~+/-]+=*$/;
const RFC3339 = /^(\d{4}-\d{2}-\d{2})[Tt](\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(?:[Zz]|([+-])([01]\d|2[0-3]):([0-5]\d))$/;
const RecordSchema = z.object({ token: z.object({
  access_token: z.string().min(1).max(MAX_ACCESS_LENGTH).regex(BEARER_VALUE),
  refresh_token: z.string().min(1),
  expiry: z.string().max(35),
}) });

interface Snapshot {
  readonly access: string;
  readonly expiresAtMs: number;
}

type SignInResult = Result<Snapshot, GeminiErrorCode>;

export interface GeminiAuthDeps {
  readonly reader: ReturnType<typeof createKeychainReader>;
  readonly now: () => number;
  readonly register: (source: "gemini", access: string, refresh: string) => ReturnType<typeof registerExactCredential>;
  readonly accountBlock: GeminiAccountBlockLatch;
  readonly logger: Logger;
}

const expiryMs = (value: string): number | undefined => {
  const match = RFC3339.exec(value);
  if (match === null) return undefined;
  const [, day, time, fraction = "", sign, hours = "0", minutes = "0"] = match;
  // Treat the wall time as UTC for the round trip. Apply the offset only after that check.
  const iso = `${day}T${time}.000Z`;
  const wallMs = Date.parse(iso);
  if (!Number.isFinite(wallMs) || new Date(wallMs).toISOString() !== iso) return undefined;
  const offsetMs = (Number(hours) * 60 + Number(minutes)) * 60_000;
  // The clock counts whole milliseconds. Expire at its first tick at or after the instant.
  const fractionMs = Math.ceil(Number(fraction.padEnd(9, "0")) / 1_000_000);
  return wallMs + (sign === "-" ? offsetMs : -offsetMs) + fractionMs;
};

const parseRecord = (value: string, register: GeminiAuthDeps["register"]): SignInResult => {
  if (!value.startsWith(PREFIX)) return err("invalid_record");
  const encoded = value.slice(PREFIX.length);
  const decoded = Buffer.from(encoded, "base64");
  // Buffer also decodes missing padding, alternate alphabets and malformed input.
  if (decoded.toString("base64") !== encoded || !isUtf8(decoded)) return err("invalid_record");
  let json: unknown;
  try {
    json = JSON.parse(decoded.toString("utf8"));
  } catch {
    return err("invalid_record");
  }
  const parsed = RecordSchema.safeParse(json);
  if (!parsed.success) return err("invalid_record");
  const { access_token: access, refresh_token: refresh, expiry } = parsed.data.token;
  const expiresAtMs = expiryMs(expiry);
  if (expiresAtMs === undefined) return err("invalid_record");
  if (!register("gemini", access, refresh)) return err("invalid_record");
  return ok({ access, expiresAtMs });
};

const fingerprint = (value: string): string => createHash("sha256").update(value).digest("hex");

/** Read one account. A 401 allows a re-read, not renewal or a write to Keychain. */
export const createGeminiAuth = ({ reader, now, register, accountBlock, logger }: GeminiAuthDeps): ProviderAuth<"gemini"> => {
  let cached: SignInResult | undefined;
  let modifiedAt: number | undefined;
  let nextProbeAt = -Infinity;
  let readLatch: KeychainReadError | undefined;
  const refused = new Set<string>();
  let flight: { readonly forced: boolean; readonly result: Promise<SignInResult> } | undefined;

  const blockedCode = (): GeminiErrorCode | undefined => accountBlock.isBlocked() ? "account_blocked" : readLatch;
  const failedRead = (code: KeychainReadError): SignInResult => {
    modifiedAt = undefined;
    if (keychainReadErrors[code].latchUntilRestart) readLatch = code;
    cached = err(code);
    return cached;
  };
  const rememberRefusal = (digest: string): void => {
    refused.delete(digest);
    refused.add(digest);
    const oldest = refused.values().next();
    if (refused.size > REFUSED_LIMIT && !oldest.done) refused.delete(oldest.value);
  };

  const load = async (forced: boolean): Promise<SignInResult> => {
    const initialBlock = blockedCode();
    if (initialBlock !== undefined) return err(initialBlock);
    if (forced || now() >= nextProbeAt) {
      nextProbeAt = now() + PROBE_INTERVAL_MS;
      const probe = await reader.probe(ITEM);
      if (!probe.ok) return failedRead(probe.error);
      if (modifiedAt !== probe.value.modifiedAtMs) cached = undefined;
      modifiedAt = probe.value.modifiedAtMs;
    }
    if (accountBlock.isBlocked()) return err("account_blocked");
    if (!forced && cached !== undefined && (!cached.ok || cached.value.expiresAtMs > now())) return cached;
    const secret = await reader.readSecret(ITEM);
    if (!secret.ok) return failedRead(secret.error);
    if (accountBlock.isBlocked()) return err("account_blocked");
    const parsed = parseRecord(secret.value, register);
    cached = parsed.ok && (parsed.value.expiresAtMs <= now() || refused.has(fingerprint(parsed.value.access)))
      ? err("sign_in_again") : parsed;
    return cached;
  };

  const singleFlight = (forced: boolean): Promise<SignInResult> => {
    const previous = flight;
    if (previous !== undefined && (!forced || previous.forced)) return previous.result;
    // A 401 must cause a new probe and read. If an ordinary load is active, queue one forced load.
    const result = Promise.resolve(previous?.result).then(() => load(forced)).catch(() => failedRead("exec_failed")).finally(() => {
      if (flight?.result === result) flight = undefined;
    });
    flight = { forced, result };
    return result;
  };

  const failure = (code: GeminiErrorCode): Result<never, ProxyError> => {
    logger.log("warn", GEMINI_ERRORS[code].event, { errorCode: code });
    return err(toGeminiProxyError(code));
  };

  const get = async (
    signal: AbortSignal | undefined, forced: boolean, failed?: ProviderCredential<"gemini">,
  ): Promise<Result<ProviderCredential<"gemini">, ProxyError>> => {
    if (signal?.aborted) return failure("cancelled");
    const initialBlock = blockedCode();
    if (initialBlock !== undefined) return failure(initialBlock);
    const auth = failed?.authHeaders["authorization"];
    const callerRefused = auth?.startsWith("Bearer ") ? fingerprint(auth.slice(7)) : undefined;
    if (callerRefused !== undefined) rememberRefusal(callerRefused);
    const pending = singleFlight(forced);
    let loaded: SignInResult;
    try {
      loaded = await (signal === undefined ? pending : abortable(pending, signal));
    } catch {
      return failure(signal?.aborted ? "cancelled" : "exec_failed");
    }
    if (signal?.aborted) return failure("cancelled");
    const finalBlock = blockedCode();
    if (finalBlock !== undefined) return failure(finalBlock);
    if (!loaded.ok) return failure(loaded.error);
    const { access, expiresAtMs } = loaded.value;
    const digest = fingerprint(access);
    if (expiresAtMs <= now() || refused.has(digest) || digest === callerRefused) return failure("sign_in_again");
    return ok({ provider: "gemini", authHeaders: { authorization: `Bearer ${access}` } });
  };

  return {
    refreshable: true,
    getCredentials: (signal) => get(signal, false),
    forceRefresh: (signal, failed) => get(signal, true, failed),
  };
};
