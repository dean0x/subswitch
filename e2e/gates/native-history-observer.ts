/** Allowlisted native input structure only: never returns instruction or tool content. */
import { object } from "./probe.js";

const itemTypes = new Set([
  "message",
  "agent_message",
  "additional_tools",
  "function_call",
  "function_call_output",
  "custom_tool_call",
  "custom_tool_call_output",
  "reasoning",
  "compaction",
]);
const roles = new Set(["system", "developer", "user", "assistant"]);
// Source-inspected Codex context fragment markers at
// 8c0f7011674145da7e10627769fb221c74fbf7a0. Classification is diagnostic only;
// a matching tag does not establish that an instruction can be translated safely.
const nativeTags = [
  ["<turn_aborted>", "turn_aborted"],
  ["<multi_agent_mode>", "multi_agent_mode"],
  ["<multi_agent_role>", "multi_agent_role"],
  ["<collaboration_mode>", "collaboration_mode"],
  ["<permissions instructions>", "permissions_instructions"],
  ["<managed_developer_instructions>", "managed_developer_instructions"],
  ["<current_time_reminder>", "current_time_reminder"],
  ["<current_time_unavailable>", "current_time_unavailable"],
  ["<model_catalog>", "model_catalog"],
  ["<model_switch>", "model_switch"],
] as const;

export function describeNativeHistory(body: Record<string, unknown>) {
  const input = Array.isArray(body["input"]) ? body["input"] : [];
  const initialInstructions = new Set<string>();
  let historyStarted = false;
  return input.slice(0, 512).map((value, index) => {
    const item = object(value);
    const rawRole = String(item?.["role"]);
    const role = roles.has(rawRole) ? rawRole : "none";
    const rawType = item?.["type"] ?? (role !== "none" ? "message" : "unknown");
    const type = itemTypes.has(String(rawType)) ? String(rawType) : "unknown";
    if (type !== "message") return { index, type, role };
    if (role !== "system" && role !== "developer") {
      historyStarted = true;
      return { index, type, role };
    }
    const content = item?.["content"];
    const blocks =
      typeof content === "string"
        ? [content]
        : Array.isArray(content)
          ? content.map((value) => object(value)?.["text"])
          : [];
    const texts =
      blocks.every((block) => typeof block === "string") && blocks.length
        ? (blocks as string[])
        : undefined;
    const identity = texts ? JSON.stringify(texts) : undefined;
    const text = texts?.length === 1 ? texts[0] : undefined;
    const matchesInitialInstruction =
      historyStarted &&
      identity !== undefined &&
      initialInstructions.has(identity);
    if (!historyStarted && identity !== undefined)
      initialInstructions.add(identity);
    const noticeCode =
      text === undefined
        ? "instruction_shape_unrecognized"
        : matchesInitialInstruction
          ? "repeated_initial_instruction"
          : (nativeTags.find(([tag]) => text.startsWith(tag))?.[1] ??
            "instruction_unrecognized");
    const containedNotices = nativeTags
      .filter(([tag]) => texts?.some((text) => text.includes(tag)))
      .map(([, code]) => code);
    return {
      index,
      type,
      role,
      noticeCode,
      matchesInitialInstruction,
      containedNotices,
    };
  });
}
