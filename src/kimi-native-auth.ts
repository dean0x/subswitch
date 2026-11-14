/** Renewable Kimi Code 2.4.x flat OAuth contract. No CLI delegation/discovery. */
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import type { KimiCredential } from "./kimi-auth.js";
import { KIMI_OAUTH_CLIENT_ID, KIMI_OAUTH_ORIGINS, kimiIdentityHeaders } from "./kimi-auth.js";
import { abortable } from "./abortable.js";
import { coordinateNativeRefresh } from "./native-auth-coordination.js";
import { readBoundedBody } from "./provider-transport.js";
import { KimiNativeError, nativeFailure as fail, nativeFingerprint, readNativeAttempt, readNativeSnapshot, withNativeLease, type NativeSnapshot, type NativeToken, type NativeStoreHooks } from "./kimi-native-store.js";

type Region = "global" | "mainland-cn";
const token = (value: unknown): value is string => typeof value === "string" && /^[!-~]{1,8192}$/.test(value);
const fingerprint = (record: NativeToken) => nativeFingerprint(JSON.stringify([record.access_token, record.refresh_token, record.expires_at]));
const due = (record: NativeToken, now: number) => record.expires_at * 1000 <= now + Math.max(300, (record.expires_in ?? 0) / 2) * 1000;
// These fetch failures happen before an HTTP request can reach the provider.
// Reset/socket/read errors are deliberately excluded: success may be lost.
const notDispatched = (error: unknown): boolean => {
  if (!(error instanceof TypeError) || !(error.cause instanceof Error)) return false;
  const code = "code" in error.cause ? error.cause.code : undefined;
  return typeof code === "string" && ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "UND_ERR_CONNECT_TIMEOUT"].includes(code);
};

/** Official default slot, derived from fixed region roots; never ambient overrides. */
export function kimiNativeTokenFilename(region: Region): string {
  if (region === "mainland-cn") return "kimi-code.json";
  if (region !== "global") throw fail("region_mismatch");
  const hash = createHash("sha256").update(JSON.stringify({
    oauthHost: KIMI_OAUTH_ORIGINS.global, baseUrl: "https://api.kimi.ai/coding/v1",
  })).digest("hex").slice(0, 16);
  return `kimi-code-env-${hash}.json`;
}
export function validateKimiNativePath(authFile: string, region: Region): void {
  if (typeof authFile !== "string" || !isAbsolute(authFile) || resolve(authFile) !== authFile ||
      authFile.includes("\0") || basename(dirname(authFile)) !== "credentials" ||
      basename(authFile) !== kimiNativeTokenFilename(region)) throw fail("region_store_mismatch");
}

