/** Responses/Responses-lite and Anthropic Messages protocol translation. */
import { createHash, randomUUID } from "node:crypto";
import { object, type ObjectValue as Item } from "./plain-object.js";
import { replayIdentity, type ReverseState } from "./claude-state.js";

export type { ObjectValue as Item } from "./plain-object.js";
import { ReverseContractError, type ClaudeErrorCode } from "./claude-errors.js";
import { CLAUDE_REASONING_EFFORTS, claudeModel, type ClaudeModel } from "./claude-models.js";
export { ReverseContractError } from "./claude-errors.js";
const fail = (code: ClaudeErrorCode, detail?: string): never => {
  throw new ReverseContractError(code, detail);
};
const string = (value: unknown): string => (typeof value === "string" ? value : fail("expected_string"));
const item = (value: unknown): Item => object(value) ?? fail("expected_object");
export interface ToolMapping {
  wire: string;
  name: string;
  namespace?: string;
  type: "function" | "custom";
  definition: Item;
}
export interface ReverseRequest {
  body: Item;
  tools: ReadonlyMap<string, ToolMapping>;
}

export function toolWireName(namespace: string | undefined, name: string, type: string): string {
  return `ss_${createHash("sha256")
    .update(JSON.stringify([namespace ?? null, name, type]))
    .digest("hex")
    .slice(0, 32)}`;
}

