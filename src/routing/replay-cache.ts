import {
  ClaudeCache,
  type CacheWrite,
  type ClaudeCacheValues,
  type KimiOrderedAssociation,
} from "../claude-cache.js";
import { RoutingError } from "./routing-types.js";
import type { KimiExecPending, KimiExecReservation } from "./kimi-exec-pending.js";
import { prefixParts, samePart, earlierDifference, type EarlierDifference } from "./replay-prefix-comparison.js";

/** Private owned-harness output. Presence is not validation; comparison is not causation.
 * committed describes the reference's observed successful publication, not current membership. */
export interface OrderedReplayDiagnostic {
  readonly event: "staged" | "published" | "publication_failed" | "aborted" | "lookup";
  readonly reference: "last_staged" | "unavailable";
  readonly sameScope: boolean | null;
  readonly samePrefix: boolean | null;
  readonly sameStore: boolean | null;
  readonly recordPresent: boolean | null;
  readonly committed: boolean | null;
}

/** Opt-in owned-harness comparison only. Equality is not a cause or admission. */
export interface OrderedReplayPrefixDiagnostic {
  readonly event: "prefix_components";
  readonly reference: "last_staged" | "unavailable";
  readonly sameControls: boolean | null;
  readonly sameEarlierMessages: boolean | null;
  readonly sameAssistant: boolean | null;
}

export interface OrderedReplayEarlierDiagnostic extends EarlierDifference {
  readonly event: "earlier_difference";
  readonly reference: "last_staged" | "unavailable";
}

/** DECISION: one weak reference slot, never an identity registry or cache owner.
 * The latest staged association need not be the intended predecessor (e.g. concurrent
 * branches). Collected/missing references give unknown, never a reconstructed cause.
 * Canonical strings are compared synchronously and never copied or retained here.
 * Production entrypoints omit this object; callbacks receive only closed values. */
export class OrderedReplayDiagnostics {
  private record: WeakRef<Readonly<KimiOrderedAssociation>> | undefined;
  private store: WeakRef<ClaudeCache> | undefined;
  private attempt: WeakRef<StagedCache> | undefined;
  private publication: "staged" | "published" | "publication_failed" | "aborted" | undefined;
  constructor(private readonly observe: (event: Readonly<OrderedReplayDiagnostic>) => void,
    private readonly observePrefix?: (event: Readonly<OrderedReplayPrefixDiagnostic>) => void,
    private readonly observeEarlier?: (event: Readonly<OrderedReplayEarlierDiagnostic>) => void) {}

