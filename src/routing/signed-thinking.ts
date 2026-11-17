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

/** Same-scope emitted provenance does not imply a successful scoped publication. */
export function foreignThinking(
  cache: ClaudeCache, signature: string, owner: string, conversation: string,
): boolean {
  const origin = cache.get("snapshot", provenanceKey(signature))?.request;
  return origin !== undefined && (origin["owner"] !== owner ||
    origin["conversation"] !== conversation || origin["pending"] === true);
}

/** Retain emitted provenance through failure. Unvalidated output has no ownership claim. */
export function observeThinking(
  cache: StagedCache, owner: string, conversation: string, block: Item, validated = true,
): void {
  const signature = thinkingSignature(block);
  if (signature === undefined) return;
  const key = provenanceKey(signature);
  const origin = cache.get("snapshot", key)?.request;
  if (!validated && origin) return;
  if (validated && origin && (origin["owner"] !== owner || origin["conversation"] !== conversation))
    throw new RoutingError("foreign_opaque_state", 409);
  cache.retainSnapshot(key, { request: validated ? { owner, conversation } : {}, input: [] });
}

/** Staged callers publish imports only after a successful provider terminal. */
export function rememberThinking(
  cache: ClaudeCache, owner: string, conversation: string, block: Item, claimOwnership = true,
): void {
  const signature = thinkingSignature(block);
  if (signature === undefined) return;
  const scoped = `signature:${owner}:${conversation}:${signature}`;
  const key = provenanceKey(signature);
  const provenance = cache.get("snapshot", key);
  if (claimOwnership && provenance && (provenance.request["owner"] !== owner ||
      provenance.request["conversation"] !== conversation || provenance.request["pending"]))
    throw new RoutingError("foreign_opaque_state", 409);
  const recorded = cache.get("snapshot", scoped)?.input[0];
  if (recorded && !sameThinking(block, recorded))
    throw new RoutingError("foreign_opaque_state", 409);
  if (claimOwnership && !provenance) {
    const value = { request: { owner, conversation }, input: [] };
    if (cache instanceof StagedCache) cache.reserveSnapshot(key, value);
    else cache.put("snapshot", key, value);
  }
  cache.put("snapshot", scoped, { request: {}, input: [block] });
}
