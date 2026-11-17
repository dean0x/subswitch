/** Entirely fabricated provider SSE. No fetch, listener, credentials or clients. */
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { aggregateFrames, createAnthropicSseTranslator } from "../../src/codex-response.js";
import { noopLogger } from "../../src/logger.js";
import { validatedProviderEvents } from "../../src/routing/provider-stream.js";
import type { AccessProfile } from "../../src/routing/routing-types.js";

export type Event = Record<string, unknown>;
export const created = (): Event => ({ type: "response.created", response: { id: "resp_fixture", model: "kimi-for-coding", status: "in_progress", output: [] } });
export const textItem = (id: string, texts: string[]) => ({ type: "message", id, role: "assistant", status: "completed", content: texts.map((text) => ({ type: "output_text", text, annotations: [] })) });
export const added = (index: number, item: Event): Event => ({ type: "response.output_item.added", output_index: index, item });
export const done = (index: number, item: Event): Event => ({ type: "response.output_item.done", output_index: index, item });
export const delta = (id: string, index: number, value: string, contentIndex = 0): Event => ({ type: "response.output_text.delta", item_id: id, output_index: index, content_index: contentIndex, delta: value });
export const terminal = (output: Event[], reason?: string): Event => ({
  type: reason ? "response.incomplete" : "response.completed",
  response: { id: "resp_fixture", model: "kimi-for-coding", status: reason ? "incomplete" : "completed", output,
    ...(reason ? { incomplete_details: { reason } } : {}), usage: { input_tokens: 37, output_tokens: 11 } },
});

const profile: AccessProfile = {
  provider: "kimi", product: "kimi-code", region: "global", billing: "subscription", account: "fabricated",
  credential: { kind: "native-oauth", authFile: "fabricated-unused-no-read", source: "kimi-code" },
};

export async function bridge(events: Event[], options: { fragment?: number; abortAfter?: string } = {}) {
  const bytes = Buffer.from(events.map((event) => `event: ${event["type"]}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
  const width = options.fragment ?? Math.max(1, bytes.length);
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    for (let offset = 0; offset < bytes.length; offset += width) controller.enqueue(bytes.subarray(offset, offset + width));
    controller.close();
  } });
  const response = new Response(body, { headers: { "content-type": "text/event-stream" } });
  const controller = new AbortController();
  const frames: string[] = [];
  const observed: { type: string; completed: boolean }[] = [];
  let completions = 0;
  const raw = async function* () {
    for await (const event of validatedProviderEvents(response, profile, "responses", controller.signal, controller,
      { now: () => 1000, monotonic: () => 1000, random: () => 0.5, schedule: () => () => {} }, () => { completions++; })) {
      const value = JSON.parse(event.data) as Event;
      observed.push({ type: value["type"] as string, completed: completions > 0 });
      yield event;
      if (options.abortAfter === value["type"]) controller.abort();
    }
  };
  let error: unknown;
  try {
    // Match routed-attempt.forward's current bridge label; ProviderId is still
    // Codex-only. This fixture does not widen production provider selection.
    await pipeline(Readable.from(raw()), createAnthropicSseTranslator({ model: "kimi-for-coding", providerId: "codex", logger: noopLogger }),
      async (source) => { for await (const frame of source) frames.push(String(frame)); });
  } catch (caught) { error = caught; }
  return { frames, observed, completions, error, aggregate: aggregateFrames(frames, "codex") };
}

export const frameData = (frames: string[]): Event[] => frames.map((raw) => JSON.parse(raw.split("\n").find((line) => line.startsWith("data: "))!.slice(6)) as Event);

export function toolRound() {
  const before = textItem("msg_before", ["שלום 🦊"]), after = textItem("msg_after", ["after tool"]);
  const args = { path: "שלום/🦊", n: 3 };
  const call = { type: "function_call", id: "fc_provider_item", call_id: "call_caller", name: "inspect", arguments: JSON.stringify(args), status: "completed" };
  const serialized = JSON.stringify(args);
  const events = [created(), added(0, textItem("msg_before", [])), delta("msg_before", 0, "שלום "), delta("msg_before", 0, "🦊"), done(0, before),
    added(1, { ...call, arguments: "", status: "in_progress" }),
    ...[serialized.slice(0, 5), serialized.slice(5, 13), serialized.slice(13)].map((value) => ({ type: "response.function_call_arguments.delta", item_id: call.id, output_index: 1, delta: value })),
    { type: "response.function_call_arguments.done", item_id: call.id, output_index: 1, arguments: serialized }, done(1, call),
    added(2, textItem("msg_after", [])), delta("msg_after", 2, "after tool"), done(2, after), terminal([before, call, after])];
  return { events, args, call };
}
