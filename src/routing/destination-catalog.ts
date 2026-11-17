import { MODEL_REGISTRY, reasoningEffortsForModel } from "../models.js";
import { CLAUDE_MODELS, CLAUDE_REASONING_EFFORTS } from "../claude-models.js";
import type {
  AccessProfile,
  DestinationProviderId,
  WireProtocol,
} from "./routing-types.js";

export interface ProviderDefinition {
  id: DestinationProviderId;
  products: readonly AccessProfile["product"][];
  protocols: readonly WireProtocol[];
}
export const DESTINATIONS: readonly ProviderDefinition[] = [
  { id: "codex", products: ["chatgpt-codex"], protocols: ["responses"] },
  { id: "claude", products: ["claude-code"], protocols: ["messages"] },
];

/** Native OAuth stores are implemented only for these exact provider/product pairs. */
export const supportsNativeOAuth = (profile: AccessProfile): boolean =>
  (profile.provider === "codex" && profile.product === "chatgpt-codex") ||
  (profile.provider === "claude" && profile.product === "claude-code");

export function modelEfforts(
  profile: AccessProfile,
  model: string,
): readonly string[] | undefined {
  if (profile.provider === "codex")
    return MODEL_REGISTRY.some((m) => m.id === model)
      ? reasoningEffortsForModel(MODEL_REGISTRY, model)
      : undefined;
  if (profile.provider === "claude")
    return CLAUDE_MODELS.some((m) => m.id === model)
      ? CLAUDE_REASONING_EFFORTS
      : undefined;
  return undefined;
}
export function defaultBase(profile: AccessProfile): string {
  return profile.product === "chatgpt-codex"
    ? "https://chatgpt.com/backend-api/codex"
    : "https://api.anthropic.com";
}
export function destinationUrl(
  profile: AccessProfile,
  protocol: WireProtocol,
): string {
  const base = (profile.baseUrl ?? defaultBase(profile)).replace(/\/$/, "");
  if (profile.product === "chatgpt-codex") return base + "/responses";
  return base + (protocol === "responses" ? "/v1/responses" : "/v1/messages");
}

/** Prefer a native ingress protocol when the destination has a documented codec for it. */
export function destinationProtocol(
  profile: AccessProfile,
  ingress: WireProtocol,
): WireProtocol {
  const definition = DESTINATIONS.find(
    (destination) => destination.id === profile.provider,
  )!;
  return definition.protocols.includes(ingress)
    ? ingress
    : definition.protocols[0]!;
}
