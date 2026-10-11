import { randomUUID } from "node:crypto";
import { object } from "./claude-contract.js";
import {
  reverseResponse,
  reverseEvents,
  ReverseContractError,
  type Item,
  type ReverseRequest,
} from "./claude-adapter.js";
import type { ReverseState } from "./claude-state.js";
import type { SseEvent } from "./codex-response.js";

interface BlockState {
  block: Item;
  open: boolean;
  arguments: string;
  streamed: boolean;
  id?: string;
  outputIndex?: number;
}
type StreamPhase = "awaiting_start" | "streaming" | "finished";
interface StreamOptions {
  id: string;
  model: string;
  request: ReverseRequest;
  state: ReverseState;
  maxBytes: number;
}

/** Incremental text with authenticated thinking replay; executable calls commit only at message_stop. */
export async function* translateClaudeStream(
  source: AsyncIterable<SseEvent>,
  options: StreamOptions,
): AsyncGenerator<Item> {
  const { id, model } = options;
  const reasoningId = `rs_${randomUUID()}`;
  const replay = options.state.begin();
  const base = {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model,
    status: "in_progress",
    output: [],
  };
  let sequence = 0,
    size = 0,
    nextOutput = 1;
  let phase: StreamPhase = "awaiting_start";
  let stopReason: unknown,
    usage: Item = {};
  const blocks: BlockState[] = [];
  let toolSeen = false;
  const frame = (event: Item): Item => ({ ...event, sequence_number: sequence++ });
  function fail(code: import("./claude-errors.js").ClaudeErrorCode): never {
    throw new ReverseContractError(code);
  }
  for await (const incoming of source) {
    size += Buffer.byteLength(incoming.data);
    if (size > options.maxBytes) fail("claude_response_too_large");
    let event: Item | undefined;
    try {
      event = object(JSON.parse(incoming.data));
    } catch {
      fail("invalid_claude_event");
    }
    if (!event || typeof event["type"] !== "string") fail("invalid_claude_event");
    if (event["type"] === "ping") continue;
    if (phase === "finished") fail("claude_event_after_terminal");
    if (event["type"] === "error") fail("claude_stream_error");
    if (event["type"] === "message_start") {
      if (phase !== "awaiting_start") fail("duplicate_claude_start");
      const message = object(event["message"]);
      if (message?.["type"] !== "message") fail("invalid_claude_start");
      phase = "streaming";
      usage = object(message["usage"]) ?? {};
      yield frame({ type: "response.created", response: base });
      yield frame({ type: "response.in_progress", response: base });
      const reasoning = { type: "reasoning", id: reasoningId, summary: [], encrypted_content: replay.token };
      yield frame({ type: "response.output_item.added", output_index: 0, item: reasoning });
      yield frame({ type: "response.output_item.done", output_index: 0, item: reasoning });
      continue;
    }
    if (phase !== "streaming") fail("missing_claude_start");
    if (event["type"] === "content_block_start") {
      const index = event["index"],
        block = object(event["content_block"]);
      if (typeof index !== "number" || index !== blocks.length || !block) fail("invalid_claude_block_index");
      if (!["text", "tool_use", "thinking", "redacted_thinking"].includes(String(block["type"])))
        fail("unsupported_claude_output");
      const state: BlockState = { block: { ...block }, open: true, arguments: "", streamed: false };
      blocks.push(state);
      if (block["type"] === "tool_use") {
        toolSeen = true;
        if (typeof block["name"] !== "string" || !options.request.tools.has(block["name"])) fail("unknown_claude_tool");
      }
      if (block["type"] === "text" || block["type"] === "tool_use") {
        const itemId = `${block["type"] === "text" ? "msg" : "fc"}_${randomUUID()}`;
        state.id = itemId;
        state.outputIndex = nextOutput++;
        if (block["type"] === "text" && !toolSeen) {
          state.streamed = true;
          const output_index = state.outputIndex;
          yield frame({
            type: "response.output_item.added",
            output_index,
            item: {
              type: "message",
              id: itemId,
              role: "assistant",
              status: "in_progress",
              phase: "final_answer",
              content: [],
            },
          });
          yield frame({
            type: "response.content_part.added",
            output_index,
            item_id: itemId,
            content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
          });
          if (typeof block["text"] === "string" && block["text"])
            yield frame({
              type: "response.output_text.delta",
              output_index,
              item_id: itemId,
              content_index: 0,
              delta: block["text"],
            });
        }
      }
    } else if (event["type"] === "content_block_delta") {
      const index = event["index"],
        delta = object(event["delta"]);
      if (typeof index !== "number" || !blocks[index]?.open || !delta) fail("invalid_claude_delta");
      const state = blocks[index]!;
      const block = state.block;
      if (delta["type"] === "text_delta" && block["type"] === "text" && typeof delta["text"] === "string") {
        block["text"] = String(block["text"] ?? "") + delta["text"];
        if (state.streamed)
          yield frame({
            type: "response.output_text.delta",
            item_id: state.id,
            output_index: state.outputIndex,
            content_index: 0,
            delta: delta["text"],
          });
      } else if (
        delta["type"] === "input_json_delta" &&
        block["type"] === "tool_use" &&
        typeof delta["partial_json"] === "string"
      ) {
        state.arguments += delta["partial_json"];
      } else if (
        delta["type"] === "thinking_delta" &&
        block["type"] === "thinking" &&
        typeof delta["thinking"] === "string"
      ) {
        block["thinking"] = String(block["thinking"] ?? "") + delta["thinking"];
      } else if (
        delta["type"] === "signature_delta" &&
        block["type"] === "thinking" &&
        typeof delta["signature"] === "string"
      ) {
        block["signature"] = String(block["signature"] ?? "") + delta["signature"];
      } else fail("unsupported_claude_delta");
    } else if (event["type"] === "content_block_stop") {
      const index = event["index"];
      if (typeof index !== "number" || !blocks[index]?.open) fail("invalid_claude_block_stop");
      blocks[index]!.open = false;
      const partial = blocks[index]!.arguments;
      if (partial) {
        try {
          blocks[index]!.block["input"] = object(JSON.parse(partial)) ?? fail("invalid_claude_tool_arguments");
        } catch {
          fail("invalid_claude_tool_arguments");
        }
      }
    } else if (event["type"] === "message_delta") {
      const delta = object(event["delta"]);
      if (!delta) fail("invalid_claude_message_delta");
      if (delta["stop_reason"] !== undefined && delta["stop_reason"] !== null) stopReason = delta["stop_reason"];
      usage = { ...usage, ...object(event["usage"]) };
    } else if (event["type"] === "message_stop") {
      phase = "finished";
      for (const event of emitTerminal(options, blocks, stopReason, usage, reasoningId, replay)) yield frame(event);
    } else fail("unsupported_claude_event");
  }
  if (phase !== "finished") fail("missing_claude_terminal");
}

