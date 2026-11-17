import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as source from "../../src/routing/kimi-responses-bridge.js";
import { output, profile, response, wire } from "../helpers/kimi-ordered-route.js";

// Exercise the checked-in generated module with its own error class as well.
const generated = await import(new URL("../../dist/routing/kimi-responses-bridge.js", import.meta.url).href) as typeof source;
const secret = "FABRICATED_OBSERVER_PRIVATE https://synthetic.invalid/?token=fake";
const codes = ["unsupported_output", "opaque_output"] as const;

for (const [name, module] of [["source", source], ["generated", generated]] as const) {
  async function render(original: unknown, loggerThrows = false) {
    const controller = new AbortController(), logs: unknown[][] = [];
    let error: unknown, frames: readonly string[] | undefined;
    try {
      frames = await module.renderValidatedKimiResponses(response(wire(output())), profile, controller.signal, controller,
        { now: () => 1, monotonic: () => 1, random: () => 0.5, schedule: () => () => {} }, () => { throw original; },
        { logger: { log(level, event, fields) { logs.push([level, event, fields]); if (loggerThrows) throw new Error(secret); } }, limitContext: {} as never });
    } catch (caught) { error = caught; }
    assert.equal(error, original, "diagnostics must rethrow the exact original value");
    assert.equal(frames, undefined, "an observer failure cannot publish frames");
    assert(!JSON.stringify(logs).includes(secret), "diagnostics contain no observer data");
    return logs;
  }
  const error = () => new module.KimiResponsesBridgeError("unsupported_output", undefined, "event_fields");
  function expected(code: typeof codes[number], eventType: string) {
    return [["warn", "kimi_ordered_response_refused", {
      errorCode: code === "opaque_output" ? "kimi_ordered_response_opaque_output" : "kimi_ordered_response_unsupported_output",
      eventType, status: null,
    }]];
  }

  describe(`${name} inert response diagnostics`, () => {
    it("never reads a changing code accessor or projects its private value", async () => {
      const original = error(); let reads = 0;
      Object.defineProperty(original, "code", { get() { reads++; return reads < 5 ? "unsupported_output" : secret; } });
      assert.deepEqual(await render(original), []); assert.equal(reads, 0);
    });
    it("never invokes a throwing code accessor", async () => {
      const original = error(); let reads = 0;
      Object.defineProperty(original, "code", { get() { reads++; throw new Error(secret); } });
      assert.deepEqual(await render(original), []); assert.equal(reads, 0);
    });
    it("ignores missing code data", async () => {
      const original = error(); Reflect.deleteProperty(original, "code");
      assert.deepEqual(await render(original), []);
    });
    it("never reads inherited code or its getter", async () => {
      const original = error(); let reads = 0;
      Reflect.deleteProperty(original, "code");
      Object.setPrototypeOf(original, Object.create(module.KimiResponsesBridgeError.prototype, {
        code: { get() { reads++; return "unsupported_output"; } },
      }));
      assert.deepEqual(await render(original), []); assert.equal(reads, 0);
    });
    it("ignores unrecognized code values without coercion", async () => {
      let conversions = 0;
      for (const value of [secret, { [Symbol.toPrimitive]() { conversions++; throw new Error(secret); } }]) {
        const original = error(); Object.defineProperty(original, "code", { value });
        assert.deepEqual(await render(original), []);
      }
      assert.equal(conversions, 0);
    });
    it("uses unknown for site accessors without invoking them", async () => {
      for (const code of codes) {
        const original = new module.KimiResponsesBridgeError(code); let reads = 0;
        Object.defineProperty(original, code === "opaque_output" ? "opaqueSite" : "unsupportedSite", {
          get() { reads++; throw new Error(secret); },
        });
        assert.deepEqual(await render(original), expected(code, "unknown")); assert.equal(reads, 0);
      }
    });
    it("uses unknown for inherited site getters without invoking them", async () => {
      for (const code of codes) {
        const original = new module.KimiResponsesBridgeError(code); let reads = 0;
        const key = code === "opaque_output" ? "opaqueSite" : "unsupportedSite";
        Reflect.deleteProperty(original, key);
        Object.setPrototypeOf(original, Object.create(module.KimiResponsesBridgeError.prototype, {
          [key]: { get() { reads++; throw new Error(secret); } },
        }));
        assert.deepEqual(await render(original), expected(code, "unknown")); assert.equal(reads, 0);
      }
    });
    it("maps unknown site strings and objects to unknown without coercion", async () => {
      let conversions = 0;
      for (const code of codes) for (const value of [secret, { [Symbol.toPrimitive]() { conversions++; throw new Error(secret); } }]) {
        const original = new module.KimiResponsesBridgeError(code);
        Object.defineProperty(original, code === "opaque_output" ? "opaqueSite" : "unsupportedSite", { value });
        assert.deepEqual(await render(original), expected(code, "unknown"));
      }
      assert.equal(conversions, 0);
    });
    it("contains a code descriptor trap and preserves the original proxy", async () => {
      const original = new Proxy(error(), { getOwnPropertyDescriptor() { throw new Error(secret); } });
      assert.deepEqual(await render(original), []);
    });
    it("contains a site descriptor trap and preserves the original proxy", async () => {
      const original = new Proxy(error(), { getOwnPropertyDescriptor(target, key) {
        if (key === "unsupportedSite") throw new Error(secret);
        return Reflect.getOwnPropertyDescriptor(target, key);
      } });
      assert.deepEqual(await render(original), []);
    });
    it("contains an instanceof prototype trap and preserves the original proxy", async () => {
      const original = new Proxy(error(), { getPrototypeOf() { throw new Error(secret); } });
      assert.deepEqual(await render(original), []);
    });
    it("retains both literal codes and known sites for own data properties", async () => {
      for (const code of codes) {
        const site = code === "opaque_output" ? "created_envelope_signature" : "event_fields";
        const original = new module.KimiResponsesBridgeError(code, code === "opaque_output" ? "created_envelope_signature" : undefined,
          code === "unsupported_output" ? "event_fields" : undefined);
        assert.deepEqual(await render(original), expected(code, site));
      }
    });
    it("keeps the exact original error when either fixed-code logger throws", async () => {
      for (const code of codes) {
        const original = new module.KimiResponsesBridgeError(code);
        assert.deepEqual(await render(original, true), expected(code, "unknown"));
      }
    });
  });
}
