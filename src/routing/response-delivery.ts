import { object } from "../plain-object.js";
import { abortable } from "../abortable.js";
import type { RoutedPrepared } from "./routed-attempt.js";
import { RoutingError, type Item, type WireProtocol } from "./routing-types.js";

interface Delivery {
  protocol: WireProtocol;
  responseId: string;
  model: string;
  streaming: boolean;
  signal: AbortSignal;
  checkDeadline(): void;
  onCommit(): void;
  onTerminal(response: Item | undefined): void;
}

/** Local response identity and bounded output staging, independent of routing policy. */
export async function* deliverResponse(
  prepared: RoutedPrepared,
  delivery: Delivery,
): AsyncGenerator<Item> {
  const iterator = prepared.events[Symbol.asyncIterator]();
  const held: Item[] = [];
  const executable: Item[] = [];
  const toolBlocks = new Set<number>();
  let executableBytes = 0;
  let heldBytes = 0,
    committed = false,
    finished = false;
  while (true) {
    delivery.checkDeadline();
    const next = await abortable(iterator.next(), delivery.signal);
    if (next.done) break;
    let event = next.value.payload;
    const response = object(event["response"]);
    if (delivery.protocol === "responses") {
      event = {
        ...event,
        ...(response
          ? {
              response: {
                ...response,
                id: delivery.responseId,
                model: delivery.model,
              },
            }
          : {}),
        ...(event["response_id"] !== undefined
          ? { response_id: delivery.responseId }
          : {}),
      };
    }
    if (!committed && delivery.streaming) {
      delivery.onCommit();
      committed = true;
    }
    const type = event["type"];
    if (
      type === "content_block_start" &&
      object(event["content_block"])?.["type"] === "tool_use"
    )
      toolBlocks.add(Number(event["index"]));
    const completesTool =
      type === "response.function_call_arguments.done" ||
      type === "response.custom_tool_call_input.done" ||
      (type === "response.output_item.done" &&
        ["function_call", "custom_tool_call"].includes(
          String(object(event["item"])?.["type"]),
        )) ||
      (type === "content_block_stop" &&
        toolBlocks.has(Number(event["index"]))) ||
      (type === "message_delta" && executable.length > 0);
    if (completesTool && delivery.streaming) {
      executableBytes += Buffer.byteLength(JSON.stringify(event));
      if (executableBytes > 32 * 1024 * 1024)
        throw new RoutingError("provider_state_too_large", 502);
      executable.push(event);
      continue;
    }
    if (!delivery.streaming) {
      heldBytes += Buffer.byteLength(JSON.stringify(event));
      if (heldBytes > 64 * 1024 * 1024)
        throw new RoutingError("response_aggregate_too_large", 502);
      held.push(event);
    }
    if (
      ["response.completed", "response.incomplete", "message_stop"].includes(
        String(event["type"]),
      )
    ) {
      delivery.onTerminal(object(event["response"]));
      finished = true;
      // Publishing replay/continuation state can fail after a valid provider terminal.
      // Do not expose executable tools until publication succeeds.
      for (const completion of executable) yield completion;
      executable.length = 0;
    }
    if (delivery.streaming) yield event;
  }
  if (!finished) throw new RoutingError("missing_provider_terminal", 502);
  if (!delivery.streaming) {
    delivery.onCommit();
    yield* held;
  }
}