/** Validate a complete message before committing replay state or executable tool calls. */
function* emitTerminal(
  options: StreamOptions,
  blocks: BlockState[],
  stopReason: unknown,
  usage: Item,
  reasoningId: string,
  replay: ReturnType<ReverseState["begin"]>,
): Generator<Item> {
  const fail = (code: import("./claude-errors.js").ClaudeErrorCode): never => {
    throw new ReverseContractError(code);
  };
  if (blocks.some((block) => block.open)) fail("unterminated_claude_block");
  // A late refusal cannot relabel output_text deltas already delivered. The relay
  // retains that text and synthesizes an incomplete/content_filter terminal instead.
  // This is a wire translation, not a claim of vendor refusal equivalence.
  const incompleteReason = stopReason === "max_tokens"
    ? "max_output_tokens"
    : stopReason === "refusal"
      ? "content_filter"
      : undefined;
  const incomplete = incompleteReason !== undefined;
  const content = blocks.map((entry) => entry.block);
  const identities = new Map(blocks.flatMap((entry, index) => (entry.id ? [[index, entry.id] as const] : [])));
  const streamedText = new Set(blocks.filter((entry) => entry.streamed).map((entry) => entry.id));
  const response = {
    type: "message",
    stop_reason: incomplete ? "end_turn" : stopReason,
    content: incomplete ? content.filter((block) => block["type"] === "text") : content,
  };
  const selectedIdentities = incomplete
    ? new Map(
        content
          .map((block, index) => ({ block, id: identities.get(index) }))
          .filter((entry) => entry.block["type"] === "text")
          .map((entry, index) => [index, entry.id!]),
      )
    : identities;
  const output = reverseResponse(response, options.request, options.state, selectedIdentities, replay.token);
  output[0]!["id"] = reasoningId;
  replay.commit({ content: response.content, output: output.slice(1) });
  const complete = reverseEvents(options.id, options.model, output, usage);
  for (const event of complete) {
    const type = event["type"];
    if (["response.created", "response.in_progress"].includes(String(type))) continue;
    if (type === "response.output_item.done" && object(event["item"])?.["type"] === "reasoning") continue;
    if (
      type === "response.output_item.added" &&
      (object(event["item"])?.["type"] === "reasoning" || streamedText.has(String(object(event["item"])?.["id"])))
    )
      continue;
    if (
      (type === "response.content_part.added" || type === "response.output_text.delta") &&
      streamedText.has(String(event["item_id"]))
    )
      continue;
    if (type === "response.completed" && incomplete) {
      yield {
        type: "response.incomplete",
        response: {
          ...object(event["response"]),
          status: "incomplete",
            incomplete_details: { reason: incompleteReason },
        },
      };
    } else yield event;
  }
}
