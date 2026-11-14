import { isDeepStrictEqual } from "node:util";
import type { SseEvent } from "../codex-response.js";
import { object } from "../plain-object.js";
import { RoutingError, type AccessProfile, type Item } from "./routing-types.js";
import type { RoutingClock } from "./clock.js";
import { validatedProviderEvents } from "./provider-stream.js";
import type { Logger } from "../logger.js";
import type { LimitContext } from "../limit-observation.js";
import type { KimiExecPending } from "./kimi-exec-pending.js";
import { orderedJsonBytes, type OrderedLeases } from "./kimi-ordered-replay.js";
import { jsonStringBytes } from "../json-size.js";

export type KimiBridgeRefusal = "invalid_event" | "unsupported_output" | "opaque_output" |
  "conflicting_identity" | "invalid_order" | "duplicate_completion" | "late_mutation" |
  "conflicting_content" | "invalid_arguments" | "conflicting_arguments" |
  "invalid_terminal" | "state_limit";

const OPAQUE_ENVELOPE_FIELDS = ["signature", "encrypted_content", "thinking", "redacted_thinking", "reasoning_content", "reasoning_text"] as const;
const ENVELOPE_STAGES = ["created", "in_progress", "completed", "incomplete"] as const;
const PART_STAGES = ["part_added", "part_done", "item_done", "completed", "incomplete"] as const;
type EnvelopeStage = typeof ENVELOPE_STAGES[number];
type PartStage = typeof PART_STAGES[number];
export type KimiOpaqueResponseSite = `${EnvelopeStage}_envelope_${typeof OPAQUE_ENVELOPE_FIELDS[number]}` |
  "stream_reasoning_event" | "item_added_reasoning" | `${PartStage}_reasoning_part`;
/** Closed source labels, never copied from provider keys, event names or values. */
export const KIMI_OPAQUE_RESPONSE_SITES: readonly KimiOpaqueResponseSite[] = Object.freeze([
  ...ENVELOPE_STAGES.flatMap(stage => OPAQUE_ENVELOPE_FIELDS.map(key => `${stage}_envelope_${key}` as const)),
  "stream_reasoning_event", "item_added_reasoning",
  ...PART_STAGES.map(stage => `${stage}_reasoning_part` as const),
]);

/** Closed source guard labels; provider keys, values and event names never become labels. */
export const KIMI_UNSUPPORTED_RESPONSE_SITES = Object.freeze([
  "event_fields",
  "event_logprobs",
  "item_added_type",
  "item_added_message_content",
  "item_added_function_arguments",
  "non_message_content_event",
  "part_added_value",
  "unknown_content_event",
  "message_fields",
  "message_shape",
  "reasoning_fields",
  "reasoning_shape",
  "function_fields",
  "function_shape",
  "text_part_fields",
  "text_part_annotations",
  "refusal_part_fields",
  "part_type",
  "ordered_visible_output",
  "refusal_with_tools",
  "profile_contract"
] as const);
export type KimiUnsupportedResponseSite = typeof KIMI_UNSUPPORTED_RESPONSE_SITES[number];

/** Version 1 diagnostic vocabulary, not an acceptance schema. Never append raw keys. */
export const KIMI_RESPONSE_EVENT_KINDS = Object.freeze([
  "response.created", "response.in_progress", "response.completed", "response.incomplete",
  "response.output_item.added", "response.output_item.done", "response.content_part.added", "response.content_part.done",
  "response.output_text.delta", "response.output_text.done", "response.refusal.delta", "response.refusal.done",
  "response.function_call_arguments.delta", "response.function_call_arguments.done",
  "response.custom_tool_call_input.delta", "response.custom_tool_call_input.done",
  "response.reasoning_summary_part.added", "response.reasoning_summary_part.done",
  "response.reasoning_summary_text.delta", "response.reasoning_summary_text.done",
  "response.reasoning_text.delta", "response.reasoning_text.done", "ping",
] as const);
/** Bit positions are immutable within this diagnostic version. Values are never inspected. */
export const KIMI_RESPONSE_FIELD_CLASSES = Object.freeze([
  "response", "output_index", "item", "item_id", "content_index", "part", "call_id", "name", "delta",
  "arguments", "refusal", "text", "logprobs", "obfuscation", "summary_index", "annotation_index", "annotation",
  "response_id", "status", "error", "code", "message", "param", "content", "encrypted_content",
] as const);
interface KimiResponseEventFields {
  readonly eventKind: typeof KIMI_RESPONSE_EVENT_KINDS[number] | "unknown";
  readonly rejectedFieldMask: number;
  readonly unknownFieldPresent: boolean;
}

