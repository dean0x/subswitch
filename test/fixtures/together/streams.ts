import { chatChunk, chatSse } from "../../helpers/chat-sse.js";

export const toolDelta = (index: number, name?: string | null, args?: string, id?: string | null) => ({
  index, id, type: "function", function: { name, arguments: args },
});

export const lateToolNames = chatSse([
  chatChunk({ tool_calls: [toolDelta(1, null, '{"b":', null), toolDelta(0, "first", '{"a":')] }),
  chatChunk({ tool_calls: [toolDelta(1, "second", "2}"), toolDelta(0, null, "1}")] }),
  chatChunk({}, "stop"),
  { choices: [], usage: { prompt_tokens: 37, completion_tokens: 11 } },
  "[DONE]",
  chatChunk({ content: "must not appear after DONE" }),
]);

export const repeatedToolIds = chatSse([
  chatChunk({ tool_calls: [
    toolDelta(0, "first", "{}"), toolDelta(1, "second", "{}", "repeated_upstream_id"),
    toolDelta(2, "third", "{}", "repeated_upstream_id"), toolDelta(3, "fourth", "{}", "upstream|invalid"),
  ] }),
  chatChunk({}, "tool_calls"),
  "[DONE]",
]);

export const textTurn = (finishReason: string) => chatSse([
  chatChunk({ role: "assistant", content: null }),
  chatChunk({ content: "Hello" }),
  chatChunk({}, finishReason),
  "[DONE]",
]);
