/**
 * Disabled building blocks for the pinned native exec contract. No production
 * entrypoint enables these helpers. Recognition is not permission to dispatch:
 * owner/history binding, full lifecycle validation and transactional publication
 * must precede any future integration. Inputs here are decoded JSON values.
 */
import { createHash } from "node:crypto";

export const KIMI_EXEC_CODEC_VERSION = "kimi-exec-v1";
// Exact raw string at openai/codex360319d8, core/src/tools/code_mode/execute_spec.rs.
// The leading/trailing newlines and every escape are part of the contract.
export const KIMI_EXEC_GRAMMAR = String.raw`
start: pragma_source | plain_source
pragma_source: PRAGMA_LINE NEWLINE SOURCE
plain_source: SOURCE

PRAGMA_LINE: /[ \t]*\/\/ @exec:[^\r\n]*/
NEWLINE: /\r?\n/
SOURCE: /[\s\S]+/
`;

// Pure helper ceilings only, not an allowance or proof of integrated frame or
// shared32MiB accounting. Final encoded frames need additional envelope checks.
export const KIMI_EXEC_MAX_ARGUMENT_BYTES = 4 * 1024 * 1024;
export const KIMI_EXEC_MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_DECLARATIONS = 1024;
const MAX_HISTORY_ENTRIES = 1024;
const MAX_NAMESPACE_DEPTH = 4;
const FINGERPRINT_DOMAIN = "subswitch.kimi-exec-codec\0";

type JsonObject = Record<string, unknown>;
export type KimiExecDeclaration = Readonly<{
  type: "custom";
  name: "exec";
  description: string;
  format: Readonly<{ type: "grammar"; syntax: "lark"; definition: string }>;
}>;
export type KimiExecRecognition =
  | { kind: "absent" }
  | { kind: "unsupported"; reason: "declarations" | "scan_limit" | "collision" | "declaration" }
  | { kind: "recognized"; declaration: KimiExecDeclaration; fingerprint: string };

function object(value: unknown): JsonObject | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return;
  // Do not call accessors on an accidentally supplied non-JSON object.
  if (Object.values(Object.getOwnPropertyDescriptors(value)).some(d => !("value" in d))) return;
  return value as JsonObject;
}

function exactFields(value: JsonObject, fields: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === fields.length && keys.every(key => typeof key === "string" && fields.includes(key));
}