/** Source guard reasons only. Never event names, provider fields or content. */
export const KIMI_REASONING_REFUSAL_REASONS = Object.freeze([
  "unhandled_reasoning_event", "omitted_display_required",
  "nonempty_summary_part_added", "nonempty_summary_part_done", "nonempty_final_summary_part",
  "nonempty_summary_text_delta", "nonempty_summary_text_done",
  "initial_encrypted_content_nonstring", "final_encrypted_content_missing",
  "final_encrypted_content_nonstring", "final_encrypted_content_empty",
] as const);
export type KimiReasoningRefusalReason = typeof KIMI_REASONING_REFUSAL_REASONS[number];

/** Fixed diagnostics contain no provider content or raw exception. */
export class KimiResponsesBridgeError extends Error {
  declare readonly eventFields?: KimiResponseEventFields;
  constructor(readonly code: KimiBridgeRefusal, readonly opaqueSite?: KimiOpaqueResponseSite, readonly unsupportedSite?: KimiUnsupportedResponseSite,
    readonly reasoningRefusalReason?: KimiReasoningRefusalReason) { super(`kimi_responses_bridge_${code}`); }
}
function refuse(code: KimiBridgeRefusal): never { throw new KimiResponsesBridgeError(code); }
function unsupported(site: KimiUnsupportedResponseSite): never { throw new KimiResponsesBridgeError("unsupported_output", undefined, site); }
function unsupportedEvent(type: string, value: Item, allowed: readonly string[]): never {
  const error = new KimiResponsesBridgeError("unsupported_output", undefined, "event_fields");
  try {
    let rejectedFieldMask = 0, unknownFieldPresent = false;
    for (const key of Object.keys(value)) if (!allowed.includes(key)) {
      const position = KIMI_RESPONSE_FIELD_CLASSES.findIndex(known => known === key);
      if (position < 0) unknownFieldPresent = true;
      else rejectedFieldMask |= 2 ** position;
    }
    Object.defineProperty(error, "eventFields", { value: Object.freeze({
      eventKind: KIMI_RESPONSE_EVENT_KINDS.find(known => known === type) ?? "unknown",
      rejectedFieldMask, unknownFieldPresent,
    }) });
  } catch { /* Diagnostics cannot replace the original fixed refusal. */ }
  throw error;
}
const ownData = (value: object, key: string): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
};
function eventFieldLog(error: KimiResponsesBridgeError) {
  try {
    const detail = ownData(error, "eventFields");
    if (typeof detail !== "object" || detail === null) return {};
    const kind = ownData(detail, "eventKind"), mask = ownData(detail, "rejectedFieldMask"), unknown = ownData(detail, "unknownFieldPresent");
    if (!(kind === "unknown" || KIMI_RESPONSE_EVENT_KINDS.some(known => known === kind)) ||
      typeof mask !== "number" || !Number.isSafeInteger(mask) || mask < 0 || mask >= 2 ** KIMI_RESPONSE_FIELD_CLASSES.length ||
      typeof unknown !== "boolean" || (mask === 0 && !unknown)) return {};
    return { responseEventKind: kind as string, responseFieldMask: mask, responseUnknownField: unknown };
  } catch { return {}; } // Optional detail failure must preserve the base fixed refusal log.
}
function opaque(site: KimiOpaqueResponseSite): never { throw new KimiResponsesBridgeError("opaque_output", site); }
function opaqueReasoning(reason: KimiReasoningRefusalReason): never {
  throw new KimiResponsesBridgeError("opaque_output", "stream_reasoning_event", undefined, reason);
}
function reasoningRefusalLog(error: KimiResponsesBridgeError) {
  try {
    const reason = ownData(error, "reasoningRefusalReason");
    return KIMI_REASONING_REFUSAL_REASONS.some(known => known === reason)
      ? { reasoningRefusalReason: reason as KimiReasoningRefusalReason } : {};
  } catch { return {}; } // Optional metadata cannot erase the base refusal or replace the error.
}
const string = (value: unknown): string => typeof value === "string" ? value : refuse("invalid_event");
const identifier = (value: unknown): string => string(value) || refuse("conflicting_identity");
const index = (value: unknown): number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : refuse("conflicting_identity");
const record = (value: unknown): Item => object(value) ?? refuse("invalid_event");
/** Reject known opaque state at each strict response-envelope boundary. Presence
 * matters even for null/empty values; never strip it or scan caller tool data.
 * Standard reasoning configuration and usage/metadata remain separate data.
 */
