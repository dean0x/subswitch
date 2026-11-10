/**
 * Disabled transaction building blocks. No production entrypoint opts in.
 * Call only AFTER original history/opaque/credential guards. This slice neither
 * dispatches nor validates provider streams: integration must remain disabled
 * until complete lifecycle, ordered delivery and shared accounting are ready.
 */
import { createHash } from "node:crypto";
import type { CacheWrite, KimiExecAssociation } from "../claude-cache.js";
import { object } from "../plain-object.js";
import { StagedCache } from "./replay-cache.js";
import { KIMI_EXEC_CODEC_VERSION, parseKimiExecArguments, recognizeKimiExec } from "./kimi-exec-codec.js";
import { RoutingError, type AccessProfile, type Item, type RouteTarget, type WireProtocol } from "./routing-types.js";
import type { KimiExecPending, KimiExecReservation } from "./kimi-exec-pending.js";

export interface KimiExecScope {
  readonly owner: string;
  readonly conversation: string;
  readonly credentialGeneration: string;
  readonly attempt: string;
}
interface Preparation extends KimiExecScope {
  body: Item;
  profile: AccessProfile;
  target: RouteTarget;
  ingress: WireProtocol;
  protocol: WireProtocol;
  stage: StagedCache;
  pending?: KimiExecPending;
}
const continuity = (): never => { throw new RoutingError("continuity_unavailable", 409); };
const unsupported = (): never => { throw new RoutingError("unsupported_routed_content"); };
const key = (scope: KimiExecScope, callId: string): string => createHash("sha256")
  .update("subswitch.kimi-exec-association\0")
  .update(JSON.stringify([scope.owner, scope.conversation, callId])).digest("hex");
const fields = (item: Item, allowed: readonly string[]): boolean =>
  Object.keys(item).every(field => allowed.includes(field));

function nativeCall(item: Item): boolean {
  return fields(item, ["type", "id", "call_id", "name", "input", "status"]) &&
    item["type"] === "custom_tool_call" && item["name"] === "exec" &&
    typeof item["call_id"] === "string" && !!item["call_id"] &&
    typeof item["input"] === "string" &&
    (!Object.hasOwn(item, "id") || typeof item["id"] === "string" && !!item["id"]) &&
    (!Object.hasOwn(item, "status") || item["status"] === "completed");
}

/** Internal preparation only; never expose its request without the full transaction. */
export function prepareKimiExecTransaction(options: Preparation): {
  outbound: Item; transaction: KimiExecTransaction;
} | undefined {
  const { profile: p, target: t, body } = options;
  if (p.provider !== "kimi" || p.product !== "kimi-code" || p.region !== "global" ||
    p.billing !== "subscription" || p.credential.kind !== "native-oauth" ||
    options.ingress !== "responses" || options.protocol !== "responses" || t.model !== "kimi-for-coding") return;
  const recognized = recognizeKimiExec(body);
  if (recognized.kind === "absent") return;
  if (recognized.kind !== "recognized") return unsupported();
  if ([options.owner, options.conversation, options.credentialGeneration, options.attempt]
    .some(value => typeof value !== "string" || !value)) continuity();
  const scope = Object.freeze({ owner: options.owner, conversation: options.conversation,
    credentialGeneration: options.credentialGeneration, attempt: options.attempt });
  const transaction = new KimiExecTransaction(scope, recognized.fingerprint, options.stage, options.pending);
  const outbound: Item = { ...body, tools: (body["tools"] as Item[]).map(tool =>
    tool["type"] === "custom" && tool["name"] === "exec" ? {
      type: "function", name: "exec", description: recognized.declaration.description, strict: true,
      parameters: { type: "object", properties: { input: { type: "string",
        description: "Exact caller-owned source, including any pragma." } }, required: ["input"], additionalProperties: false },
    } : tool) };
  if (Object.hasOwn(body, "tool_choice")) {
    const choice = body["tool_choice"], selection = object(choice);
    if (typeof choice === "string" && ["auto", "none", "required"].includes(choice)) { /* preserve */ }
    else if (selection && fields(selection, ["type", "name"]) && Object.keys(selection).length === 2 &&
      ["custom", "function"].includes(String(selection["type"])) && typeof selection["name"] === "string") {
      if (selection["name"] === "exec") {
        if (selection["type"] !== "custom") unsupported();
        outbound["tool_choice"] = { type: "function", name: "exec" };
      }
    } else unsupported();
  }
  if (Array.isArray(body["input"])) outbound["input"] = transaction.history(body["input"] as Item[]);
  return { outbound, transaction };
}

