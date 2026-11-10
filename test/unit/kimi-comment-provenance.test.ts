/** All transports are fabricated in memory; no sockets, auth or credential IO. */
import assert from "node:assert/strict";
import { it } from "node:test";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createSseParser, isParserComment, type SseEvent } from "../../src/codex-response.js";
import { validatedProviderEvents } from "../../src/routing/provider-stream.js";
import type { AccessProfile } from "../../src/routing/routing-types.js";
import { strictBridge } from "../helpers/kimi-strict-responses-bridge.js";
import { created, added, done, terminal, type Event } from "../helpers/kimi-responses-bridge.js";

const call = { type: "function_call", id: "fc", call_id: "caller", name: "inspect", arguments: '{"n":7}', status: "completed" };
const round = (): Event[] => [created(), added(0, { ...call, arguments: "", status: "in_progress" }), done(0, call), terminal([call])];
const wire = (events: Event[]): string => events.map((event) => `event: ${event["type"]}\ndata: ${JSON.stringify(event)}\n\n`).join("");
const placed = (position: string, raw: string) => {
  const events = round();
  if (position === "before start") return { events: [], tail: raw + wire(events) };
  if (position === "before terminal") return { events: events.slice(0, -1), tail: raw + wire(events.slice(-1)) };
  return { events, tail: raw };
};
const payloads = [
  { type: "error", error: { type: "server_error", message: "fabricated" }, parserComment: true },
  { type: "response.function_call_arguments.delta", item_id: "fc", output_index: 0, delta: '{"n":8}', parserComment: true },
];
for (const position of ["before start", "before terminal", "after terminal"]) {
  for (const payload of payloads) for (const fragment of [1, 8192]) {
    it(`refuses data-bearing reserved-name ${payload.type} ${position}, fragment${fragment}`, async () => {
      const fixture = placed(position, `event: __subswitch_comment\ndata: ${JSON.stringify(payload)}\n\n`);
      const run = await strictBridge(fixture.events, { tail: fixture.tail, fragment });
      assert.match(String(run.error), /invalid_provider_event/);
      assert.equal(run.completions, 0); assert.deepEqual(run.frames, []);
    });
  }
  for (const fragment of [1, 8192]) it(`retains genuine parser no-data keepalives ${position}, fragment${fragment}`, async () => {
    const fixture = placed(position, ': keepalive\n\nevent: __subswitch_comment\n: no data\n\n');
    const run = await strictBridge(fixture.events, { tail: fixture.tail, fragment });
    assert.equal(run.error, undefined); assert.equal(run.completions, 1);
    assert.ok(run.aggregate.ok && run.aggregate.value.kind === "message");
    assert.deepEqual(run.aggregate.value.message["content"], [{ type: "tool_use", id: "caller", name: "inspect", input: { n: 7 } }]);
  });
}

it("parser comment provenance is independent of identical wire names and record shape", async () => {
  const raw = ': keepalive\n\nevent: __subswitch_comment\ndata: {"parserComment":true}\n\n';
  const bytes = Buffer.from(raw), events: SseEvent[] = [];
  await pipeline(Readable.from([...bytes].map((byte) => Buffer.from([byte]))), createSseParser(16384, true),
    async (source) => { for await (const event of source) events.push(event as SseEvent); });
  // Existing parser flush also returns one no-data tail record; all record fields
  // remain the established event/data shape. No enumerable provenance is added.
  assert.deepEqual(events.slice(0, 2), [
    { event: "__subswitch_comment", data: ': keepalive' },
    { event: "__subswitch_comment", data: '{"parserComment":true}' },
  ]);
  assert.equal(isParserComment(events[0]!), true); assert.equal(isParserComment(events[1]!), false);
  assert.equal(isParserComment({ ...events[0]! }), false, "copying wire fields cannot forge parser identity");
  assert.deepEqual(Object.keys(events[0]!), ["event", "data"]);
});

it("default validator keeps established reserved-name behavior without the strict opt-in", async () => {
  const base = round(), spoof = `event: __subswitch_comment\ndata: ${JSON.stringify(payloads[0])}\n\n`;
  const response = new Response(wire(base.slice(0, -1)) + spoof + wire(base.slice(-1)), { headers: { "content-type": "text/event-stream" } });
  const profile: AccessProfile = { provider: "kimi", product: "kimi-code", region: "global", billing: "subscription", account: "fabricated",
    credential: { kind: "native-oauth", authFile: "fabricated-unused-no-read" } };
  const controller = new AbortController(); let completions = 0;
  for await (const _event of validatedProviderEvents(response, profile, "responses", controller.signal, controller,
    { now: () => 1000, monotonic: () => 1000, random: () => 0.5, schedule: () => () => {} }, () => { completions++; })) { /* drain */ }
  assert.equal(completions, 1);
});
