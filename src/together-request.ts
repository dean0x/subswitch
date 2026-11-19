import { buildInstructions } from "./anthropic-parse.js";
import type { AnthropicMessage, AnthropicRequest } from "./anthropic-wire-types.js";
import type { ProxyError } from "./errors.js";
import { err, ok, type Result } from "./result.js";
import { TOGETHER_DEFAULT_CAPABILITIES, type TogetherCapabilities } from "./together-models.js";

export const TOGETHER_DEFAULT_OUTPUT_CAP = 16_384;

export type TogetherRequestWarning =
  | "image_dropped"
  | "unsupported_block_dropped"
  | "unsupported_tool_skipped"
  | "unknown_tool_choice"
  | "thinking_dropped";

type Block = Record<string, unknown>;
type UserPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image_url"; readonly image_url: { readonly url: string } };
type ToolCall = {
  readonly id: string;
  readonly type: "function";
  readonly function: { readonly name: string; readonly arguments: string };
};
type Tool = {
  readonly type: "function";
  readonly function: { readonly name: string; readonly description?: string; readonly parameters: Block };
};
type ToolChoice = "auto" | "required" | "none" | { readonly type: "function"; readonly function: { readonly name: string } };
type TogetherMessage =
  | { readonly role: "system"; readonly content: string }
  | { readonly role: "user"; readonly content: string | readonly UserPart[] }
  | { readonly role: "tool"; readonly tool_call_id: string; readonly content: string }
  | { readonly role: "assistant"; readonly content: string | null; readonly tool_calls?: readonly ToolCall[];
      readonly reasoning_content?: string };

export interface TogetherRequestOptions {
  readonly model: string;
  readonly outputCap?: number;
  readonly capabilities?: TogetherCapabilities;
  readonly conversationKey?: string;
  readonly getReasoning?: (key: string) => string | undefined;
}

export interface TogetherRequestOutcome {
  readonly body: {
    readonly model: string;
    readonly messages: readonly TogetherMessage[];
    readonly max_tokens: number;
    readonly stream: boolean;
    readonly stream_options?: { readonly include_usage: true };
    readonly tools?: readonly Tool[];
    readonly tool_choice?: ToolChoice;
    readonly temperature?: number;
    readonly top_p?: number;
    readonly stop?: readonly string[];
  };
  readonly warnings: readonly TogetherRequestWarning[];
  readonly clamp?: { readonly requested: number; readonly applied: number };
}

export const reasoningKey = (conversationKey: string, toolId: string): string => `${conversationKey}|${toolId}`;

const isBlock = (value: unknown): value is Block =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";
const finiteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const BASE64_DATA = /^[A-Za-z0-9+/]+={0,2}$/;

const imageUrl = (source: unknown): string | undefined => {
  if (!isBlock(source) || source["type"] !== "base64") return undefined;
  const { media_type: mediaType, data } = source;
  if (!isString(mediaType) || !IMAGE_MEDIA_TYPES.has(mediaType) || !isString(data) || !BASE64_DATA.test(data)) return undefined;
  return `data:${mediaType};base64,${data}`;
};

const toolOutput = (content: unknown, warnings: TogetherRequestWarning[]): string => {
  if (isString(content)) return content;
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const block of content) {
    if (isBlock(block) && block["type"] === "text" && isString(block["text"])) {
      texts.push(block["text"]);
    } else {
      warnings.push(isBlock(block) && block["type"] === "image" ? "image_dropped" : "unsupported_block_dropped");
    }
  }
  return texts.join("\n");
};

const mapUserTurn = (
  content: AnthropicMessage["content"],
  images: boolean,
  messages: TogetherMessage[],
  warnings: TogetherRequestWarning[],
): Result<void, ProxyError> => {
  if (isString(content)) {
    messages.push({ role: "user", content });
    return ok(undefined);
  }
  const parts: UserPart[] = [];
  let hasImage = false;
  for (const block of content) {
    if (block["type"] === "tool_result") {
      const id = block["tool_use_id"];
      if (!isString(id) || id === "") return err({ kind: "translate", message: "Together tool result needs a tool call ID" });
      const text = toolOutput(block["content"], warnings);
      messages.push({ role: "tool", tool_call_id: id, content: block["is_error"] === true ? `[Tool error] ${text}` : text });
    } else if (block["type"] === "text" && isString(block["text"])) {
      parts.push({ type: "text", text: block["text"] });
    } else if (block["type"] === "image") {
      if (!images) return err({ kind: "translate", message: "Together model does not support images" });
      const url = imageUrl(block["source"]);
      if (url === undefined) {
        warnings.push("image_dropped");
      } else {
        parts.push({ type: "image_url", image_url: { url } });
        hasImage = true;
      }
    } else {
      warnings.push("unsupported_block_dropped");
    }
  }
  // Tool results must follow the assistant's tool calls, before any other user content.
  if (hasImage) {
    messages.push({ role: "user", content: parts });
  } else if (parts.length > 0) {
    const text = parts.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    messages.push({ role: "user", content: text });
  }
  return ok(undefined);
};

