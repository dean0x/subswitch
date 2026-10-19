import { createHash } from "node:crypto";
import type { ClaudeCache } from "../claude-cache.js";
import { StagedCache } from "./replay-cache.js";
import { RoutingError, type Item } from "./routing-types.js";

/** Native signatures remain opaque; only their original upstream can authenticate imports. */
export function thinkingSignature(block: Item): string | undefined {
  const signature = block[block["type"] === "thinking" ? "signature" : "data"];
  if (typeof signature !== "string" || !signature) return undefined;
  if (block["type"] === "thinking")
    return typeof block["thinking"] === "string" && block["data"] === undefined
      ? signature : undefined;
  return block["type"] === "redacted_thinking" &&
    block["signature"] === undefined && block["thinking"] === undefined
    ? signature : undefined;
}

export function sameThinking(block: Item, recorded: Item): boolean {
  return thinkingSignature(block) !== undefined &&
    block["type"] === recorded["type"] &&
    block["thinking"] === recorded["thinking"] &&
    block["signature"] === recorded["signature"] &&
    block["data"] === recorded["data"];
}

const provenanceKey = (signature: string) =>
  `thinking-origin:${createHash("sha256").update(signature).digest("hex")}`;

/** Distinguish a cold cache from a signature already observed under another scope. */
export const knownThinking = (cache: ClaudeCache, signature: string): boolean =>
  cache.get("snapshot", provenanceKey(signature)) !== undefined;

/** Staged callers publish imports only after a successful provider terminal. */
export function rememberThinking(
  cache: ClaudeCache, owner: string, conversation: string, block: Item,
): void {
  const signature = thinkingSignature(block);
  if (signature === undefined) return;
  const scoped = `signature:${owner}:${conversation}:${signature}`;
  const key = provenanceKey(signature);
  const provenance = cache.get("snapshot", key);
  if (provenance && (provenance.request["owner"] !== owner ||
      provenance.request["conversation"] !== conversation || provenance.request["pending"]))
    throw new RoutingError("foreign_opaque_state", 409);
  const recorded = cache.get("snapshot", scoped)?.input[0];
  if (recorded && !sameThinking(block, recorded))
    throw new RoutingError("foreign_opaque_state", 409);
  if (!provenance) {
    const value = { request: { owner, conversation }, input: [] };
    if (cache instanceof StagedCache) cache.reserveSnapshot(key, value);
    else cache.put("snapshot", key, value);
  }
  cache.put("snapshot", scoped, { request: {}, input: [block] });
}
