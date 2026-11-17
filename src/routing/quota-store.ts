import { createHash } from "node:crypto";
import {
  RoutingError,
  type AllowanceScope,
  type ClassifiedFailure,
  type QuotaObservation,
} from "./routing-types.js";

import { systemClock, type RoutingClock } from "./clock.js";
export type Readiness =
  | "unknown"
  | "available"
  | "exhausted"
  | "eligible-for-retry"
  | "probing";
interface ScopeState {
  windows: Map<string, QuotaObservation>;
  failureAt: number | undefined;
  nextRetry: number;
  retryConstraint: number;
  failures: number;
  probing: symbol | undefined;
  serviceable: boolean;
  observedAt: number;
  failureRevision: number;
}

export const scopeKey = (scope: AllowanceScope): string =>
  createHash("sha256")
    .update(
      JSON.stringify([
        scope.provider,
        scope.product,
        scope.region ?? "",
        scope.account,
        scope.allowanceGroup,
        scope.modelScope ?? "",
      ]),
    )
    .digest("hex");

/** Independent blockers, atomic scope updates, and ownership of half-open reservations. */
export class QuotaStore {
  private readonly scopes = new Map<string, ScopeState>();
  private readonly scopeBytes = new Map<string, number>();
  private bytes = 0;

  constructor(readonly clock: RoutingClock = systemClock) {}

  private copy(scope: AllowanceScope): ScopeState {
    const state = this.scopes.get(scopeKey(scope));
    return state
      ? { ...state, windows: new Map(state.windows) }
      : {
          windows: new Map(),
          failureAt: undefined,
          nextRetry: 0,
          retryConstraint: 0,
          failures: 0,
          probing: undefined,
          serviceable: false,
          observedAt: 0,
          failureRevision: 0,
        };
  }

  private publish(scope: AllowanceScope, state: ScopeState): void {
    const key = scopeKey(scope);
    const bytes = Buffer.byteLength(
      JSON.stringify([
        key,
        {
          ...state,
          probing: state.probing !== undefined,
          windows: [...state.windows],
        },
      ]),
    );
    const total = this.bytes - (this.scopeBytes.get(key) ?? 0) + bytes;
    if (
      (!this.scopes.has(key) && this.scopes.size >= 4096) ||
      total > 4 * 1024 * 1024
    )
      throw new RoutingError("quota_store_full", 503);
    this.scopes.set(key, state);
    this.scopeBytes.set(key, bytes);
    this.bytes = total;
  }

  private cooldown(state: ScopeState): number {
    const base = Math.min(900000, 60000 * 2 ** Math.min(state.failures, 4));
    return Math.min(
      900000,
      Math.round(base * (0.8 + 0.4 * this.clock.random())),
    );
  }

  fail(failure: ClassifiedFailure, reservation?: symbol): void {
    if (!failure.scope || !["quota", "rate_limit"].includes(failure.kind))
      return;
    if (failure.windows.length > 16)
      throw new RoutingError("quota_window_limit", 503);
    const state = this.copy(failure.scope),
      now = this.clock.now();
    state.serviceable = false;
    if (reservation === undefined || state.probing === reservation)
      state.probing = undefined;
    state.failureAt = now;
    state.failureRevision++;
    state.retryConstraint = Math.max(
      state.retryConstraint,
      failure.retryAt ?? 0,
    );
    state.nextRetry = Math.max(
      now + this.cooldown(state),
      state.retryConstraint,
    );
    state.failures++;
    for (const window of failure.windows) {
      if (!this.validWindow(window)) continue;
      if (!state.windows.has(window.id) && state.windows.size >= 16)
        throw new RoutingError("quota_window_limit", 503);
      const old = state.windows.get(window.id);
      if (!old || old.observedAt <= window.observedAt)
        state.windows.set(window.id, { ...window });
    }
    this.publish(failure.scope, state);
  }

