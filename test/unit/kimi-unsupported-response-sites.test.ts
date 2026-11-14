import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as bridge from "../../src/routing/kimi-responses-bridge.js";
import { KimiExecPending } from "../../src/routing/kimi-exec-pending.js";
import { profile, response, wire } from "../helpers/kimi-ordered-route.js";
import { created, added, done, delta, terminal, textItem, type Event } from "../helpers/kimi-responses-bridge.js";

const secret = "FABRICATED_PRIVATE_DIAGNOSTIC https://synthetic.invalid/?token=fake";
const message = () => ({ ...textItem("m", []), status: "in_progress" });
const call = () => ({ id: "fc", type: "function_call", call_id: "c", name: "inspect", arguments: "", status: "in_progress" });
const part = (value: Event): Event => ({ type: "response.content_part.added", output_index: 0, item_id: "m", content_index: 0, part: value });
const reasoning = () => ({ id: "r", type: "reasoning", status: "in_progress", summary: [] });
const prefix = () => [created(), added(0, message())];
const refusal = () => ({ ...textItem("m", []), content: [{ type: "refusal", refusal: secret }] });
const finalCall = () => ({ ...call(), status: "completed", arguments: '{"n":7}' });

// One independently constructed input for each guard, including all six fields() callers.
const cases: [string, () => Event[]][] = [
  ["event_fields", () => [{ ...created(), private_unknown: secret }]],
  ["event_logprobs", () => [...prefix(), { ...delta("m", 0, secret), logprobs: [secret] }]],
  ["item_added_type", () => [created(), added(0, { ...call(), type: "custom_tool_call" })]],
  ["item_added_message_content", () => [created(), added(0, { ...message(), content: textItem("m", [secret]).content })]],
  ["item_added_function_arguments", () => [created(), added(0, { ...call(), arguments: secret })]],
  ["non_message_content_event", () => [created(), added(0, call()), delta("fc", 0, secret)]],
  ["part_added_value", () => [...prefix(), part({ type: "output_text", text: secret })]],
  ["unknown_content_event", () => [...prefix(), delta("m", 0, ""), { type: "response.custom_tool_call_input.done", output_index: 0, item_id: "m", content_index: 0, text: secret }]],
  ["message_fields", () => [created(), added(0, { ...message(), private_unknown: secret })]],
  ["message_shape", () => [created(), added(0, { ...message(), role: "user" })]],
  ["reasoning_fields", () => [created(), added(0, { ...reasoning(), private_unknown: secret })]],
  ["reasoning_shape", () => [created(), added(0, { ...reasoning(), summary: [secret] })]],
  ["function_fields", () => [created(), added(0, { ...call(), private_unknown: secret })]],
  ["function_shape", () => [created(), added(0, call()), done(0, { ...finalCall(), status: "synthetic" })]],
  ["text_part_fields", () => [...prefix(), part({ type: "output_text", text: "", private_unknown: secret })]],
  ["text_part_annotations", () => [...prefix(), part({ type: "output_text", text: "", annotations: [secret] })]],
  ["refusal_part_fields", () => [...prefix(), part({ type: "refusal", refusal: "", private_unknown: secret })]],
  ["part_type", () => [...prefix(), part({ type: "image", data: secret })]],
  ["ordered_visible_output", () => [created(), terminal([])]],
  ["refusal_with_tools", () => [created(), added(0, message()), done(0, refusal()), added(1, call()), done(1, finalCall()), terminal([refusal(), finalCall()])]],
  ["profile_contract", () => [created()]],
];

async function run(events: Event[], options: { invalidProfile?: boolean; loggerThrows?: boolean } = {}) {
  const controller = new AbortController(), pending = new KimiExecPending();
  const leases: { release(): void }[] = [], logs: unknown[][] = [];
  let completions = 0, publications = 0, frames: readonly string[] = [], error: unknown;
  try {
    frames = await bridge.renderValidatedKimiResponses(response(wire(events)), options.invalidProfile ? { ...profile, region: "mainland-cn" } : profile,
      controller.signal, controller, { now: () => 1, monotonic: () => 1, random: () => 0.5, schedule: () => () => {} }, () => { completions++; },
      { logger: { log(level, event, fields) { logs.push([level, event, fields]); if (options.loggerThrows) throw new Error(secret); } }, limitContext: {} as never },
      { pending, leases, omittedDisplay: true, onOutput() { publications++; } });
  } catch (caught) { error = caught; }
  finally { for (const lease of leases) lease.release(); }
  assert.equal(pending.byteSize, 0, "all owned pending representations released");
  return { error, frames, completions, publications, logs };
}

