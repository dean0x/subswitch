/** Pure identity/assembly over the existing attempt cache and pending ledger. */
import { createHash } from "node:crypto";
import type { ClaudeCache, KimiOrderedAssociation } from "../claude-cache.js";
import { RoutingError, type ActionContext, type Item } from "./routing-types.js";
import type { KimiExecPending, KimiExecReservation } from "./kimi-exec-pending.js";
import type { KimiResponsesRequest } from "./kimi-responses-request.js";
import { jsonStringBytes as stringBytes } from "../json-size.js";

export const KIMI_ORDERED_CODEC = "kimi-ordered-messages-v4";
function unavailable(): never { throw new RoutingError("continuity_unavailable", 409); }
export type OrderedLeases = KimiExecReservation[];

/** Private owned-harness seam only. Values are borrowed for this synchronous call;
 * never log, retain, or expose them to a caller. Production entrypoints omit it. */
export interface OrderedReplayIdentity {
  readonly scopeCanonical: string;
  readonly prefixCanonical: string;
  readonly key: string;
}
export type ObserveOrderedReplay = (identity: Readonly<OrderedReplayIdentity>) => void;

/** Iterative, data-descriptor-only JSON traversal. Never invokes getters/toJSON. */
function* tokens(root: unknown, canonical: boolean): Generator<string | { text: string }> {
  const pending: { value?: unknown; literal?: string }[] = [{ value: root }];
  const seen = new WeakSet<object>();
  while (pending.length) {
    const task = pending.pop()!;
    if (task.literal !== undefined) { yield task.literal; continue; }
    const value = task.value;
    if (typeof value === "string") { yield { text: value }; continue; }
    if (value === null || typeof value === "boolean") { yield String(value); continue; }
    if (typeof value === "number" && Number.isFinite(value)) {
      yield canonical && Object.is(value, -0) ? "-0" : String(value); continue;
    }
    if (!value || typeof value !== "object" || seen.has(value)) unavailable();
    seen.add(value);
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) unavailable();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    let keys = Reflect.ownKeys(descriptors).filter(key => !(array && key === "length"));
    for (const key of keys) {
      if (typeof key !== "string") unavailable();
      const d = descriptors[key]!;
      if (!("value" in d) || !d.enumerable) unavailable();
      if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) unavailable();
    }
    if (array && keys.length !== value.length) unavailable();
    if (canonical && !array) keys = (keys as string[]).sort();
    yield array ? "[" : "{";
    pending.push({ literal: array ? "]" : "}" });
    for (let i = keys.length - 1; i >= 0; i--) {
      const key = keys[i] as string;
      pending.push({ value: descriptors[key]!.value });
      if (!array) { pending.push({ literal: ":" }); pending.push({ value: key }); }
      if (i > 0) pending.push({ literal: "," });
    }
  }
}

export function orderedJsonBytes(value: unknown, canonical = false): number {
  let bytes = 0;
  for (const token of tokens(value, canonical)) {
    bytes += typeof token === "string" ? token.length : stringBytes(token.text);
    if (bytes > 32 * 1024 * 1024) throw new RoutingError("provider_state_too_large", 502);
  }
  return bytes;
}

/** Reserve before a JSON clone/parse, not after allocating the history copy. */
export function holdOrderedJson(value: unknown, pending: KimiExecPending, leases: OrderedLeases): void {
  leases.push(pending.reserve(orderedJsonBytes(value) + 1));
}

export function orderedCanonical(value: unknown, pending?: KimiExecPending, leases?: OrderedLeases): string {
  const bytes = orderedJsonBytes(value, true);
  let chunkBytes = 2, count = 0;
  for (const token of tokens(value, true)) {
    // Each encoder chunk is itself a JSON string in a retained array. Many
    // tiny chunks need their individual quotes and separators charged too.
    chunkBytes += (count++ ? 1 : 0) + (typeof token === "string" ? stringBytes(token) : 2 * stringBytes(token.text) + 2);
  }
  // Bound both escaped canonical string and simultaneous token-array/join copy
  // before constructing chunks. The temporary charge ends after join.
  const retained = pending?.reserve(2 * bytes + 3);
  let temporary: KimiExecReservation | undefined;
  try {
    temporary = pending?.reserve(chunkBytes);
    const chunks: string[] = [];
    for (const token of tokens(value, true)) chunks.push(typeof token === "string" ? token : JSON.stringify(token.text));
    const encoded = chunks.join("");
    if (retained) leases!.push(retained);
    return encoded;
  } catch (error) { retained?.release(); throw error; }
  finally { temporary?.release(); }
}

export function orderedAssociationId(scopeCanonical: string, prefixCanonical: string): string {
  return createHash("sha256").update("[").update(scopeCanonical).update(",").update(prefixCanonical).update("]").digest("hex");
}

