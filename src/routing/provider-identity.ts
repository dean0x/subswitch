import type { SseEvent } from "../codex-response.js";
import { object } from "../plain-object.js";
import type { KimiExecPending, KimiExecReservation } from "./kimi-exec-pending.js";
import { RoutingError, type ClientEvent, type Item, type WireProtocol } from "./routing-types.js";

/** Identity conversion; optional ownership is internal to the disabled exec path. */
export async function* identifyProviderEvents(
  raw: AsyncIterable<Item | SseEvent>,
  protocol: WireProtocol,
  pending?: KimiExecPending,
): AsyncGenerator<ClientEvent> {
  const iterator = raw[Symbol.asyncIterator]();
  let exhausted = false;
  try {
    while (true) {
      let next: IteratorResult<Item | SseEvent> | undefined = await iterator.next();
      if (next.done) { exhausted = true; break; }
      let value: Item | SseEvent | undefined = next.value;
      next = undefined;
      let payload: Item | undefined, event: ClientEvent | undefined;
      let rawLease: KimiExecReservation | undefined, payloadLease: KimiExecReservation | undefined;
      let eventLease: KimiExecReservation | undefined;
      try {
        rawLease = pending?.retain(value);
        payload = "data" in value ? object(JSON.parse(String(value.data))) : value;
        if (!payload) throw new RoutingError("invalid_provider_event", 502);
        payloadLease = pending?.retain(payload);
        event = { protocol, payload };
        eventLease = pending?.retain(event);
        yield event;
      } finally {
        event = undefined; payload = undefined; value = undefined;
        eventLease?.release(); payloadLease?.release(); rawLease?.release();
      }
    }
  } finally {
    if (!exhausted) await iterator.return?.();
  }
}
