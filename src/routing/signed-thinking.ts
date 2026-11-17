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

/** Native provenance and exact replay share one record; gateway replay stays scope-local. */
export function recordedThinking(
  cache: ClaudeCache, signature: string, owner: string, conversation: string,
): Item | undefined {
  const record = cache.get("snapshot", provenanceKey(signature));
  if (record?.request["owner"] === owner && record.request["conversation"] === conversation &&
      !record.request["pending"]) return record.input[0];
  return cache.get("snapshot", `signature:${owner}:${conversation}:${signature}`)?.input[0];
}

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

/** Imports require an attempt-local stage; only success publishes exact replay. */
export function rememberThinking(
  cache: StagedCache, owner: string, conversation: string, block: Item, claimOwnership = true,
): void {
  if (!(cache instanceof StagedCache)) throw new RoutingError("invalid_replay_stage", 500);
  const signature = thinkingSignature(block);
  if (signature === undefined) return;
  const key = provenanceKey(signature);
  const provenance = cache.get("snapshot", key);
  if (claimOwnership && provenance && (provenance.request["owner"] !== owner ||
      provenance.request["conversation"] !== conversation || provenance.request["pending"]))
    throw new RoutingError("foreign_opaque_state", 409);
  const recorded = recordedThinking(cache, signature, owner, conversation);
  if (recorded && !sameThinking(block, recorded))
    throw new RoutingError("foreign_opaque_state", 409);
  if (claimOwnership) {
    const value = { request: { owner, conversation }, input: [block] };
    if (!provenance) cache.reserveSnapshot(key, value);
    else cache.put("snapshot", key, value);
  } else {
    // Unvalidated gateway output has scoped replay but cannot claim native ownership.
    cache.put("snapshot", `signature:${owner}:${conversation}:${signature}`, { request: {}, input: [block] });
  }
}
