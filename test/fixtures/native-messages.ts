/** Fabricated native Messages output; no provider signatures or credentials. */
import type { Item } from "../../src/routing/routing-types.js";

export const nativeContent: Item[] = [
  { type: "thinking", thinking: "Fabricated thought: α\nline two", signature: "fabricated+/signature==" },
  { type: "redacted_thinking", data: "fabricated+/redacted==" },
  { type: "text", text: "Before tool" },
  { type: "tool_use", id: "toolu_fixture", name: "Read", input: { path: "fixture.txt" } },
  { type: "text", text: "After tool" },
];

export function nativeEvents(content: Item[] = nativeContent, options: { signatureInDeltas?: boolean } = {}): Item[] {
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
      if (field === "signature" && options.signatureInDeltas) {
        delete start[field];
        deltas.push({ type, [field]: value.slice(0, 1) });
      } else start[field] = value.slice(0, 1);
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

export const invalidSignedCases: readonly { name: string; block: Item; delta?: Item }[] = [
  { name: "missing thinking", block: { type: "thinking", signature: "fabricated-invalid" } },
  { name: "numeric thinking before a delta", block: { type: "thinking", thinking: 123, signature: "fabricated-invalid" }, delta: { type: "thinking_delta", thinking: "suffix" } },
  { name: "missing signature", block: { type: "thinking", thinking: "fabricated" } },
  { name: "numeric signature before a delta", block: { type: "thinking", thinking: "fabricated", signature: 123 }, delta: { type: "signature_delta", signature: "suffix" } },
  { name: "null signature", block: { type: "thinking", thinking: "fabricated", signature: null } },
  { name: "redacted data on thinking", block: { type: "thinking", thinking: "fabricated", signature: "fabricated-invalid", data: "forbidden" } },
  { name: "missing redacted data", block: { type: "redacted_thinking" } },
  { name: "object redacted data", block: { type: "redacted_thinking", data: {} } },
  { name: "numeric redacted data", block: { type: "redacted_thinking", data: 123 } },
  { name: "null redacted data", block: { type: "redacted_thinking", data: null } },
  { name: "thinking on redacted content", block: { type: "redacted_thinking", data: "fabricated", thinking: "" } },
  { name: "signature on redacted content", block: { type: "redacted_thinking", data: "fabricated", signature: "fabricated-invalid" } },
  { name: "numeric signature delta", block: { type: "thinking", thinking: "", signature: "fabricated-invalid" }, delta: { type: "signature_delta", signature: 123 } },
  { name: "object thinking delta", block: { type: "thinking", thinking: "", signature: "fabricated-invalid" }, delta: { type: "thinking_delta", thinking: {} } },
  { name: "signature delta on redacted content", block: { type: "redacted_thinking", data: "fabricated" }, delta: { type: "signature_delta", signature: "forbidden" } },
];

/** Valid signed prefix and a completed tool must stay unpublished on failure. */
export function invalidSignedEvents(testCase: (typeof invalidSignedCases)[number]): Item[] {
  const events = nativeEvents([nativeContent[0]!, nativeContent[3]!, testCase.block]);
  if (testCase.delta) {
    const stop = events.findIndex(event => event.type === "content_block_stop" && event.index === 2);
    events.splice(stop, 0, { type: "content_block_delta", index: 2, delta: testCase.delta });
  }
  return events;
}

export const messageFrames = (events: Item[]) => events.map(event =>
  `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
