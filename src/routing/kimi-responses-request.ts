import { err, ok, type Result } from "../result.js";

// Fixed structural vocabulary from the pinned Claude request builder.
// Attribution, thinking and inert context edits have selected-route policies.
// Other fields remain unsupported; caller-supplied names/values are never echoed.
const CALLER_FIELDS = ["metadata", "thinking", "temperature", "context_management",
  "safeguards", "speed", "thread", "diagnostics", "betas", "fallback_credit_token"] as const;
type CallerField = typeof CALLER_FIELDS[number];
type JsonKind = "null" | "array" | "object" | "string" | "number" | "boolean";

export type KimiMessagesRefusal =
  | "invalid_json"
  | "invalid_request"
  | "unsupported_request_field"
  | `unsupported_request_field_${CallerField}_${JsonKind}`
  | "unsupported_thinking_type"
  | "unsupported_thinking_field"
  | "unsupported_thinking_display"
  | "unsupported_thinking_binding"
  | "invalid_thinking_budget"
  | "invalid_thinking_cap"
  | "unsupported_context_management_field"
  | "invalid_context_management_edits"
  | "unsupported_context_management_edit"
  | "unsupported_output_config_field"
  | `unsupported_output_config_field_format_${JsonKind}`
  | "invalid_message"
  | "unsupported_message_field"
  | "unsupported_role"
  | "unsupported_block"
  | "unsupported_block_field"
  | "unsupported_block_cache_control"
  | "unsupported_text_block_citations"
  | "unsupported_tool_use_caller"
  | "opaque_reasoning"
  | "invalid_tool"
  | "unsupported_tool_field"
  | "invalid_tool_linkage"
  | "incomplete_tool_round"
  | "unsupported_tool_result"
  | "invalid_tool_choice";

export interface KimiResponsesRequest {
  readonly body: Record<string, unknown>;
  readonly stream: boolean;
  /** A final assistant turn may await caller-owned tool execution. */
  readonly pendingCallIds: readonly string[];
  /** Half-open input spans in the original full-request validation/flush order. */
  readonly messageSpans: readonly (readonly [number, number])[];
  readonly systemSpan: readonly [number, number];
}

type Item = Record<string, unknown>;
class Refusal extends Error {
  constructor(readonly code: KimiMessagesRefusal) { super(code); }
}
function refuse(code: KimiMessagesRefusal): never { throw new Refusal(code); }
function record(value: unknown, code: KimiMessagesRefusal): Item {
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse(code);
  return value as Item;
}
function fields(value: Item, allowed: readonly string[], code: KimiMessagesRefusal): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) refuse(code);
}
/** Selected-route portability policy, after cloneJson: source cache hints are
 * advisory. The destination owns caching; no source TTL, billing, retention or
 * isolation equivalence is promised. Never recurse into caller tool data.
 */
function cacheHint(value: unknown, code: KimiMessagesRefusal): void {
  if (value === null) return;
  const hint = record(value, code);
  fields(hint, ["type", "ttl"], code);
  if (hint["type"] !== "ephemeral" || (Object.hasOwn(hint, "ttl") && hint["ttl"] !== "5m" && hint["ttl"] !== "1h")) refuse(code);
}
/** Fixed known block families only; unknown names and values never escape. */
function blockFields(value: Item, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (allowed.includes(key)) continue;
    if (key === "cache_control") { cacheHint(value[key], "unsupported_block_cache_control"); continue; }
    if (value["type"] === "tool_use" && key === "caller") refuse("unsupported_tool_use_caller");
    refuse("unsupported_block_field");
  }
}
/** Only called on our own JSON clone, never on caller accessors or raw errors. */
function jsonKind(value: unknown): JsonKind {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "object": return "object";
    case "string": return "string";
    case "number": return "number";
    case "boolean": return "boolean";
    default: return refuse("invalid_json");
  }
}
function requestFields(request: Item): void {
  const allowed = ["model", "messages", "system", "tools", "tool_choice", "max_tokens", "stream", "output_config"];
  for (const key of Object.keys(request)) {
    if (allowed.includes(key)) continue;
    if (key === "cache_control") { cacheHint(request[key], "unsupported_request_field"); continue; }
    if (key === "metadata") { optionalAttribution(request[key]); continue; }
    if (key === "thinking") { selectedThinking(request[key], request["max_tokens"]); continue; }
    if (key === "context_management") { preservedContext(request[key]); continue; }
    const field = CALLER_FIELDS.find((known) => known === key);
    refuse(field ? `unsupported_request_field_${field}_${jsonKind(request[key])}` : "unsupported_request_field");
  }
}
/** Selected-route compatibility policy: validate optional Anthropic attribution,
 * then omit it. It is not Kimi identity, model input, cache state or abuse attribution.
 * Only called after cloneJson; never inspect caller getters or coerce user_id.
 */
