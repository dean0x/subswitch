/** Fabricated state and socketless transports only; diagnostic labels never grant acceptance. */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as source from "../../src/routing/kimi-responses-bridge.js";
import * as sourceLogger from "../../src/logger.js";
import { KimiExecPending } from "../../src/routing/kimi-exec-pending.js";
import type { Item } from "../../src/routing/routing-types.js";
import { fixture, ordered, output, profile, response, wire } from "../helpers/kimi-ordered-route.js";
import { added, created, done, terminal, textItem } from "../helpers/kimi-responses-bridge.js";

const generated = await import(new URL("../../dist/routing/kimi-responses-bridge.js", import.meta.url).href) as typeof source;
const generatedLogger = await import(new URL("../../dist/logger.js", import.meta.url).href) as typeof sourceLogger;
const privateValue = "FABRICATED_REASON_PRIVATE https://synthetic.invalid/?token=fake";
const reasons = ["unhandled_reasoning_event", "omitted_display_required", "nonempty_summary_part_added",
  "nonempty_summary_part_done", "nonempty_final_summary_part", "nonempty_summary_text_delta", "nonempty_summary_text_done"] as const;
const encryptionReasons = ["initial_encrypted_content_nonstring", "final_encrypted_content_missing",
  "final_encrypted_content_nonstring", "final_encrypted_content_empty"] as const;
const absent = Symbol("absent");
const encryptionShapes = [
  ["absent", absent, undefined, undefined],
  ["null", null, undefined, "final_encrypted_content_nonstring"],
  ["empty", "", undefined, "final_encrypted_content_empty"],
  ["valid private string", privateValue, undefined, undefined],
  ["boolean", false, "initial_encrypted_content_nonstring", "final_encrypted_content_nonstring"],
  ["number", 0, "initial_encrypted_content_nonstring", "final_encrypted_content_nonstring"],
  ["array", [privateValue], "initial_encrypted_content_nonstring", "final_encrypted_content_nonstring"],
  ["object", { private: privateValue }, "initial_encrypted_content_nonstring", "final_encrypted_content_nonstring"],
] as const;
const empty = () => ({ type: "summary_text", text: "" });
const summary = (suffix: string, rest: Item = {}): Item => ({
  type: `response.reasoning_summary_${suffix}`, output_index: 0, item_id: "r", summary_index: 0, ...rest,
});
function events(): Item[] {
  const r = { id: "r", type: "reasoning", status: "completed", summary: [empty()], encrypted_content: "fabricated-encryption" };
  const m = textItem("m", ["שלום 🦊"]);
  const c = { id: "fc", type: "function_call", call_id: "caller", name: "inspect", arguments: ' { "n":-0,"s":"🦊" } ', status: "completed" };
  return [created(), added(0, { ...r, summary: [], status: "in_progress", encrypted_content: null }),
    summary("part.added", { part: empty() }), summary("text.delta", { delta: "" }), summary("text.done", { text: "" }),
    summary("part.done", { part: empty() }), done(0, r), added(1, { ...m, content: [], status: "in_progress" }), done(1, m),
    added(2, { ...c, arguments: "", status: "in_progress" }), done(2, c), terminal([r, m, c])].map(e => structuredClone(e));
}
function encryptionInput(stage: "initial" | "final", value: unknown): Item[] {
  const e = events(), item = e[stage === "initial" ? 1 : 6]!["item"] as Item;
  if (value === absent) delete item["encrypted_content"];
  else item["encrypted_content"] = value;
  if (stage === "final") {
    const raw = (e.at(-1)!["response"] as Item)["output"] as Item[];
    raw[0] = structuredClone(item);
  }
  return e;
}
function refusal(reason: typeof reasons[number]): Item[] {
  const e = events();
  switch (reason) {
    case "unhandled_reasoning_event": e[3] = { type: "response.reasoning_text.delta", output_index: 0, item_id: "r", content_index: 0, delta: privateValue }; break;
    // With display disabled, summary_index/part are rejected even earlier by event_fields.
    // A bare event reaches the actual display guard, before lookup or scalar validation.
    case "omitted_display_required": return [created(), { type: "response.reasoning_summary_part.added" }];
    case "nonempty_summary_part_added": (e[2]!["part"] as Item)["text"] = privateValue; break;
    case "nonempty_summary_part_done": (e[5]!["part"] as Item)["text"] = privateValue; break;
    case "nonempty_final_summary_part": ((e[6]!["item"] as Item)["summary"] as Item[])[0]!["text"] = privateValue; break;
    case "nonempty_summary_text_delta": e[3]!["delta"] = privateValue; break;
    case "nonempty_summary_text_done": e[4]!["text"] = privateValue; break;
  }
  return e;
}
const baseLog = (detail: object = {}) => [["warn", "kimi_ordered_response_refused", {
  errorCode: "kimi_ordered_response_opaque_output", eventType: "stream_reasoning_event", status: null, ...detail,
}]];