  staged(attempt: StagedCache, store: ClaudeCache, record: Readonly<KimiOrderedAssociation>): void {
    this.record = new WeakRef(record);
    this.store = new WeakRef(store);
    this.attempt = new WeakRef(attempt);
    this.publication = "staged";
    this.emit("staged");
  }
  publicationResult(attempt: StagedCache, writes: readonly CacheWrite[], success: boolean): void {
    if (this.attempt?.deref() !== attempt ||
      (this.publication !== "staged" && this.publication !== "publication_failed")) return;
    const record = this.record?.deref();
    if (!record || !writes.some(write => write.kind === "kimiOrdered" && write.value === record)) return;
    this.publication = success ? "published" : "publication_failed";
    this.emit(this.publication);
  }
  aborted(attempt: StagedCache): void {
    if (this.attempt?.deref() !== attempt ||
      (this.publication !== "staged" && this.publication !== "publication_failed")) return;
    this.publication = "aborted";
    this.emit("aborted");
  }
  lookup(store: ClaudeCache, scope: string, prefix: string, present: boolean): void {
    const record = this.record?.deref(), priorStore = this.store?.deref();
    // Data descriptors only: diagnostics must not add getter execution to a lookup.
    const same = (field: "scopeCanonical" | "prefixCanonical", current: string): boolean | null => {
      if (!record) return null;
      try {
        const descriptor = Object.getOwnPropertyDescriptor(record, field);
        return descriptor && "value" in descriptor && typeof descriptor.value === "string" ? descriptor.value === current : null;
      } catch { return null; }
    };
    this.emit("lookup", same("scopeCanonical", scope), same("prefixCanonical", prefix),
      priorStore ? priorStore === store : null, present);
    try {
      if (this.observePrefix) {
        const descriptor = record && Object.getOwnPropertyDescriptor(record, "prefixCanonical");
        const prior = descriptor && "value" in descriptor && typeof descriptor.value === "string" ? descriptor.value : undefined;
        const left = prior === undefined ? undefined : prefixParts(prior), right = prefixParts(prefix);
        this.observePrefix(Object.freeze({ event: "prefix_components", reference: record ? "last_staged" : "unavailable",
          sameControls: left && right ? samePart(prior!, left[0], prefix, right[0]) : null,
          sameEarlierMessages: left && right ? samePart(prior!, left[1], prefix, right[1]) : null,
          sameAssistant: left && right ? samePart(prior!, left[2], prefix, right[2]) : null }));
      }
    } catch {} // Optional diagnostic work never changes the real lookup/refusal.
    try {
      if (!this.observeEarlier) return;
      const descriptor = record && Object.getOwnPropertyDescriptor(record, "prefixCanonical");
      const prior = descriptor && "value" in descriptor && typeof descriptor.value === "string" ? descriptor.value : undefined;
      this.observeEarlier(Object.freeze({ event: "earlier_difference", reference: record ? "last_staged" : "unavailable",
        ...earlierDifference(prior, prefix) }));
    } catch {} // Independent from both existing callbacks and ordinary admission.
  }
  private emit(event: OrderedReplayDiagnostic["event"], sameScope: boolean | null = null,
    samePrefix: boolean | null = null, sameStore: boolean | null = null, recordPresent: boolean | null = null): void {
    try {
      const available = !!this.record?.deref();
      this.observe(Object.freeze({ event, reference: available ? "last_staged" : "unavailable",
        sameScope, samePrefix, sameStore, recordPresent,
        committed: !available ? null : this.publication === "published" }));
    } catch {} // A diagnostic callback/getter failure cannot replace the real result.
  }
}

