import { type Result, ok, err } from "./result.js";
import type { ProxyError } from "./errors.js";
import type { ReasoningCache } from "./reasoning-cache.js";
import type { AnthropicRequest, AnthropicMessage } from "./anthropic-wire-types.js";
import { buildInstructions } from "./anthropic-parse.js";

/**
 * Warnings are closed codes (never request content) so they can be logged
 * without violating the redaction policy.
 */
export type TranslateWarning =
  | "image_dropped"
  | "unsupported_block_dropped"
  | "unsupported_tool_skipped"
  | "reasoning_cache_miss"
  | "unknown_tool_choice"
  | "unsupported_effort_dropped";

export interface TranslateOutcome {
  readonly body: Record<string, unknown>;
  readonly stream: boolean;
  readonly warnings: readonly TranslateWarning[];
  readonly effort?: string;
  /** Derived conversation key (v7-shaped UUID) used for prompt_cache_key and session_id. */
  readonly conversationKey?: string;
}

type Block = Record<string, unknown>;

const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

const textOfBlocks = (blocks: readonly Block[]): string =>
  blocks
    .filter((block) => block["type"] === "text")
    .map((block) => asString(block["text"]) ?? "")
    .join("\n\n");

const flattenToolResultContent = (content: unknown, warnings: TranslateWarning[]): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const entry of content) {
    if (typeof entry !== "object" || entry === null) continue;
    const block = entry as Block;
    if (block["type"] === "text") {
      parts.push(asString(block["text"]) ?? "");
    } else {
      warnings.push(block["type"] === "image" ? "image_dropped" : "unsupported_block_dropped");
    }
  }
  return parts.join("\n");
};

interface InputBuilder {
  readonly items: Record<string, unknown>[];
  readonly warnings: TranslateWarning[];
  readonly injectedReasoningIds: Set<string>;
}

const pushMessageItem = (builder: InputBuilder, role: "user" | "assistant", texts: string[]): void => {
  if (texts.length === 0) return;
  const contentType = role === "user" ? "input_text" : "output_text";
  builder.items.push({
    type: "message",
    role,
    content: texts.map((text) => ({ type: contentType, text })),
  });
  texts.length = 0;
};

const translateUserMessage = (builder: InputBuilder, message: AnthropicMessage): void => {
  if (typeof message.content === "string") {
    pushMessageItem(builder, "user", [message.content]);
    return;
  }
  const pendingTexts: string[] = [];
  for (const block of message.content) {
    switch (block["type"]) {
      case "text":
        pendingTexts.push(asString(block["text"]) ?? "");
        break;
      case "tool_result": {
        pushMessageItem(builder, "user", pendingTexts);
        builder.items.push({
          type: "function_call_output",
          call_id: asString(block["tool_use_id"]) ?? "",
          output: flattenToolResultContent(block["content"], builder.warnings),
        });
        break;
      }
      case "image":
        builder.warnings.push("image_dropped");
        break;
      default:
        builder.warnings.push("unsupported_block_dropped");
        break;
    }
  }
  pushMessageItem(builder, "user", pendingTexts);
};

const injectReasoningItems = (builder: InputBuilder, cache: ReasoningCache, callId: string): void => {
  const items = cache.get(callId);
  if (items === undefined) {
    // Degraded, not broken: the model loses its prior chain-of-thought but the
    // conversation still round-trips.
    builder.warnings.push("reasoning_cache_miss");
    return;
  }
  for (const item of items) {
    const id = typeof item === "object" && item !== null ? asString((item as Block)["id"]) : undefined;
    if (id !== undefined) {
      if (builder.injectedReasoningIds.has(id)) continue;
      builder.injectedReasoningIds.add(id);
    }
    builder.items.push(item as Record<string, unknown>);
  }
};

/**
 * Claude Code's subagent harness sends system prompts as a `system`-role entry
 * inside messages[] (verified live). The Responses API models these as
 * developer-role input messages.
 */
const translateSystemMessage = (builder: InputBuilder, message: AnthropicMessage): void => {
  const text =
    typeof message.content === "string" ? message.content : textOfBlocks(message.content as readonly Block[]);
  if (text === "") return;
  builder.items.push({
    type: "message",
    role: "developer",
    content: [{ type: "input_text", text }],
  });
};

