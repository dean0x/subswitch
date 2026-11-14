import { object } from "../plain-object.js";
import { abortable } from "../abortable.js";
import type { RoutedPrepared } from "./routed-attempt.js";
import { RoutingError, type ClientEvent, type Item, type WireProtocol } from "./routing-types.js";
import type { KimiExecReservation } from "./kimi-exec-pending.js";
import { orderedJsonBytes } from "./kimi-ordered-replay.js";

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
  if (prepared.atomicMessages) {
    yield* deliverAtomicMessages(prepared, delivery);
    return;
  }
  if (prepared.orderedResponsesSuffix) {
    yield* deliverOrderedResponses(prepared, delivery);
    return;
  }
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

/** Strict Kimi Messages are one validated publication, including text and tools. */
async function* deliverAtomicMessages(prepared: RoutedPrepared, delivery: Delivery): AsyncGenerator<Item> {
  if (prepared.protocol !== "messages" || delivery.protocol !== "messages")
    throw new RoutingError("unsupported_routed_content");
  const held: Item[] = [];
  const leases: KimiExecReservation[] = [];
  const pending = prepared.atomicPending;
  let bytes = 0, terminal = false;
  const check = () => { delivery.signal.throwIfAborted(); delivery.checkDeadline(); delivery.signal.throwIfAborted(); };
  try {
  for await (const value of prepared.events) {
    check();
    if (value.protocol !== "messages" || terminal) throw new RoutingError("invalid_provider_terminal", 502);
    const event = value.payload;
    if (pending) leases.push(pending.reserve(orderedJsonBytes([event]) + 1));
    const encodedLease = pending?.reserve(2 * orderedJsonBytes(event) + 3);
    let size: number;
    try { size = Buffer.byteLength(JSON.stringify(event)); }
    finally { encodedLease?.release(); }
    // Preflight the exact downstream Messages SSE envelope before any publication.
    if (size + Buffer.byteLength(`event: ${String(event["type"])}\ndata: \n\n`) > 4 * 1024 * 1024)
      throw new RoutingError("sse_event_too_large", 502);
    bytes += size;
    if (bytes > 64 * 1024 * 1024) throw new RoutingError("response_aggregate_too_large", 502);
    terminal = event["type"] === "message_stop";
    held.push(event);
  }
  check();
  if (!terminal) throw new RoutingError("missing_provider_terminal", 502);
  // Synchronous owner/cache/quota publication must succeed before the first frame.
  delivery.onTerminal(undefined);
  check();
  delivery.onCommit();
  for (const event of held) { check(); yield event; }
  } finally {
    held.length = 0;
    for (const lease of leases) lease.release();
  }
}

