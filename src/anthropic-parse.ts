// Anthropic-side parsing helpers.
// Imported by conversation-key.ts (which must not depend on the Codex Responses
// translator) and by codex-request.ts (which needs it for instruction extraction).
// No imports from the rest of the repo except the Anthropic wire-type.

import { ModelPeekSchema, type AnthropicRequest } from "./anthropic-wire-types.js";

// ---------------------------------------------------------------------------
// Over-window model sniff
// ---------------------------------------------------------------------------

/**
 * How many bytes of a declared-oversize body to read before deciding a route.
 *
 * Fixed constant, NOT configurable: the sniff is a fallback for bodies the relay
 * cannot buffer in full, and its purpose is solely to peek the `"model"` key near
 * the start of the JSON object. 8 KiB is generous for any realistic model name.
 */
export const MODEL_SNIFF_BYTES = 8 * 1024;

/**
 * Anchored regex over the leading bytes of a request body.
 *
 * Why anchored: a nested `"model"` key inside `messages` or `tools` can appear at
 * any offset in the body, but the TOP-LEVEL `"model"` field can only be preceded by
 * optional whitespace and the opening `{`.  Anchoring prevents a false match on a
 * deeply nested object whose model key happens to sit within the sniff window.
 *
 * ReDoS safety (matches src/errors.ts pattern):
 *   - Input is bounded to MODEL_SNIFF_BYTES (8 KiB) before the match is run.
 *   - The three alternation arms are mutually exclusive: `[^"\\\x00-\x1f]` matches
 *     any printable non-special character; `\\["\\/bfnrt]` matches escape sequences;
 *     `\\u[0-9a-fA-F]{4}` matches Unicode escapes.  No arm overlaps another.
 *   - The byte window bounds the captured string, including an invalid Together id.
 *
 * Intentional divergence from JSON.parse on duplicate top-level `model` keys: this
 * regex takes the FIRST occurrence; JSON.parse takes the LAST.  This case is only
 * reachable on a body that exceeds the routing window, and in practice no client
 * sends duplicate top-level keys, so the divergence is theoretical.
 */
const MODEL_SNIFF_REGEX =
  /^\s*\{\s*"model"\s*:\s*("(?:[^"\\\x00-\x1f]|\\["\\\/bfnrt]|\\u[0-9a-fA-F]{4})*")/;

/**
 * Scan the leading bytes of a request body for the top-level `"model"` key.
 *
 * Returns the unescaped model name string on a match, or `undefined` when:
 *   - the buffer does not begin with `{"model": ...`,
 *   - the value exceeds 200 characters and has no Together qualifier,
 *   - the captured literal is malformed JSON (JSON.parse throws), or
 *   - the buffer is empty.
 *
 * The return is the MODEL NAME STRING, not the quoted JSON literal — escape
 * sequences are resolved by delegating to JSON.parse rather than re-implementing
 * its escape handling.
 */
export const sniffLeadingModel = (prefix: Buffer): string | undefined => {
  const text = prefix.subarray(0, MODEL_SNIFF_BYTES).toString("utf8");
  const match = MODEL_SNIFF_REGEX.exec(text);
  if (match === null || match[1] === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(match[1]);
    return ModelPeekSchema.safeParse({ model: parsed }).data?.model;
  } catch {
    return undefined;
  }
};

type Block = Record<string, unknown>;

/**
 * Concatenate the text of an Anthropic content-block array.
 *
 * Exported because BOTH the conversation-key path and the outbound request-body
 * path must produce identical text — two copies that drift would silently reshape
 * the prompt cache key while the request body kept working.
 */
export const textOfBlocks = (blocks: readonly Block[]): string =>
  blocks
    .filter((block) => block["type"] === "text")
    .map((block) => (typeof block["text"] === "string" ? block["text"] : ""))
    .join("\n\n");

/**
 * Extract the plain-text instruction string from an Anthropic `system` field.
 *
 * Returns `undefined` when the system is absent or produces no text — callers
 * that need an empty-string fallback must coalesce: `buildInstructions(x) ?? ""`.
 */
export const buildInstructions = (system: AnthropicRequest["system"]): string | undefined => {
  if (system === undefined) return undefined;
  if (typeof system === "string") return system;
  const text = textOfBlocks(system);
  return text === "" ? undefined : text;
};