  observe(
    scope: AllowanceScope,
    windows: readonly QuotaObservation[],
    requestedAt: number,
    options: {
      complete?: boolean;
      serviceableCredits?: boolean;
      failureRevision?: number;
    } = {},
  ): boolean {
    const state = this.copy(scope),
      now = this.clock.now();
    if (
      requestedAt < (state.failureAt ?? -Infinity) ||
      requestedAt < state.observedAt ||
      requestedAt > now ||
      (options.failureRevision !== undefined &&
        options.failureRevision !== state.failureRevision) ||
      (!windows.length && !options.complete)
    )
      return false;
    if (
      windows.length > 16 ||
      windows.some(
        (window) =>
          !this.validWindow(window) ||
          window.observedAt < requestedAt ||
          window.observedAt > now,
      )
    )
      return false;
    for (const window of windows) {
      if (!state.windows.has(window.id) && state.windows.size >= 16)
        return false;
      const old = state.windows.get(window.id);
      if (!old || old.observedAt <= window.observedAt)
        state.windows.set(window.id, { ...window });
    }
    // Only a driver with a verified complete-snapshot contract may remove missing windows.
    if (options.complete) {
      const present = new Set(windows.map((window) => window.id));
      for (const id of state.windows.keys())
        if (!present.has(id)) state.windows.delete(id);
    }
    state.observedAt = requestedAt;
    if (
      options.serviceableCredits ||
      [...state.windows.values()].every((window) => window.exhausted === false)
    )
      state.nextRetry = Math.max(now, state.retryConstraint);
    this.publish(scope, state);
    return true;
  }

  readiness(scope: AllowanceScope): Readiness {
    const state = this.scopes.get(scopeKey(scope));
    if (!state) return "unknown";
    if (state.probing) return "probing";
    if (state.serviceable) return "available";
    if (state.failureAt === undefined)
      return state.windows.size ? "eligible-for-retry" : "unknown";
    const now = this.clock.now();
    if (now < state.retryConstraint) return "exhausted";
    // A bounded ordinary action can detect credit restoration before recorded resets.
    if (now >= state.nextRetry) return "eligible-for-retry";
    const blockers = [...state.windows.values()].filter(
      (window) => window.exhausted !== false,
    );
    if (
      blockers.length &&
      blockers.every(
        (window) => window.resetAt !== undefined && window.resetAt <= now,
      ) &&
      now >= state.failureAt + 60000
    )
      return "eligible-for-retry";
    return "exhausted";
  }

  reserve(scope: AllowanceScope, reservation = Symbol("quota-probe")): boolean {
    const readiness = this.readiness(scope);
    if (readiness === "exhausted" || readiness === "probing") return false;
    const state = this.copy(scope);
    if (readiness === "eligible-for-retry") state.probing = reservation;
    // Reserve storage before inference, rather than fail admission after completing tools.
    this.publish(scope, state);
    return true;
  }

  success(scope: AllowanceScope, reservation?: symbol): void {
    const state = this.copy(scope);
    if (reservation === undefined || state.probing === reservation)
      state.probing = undefined;
    state.serviceable = true;
    state.failures = 0;
    this.publish(scope, state);
  }

  release(scope: AllowanceScope, reservation?: symbol): void {
    const current = this.scopes.get(scopeKey(scope));
    if (
      !current?.probing ||
      (reservation !== undefined && current.probing !== reservation)
    )
      return;
    const state = this.copy(scope);
    state.probing = undefined;
    this.publish(scope, state);
  }

  recoveryFailure(
    scope: AllowanceScope,
    retryAt?: number,
    reservation?: symbol,
  ): void {
    const current = this.scopes.get(scopeKey(scope));
    if (
      !current?.probing ||
      (reservation !== undefined && current.probing !== reservation)
    )
      return;
    const state = this.copy(scope),
      now = this.clock.now();
    state.retryConstraint = Math.max(state.retryConstraint, retryAt ?? 0);
    state.nextRetry = Math.max(
      now + this.cooldown(state),
      state.retryConstraint,
    );
    state.failureAt = now;
    state.failures++;
    state.failureRevision++;
    state.probing = undefined;
    this.publish(scope, state);
  }

  observations(scope: AllowanceScope): readonly QuotaObservation[] {
    return [...(this.scopes.get(scopeKey(scope))?.windows.values() ?? [])].map(
      (window) => ({ ...window }),
    );
  }
  observationRevision(scope: AllowanceScope): number {
    return this.scopes.get(scopeKey(scope))?.failureRevision ?? 0;
  }

  private validWindow(window: QuotaObservation): boolean {
    return (
      window.id.length > 0 &&
      window.id.length <= 128 &&
      Number.isFinite(window.observedAt) &&
      (window.exhausted === true ||
        window.exhausted === false ||
        window.exhausted === "unknown") &&
      (window.source === "inference" || window.source === "usage") &&
      (window.resetAt === undefined ||
        (Number.isFinite(window.resetAt) && window.resetAt >= 0))
    );
  }

  get byteSize(): number {
    return this.bytes;
  }
  get size(): number {
    return this.scopes.size;
  }
}