function responseEnvelope(value: unknown, stage: EnvelopeStage): Item {
  const response = record(value);
  for (const key of OPAQUE_ENVELOPE_FIELDS) {
    if (Object.hasOwn(response, key)) opaque(`${stage}_envelope_${key}`);
  }
  return response;
}
const fields = (value: Item, allowed: readonly string[], site: KimiUnsupportedResponseSite) => {
  if (Object.keys(value).some((key) => !allowed.includes(key))) unsupported(site);
};
const frame = (type: string, rest: Item = {}): string => `event: ${type}\ndata: ${JSON.stringify({ type, ...rest })}\n\n`;
const argumentsObject = (value: string): Item => {
  try {
    const parsed = object(JSON.parse(value)) ?? refuse("invalid_arguments");
    const pending: unknown[] = [parsed];
    while (pending.length) {
      const entry = pending.pop();
      if (typeof entry === "number" && !Number.isFinite(entry)) refuse("invalid_arguments");
      if (entry && typeof entry === "object") for (const child of Object.values(entry)) pending.push(child);
    }
    return parsed;
  }
  catch { return refuse("invalid_arguments"); }
};
function sameArguments(left: Item, right: Item): boolean {
  try { return isDeepStrictEqual(left, right); }
  catch { return refuse("invalid_arguments"); }
}

interface TextState {
  value: string;
  deltas: boolean;
  textDone: boolean;
  partDone: boolean;
}
interface Part extends TextState {
  kind: "output_text" | "refusal";
}
interface Output {
  id: string;
  kind: "message" | "function_call" | "reasoning";
  done: boolean;
  parts: Part[];
  summaryParts: TextState[];
  callId?: string;
  name?: string;
  args: string;
  deltas: boolean;
  argsDone: boolean;
  finalArgs?: Item;
  publicArgs?: Item;
  completedItem?: Item;
}

/**
 * Strict ordered Kimi codec. Attach observeOriginal to
 * validatedProviderEvents, drain it to clean EOF, then call finish(). Never feed
 * legacy reordered events to this codec or publish its frames before that drain.
 * All output is buffered: refusal/cancel/error exposes no text or executable tool.
 * No auth, cache, admission, tool dispatch, opaque ownership or I/O lives here.
 */
class KimiResponsesBridge {
  constructor(private readonly replay?: KimiOrderedBridge) {}
  private responseId: string | undefined;
  private model: string | undefined;
  private outputs: Output[] = [];
  private ids = new Set<string>();
  private calls = new Set<string>();
  private terminal: { stop: string; usage: Item } | undefined;
  private bytes = 0;
  private finished = false;
  private sequence = -1;
  // Existing routed provider state envelope; response storage, not a history cap.
  private static readonly MAX_BYTES = 32 * 1024 * 1024;

