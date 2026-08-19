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
 *
 * Taking a `ModelResolution` rather than a model name is what enforces ADR-005:
 * there is no string here to match against, so name matching cannot creep back in.
 * Note this is an argument-shape guarantee, not a provenance one — `ModelResolution`
 * is an ordinary union, so callers must still resolve via `resolveModel` (server.ts
 * closes over the table built once at startup).
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
      // Router doesn't arbitrate between same-named providers; fails open to Anthropic
      // with route "anthropic:ambiguous", and doctor reports the conflict as a config defect.
      return { kind: "ambiguous", name: resolution.name, providers: resolution.providers };

    case "unknown_qualifier":
      // "kimee:k2" — provider prefix not in PROVIDER_IDS. Distinguishable from unresolved
      // so doctor can emit a precise "unknown_provider" finding rather than "unresolvable".
      // The relay forwards the name to Anthropic unchanged, so the request still works at
      // runtime. The finding's severity — "info" here, "fail" for "ambiguous" — and why the
      // two differ are documented once, on AgentFinding in agent-scan.ts.
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
