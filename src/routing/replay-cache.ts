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
  private reservations = new Map<string, Snapshot>();
  private closed = false;
  constructor(private shared: ClaudeCache) {
    super({ maxEntries: 2048, maxBytes: 32 * 1024 * 1024 }, true);
  }
  override get<K extends keyof ClaudeCacheValues>(
    kind: K,
    id: string,
  ): ClaudeCacheValues[K] | undefined {
    return super.get(kind, id) ?? this.shared.get(kind, id);
  }
  override put<K extends keyof ClaudeCacheValues>(
    kind: K,
    id: string,
    value: ClaudeCacheValues[K],
  ): void {
    if (this.closed) throw new RoutingError("request_cancelled", 499);
    super.put(kind, id, value);
    this.writes.set(`${kind}:${id}`, { kind, id, value } as CacheWrite);
  }
  /** Exclusive claims use the existing shared byte/entry budget before dispatch. */
  reserveSnapshot(id: string, value: Snapshot): void {
    if (this.shared.get("snapshot", id))
      throw new RoutingError("foreign_opaque_state", 409);
    this.put("snapshot", id, value);
    const reservation = {
      request: { ...value.request, pending: true }, input: value.input,
    };
    try {
      this.shared.put("snapshot", id, reservation);
    } catch {
      throw new RoutingError("continuation_store_full", 503);
    }
    this.reservations.set(id, reservation);
  }
  commit(): void {
    try {
      if (this.closed) throw new RoutingError("request_cancelled", 499);
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
    this.reservations.clear();
    this.writes.clear();
    this.closed = true;
  }
}
