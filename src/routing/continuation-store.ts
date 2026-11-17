import { randomUUID, createHash } from "node:crypto";
import assert from "node:assert/strict";
import {
  RoutingError,
  type AccessProfile,
  type Item,
  type RouteTarget,
  type WireProtocol,
} from "./routing-types.js";

export const ownerKey = (
  p: AccessProfile,
  target: RouteTarget,
  protocol: WireProtocol,
  generation: string,
): string =>
  createHash("sha256")
    .update(
      JSON.stringify([
        target.profile,
        p.provider,
        p.product,
        p.region,
        p.account,
        p.credential,
        p.baseUrl,
        target.model,
        protocol,
        generation,
      ]),
    )
    .digest("hex");
export interface Continuation {
  conversation: string;
  route: string;
  request: Item;
  output: Item[];
  owner: string;
  protocol: WireProtocol;
  scope: "explicit" | "single-target";
}
/** Local response IDs never contain upstream handles. State is process-local and bounded. */
export class ContinuationStore {
  private readonly entries = new Map<
    string,
    { state: Continuation; bytes: number }
  >();
  private bytes = 0;
  constructor(private readonly limits = { maxEntries: 2048, maxBytes: 32 * 1024 * 1024 }) {
    assert(limits.maxEntries > 0 && limits.maxBytes > 0, "Continuation store requires positive bounds");
  }
  put(
    state: Continuation,
    id = `resp_subswitch_route_${randomUUID()}`,
  ): string {
    this.preparePut(state, id)();
    return id;
  }
  /** Preflight both continuation and replay budgets before publishing either store. */
  preparePut(state: Continuation, id: string): () => void {
    if (this.entries.has(id))
      throw new RoutingError("continuation_id_collision", 409);
    const bytes = Buffer.byteLength(JSON.stringify(state));
    if (bytes > this.limits.maxBytes)
      throw new RoutingError("continuation_too_large", 413);
    const snapshot = structuredClone(state);
    return () => {
      if (this.entries.has(id))
        throw new RoutingError("continuation_id_collision", 409);
      // Only completed responses live here. Active requests own independent history copies.
      // Evict at publication, not preflight, so an abandoned attempt retains prior history.
      for (const [oldest, entry] of this.entries) {
        if (this.entries.size < this.limits.maxEntries && this.bytes + bytes <= this.limits.maxBytes) break;
        this.entries.delete(oldest);
        this.bytes -= entry.bytes;
      }
      this.entries.set(id, { state: snapshot, bytes });
      this.bytes += bytes;
    };
  }
  get(
    id: string,
    conversation: string | undefined,
    route: string,
    protocol: WireProtocol,
  ): Continuation {
    const entry = this.entries.get(id);
    if (!entry) throw new RoutingError("continuation_state_lost", 409);
    if (
      entry.state.route !== route ||
      entry.state.protocol !== protocol ||
      (conversation === undefined
        ? entry.state.scope !== "single-target"
        : entry.state.scope !== "explicit" ||
          entry.state.conversation !== conversation)
    )
      throw new RoutingError("continuation_scope_mismatch", 409);
    this.entries.delete(id);
    this.entries.set(id, entry);
    return structuredClone(entry.state);
  }
  route(id: string): string | undefined {
    const entry = this.entries.get(id);
    if (!entry && id.startsWith("resp_subswitch_route_"))
      throw new RoutingError("continuation_state_lost", 409);
    return entry?.state.route;
  }
}
