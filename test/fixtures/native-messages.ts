/** Fabricated native Messages output; no provider signatures or credentials. */
import type { Item } from "../../src/routing/routing-types.js";

export const nativeContent: Item[] = [
  { type: "thinking", thinking: "Fabricated thought: α\nline two", signature: "fabricated+/signature==" },
  { type: "redacted_thinking", data: "fabricated+/redacted==" },
  { type: "text", text: "Before tool" },
  { type: "tool_use", id: "toolu_fixture", name: "Read", input: { path: "fixture.txt" } },
  { type: "text", text: "After tool" },
];

export function nativeEvents(content: Item[] = nativeContent): Item[] {
  const events: Item[] = [{ type: "message_start", message: {
    id: "msg_fixture", type: "message", role: "assistant", model: "claude-sonnet-5",
    content: [], usage: { input_tokens: 7, output_tokens: 0 },
  } }];
  for (const [index, block] of content.entries()) {
    const start = { ...block };
    const deltas: Item[] = [];
    for (const [field, type] of [["text", "text_delta"], ["thinking", "thinking_delta"], ["signature", "signature_delta"]] as const) {
      if (typeof block[field] !== "string") continue;
      const value = block[field] as string;
      start[field] = value.slice(0, 1);
      for (const part of [value.slice(1, 5), value.slice(5)]) deltas.push({ type, [field!]: part });
    }
    if (block.type === "tool_use") {
      start.input = {};
      const json = JSON.stringify(block.input);
      for (const part of [json.slice(0, 5), json.slice(5)]) deltas.push({ type: "input_json_delta", partial_json: part });
    }
    events.push({ type: "content_block_start", index, content_block: start },
      ...deltas.map(delta => ({ type: "content_block_delta", index, delta })),
      { type: "content_block_stop", index });
  }
  events.push({ type: "message_delta", delta: {
    stop_reason: content.some(block => block.type === "tool_use") ? "tool_use" : "end_turn", stop_sequence: null,
  }, usage: { output_tokens: 9 } }, { type: "message_stop" });
  return events;
}

export const messageFrames = (events: Item[]) => events.map(event =>
  `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
