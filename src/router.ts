import type { ModelResolution, ProviderId } from "./models.js";

export type Route =
  | { readonly kind: "provider"; readonly provider: ProviderId; readonly model: string; readonly endpoint: "messages" | "count_tokens" }
  | { readonly kind: "anthropic" }
  | { readonly kind: "ambiguous"; readonly name: string; readonly providers: readonly ProviderId[] }
  /** Colon-separated name whose prefix is not a known provider (e.g. "kimee:k2"). */
  | { readonly kind: "unknown_provider"; readonly qualifier: string };

/**
 * Pure routing decision. Accepts a pre-built ModelResolution — never a raw model name.
 * This function performs ZERO name matching. All matching is in resolveModel (ADR-005).
 *
 * Non-POST requests and non-/v1/messages* paths always route to Anthropic.
 * The server guarantees that `resolution` is constructible only by `resolveModel`,
 * so a raw unvalidated string can never reach this function.
 */
export const decideRoute = (
  method: string,
  path: string,
  resolution: ModelResolution,
): Route => {
  if (method !== "POST") return { kind: "anthropic" };
  const pathname = path.split("?")[0] ?? path;
  if (!pathname.startsWith("/v1/messages")) return { kind: "anthropic" };

  switch (resolution.kind) {
    case "unresolved":
      // Unknown name — fall through to Anthropic (404 from upstream is truthful;
      // a typo like "sool" fails visibly rather than silently routing somewhere wrong).
      return { kind: "anthropic" };

    case "ambiguous":
      // Two providers claim the same family name. Never arbitrate or fall through — 400
      // so the user sees exactly which providers they must qualify with.
      return { kind: "ambiguous", name: resolution.name, providers: resolution.providers };

    case "unknown_qualifier":
      // "kimee:k2" — provider prefix not in PROVIDER_IDS. Distinguishable from unresolved
      // so Phase F can emit an "unknown_provider" finding rather than "unresolvable".
      return { kind: "unknown_provider", qualifier: resolution.qualifier };

    case "resolved": {
      if (pathname === "/v1/messages") {
        return {
          kind: "provider",
          provider: resolution.target.provider,
          model: resolution.target.id,
          endpoint: "messages",
        };
      }
      if (pathname === "/v1/messages/count_tokens") {
        return {
          kind: "provider",
          provider: resolution.target.provider,
          model: resolution.target.id,
          endpoint: "count_tokens",
        };
      }
      // Other /v1/messages/* sub-paths (future API surface) → Anthropic
      return { kind: "anthropic" };
    }

    default: {
      // Exhaustive check — compiler enforces that all ModelResolution arms are handled.
      const _exhaustive: never = resolution;
      void _exhaustive;
      return { kind: "anthropic" };
    }
  }
};