const mapAssistantTurn = (
  content: AnthropicMessage["content"],
  getTurnReasoning: (toolId: string) => string | undefined,
  messages: TogetherMessage[],
  warnings: TogetherRequestWarning[],
): Result<void, ProxyError> => {
  if (isString(content)) {
    messages.push({ role: "assistant", content });
    return ok(undefined);
  }
  const texts: string[] = [];
  const calls: ToolCall[] = [];
  for (const block of content) {
    if (block["type"] === "tool_use") {
      const { id, name, input } = block;
      if (!isString(id) || id === "" || !isString(name) || name === "") {
        return err({ kind: "translate", message: "Together tool call needs an ID and a name" });
      }
      calls.push({ id, type: "function", function: { name, arguments: JSON.stringify(input ?? {}) } });
    } else if (block["type"] === "text" && isString(block["text"])) {
      texts.push(block["text"]);
    } else if (block["type"] !== "thinking" && block["type"] !== "redacted_thinking") {
      warnings.push("unsupported_block_dropped");
    }
  }
  const first = calls[0];
  if (first !== undefined) {
    const reasoning = getTurnReasoning(first.id);
    messages.push({
      role: "assistant", content: texts.length > 0 ? texts.join("\n") : null, tool_calls: calls,
      ...(reasoning !== undefined ? { reasoning_content: reasoning } : {}),
    });
  } else if (texts.length > 0) {
    messages.push({ role: "assistant", content: texts.join("\n") });
  }
  return ok(undefined);
};

const mapTools = (tools: AnthropicRequest["tools"], warnings: TogetherRequestWarning[]): Tool[] => {
  const mapped: Tool[] = [];
  for (const tool of tools ?? []) {
    if (tool.input_schema === undefined || (tool["type"] !== undefined && tool["type"] !== "custom")) {
      warnings.push("unsupported_tool_skipped");
      continue;
    }
    mapped.push({ type: "function", function: {
      name: tool.name, parameters: { ...tool.input_schema },
      ...(tool.description !== undefined ? { description: tool.description } : {}),
    } });
  }
  return mapped;
};

const mapToolChoice = (choice: AnthropicRequest["tool_choice"], warnings: TogetherRequestWarning[]): ToolChoice | undefined => {
  if (choice === undefined) return undefined;
  switch (choice["type"]) {
    case "auto": return "auto";
    case "any": return "required";
    case "none": return "none";
    case "tool":
      if (isString(choice["name"]) && choice["name"] !== "") return { type: "function", function: { name: choice["name"] } };
      break;
  }
  warnings.push("unknown_tool_choice");
  return undefined;
};

const mapMessages = (
  request: AnthropicRequest,
  options: TogetherRequestOptions,
  capabilities: TogetherCapabilities,
  warnings: TogetherRequestWarning[],
): Result<TogetherMessage[], ProxyError> => {
  const messages: TogetherMessage[] = [];
  const instructions = buildInstructions(request.system);
  if (instructions) messages.push({ role: "system", content: instructions });
  const { conversationKey, getReasoning } = options;
  const getTurnReasoning = (id: string): string | undefined =>
    capabilities.reasoningReplay && conversationKey !== undefined
      ? getReasoning?.(reasoningKey(conversationKey, id))
      : undefined;
  for (const { role, content } of request.messages) {
    if (role === "system") {
      const text = buildInstructions(content);
      if (text) messages.push({ role: "system", content: text });
    } else if (role === "assistant" || role === "user") {
      const mapped = role === "assistant"
        ? mapAssistantTurn(content, getTurnReasoning, messages, warnings)
        : mapUserTurn(content, capabilities.images, messages, warnings);
      if (!mapped.ok) return mapped;
    } else {
      return err({ kind: "translate", message: "Together request has an unsupported message role" });
    }
  }
  return ok(messages);
};

/** Map parsed Anthropic input with the canonical model ID and user config cap. */
export const translateTogetherRequest = (
  request: AnthropicRequest,
  options: TogetherRequestOptions,
): Result<TogetherRequestOutcome, ProxyError> => {
  const { model, outputCap = TOGETHER_DEFAULT_OUTPUT_CAP, capabilities = TOGETHER_DEFAULT_CAPABILITIES } = options;
  const warnings: TogetherRequestWarning[] = [];
  const messages = mapMessages(request, options, capabilities, warnings);
  if (!messages.ok) return messages;
  const tools = mapTools(request.tools, warnings);
  const toolChoice = mapToolChoice(request.tool_choice, warnings);
  if (Object.hasOwn(request, "thinking")) warnings.push("thinking_dropped");

  const requested = request.max_tokens ?? outputCap;
  const applied = Math.min(requested, outputCap, capabilities.maxOutputTokens ?? outputCap);
  const stream = request.stream === true;
  const temperature = finiteNumber(request["temperature"]);
  const topP = finiteNumber(request["top_p"]);
  const stop = request["stop_sequences"];
  return ok({
    body: {
      model, messages: messages.value, max_tokens: applied, stream,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
      ...(tools.length > 0 ? { tools } : {}),
      ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
      ...(topP !== undefined ? { top_p: topP } : {}),
      ...(Array.isArray(stop) && stop.every(isString) ? { stop: [...stop] } : {}),
    },
    warnings,
    ...(applied < requested ? { clamp: { requested, applied } } : {}),
  });
};