interface RefreshResult { snapshot: NativeSnapshot; predecessor?: string }
export class KimiNativeAuthManager {
  readonly coordinationKey: string;
  private readonly deviceId = randomUUID();
  private readonly rejectedAccess = new Set<string>();
  // Only a successful refresh of the unchanged, locked grant proves continuity.
  private readonly lineages = new Map<string, string>();
  constructor(private readonly authFile: string, private readonly region: Region,
    private readonly now = Date.now, private readonly transport: typeof fetch = fetch, private readonly hooks?: NativeStoreHooks) {
    validateKimiNativePath(authFile, region);
    this.coordinationKey = `kimi-code:${authFile}`;
  }
  /** Read-only health inspection; doctor must never renew or create state. */
  async inspect(signal: AbortSignal): Promise<{ renewalDue: boolean; recoveryRequired?: true }> {
    try {
      const { record } = await readNativeSnapshot(this.authFile, signal), attempt = await readNativeAttempt(this.authFile, signal);
      return { renewalDue: due(record, this.now()), ...(attempt?.grant === fingerprint(record) && attempt.outcome === "pending" ? { recoveryRequired: true as const } : {}) };
    }
    catch (error) { if (error instanceof KimiNativeError) throw error; throw fail("unavailable"); }
  }
  private async renew(failedAccess: string | undefined): Promise<RefreshResult> {
    const deadline = AbortSignal.timeout(20000);
    return withNativeLease(this.authFile, deadline, async lease => {
      const signal = lease.signal;
      let current = await readNativeSnapshot(this.authFile, signal);
      if (!due(current.record, this.now()) && nativeFingerprint(current.record.access_token) !== failedAccess) return { snapshot: current };
      const grant = fingerprint(current.record), prior = await lease.readAttempt();
      if (prior?.grant === grant) {
        if (prior.outcome === "denied") throw fail("reauthorization_required", 401);
        if (prior.outcome === "pending") throw fail("refresh_recovery_required");
        if (prior.retryAt > this.now()) throw fail("refresh_busy");
      }
      if (!token(current.record.refresh_token)) throw fail("reauthorization_required", 401);
      const failures = prior?.grant === grant ? Math.min(prior.failures + 1, 5) : 1;
      const backoff = async () => lease.writeAttempt(grant, "busy", this.now() + Math.min(300000, 30000 * 2 ** (failures - 1)), failures);
      // Persist before dispatch: never replay a potentially rotated grant after
      // transport loss, malformed success, cancellation or process restart.
      await lease.writeAttempt(grant, "prepared", this.now() + 30000, failures);
      await lease.verify();
      await lease.writeAttempt(grant, "pending", 0, failures);
      let response: Response;
      try {
        response = await abortable(Promise.resolve().then(async () => {
          await lease.verify();
          signal.throwIfAborted();
          return this.transport(KIMI_OAUTH_ORIGINS[this.region] + "/api/oauth/token", {
            method: "POST", redirect: "error", signal,
            headers: { ...kimiIdentityHeaders(this.deviceId), "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
            body: new URLSearchParams({ client_id: KIMI_OAUTH_CLIENT_ID, grant_type: "refresh_token", refresh_token: current.record.refresh_token! }),
          });
        }), signal);
      } catch (error) {
        if (signal.aborted && !deadline.aborted) throw fail("lock_lost");
        if (notDispatched(error)) { await backoff(); throw fail("refresh_unavailable"); }
        throw fail("refresh_recovery_required");
      }
      // Record the definite rejection as soon as headers arrive, before a slow
      // or broken error body can exhaust the lease deadline.
      if (response.status === 429) await backoff();
      let body: Awaited<ReturnType<typeof readBoundedBody>>;
      try {
        body = await readBoundedBody(response.body, 16 * 1024, signal);
        // Cancellation can make reader.read() return EOF rather than throw.
        signal.throwIfAborted();
      } catch {
        if (signal.aborted && !deadline.aborted) throw fail("lock_lost");
        // Headers alone prove the 429 cooldown. Every other incomplete reply
        // leaves grant consumption unknown, including a lost success body.
        throw fail(response.status === 429 ? "refresh_busy" : "refresh_recovery_required");
      }
      let data: Record<string, unknown> | undefined;
      try { const value: unknown = JSON.parse(body.text); if (value && typeof value === "object" && !Array.isArray(value)) data = value as Record<string, unknown>; } catch { /* fixed safe failure below */ }
      // Adopt a non-cooperating owner's rotation; never overwrite/tombstone it.
      const observed = await readNativeSnapshot(this.authFile, signal);
      if (fingerprint(observed.record) !== grant) return { snapshot: observed };
      if (response.status >= 400 && response.status < 500 && body.complete && !body.truncated && data?.["error"] === "invalid_grant") {
        await lease.writeAttempt(grant, "denied", 0, failures);
        throw fail("reauthorization_required", 401);
      }
      // An explicit HTTP rejection is a completed failed request, rather than a
      // lost success. Persist bounded backoff so a later demand/restart recovers.
      if (!response.ok) {
        const authenticationRejected = (response.status === 401 || response.status === 403) && body.complete && !body.truncated &&
          (data?.["error"] === "invalid_client" || data?.["error"] === "unauthorized_client") &&
          data["access_token"] === undefined && data["refresh_token"] === undefined;
        if (authenticationRejected) await backoff();
        if (response.status === 429 || authenticationRejected) throw fail(response.status === 429 ? "refresh_busy" : "refresh_rejected");
        throw fail("refresh_recovery_required");
      }
      if (response.status !== 200) throw fail("refresh_recovery_required");
      const seconds = data?.["expires_in"], refresh = data?.["refresh_token"] ?? current.record.refresh_token;
      if (!body.complete || body.truncated || !data || !token(data["access_token"]) || !token(refresh) ||
          typeof seconds !== "number" || !Number.isSafeInteger(seconds) || seconds <= 30 || seconds > 86400 * 365 ||
          (data["token_type"] !== undefined && data["token_type"] !== "Bearer") ||
          (data["scope"] !== undefined && (typeof data["scope"] !== "string" || data["scope"].length > 8192 || /[\u0000-\u001f\u007f]/.test(data["scope"])))) throw fail("refresh_recovery_required");
      const next: NativeToken = { ...current.record, access_token: data["access_token"], refresh_token: refresh,
        expires_at: Math.floor(this.now() / 1000) + seconds, expires_in: seconds, token_type: "Bearer",
        ...(data["scope"] !== undefined ? { scope: data["scope"] } : {}) };
      const persisted = await lease.replace(current, next);
      current = await readNativeSnapshot(this.authFile, signal);
      if (!persisted || fingerprint(current.record) !== fingerprint(next)) return { snapshot: current };
      return { snapshot: current, predecessor: nativeFingerprint(observed.record.access_token) };
    }, this.hooks);
  }
  async credentials(caller: AbortSignal, force = false, failedAccess?: string): Promise<KimiCredential> {
    const signal = AbortSignal.any([caller, AbortSignal.timeout(25000)]);
    try {
      signal.throwIfAborted();
      if (force) {
        if (!failedAccess || !/^[a-f0-9]{64}$/.test(failedAccess)) throw fail("refresh_required", 401);
        this.rejectedAccess.add(failedAccess);
      }
      let selected = await readNativeSnapshot(this.authFile, signal);
      const previousAccess = nativeFingerprint(selected.record.access_token);
      if (due(selected.record, this.now()) || this.rejectedAccess.has(previousAccess)) {
        const pending = coordinateNativeRefresh("kimi", this.coordinationKey, fingerprint(selected.record), () => this.renew(this.rejectedAccess.has(previousAccess) ? previousAccess : undefined)).then(result => {
          // A cancelled waiter still observes a committed self-refresh lineage.
          if (result.predecessor) this.lineages.set(nativeFingerprint(result.snapshot.record.access_token), this.lineages.get(result.predecessor) ?? result.predecessor);
          return result;
        });
        const result = await abortable(pending, signal);
        selected = result.snapshot;
      }
      const access = nativeFingerprint(selected.record.access_token);
      if (selected.record.expires_at * 1000 <= this.now() + 30000 || this.rejectedAccess.has(access)) throw fail("refresh_rejected");
      signal.throwIfAborted();
      return { provider: "kimi", generation: this.lineages.get(access) ?? access, deviceId: this.deviceId,
        authHeaders: { authorization: `Bearer ${selected.record.access_token}` } };
    } catch (error) {
      if (signal.aborted) throw fail("cancelled", 499);
      if (error instanceof KimiNativeError) throw error;
      throw fail("unavailable");
    }
  }
}
