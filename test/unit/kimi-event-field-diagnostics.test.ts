import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as source from "../../src/routing/kimi-responses-bridge.js";
import { KimiExecPending } from "../../src/routing/kimi-exec-pending.js";
import { output, profile, response, wire } from "../helpers/kimi-ordered-route.js";
import { created, added, done, delta, terminal, textItem, type Event } from "../helpers/kimi-responses-bridge.js";

const generated = await import(new URL("../../dist/routing/kimi-responses-bridge.js", import.meta.url).href) as typeof source;
const secret = "FABRICATED_EVENT_PRIVATE https://synthetic.invalid/?token=fake";
const kinds = ["response.created", "response.in_progress", "response.completed", "response.incomplete",
  "response.output_item.added", "response.output_item.done", "response.content_part.added", "response.content_part.done",
  "response.output_text.delta", "response.output_text.done", "response.refusal.delta", "response.refusal.done",
  "response.function_call_arguments.delta", "response.function_call_arguments.done",
  "response.custom_tool_call_input.delta", "response.custom_tool_call_input.done",
  "response.reasoning_summary_part.added", "response.reasoning_summary_part.done",
  "response.reasoning_summary_text.delta", "response.reasoning_summary_text.done",
  "response.reasoning_text.delta", "response.reasoning_text.done", "ping"];
// Bit positions are a versioned diagnostic vocabulary, not an acceptance schema.
const fields = ["response", "output_index", "item", "item_id", "content_index", "part", "call_id", "name", "delta",
  "arguments", "refusal", "text", "logprobs", "obfuscation", "summary_index", "annotation_index", "annotation",
  "response_id", "status", "error", "code", "message", "param", "content", "encrypted_content"];
const mask = (names: string[]) => names.reduce((n, key) => n + 2 ** fields.indexOf(key), 0);
const projection = (eventKind: string, rejectedFieldMask: number, unknownFieldPresent: boolean) => ({
  responseEventKind: eventKind, responseFieldMask: rejectedFieldMask, responseUnknownField: unknownFieldPresent,
});
const log = (detail: object = {}) => [["warn", "kimi_ordered_response_refused", {
  errorCode: "kimi_ordered_response_unsupported_output", eventType: "event_fields", status: null, ...detail,
}]];