function content(value: unknown, toolResult = false): Item[] {
  if (typeof value === "string") return [{ type: "text", text: value }];
  if (!Array.isArray(value)) return fail("unsupported_content");
  return value.map((value) => {
    const block = item(value);
    if (["input_text", "output_text", "text"].includes(String(block["type"])))
      return { type: "text", text: string(block["text"]) };
    if (block["type"] === "input_image") {
      const url = string(block["image_url"]);
      const inline = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(url);
      if (inline) return { type: "image", source: { type: "base64", media_type: inline[1], data: inline[2] } };
      if (/^https:\/\//.test(url)) return { type: "image", source: { type: "url", url } };
      return fail("unsupported_image");
    }
    return fail(toolResult ? "unsupported_tool_result_content" : "unsupported_content_block");
  });
}

const collectTools = (request: Item, input: Item[]): ReadonlyMap<string, ToolMapping> => {
  const tools = new Map<string, ToolMapping>();
  if (request["tools"] !== undefined && !Array.isArray(request["tools"])) return fail("invalid_tools");
  const register = (definition: Item, namespace?: string): void => {
    if (definition["type"] === "namespace") {
      if (namespace || !Array.isArray(definition["tools"])) return fail("unsupported_namespace");
      for (const nested of definition["tools"]) register(item(nested), string(definition["name"]));
      return;
    }
    const type = definition["type"];
    if (type !== "function" && type !== "custom") return fail("unsupported_hosted_tool");
    const name = string(definition["name"]),
      wire = toolWireName(namespace, name, type);
    const existing = tools.get(wire);
    if (existing && JSON.stringify(existing.definition) !== JSON.stringify(definition))
      return fail("tool_definition_conflict");
    tools.set(wire, { wire, name, type, definition, ...(namespace === undefined ? {} : { namespace }) });
  };
  if (Array.isArray(request["tools"])) for (const definition of request["tools"]) register(item(definition));
  for (const entry of input)
    if (entry["type"] === "additional_tools") {
      if (!Array.isArray(entry["tools"])) return fail("invalid_additional_tools");
      for (const definition of entry["tools"]) register(item(definition));
    }
  return tools;
};

const lookupTool = (tools: ReadonlyMap<string, ToolMapping>, entry: Item, type: "function" | "custom"): ToolMapping => {
  const namespace = entry["namespace"] === undefined ? undefined : string(entry["namespace"]);
  return tools.get(toolWireName(namespace, string(entry["name"]), type)) ?? fail("unknown_tool");
};

const buildSystem = (request: Item, nativePreamble: readonly Item[]): Item[] => {
  const system: Item[] = [...nativePreamble];
  if (request["instructions"] !== undefined && request["instructions"] !== "") {
    system.push({ type: "text", text: string(request["instructions"]) });
  }
  return system;
};

const foldHistory = (input: Item[], system: Item[], tools: ReadonlyMap<string, ToolMapping>, state?: ReverseState) => {
  const messages: { role: "user" | "assistant"; content: Item[] }[] = [];
  const append = (role: "user" | "assistant", blocks: Item[]) => {
    if (!blocks.length) return;
    const last = messages.at(-1);
    if (last?.role === role) last.content.push(...blocks);
    else messages.push({ role, content: blocks });
  };
  const calls = new Set<string>(),
    results = new Set<string>();
  for (let inputIndex = 0; inputIndex < input.length; inputIndex++) {
    const entry = input[inputIndex]!;
    const type = entry["type"];
    if (type === "additional_tools") continue;
    if (type === "reasoning" && state) {
      const replay = state.open(string(entry["encrypted_content"]));
      const following = input.slice(inputIndex + 1, inputIndex + 1 + replay.output.length);
      if (
        following.some(
          (value) =>
            value["encrypted_function_args"] !== undefined &&
            (!Array.isArray(value["encrypted_function_args"]) || value["encrypted_function_args"].length),
        )
      )
        return fail("encrypted_tool_arguments");
      if (
        following.length !== replay.output.length ||
        following.some((value, index) => replayIdentity(value) !== replayIdentity(replay.output[index]!))
      ) {
        return fail("state_history_mismatch");
      }
      for (const block of replay.content)
        if (block["type"] === "tool_use") {
          const id = string(block["id"]);
          if (calls.has(id)) return fail("duplicate_tool_call");
          calls.add(id);
        }
      append("assistant", replay.content);
      inputIndex += following.length;
      continue;
    }
    if (type === "message" || (type === undefined && entry["role"] !== undefined)) {
      const role = entry["role"];
      if (role === "system" || role === "developer") {
        const blocks = content(entry["content"]);
        if (blocks.some((block) => block["type"] !== "text")) return fail("nontext_system");
        if (messages.length) {
          // Native Codex records cancellation as an ordered developer notice. It
          // describes the interrupted turn, so retain it at that point in history;
          // hoisting it into the system prompt would make it apply to later turns.
          const text = blocks.length === 1 ? blocks[0]?.["text"] : undefined;
          if (role === "developer" && typeof text === "string" && /^<turn_aborted>\n[^]*\n<\/turn_aborted>$/.test(text)) {
            append("user", blocks);
            continue;
          }
          return fail("mid_history_instructions_unimplemented");
        }
        system.push(...blocks);
      } else if (role === "user" || role === "assistant") append(role, content(entry["content"]));
      else return fail("unsupported_message_role");
    } else if (type === "agent_message") {
      const blocks = content(entry["content"]);
      append("user", [
        { type: "text", text: `Agent message from ${string(entry["author"])} to ${string(entry["recipient"])}:` },
        ...blocks,
      ]);
    } else if (type === "function_call" || type === "custom_tool_call") {
      if (
        entry["encrypted_function_args"] !== undefined &&
        (!Array.isArray(entry["encrypted_function_args"]) || entry["encrypted_function_args"].length)
      )
        return fail("encrypted_tool_arguments");
      const mapping = lookupTool(tools, entry, type === "function_call" ? "function" : "custom");
      const id = string(entry["call_id"]);
      if (calls.has(id)) return fail("duplicate_tool_call");
      calls.add(id);
      let args: Item;
      try {
        args =
          type === "custom_tool_call"
            ? { input: string(entry["input"]) }
            : item(JSON.parse(string(entry["arguments"])));
      } catch {
        return fail("invalid_tool_arguments");
      }
      append("assistant", [{ type: "tool_use", id, name: mapping.wire, input: args }]);
    } else if (type === "function_call_output" || type === "custom_tool_call_output") {
      const id = string(entry["call_id"]);
      if (!calls.has(id) || results.has(id)) return fail("unmatched_tool_result");
      results.add(id);
      append("user", [{ type: "tool_result", tool_use_id: id, content: content(entry["output"], true) }]);
    } else
      return fail(
        type === "reasoning" || type === "compaction" ? "opaque_state_unimplemented" : "unsupported_input_item",
      );
  }
  if ([...calls].some((id) => !results.has(id))) return fail("missing_tool_result");
  return messages;
};

const mapTools = (tools: ReadonlyMap<string, ToolMapping>) => {
  return [...tools.values()].map((mapping) => {
    const definition = mapping.definition;
    const description = definition["description"] === undefined ? "" : string(definition["description"]);
    return {
      name: mapping.wire,
      description:
        mapping.type === "custom"
          ? `${description}\nReturn the original freeform tool input verbatim in the input string. Tool format: ${JSON.stringify(definition["format"] ?? { type: "text" })}`
          : description,
      input_schema:
        mapping.type === "custom"
          ? {
              type: "object",
              properties: { input: { type: "string" } },
              required: ["input"],
              additionalProperties: false,
            }
          : item(definition["parameters"] ?? { type: "object", properties: {} }),
    };
  });
};

const resolveToolChoice = (request: Item, tools: ReadonlyMap<string, ToolMapping>): Item => {
  let choice: Item = { type: "auto" };
  if (request["tool_choice"] === "none") choice = { type: "none" };
  else if (request["tool_choice"] === "required") choice = { type: "any" };
  else if (object(request["tool_choice"])) {
    const selected = item(request["tool_choice"]);
    if (selected["type"] !== "function" && selected["type"] !== "custom") return fail("unsupported_tool_choice");
    choice = { type: "tool", name: lookupTool(tools, selected, selected["type"]).wire };
  } else if (request["tool_choice"] !== undefined && request["tool_choice"] !== "auto")
    return fail("unsupported_tool_choice");
  if (request["parallel_tool_calls"] === false && choice["type"] !== "none") choice["disable_parallel_tool_use"] = true;
  return choice;
};

/** "low, medium, high, xhigh, or max" */
const EFFORT_CHOICES = `${CLAUDE_REASONING_EFFORTS.slice(0, -1).join(", ")}, or ${CLAUDE_REASONING_EFFORTS.at(-1)}`;

/**
 * `model` is the canonical id, so it names a catalog entry or a configured alias target —
 * never raw client text. `capability` is undefined for an alias-bridged target the catalog
 * does not know: with no data, nothing is clamped or refused and the request goes as sent.
 */
const sampling = (request: Item, model: string, capability: ClaudeModel | undefined): Item => {
  const format = object(object(request["text"])?.["format"]);
  if (format && format["type"] !== "text") return fail("structured_output_unimplemented");
  const max = request["max_output_tokens"] ?? 4096;
  if (typeof max !== "number" || !Number.isSafeInteger(max) || max < 1) return fail("invalid_output_limit");
  const reasoning = object(request["reasoning"]);
  const effort = reasoning?.["effort"];
  if (effort !== undefined && !["none", ...CLAUDE_REASONING_EFFORTS].includes(String(effort)))
    return fail("unsupported_reasoning_effort");
  // Refused rather than rewritten: silently thinking anyway would change what the client asked for.
  if (effort === "none" && capability?.thinkingAlwaysOn)
    return fail(
      "reasoning_effort_unsupported_by_model",
      `\`${model}\` always thinks, so reasoning effort \`none\` cannot be honoured; use ${EFFORT_CHOICES}.`,
    );
  return {
    max_tokens: capability ? Math.min(max, capability.maxOutputTokens) : max,
    ...(effort === "none"
      ? { thinking: { type: "disabled" } }
      : effort !== undefined
        ? { thinking: { type: "adaptive" }, output_config: { effort } }
        : {}),
  };
};

/** Refused rather than downgraded to `auto`: the client asked for a call to be guaranteed. */
const requireToolChoiceSupport = (choice: Item, model: string, capability: ClaudeModel | undefined): void => {
  if ((choice["type"] === "any" || choice["type"] === "tool") && capability?.forcedToolChoice === false)
    fail(
      "tool_choice_unsupported_by_model",
      `\`${model}\` does not support forced tool choice (\`required\` or a named tool); use \`auto\`.`,
    );
};

/** Caller supplies complete native history. Unknown opaque state is an explicit error. */
export const reverseRequest = (
  request: Item,
  nativePreamble: readonly Item[] = [],
  state?: ReverseState,
): ReverseRequest => {
  const input =
    typeof request["input"] === "string"
      ? [{ type: "message", role: "user", content: request["input"] }]
      : Array.isArray(request["input"])
        ? request["input"].map(item)
        : fail("unsupported_input");
  const tools = collectTools(request, input);
  const system = buildSystem(request, nativePreamble);
  const messages = foldHistory(input, system, tools, state);
  const mappedTools = mapTools(tools);
  const choice = resolveToolChoice(request, tools);
  const model = string(request["model"]);
  const capability = claudeModel(model);
  // tool_choice is only sent alongside tools, so an unsent forced choice is not refused.
  if (mappedTools.length) requireToolChoiceSupport(choice, model, capability);
  return {
    tools,
    body: {
      model,
      ...sampling(request, model, capability),
      stream: false,
      cache_control: { type: "ephemeral" },
      ...(system.length ? { system } : {}),
      messages,
      ...(mappedTools.length ? { tools: mappedTools, tool_choice: choice } : {}),
    },
  };
};

/** Completed JSON only. Partial/truncated arguments never become executable native calls. */
export function reverseResponse(
  response: Item,
  request: ReverseRequest,
  state?: ReverseState,
  identities?: ReadonlyMap<number, string>,
  stateToken?: string,
): Item[] {
  const upstreamString = (value: unknown): string =>
    typeof value === "string" ? value : fail("invalid_claude_response");
  const upstreamItem = (value: unknown): Item => object(value) ?? fail("invalid_claude_response");
  if (response["type"] !== "message" || !Array.isArray(response["content"])) return fail("invalid_claude_response");
  if (response["stop_reason"] !== "end_turn" && response["stop_reason"] !== "tool_use")
    return fail("incomplete_claude_response");
  const output: Item[] = [];
  const callIds = new Set<string>();
  for (const [blockIndex, value] of response["content"].entries()) {
    const block = upstreamItem(value);
    if (block["type"] === "text") {
      upstreamString(block["text"]);
      output.push({
        type: "message",
        id: identities?.get(blockIndex) ?? `msg_${randomUUID()}`,
        role: "assistant",
        phase: response["stop_reason"] === "tool_use" ? "commentary" : "final_answer",
        status: "completed",
        content: [{ type: "output_text", text: block["text"], annotations: [] }],
      });
    } else if (block["type"] === "tool_use") {
      const mapping = request.tools.get(upstreamString(block["name"])) ?? fail("unknown_claude_tool");
      const args = upstreamItem(block["input"]),
        callId = upstreamString(block["id"]);
      if (!callId || callIds.has(callId)) return fail("duplicate_or_missing_tool_call_id");
      callIds.add(callId);
      const common = {
        id: identities?.get(blockIndex) ?? `fc_${randomUUID()}`,
        call_id: callId,
        name: mapping.name,
        status: "completed",
        ...(mapping.namespace === undefined ? {} : { namespace: mapping.namespace }),
      };
      if (mapping.type === "custom") {
        if (Object.keys(args).length !== 1) return fail("invalid_custom_tool_input");
        output.push({ ...common, type: "custom_tool_call", input: upstreamString(args["input"]) });
      } else
        output.push({
          ...common,
          type: "function_call",
          arguments: JSON.stringify(args),
          ...(mapping.namespace === "collaboration" ? { encrypted_function_args: [] } : {}),
        });
    } else if (block["type"] === "thinking" || block["type"] === "redacted_thinking") {
      if (!state) return fail("claude_thinking_state_unimplemented");
    } else return fail("unsupported_claude_output");
  }
  const toolCount = output.filter((entry) => entry["type"] !== "message").length;
  if ((response["stop_reason"] === "tool_use") !== toolCount > 0) return fail("inconsistent_stop_reason");
  if (state) {
    output.unshift({
      type: "reasoning",
      id: `rs_${randomUUID()}`,
      summary: [],
      encrypted_content: stateToken ?? state.seal({ content: response["content"] as Item[], output: [...output] }),
    });
  }
  return output;
}

/** Responses event construction, independent of HTTP versus WebSockets. */
export function reverseEvents(id: string, model: string, output: Item[], usage: Item = {}): Item[] {
  const base = {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model,
    status: "in_progress",
    output: [],
  };
  const frames: Item[] = [
    { type: "response.created", response: base },
    { type: "response.in_progress", response: base },
  ];
  output.forEach((entry, output_index) => {
    const type = entry["type"],
      item_id = entry["id"];
    frames.push({
      type: "response.output_item.added",
      output_index,
      item: {
        ...entry,
        status: "in_progress",
        ...(type === "function_call"
          ? { arguments: "" }
          : type === "custom_tool_call"
            ? { input: "" }
            : { content: [] }),
      },
    });
    if (type === "message") {
      const part = (entry["content"] as Item[])[0]!;
      const info = { item_id, output_index, content_index: 0 };
      frames.push(
        { type: "response.content_part.added", ...info, part: { ...part, text: "" } },
        { type: "response.output_text.delta", ...info, delta: part["text"] },
        { type: "response.output_text.done", ...info, text: part["text"] },
        { type: "response.content_part.done", ...info, part },
      );
    } else if (type === "function_call" || type === "custom_tool_call") {
      const custom = type === "custom_tool_call",
        field = custom ? "input" : "arguments";
      const stem = custom ? "response.custom_tool_call_input" : "response.function_call_arguments";
      frames.push(
        { type: `${stem}.delta`, item_id, output_index, delta: entry[field] },
        { type: `${stem}.done`, item_id, output_index, [field]: entry[field] },
      );
    }
    frames.push({ type: "response.output_item.done", output_index, item: entry });
  });
  const count = (value: unknown) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const cached = count(usage["cache_read_input_tokens"]);
  const inputTokens = count(usage["input_tokens"]) + count(usage["cache_creation_input_tokens"]) + cached;
  const outputTokens = count(usage["output_tokens"]);
  frames.push({
    type: "response.completed",
    response: {
      ...base,
      status: "completed",
      output,
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
        input_tokens_details: { cached_tokens: cached },
      },
    },
  });
  return frames.map((frame, sequence_number) => ({ ...frame, sequence_number }));
}