export function prepareOrderedReplay(args: {
  context: Readonly<ActionContext>; route: string; profile: string; owner: string; generation: string;
  source: Item; rendered: KimiResponsesRequest; outbound: Item;
  stage: Pick<ClaudeCache, "get" | "put"> & {
    /** Private synchronous borrowed values; implementations must never retain them. */
    observeOrderedLookup?(scope: string, prefix: string, record: Readonly<KimiOrderedAssociation> | undefined): void;
  }; pending: KimiExecPending; leases: OrderedLeases;
  observeIdentity?: ObserveOrderedReplay | undefined;
}): { input: Item[]; stageOutput(rawOutput: readonly Item[], assistant: Item): void } {
  const { source, rendered, pending, leases, stage } = args;
  const scope: Item = { associationVersion: 1, ...args.context, ingress: "messages", destination: "responses",
    logicalRoute: args.route, accessProfileName: args.profile, owner: args.owner,
    credentialGeneration: args.generation, codecVersion: KIMI_ORDERED_CODEC };
  const scopeCanonical = orderedCanonical(scope, pending, leases);
  const controls = Object.fromEntries(Object.entries(source).filter(([key]) => key !== "messages"));
  const messages = source["messages"] as Item[];
  // The renderer has validated cache hints and treats them as advisory, not
  // model input. Native clients move these markers across turns. Compare only
  // their known envelope positions; tool input/schema data remains exact.
  const withoutHint = (entry: Item): Item => {
    const copy = { ...entry }; delete copy["cache_control"]; return copy;
  };
  const blocks = (content: unknown): unknown => Array.isArray(content) ? content.map(withoutHint) : content;
  const prefix = (history: readonly Item[]) => {
    // Reserve a full JSON-copy upper bound before constructing the shallow
    // identity projection. Canonical strings/chunks keep their existing charges.
    holdOrderedJson({ controls, messages: history }, pending, leases);
    const identity = withoutHint(controls);
    if (Array.isArray(controls["tools"])) identity["tools"] = controls["tools"].map(withoutHint);
    if (Array.isArray(controls["system"])) identity["system"] = blocks(controls["system"]);
    const messages = history.map(message => {
      const content = blocks(message["content"]);
      const block = Array.isArray(content) && content.length === 1 ? content[0] as Item : undefined;
      // The validated renderer emits the same single input_text for a string
      // and a sole plain text block. Project only this wrapper in identity;
      // preserve citations, multiple blocks, controls and all caller/tool data.
      return { ...message, content: block?.["type"] === "text" && typeof block["text"] === "string" &&
        Object.keys(block).length === 2 ? block["text"] : content };
    });
    return orderedCanonical({ controls: identity, messages }, pending, leases);
  };
  let last = -1;
  for (let i = 0; i < messages.length; i++) if (messages[i]!["role"] === "assistant") last = i;
  let input = args.outbound["input"] as Item[];
  if (last >= 0) {
    if (last === messages.length - 1 || messages.at(-1)!["role"] !== "user" ||
      !messages.slice(last + 1).some(m => m["role"] === "user") ||
      messages.slice(last + 1).some(m => m["role"] !== "user" && m["role"] !== "system")) unavailable();
    const prefixCanonical = prefix(messages.slice(0, last + 1));
    const key = orderedAssociationId(scopeCanonical, prefixCanonical);
    const record = stage.get("kimiOrdered", key);
    // Observe only after the real lookup; no extra get, mutation, or LRU touch.
    // A diagnostic failure cannot replace the original refusal or success.
    try { stage.observeOrderedLookup?.(scopeCanonical, prefixCanonical, record); } catch {}
    try { args.observeIdentity?.(Object.freeze({ scopeCanonical, prefixCanonical, key })); } catch {}
    if (!record || record.version !== 1 || record.scopeCanonical !== scopeCanonical || record.prefixCanonical !== prefixCanonical ||
      Object.keys(record).sort().join(",") !== "prefixCanonical,rawOutputCanonical,scopeCanonical,upstreamInputCanonical,version" ||
      typeof record.upstreamInputCanonical !== "string" || typeof record.rawOutputCanonical !== "string") unavailable();
    const parse = (text: string): Item[] => {
      // A JSON representation is no larger than its canonical byte spelling.
      leases.push(pending.reserve(Buffer.byteLength(text) + 1));
      let value: unknown;
      try { value = JSON.parse(text); } catch { return unavailable(); }
      if (!Array.isArray(value) || orderedCanonical(value, pending, leases) !== text) unavailable();
      return value as Item[];
    };
    const priorInput = parse(record.upstreamInputCanonical), output = parse(record.rawOutputCanonical);
    const start = rendered.messageSpans[last + 1]![0];
    // Whole-request renderer has already validated tool-result linkage and flush order.
    const suffix = input.slice(start);
    holdOrderedJson([priorInput, output, suffix], pending, leases);
    input = [...priorInput, ...output, ...suffix];
  }
  const upstreamInputCanonical = orderedCanonical(input, pending, leases);
  return { input, stageOutput(rawOutput, assistant) {
    if (assistant["role"] !== "assistant" || !Array.isArray(assistant["content"]) || !assistant["content"].length) unavailable();
    const prefixCanonical = prefix([...messages, assistant]);
    const value: KimiOrderedAssociation = Object.freeze({ version: 1, scopeCanonical, prefixCanonical, upstreamInputCanonical,
      rawOutputCanonical: orderedCanonical(rawOutput, pending, leases) });
    try { stage.put("kimiOrdered", orderedAssociationId(scopeCanonical, prefixCanonical), value); }
    catch (error) {
      if (error instanceof RoutingError) throw error;
      if (error instanceof Error && error.message === "continuity_unavailable") unavailable();
      throw new RoutingError("continuation_store_full", 503);
    }
  } };
}
