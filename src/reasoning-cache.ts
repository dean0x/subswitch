import { strict as assert } from "node:assert";

interface CacheEntry {
  readonly items: readonly unknown[];
  readonly bytes: number;
}

/**
 * Compute the byte footprint of a set of reasoning items.
 * Encrypted_content strings dominate; JSON string-length ≈ byte size is acceptable.
 */
const computeBytes = (items: readonly unknown[]): number => JSON.stringify(items).length;

/**
 * Hybrid-bound LRU mapping tool call_id -> the raw Responses reasoning items that
 * preceded that call. Evicts when EITHER `maxEntries` OR `maxBytes` is exceeded.
 *
 * `get` refreshes recency but never removes: Claude Code may retry a request and
 * re-ask for the same call_id.
 *
 * Edge case: a single oversized entry (bytes > maxBytes) degenerates the cache to
 * 1 entry — strictly better than a guaranteed miss.
 */
export class ReasoningCache {
  private readonly entries = new Map<string, CacheEntry>();
  private totalBytes = 0;

  constructor(
    private readonly maxEntries: number,
    private readonly maxBytes: number,
  ) {
    assert(Number.isInteger(maxEntries) && maxEntries > 0, "maxEntries must be a positive integer");
    assert(Number.isInteger(maxBytes) && maxBytes > 0, "maxBytes must be a positive integer");
  }

  put(callId: string, items: readonly unknown[]): void {
    const bytes = computeBytes(items);

    // Remove existing entry first so a key overwrite correctly subtracts its old bytes.
    const existing = this.entries.get(callId);
    if (existing !== undefined) {
      this.totalBytes -= existing.bytes;
      this.entries.delete(callId);
    }

    this.entries.set(callId, { items, bytes });
    this.totalBytes += bytes;

    // Evict LRU entries while over either bound. The size > 1 guard on the byte
    // condition ensures a single oversized entry is kept rather than looping forever.
    while (this.entries.size > this.maxEntries || (this.totalBytes > this.maxBytes && this.entries.size > 1)) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      const oldestEntry = this.entries.get(oldest);
      assert(oldestEntry !== undefined, "BUG: Map key without value in reasoning cache");
      this.totalBytes -= oldestEntry.bytes;
      this.entries.delete(oldest);
    }

    assert(this.entries.size <= this.maxEntries, "reasoning cache exceeded entry bound");
    // The byte bound may be exceeded by a single oversized entry (degenerate case documented above).
    assert(this.entries.size <= 1 || this.totalBytes <= this.maxBytes, "reasoning cache exceeded byte bound");
  }

  get(callId: string): readonly unknown[] | undefined {
    const entry = this.entries.get(callId);
    if (entry !== undefined) {
      this.entries.delete(callId);
      this.entries.set(callId, entry);
    }
    return entry?.items;
  }

  get size(): number {
    return this.entries.size;
  }

  get byteSize(): number {
    return this.totalBytes;
  }
}
