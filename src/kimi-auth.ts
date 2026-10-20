/** Model-only managed OAuth, adapted from MoonshotAI/kimi-code@67325c1b
 * packages/oauth/src/{constants,identity,oauth}.ts (MIT; see NOTICE).
 * Own identity/store; no native CLI, discovery, API key, agent or background calls.
 */
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { abortable } from "./abortable.js";
import { coordinateNativeRefresh } from "./native-auth-coordination.js";
import { readBoundedBody } from "./provider-transport.js";
import { SUBSWITCH_NAME, SUBSWITCH_VERSION } from "./version.js";
import { RoutingError } from "./routing/routing-types.js";
import type { ProviderCredential } from "./provider-auth.js";
import type { KimiAuthRecord, KimiAuthStore } from "./kimi-auth-store.js";

/** Explicit region mapping from official region.ts (retained pin3079e9515f05f097a3f34afdc8ebe2b9b377bf0d). */
export const KIMI_OAUTH_ORIGINS = { global: "https://auth.kimi.ai", "mainland-cn": "https://auth.kimi.com" } as const;
const CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
type Region = KimiAuthRecord["region"];
type Data = Record<string, unknown>;
class OAuthFailure extends RoutingError {}
const fail = (code: string, status = 503) => new OAuthFailure(`kimi_oauth_${code}`, status);
const token = (value: unknown): value is string => typeof value === "string" && /^[!-~]{1,8192}$/.test(value);
const run = <T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> => {
  signal.throwIfAborted();
  return abortable(Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); }), signal);
};
export function kimiIdentityHeaders(deviceId: string): Record<string, string> {
  if (!/^[a-zA-Z0-9-]{1,128}$/.test(deviceId)) throw fail("invalid_device");
  return { "user-agent": `${SUBSWITCH_NAME}/${SUBSWITCH_VERSION}`, "x-msh-platform": SUBSWITCH_NAME,
    "x-msh-version": SUBSWITCH_VERSION, "x-msh-device-id": deviceId };
}
interface Options {
  store: KimiAuthStore;
  region: Region;
  /** Only an explicit numeric loopback endpoint may replace the fixed auth host. */
  fixtureOrigin?: string;
  transport?: typeof fetch;
  now?: () => number;
}
// Store errors are sanitized by the persistence boundary. Carry our own protocol
// result through that boundary, then report its safe code after releasing the lock.
async function locked<T>(options: Options, operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  const result = await options.store.withLock(async () => {
    try { return { ok: true as const, value: await operation() }; }
    catch (error) { return { ok: false as const, error }; }
  }, signal);
  if (!result.ok) throw result.error;
  return result.value;
}
function origin(options: Options): string {
  if (options.region !== "global" && options.region !== "mainland-cn") throw fail("region_mismatch");
  if (!options.fixtureOrigin) return KIMI_OAUTH_ORIGINS[options.region];
  const url = new URL(options.fixtureOrigin);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/" || url.search || url.hash || url.username || url.password) throw fail("fixture_endpoint");
  return url.origin;
}
function tokens(data: Data, now: number, previous?: KimiAuthRecord["tokens"]): KimiAuthRecord["tokens"] {
  const seconds = data["expires_in"];
  const refresh = data["refresh_token"] ?? previous?.refresh_token;
  if (!token(data["access_token"]) || !token(refresh) || typeof seconds !== "number" || !Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 86400 * 365 || (data["token_type"] !== undefined && data["token_type"] !== "Bearer")) throw fail("invalid_response");
  return { access_token: data["access_token"], refresh_token: refresh, expires_at: Math.floor(now / 1000) + seconds, token_type: "Bearer" };
}
/** Every operation has a deadline, bounded response and sanitized failures. No automatic retries. */
async function post(options: Options, path: string, params: Data, deviceId: string, signal: AbortSignal): Promise<{ status: number; data: Data }> {
  const wait = AbortSignal.any([signal, AbortSignal.timeout(10000)]);
  try {
    const response = await run(() => (options.transport ?? fetch)(origin(options) + path, {
      method: "POST", redirect: "error", signal: wait,
      headers: { ...kimiIdentityHeaders(deviceId), "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ client_id: CLIENT_ID, ...params } as Record<string, string>),
    }), wait);
    const body = await readBoundedBody(response.body, 16 * 1024, wait);
    if (!body.complete || body.truncated) throw fail("invalid_response");
    const data: unknown = JSON.parse(body.text);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw fail("invalid_response");
    return { status: response.status, data: data as Data };
  } catch { throw fail(wait.aborted ? "cancelled" : "request_failed", wait.aborted ? 499 : 503); }
}
export interface KimiCredential extends ProviderCredential<"kimi"> {
  /** Local login lineage, not an asserted provider account identifier. */
  readonly generation: string;
  readonly deviceId: string;
}
export class KimiAuthManager {
  constructor(private readonly options: Options) { origin(options); }
  private owner(record: KimiAuthRecord): void {
    if (record.region !== this.options.region) throw fail("region_mismatch");
  }
  async credentials(caller: AbortSignal, force = false): Promise<KimiCredential> {
    const wait = AbortSignal.any([caller, AbortSignal.timeout(15000)]);
    try {
      const initial = await run(() => this.options.store.read(wait), wait);
      this.owner(initial);
      const now = this.options.now ?? Date.now;
      let selected = initial;
      if (force || initial.tokens.expires_at * 1000 <= now() + 120000) {
        // A cancelled waiter cannot cancel another caller's shared refresh.
        selected = await run(() => coordinateNativeRefresh("kimi", this.options.store.coordinationKey, JSON.stringify([initial.generation, initial.region, initial.deviceId]), async () => {
          const signal = AbortSignal.timeout(15000);
          return locked(this.options, async () => {
            const current = await this.options.store.read(signal);
            this.owner(current);
            if (current.generation !== initial.generation || current.deviceId !== initial.deviceId) throw fail("owner_changed", 409);
            if (current.tokens.expires_at * 1000 > now() + 120000 && (!force || current.revision !== initial.revision)) return current;
            const response = await post(this.options, "/api/oauth/token", { grant_type: "refresh_token", refresh_token: current.tokens.refresh_token }, current.deviceId, signal);
            if (response.status !== 200) throw fail("refresh_failed");
            const next: KimiAuthRecord = { ...current, revision: randomUUID(), tokens: tokens(response.data, now(), current.tokens) };
            if (!await this.options.store.compareAndSwap(current.revision, next, signal)) throw fail("owner_changed", 409);
            const published = await this.options.store.read(signal);
            if (published.generation !== initial.generation || published.revision !== next.revision) throw fail("owner_changed", 409);
            return published;
          }, signal);
        }), wait);
      }
      wait.throwIfAborted();
      this.owner(selected);
      if (selected.generation !== initial.generation || selected.deviceId !== initial.deviceId) throw fail("owner_changed", 409);
      if (selected.tokens.expires_at * 1000 <= now()) throw fail("expired");
      return { provider: "kimi", generation: selected.generation, deviceId: selected.deviceId,
        authHeaders: { authorization: `Bearer ${selected.tokens.access_token}` } };
    } catch (error) {
      if (wait.aborted) throw fail("cancelled", 499);
      if (error instanceof OAuthFailure) throw error;
      throw fail("unavailable");
    }
  }
}

/** Explicit setup only. Never called by serve/doctor; never opens a browser or touches native state. */
export async function loginKimi(options: Options & {
  signal: AbortSignal;
  onVerification: (info: { uri: string; userCode: string }) => void;
  /** Injectable delay for deterministic offline tests. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}): Promise<void> {
  origin(options);
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(300000)]);
  const deviceId = randomUUID(), generation = randomUUID();
  const now = options.now ?? Date.now;
  try {
    // Require a new store; an existing login is never silently replaced.
    await locked(options, async () => {
      try { await options.store.read(signal); } catch (error) {
        if (error instanceof Error && error.message === "kimi_auth_store_missing") return;
        throw error;
      }
      throw fail("store_exists");
    }, signal);
    const auth = await post(options, "/api/oauth/device_authorization", {}, deviceId, signal);
    const d = auth.data, expires = d["expires_in"], interval = d["interval"] ?? 5;
    if (auth.status !== 200 || !token(d["device_code"]) || !token(d["user_code"]) || typeof expires !== "number" || !Number.isSafeInteger(expires) || expires < 1 || expires > 1800 || typeof interval !== "number" || !Number.isSafeInteger(interval) || interval < 1 || interval > 60 || typeof d["verification_uri_complete"] !== "string") throw fail("invalid_device_response");
    const uri = new URL(d["verification_uri_complete"]);
    const allowed = origin(options);
    if (uri.origin !== allowed || uri.username || uri.password || /[\u0000-\u0020\u007f-\u009f]/.test(d["verification_uri_complete"])) throw fail("verification_uri");
    const deadline = Math.min(now() + expires * 1000, now() + 300000);
    options.onVerification({ uri: uri.href, userCode: d["user_code"] });
    let delay = interval * 1000;
    // Both clock deadline and a hard dispatch count bound injected clocks/delays.
    for (let polls = 0; polls < 60 && now() < deadline; polls++) {
      await run(() => options.sleep ? options.sleep(delay, signal) : sleep(delay, undefined, { signal }), signal);
      if (now() >= deadline) break;
      const response = await post(options, "/api/oauth/token", { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: d["device_code"] }, deviceId, signal);
      if (response.status === 200) {
        const record: KimiAuthRecord = { version: 1, revision: randomUUID(), generation, region: options.region, deviceId, tokens: tokens(response.data, now()) };
        await locked(options, () => options.store.write(record, signal), signal);
        return;
      }
      if (response.status !== 400) throw fail("poll_failed");
      if (response.data["error"] === "authorization_pending") continue;
      if (response.data["error"] === "slow_down") { delay = Math.min(delay + 5000, 60000); continue; }
      throw fail(response.data["error"] === "access_denied" ? "denied" : response.data["error"] === "expired_token" ? "expired" : "poll_failed");
    }
    throw fail("expired");
  } catch (error) {
    if (signal.aborted) throw fail("cancelled", 499);
    if (error instanceof OAuthFailure) throw error;
    throw fail("login_failed");
  }
}