for (const [name, module] of [["source", source], ["generated", generated]] as const) {
  async function run(events: Event[], original?: unknown, loggerThrows = false) {
    const controller = new AbortController(), pending = new KimiExecPending(), leases: { release(): void }[] = [];
    const logs: unknown[][] = []; let error: unknown, frames: readonly string[] = [], completions = 0, publications = 0;
    try {
      frames = await module.renderValidatedKimiResponses(response(wire(events)), profile, controller.signal, controller,
        { now: () => 1, monotonic: () => 1, random: () => 0.5, schedule: () => () => {} }, () => {
          if (original !== undefined) throw original;
          completions++;
        }, { logger: { log(level, event, values) { logs.push([level, event, values]); if (loggerThrows) throw Error(secret); } }, limitContext: {} as never },
        { pending, leases, omittedDisplay: true, onOutput() { publications++; } });
    } catch (caught) { error = caught; }
    finally { for (const lease of leases) lease.release(); }
    assert.equal(pending.byteSize, 0); assert(!JSON.stringify(logs).includes(secret));
    if (error) { assert.deepEqual(frames, []); assert.equal(completions, 0); assert.equal(publications, 0); }
    return { logs, error, frames, completions, publications };
  }
  function injected(detail: unknown) {
    const error = new module.KimiResponsesBridgeError("unsupported_output", undefined, "event_fields");
    Object.defineProperty(error, "eventFields", { value: detail, configurable: true }); return error;
  }
  describe(`${name} closed event-field diagnostics`, () => {
    for (const type of kinds) it(`identifies ${type} without accepting extra fields`, async () => {
      const event = { ...(type === "response.created" ? created() : { type }), obfuscation: secret, [secret]: secret };
      const r = await run(type === "response.created" ? [event] : [created(), event]);
      assert(r.error instanceof module.KimiResponsesBridgeError); assert.equal(r.error.code, "unsupported_output");
      assert.equal(r.error.unsupportedSite, "event_fields");
      assert.deepEqual(r.logs, log(projection(type, mask(["obfuscation"]), true)));
      assert(!JSON.stringify(r.error).includes(secret));
    });
    it("records all rejected known classes together and never their values", async () => {
      const event = created(); const rejected = fields.filter(key => key !== "response");
      for (const field of rejected) event[field] = secret;
      const r = await run([event]); assert.deepEqual(r.logs, log(projection("response.created", mask(rejected), false)));
    });
    it("records only the unknown marker for arbitrary rejected names", async () => {
      const r = await run([{ ...created(), [secret]: secret }]);
      assert.deepEqual(r.logs, log(projection("response.created", 0, true)));
    });
    it("does not classify allowed fields as rejected", async () => {
      const r = await run([created(), { type: "response.output_text.delta", item_id: "m", output_index: 0, content_index: 0,
        delta: secret, logprobs: [], obfuscation: secret }]);
      assert.deepEqual(r.logs, log(projection("response.output_text.delta", mask(["obfuscation"]), false)));
    });
    it("uses presence for all JSON kinds without persisting values", async () => {
      for (const value of [null, false, 0, "", [], {}, secret]) {
        const r = await run([{ ...created(), obfuscation: value }]);
        assert.deepEqual(r.logs, log(projection("response.created", mask(["obfuscation"]), false)));
      }
    });
    it("keeps the original refusal when its diagnostic logger throws", async () => {
      const r = await run([{ ...created(), obfuscation: secret }], undefined, true);
      assert(r.error instanceof module.KimiResponsesBridgeError); assert.equal(r.error.unsupportedSite, "event_fields");
      assert.deepEqual(r.logs, log(projection("response.created", mask(["obfuscation"]), false)));
    });
    it("preserves valid tools, encrypted reasoning, raw arguments and clean EOF publication", async () => {
      const reasoning = { id: "r", type: "reasoning", status: "in_progress", summary: [] };
      const encrypted = { ...reasoning, status: "completed", encrypted_content: secret };
      const message = textItem("m", ["שלום 🦊"]);
      const call = { id: "fc", type: "function_call", call_id: "c", name: "inspect", arguments: '{"n":-0,"s":"🦊"}', status: "completed" };
      const r = await run([created(), added(0, reasoning), done(0, encrypted), added(1, { ...message, status: "in_progress", content: [] }),
        delta("m", 1, "שלום 🦊"), done(1, message), added(2, { ...call, status: "in_progress", arguments: "" }), done(2, call), terminal([encrypted, message, call])]);
      assert.equal(r.error, undefined); assert.equal(r.completions, 1); assert.equal(r.publications, 1); assert.deepEqual(r.logs, []);
      assert(r.frames.some(f => f.includes("tool_use"))); assert(r.frames.some(f => f.includes("שלום 🦊")));
    });
    it("reproduces fixture-backed obfuscation rejection on an otherwise valid argument stream", async () => {
      const serialized = '{"n":-0,"s":"🦊"}';
      const call = { id: "fc", type: "function_call", call_id: "c", name: "inspect", arguments: serialized, status: "completed" };
      const event = { type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc", delta: serialized };
      const stream = (target: Event) => [created(), added(0, { ...call, arguments: "", status: "in_progress" }), target,
        { type: "response.function_call_arguments.done", output_index: 0, item_id: "fc", arguments: serialized }, done(0, call), terminal([call])];
      const valid = await run(stream(event)); assert.equal(valid.error, undefined); assert.equal(valid.publications, 1);
      const refused = await run(stream({ ...event, obfuscation: secret }));
      assert(refused.error instanceof module.KimiResponsesBridgeError); assert.equal(refused.error.unsupportedSite, "event_fields");
      assert.deepEqual(refused.logs, log(projection("response.function_call_arguments.delta", mask(["obfuscation"]), false)));
    });
    it("never invokes metadata or nested accessors", async () => {
      let reads = 0;
      for (const key of ["eventFields", "eventKind", "rejectedFieldMask", "unknownFieldPresent"]) {
        const detail = { eventKind: "response.created", rejectedFieldMask: 1, unknownFieldPresent: false };
        const original = injected(detail);
        Object.defineProperty(key === "eventFields" ? original : detail, key, { get() { reads++; throw Error(secret); } });
        const r = await run(output(), original); assert.equal(r.error, original); assert.deepEqual(r.logs, log());
      }
      assert.equal(reads, 0);
    });
    it("ignores inherited diagnostic data", async () => {
      const detail = Object.create({ eventKind: "response.created", rejectedFieldMask: 1, unknownFieldPresent: false });
      const original = injected(detail); const r = await run(output(), original);
      assert.equal(r.error, original); assert.deepEqual(r.logs, log());
    });
    it("refuses unsafe masks, coercible kinds and nonboolean markers without conversion", async () => {
      let conversions = 0;
      const coercible = { [Symbol.toPrimitive]() { conversions++; throw Error(secret); } };
      for (const [key, values] of [["eventKind", [secret, coercible]], ["rejectedFieldMask", [-1, 0.5, Infinity, NaN, 2 ** fields.length, coercible]],
        ["unknownFieldPresent", [0, "true", coercible]]] as const) for (const value of values) {
        const original = injected({ eventKind: "response.created", rejectedFieldMask: 1, unknownFieldPresent: false, [key]: value });
        const r = await run(output(), original); assert.equal(r.error, original); assert.deepEqual(r.logs, log());
      }
      assert.equal(conversions, 0);
    });
    it("contains metadata descriptor traps and preserves exact original identity", async () => {
      for (const key of ["eventKind", "rejectedFieldMask", "unknownFieldPresent"]) {
        const detail = { eventKind: "response.created", rejectedFieldMask: 1, unknownFieldPresent: false };
        const original = injected(new Proxy(detail, { getOwnPropertyDescriptor(target, field) {
          if (field === key) throw Error(secret);
          return Reflect.getOwnPropertyDescriptor(target, field);
        } }));
        const r = await run(output(), original); assert.equal(r.error, original); assert.deepEqual(r.logs, log());
      }
      const proxy = Proxy.revocable({}, {}); proxy.revoke();
      const revoked = injected(proxy.proxy); const r = await run(output(), revoked);
      assert.equal(r.error, revoked); assert.deepEqual(r.logs, log());
      const original = new Proxy(injected({}), { getOwnPropertyDescriptor(target, key) {
        if (key === "eventFields") throw Error(secret);
        return Reflect.getOwnPropertyDescriptor(target, key);
      } });
      const trapped = await run(output(), original); assert.equal(trapped.error, original); assert.deepEqual(trapped.logs, log());
    });
    it("never attaches event metadata to another refusal site", async () => {
      const original = injected({ eventKind: "response.created", rejectedFieldMask: 1, unknownFieldPresent: false });
      Object.defineProperty(original, "unsupportedSite", { value: "message_fields" });
      const r = await run(output(), original); assert.equal(r.error, original);
      assert.deepEqual(r.logs, [["warn", "kimi_ordered_response_refused", { errorCode: "kimi_ordered_response_unsupported_output", eventType: "message_fields", status: null }]]);
    });
    it("retains terminal and clean EOF gates", async () => {
      const events = output(); events.pop(); const r = await run(events);
      assert(r.error); assert.deepEqual(r.logs, []);
    });
  });
}