  readonly observeOriginal = (event: SseEvent, value: Item): void => {
    if (this.finished || this.terminal) refuse("late_mutation");
    this.bytes += Buffer.byteLength(event.data);
    if (this.bytes > KimiResponsesBridge.MAX_BYTES) refuse("state_limit");
    const type = string(value["type"]);
    if (this.replay) {
      const sequence = index(value["sequence_number"]);
      if (sequence <= this.sequence) refuse("invalid_order");
      this.sequence = sequence;
      // Covers retained original snapshots and simultaneous state/delta copies.
      // One attempt ledger is also used by parsing, replay, cache and delivery.
      this.replay.leases.push(this.replay.pending.reserve(2 * orderedJsonBytes(value) + 64));
    }
    if (event.event !== undefined && event.event !== type) refuse("invalid_event");
    const payloadFields = type === "response.created" || type === "response.in_progress" || type === "response.completed" || type === "response.incomplete"
      ? ["response"] : type === "response.output_item.added" || type === "response.output_item.done"
        ? ["output_index", "item"] : this.replay?.omittedDisplay && (type === "response.reasoning_summary_part.added" || type === "response.reasoning_summary_part.done")
          ? ["output_index", "item_id", "summary_index", "part", ...(type.endsWith(".done") ? ["status"] : [])]
          : this.replay?.omittedDisplay && (type === "response.reasoning_summary_text.delta" || type === "response.reasoning_summary_text.done")
            ? ["output_index", "item_id", "summary_index", type.endsWith(".delta") ? "delta" : "text"] : type.startsWith("response.content_part.")
          ? ["output_index", "item_id", "content_index", "part"] : type.startsWith("response.function_call_arguments.")
            ? ["output_index", "item_id", "call_id", "name", type.endsWith(".delta") ? "delta" : "arguments"]
            : ["output_index", "item_id", "content_index", type.endsWith(".delta") ? "delta" : type.startsWith("response.refusal.") ? "refusal" : "text", "logprobs"];
    const allowed = ["type", "sequence_number", ...payloadFields];
    if (Object.keys(value).some((key) => !allowed.includes(key))) unsupportedEvent(type, value, allowed);
    if (value["logprobs"] !== undefined && (!Array.isArray(value["logprobs"]) || value["logprobs"].length)) unsupported("event_logprobs");
    if (type === "response.created") {
      if (this.responseId) refuse("duplicate_completion");
      const response = responseEnvelope(value["response"], "created");
      this.responseId = identifier(response["id"]);
      this.model = identifier(response["model"]);
      if (response["status"] !== "in_progress" || !Array.isArray(response["output"]) || response["output"].length) refuse("invalid_event");
      return;
    }
    if (!this.responseId) refuse("invalid_event");
    if (type === "response.in_progress") {
      const response = responseEnvelope(value["response"], "in_progress");
      if (response["id"] !== this.responseId || response["model"] !== this.model || response["status"] !== "in_progress" || !Array.isArray(response["output"]) || response["output"].length) refuse("invalid_event");
      return;
    }
    if (type === "response.reasoning_summary_part.added" || type === "response.reasoning_summary_part.done" ||
      type === "response.reasoning_summary_text.delta" || type === "response.reasoning_summary_text.done") {
      this.summaryEvent(type, value); return;
    }
    if (type.includes("reasoning")) opaqueReasoning("unhandled_reasoning_event");
    if (type === "response.output_item.added") {
      if (index(value["output_index"]) !== this.outputs.length) refuse("invalid_order");
      const item = record(value["item"]), id = identifier(item["id"]);
      if (this.ids.has(id)) refuse("conflicting_identity");
      this.ids.add(id);
      const kind = item["type"];
      if (kind === "reasoning" && !this.replay?.omittedDisplay) opaque("item_added_reasoning");
      if (kind !== "message" && kind !== "function_call" && !(kind === "reasoning" && this.replay)) unsupported("item_added_type");
      if (item["status"] !== "in_progress") refuse("invalid_order");
      const output: Output = { id, kind, done: false, parts: [], summaryParts: [], args: "", deltas: false, argsDone: false };
      if (kind === "message") {
        this.messageShape(item);
        if ((item["content"] as unknown[]).length) unsupported("item_added_message_content");
      } else if (kind === "reasoning") {
        this.reasoningShape(item, false);
      } else {
        this.toolShape(item);
        output.callId = identifier(item["call_id"]); output.name = identifier(item["name"]);
        if (this.calls.has(output.callId)) refuse("conflicting_identity");
        this.calls.add(output.callId);
        // added.arguments is only a placeholder; finals/deltas carry actual values.
        if (item["arguments"] !== "") unsupported("item_added_function_arguments");
      }
      this.outputs.push(output);
      return;
    }
    if (type === "response.completed" || type === "response.incomplete") {
      const stage = type === "response.completed" ? "completed" : "incomplete";
      this.complete(type, responseEnvelope(value["response"], stage), stage); return;
    }
    const output = this.lookup(value);
    if (output.done) refuse("late_mutation");
    if (type === "response.output_item.done") {
      const item = record(value["item"]);
      this.reconcile(output, item, "item_done"); output.done = true; output.completedItem = item; return;
    }
    if (type === "response.function_call_arguments.delta" || type === "response.function_call_arguments.done") {
      if (output.kind !== "function_call") refuse("conflicting_identity");
      if (value["name"] !== undefined && value["name"] !== output.name) refuse("conflicting_identity");
      if (output.argsDone) refuse(type.endsWith(".done") ? "duplicate_completion" : "late_mutation");
      if (type.endsWith(".delta")) { output.args += string(value["delta"]); output.deltas = true; }
      else { this.reconcileArgs(output, string(value["arguments"])); output.argsDone = true; }
      return;
    }
    if (output.kind !== "message") unsupported("non_message_content_event");
    const ci = index(value["content_index"]);
    let part = output.parts[ci];
    if (type === "response.content_part.added") {
      if (part) refuse("conflicting_identity");
      if (ci !== output.parts.length) refuse("invalid_order");
      const source = this.partShape(record(value["part"]), "part_added");
      if (source.value !== "") unsupported("part_added_value");
      output.parts.push({ ...source, deltas: false, textDone: false, partDone: false }); return;
    }
    const kind = type.startsWith("response.refusal.") ? "refusal" : "output_text";
    if (!part && (type === "response.output_text.delta" || type === "response.refusal.delta")) {
      if (ci !== output.parts.length) refuse("invalid_order");
      part = { kind, value: "", deltas: false, textDone: false, partDone: false }; output.parts.push(part);
    }
    if (!part) refuse("conflicting_identity");
    if (type === "response.content_part.done") {
      if (part.partDone) refuse("duplicate_completion");
      this.reconcilePart(part, record(value["part"]), "part_done"); part.partDone = true; return;
    }
    if (part.kind !== kind) refuse("conflicting_content");
    if (part.partDone || part.textDone) refuse(type.endsWith(".done") ? "duplicate_completion" : "late_mutation");
    if (type === "response.output_text.delta" || type === "response.refusal.delta") {
      part.value += string(value["delta"]); part.deltas = true; return;
    }
    if (type === "response.output_text.done" || type === "response.refusal.done") {
      this.reconcileText(part, string(value[kind === "refusal" ? "refusal" : "text"])); part.textDone = true; return;
    }
    unsupported("unknown_content_event");
  };