function optionalAttribution(value: unknown): void {
  const code = `unsupported_request_field_metadata_${jsonKind(value)}` as const;
  const metadata = record(value, code);
  fields(metadata, ["user_id"], code);
  if (!Object.hasOwn(metadata, "user_id")) return;
  const userId = metadata["user_id"];
  if (typeof userId !== "string") refuse(code);
  // Apply the 512-character caller limit as Unicode code points, not UTF-16
  // units or UTF-8 bytes. Stop at the bound without copying or transforming it.
  let count = 0;
  for (const _ of userId) if (++count > 512) refuse(code);
}
/** Validate caller controls after cloneJson. The selected destination low/high/max
 * effort owns effective reasoning in request-adapter, including when thinking is
 * absent. A valid caller budget is explicitly superseded, never converted to or
 * promised equivalent to categorical effort. The source-specific budget/cap
 * relation is superseded too; the independent positive output cap is retained.
 * Exact omitted display constrains output to no readable reasoning. The strict
 * bridge refuses opaque output; this does not emulate Anthropic signatures.
 * Other display/binding controls and unknown fields remain unsupported.
 */
function selectedThinking(value: unknown, maxTokens: unknown): void {
  const code = `unsupported_request_field_thinking_${jsonKind(value)}` as const;
  const thinking = record(value, code), type = thinking["type"];
  if (type !== "adaptive" && type !== "enabled") refuse("unsupported_thinking_type");
  for (const key of Object.keys(thinking)) {
    if (key === "type" || (type === "enabled" && key === "budget_tokens")) continue;
    if (key === "display") {
      if (thinking[key] === "omitted") continue;
      refuse("unsupported_thinking_display");
    }
    if (key === "block_binding" || key === "signature") refuse("unsupported_thinking_binding");
    refuse("unsupported_thinking_field");
  }
  if (type === "adaptive") return;
  const budget = thinking["budget_tokens"];
  if (!Number.isSafeInteger(budget) || (budget as number) < 1024) refuse("invalid_thinking_budget");
  if (!Number.isSafeInteger(maxTokens) || (maxTokens as number) <= 0) refuse("invalid_thinking_cap");
}
/** Only explicit preservation is portable: no edits, or one exact keep-all edit.
 * Never run an edit, prune history, infer a default keep count or drop tools.
 * Signed/opaque history is still validated independently by the existing guards.
 */
function preservedContext(value: unknown): void {
  const context = record(value, `unsupported_request_field_context_management_${jsonKind(value)}`);
  fields(context, ["edits"], "unsupported_context_management_field");
  if (!Object.hasOwn(context, "edits")) return;
  const edits = context["edits"];
  if (!Array.isArray(edits)) refuse("invalid_context_management_edits");
  if (!edits.length) return;
  if (edits.length !== 1) refuse("unsupported_context_management_edit");
  const edit = record(edits[0], "unsupported_context_management_edit");
  fields(edit, ["type", "keep"], "unsupported_context_management_edit");
  if (edit["type"] !== "clear_thinking_20251015" || edit["keep"] !== "all") refuse("unsupported_context_management_edit");
}
function nonempty(value: unknown, code: KimiMessagesRefusal): string {
  if (typeof value !== "string" || value.length === 0) refuse(code);
  return value;
}

