import { strict as assert } from "node:assert";

/**
 * Bounded LRU mapping tool call_id -> the raw Responses reasoning items that
 * preceded that call. `get` refreshes recency but never removes: Claude Code
 * may retry a request and re-ask for the same call_id.
 */
export class ReasoningCache {
  private readonly entries = new Map<string, readonly unknown[]>();

  constructor(private readonly maxEntries: number) {
    assert(Number.isInteger(maxEntries) && maxEntries > 0, "maxEntries must be a positive integer");
  }

  put(callId: string, items: readonly unknown[]): void {
    this.entries.delete(callId);
    this.entries.set(callId, items);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    assert(this.entries.size <= this.maxEntries, "reasoning cache exceeded its bound");
  }

  get(callId: string): readonly unknown[] | undefined {
    const items = this.entries.get(callId);
    if (items !== undefined) {
      this.entries.delete(callId);
      this.entries.set(callId, items);
    }
    return items;
  }

  get size(): number {
    return this.entries.size;
  }
}
