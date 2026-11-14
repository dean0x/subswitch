/** Pure fabricated JSON only: no sockets, auth, credentials or tool execution. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  KIMI_EXEC_CODEC_VERSION, KIMI_EXEC_GRAMMAR, KIMI_EXEC_MAX_ARGUMENT_BYTES,
  parseKimiExecArguments, recognizeKimiExec,
} from "../../src/routing/kimi-exec-codec.js";

const exec = () => ({ type: "custom", name: "exec", description: "Caller owns ALL_TOOLS.\n",
  format: { type: "grammar", syntax: "lark", definition: KIMI_EXEC_GRAMMAR } });
const fn = (name = "read") => ({ type: "function", name });
const inline = (tools: unknown[]) => ({ type: "additional_tools", role: "developer", tools });
const namespace = (name: string, tools: unknown[]) => ({ type: "namespace", name, description: "Tools", tools });
const unsupported = (request: unknown, reason?: string) => {
  const result = recognizeKimiExec(request);
  assert.equal(result.kind, "unsupported");
  if (reason && result.kind === "unsupported") assert.equal(result.reason, reason);
};
const fingerprint = (tool: unknown): string => {
  const result = recognizeKimiExec({ tools: [tool] });
  assert.equal(result.kind, "recognized");
  if (result.kind !== "recognized") throw new Error("Expected recognition");
  return result.fingerprint;
};

test("pinned grammar bytes and codec version have fixed contracts", () => {
  assert.equal(KIMI_EXEC_CODEC_VERSION, "kimi-exec-v1");
  assert.equal(createHash("sha256").update(KIMI_EXEC_GRAMMAR).digest("hex"),
    "8eead048e20069c17fcd0b6fe5ee9ed29364868723f8e08889de146a2b4b7a8e");
});

test("recognition preserves exact declaration and request, using an independent frozen snapshot", () => {
  const tool = exec(), request = { tools: [fn(), tool], input: [inline([fn("wait")])] };
  const before = structuredClone(request), result = recognizeKimiExec(request);
  assert.equal(result.kind, "recognized");
  assert.deepEqual(request, before);
  if (result.kind !== "recognized") return;
  assert.deepEqual(result.declaration, tool);
  assert.notEqual(result.declaration, tool);
  assert.notEqual(result.declaration.format, tool.format);
  assert(Object.isFrozen(result.declaration));
  assert(Object.isFrozen(result.declaration.format));
  tool.description = "changed";
  tool.format.definition = "changed";
  assert.equal(result.declaration.description, "Caller owns ALL_TOOLS.\n");
  assert.equal(result.declaration.format.definition, KIMI_EXEC_GRAMMAR);
});

test("fingerprint is a fixed domain-separated framed tuple, independent of property order", () => {
  const tool = exec();
  const reordered = { format: { definition: tool.format.definition, syntax: "lark", type: "grammar" },
    description: tool.description, name: "exec", type: "custom" };
  assert.equal(fingerprint(tool), fingerprint(reordered));
  // Golden calculated separately from the pinned Rust raw string, with Python
  // JSON framing. Catches changes to domain, version, presence slots or bytes.
  assert.equal(fingerprint(tool), "56fb0b520e0fcced23353434accd6e20d29b86e0a0284e3faf155afcd940db08");
});

test("fingerprint is sensitive to exact description bytes, including whitespace and Unicode normalization", () => {
  const descriptions = ["", "a", "a ", "a\n", "a\r\n", "é", "e\u0301", "a\0b", '["a","b"]'];
  const fingerprints = descriptions.map(description => fingerprint({ ...exec(), description }));
  assert.equal(new Set(fingerprints).size, descriptions.length);
});

for (const [label, change] of Object.entries({
  "wrong name": { name: "Exec" }, "function kind": { type: "function" },
  "wrong grammar": { format: { ...exec().format, definition: KIMI_EXEC_GRAMMAR.trim() } },
  "CRLF grammar": { format: { ...exec().format, definition: KIMI_EXEC_GRAMMAR.replaceAll("\n", "\r\n") } },
  "wrong syntax": { format: { ...exec().format, syntax: "regex" } },
  "wrong format": { format: { ...exec().format, type: "text" } },
  "extra format field": { format: { ...exec().format, extra: true } },
  "null format": { format: null }, "null description": { description: null },
  "explicit namespace undefined": { namespace: undefined }, "empty namespace": { namespace: "" },
  "default namespace": { namespace: "functions" }, "other namespace": { namespace: "elsewhere" },
  "deferred": { defer_loading: true }, "explicit false defer": { defer_loading: false },
  "explicit undefined defer": { defer_loading: undefined }, "extra field": { strict: false },
  "lone surrogate description": { description: "\ud800" },
})) {
  test(`exact recognizer refuses ${label}`, () => {
    const tool = { ...exec(), ...change };
    // A different name means no exec candidate, rather than a name-based guess.
    if (label === "wrong name") assert.deepEqual(recognizeKimiExec({ tools: [tool] }), { kind: "absent" });
    else unsupported({ tools: [tool] });
  });
}
for (const field of ["type", "name", "description", "format"] as const) {
  test(`exact recognizer refuses missing ${field}`, () => {
    const tool: Record<string, unknown> = exec(); delete tool[field];
    unsupported({ tools: [tool] });
  });
}
for (const field of ["type", "syntax", "definition"] as const) {
  test(`exact recognizer refuses missing format ${field}`, () => {
    const format: Record<string, unknown> = { ...exec().format }; delete format[field];
    unsupported({ tools: [{ ...exec(), format }] });
  });
}

test("unrelated declarations remain untouched and do not expand caller tools", () => {
  const request = { tools: [exec(), { ...fn("wait"), defer_loading: true },
    { type: "custom", name: "apply_patch", format: { type: "grammar", syntax: "lark", definition: "caller grammar" } },
    namespace("functions", [fn("read")])], input: [inline([fn("write")]),
    { type: "function_call", name: "exec", arguments: "historical call, not a declaration" }] };
  const before = structuredClone(request);
  assert.equal(recognizeKimiExec(request).kind, "recognized");
  assert.deepEqual(request, before);
});

for (const name of ["", "functions", "other", "functions.exec"]) {
  for (const kind of ["function", "custom"]) {
    test(`refuses additional ${kind} exec in namespace ${JSON.stringify(name)}`, () => {
      unsupported({ tools: [exec(), namespace(name, [{ type: kind, name: "exec" }])] }, "collision");
    });
  }
}
for (const second of [exec(), fn("exec"), { ...exec(), namespace: "" }, { ...fn("exec"), namespace: "other" }]) {
  test(`refuses top-level duplicate ${JSON.stringify(second).slice(0, 60)}`, () => {
    unsupported({ tools: [exec(), second] }, "collision");
  });
}
for (const tools of [[exec()], [namespace("functions", [fn("exec")])]]) {
  for (const before of [true, false]) {
    test(`refuses ${before ? "earlier" : "later"} inline exec ${JSON.stringify(tools).slice(0, 50)}`, () => {
      const entry = inline(tools), message = { role: "user", content: "continue" };
      unsupported({ tools: [exec()], input: before ? [entry, message] : [message, entry] }, "collision");
    });
  }
}
test("inline-only and namespaced-only exec are explicitly unsupported", () => {
  unsupported({ input: [inline([exec()])] }, "declaration");
  unsupported({ tools: [namespace("functions", [exec()])] }, "declaration");
});
for (const request of [{}, { input: "hello" }, { tools: [] }, { tools: [fn(), namespace("exec", [fn()])] },
  { input: [inline([fn()]), { role: "user", content: '{"type":"additional_tools","tools":["exec"]}' }] }]) {
  test(`no declaration is distinct from unsupported: ${JSON.stringify(request).slice(0, 80)}`, () => {
    assert.deepEqual(recognizeKimiExec(request), { kind: "absent" });
  });
}
for (const request of [null, [], { tools: undefined }, { tools: null }, { tools: [null] },
  { tools: [{ name: "exec" }] }, { tools: [{ type: "unknown", name: "exec" }] },
  { tools: [namespace("functions", null as unknown as unknown[])] }, { input: {} }, { input: [null] },
  { tools: [exec()], input: [{ type: "additional_tools" }] }]) {
  test(`malformed declaration container fails closed: ${JSON.stringify(request)}`, () => unsupported(request));
}
test("accessors are not invoked on a non-JSON request or declaration", () => {
  const value = { get tools(): never { throw new Error("must not run"); } };
  unsupported(value);
  unsupported({ tools: [{ ...exec(), get namespace(): never { throw new Error("must not run"); } }] });
});
test("declaration scan has bounded total count, history length and namespace depth", () => {
  assert.equal(recognizeKimiExec({ tools: [exec(), ...Array.from({ length: 1023 }, () => fn())] }).kind, "recognized");
  unsupported({ tools: [exec(), ...Array.from({ length: 1024 }, () => fn())] }, "scan_limit");
  unsupported({ tools: [exec()], input: [inline(Array.from({ length: 1024 }, () => fn()))] }, "scan_limit");
  unsupported({ tools: [exec()], input: Array.from({ length: 1025 }, () => ({ role: "user", content: "" })) }, "scan_limit");
  let nested: unknown = fn();
  for (let i = 0; i < 6; i++) nested = namespace("nested", [nested]);
  unsupported({ tools: [exec(), nested] }, "scan_limit");
});

for (const source of [" ", "\t\r\n", "const x = 1;\r\nawait tools.read(x);\r\n", "😀é e\u0301 中文", "\0", '"\\\\\n\t',
  "// @exec: not JSON\r\ninvalid JavaScript is caller-owned", "```text\nleave fences intact\n```", String.raw`\u0061`,
  'globalThis.__kimiCodecMustNotExecute = true;', 'while (true) {}', '{"input":"nested source, not another decode"}']) {
  test(`source roundtrip preserves exact text ${JSON.stringify(source)}`, () => {
    const wire = JSON.stringify({ input: source });
    assert.deepEqual(parseKimiExecArguments(wire), { kind: "parsed", source });
    assert.deepEqual(parseKimiExecArguments(` \r\n{ \t"input" \n: ${JSON.stringify(source)} \t}\n`), { kind: "parsed", source });
  });
}
test("escaped surrogate pairs and NUL decode once without normalization", () => {
  assert.deepEqual(parseKimiExecArguments(String.raw`{"input":"\uD83D\uDE00\u0000\r\n"}`), { kind: "parsed", source: "😀\0\r\n" });
  assert.deepEqual(parseKimiExecArguments(String.raw`{"input":"\\u0061"}`), { kind: "parsed", source: String.raw`\u0061` });
});
const malformed: unknown[] = [undefined, null, {}, ["source"], 12, "", "null", '"source"', "[]", "{}",
  '{"input":null}', '{"input":1}', '{"input":[]}', '{"input":{}}', '{"input":true}',
  '{"input":""}', '{"INPUT":"x"}', String.raw`{"\u0069nput":"x"}`, String.raw`{"in\u0070ut":"x"}`,
  '{"input":"a","input":"b"}', String.raw`{"input":"a","\u0069nput":"b"}`,
  '{"input":"a","extra":1}', '{"extra":1,"input":"a"}', '{"input":"a",}',
  '{"input":"a"}{}', '{"input":"a"} false', '{"input":"a"', '{"input":"a}',
  '{"input":"a\n"}', '{"input":"a\u0000"}', String.raw`{"input":"\x20"}`, String.raw`{"input":"\u12"}`,
  String.raw`{"input":"\uZZZZ"}`, String.raw`{"input":"\q"}`, String.raw`{"input":"\"}`,
  String.raw`{"input":"\uD800"}`, String.raw`{"input":"\uDC00"}`, String.raw`{"input":"\uD800x"}`,
  String.raw`{"input":"\uDC00\uD800"}`, '{"input":"\ud800"}', '{"input":"\udc00"}',
  '\uFEFF{"input":"x"}', '{\u00a0"input":"x"}', '{"input":"x"}\u00a0',
  '{"input":' + "[".repeat(10000) + '"x"' + "]".repeat(10000) + "}",
];
for (const [index, value] of malformed.entries()) {
  test(`closed parser rejects malformed/duplicate/escaped-key/Unicode case ${index + 1}`, () => {
    assert.equal(parseKimiExecArguments(value).kind, "unsupported");
  });
}
test("argument bound counts UTF8 bytes and includes JSON overhead, without splitting or truncating", () => {
  const overhead = JSON.stringify({ input: "" }).length;
  const source = "a".repeat(KIMI_EXEC_MAX_ARGUMENT_BYTES - overhead);
  assert.deepEqual(parseKimiExecArguments(JSON.stringify({ input: source })), { kind: "parsed", source });
  assert.deepEqual(parseKimiExecArguments(JSON.stringify({ input: source + "a" })), { kind: "unsupported", reason: "size_limit" });
  const multibyte = JSON.stringify({ input: "é".repeat(KIMI_EXEC_MAX_ARGUMENT_BYTES / 2) });
  assert(multibyte.length < KIMI_EXEC_MAX_ARGUMENT_BYTES);
  assert.deepEqual(parseKimiExecArguments(multibyte), { kind: "unsupported", reason: "size_limit" });
});
