/**
 * OFFLINE ONLY. Source-compatible model/auth boundary; not service authorization.
 * Adapted from MoonshotAI/kimi-code@67325c1b25e46b2fc66043bceab059221b719fa9:
 * packages/oauth/src/{types,identity,oauth-manager}.ts and
 * packages/node-sdk/src/kimi-code-model-provider.ts. MIT; see NOTICE.
 * Subswitch owns this adaptation. No private SDK, native process or ambient state.
 */
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { abortable } from "./abortable.js";
import { readBoundedBody } from "./provider-transport.js";
import { SUBSWITCH_NAME, SUBSWITCH_VERSION } from "./version.js";
import { RoutingError, type Item, type WireProtocol } from "./routing/routing-types.js";
import type { ProviderAuth, ProviderCredential } from "./provider-auth.js";
import { err, ok } from "./result.js";

export interface KimiFixtureScope {
  readonly product: "kimi-code";
  readonly region: "global" | "mainland-cn";
  /** Fixture-attested identity, never inferred from an arbitrary access token. */
  readonly account: string;
  readonly generation: string;
}
export interface KimiFixtureRecord {
  readonly revision: string;
  readonly scope: KimiFixtureScope;
  readonly tokens: Readonly<Record<string, unknown>>;
}
/** Atomic persistence/locking are supplied explicitly, not native-store discovery. */
export interface KimiFixtureStore {
  read(signal: AbortSignal): Promise<KimiFixtureRecord>;
  withLock<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T>;
  compareAndSwap(revision: string, tokens: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<boolean>;
}
export interface KimiSubscriptionFixtureOptions {
  readonly mode: "offline-fixture";
  readonly scope: KimiFixtureScope;
  readonly store: KimiFixtureStore;
  readonly origin: string;
  readonly clientId: "subswitch-offline-fixture";
  readonly transport: typeof fetch;
  readonly now?: () => number;
  readonly limits?: { requestMs?: number; phaseMs?: number; attempts?: number; tokens?: number; refreshes?: number };
}
interface Material { access: string; refresh: string; expires: number }
export interface KimiFixtureCredential extends ProviderCredential<"kimi"> { readonly generation: string }
class FixtureFailure extends RoutingError {}
const failure = (code: string, status = 503) => new FixtureFailure(`kimi_subscription_${code}`, status);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const scopeKey = (scope: KimiFixtureScope) => hash([scope.product, scope.region, scope.account, scope.generation]);
const asciiToken = (value: unknown): value is string => typeof value === "string" && /^[!-~]{1,8192}$/.test(value);
function material(tokens: Readonly<Record<string, unknown>>): Material {
  const access = tokens["access_token"], refresh = tokens["refresh_token"], expires = tokens["expires_at"];
  if (!asciiToken(access) || !asciiToken(refresh) || typeof expires !== "number" || !Number.isFinite(expires * 1000) || expires <= 0 || tokens["token_type"] !== "Bearer") throw failure("invalid_fixture_tokens");
  return { access, refresh, expires: expires * 1000 };
}
function bounded(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw failure("invalid_fixture_limit");
  return value;
}

/** Default gate runs before reading transport, storage, endpoint or identity options. */
export function createKimiSubscription(options?: KimiSubscriptionFixtureOptions): KimiSubscriptionFixture {
  if (options?.mode !== "offline-fixture") throw failure("contract_unverified");
  return new KimiSubscriptionFixture(options);
}

/** No agent loop. Each model dispatch/retry is accounted for before transport. */
class KimiSubscriptionFixture implements ProviderAuth<"kimi"> {
  readonly refreshable = true;
  private readonly scope: KimiFixtureScope;
  private readonly origin: string;
  private readonly now: () => number;
  private readonly started = performance.now();
  private readonly phase: AbortSignal;
  private readonly requestMs: number;
  private readonly phaseMs: number;
  private readonly maxima: { attempts: number; tokens: number; refreshes: number };
  private readonly counts = { attempts: 0, tokens: 0, refreshes: 0 };
  private readonly identity = { "user-agent": `${SUBSWITCH_NAME}/${SUBSWITCH_VERSION}`, "x-msh-platform": SUBSWITCH_NAME, "x-msh-version": SUBSWITCH_VERSION };
  constructor(private readonly options: KimiSubscriptionFixtureOptions) {
    const scope = options.scope;
    if (scope.product !== "kimi-code" || !["global", "mainland-cn"].includes(scope.region) || !asciiToken(scope.account) || !asciiToken(scope.generation)) throw failure("fixture_scope_mismatch");
    this.scope = { ...scope };
    const url = new URL(options.origin);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/" || url.search || url.hash || url.username || url.password || options.clientId !== "subswitch-offline-fixture") throw failure("loopback_fixture_required");
    this.origin = url.origin;
    this.now = options.now ?? Date.now;
    this.requestMs = bounded(options.limits?.requestMs, 30_000);
    this.phaseMs = bounded(options.limits?.phaseMs, 180_000);
    this.phase = AbortSignal.timeout(this.phaseMs);
    this.maxima = { attempts: bounded(options.limits?.attempts, 6), tokens: bounded(options.limits?.tokens, 1536), refreshes: bounded(options.limits?.refreshes, 2) };
  }
  budget() { return { ...this.counts }; }
  private checkInferenceBudget(tokens: number) {
    if (this.counts.attempts >= this.maxima.attempts || this.counts.tokens + tokens > this.maxima.tokens) throw failure("inference_budget");
  }
  private signal(caller?: AbortSignal) {
    if (performance.now() - this.started >= this.phaseMs) throw failure("phase_deadline", 504);
    return AbortSignal.any([this.phase, AbortSignal.timeout(this.requestMs), ...(caller ? [caller] : [])]);
  }
  private owner(record: KimiFixtureRecord) {
    if (scopeKey(record.scope) !== scopeKey(this.scope)) throw failure("owner_changed", 409);
    return scopeKey(this.scope);
  }
  async credentials(caller: AbortSignal, force = false): Promise<KimiFixtureCredential> {
    const wait = this.signal(caller);
    try {
      const initial = await abortable(this.options.store.read(wait), wait);
      this.owner(initial);
      let selected = initial;
      if (force || material(initial.tokens).expires <= this.now() + 120_000) {
        // The shared operation has its own deadline. Cancelling one waiter does not
        // cancel another caller's refresh or let an abandoned refresh run forever.
        const operation = this.signal();
        selected = await abortable(this.options.store.withLock(async () => {
          operation.throwIfAborted();
          const current = await abortable(this.options.store.read(operation), operation);
          this.owner(current);
          const token = material(current.tokens);
          if (token.expires > this.now() + 120_000 && (!force || current.revision !== initial.revision)) return current;
          if (this.counts.refreshes >= this.maxima.refreshes) throw failure("refresh_budget");
          this.counts.refreshes++;
          const response = await abortable(this.options.transport(`${this.origin}/fixture/oauth/token`, {
            method: "POST", redirect: "error", signal: operation,
            headers: { ...this.identity, "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: token.refresh, client_id: this.options.clientId }),
          }), operation);
          if (!response.ok) { await abortable(Promise.resolve(response.body?.cancel()), operation); throw failure("refresh_failed"); }
          const body = await readBoundedBody(response.body, 16 * 1024, operation);
          if (!body.complete || body.truncated) throw failure("invalid_refresh_response");
          const data = JSON.parse(body.text) as Record<string, unknown>;
          const seconds = data["expires_in"];
          if (!asciiToken(data["access_token"]) || typeof seconds !== "number" || !Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 86400 || (data["refresh_token"] !== undefined && !asciiToken(data["refresh_token"])) || (data["token_type"] !== undefined && data["token_type"] !== "Bearer")) throw failure("invalid_refresh_response");
          const tokens = { ...current.tokens, access_token: data["access_token"], refresh_token: data["refresh_token"] ?? token.refresh,
            token_type: "Bearer", expires_in: seconds, expires_at: this.now() / 1000 + seconds,
            ...(typeof data["scope"] === "string" ? { scope: data["scope"] } : {}) };
          material(tokens);
          operation.throwIfAborted();
          if (!await abortable(this.options.store.compareAndSwap(current.revision, tokens, operation), operation)) throw failure("owner_changed", 409);
          const published = await abortable(this.options.store.read(operation), operation);
          this.owner(published);
          return published;
        }, operation), wait);
      }
      wait.throwIfAborted();
      const token = material(selected.tokens);
      if (token.expires <= this.now()) throw failure("expired");
      return { provider: "kimi", generation: this.owner(selected), authHeaders: { authorization: `Bearer ${token.access}` } };
    } catch (error) {
      if (wait.aborted) throw failure("cancelled", 499);
      if (error instanceof FixtureFailure) throw error;
      throw failure("auth_failed"); // Never expose transport/store/token parse errors.
    }
  }
  async getCredentials() { try { return ok(await this.credentials(this.signal())); } catch { return err({ kind: "auth" as const, message: "Kimi subscription fixture authentication unavailable." }); } }
  async forceRefresh() { try { return ok(await this.credentials(this.signal(), true)); } catch { return err({ kind: "auth" as const, message: "Kimi subscription fixture refresh unavailable." }); } }

  async request(protocol: WireProtocol, body: Item, caller: AbortSignal, expectedGeneration?: string): Promise<Response> {
    const signal = this.signal(caller);
    try {
      if (protocol !== "messages" && protocol !== "responses") throw failure("protocol");
      const cap = body[protocol === "messages" ? "max_tokens" : "max_output_tokens"];
      if (!Number.isSafeInteger(cap) || (cap as number) < 1 || (cap as number) > 256 || body["model"] !== "kimi-for-coding" || body["stream"] !== true) throw failure("request_boundary");
      this.checkInferenceBudget(cap as number); // Do not spend auth work on an already exhausted request.
      const encoded = JSON.stringify(body); // Snapshot caller history/tools once; never rewrite or execute.
      let credential = await this.credentials(signal);
      const generation = expectedGeneration ?? credential.generation;
      for (let attempt = 0; ; attempt++) {
        signal.throwIfAborted();
        if (credential.generation !== generation) throw failure("owner_changed", 409);
        this.checkInferenceBudget(cap as number);
        this.counts.attempts++; this.counts.tokens += cap as number;
        const response = await abortable(this.options.transport(`${this.origin}/fixture/v1/${protocol}`, {
          method: "POST", redirect: "error", signal,
          headers: { ...this.identity, ...credential.authHeaders, "content-type": "application/json", accept: "text/event-stream" }, body: encoded,
        }), signal);
        if (response.status === 401 && attempt === 0) {
          await abortable(Promise.resolve(response.body?.cancel()), signal);
          credential = await this.credentials(signal, true);
          continue;
        }
        if (!response.ok) { await abortable(Promise.resolve(response.body?.cancel()), signal); throw failure("upstream_failed", response.status >= 400 ? response.status : 502); }
        return this.stream(response, signal);
      }
    } catch (error) {
      if (signal.aborted) throw failure("cancelled", 499);
      if (error instanceof FixtureFailure) throw error;
      throw failure("transport_failed", 502);
    }
  }
  private stream(response: Response, signal: AbortSignal): Response {
    const reader = response.body?.getReader();
    if (!reader) throw failure("empty_stream", 502);
    const cancel = () => { void reader.cancel().catch(() => {}); };
    const cleanup = () => signal.removeEventListener("abort", cancel);
    signal.addEventListener("abort", cancel, { once: true });
    const contentType = response.headers.get("content-type");
    return new Response(new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          signal.throwIfAborted();
          const value = await abortable(reader.read(), signal);
          signal.throwIfAborted();
          if (value.done) { cleanup(); controller.close(); } else controller.enqueue(value.value);
        } catch { cleanup(); cancel(); controller.error(failure("cancelled", 499)); }
      },
      async cancel() { cleanup(); await abortable(reader.cancel(), signal).catch(() => {}); },
    }), { status: response.status, headers: contentType ? { "content-type": contentType } : {} });
  }
}
