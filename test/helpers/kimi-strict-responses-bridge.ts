/** Socketless synthetic transport. Fabricated profile path is never opened. */
import { aggregateFrames } from "../../src/codex-response.js";
import { renderValidatedKimiResponses } from "../../src/routing/kimi-responses-bridge.js";
import type { AccessProfile } from "../../src/routing/routing-types.js";
import type { Event } from "./kimi-responses-bridge.js";

const profile: AccessProfile = {
  provider: "kimi", product: "kimi-code", region: "global", billing: "subscription", account: "fabricated",
  credential: { kind: "native-oauth", authFile: "fabricated-unused-no-read", source: "kimi-code" },
};
export async function strictBridge(events: Event[], options: { fragment?: number; tail?: string; abort?: boolean } = {}) {
  const bytes = Buffer.from(events.map((event) => `event: ${event["type"]}\ndata: ${JSON.stringify(event)}\n\n`).join("") + (options.tail ?? ""));
  const controller = new AbortController();
  let offset = 0, completions = 0, cancelled = false;
  const body = new ReadableStream<Uint8Array>({ pull(stream) {
    if (options.abort && offset > 0) { controller.abort(); stream.close(); return; }
    if (offset >= bytes.length) { stream.close(); return; }
    const next = Math.min(bytes.length, offset + (options.fragment ?? bytes.length));
    stream.enqueue(bytes.subarray(offset, next)); offset = next;
  }, cancel() { cancelled = true; } });
  let frames: readonly string[] = [], error: unknown;
  try {
    frames = await renderValidatedKimiResponses(new Response(body, { headers: { "content-type": "text/event-stream" } }), profile,
      controller.signal, controller, { now: () => 1000, monotonic: () => 1000, random: () => 0.5, schedule: () => () => {} }, () => { completions++; });
  } catch (caught) { error = caught; }
  // Aggregator's current ProviderId is Codex-only; this is a fixture label, not a route selection.
  return { frames, error, completions, cancelled, aggregate: aggregateFrames(frames, "codex") };
}