/** Owner scope is supplied by the existing authenticated attempt, never inferred from source text. */
export class KimiExecTransaction {
  constructor(readonly scope: Readonly<KimiExecScope>, readonly fingerprint: string, private readonly stage: StagedCache,
    private readonly pending?: KimiExecPending) {}

  private association(callId: string): Readonly<KimiExecAssociation> {
    const recorded = this.stage.get("kimiExec", key(this.scope, callId));
    if (!recorded || recorded.codecVersion !== KIMI_EXEC_CODEC_VERSION ||
      recorded.declarationFingerprint !== this.fingerprint || recorded.owner !== this.scope.owner ||
      recorded.conversation !== this.scope.conversation || recorded.credentialGeneration !== this.scope.credentialGeneration ||
      recorded.callId !== callId || typeof recorded.attempt !== "string" || !recorded.attempt ||
      !object(recorded.item) || !nativeCall(recorded.item) || recorded.item["call_id"] !== callId) return continuity();
    return recorded;
  }

  history(entries: readonly Item[]): Item[] {
    const mapped = new Set<string>();
    return entries.map(item => {
      const callIdValue = item["call_id"];
      const known = typeof callIdValue === "string" && this.stage.get("kimiExec", key(this.scope, callIdValue));
      if (known && ["custom_tool_call", "function_call"].includes(String(item["type"])) &&
        (item["type"] !== "custom_tool_call" || item["name"] !== "exec")) continuity();
      if (["custom_tool_call", "function_call"].includes(String(item["type"])) && item["name"] === "exec") {
        if (!nativeCall(item)) continuity();
        const callId = item["call_id"] as string, recorded = this.association(callId).item;
        if (mapped.has(callId) || item["input"] !== recorded["input"] ||
          (Object.hasOwn(item, "id") && item["id"] !== recorded["id"]) ||
          (Object.hasOwn(item, "status") && item["status"] !== recorded["status"])) continuity();
        mapped.add(callId);
        const { input, ...rest } = item;
        return { ...rest, type: "function_call", arguments: JSON.stringify({ input }) };
      }
      if (item["type"] === "custom_tool_call_output" && mapped.has(String(item["call_id"])))
        return { ...item, type: "function_call_output" };
      if (known && item["type"] === "custom_tool_call_output") continuity();
      // A result cannot acquire codec ownership from its name or call_id alone.
      if (item["type"] === "function_call_output" && mapped.has(String(item["call_id"]))) continuity();
      return item;
    });
  }

  /** Future caller must first validate the entire raw lifecycle AND native projection. */
  stageValidatedCalls(calls: readonly Item[]): void {
    const writes: CacheWrite[] = [], seen = new Set<string>();
    const leases: KimiExecReservation[] = [];
    try {
    if (calls.length > 1024) unsupported();
    for (const call of calls) {
      if (!nativeCall(call) || parseKimiExecArguments(JSON.stringify({ input: call["input"] })).kind !== "parsed") unsupported();
      const callId = call["call_id"] as string, id = key(this.scope, callId);
      if (seen.has(callId) || this.stage.get("kimiExec", id)) continuity();
      seen.add(callId);
      const value = Object.freeze({ codecVersion: KIMI_EXEC_CODEC_VERSION, declarationFingerprint: this.fingerprint,
        ...this.scope, callId, item: Object.freeze({ ...call }) });
      const write: CacheWrite = { kind: "kimiExec", id, value };
      if (this.pending) leases.push(this.pending.retain([write]));
      writes.push(write);
    }
    // Existing strict local batch budget and shared commit semantics, no new store.
    this.stage.putBatch(writes);
    } finally {
      writes.length = 0;
      for (const lease of leases) lease.release();
    }
  }
}