  private lookup(value: Item): Output {
    const output = this.outputs[index(value["output_index"])];
    const item = object(value["item"]);
    if (!output || (item ? item["id"] : value["item_id"]) !== output.id ||
      (value["item_id"] !== undefined && value["item_id"] !== output.id) ||
      (value["call_id"] !== undefined && value["call_id"] !== output.callId)) refuse("conflicting_identity");
    return output;
  }
  private messageShape(item: Item): void {
    fields(item, ["type", "id", "role", "status", "content"], "message_fields");
    if (item["type"] !== "message" || item["role"] !== "assistant" || !Array.isArray(item["content"]) ||
      !["in_progress", "completed", "incomplete"].includes(string(item["status"]))) unsupported("message_shape");
  }
  private reasoningShape(item: Item, done: boolean): void {
    fields(item, ["id", "type", "summary", "status", "encrypted_content"], "reasoning_fields");
    if (item["type"] !== "reasoning" || !Array.isArray(item["summary"]) || (!done && item["summary"].length) ||
      item["status"] !== (done ? "completed" : "in_progress")) unsupported("reasoning_shape");
    for (const part of item["summary"]) this.summaryText(record(part));
    if (done) {
      // Optional in the Responses item schema. Owned replay retains the exact
      // completed item, including absence; never synthesize or discard state.
      if (Object.hasOwn(item, "encrypted_content")) {
        if (typeof item["encrypted_content"] !== "string") opaqueReasoning("final_encrypted_content_nonstring");
        if (!item["encrypted_content"]) opaqueReasoning("final_encrypted_content_empty");
      }
    } else if (Object.hasOwn(item, "encrypted_content") && item["encrypted_content"] !== null && typeof item["encrypted_content"] !== "string") {
      opaqueReasoning("initial_encrypted_content_nonstring");
    }
  }
  private summaryText(part: Item): string {
    fields(part, ["type", "text"], "reasoning_fields");
    if (part["type"] !== "summary_text") unsupported("reasoning_shape");
    return string(part["text"]);
  }
  /** Omitted display keeps summaries private. Reconcile every snapshot against
    * accumulated deltas, then retain the complete raw item for owned continuation.
    * The existing pre-retention event leases cover the accumulated text as well.
   */
  private summaryEvent(type: string, value: Item): void {
    if (!this.replay?.omittedDisplay) opaqueReasoning("omitted_display_required");
    const output = this.lookup(value);
    if (output.kind !== "reasoning") refuse("conflicting_identity");
    if (output.done) refuse("late_mutation");
    const si = index(value["summary_index"]), part = output.summaryParts[si];
    if (type === "response.reasoning_summary_part.added") {
      if (part) refuse("conflicting_identity");
      if (si !== output.summaryParts.length || output.summaryParts.at(-1)?.partDone === false) refuse("invalid_order");
      if (this.summaryText(record(value["part"])) !== "") opaqueReasoning("nonempty_summary_part_added");
      output.summaryParts.push({ value: "", deltas: false, textDone: false, partDone: false }); return;
    }
    if (!part) refuse("conflicting_identity");
    if (part.partDone) refuse("late_mutation");
    if (type === "response.reasoning_summary_part.done") {
      // The reference permits status=incomplete only for interrupted parts.
      // This owned replay subset requires complete parts and a complete item.
      if (Object.hasOwn(value, "status") || !part.textDone) refuse("invalid_terminal");
      this.reconcileText(part, this.summaryText(record(value["part"]))); part.partDone = true; return;
    }
    if (part.textDone) refuse(type.endsWith(".done") ? "duplicate_completion" : "late_mutation");
    if (type.endsWith(".delta")) { part.value += string(value["delta"]); part.deltas = true; }
    else { this.reconcileText(part, string(value["text"])); part.textDone = true; }
  }
  private toolShape(item: Item): void {
    fields(item, ["type", "id", "call_id", "name", "status", "arguments"], "function_fields");
    if (item["type"] !== "function_call" || !["in_progress", "completed"].includes(string(item["status"]))) unsupported("function_shape");
  }
  private partShape(part: Item, stage: PartStage): { kind: Part["kind"]; value: string } {
    if (part["type"] === "output_text") {
      fields(part, ["type", "text", "annotations"], "text_part_fields");
      if (part["annotations"] !== undefined && (!Array.isArray(part["annotations"]) || part["annotations"].length)) unsupported("text_part_annotations");
      return { kind: "output_text", value: string(part["text"]) };
    }
    if (part["type"] === "refusal") {
      fields(part, ["type", "refusal"], "refusal_part_fields"); return { kind: "refusal", value: string(part["refusal"]) };
    }
    if (String(part["type"]).includes("reasoning")) opaque(`${stage}_reasoning_part`);
    return unsupported("part_type");
  }
  private reconcileText(part: TextState, value: string): void {
    if ((part.deltas || part.textDone || part.partDone) && part.value !== value) refuse("conflicting_content");
    part.value = value;
  }
  private reconcilePart(part: Part, source: Item, stage: PartStage): void {
    const final = this.partShape(source, stage);
    if (part.kind !== final.kind) refuse("conflicting_content");
    this.reconcileText(part, final.value);
  }
  private reconcileArgs(output: Output, serialized: string): void {
    const parsed = argumentsObject(serialized);
    if (output.deltas && !sameArguments(argumentsObject(output.args), parsed)) refuse("conflicting_arguments");
    if (output.finalArgs && !sameArguments(output.finalArgs, parsed)) refuse("conflicting_arguments");
    output.finalArgs = parsed;
  }
  private reconcile(output: Output, item: Item, stage: PartStage): void {
    if (item["id"] !== output.id || item["type"] !== output.kind) refuse("conflicting_identity");
    if (output.completedItem && !isDeepStrictEqual(output.completedItem, item)) refuse("conflicting_content");
    if (output.kind === "reasoning") {
      this.reasoningShape(item, true);
      const summary = item["summary"] as Item[];
      if (summary.length !== output.summaryParts.length || output.summaryParts.some((part, i) =>
        !part.partDone || part.value !== this.summaryText(record(summary[i])))) refuse("conflicting_content");
    } else if (output.kind === "function_call") {
      this.toolShape(item);
      if (item["status"] !== "completed" || item["call_id"] !== output.callId || item["name"] !== output.name) refuse("conflicting_identity");
      this.reconcileArgs(output, string(item["arguments"]));
    } else {
      this.messageShape(item);
      if (item["status"] !== "completed" && item["status"] !== "incomplete") refuse("invalid_terminal");
      const content = item["content"] as unknown[];
      if (content.length < output.parts.length) refuse("conflicting_content");
      for (let i = 0; i < content.length; i++) {
        const source = record(content[i]), part = output.parts[i];
        if (part) this.reconcilePart(part, source, stage);
        else output.parts.push({ ...this.partShape(source, stage), deltas: false, textDone: false, partDone: false });
      }
    }
  }
  private complete(type: string, response: Item, stage: "completed" | "incomplete"): void {
    if (this.replay && (type !== "response.completed" || this.outputs.some(out => !out.done))) refuse("invalid_terminal");
    if (response["id"] !== this.responseId || response["model"] !== this.model ||
      response["status"] !== (type === "response.completed" ? "completed" : "incomplete") ||
      !Array.isArray(response["output"]) || response["output"].length !== this.outputs.length) refuse("invalid_terminal");
    for (let i = 0; i < this.outputs.length; i++) this.reconcile(this.outputs[i]!, record(response["output"][i]), stage);
    if (type === "response.completed" && response["output"].some((item) => record(item)["status"] !== "completed")) refuse("invalid_terminal");
    const hasCalls = this.calls.size > 0;
    const reason = object(response["incomplete_details"])?.["reason"];
    if (type === "response.completed" && response["incomplete_details"] !== undefined && response["incomplete_details"] !== null) refuse("invalid_terminal");
    if (type === "response.incomplete" && (hasCalls || !["max_output_tokens", "content_filter"].includes(String(reason)))) refuse("invalid_terminal");
    const usage = record(response["usage"]), tokens: Item = {};
    for (const field of ["input_tokens", "output_tokens"]) {
      const value = usage[field];
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) refuse("invalid_terminal");
      tokens[field] = value;
    }
    const refused = this.outputs.some((out) => out.parts.some((part) => part.kind === "refusal"));
    if (this.replay && !this.outputs.some(out => out.kind === "function_call" || out.parts.some(part => part.kind === "output_text"))) unsupported("ordered_visible_output");
    if (refused && hasCalls) unsupported("refusal_with_tools");
    this.terminal = { stop: reason === "max_output_tokens" ? "max_tokens" : reason === "content_filter" || refused ? "refusal" : hasCalls ? "tool_use" : "end_turn", usage: tokens };
  }

  /** Only after the observed validatedProviderEvents iterator succeeds to EOF. */
  finish(): readonly string[] {
    if (!this.terminal || this.finished) refuse("invalid_terminal");
    this.finished = true;
    const emit = (type: string, rest: Item = {}): string => {
      if (this.replay) this.replay.leases.push(this.replay.pending.reserve(2 * orderedJsonBytes({ type, ...rest }) + 128));
      return frame(type, rest);
    };
    const frames = [emit("message_start", { message: { id: this.responseId, type: "message", role: "assistant", model: this.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } })];
    let next = 0;
    for (const output of this.outputs) {
      if (output.kind === "reasoning") continue;
      if (output.kind === "function_call") {
        if (!output.finalArgs) refuse("invalid_arguments");
        const i = next++;
        // Messages publishes JSON.stringify's representation (including -0 ->0).
        // Keep raw provider arguments separate; derive cached A from exactly the
        // same string consumed by the public frame aggregator.
        const temporary = this.replay?.pending.reserve(2 * orderedJsonBytes(output.finalArgs) + 3);
        let serialized: string | undefined;
        try {
        serialized = JSON.stringify(output.finalArgs);
        if (this.replay) {
          this.replay.leases.push(this.replay.pending.reserve(Buffer.byteLength(serialized) + 1));
          output.publicArgs = JSON.parse(serialized) as Item;
        }
        frames.push(emit("content_block_start", { index: i, content_block: { type: "tool_use", id: output.callId, name: output.name, input: {} } }),
          emit("content_block_delta", { index: i, delta: { type: "input_json_delta", partial_json: serialized } }), emit("content_block_stop", { index: i }));
        } finally { serialized = undefined; temporary?.release(); }
      } else for (const part of output.parts) {
        const i = next++;
        frames.push(emit("content_block_start", { index: i, content_block: { type: "text", text: "" } }),
          emit("content_block_delta", { index: i, delta: { type: "text_delta", text: part.value } }), emit("content_block_stop", { index: i }));
      }
    }
    frames.push(emit("message_delta", { delta: { stop_reason: this.terminal.stop, stop_sequence: null }, usage: this.terminal.usage }), emit("message_stop"));
    return frames;
  }
  publicAssistant(): Item {
    if (this.replay) {
      let bytes = 36, count = 0; // role/content framing and terminators
      for (const out of this.outputs) {
        if (out.kind === "function_call") {
          bytes += (count++ ? 1 : 0) + 43 + jsonStringBytes(out.callId!) + jsonStringBytes(out.name!) + orderedJsonBytes(out.publicArgs);
        } else if (out.kind === "message") for (const part of out.parts)
          bytes += (count++ ? 1 : 0) + 23 + jsonStringBytes(part.value);
      }
      this.replay.leases.push(this.replay.pending.reserve(bytes + 1));
    }
    const content: Item[] = [];
    for (const out of this.outputs) {
      if (out.kind === "function_call") content.push({ type: "tool_use", id: out.callId, name: out.name, input: out.publicArgs ?? out.finalArgs });
      else if (out.kind === "message") for (const part of out.parts) content.push({ type: "text", text: part.value });
    }
    return { role: "assistant", content };
  }
}

