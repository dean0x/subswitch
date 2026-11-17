import {
  ClaudeCache,
  type CacheWrite,
  type ClaudeCacheValues,
} from "../claude-cache.js";
import { RoutingError } from "./routing-types.js";

/** Attempt-local replay writes. Abandoned attempts never publish to the shared cache. */
export class StagedCache extends ClaudeCache {
  private writes = new Map<string, CacheWrite>();
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
    super.put(kind, id, snapshot);
    return snapshot;
  }
  override put<K extends keyof ClaudeCacheValues>(
    kind: K,
    id: string,
    value: ClaudeCacheValues[K],
  ): void {
    super.put(kind, id, value);
    this.writes.set(`${kind}:${id}`, { kind, id, value } as CacheWrite);
  }
  preflight(): void {
    try {
      this.shared.checkBatch([...this.writes.values()]);
    } catch {
      throw new RoutingError("continuation_store_full", 503);
    }
  }
  commit(): void {
    try {
      this.shared.putBatch([...this.writes.values()]);
    } catch {
      throw new RoutingError("continuation_store_full", 503);
    }
    this.writes.clear();
  }
}