describe("unsupported-output fixed source sites", () => {
  for (const [site, events] of cases) it(`refuses ${site} atomically with no provider data in diagnostics`, async () => {
    const r = await run(events(), { invalidProfile: site === "profile_contract" });
    assert(r.error instanceof bridge.KimiResponsesBridgeError);
    assert.equal(r.error.code, "unsupported_output");
    assert.equal(Object.getOwnPropertyDescriptor(r.error, "unsupportedSite")?.value, site);
    assert.equal(String(r.error), "Error: kimi_responses_bridge_unsupported_output");
    assert.deepEqual(r.frames, []); assert.equal(r.completions, 0); assert.equal(r.publications, 0);
    assert.deepEqual(r.logs, [["warn", "kimi_ordered_response_refused", { errorCode: "kimi_ordered_response_unsupported_output", eventType: site, status: null,
      ...(site === "event_fields" ? { responseEventKind: "response.created", responseFieldMask: 0, responseUnknownField: true } : {}),
    }]]);
    assert(!JSON.stringify([r.logs, r.error]).includes(secret));
  });
  it("covers the entire finite unsupported-output site set", () => {
    const sites = (bridge as unknown as Record<string, unknown>)["KIMI_UNSUPPORTED_RESPONSE_SITES"];
    assert.deepEqual(sites, cases.map(([site]) => site)); assert(Object.isFrozen(sites));
  });
  it("preserves valid encrypted reasoning and visible tool/text sequence", async () => {
    const r = await run([created(), added(0, reasoning()), done(0, { ...reasoning(), status: "completed", encrypted_content: secret }),
      added(1, message()), done(1, textItem("m", ["שלום 🦊"])), added(2, call()), done(2, finalCall()), terminal([
        { ...reasoning(), status: "completed", encrypted_content: secret }, textItem("m", ["שלום 🦊"]), finalCall(),
      ])]);
    assert.equal(r.error, undefined); assert.equal(r.completions, 1); assert.equal(r.publications, 1); assert.deepEqual(r.logs, []);
    assert(r.frames.some(f => f.includes("שלום 🦊"))); assert(r.frames.some(f => f.includes("tool_use")));
  });
  it("keeps the original refusal when the diagnostic observer throws", async () => {
    const r = await run(cases[0]![1](), { loggerThrows: true }); assert(r.error instanceof bridge.KimiResponsesBridgeError);
    assert.equal(r.error.code, "unsupported_output"); assert.equal(Object.getOwnPropertyDescriptor(r.error, "unsupportedSite")?.value, "event_fields");
    assert.deepEqual(r.frames, []); assert.equal(r.publications, 0);
  });
  it("retains the existing opaque refusal and fixed opaque site", async () => {
    const e = created(); (e["response"] as Event)["signature"] = secret;
    const r = await run([e]); assert(r.error instanceof bridge.KimiResponsesBridgeError); assert.equal(r.error.code, "opaque_output");
    assert.equal(r.error.opaqueSite, "created_envelope_signature"); assert.deepEqual(r.logs, [["warn", "kimi_ordered_response_refused", {
      errorCode: "kimi_ordered_response_opaque_output", eventType: "created_envelope_signature", status: null,
    }]]); assert.deepEqual(r.frames, []); assert.equal(r.publications, 0);
  });
  it("still requires terminal and clean EOF before publication", async () => {
    const r = await run([created(), added(0, message()), done(0, textItem("m", ["visible"]))]);
    assert(r.error); assert.deepEqual(r.frames, []); assert.equal(r.completions, 0); assert.equal(r.publications, 0);
  });
});
