/**
 * The Kimi sign-in of the Kimi leg: the Kimi CLI file, renewed when due or once after a 401.
 *
 * Subswitch reads the Kimi CLI sign-in file. It renews the sign-in when the CLI does (less
 * than max(300 s, expires_in / 2) of life is left), and once for each access token that
 * Kimi refused. Each renewal runs under the Kimi CLI lock and under a 20 s deadline of its
 * own. The renewal marker is written as prepared, then as pending, before the token
 * request, and the new record is written back atomically with every key of the file.
 *
 * A renewal whose request may have reached Kimi is never sent again, because Kimi can have
 * rotated the grant. Only a connect failure that proves that no request left, a 429, or a
 * refused client gives a backoff, after which a new request can go.
 *
 * A caller signal ends only the wait of that caller. The token request, the body read and
 * the write-back run to their end under the renewal deadline, so a sent renewal is saved.
 *
 * Each failure is one code of the closed Kimi table. The manager logs the event of that
 * code with the code only, and replies with the fixed text of the code.
 */
import { randomUUID } from "node:crypto";
import { abortable } from "./abortable.js";
import { registerExactCredential, type ProxyError } from "./errors.js";
import { KIMI_OAUTH_CLIENT_ID, kimiIdentityHeaders } from "./kimi-constants.js";
import { KIMI_ERRORS, kimiErrorCodeOf, toKimiProxyError, type KimiErrorCode } from "./kimi-errors.js";
import { kimiFingerprint, type KimiLease, type KimiNativeStore, type KimiSnapshot, type KimiTokenRecord } from "./kimi-native-store.js";
import type { LogLevel, Logger } from "./logger.js";
import { coordinateNativeRefresh } from "./native-auth-coordination.js";
import { isPlainObject } from "./plain-object.js";
import type { ProviderAuth, ProviderCredential } from "./provider-auth.js";
import { KIMI_EVENTS } from "./provider-events.js";
import { readBoundedBody, type BoundedText } from "./provider-transport.js";
import { err, ok, type Result } from "./result.js";

/** One renewal: the lock wait, the token request, the body read and the write-back. */
const RENEWAL_DEADLINE_MS = 20_000;
/** The longest wait of one caller for a credential, above the renewal deadline. */
const WAIT_DEADLINE_MS = 25_000;
/** A bearer is usable only while more than this is left of its life. */
const USABLE_MARGIN_MS = 30_000;
/** A prepared marker blocks a new renewal of its grant for this long. */
const PREPARED_HOLD_MS = 30_000;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_CAP_MS = 300_000;
/** The store keeps at most this failure count in a marker. */
const MAX_FAILURES = 5;
const TOKEN_REPLY_MAX_BYTES = 16 * 1024;
/** The manager keeps at most this many refused access tokens, the latest ones. */
const REFUSED_LIMIT = 16;
const TOKEN = /^[!-~]{1,8192}$/;
const MAX_LIFE_SECONDS = 86_400 * 365;
const MIN_LIFE_SECONDS = 30;
const MAX_SCOPE_LENGTH = 8192;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
/** Fetch failure codes that prove that no request left: the name lookup or the connect failed. */
const NOT_SENT_CODES: ReadonlySet<string> = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "UND_ERR_CONNECT_TIMEOUT"]);
/**
 * Renewal failures after which a due bearer that is still valid can serve the request.
 * None of them shows that the sign-in ended.
 */
const KEEP_VALID_BEARER: ReadonlySet<KimiErrorCode> = new Set<KimiErrorCode>([
  "lock_busy", "refresh_busy", "refresh_unavailable", "refresh_recovery_required", "timeout",
]);

export interface KimiAuthDeps {
  readonly store: KimiNativeStore;
  /** The token URL of the Kimi config block, vetted at load and at startup. */
  readonly oauthTokenUrl: string;
  readonly fetch: typeof fetch;
  readonly now: () => number;
  readonly logger: Logger;
  /** A signal that aborts after `ms`. Production gives none and gets AbortSignal.timeout. */
  readonly deadline?: (ms: number) => AbortSignal;
}