/** Attempt-local replay writes. Abandoned attempts never publish to the shared cache. */
export class StagedCache extends ClaudeCache {
  private writes = new Map<string, CacheWrite>();
  private pending: KimiExecPending | undefined;
  private leases = new Map<string, { entry: KimiExecReservation; write: KimiExecReservation }>();
  private disposed = false;
  constructor(private shared: ClaudeCache, private readonly diagnostics?: OrderedReplayDiagnostics) {
    super({ maxEntries: 2048, maxBytes: 32 * 1024 * 1024 }, true);
  }
  override get<K extends keyof ClaudeCacheValues>(
    kind: K,
    id: string,
  ): ClaudeCacheValues[K] | undefined {
    this.checkOpen();
    return super.get(kind, id) ?? this.shared.get(kind, id);
  }
  /** Called after exactly the existing lookup; no cache read, mutation or LRU touch. */
  observeOrderedLookup(scope: string, prefix: string, record: Readonly<KimiOrderedAssociation> | undefined): void {
    try { this.diagnostics?.lookup(this.shared, scope, prefix, record !== undefined); } catch {}
  }
  /** Internal codec attachment happens only after the original request guards. */
  attachPending(pending: KimiExecPending): void {
    this.checkOpen();
    if (this.pending) throw new RoutingError("invalid_codec_publication", 500);
    const leases = new Map<string, { entry: KimiExecReservation; write: KimiExecReservation }>();
    try {
      for (const [key, entry] of this.retainedEntries) {
        const entryLease = pending.retain([key, entry]);
        try { leases.set(key, { entry: entryLease, write: pending.retain([key, this.writes.get(key)]) }); }
        catch (error) { entryLease.release(); throw error; }
      }
    } catch (error) { this.release(leases); throw error; }
    this.pending = pending;
    this.leases = leases;
  }
  override put<K extends keyof ClaudeCacheValues>(
    kind: K,
    id: string,
    value: ClaudeCacheValues[K],
  ): void {
    this.checkOpen();
    const write = { kind, id, value } as CacheWrite, leases = this.hold([write]);
    try {
      super.put(kind, id, value, this.pending);
      this.writes.set(`${kind}:${id}`, write);
      this.replace(leases);
      this.observeStaged(write);
    } catch (error) { this.release(leases); throw error; }
  }
  /** Preflight a complete attempt-local group before recording any of its writes. */
  override putBatch(writes: readonly CacheWrite[]): void {
    this.checkOpen();
    const leases = this.hold(writes);
    try {
      super.putBatch(writes, this.pending);
      let ordered: CacheWrite | undefined;
      for (const write of writes) {
        this.writes.set(`${write.kind}:${write.id}`, write);
        if (write.kind === "kimiOrdered") ordered = write;
      }
      this.replace(leases);
      // Observe the latest association only after the complete group is recorded
      // and charged. A callback must not interleave partial batch registration.
      if (ordered) this.observeStaged(ordered);
    } catch (error) { this.release(leases); throw error; }
  }
  commit(): void {
    this.checkOpen();
    let writes: CacheWrite[] | undefined;
    let lease: KimiExecReservation | undefined;
    try {
      if (this.pending) {
        let bytes = 2, count = 0;
        for (const write of this.writes.values()) bytes += (count++ ? 1 : 0) + this.pending.measure(write);
        lease = this.pending.reserve(bytes + 1);
      }
      writes = [...this.writes.values()];
      try { this.shared.putBatch(writes, this.pending); }
      catch (error) {
        try { this.diagnostics?.publicationResult(this, writes, false); } catch {}
        if (error instanceof RoutingError) throw error;
        if (error instanceof Error && error.message === "continuity_unavailable")
          throw new RoutingError("continuity_unavailable", 409);
        throw new RoutingError("continuation_store_full", 503);
      }
      // Only a successful return from the actual atomic shared publication counts.
      try { this.diagnostics?.publicationResult(this, writes, true); } catch {}
    } finally { writes = undefined; lease?.release(); }
    if (this.pending) this.dispose();
    else this.writes.clear();
  }
  /** Clears only this attempt; shared publication is never rolled back. */
  dispose(): void {
    this.writes.clear();
    this.clearEntries();
    this.release(this.leases);
    this.disposed = true;
    try { this.diagnostics?.aborted(this); } catch {}
  }
  private observeStaged(write: CacheWrite): void {
    try { if (write.kind === "kimiOrdered") this.diagnostics?.staged(this, this.shared, write.value); } catch {}
  }
  private checkOpen(): void {
    if (this.disposed) throw new RoutingError("invalid_codec_publication", 500);
  }
  private hold(writes: readonly CacheWrite[]): Map<string, { entry: KimiExecReservation; write: KimiExecReservation }> {
    const leases = new Map<string, { entry: KimiExecReservation; write: KimiExecReservation }>();
    if (!this.pending) return leases;
    try {
      for (const write of writes) {
        const key = `${write.kind}:${write.id}`;
        const entry = { kind: write.kind, value: write.value,
          bytes: this.pending.measure(write.value) + Buffer.byteLength(key) };
        const entryLease = this.pending.retain([key, entry]);
        let writeLease: KimiExecReservation;
        try { writeLease = this.pending.retain([key, write]); }
        catch (error) { entryLease.release(); throw error; }
        const prior = leases.get(key);
        leases.set(key, { entry: entryLease, write: writeLease });
        prior?.entry.release(); prior?.write.release();
      }
      return leases;
    } catch (error) { this.release(leases); throw error; }
  }
  private replace(leases: Map<string, { entry: KimiExecReservation; write: KimiExecReservation }>): void {
    for (const [key, lease] of leases) {
      const prior = this.leases.get(key);
      this.leases.set(key, lease);
      prior?.entry.release(); prior?.write.release();
    }
    leases.clear();
  }
  private release(leases: Map<string, { entry: KimiExecReservation; write: KimiExecReservation }>): void {
    for (const lease of leases.values()) { lease.entry.release(); lease.write.release(); }
    leases.clear();
  }
}
