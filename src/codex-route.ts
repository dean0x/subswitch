import { ReverseContractError } from "./claude-errors.js";
import { displayModelName } from "./claude-models.js";

export type ClaudeResolution =
  | { readonly kind: "claude"; readonly model: string }
  /** A Claude-namespace name that is neither a catalog id nor a configured alias or target. */
  | { readonly kind: "unregistered"; readonly name: string }
  | { readonly kind: "foreign" }
  | { readonly kind: "absent" };

export type CodexRoute =
  | { readonly kind: "claude"; readonly model: string }
  | { readonly kind: "parent" }
  | { readonly kind: "rejected"; readonly code: "translated_compaction_unavailable" }
  | {
      readonly kind: "rejected";
      readonly code: "unregistered_claude_model";
      readonly message: string;
    };

/** The client message for a Claude-namespace name nothing routes; the name is display-safe. */
export const unregisteredClaudeMessage = (name: string): string =>
  `\`${displayModelName(name)}\` is not a registered Claude model; add a \`codexIngress.claude.aliases\` entry to route it`;

/**
 * Resolution precedes dispatch; HTTP and WebSocket dispatch do no model-name matching.
 *
 * An unregistered Claude-namespace name is refused here rather than forwarded: OpenAI could
 * never act on it, so the relay answers with the 400 the origin itself would give an
 * unsupported model, inventing no behaviour the origin could have had (applies ADR-011).
 */
export const decideCodexRoute = (path: string, resolution: ClaudeResolution): CodexRoute => {
  switch (resolution.kind) {
    case "claude":
      return path === "/responses/compact"
        ? { kind: "rejected", code: "translated_compaction_unavailable" }
        : { kind: "claude", model: resolution.model };
    case "unregistered":
      return {
        kind: "rejected",
        code: "unregistered_claude_model",
        message: unregisteredClaudeMessage(resolution.name),
      };
    case "foreign":
    case "absent":
      return { kind: "parent" };
    default: {
      const exhaustive: never = resolution;
      return exhaustive;
    }
  }
};

/** The error a rejected route answers with, carrying its client message when it has one. */
export const rejectionError = (route: Extract<CodexRoute, { kind: "rejected" }>): ReverseContractError =>
  new ReverseContractError(route.code, "message" in route ? route.message : undefined);
