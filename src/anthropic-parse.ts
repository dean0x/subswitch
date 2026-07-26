// Anthropic-side parsing helpers.
// Imported by conversation-key.ts (which must not depend on the Codex Responses
// translator) and by codex-request.ts (which needs it for instruction extraction).
// No imports from the rest of the repo except the Anthropic wire-type.

import type { AnthropicRequest } from "./wire-types.js";

type Block = Record<string, unknown>;

const textOfBlocks = (blocks: readonly Block[]): string =>
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