function scalarText(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

/** Scan declarations only; existing request/history validators remain required. */
export function recognizeKimiExec(request: unknown): KimiExecRecognition {
  const body = object(request);
  if (!body) return { kind: "unsupported", reason: "declarations" };
  let count = 0, execCount = 0;
  let candidate: JsonObject | undefined;
  let failure: "declarations" | "scan_limit" | undefined;
  const scan = (value: unknown, topLevel: boolean, depth: number): void => {
    if (failure) return;
    if (!Array.isArray(value)) { failure = "declarations"; return; }
    if (depth > MAX_NAMESPACE_DEPTH || value.length > MAX_DECLARATIONS) {
      failure = "scan_limit"; return;
    }
    for (const entry of value) {
      if (failure) return;
      if (++count > MAX_DECLARATIONS) { failure = "scan_limit"; return; }
      const tool = object(entry);
      if (!tool || typeof tool["type"] !== "string" || typeof tool["name"] !== "string") {
        failure = "declarations"; return;
      }
      if (tool["type"] === "namespace") {
        scan(tool["tools"], false, depth + 1);
      } else {
        // Refuse ALL extra exec declarations, even in another namespace.
        // This covers native absent/empty/functions namespace normalization
        // without flattening names or trusting duplicate-registration behavior.
        if (tool["name"] === "exec") {
          execCount++;
          if (topLevel && tool["type"] === "custom") candidate = tool;
        }
        if (tool["type"] !== "custom" && tool["type"] !== "function") failure = "declarations";
      }
    }
  };
  if (Object.hasOwn(body, "tools")) scan(body["tools"], true, 0);
  const input = body["input"];
  if (input !== undefined && typeof input !== "string") {
    if (!Array.isArray(input)) return { kind: "unsupported", reason: "declarations" };
    if (input.length > MAX_HISTORY_ENTRIES) return { kind: "unsupported", reason: "scan_limit" };
    for (const entry of input) {
      const item = object(entry);
      if (!item) return { kind: "unsupported", reason: "declarations" };
      if (item["type"] === "additional_tools") scan(item["tools"], false, 0);
    }
  }
  if (failure) return { kind: "unsupported", reason: failure };
  if (!execCount) return { kind: "absent" };
  if (execCount !== 1) return { kind: "unsupported", reason: "collision" };
  if (!candidate || !exactFields(candidate, ["type", "name", "description", "format"]))
    return { kind: "unsupported", reason: "declaration" };
  const format = object(candidate["format"]), description = candidate["description"];
  if (
    !format || !exactFields(format, ["type", "syntax", "definition"]) ||
    format["type"] !== "grammar" || format["syntax"] !== "lark" ||
    format["definition"] !== KIMI_EXEC_GRAMMAR || typeof description !== "string" ||
    description.length > KIMI_EXEC_MAX_ARGUMENT_BYTES ||
    Buffer.byteLength(description) > KIMI_EXEC_MAX_ARGUMENT_BYTES || !scalarText(description)
  ) return { kind: "unsupported", reason: "declaration" };

  // Explicit presence slots and JSON framing prevent concatenation ambiguity.
  // Description is consistency data, never proof of caller identity/authority.
  const tuple = [KIMI_EXEC_CODEC_VERSION, "custom", "exec", "absent", null,
    "absent", "grammar", "lark", KIMI_EXEC_GRAMMAR, description];
  const fingerprint = createHash("sha256").update(FINGERPRINT_DOMAIN).update(JSON.stringify(tuple)).digest("hex");
  const declaration: KimiExecDeclaration = Object.freeze({
    type: "custom", name: "exec", description,
    format: Object.freeze({ type: "grammar", syntax: "lark", definition: KIMI_EXEC_GRAMMAR }),
  });
  return { kind: "recognized", declaration, fingerprint };
}

export type KimiExecArguments =
  | { kind: "parsed"; source: string }
  | { kind: "unsupported"; reason: "size_limit" | "shape" | "json" | "source" };

/**
 * Closed depth-one JSON reader: a literal unescaped "input" key and one string.
 * Linear scan, no recursive parsing or source evaluation. Only the string token
 * is JSON-decoded, exactly once; duplicate/escaped keys cannot be collapsed.
 */
export function parseKimiExecArguments(value: unknown): KimiExecArguments {
  if (typeof value !== "string") return { kind: "unsupported", reason: "shape" };
  if (value.length > KIMI_EXEC_MAX_ARGUMENT_BYTES || Buffer.byteLength(value) > KIMI_EXEC_MAX_ARGUMENT_BYTES)
    return { kind: "unsupported", reason: "size_limit" };
  let at = 0;
  const whitespace = () => {
    while (value[at] === " " || value[at] === "\t" || value[at] === "\r" || value[at] === "\n") at++;
  };
  const shape = (): KimiExecArguments => ({ kind: "unsupported", reason: "shape" });
  whitespace();
  if (value[at++] !== "{") return shape();
  whitespace();
  if (!value.startsWith('"input"', at)) return shape();
  at += 7;
  whitespace();
  if (value[at++] !== ":") return shape();
  whitespace();
  const start = at;
  if (value[at++] !== '"') return shape();
  let closed = false;
  while (at < value.length) {
    const char = value[at++];
    if (char === '"') { closed = true; break; }
    if (char === "\\") at++; // JSON.parse validates the escape, including \uXXXX.
  }
  if (!closed) return { kind: "unsupported", reason: "json" };
  const end = at;
  whitespace();
  if (value[at++] !== "}") return shape();
  whitespace();
  if (at !== value.length) return shape();
  let source: string;
  try { source = JSON.parse(value.slice(start, end)) as string; }
  catch { return { kind: "unsupported", reason: "json" }; }
  if (!source.length || !scalarText(source)) return { kind: "unsupported", reason: "source" };
  if (Buffer.byteLength(source) > KIMI_EXEC_MAX_SOURCE_BYTES)
    return { kind: "unsupported", reason: "size_limit" };
  return { kind: "parsed", source };
}
