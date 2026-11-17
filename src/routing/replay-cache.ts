import {
  ClaudeCache,
  type CacheWrite,
  type ClaudeCacheValues,
  type Snapshot,
} from "../claude-cache.js";
import { RoutingError } from "./routing-types.js";

/** Attempt-local replay writes; exclusive pending claims roll back on abandonment. */
export class StagedCache extends ClaudeCache {
  private writes = new Map<string, CacheWrite>();
  private pendingReservations = new Map<string, Snapshot>();
  private reservations = new Map<string, Snapshot>();
  private closed = false;
  constructor(private shared: ClaudeCache) {
    super({ maxEntries: 2048, maxBytes: 32 * 1024 * 1024 }, true);
  }
  override get<K extends keyof ClaudeCacheValues>(
    kind: K,
    id: string,
  ): ClaudeCacheValues[K] | undefined {
    const local = super.get(kind, id);
    if (local !== undefined) return local;
    const value = this.shared.get(kind, id);
    if (value === undefined) return undefined;
    // Active history stays attempt-local even if another response reclaims shared LRU state.
    const snapshot = structuredClone(value);
    try {
      super.put(kind, id, snapshot);
    } catch {
      throw new RoutingError("continuation_store_full", 503);
    }
    return snapshot;
  }
  override put<K extends keyof ClaudeCacheValues>(
    kind: K,
    id: string,
    value: ClaudeCacheValues[K],
  ): void {
    if (this.closed) throw new RoutingError("request_cancelled", 499);
    try {
      super.put(kind, id, value);
    } catch {
      throw new RoutingError("continuation_store_full", 503);
    }
    this.writes.set(`${kind}:${id}`, { kind, id, value } as CacheWrite);
  }
  preflight(): void {
    if (this.closed) throw new RoutingError("request_cancelled", 499);
    for (const id of this.pendingReservations.keys())
      if (this.shared.get("snapshot", id))
        throw new RoutingError("foreign_opaque_state", 409);
    const pending: CacheWrite[] = [...this.pendingReservations].map(([id, value]) => ({
      kind: "snapshot", id, value,
    }));
    try {
      const writes = [...this.writes.values()];
      // Bound the complete import batch and its pending form before any shared write.
      this.shared.checkBatch(writes);
      this.shared.checkBatch([...writes, ...pending]);
      this.shared.putBatch(pending);
    } catch {
      throw new RoutingError("continuation_store_full", 503);
    }
    for (const [id, value] of this.pendingReservations) this.reservations.set(id, value);
    this.pendingReservations.clear();
  }
  /** Import claims stay local until preflight checks the full byte/entry budget. */
  reserveSnapshot(id: string, value: Snapshot): void {
    if (this.closed) throw new RoutingError("request_cancelled", 499);
    if (this.shared.get("snapshot", id) || this.pendingReservations.has(id))
      throw new RoutingError("foreign_opaque_state", 409);
    this.put("snapshot", id, value);
    this.pendingReservations.set(id, {
      request: { ...value.request, pending: true }, input: [],
    });
  }
  /** Observed provenance survives discard; it is not a usable scoped replay record. */
  retainSnapshot(id: string, value: Snapshot): void {
    this.put("snapshot", id, value);
    try {
      this.shared.put("snapshot", id, value);
    } catch {
      throw new RoutingError("continuation_store_full", 503);
    }
    this.pendingReservations.delete(id);
    this.reservations.delete(id);
  }
  commit(): void {
    try {
      if (this.closed) throw new RoutingError("request_cancelled", 499);
      if (this.pendingReservations.size) this.preflight();
      // Validation and publication are synchronous. A foreign attempt cannot acquire
      // this signature between the ownership check and the atomic batch write.
      for (const [id, reservation] of this.reservations)
        if (this.shared.get("snapshot", id) !== reservation)
          throw new RoutingError("foreign_opaque_state", 409);
      try {
        this.shared.putBatch([...this.writes.values()]);
      } catch {
        throw new RoutingError("continuation_store_full", 503);
      }
    } finally {
      this.discard();
    }
  }
  discard(): void {
    for (const [id, reservation] of this.reservations)
      if (this.shared.get("snapshot", id) === reservation)
        this.shared.delete("snapshot", id);
    this.pendingReservations.clear();
    this.reservations.clear();
    this.writes.clear();
    this.closed = true;
  }
}
