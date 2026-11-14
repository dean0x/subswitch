import assert from "node:assert/strict";
import type { ObjectValue as Item } from "./plain-object.js";
import type { ClaudeReplay } from "./claude-state.js";
import type { KimiExecPending, KimiExecReservation } from "./routing/kimi-exec-pending.js";

export interface Snapshot {
  request: Item;
  input: Item[];
}
/** Process-local exec replay identity; never credential storage or caller authority. */
export interface KimiExecAssociation {
  codecVersion: string;
  declarationFingerprint: string;
  owner: string;
  conversation: string;
  credentialGeneration: string;
  attempt: string;
  callId: string;
  item: Readonly<Item>;
}
/** Exact process-local ordered Responses replay; no remote handle or credentials. */
export interface KimiOrderedAssociation {
  readonly version: 1;
  readonly scopeCanonical: string;
  readonly prefixCanonical: string;
  readonly upstreamInputCanonical: string;
  readonly rawOutputCanonical: string;
}
export interface ClaudeCacheValues {
  snapshot: Snapshot;
  replay: ClaudeReplay;
  adapted: true;
  kimiExec: Readonly<KimiExecAssociation>;
  kimiOrdered: Readonly<KimiOrderedAssociation>;
}
type Values = ClaudeCacheValues;
export type CacheWrite = { [K in keyof Values]: { kind: K; id: string; value: Values[K] } }[keyof Values];
type Entry = { [K in keyof Values]: { kind: K; value: Values[K]; bytes: number } }[keyof Values];

/** One byte/entry budget covers snapshots, thinking replay, adaptation markers and exec identities. */
export class ClaudeCache {
  private readonly entries = new Map<string, Entry>();
  private bytes = 0;
  constructor(private readonly limits = { maxEntries: 4096, maxBytes: 64 * 1024 * 1024 }, private readonly strict = false) {
    assert(limits.maxEntries > 0 && limits.maxBytes > 0, "Claude cache requires positive bounds");
  }
  put<K extends keyof Values>(kind: K, id: string, value: Values[K], pending?: KimiExecPending): void {
    const key = `${kind}:${id}`;
    const old = this.entries.get(key);
    if ((kind === "kimiExec" || kind === "kimiOrdered") && old) throw new Error("continuity_unavailable");
    const bytes = (pending ? pending.serializedBytes(value) : Buffer.byteLength(JSON.stringify(value))) + Buffer.byteLength(key);
    if (this.strict && (bytes > this.limits.maxBytes || this.bytes - (old?.bytes ?? 0) + bytes > this.limits.maxBytes ||
      (!old && this.entries.size >= this.limits.maxEntries))) throw new Error("continuation_store_full");
    const lease = pending?.retain([key, { kind, value, bytes }]);
    try {
    if (old) {
      this.bytes -= old.bytes;
      this.entries.delete(key);
    }
    // Oversized entries must not silently expand the configured process budget.
    if (bytes > this.limits.maxBytes) return;
    this.entries.set(key, { kind, value, bytes } as Entry);
    this.bytes += bytes;
    while (this.entries.size > this.limits.maxEntries || this.bytes > this.limits.maxBytes) {
      const oldest = this.entries.entries().next().value;
      assert(oldest, "cache over budget without an entry to evict");
      this.bytes -= oldest[1].bytes;
      this.entries.delete(oldest[0]);
    }
    } finally { lease?.release(); }
  }
  /** Routed attempts publish all staged state together, after checking the shared budget. */
  putBatch(writes: readonly CacheWrite[], pending?: KimiExecPending): void {
    const updates = new Map<string, Entry>();
    const leases: KimiExecReservation[] = [];
    let bytes = this.bytes;
    let entries = this.entries.size;
    try {
    for (const write of writes) {
      const key = `${write.kind}:${write.id}`;
      const previous = updates.get(key) ?? this.entries.get(key);
      // Exec call identity is insert-only, even for an identical retry. Check the
      // current shared state AND earlier batch writes before any publication.
      if ((write.kind === "kimiExec" || write.kind === "kimiOrdered") && previous) throw new Error("continuity_unavailable");
      const size = (pending ? pending.serializedBytes(write.value) : Buffer.byteLength(JSON.stringify(write.value))) + Buffer.byteLength(key);
      if (!previous) entries++;
      bytes += size - (previous?.bytes ?? 0);
      if (pending) leases.push(pending.retain([key, { kind: write.kind, value: write.value, bytes: size }]));
      updates.set(key, { kind: write.kind, value: write.value, bytes: size } as Entry);
    }
    if (entries > this.limits.maxEntries || bytes > this.limits.maxBytes)
      throw new Error("continuation_store_full");
    // Preflight only touched entries; publication is synchronous and preserves LRU order.
    for (const [key, entry] of updates) this.entries.set(key, entry);
    this.bytes = bytes;
    } finally {
      updates.clear();
      for (const lease of leases) lease.release();
    }
  }
  get<K extends keyof Values>(kind: K, id: string): Values[K] | undefined {
    const key = `${kind}:${id}`,
      entry = this.entries.get(key);
    if (!entry) return undefined;
    assert(entry.kind === kind, "cache key and value kind disagree");
    this.entries.delete(key);
    this.entries.set(key, entry);
    // Only put<K> writes this namespaced key, and the discriminant is checked above.
    return entry.value as Values[K];
  }
  get byteSize(): number {
    return this.bytes;
  }
  get size(): number {
    return this.entries.size;
  }
  /** Attempt subclasses account the actual local entries and clear them before releasing ownership. */
  protected get retainedEntries(): ReadonlyMap<string, Entry> { return this.entries; }
  protected clearEntries(): void { this.entries.clear(); this.bytes = 0; }
}