for (const [name, module, loggerModule] of [["source", source, sourceLogger], ["generated", generated, generatedLogger]] as const) {
  async function run(input: Item[], options: { omitted?: boolean; noReplay?: boolean; original?: unknown; loggerThrows?: boolean;
    loggerGetter?: boolean; abortAtEof?: boolean; errorAtEof?: boolean; tail?: string } = {}) {
    const controller = new AbortController(), pending = new KimiExecPending(), leases: { release(): void }[] = [];
    let error: unknown, frames: readonly string[] = [], completions = 0, publications = 0, raw: readonly Item[] | undefined;
    const logs: unknown[][] = [];
    const logger = { log(level: unknown, event: unknown, fields: unknown) {
      logs.push([level, event, fields]); if (options.loggerThrows) throw Error(privateValue);
    } };
    if (options.loggerGetter) Object.defineProperty(logger, "log", { get() { throw Error(privateValue); } });
    const transport = response(wire(input) + (options.tail ?? ""), 4096, () => {
      assert.equal(publications, 0); assert.equal(completions, 0);
      if (options.abortAtEof) controller.abort();
      if (options.errorAtEof) throw Error(privateValue);
    });
    try {
      frames = await module.renderValidatedKimiResponses(transport, profile, controller.signal, controller,
        { now: () => 1, monotonic: () => 1, random: () => 0.5, schedule: () => () => {} }, () => {
          if (options.original !== undefined) throw options.original;
          completions++;
        }, { logger, limitContext: {} as never }, options.noReplay ? undefined : {
          pending, leases, omittedDisplay: options.omitted ?? true, onOutput(value) { publications++; raw = value; },
        });
    } catch (caught) { error = caught; }
    finally { for (const lease of leases) lease.release(); }
    assert.equal(pending.byteSize, 0);
    assert(!JSON.stringify(logs).includes(privateValue));
    if (error !== undefined) { assert.deepEqual(frames, []); assert.equal(completions, 0); assert.equal(publications, 0); }
    return { error, frames, logs, completions, publications, raw };
  }
  const original = () => new module.KimiResponsesBridgeError("opaque_output", "stream_reasoning_event");
  async function injected(error: unknown, loggerThrows = false) {
    const r = await run(output(), { original: error, loggerThrows });
    assert.equal(r.error, error, "diagnostics must rethrow the exact original value"); return r.logs;
  }
  test(`${name}: closed diagnostic vocabulary is immutable`, () => {
    assert.deepEqual(module.KIMI_REASONING_REFUSAL_REASONS, [...reasons, ...encryptionReasons]);
    assert(Object.isFrozen(module.KIMI_REASONING_REFUSAL_REASONS));
    assert.equal(new Set(module.KIMI_REASONING_REFUSAL_REASONS).size, 11);
  });
  for (const [label, value, initial, final] of encryptionShapes) for (const stage of ["initial", "final"] as const)
  test(`${name}: ${stage} encryption ${label} preserves acceptance and safe diagnostics`, async () => {
    const expected = stage === "initial" ? initial : final, input = encryptionInput(stage, value), r = await run(input);
    if (expected === undefined) {
      assert.equal(r.error, undefined); assert.equal(r.completions, 1); assert.equal(r.publications, 1);
      assert.deepEqual(r.raw, (input.at(-1)!["response"] as Item)["output"]);
      assert(r.frames.some(f => f.includes("tool_use"))); assert(r.frames.some(f => f.includes("שלום 🦊")));
      assert(!JSON.stringify(r.frames).includes(privateValue)); assert.deepEqual(r.logs, []);
    } else {
      assert(r.error instanceof module.KimiResponsesBridgeError);
      assert.equal(r.error.code, "opaque_output"); assert.equal(r.error.opaqueSite, "stream_reasoning_event");
      assert.equal(r.error.message, "kimi_responses_bridge_opaque_output");
      assert.equal(r.error.unsupportedSite, undefined); assert.equal(r.error.reasoningRefusalReason, expected);
      assert.deepEqual(r.logs, baseLog({ reasoningRefusalReason: expected }));
      assert(!JSON.stringify(r.error).includes(privateValue));
    }
  });
  test(`${name}: terminal encryption mismatch retains reconciliation precedence`, async () => {
    const input = events(), raw = (input.at(-1)!["response"] as Item)["output"] as Item[];
    delete raw[0]!["encrypted_content"];
    const r = await run(input); assert(r.error instanceof module.KimiResponsesBridgeError);
    assert.equal(r.error.code, "conflicting_content"); assert.equal(r.error.reasoningRefusalReason, undefined);
    assert.deepEqual(r.logs, []);
  });
  for (const reason of ["unhandled_reasoning_event", "omitted_display_required", "nonempty_summary_part_added"] as const)
  test(`${name}: real guard ${reason} keeps the original refusal and atomic publication`, async () => {
    const r = await run(refusal(reason), { omitted: reason !== "omitted_display_required" });
    assert(r.error instanceof module.KimiResponsesBridgeError);
    assert.equal(r.error.code, "opaque_output"); assert.equal(r.error.opaqueSite, "stream_reasoning_event");
    assert.equal(r.error.unsupportedSite, undefined); assert.equal(r.error.reasoningRefusalReason, reason);
    assert.equal(r.error.message, "kimi_responses_bridge_opaque_output");
    assert.deepEqual(r.logs, baseLog({ reasoningRefusalReason: reason }));
    assert(!JSON.stringify(r.error).includes(privateValue));
  });
  for (const reason of ["nonempty_summary_part_done", "nonempty_final_summary_part", "nonempty_summary_text_delta", "nonempty_summary_text_done"] as const)
  test(`${name}: inconsistent private ${reason} fails content reconciliation without a stale opaque reason`, async () => {
    const r = await run(refusal(reason));
    assert(r.error instanceof module.KimiResponsesBridgeError); assert.equal(r.error.code, "conflicting_content");
    assert.equal(r.error.reasoningRefusalReason, undefined); assert.deepEqual(r.logs, []);
  });
  test(`${name}: non-replay summary reaches the same display guard`, async () => {
    const r = await run(refusal("omitted_display_required"), { noReplay: true });
    assert(r.error instanceof module.KimiResponsesBridgeError);
    assert.deepEqual(r.logs, baseLog({ reasoningRefusalReason: "omitted_display_required" }));
  });
  test(`${name}: valid empty scaffolding retains exact encryption, tool identifiers and raw arguments without diagnostics`, async () => {
    const e = events(), r = await run(e);
    assert.equal(r.error, undefined); assert.equal(r.completions, 1); assert.equal(r.publications, 1);
    assert.deepEqual(r.raw, (e.at(-1)!["response"] as Item)["output"]);
    assert.equal(r.raw![0]!["encrypted_content"], "fabricated-encryption");
    assert.equal(r.raw![2]!["id"], "fc"); assert.equal(r.raw![2]!["call_id"], "caller");
    assert.equal(r.raw![2]!["arguments"], ' { "n":-0,"s":"🦊" } ');
    assert(r.frames.some(f => f.includes("tool_use"))); assert(r.frames.some(f => f.includes("שלום 🦊")));
    assert(!JSON.stringify(r.frames).includes("fabricated-encryption")); assert.deepEqual(r.logs, []);
  });
  const earlier: [string, (e: Item[]) => void, source.KimiBridgeRefusal, source.KimiUnsupportedResponseSite?][] = [
    ["non-string part", e => { (e[2]!["part"] as Item)["text"] = null; }, "invalid_event"],
    ["non-string delta", e => { e[3]!["delta"] = []; }, "invalid_event"],
    ["non-string text done", e => { e[4]!["text"] = {}; }, "invalid_event"],
    ["unknown part field", e => { (e[2]!["part"] as Item)[privateValue] = privateValue; }, "unsupported_output", "reasoning_fields"],
    ["unknown event field", e => { e[3]![privateValue] = privateValue; }, "unsupported_output", "event_fields"],
    ["wrong part type", e => { (e[2]!["part"] as Item)["type"] = privateValue; }, "unsupported_output", "reasoning_shape"],
    ["foreign identity before nonempty text", e => { e[3]!["item_id"] = "other"; e[3]!["delta"] = privateValue; }, "conflicting_identity"],
    ["out-of-order before nonempty part", e => { e[2]!["summary_index"] = 1; (e[2]!["part"] as Item)["text"] = privateValue; }, "invalid_order"],
    ["status before nonempty part", e => { e[5]!["status"] = "incomplete"; (e[5]!["part"] as Item)["text"] = privateValue; }, "invalid_terminal"],
    ["late delta before nonempty scalar", e => { e.splice(5, 0, summary("text.delta", { delta: privateValue })); }, "late_mutation"],
    ["initial nonempty array before readable final shape", e => { (e[1]!["item"] as Item)["summary"] = [{ type: "summary_text", text: privateValue }]; }, "unsupported_output", "reasoning_shape"],
    ["terminal snapshot mismatch before final shape", e => {
      const raw = (e.at(-1)!["response"] as Item)["output"] as Item[];
      (raw[0]!["summary"] as Item[])[0]!["text"] = privateValue;
    }, "conflicting_content"],
  ];
  for (const [label, mutate, code, site] of earlier) test(`${name}: ${label} retains earlier refusal precedence without a reason`, async () => {
    const e = events(); mutate(e); const r = await run(e);
    assert(r.error instanceof module.KimiResponsesBridgeError); assert.equal(r.error.code, code);
    assert.equal(r.error.unsupportedSite, site); assert.equal(r.error.reasoningRefusalReason, undefined);
    for (const log of r.logs) assert(!Object.hasOwn(log[2] as object, "reasoningRefusalReason"));
  });
  test(`${name}: summary payload fields retain event_fields precedence with display disabled`, async () => {
    const r = await run([created(), summary("part.added", { part: empty() })], { omitted: false });
    assert(r.error instanceof module.KimiResponsesBridgeError); assert.equal(r.error.unsupportedSite, "event_fields");
    assert.equal(r.error.reasoningRefusalReason, undefined);
    assert.deepEqual(r.logs, [["warn", "kimi_ordered_response_refused", {
      errorCode: "kimi_ordered_response_unsupported_output", eventType: "event_fields", status: null,
      responseEventKind: "response.reasoning_summary_part.added", responseFieldMask: 16416, responseUnknownField: false,
    }]]);
  });
  test(`${name}: EOF error, abort and malformed tail still prevent publication`, async () => {
    for (const options of [{ errorAtEof: true }, { abortAtEof: true }, { tail: "data: {\n\n" }]) {
      const r = await run(events(), options); assert(r.error); assert.deepEqual(r.logs, []);
    }
  });
  test(`${name}: each own fixed reason is projected without copying unrelated error data`, async () => {
    for (const reason of [...reasons, ...encryptionReasons]) {
      const error = new module.KimiResponsesBridgeError("opaque_output", "stream_reasoning_event", undefined, reason);
      Object.defineProperty(error, privateValue, { value: privateValue });
      assert.deepEqual(await injected(error), baseLog({ reasoningRefusalReason: reason }));
    }
  });
  test(`${name}: missing, unknown, boxed and coercible reasons preserve the base refusal without conversion`, async () => {
    let conversions = 0;
    const coercible = { [Symbol.toPrimitive]() { conversions++; throw Error(privateValue); }, toString() { conversions++; throw Error(privateValue); } };
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    for (const value of [undefined, null, false, 0, NaN, privateValue, [], {}, new String(reasons[0]), coercible, revoked.proxy]) {
      const error = original(); Object.defineProperty(error, "reasoningRefusalReason", { value });
      assert.deepEqual(await injected(error), baseLog());
    }
    const error = original(); Reflect.deleteProperty(error, "reasoningRefusalReason");
    assert.deepEqual(await injected(error), baseLog()); assert.equal(conversions, 0);
  });
  test(`${name}: inherited reason values and getters are never read`, async () => {
    let reads = 0;
    for (const descriptor of [{ value: reasons[0] }, { get() { reads++; throw Error(privateValue); } }]) {
      const error = original(); Reflect.deleteProperty(error, "reasoningRefusalReason");
      Object.setPrototypeOf(error, Object.create(module.KimiResponsesBridgeError.prototype, { reasoningRefusalReason: descriptor }));
      assert.deepEqual(await injected(error), baseLog());
    }
    assert.equal(reads, 0);
  });
  test(`${name}: own reason accessors cannot run or erase the base refusal`, async () => {
    let reads = 0; const error = original();
    Object.defineProperty(error, "reasoningRefusalReason", { get() { reads++; throw Error(privateValue); } });
    assert.deepEqual(await injected(error), baseLog()); assert.equal(reads, 0);
  });
  test(`${name}: reason descriptor traps preserve the base refusal and exact original proxy`, async () => {
    let gets = 0, traps = 0;
    const error = new Proxy(original(), {
      get() { gets++; throw Error(privateValue); },
      getOwnPropertyDescriptor(target, key) {
        if (key === "reasoningRefusalReason") { traps++; throw Error(privateValue); }
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    assert.deepEqual(await injected(error), baseLog()); assert.equal(gets, 0); assert.equal(traps, 1);
  });
  test(`${name}: revoked error cannot replace the original refusal`, async () => {
    const error = Proxy.revocable(original(), {}); error.revoke();
    assert.deepEqual(await injected(error.proxy), []);
  });
  test(`${name}: logger failure or throwing logger accessor preserves exact original identity`, async () => {
    const error = new module.KimiResponsesBridgeError("opaque_output", "stream_reasoning_event", undefined, reasons[0]);
    assert.deepEqual(await injected(error, true), baseLog({ reasoningRefusalReason: reasons[0] }));
    const r = await run(output(), { original: error, loggerGetter: true }); assert.equal(r.error, error); assert.deepEqual(r.logs, []);
    const actual = await run(refusal(reasons[0]), { loggerThrows: true });
    assert(actual.error instanceof module.KimiResponsesBridgeError); assert.equal(actual.error.reasoningRefusalReason, reasons[0]);
  });
  test(`${name}: reason data never crosses to another code/site or replaces event-field projection`, async () => {
    const opaque = new module.KimiResponsesBridgeError("opaque_output", "item_added_reasoning", undefined, reasons[0]);
    assert.deepEqual(await injected(opaque), [["warn", "kimi_ordered_response_refused", {
      errorCode: "kimi_ordered_response_opaque_output", eventType: "item_added_reasoning", status: null,
    }]]);
    const unsupported = new module.KimiResponsesBridgeError("unsupported_output", undefined, "event_fields", reasons[0]);
    Object.defineProperty(unsupported, "eventFields", { value: { eventKind: "response.created", rejectedFieldMask: 1, unknownFieldPresent: false } });
    assert.deepEqual(await injected(unsupported), [["warn", "kimi_ordered_response_refused", {
      errorCode: "kimi_ordered_response_unsupported_output", eventType: "event_fields", status: null,
      responseEventKind: "response.created", responseFieldMask: 1, responseUnknownField: false,
    }]]);
    const invalid = new module.KimiResponsesBridgeError("invalid_event", "stream_reasoning_event", undefined, reasons[0]);
    assert.deepEqual(await injected(invalid), []);
  });
  test(`${name}: logger renders every fixed reason once in the closed field set`, () => {
    assert.equal(loggerModule.FIELD_KEYS.filter(key => key === "reasoningRefusalReason").length, 1);
    for (const reason of [...reasons, ...encryptionReasons]) {
      const lines: string[] = [], logger = loggerModule.createConsoleLogger("debug", line => { lines.push(line); }, false);
      logger.log("warn", "kimi_ordered_response_refused", { errorCode: "kimi_ordered_response_opaque_output",
        eventType: "stream_reasoning_event", status: null, reasoningRefusalReason: reason });
      assert.deepEqual(lines, [`level=warn event=kimi_ordered_response_refused status=null eventType=stream_reasoning_event errorCode=kimi_ordered_response_opaque_output reasoningRefusalReason=${reason}`]);
    }
  });
}

for (const [label, value, initial, final] of encryptionShapes) for (const stage of ["initial", "final"] as const) {
  const expected = stage === "initial" ? initial : final;
  if (expected === undefined) continue;
  test(`selected route ${stage} encryption ${label} writes no cache, commits no action and exposes no output or fallback`, async () => {
    const f = fixture({ reply: () => response(wire(encryptionInput(stage, value))), fallback: true });
    try {
      const r = await f.run({ ...ordered(), thinking: { type: "adaptive", display: "omitted" } });
      assert(r.error); assert.deepEqual(r.seen, []);
      assert.equal(f.stats().commits, 0); assert.equal(f.stats().successes, 0); assert.equal(f.effects().cacheWriteCalls, 0);
      assert.equal(f.cache.size, 0); assert.equal(f.sent.length, 1); assert(!JSON.stringify(f.logs).includes(privateValue));
      assert.deepEqual(f.logs.filter(log => log[1] === "kimi_ordered_response_refused"), baseLog({ reasoningRefusalReason: expected }));
    } finally { f.router.close(); }
  });
}

for (const reason of reasons) test(`selected route ${reason} writes no cache, commits no action and exposes no output or fallback`, async () => {
  const f = fixture({ reply: () => response(wire(refusal(reason))), fallback: true });
  try {
    const body = reason === "omitted_display_required" ? ordered() : { ...ordered(), thinking: { type: "adaptive", display: "omitted" } };
    const r = await f.run(body); assert(r.error); assert.deepEqual(r.seen, []);
    assert.equal(f.stats().commits, 0); assert.equal(f.stats().successes, 0); assert.equal(f.effects().cacheWriteCalls, 0);
    assert.equal(f.cache.size, 0); assert.equal(f.sent.length, 1); assert(!JSON.stringify(f.logs).includes(privateValue));
    const opaqueGuard = reason === "unhandled_reasoning_event" || reason === "omitted_display_required" || reason === "nonempty_summary_part_added";
    assert.deepEqual(f.logs.filter(log => log[1] === "kimi_ordered_response_refused"),
      opaqueGuard ? baseLog({ reasoningRefusalReason: reason }) : []);
  } finally { f.router.close(); }
});