export interface KimiAuth extends ProviderAuth<"kimi"> {
  /** The random device id of this manager in the Kimi identity headers. */
  readonly deviceId: string;
}

type Renewal = Result<KimiSnapshot, KimiErrorCode>;

/** The fingerprint of an access token, so the manager holds no refused token text. */
const accessOf = (record: KimiTokenRecord): string => kimiFingerprint(record.access_token);

/** The grant of a record, as the renewal marker names it. */
export const kimiGrantOf = (record: KimiTokenRecord): string =>
  kimiFingerprint(JSON.stringify([record.access_token, record.refresh_token, record.expires_at]));

/** The Kimi CLI renews when less than max(300 s, expires_in / 2) of life is left. */
export const kimiRenewalDue = (record: KimiTokenRecord, nowMs: number): boolean =>
  record.expires_at * 1000 <= nowMs + Math.max(300, record.expires_in / 2) * 1000;

/** True only for a fetch failure whose cause shows that the request did not leave. */
const provedNotSent = (error: unknown): boolean => {
  if (!(error instanceof TypeError) || !(error.cause instanceof Error) || !("code" in error.cause)) return false;
  const { code } = error.cause;
  return typeof code === "string" && NOT_SENT_CODES.has(code);
};

/** The token reply as a plain object, or undefined. The parse error quotes the reply, so it is dropped. */
const parseReply = (text: string): Readonly<Record<string, unknown>> | undefined => {
  try {
    const value: unknown = JSON.parse(text);
    return isPlainObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
};

/** The record after a token reply, with every other key of `current`, or undefined for a reply that Subswitch can not use. */
const renewedRecord = (current: KimiTokenRecord, reply: Readonly<Record<string, unknown>>, nowMs: number): KimiTokenRecord | undefined => {
  const { access_token: access, refresh_token: refresh = current.refresh_token, expires_in: life, token_type: type, scope } = reply;
  if (typeof access !== "string" || !TOKEN.test(access) || typeof refresh !== "string" || !TOKEN.test(refresh)) return undefined;
  if (typeof life !== "number" || !Number.isSafeInteger(life) || life <= MIN_LIFE_SECONDS || life > MAX_LIFE_SECONDS) return undefined;
  // The OAuth token type is not case sensitive. Subswitch writes it as the Kimi CLI reads it.
  if (type !== undefined && (typeof type !== "string" || type.toLowerCase() !== "bearer")) return undefined;
  if (scope !== undefined && (typeof scope !== "string" || scope.length > MAX_SCOPE_LENGTH || CONTROL_CHARACTER.test(scope))) return undefined;
  return {
    ...current, access_token: access, refresh_token: refresh, expires_at: Math.floor(nowMs / 1000) + life,
    expires_in: life, token_type: "Bearer", ...(scope === undefined ? {} : { scope }),
  };
};

/** The token of a Kimi bearer credential, or undefined when the credential has none. */
const bearerToken = (credential: ProviderCredential<"kimi">): string | undefined => {
  const header = credential.authHeaders["authorization"];
  return header?.startsWith("Bearer ") && header.length > "Bearer ".length ? header.slice("Bearer ".length) : undefined;
};

const levelOf = (code: KimiErrorCode): LogLevel => {
  if (code === "cancelled") return "info";
  return KIMI_ERRORS[code].kind === "auth" ? "error" : "warn";
};

/**
 * The Kimi sign-in manager of one Kimi CLI sign-in file. It holds no token text: only the
 * fingerprints of the access tokens that Kimi refused.
 */
export const createKimiAuth = (deps: KimiAuthDeps): KimiAuth => {
  const { store, logger } = deps;
  const deadline = deps.deadline ?? ((ms: number) => AbortSignal.timeout(ms));
  const deviceId = randomUUID();
  const refused = new Set<string>();

  const refuse = (access: string): void => {
    refused.delete(access);
    refused.add(access);
    for (const oldest of refused) {
      if (refused.size <= REFUSED_LIMIT) break;
      refused.delete(oldest);
    }
  };

  const usable = (record: KimiTokenRecord): boolean =>
    record.expires_at * 1000 > deps.now() + USABLE_MARGIN_MS && !refused.has(accessOf(record));

  /** Log the fixed event of `code` with the code only, and give the fixed reply of `code`. */
  const failure = (code: KimiErrorCode): Result<never, ProxyError> => {
    logger.log(levelOf(code), KIMI_ERRORS[code].event, { errorCode: code });
    return err(toKimiProxyError(code));
  };

  /** One renewal under the lock. The lease signal aborts at the renewal deadline or when the lock is lost. */
  const renewUnderLock = async (lease: KimiLease, renewal: AbortSignal, refusedAccess: string | undefined,
    progress: { sent: boolean }): Promise<Renewal> => {
    const { signal } = lease;
    const lockLost = (): boolean => signal.aborted && !renewal.aborted;
    const current = await lease.read();
    if (!kimiRenewalDue(current.record, deps.now()) && accessOf(current.record) !== refusedAccess) return ok(current);
    const grant = kimiGrantOf(current.record);
    const prior = await lease.readMarker();
    const same = prior !== undefined && prior.grant === grant ? prior : undefined;
    if (same?.outcome === "denied") return err("reauthorization_required");
    if (same?.outcome === "pending") return err("refresh_recovery_required");
    if (same !== undefined && same.retryAt > deps.now()) return err("refresh_busy");
    const failures = same === undefined ? 1 : Math.min(same.failures + 1, MAX_FAILURES);
    const backoff = (): Promise<void> => lease.writeMarker(grant, "busy",
      deps.now() + Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (failures - 1)), failures);
    // The marker goes to disk before the request. After a restart, a lost reply or a lost
    // lock, the pending marker stops a second send of a grant that Kimi may have rotated.
    await lease.writeMarker(grant, "prepared", deps.now() + PREPARED_HOLD_MS, failures);
    await lease.verify();
    await lease.writeMarker(grant, "pending", 0, failures);
    await lease.verify();
    signal.throwIfAborted();
    progress.sent = true;
    let response: Response;
    try {
      response = await abortable(deps.fetch(deps.oauthTokenUrl, {
        method: "POST",
        redirect: "error",
        signal,
        headers: { ...kimiIdentityHeaders(deviceId), "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({ client_id: KIMI_OAUTH_CLIENT_ID, grant_type: "refresh_token", refresh_token: current.record.refresh_token }),
      }), signal);
    } catch (error) {
      if (lockLost()) return err("lock_lost");
      if (!provedNotSent(error)) return err("refresh_recovery_required");
      await backoff();
      return err("refresh_unavailable");
    }
    // The 429 status alone proves the cooldown, so it is saved before a slow body can use up the deadline.
    if (response.status === 429) await backoff();
    let body: BoundedText;
    try {
      body = await readBoundedBody(response.body, TOKEN_REPLY_MAX_BYTES, signal);
      // An abort can end the body read as if the body were complete.
      signal.throwIfAborted();
    } catch {
      if (lockLost()) return err("lock_lost");
      return err(response.status === 429 ? "refresh_busy" : "refresh_recovery_required");
    }
    const whole = body.complete && !body.truncated;
    const reply = parseReply(body.text);
    // The Kimi CLI rotated the sign-in during the request: use its record and never overwrite it.
    const observed = await lease.read();
    if (kimiGrantOf(observed.record) !== grant) {
      logger.log("warn", KIMI_EVENTS.refreshTokenRotatedExternally);
      return ok(observed);
    }
    if (response.status >= 400 && response.status < 500 && whole && reply?.["error"] === "invalid_grant") {
      await lease.writeMarker(grant, "denied", 0, failures);
      return err("reauthorization_required");
    }
    if (!response.ok) {
      if (response.status === 429) return err("refresh_busy");
      const clientRefused = (response.status === 401 || response.status === 403) && whole &&
        (reply?.["error"] === "invalid_client" || reply?.["error"] === "unauthorized_client") &&
        reply["access_token"] === undefined && reply["refresh_token"] === undefined;
      if (!clientRefused) return err("refresh_recovery_required");
      await backoff();
      return err("refresh_rejected");
    }
    const next = response.status === 200 && whole && reply !== undefined ? renewedRecord(current.record, reply, deps.now()) : undefined;
    if (next === undefined) return err("refresh_recovery_required");
    // replace() is false when the file changed after the last read: that record wins.
    if (await lease.replace(current, next)) logger.log("info", KIMI_EVENTS.tokenRefreshed);
    return ok(await lease.read());
  };

  /** A renewal that never rejects. The caller signal does not reach it. */
  const renew = async (refusedAccess: string | undefined): Promise<Renewal> => {
    const renewal = deadline(RENEWAL_DEADLINE_MS);
    const progress = { sent: false };
    try {
      return await store.withLease(renewal, (lease) => renewUnderLock(lease, renewal, refusedAccess, progress));
    } catch (error) {
      if (!renewal.aborted) return err(kimiErrorCodeOf(error));
      return err(progress.sent ? "refresh_recovery_required" : "timeout");
    }
  };

  const load = async (caller: AbortSignal | undefined): Promise<Result<ProviderCredential<"kimi">, ProxyError>> => {
    const bound = deadline(WAIT_DEADLINE_MS);
    const wait = caller === undefined ? bound : AbortSignal.any([caller, bound]);
    const ended = (): KimiErrorCode => (caller?.aborted ? "cancelled" : "timeout");
    const read = async (): Promise<Result<KimiSnapshot, KimiErrorCode>> => {
      try {
        return ok(await store.read(wait));
      } catch (error) {
        return err(wait.aborted ? ended() : kimiErrorCodeOf(error));
      }
    };
    if (wait.aborted) return failure(ended());
    const first = await read();
    if (!first.ok) return failure(first.error);
    let selected = first.value;
    const access = accessOf(selected.record);
    if (kimiRenewalDue(selected.record, deps.now()) || refused.has(access)) {
      const refusedAccess = refused.has(access) ? access : undefined;
      // Managers of one file share one renewal of one grant; another grant waits for it to settle.
      const flight = coordinateNativeRefresh("kimi", store.coordinationKey, kimiGrantOf(selected.record), () => renew(refusedAccess));
      let renewal: Renewal;
      try {
        renewal = await abortable(flight, wait);
      } catch {
        return failure(ended());
      }
      if (renewal.ok) {
        selected = renewal.value;
      } else {
        if (!KEEP_VALID_BEARER.has(renewal.error)) return failure(renewal.error);
        const again = await read();
        if (!again.ok) return failure(again.error);
        if (!usable(again.value.record)) return failure(renewal.error);
        logger.log("warn", KIMI_ERRORS[renewal.error].event, { errorCode: renewal.error });
        selected = again.value;
      }
    }
    if (!usable(selected.record)) return failure("refresh_rejected");
    // The scrub must hold each token before it can reach a request; a token that it can not hold is refused.
    if (!registerExactCredential("kimi", selected.record.access_token)) return failure("invalid_record");
    return ok({ provider: "kimi", authHeaders: { authorization: `Bearer ${selected.record.access_token}` } });
  };

  return {
    refreshable: true,
    deviceId,
    getCredentials: (signal) => load(signal),
    forceRefresh: async (signal, failed) => {
      const token = failed === undefined ? undefined : bearerToken(failed);
      // A renewal needs the refused bearer, so that each token is renewed at most once.
      if (token === undefined) return failure("refresh_required");
      refuse(kimiFingerprint(token));
      return load(signal);
    },
  };
};