export interface KimiOrderedBridge {
  readonly pending: KimiExecPending;
  readonly leases: OrderedLeases;
  readonly omittedDisplay: boolean;
  onOutput(rawOutput: readonly Item[], assistant: Item): void;
}

/**
 * Strict entry point: uses the actual provider validator,
 * observes pre-holding order and publishes only after its successful clean EOF.
 * Response is caller-owned; this function opens no connection or credentials.
 */
export async function renderValidatedKimiResponses(
  response: Response, profile: AccessProfile, signal: AbortSignal,
  controller: AbortController, clock: RoutingClock, onComplete: (final: Item) => void = () => {},
  diagnostics?: { logger: Logger; limitContext: LimitContext },
  replay?: KimiOrderedBridge,
): Promise<readonly string[]> {
  try {
    if (profile.provider !== "kimi" || profile.product !== "kimi-code" || profile.region !== "global" ||
      profile.billing !== "subscription" || profile.credential.kind !== "native-oauth") unsupported("profile_contract");
    const codec = new KimiResponsesBridge(replay);
    let final: Item | undefined;
    for await (const _event of validatedProviderEvents(response, profile, "responses", signal, controller, clock,
      (value) => { final = value; }, diagnostics?.logger, diagnostics?.limitContext, undefined, codec.observeOriginal, replay?.pending)) { /* drain; never forward pending executable closures */ }
    signal.throwIfAborted();
    let frames: readonly string[];
    try { frames = codec.finish(); }
    catch (error) {
      if (error instanceof KimiResponsesBridgeError || error instanceof RoutingError) throw error;
      return refuse("invalid_arguments");
    }
    if (!final) refuse("invalid_terminal");
    onComplete(final);
    if (replay) replay.onOutput(final["output"] as Item[], codec.publicAssistant());
    return frames;
  } catch (error) {
    try {
      // Even prototype and descriptor inspection can throw for observer proxies.
      if (error instanceof KimiResponsesBridgeError) {
        const descriptor = Object.getOwnPropertyDescriptor(error, "code");
        const code: unknown = descriptor && "value" in descriptor ? descriptor.value : undefined;
        if (code === "opaque_output" || code === "unsupported_output") {
          // Snapshot own data only; never invoke accessors or coerce unknown values.
          const isOpaque = code === "opaque_output";
          const site = Object.getOwnPropertyDescriptor(error, isOpaque ? "opaqueSite" : "unsupportedSite");
          const sites: readonly string[] = isOpaque ? KIMI_OPAQUE_RESPONSE_SITES : KIMI_UNSUPPORTED_RESPONSE_SITES;
          const fixedSite = site && "value" in site && sites.includes(site.value) ? site.value : "unknown";
          diagnostics?.logger.log("warn", "kimi_ordered_response_refused", {
            errorCode: isOpaque ? "kimi_ordered_response_opaque_output" : "kimi_ordered_response_unsupported_output",
            eventType: fixedSite, status: null,
            ...(!isOpaque && fixedSite === "event_fields" ? eventFieldLog(error) : {}),
            ...(isOpaque && fixedSite === "stream_reasoning_event" ? reasoningRefusalLog(error) : {}),
          });
        }
      }
    } catch { /* Diagnostic inspection and observers cannot replace the original refusal. */ }
    throw error;
  }
}