/** Disabled codec delivery: one ordered suffix, sharing the upstream pending owner. */
async function* deliverOrderedResponses(prepared: RoutedPrepared, delivery: Delivery): AsyncGenerator<Item> {
  const context = prepared.orderedResponsesSuffix!;
  if (prepared.protocol !== "responses" || delivery.protocol !== "responses")
    throw new RoutingError("unsupported_routed_content");
  const pending = context.pending, iterator = prepared.events[Symbol.asyncIterator]();
  type Held = { event: Item; lease: KimiExecReservation };
  const held: (Held | undefined)[] = [];
  let sequence = 0, suffix = false, committed = false, terminal = false, exhausted = false;
  const check = () => { delivery.signal.throwIfAborted(); delivery.checkDeadline(); };
  const numbered = (event: Item, index: number): Item => {
    if (!Number.isSafeInteger(index) || index < 0 || !Number.isSafeInteger(index + 1))
      throw new RoutingError("provider_state_too_large", 502);
    return { ...event, sequence_number: index };
  };
  const frameBytes = (event: Item): number => {
    let encoded: string | undefined = JSON.stringify(event);
    const lease = pending.retain(encoded);
    try {
      const bytes = Buffer.byteLength(encoded);
      // Exact Responses ingress envelope: `data: ${JSON.stringify(event)}\n\n`.
      if (bytes + 8 > 4 * 1024 * 1024) throw new RoutingError("sse_event_too_large", 502);
      return bytes;
    } finally { encoded = undefined; lease.release(); }
  };
  try {
    while (true) {
      check();
      let next: IteratorResult<ClientEvent> | undefined;
      let event: Item | undefined, inputLease: KimiExecReservation | undefined;
      let original: Item | undefined, response: Item | undefined;
      let lease: KimiExecReservation | undefined;
      try {
        next = await abortable(iterator.next(), delivery.signal);
        check();
        if (next.done) { next = undefined; exhausted = true; break; }
        inputLease = pending.retain(next.value);
        if (next.value.protocol !== "responses") throw new RoutingError("unsupported_routed_content");
        if (terminal) throw new RoutingError("invalid_provider_terminal", 502);
        original = next.value.payload; response = object(original["response"]);
        event = { ...original,
          ...(response ? { response: { ...response, id: delivery.responseId, model: delivery.model } } : {}),
          ...(original["response_id"] !== undefined ? { response_id: delivery.responseId } : {}),
        };
        lease = pending.retain([event]);
        original = undefined; response = undefined; next = undefined;
        inputLease.release(); inputLease = undefined;
        const type = String(event["type"]);
        terminal = type === "response.completed" || type === "response.incomplete";
        suffix ||= type === "response.output_item.added" || type === "response.output_item.done" ||
          type.startsWith("response.function_call_arguments.") || type.startsWith("response.custom_tool_call_input.");
        if (suffix || terminal || !delivery.streaming) {
          held.push({ event, lease });
          event = undefined; lease = undefined;
        } else {
          let final: Item | undefined = numbered(event, sequence);
          const finalLease = pending.retain([final]);
          try {
            event = undefined; lease.release(); lease = undefined;
            frameBytes(final);
            check();
            if (!committed) { delivery.onCommit(); committed = true; }
            sequence++;
            yield final;
            check();
          } finally { final = undefined; finalLease.release(); }
        }
      } finally {
        next = undefined; event = undefined; original = undefined; response = undefined;
        inputLease?.release(); lease?.release();
      }
    }
    if (!terminal) throw new RoutingError("missing_provider_terminal", 502);
    // Final order is now fixed. Replace entries in place, retaining old+new until
    // each old reference is dropped. No second executable-only or encoded queue.
    let aggregateBytes = 0;
    for (let index = 0; index < held.length; index++) {
      check();
      let entry: Held | undefined = held[index]!;
      let final: Item | undefined = numbered(entry.event, sequence + index);
      let lease: KimiExecReservation | undefined = pending.retain([final]);
      try {
        aggregateBytes += frameBytes(final);
        if (!delivery.streaming && aggregateBytes > 64 * 1024 * 1024)
          throw new RoutingError("response_aggregate_too_large", 502);
        const oldLease = entry.lease;
        held[index] = { event: final, lease };
        entry = undefined; final = undefined; lease = undefined;
        oldLease.release();
      } finally { entry = undefined; final = undefined; lease?.release(); }
    }
    check();
    if (context.beforePublication() !== undefined) throw new RoutingError("invalid_codec_publication", 500);
    check();
    // Existing synchronous continuation/cache publication remains owned by caller.
    delivery.onTerminal(object(held.at(-1)!.event["response"]));
    for (let index = 0; index < held.length; index++) {
      check();
      if (!committed) { delivery.onCommit(); committed = true; }
      yield held[index]!.event;
      check();
      // Keep the actual parked yield's entry charged until it resumes.
      const lease = held[index]!.lease;
      held[index] = undefined;
      lease.release();
      sequence++;
    }
  } finally {
    for (let index = 0; index < held.length; index++) {
      const lease = held[index]?.lease;
      held[index] = undefined;
      lease?.release();
    }
    held.length = 0;
    if (!exhausted) {
      // Same finite cleanup bound as RoutedPrepared.cancel/codec transport.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([Promise.resolve(iterator.return?.()).catch(() => {}),
          new Promise<void>(resolve => { timer = setTimeout(resolve, 100); })]);
      } finally { clearTimeout(timer); }
    }
  }
}
