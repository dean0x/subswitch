import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createSseParser, type SseEvent } from "../codex-response.js";
import { object } from "../plain-object.js";
import { classifyFailure } from "./provider-failure.js";
import { AttemptFailure } from "./attempt-failure.js";
import { scheduleRoutingTimer, type RoutingClock } from "./clock.js";
import {
  RoutingError,
  type AccessProfile,
  type Item,
  type WireProtocol,
} from "./routing-types.js";
import type { Logger } from "../logger.js";
import { recordLimitEvent, recordLimitFailure, type LimitContext } from "../limit-observation.js";

/** Validate incrementally; withhold executable tools until the provider's valid terminal. */
export async function* validatedProviderEvents(
  response: Response,
  p: AccessProfile,
  protocol: WireProtocol,
  signal: AbortSignal,
  controller: AbortController,
  clock: RoutingClock,
  onComplete: (final: Item) => void,
  logger?: Logger,
  limitContext?: LimitContext,
): AsyncGenerator<SseEvent> {
  if (!response.body) throw new RoutingError("missing_provider_body", 502);
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  // The existing Codex subscription transport validates SSE bytes, independently
  // of MIME. Its live endpoint may use a non-SSE MIME; preserve that contract.
  // Every routed stream still needs a valid start event before commitment.
  if (
    p.product !== "chatgpt-codex" &&
    !contentType.includes("text/event-stream")
  )
    throw new RoutingError(
      contentType.includes("html")
        ? "provider_response_html"
        : contentType.includes("json")
          ? "provider_response_json"
          : "provider_content_type_unverified",
      502,
    );
  const source = Readable.fromWeb(
    response.body as import("node:stream/web").ReadableStream<Uint8Array>,
  );
  const parser = createSseParser(4 * 1024 * 1024, true);
  let sourceFailure: unknown;
  let parserFailed = false;
  // Pipeline propagates a source error through the parser. Preserve which surface
  // failed first, so a parser rejection that destroys its source stays a protocol failure.
  const onSourceError = (error: unknown) => {
    if (!parserFailed) sourceFailure = error;
  };
  const onParserError = () => {
    parserFailed = true;
  };
  source.on("error", onSourceError);
  parser.on("error", onParserError);
  let cancelIdle: (() => void) | undefined;
  const reset = () => {
    cancelIdle?.();
    cancelIdle = scheduleRoutingTimer(clock, () => controller.abort(), 300000);
  };
  source.on("data", reset);
  reset();
  const running = pipeline(source, parser, { signal }).catch((e) =>
    parser.destroy(e as Error),
  );
  let started = false,
    terminal = false,
    prefixBytes = 0,
    prefixEvents = 0;
  let responseId: string | undefined;
  const pendingTools: SseEvent[] = [];
  let pendingBytes = 0;
  const holdTool = (event: SseEvent) => {
    pendingBytes += Buffer.byteLength(event.data);
    if (pendingBytes + stateBytes > 32 * 1024 * 1024)
      throw new RoutingError("provider_state_too_large", 502);
    pendingTools.push(event);
  };
  const blocks = new Map<
    number,
    { type: string; arguments: string; closed: boolean; content: Item }
  >();
  let stateBytes = 0;
  let stopReason: unknown;
  try {
    for await (const event of parser as AsyncIterable<SseEvent>) {
      signal.throwIfAborted();
      if (event.event === "__subswitch_comment") {
        if (
          !started &&
          (++prefixEvents > 16 ||
            (prefixBytes += Buffer.byteLength(event.data)) > 65536)
        )
          throw new RoutingError("provider_prefix_limit", 502);
        continue;
      }
      if (terminal)
        throw new RoutingError("provider_event_after_terminal", 502);
      if (event.data === "[DONE]") continue;
      let value: Item | undefined;
      try {
        value = object(JSON.parse(event.data));
      } catch {
        if (logger && limitContext && ["error", "response.failed"].includes(event.event ?? ""))
          recordLimitFailure(logger, limitContext, { transport: "sse", committed: "unknown",
            providerStartSeen: started, headers: response.headers, text: event.data,
            truncated: Buffer.byteLength(event.data) > 65536 });
        throw new RoutingError("invalid_provider_event", 502);
      }
      const type = value?.["type"];
      if (typeof type !== "string")
        throw new RoutingError("invalid_provider_event", 502);
      if (
        !type.startsWith("response.") &&
        ![
          "message_start",
          "content_block_start",
          "content_block_delta",
          "content_block_stop",
          "message_delta",
          "message_stop",
          "ping",
          "error",
        ].includes(type)
      )
        throw new RoutingError("unsupported_provider_event", 502);
      if (
        type.startsWith("response.") &&
        ![
          "response.created",
          "response.in_progress",
          "response.output_item.added",
          "response.output_item.done",
          "response.content_part.added",
          "response.content_part.done",
          "response.output_text.delta",
          "response.output_text.done",
          "response.refusal.delta",
          "response.refusal.done",
          "response.function_call_arguments.delta",
          "response.function_call_arguments.done",
          "response.custom_tool_call_input.delta",
          "response.custom_tool_call_input.done",
          "response.reasoning_summary_part.added",
          "response.reasoning_summary_part.done",
          "response.reasoning_summary_text.delta",
          "response.reasoning_summary_text.done",
          "response.reasoning_text.delta",
          "response.reasoning_text.done",
          "response.completed",
          "response.incomplete",
          "response.failed",
        ].includes(type)
      )
        throw new RoutingError("unsupported_provider_event", 502);
      if (type === "ping") {
        if (
          !started &&
          (++prefixEvents > 16 ||
            (prefixBytes += Buffer.byteLength(event.data)) > 65536)
        )
          throw new RoutingError("provider_prefix_limit", 502);
        continue;
      }
      if (type === "error" || type === "response.failed") {
        if (logger && limitContext) recordLimitEvent(logger, limitContext, value, "sse", { headers: response.headers, providerStartSeen: started, truncated: Buffer.byteLength(event.data) > 65536 });
        const envelope =
          type === "response.failed"
            ? { error: object(value?.["response"])?.["error"] }
            : value;
        const status = Number(
          object(envelope?.["error"])?.["status"] ??
            object(envelope?.["error"])?.["status_code"] ??
            0,
        );
        // Never guess a status for product-specific inference errors.
        const encoded = JSON.stringify(envelope),
          truncated = Buffer.byteLength(encoded) > 65536;
        throw new AttemptFailure(
          classifyFailure(
            p,
            status,
            { text: truncated ? "" : encoded, complete: !truncated, truncated },
            clock.now(),
            response.headers.get("retry-after"),
          ),
        );
      }
      if ((protocol === "responses") !== type.startsWith("response."))
        throw new RoutingError("provider_protocol_mismatch", 502);
      if (!started && type !== "message_start" && type !== "response.created")
        throw new RoutingError("provider_start_required", 502);
      if (type === "message_start" || type === "response.created") {
        if (started) throw new RoutingError("duplicate_provider_start", 502);
        const opening = object(
          value?.[type === "message_start" ? "message" : "response"],
        );
        if (
          !opening ||
          typeof opening["id"] !== "string" ||
          !opening["id"] ||
          (type === "message_start"
            ? opening["type"] !== "message" ||
              opening["role"] !== "assistant" ||
              !Array.isArray(opening["content"])
            : opening["status"] !== "in_progress" ||
              !Array.isArray(opening["output"]))
        )
          throw new RoutingError("invalid_provider_start", 502);
        started = true;
        responseId = opening["id"] as string;
      }
      const item = object(value?.["item"]);
      if (type === "content_block_start") {
        const block = object(value?.["content_block"]),
          index = value?.["index"];
        if (
          typeof index !== "number" ||
          !Number.isInteger(index) ||
          index < 0 ||
          blocks.size >= 1024 ||
          blocks.has(index) ||
          !block ||
          !["text", "thinking", "redacted_thinking", "tool_use"].includes(
            String(block["type"]),
          )
        )
          throw new RoutingError("invalid_provider_block", 502);
        stateBytes += Buffer.byteLength(JSON.stringify(block));
        blocks.set(index, {
          type: String(block["type"]),
          arguments: "",
          closed: false,
          content: { ...block },
        });
      }
      if (type === "content_block_delta") {
        const block = blocks.get(Number(value?.["index"])),
          delta = object(value?.["delta"]);
        if (!block || block.closed || !delta)
          throw new RoutingError("invalid_provider_delta", 502);
        const field =
          block.type === "text" && delta["type"] === "text_delta"
            ? "text"
            : block.type === "tool_use" && delta["type"] === "input_json_delta"
              ? "partial_json"
              : block.type === "thinking" && delta["type"] === "thinking_delta"
                ? "thinking"
                : block.type === "thinking" &&
                    delta["type"] === "signature_delta"
                  ? "signature"
                  : undefined;
        if (!field || typeof delta[field] !== "string")
          throw new RoutingError("invalid_provider_delta", 502);
        if (block.type === "tool_use" || field === "signature")
          stateBytes += Buffer.byteLength(String(delta[field]));
        if (delta["type"] === "input_json_delta")
          block.arguments += String(delta["partial_json"] ?? "");
        if (delta["type"] === "signature_delta")
          block.content["signature"] =
            String(block.content["signature"] ?? "") +
            String(delta["signature"] ?? "");
        if (delta["type"] === "thinking_delta") {
          block.content["thinking"] =
            String(block.content["thinking"] ?? "") + String(delta["thinking"]);
          stateBytes += Buffer.byteLength(String(delta["thinking"]));
        }
      }
      if (type === "content_block_stop") {
        const block = blocks.get(Number(value?.["index"]));
        if (!block || block.closed)
          throw new RoutingError("invalid_provider_block_stop", 502);
        block.closed = true;
        if (block.type === "tool_use") {
          try {
            if (
              !object(
                block.arguments
                  ? JSON.parse(block.arguments)
                  : block.content["input"],
              )
            )
              throw new Error();
          } catch {
            throw new RoutingError("invalid_provider_tool", 502);
          }
          holdTool(event);
          continue;
        }
      }
      if (type === "message_delta") {
        const reason = object(value?.["delta"])?.["stop_reason"];
        if (reason !== undefined && reason !== null) {
          if (stopReason !== undefined && stopReason !== reason)
            throw new RoutingError("conflicting_provider_terminal", 502);
          stopReason = reason;
        }
        if (pendingTools.length) {
          holdTool(event);
          continue;
        }
      }
      if (
        (type === "response.output_item.done" &&
          ["function_call", "custom_tool_call"].includes(
            String(item?.["type"]),
          )) ||
        type === "response.function_call_arguments.done" ||
        type === "response.custom_tool_call_input.done"
      ) {
        holdTool(event);
        continue;
      }
      if (type === "response.completed" || type === "response.incomplete") {
        const final = object(value?.["response"]);
        if (
          !final ||
          !Array.isArray(final["output"]) ||
          final["id"] !== responseId ||
          final["status"] !==
            (type === "response.completed" ? "completed" : "incomplete")
        )
          throw new RoutingError("invalid_provider_terminal", 502);
        if (type === "response.incomplete" && pendingTools.length)
          throw new RoutingError("incomplete_provider_tools", 502);
        const calls = new Set<string>();
        for (const entry of final["output"]) {
          const tool = object(entry);
          if (
            !tool ||
            ![
              "message",
              "reasoning",
              "function_call",
              "custom_tool_call",
            ].includes(String(tool["type"]))
          )
            throw new RoutingError("invalid_provider_terminal", 502);
          if (
            tool &&
            ["function_call", "custom_tool_call"].includes(String(tool["type"]))
          ) {
            if (
              typeof tool["call_id"] !== "string" ||
              !tool["call_id"] ||
              calls.has(tool["call_id"]) ||
              typeof tool["name"] !== "string" ||
              !tool["name"] ||
              (tool["type"] === "custom_tool_call" &&
                typeof tool["input"] !== "string") ||
              type === "response.incomplete"
            )
              throw new RoutingError("invalid_provider_tool", 502);
            calls.add(tool["call_id"]);
          }
          if (tool?.["type"] === "function_call") {
            if (
              typeof tool["call_id"] !== "string" ||
              typeof tool["arguments"] !== "string"
            )
              throw new RoutingError("invalid_provider_tool", 502);
            try {
              if (!object(JSON.parse(tool["arguments"]))) throw new Error();
            } catch {
              throw new RoutingError("invalid_provider_tool", 502);
            }
          }
        }
        validatePendingTools(pendingTools, final["output"] as Item[]);
        onComplete(final);
        for (const pending of pendingTools) yield pending;
        terminal = true;
      } else if (type === "message_stop") {
        const tools = [...blocks.values()].filter((b) => b.type === "tool_use");
        const ids = tools.map((b) => b.content["id"]);
        if (
          ids.some((id) => typeof id !== "string" || !id) ||
          new Set(ids).size !== ids.length ||
          tools.some(
            (b) => typeof b.content["name"] !== "string" || !b.content["name"],
          )
        )
          throw new RoutingError("invalid_provider_tool", 502);
        if (
          [...blocks.values()].some((b) => !b.closed) ||
          ![
            "end_turn",
            "tool_use",
            "max_tokens",
            "refusal",
            "stop_sequence",
          ].includes(String(stopReason)) ||
          (tools.length > 0 && stopReason !== "tool_use") ||
          (!tools.length && stopReason === "tool_use")
        )
          throw new RoutingError("invalid_provider_terminal", 502);
        onComplete({ content: [...blocks.values()].map((b) => b.content) });
        for (const pending of pendingTools) yield pending;
        terminal = true;
      }
      if (stateBytes + pendingBytes > 32 * 1024 * 1024)
        throw new RoutingError("provider_state_too_large", 502);
      yield event;
      if (terminal) break;
    }
    if (!terminal) throw new RoutingError("missing_provider_terminal", 502);
  } catch (error) {
    if (signal.aborted)
      throw new RoutingError("provider_stream_timeout_or_cancelled", 504);
    if (
      sourceFailure !== undefined &&
      !(error instanceof RoutingError) &&
      error === sourceFailure
    )
      throw new AttemptFailure({
        kind: "transport",
        evidence: "unknown",
        windows: [],
        bodyTruncated: false,
        responseCommitted: false,
      });
    throw error;
  } finally {
    cancelIdle?.();
    source.destroy();
    parser.destroy();
    await running;
    source.off("data", reset);
    source.off("error", onSourceError);
    parser.off("error", onParserError);
  }
}

