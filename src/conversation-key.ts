import { createHash } from "node:crypto";
import type { AnthropicRequest } from "./wire-types.js";
import { buildInstructions } from "./codex-request.js";

// Maximum bytes per hash component. Caps hash cost on pathologically large
// inputs — bounded per engineering reliability principles — without changing
// the key for normal-sized components.
const COMPONENT_CAP_BYTES = 16 * 1024;

const capBytes = (s: string): string => {
  if (Buffer.byteLength(s, "utf8") <= COMPONENT_CAP_BYTES) return s;
  return Buffer.from(s, "utf8").subarray(0, COMPONENT_CAP_BYTES).toString("utf8");
};

/**
 * Derive a stable, v7-shaped conversation key from the immutable parts of an
 * Anthropic request: model + system/instructions + first user message.
 *
 * Returns undefined when no user message is present — callers must fall back
 * to newSessionId() in that case.
 *
 * The real codex-cli 0.144.6 uses UUID v7 (time-sortable) for its session_id.
 * Our key is deterministic (sha256-based), not time-sortable, but we force the
 * version nibble to 7 and the variant bits to 10xx so it is indistinguishable
 * in shape from the CLI's v7 ids (fingerprint parity; verified live 2026-07-22).
 *
 * Collisions (identical model + instructions + first-user-message) share cache
 * affinity and session_id, which is benign under store:false. [applies ADR-003]
 *
 * Escape hatch: to stop including instructions in the hash (e.g., if Claude Code
 * mutates system mid-conversation causing key flap), remove the
 * `instructionsComponent` element from the components array below — that is the
 * only edit needed.
 */
export const deriveConversationKey = (request: AnthropicRequest): string | undefined => {
  const firstUserMessage = request.messages.find((m) => m.role === "user");
  if (firstUserMessage === undefined) return undefined;

  const modelComponent = capBytes(request.model);
  // Escape hatch: remove the next line to drop instructions from the hash.
  const instructionsComponent = capBytes(buildInstructions(request.system) ?? "");
  const userMessageComponent = capBytes(JSON.stringify(firstUserMessage));

  const input = `${modelComponent} ${instructionsComponent} ${userMessageComponent}`;
  const digest = createHash("sha256").update(input, "utf8").digest();

  // Map first 16 digest bytes into the 128-bit UUID layout.
  const b = Buffer.from(digest.subarray(0, 16));
  // Force version nibble = 7 (bits 48-51, high nibble of byte 6).
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x70;
  // Force variant bits = 10xx (bits 64-65, top two bits of byte 8).
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;

  const hex = b.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};
