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
  };
}
function fail(): never {
  throw new RoutingError("unsupported_routed_content");
}
/** Native agent identities become ordered, addressed text on non-native Responses destinations. */
export function renderResponsesHistory(transcript: PortableTranscript): Item {
  if (transcript.protocol !== "responses") return transcript.source;
  return {
    ...transcript.source,
    tools: transcript.tools,
    input: transcript.entries
      .filter((e) => e["type"] !== "additional_tools")
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