/** Executable events must describe the same tools as the validated terminal. */
function validatePendingTools(
  events: readonly SseEvent[],
  output: readonly Item[],
): void {
  const tools = output.filter((item) =>
    ["function_call", "custom_tool_call"].includes(String(item["type"])),
  );
  const byCall = new Map(tools.map((tool) => [tool["call_id"], tool]));
  const byId = new Map<unknown, Item>();
  for (const tool of tools) {
    if (typeof tool["id"] !== "string") continue;
    if (byId.has(tool["id"]))
      throw new RoutingError("inconsistent_provider_tool_id", 502);
    byId.set(tool["id"], tool);
  }
  const completions = new Set<string>();
  for (const event of events) {
    const value = object(JSON.parse(event.data))!;
    const item = object(value["item"]);
    const completed = item
      ? byCall.get(item["call_id"])
      : byId.get(value["item_id"]) ??
        byCall.get(value["call_id"]) ??
        (Number.isInteger(value["output_index"])
          ? output[value["output_index"] as number]
          : undefined);
    if (!completed)
      throw new RoutingError("inconsistent_provider_tool_missing", 502);
    if (
      (value["item_id"] !== undefined &&
        value["item_id"] !== completed["id"]) ||
      (value["call_id"] !== undefined &&
        value["call_id"] !== completed["call_id"]) ||
      (value["output_index"] !== undefined &&
        output[value["output_index"] as number] !== completed) ||
      !["function_call", "custom_tool_call"].includes(
        String(completed["type"]),
      ) ||
      (value["type"] === "response.function_call_arguments.done" &&
        completed["type"] !== "function_call") ||
      (value["type"] === "response.custom_tool_call_input.done" &&
        completed["type"] !== "custom_tool_call")
    )
      throw new RoutingError("inconsistent_provider_tool", 502);
    const fields = item
      ? ["type", "id", "name", "call_id", "arguments", "input", "namespace"]
      : [
          value["type"] === "response.function_call_arguments.done"
            ? "arguments"
            : "input",
        ];
    const source = item ?? value;
    const different = fields.find(
      (field) => source[field] !== completed[field],
    );
    if (different)
      throw new RoutingError(`inconsistent_provider_tool_${different}`, 502);
    const completion = JSON.stringify([value["type"], completed["call_id"]]);
    if (completions.has(completion))
      throw new RoutingError("duplicate_provider_tool_completion", 502);
    completions.add(completion);
  }
}
