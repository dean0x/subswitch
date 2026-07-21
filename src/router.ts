export type Route =
  | { readonly kind: "codex"; readonly endpoint: "messages" | "count_tokens" }
  | { readonly kind: "anthropic" };

/**
 * Pure routing decision. Only POST /v1/messages and POST /v1/messages/count_tokens
 * with an exact model match go to Codex; everything else passes through to Anthropic,
 * where unknown models fail visibly and claude-* traffic is never misrouted.
 */
export const decideRoute = (
  method: string,
  path: string,
  peekModel: string | undefined,
  codexModels: readonly string[],
): Route => {
  if (method !== "POST" || peekModel === undefined || !codexModels.includes(peekModel)) {
    return { kind: "anthropic" };
  }
  const pathname = path.split("?")[0] ?? path;
  if (pathname === "/v1/messages") return { kind: "codex", endpoint: "messages" };
  if (pathname === "/v1/messages/count_tokens") return { kind: "codex", endpoint: "count_tokens" };
  return { kind: "anthropic" };
};