/** Clone JSON data without invoking toJSON/accessors or recursive transcript scans. */
function cloneJson(value: unknown): unknown {
  const root: Item = {};
  const pending: { source: unknown; target: Item | unknown[]; key: string }[] = [{ source: value, target: root, key: "value" }];
  const seen = new WeakSet<object>();
  while (pending.length) {
    const { source, target, key } = pending.pop()!;
    let copy: unknown = source;
    if (source !== null && typeof source === "object") {
      const array = Array.isArray(source);
      const prototype = Object.getPrototypeOf(source);
      if (seen.has(source) || (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)) refuse("invalid_json");
      seen.add(source);
      copy = array ? [] : {};
      const descriptors = Object.getOwnPropertyDescriptors(source);
      const keys = Reflect.ownKeys(descriptors);
      let elements = 0;
      // LIFO worklist: enqueue backwards so object insertion order also survives.
      for (const childKey of keys.reverse()) {
        if (array && childKey === "length") continue;
        if (typeof childKey !== "string") refuse("invalid_json");
        const descriptor = descriptors[childKey]!;
        if (!("value" in descriptor) || !descriptor.enumerable) refuse("invalid_json");
        if (array && (!/^(0|[1-9][0-9]*)$/.test(childKey) || Number(childKey) >= (source as unknown[]).length)) refuse("invalid_json");
        elements++;
        pending.push({ source: descriptor.value, target: copy as Item, key: childKey });
      }
      if (array && elements !== (source as unknown[]).length) refuse("invalid_json");
    } else if (typeof source !== "string" && typeof source !== "boolean" && source !== null && !(typeof source === "number" && Number.isFinite(source))) {
      refuse("invalid_json");
    }
    // Define an own data property, including for the JSON key "__proto__".
    Object.defineProperty(target, key, { value: copy, enumerable: true, writable: true, configurable: true });
  }
  return root["value"];
}

/**
 * Pure subset renderer selected for ordered Kimi subscription Messages routing.
 * Preserves ordered roles/text blocks/tool linkage, not universal model semantics.
 * Validated optional attribution is deliberately omitted, not translated.
 * Validated thinking controls defer to the configured destination effort; caller
 * numeric budgets are not honored or converted. This does not drop reasoning history.
 * Empty context edits or an exact keep-all-thinking instruction preserve it as-is.
 * Validated ephemeral cache hints are advisory; destination caching owns their
 * effective behavior. They are neither forwarded nor emulated.
 * All opaque reasoning and other unmapped metadata/multimodal forms are refused.
 * Input is JSON data; no auth, owner/cache publication, tool execution or I/O.
 */