const translateAssistantMessage = (builder: InputBuilder, cache: ReasoningCache, message: AnthropicMessage): void => {
  if (typeof message.content === "string") {
    pushMessageItem(builder, "assistant", [message.content]);
    return;
  }
  const pendingTexts: string[] = [];
  for (const block of message.content) {
    switch (block["type"]) {
      case "text":
        pendingTexts.push(asString(block["text"]) ?? "");
        break;
      case "tool_use": {
        pushMessageItem(builder, "assistant", pendingTexts);
        const callId = asString(block["id"]) ?? "";
        injectReasoningItems(builder, cache, callId);
        builder.items.push({
          type: "function_call",
          call_id: callId,
          name: asString(block["name"]) ?? "",
          arguments: JSON.stringify(block["input"] ?? {}),
        });
        break;
      }
      case "thinking":
      case "redacted_thinking":
        // Reasoning round-trips through the server-side cache, never through
        // Anthropic thinking blocks.
        break;
      default:
        builder.warnings.push("unsupported_block_dropped");
        break;
    }
  }
  pushMessageItem(builder, "assistant", pendingTexts);
};

const translateTools = (
  tools: AnthropicRequest["tools"],
  warnings: TranslateWarning[],
): Record<string, unknown>[] | undefined => {
  if (tools === undefined || tools.length === 0) return undefined;
  const translated: Record<string, unknown>[] = [];
  for (const tool of tools) {
    if (tool.input_schema === undefined) {
      // Server-side tools (web_search etc.) have no client-side schema and
      // cannot be expressed as Responses function tools.
      warnings.push("unsupported_tool_skipped");
      continue;
    }
    translated.push({
      type: "function",
      name: tool.name,
      description: tool.description ?? "",
      parameters: stripCacheControl(tool.input_schema),
      strict: false,
    });
  }
  return translated.length > 0 ? translated : undefined;
};

const translateToolChoice = (
  toolChoice: Record<string, unknown> | undefined,
  warnings: TranslateWarning[],
): unknown => {
  if (toolChoice === undefined) return undefined;
  switch (toolChoice["type"]) {
    case "auto":
      return "auto";
    case "any":
      return "required";
    case "none":
      return "none";
    case "tool":
      return { type: "function", name: asString(toolChoice["name"]) ?? "" };
    default:
      warnings.push("unknown_tool_choice");
      return undefined;
  }
};

const stripCacheControl = (value: Record<string, unknown>): Record<string, unknown> => {
  const { cache_control: _dropped, ...rest } = value;
  return rest;
};

// Effort values the Codex backend accepts for reasoning.effort (its own 400
// error enumerates exactly this set; verified live 2026-07-21). Claude Code's
// `effort` agent frontmatter arrives as output_config.effort with a subset of
// these values, so mapping is a direct pass-through.
const CODEX_EFFORT_VALUES = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

const translateEffort = (
  outputConfig: AnthropicRequest["output_config"],
  warnings: TranslateWarning[],
): string | undefined => {
  const effort = outputConfig?.effort;
  if (effort === undefined) return undefined;
  if (!CODEX_EFFORT_VALUES.has(effort)) {
    // Effort is a hint: an unrecognized value degrades to the backend default
    // instead of failing the whole request with an upstream 400.
    warnings.push("unsupported_effort_dropped");
    return undefined;
  }
  return effort;
};

export const translateRequest = (
  request: AnthropicRequest,
  cache: ReasoningCache,
  conversationKey?: string,
): Result<TranslateOutcome, ProxyError> => {
  const builder: InputBuilder = { items: [], warnings: [], injectedReasoningIds: new Set() };

  for (const message of request.messages) {
    if (message.role === "user") {
      translateUserMessage(builder, message);
    } else if (message.role === "assistant") {
      translateAssistantMessage(builder, cache, message);
    } else if (message.role === "system") {
      translateSystemMessage(builder, message);
    } else {
      return err({ kind: "translate", message: `unsupported message role: ${message.role}` });
    }
  }

  const instructions = buildInstructions(request.system);
  const tools = translateTools(request.tools, builder.warnings);
  const toolChoice = translateToolChoice(request.tool_choice, builder.warnings);
  const effort = translateEffort(request.output_config, builder.warnings);

  const body: Record<string, unknown> = {
    model: request.model,
    input: builder.items,
    stream: true,
    store: false,
    include: ["reasoning.encrypted_content"],
    parallel_tool_calls: true,
    ...(instructions !== undefined ? { instructions } : {}),
    ...(tools !== undefined ? { tools } : {}),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    ...(effort !== undefined ? { reasoning: { effort } } : {}),
    // max_tokens is intentionally not mapped: the Codex backend rejects
    // max_output_tokens with 400 "Unsupported parameter" (verified live). [avoids PF-002]
    ...(conversationKey !== undefined ? { prompt_cache_key: conversationKey } : {}),
  };

  return ok({
    body,
    stream: request.stream === true,
    warnings: builder.warnings,
    ...(effort !== undefined ? { effort } : {}),
    ...(conversationKey !== undefined ? { conversationKey } : {}),
  });
};

/** chars/4 heuristic for the count_tokens stub — close enough for context bookkeeping. */
export const estimateTokens = (rawBody: Buffer | string): number => Math.ceil(rawBody.length / 4);
