import {
  ClaudeCache,
  type CacheWrite,
  type ClaudeCacheValues,
  type Snapshot,
} from "../claude-cache.js";
import { RoutingError } from "./routing-types.js";

export class StagedCache extends ClaudeCache {
  private writes = new Map<string, CacheWrite>();
  private pendingReservations = new Map<string, Snapshot>();
  private reservations = new Map<string, Snapshot>();
  private disposed = false;
  constructor(private shared: ClaudeCache) {
    super({ maxEntries: 2048, maxBytes: 32 * 1024 * 1024 }, true);
  }
  override get<K extends keyof ClaudeCacheValues>(kind: K, id: string): ClaudeCacheValues[K] | undefined {
    this.checkOpen();
    const local = super.get(kind, id);
    if (local !== undefined) return local;
    const value = this.shared.get(kind, id);
    if (value === undefined) return undefined;
    // Keep active history local if another response reclaims shared LRU state.
    const snapshot = structuredClone(value);
    try {
      super.put(kind, id, snapshot);
    } catch (error) {
      if (error instanceof RoutingError) throw error;
      throw new RoutingError("continuation_store_full", 503);
    }
    return snapshot;
  }
  override put<K extends keyof ClaudeCacheValues>(kind: K, id: string, value: ClaudeCacheValues[K]): void {
    this.checkOpen();
    const write = { kind, id, value } as CacheWrite;
    try {
      super.put(kind, id, value);
      this.writes.set(`${kind}:${id}`, write);
    } catch (error) {
      if (error instanceof RoutingError) throw error;
      throw new RoutingError("continuation_store_full", 503);
    }
  }
  /** Validate the complete local group before any write becomes visible. */
  override putBatch(writes: readonly CacheWrite[]): void {
    this.checkOpen();
    super.putBatch(writes);
    for (const write of writes) this.writes.set(`${write.kind}:${write.id}`, write);
  }
  preflight(): void {
    this.checkOpen();
    for (const id of this.pendingReservations.keys())
      if (this.shared.get("snapshot", id)) throw new RoutingError("foreign_opaque_state", 409);
    const pending: CacheWrite[] = [...this.pendingReservations].map(([id, value]) => ({ kind: "snapshot", id, value }));
    try {
      const writes = [...this.writes.values()];
      // Count staged-only imports and their pending form before any shared write.
      this.shared.checkBatch(writes);
      this.shared.checkBatch([...writes, ...pending]);
      if (pending.length) this.shared.putBatch(pending);
    } catch (error) {
      if (error instanceof RoutingError) throw error;
      throw new RoutingError("continuation_store_full", 503);
    }
    for (const [id, value] of this.pendingReservations) this.reservations.set(id, value);
    this.pendingReservations.clear();
  }
  /** Import claims stay local until preflight checks the complete budget. */
  reserveSnapshot(id: string, value: Snapshot): void {
    this.checkOpen();
    if (this.shared.get("snapshot", id) || this.pendingReservations.has(id))
      throw new RoutingError("foreign_opaque_state", 409);
    this.put("snapshot", id, value);
    this.pendingReservations.set(id, { request: { ...value.request, pending: true }, input: [] });
  }
  /** Emitted provenance survives disposal; it is not usable scoped replay. */
  retainSnapshot(id: string, value: Snapshot): void {
    this.put("snapshot", id, value);
    try { this.shared.put("snapshot", id, value); }
    catch (error) {
      if (error instanceof RoutingError) throw error;
      throw new RoutingError("continuation_store_full", 503);
    }
    this.pendingReservations.delete(id);
    this.reservations.delete(id);
  }
  commit(): void {
    this.checkOpen();
    if (this.pendingReservations.size) this.preflight();
    const writes = [...this.writes.values()];
    // Ownership checks and atomic publication are synchronous.
    for (const [id, reservation] of this.reservations)
      if (this.shared.get("snapshot", id) !== reservation)
        throw new RoutingError("foreign_opaque_state", 409);
    try { this.shared.putBatch(writes); }
    catch (error) {
      if (error instanceof RoutingError) throw error;
      throw new RoutingError("continuation_store_full", 503);
    }
    this.reservations.clear();
    this.writes.clear();
  }
  /** Clear this attempt and pending claims, never a successful publication. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const [id, reservation] of this.reservations)
      if (this.shared.get("snapshot", id) === reservation) this.shared.delete("snapshot", id);
    this.pendingReservations.clear();
    this.reservations.clear();
    this.writes.clear();
    this.clearEntries();
  }
  private checkOpen(): void {
    if (this.disposed) throw new RoutingError("invalid_codec_publication", 500);
  }
}