export function renderKimiResponsesRequest(source: unknown): Result<KimiResponsesRequest, KimiMessagesRefusal> {
  try {
    const request = record(cloneJson(source), "invalid_request");
    requestFields(request);
    const model = nonempty(request["model"], "invalid_request");
    if (!Array.isArray(request["messages"]) || !request["messages"].length) refuse("invalid_request");
    if (request["stream"] !== undefined && typeof request["stream"] !== "boolean") refuse("invalid_request");
    const input: Item[] = [];
    const messageSpans: [number, number][] = [];
    const calls = new Set<string>(), results = new Set<string>(), pendingCalls = new Set<string>();

    const message = (role: string, content: unknown): void => {
      const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content;
      if (!Array.isArray(blocks) || !blocks.length) refuse("invalid_message");
      let texts: Item[] = [];
      const flush = () => {
        if (!texts.length) return;
        // Responses compatible input-message Items accept input_text for all roles.
        input.push({ type: "message", role, content: texts });
        texts = [];
      };
      if (role === "assistant" && pendingCalls.size) refuse("incomplete_tool_round");
      for (const value of blocks) {
        const block = record(value, "unsupported_block");
        const type = block["type"];
        if (type === "thinking" || type === "redacted_thinking" || type === "reasoning") refuse("opaque_reasoning");
        if (type === "text") {
          blockFields(block, ["type", "text", "citations"]);
          // The source text schema permits null or a list of citations. Only
          // these two empty forms carry no citation information to preserve.
          const citations = block["citations"];
          if (Object.hasOwn(block, "citations") && citations !== null &&
            (!Array.isArray(citations) || citations.length !== 0)) refuse("unsupported_text_block_citations");
          if (typeof block["text"] !== "string") refuse("unsupported_block");
          texts.push({ type: "input_text", text: block["text"] });
        } else if (type === "tool_use" && role === "assistant") {
          blockFields(block, ["type", "id", "name", "input"]);
          const id = nonempty(block["id"], "invalid_tool_linkage");
          const name = nonempty(block["name"], "invalid_tool");
          const args = record(block["input"], "invalid_tool");
          if (calls.has(id)) refuse("invalid_tool_linkage");
          calls.add(id); pendingCalls.add(id);
          flush();
          input.push({ type: "function_call", call_id: id, name, arguments: JSON.stringify(args) });
        } else if (type === "tool_result" && role === "user") {
          blockFields(block, ["type", "tool_use_id", "content", "is_error"]);
          const id = nonempty(block["tool_use_id"], "invalid_tool_linkage");
          if (!calls.has(id) || results.has(id)) refuse("invalid_tool_linkage");
          // Responses has no is_error flag; never manufacture a textual error prefix.
          if ((block["is_error"] !== undefined && block["is_error"] !== false) || typeof block["content"] !== "string") refuse("unsupported_tool_result");
          results.add(id); pendingCalls.delete(id);
          flush();
          input.push({ type: "function_call_output", call_id: id, output: block["content"] });
        } else refuse("unsupported_block");
      }
      flush();
      // Anthropic tool results belong in the following user turn. A system Item
      // may intervene, but partial results cannot leak into another ordinary turn.
      if (role === "user" && pendingCalls.size) refuse("incomplete_tool_round");
    };
    if (request["system"] !== undefined) message("system", request["system"]);
    const systemSpan: [number, number] = [0, input.length];
    for (const value of request["messages"]) {
      const entry = record(value, "invalid_message");
      fields(entry, ["role", "content"], "unsupported_message_field");
      const role = entry["role"];
      if (role !== "system" && role !== "user" && role !== "assistant") refuse("unsupported_role");
      const start = input.length;
      message(role, entry["content"]);
      messageSpans.push([start, input.length]);
    }

    const body: Item = { model, input, stream: true, store: false };
    const names = new Set<string>();
    if (request["tools"] !== undefined) {
      if (!Array.isArray(request["tools"])) refuse("invalid_tool");
      body["tools"] = request["tools"].map((value) => {
        const tool = record(value, "invalid_tool");
        fields(tool, ["name", "description", "input_schema", "cache_control"], "unsupported_tool_field");
        if (Object.hasOwn(tool, "cache_control")) cacheHint(tool["cache_control"], "unsupported_tool_field");
        const name = nonempty(tool["name"], "invalid_tool");
        if (names.has(name) || (tool["description"] !== undefined && typeof tool["description"] !== "string")) refuse("invalid_tool");
        names.add(name);
        return { type: "function", name, parameters: record(tool["input_schema"], "invalid_tool"), strict: false,
          ...(tool["description"] !== undefined ? { description: tool["description"] } : {}) };
      });
    }
    if (request["tool_choice"] !== undefined) {
      const choice = record(request["tool_choice"], "invalid_tool_choice");
      const type = choice["type"];
      fields(choice, type === "tool" ? ["type", "name", "disable_parallel_tool_use"] : ["type", "disable_parallel_tool_use"], "invalid_tool_choice");
      if (type === "tool") {
        const name = nonempty(choice["name"], "invalid_tool_choice");
        if (!names.has(name)) refuse("invalid_tool_choice");
        body["tool_choice"] = { type: "function", name };
      } else if (type === "auto" || type === "none" || type === "any") {
        if (type === "any" && !names.size) refuse("invalid_tool_choice");
        body["tool_choice"] = type === "any" ? "required" : type;
      } else refuse("invalid_tool_choice");
      if (choice["disable_parallel_tool_use"] !== undefined) {
        if (typeof choice["disable_parallel_tool_use"] !== "boolean") refuse("invalid_tool_choice");
        body["parallel_tool_calls"] = !choice["disable_parallel_tool_use"];
      }
    }
    if (request["max_tokens"] !== undefined) {
      if (!Number.isSafeInteger(request["max_tokens"]) || (request["max_tokens"] as number) <= 0) refuse("invalid_request");
      body["max_output_tokens"] = request["max_tokens"];
    }
    if (request["output_config"] !== undefined) {
      const config = record(request["output_config"], "invalid_request");
      for (const key of Object.keys(config)) {
        if (key !== "effort") refuse(key === "format"
          ? `unsupported_output_config_field_format_${jsonKind(config[key])}` : "unsupported_output_config_field");
      }
      body["reasoning"] = { effort: nonempty(config["effort"], "invalid_request") };
    }
    return ok({ body, stream: request["stream"] === true, pendingCallIds: [...pendingCalls], messageSpans, systemSpan });
  } catch (error) {
    return err(error instanceof Refusal ? error.code : "invalid_json");
  }
}
