import { QuotaStore, scopeKey } from "./quota-store.js";
import type { AllowanceScope, QuotaObservation } from "./routing-types.js";
import { abortable } from "../abortable.js";
import { scheduleRoutingTimer } from "./clock.js";

export interface UsageSnapshot {
  windows: readonly QuotaObservation[];
  complete: boolean;
  serviceableCredits: boolean;
}
export type UsageDriver = (
  scope: AllowanceScope,
  signal: AbortSignal,
) => Promise<UsageSnapshot | undefined>;

/** Optional read-only metadata. No driver is registered for unvalidated coding-key /usages. */
export class UsageCoordinator {
  private readonly queried = new Map<string, number>();
  private readonly pending = new Map<string, Promise<boolean>>();
  private active = 0;
  private readonly controllers = new Set<AbortController>();
  private closed = false;
  constructor(
    private readonly quota: QuotaStore,
    private readonly driver?: UsageDriver,
  ) {}
  refresh(scope: AllowanceScope): Promise<boolean> {
    const key = scopeKey(scope),
      now = this.quota.clock.now(),
      last = this.queried.get(key);
    const pending = this.pending.get(key);
    if (pending) return pending;
    if (
      this.closed ||
      !this.driver ||
      this.active >= 4 ||
      (last !== undefined && now - last < 60000) ||
      (last === undefined && this.queried.size >= 4096)
    )
      return Promise.resolve(false);
    this.queried.set(key, now);
    const failureRevision = this.quota.observationRevision(scope);
    this.active++;
    const controller = new AbortController();
    this.controllers.add(controller);
    const cancelTimeout = scheduleRoutingTimer(
      this.quota.clock,
      () => controller.abort(),
      8000,
    );
    let observation: Promise<UsageSnapshot | undefined>;
    try {
      observation = this.driver(scope, controller.signal);
    } catch (error) {
      observation = Promise.reject(error);
    }
    const operation = abortable(observation, controller.signal)
      .then(
        (snapshot) =>
          !!snapshot &&
          Buffer.byteLength(JSON.stringify(snapshot)) <= 65536 &&
          this.quota.observe(scope, snapshot.windows, now, {
            ...snapshot,
            failureRevision,
          }),
      )
      .catch(() => false)
      .finally(() => {
        cancelTimeout();
        this.controllers.delete(controller);
        this.active--;
        this.pending.delete(key);
      });
    this.pending.set(key, operation);
    return operation;
  }
  close(): void {
    this.closed = true;
    for (const controller of this.controllers) controller.abort();
  }
}
