import { object } from "../plain-object.js";
import { inputItems } from "../codex-body.js";
import { RoutingError, type Item, type WireProtocol } from "./routing-types.js";

export interface PortableTranscript {
  protocol: WireProtocol;
  instructions: unknown;
  entries: readonly Item[];
  tools: readonly Item[];
  toolErrors: ReadonlySet<string>;
  source: Item;
  hasOpaqueReasoning: boolean;
  hasThinking: boolean;
  hasResponsesExecDeclaration: boolean;
}
/** Decode supported native history once. Destination-owned reasoning remains opaque. */
export function decodePortableHistory(
  body: Item,
  protocol: WireProtocol,
): PortableTranscript {
  const entries =
    protocol === "responses"
      ? inputItems(body["input"])
      : Array.isArray(body["messages"])
        ? body["messages"].map((v) => object(v) ?? fail())
        : fail();
  const calls = new Set<string>(),
    results = new Set<string>(),
    errors = new Set<string>();
  let hasOpaqueReasoning = false,
    hasThinking = false;
  const textContent = (
    content: unknown,
    types: readonly string[],
    allowRefusal = false,
  ) => {
    if (typeof content === "string") return;
    if (!Array.isArray(content)) fail();
    for (const value of content) {
      const block = object(value) ?? fail();
      if (allowRefusal && block["type"] === "refusal") {
        if (typeof block["refusal"] !== "string") fail();
        continue;
      }
      if (
        !types.includes(String(block["type"])) ||
        typeof block["text"] !== "string"
      )
        fail();
    }
  };
  const roles = ["user", "assistant", "system", "developer"];
  const tools = Array.isArray(body["tools"])
    ? body["tools"].map((v) => object(v) ?? fail())
    : [];
  const call = (id: unknown) => {
    if (typeof id !== "string" || !id || calls.has(id)) fail();
    calls.add(id);
  };
  const result = (id: unknown, error: boolean) => {
    if (typeof id !== "string" || !calls.has(id) || results.has(id)) fail();
    results.add(id);
    if (error) errors.add(id);
  };
  for (const entry of entries) {
    if (protocol === "responses") {
      const type = entry["type"] ?? (entry["role"] ? "message" : "unknown");
      if (
        ![
          "message",
          "agent_message",
          "additional_tools",
          "function_call",
          "function_call_output",
          "custom_tool_call",
          "custom_tool_call_output",
          "reasoning",
        ].includes(String(type))
      )
        fail();
      if (
        entry["encrypted_function_args"] !== undefined &&
        (!Array.isArray(entry["encrypted_function_args"]) ||
          entry["encrypted_function_args"].length)
      )
        throw new RoutingError("foreign_opaque_state", 409);
      if (type === "message") {
        if (!roles.includes(String(entry["role"]))) fail();
        textContent(
          entry["content"],
          ["input_text", "output_text", "text"],
          entry["role"] === "assistant",
        );
      }
      if (type === "agent_message") {
        if (
          typeof entry["author"] !== "string" ||
          typeof entry["recipient"] !== "string"
        )
          fail();
        textContent(entry["content"], ["input_text", "output_text", "text"]);
      }
      if (type === "reasoning")
        hasOpaqueReasoning ||= typeof entry["encrypted_content"] === "string";
      if (type === "function_call" || type === "custom_tool_call")
        call(entry["call_id"]);
      if (
        type === "function_call_output" ||
        type === "custom_tool_call_output"
      ) {
        result(entry["call_id"], entry["is_error"] === true);
        textContent(entry["output"], ["input_text", "output_text", "text"]);
      }
      if (type === "additional_tools") {
        if (!Array.isArray(entry["tools"])) fail();
        for (const tool of entry["tools"]) tools.push(object(tool) ?? fail());
      }
    } else if (Array.isArray(entry["content"])) {
      if (!["user", "assistant", "system"].includes(String(entry["role"])))
        fail();
      for (const value of entry["content"]) {
        const block = object(value) ?? fail();
        if (
          ![
            "text",
            "tool_use",
            "tool_result",
            "thinking",
            "redacted_thinking",
          ].includes(String(block["type"]))
        )
          fail();
        if (entry["role"] === "system" && block["type"] !== "text") fail();
        if (block["type"] === "text" && typeof block["text"] !== "string")
          fail();
        if (
          block["type"] === "thinking" ||
          block["type"] === "redacted_thinking"
        )
          hasThinking = true;
        if (block["type"] === "tool_use") call(block["id"]);
        if (block["type"] === "tool_result")
          result(block["tool_use_id"], block["is_error"] === true);
        if (block["type"] === "tool_result")
          textContent(block["content"] ?? "", ["text"]);
      }
    } else if (
      typeof entry["content"] !== "string" ||
      !["user", "assistant", "system"].includes(String(entry["role"]))
    )
      fail();
  }
  if ([...calls].some((id) => !results.has(id)))
    throw new RoutingError("continuity_unavailable", 409);
  let hasResponsesExecDeclaration = false;
  const checkTools = (items: readonly Item[], depth = 0) => {
    if (depth > 4 || items.length > 1024) fail();
    for (const tool of items) {
      if (protocol === "messages") {
        if (typeof tool["name"] !== "string" || tool["type"] !== undefined)
          fail();
      } else if (tool["type"] === "namespace") {
        if (!Array.isArray(tool["tools"])) fail();
        checkTools(
          tool["tools"].map((v) => object(v) ?? fail()),
          depth + 1,
        );
      } else if (tool["type"] !== "function" && tool["type"] !== "custom")
        fail();
      // Reuse the original bounded traversal, including every temporal and
      // namespaced declaration. Ordinary history length cannot imply absence.
      else if (tool["name"] === "exec") hasResponsesExecDeclaration = true;
    }
  };
  checkTools(tools);
  const instructions =
    protocol === "messages" ? body["system"] : body["instructions"];
  if (instructions !== undefined && instructions !== null)
    textContent(instructions, ["text", "input_text"]);
  return {
    protocol,
    instructions:
      protocol === "messages" ? body["system"] : body["instructions"],
    entries,
    tools,
    toolErrors: errors,
    source: body,
    hasOpaqueReasoning,
    hasThinking,
    hasResponsesExecDeclaration,
  };
}
function fail(): never {
  throw new RoutingError("unsupported_routed_content");
}
/** Validate only the inline declarations preserved for Kimi's Responses wire format. */
function validateInlineTools(entry: Item): void {
  const fields = (item: Item, allowed: readonly string[]) => {
    if (Object.keys(item).some((key) => !allowed.includes(key))) fail();
  };
  const declaration = (value: unknown, nested = false): void => {
    const tool = object(value) ?? fail();
    if (typeof tool["name"] !== "string") fail();
    if (tool["description"] !== undefined && typeof tool["description"] !== "string")
      fail();
    if (tool["type"] === "function") {
      fields(tool, ["type", "name", "description", "parameters", "strict"]);
      if (!/^[a-zA-Z_][a-zA-Z0-9_-]{0,127}$/.test(tool["name"])) fail();
      if (tool["parameters"] !== undefined && !object(tool["parameters"])) fail();
      if (tool["strict"] !== undefined && typeof tool["strict"] !== "boolean") fail();
    } else if (tool["type"] === "custom") {
      fields(tool, ["type", "name", "description", "format"]);
      const format = object(tool["format"]) ?? fail();
      fields(format, ["type", "syntax", "definition"]);
      if (
        tool["name"] !== "apply_patch" ||
        format["type"] !== "grammar" ||
        format["syntax"] !== "lark" ||
        typeof format["definition"] !== "string"
      ) fail();
    } else if (tool["type"] === "namespace") {
      fields(tool, ["type", "name", "description", "tools"]);
      if (nested || typeof tool["description"] !== "string" || !Array.isArray(tool["tools"]))
        fail();
      for (const child of tool["tools"]) declaration(child, true);
    } else fail();
  };
  fields(entry, ["type", "role", "id", "tools"]);
  if (
    entry["role"] !== "developer" ||
    (entry["id"] !== undefined && typeof entry["id"] !== "string") ||
    !Array.isArray(entry["tools"])
  ) fail();
  // The published schema has no minItems or ID/declaration uniqueness constraint.
  // Preserve empty lists and repeated declarations at their original positions.
  for (const tool of entry["tools"]) declaration(tool);
}

/** Native agent identities become ordered, addressed text on non-native Responses destinations. */
export function renderResponsesHistory(
  transcript: PortableTranscript,
  preserveInlineTools = false,
): Item {
  if (transcript.protocol !== "responses") return transcript.source;
  if (preserveInlineTools)
    for (const entry of transcript.entries)
      if (entry["type"] === "additional_tools") validateInlineTools(entry);
  return {
    ...transcript.source,
    ...(preserveInlineTools ? {} : { tools: transcript.tools }),
    input: transcript.entries
      .filter((e) => preserveInlineTools || e["type"] !== "additional_tools")
      .map((e) => {
        if (e["type"] !== "agent_message") return e;
        if (
          typeof e["author"] !== "string" ||
          typeof e["recipient"] !== "string"
        )
          fail();
        const content =
          typeof e["content"] === "string"
            ? [{ type: "input_text", text: e["content"] }]
            : e["content"];
        if (!Array.isArray(content)) fail();
        return {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: `Agent message from ${e["author"]} to ${e["recipient"]}:`,
            },
            ...content,
          ],
        };
      }),
  };
}
