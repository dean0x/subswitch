import type { SseEvent } from "../codex-response.js";
import { object } from "../plain-object.js";
import { RoutingError, type ClientEvent, type Item, type WireProtocol } from "./routing-types.js";

/** Convert native provider events to the client envelope. */
export async function* identifyProviderEvents(
  raw: AsyncIterable<Item | SseEvent>,
  protocol: WireProtocol,
): AsyncGenerator<ClientEvent> {
  for await (const value of raw) {
    const payload = "data" in value ? object(JSON.parse(String(value.data))) : value;
    if (!payload) throw new RoutingError("invalid_provider_event", 502);
    yield { protocol, payload };
  }
}
