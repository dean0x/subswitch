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
  {
    id: "codex",
    products: ["chatgpt-codex", "openai-api"],
    protocols: ["responses"],
  },
  {
    id: "claude",
    products: ["claude-code", "anthropic-api"],
    protocols: ["messages"],
  },
  {
    id: "kimi",
    products: ["kimi-code", "kimi-platform"],
    protocols: ["messages", "responses"],
  },
];
/** Documentation establishes candidates, not live compatibility or equivalence. */
export const KIMI_MODELS = {
  "kimi-code": [
    "k3",
    "k3-256k",
    "kimi-for-coding",
    "kimi-for-coding-highspeed",
  ],
  "kimi-platform": ["kimi-k3"],
} as const;

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
  const models: readonly string[] =
    profile.product === "kimi-code"
      ? KIMI_MODELS["kimi-code"]
      : KIMI_MODELS["kimi-platform"];
  return models.includes(model) ? ["low", "high", "max"] : undefined;
}
export function defaultBase(profile: AccessProfile): string {
  switch (profile.product) {
    case "chatgpt-codex":
      return "https://chatgpt.com/backend-api/codex";
    case "openai-api":
      return "https://api.openai.com";
    case "claude-code":
    case "anthropic-api":
      return "https://api.anthropic.com";
    case "kimi-code":
      return `https://api.kimi.${profile.region === "mainland-cn" ? "com" : "ai"}/coding`;
    case "kimi-platform":
      return `https://api.moonshot.${profile.region === "mainland-cn" ? "cn" : "ai"}`;
  }
}
export function destinationUrl(
  profile: AccessProfile,
  protocol: WireProtocol,
): string {
  const base = (profile.baseUrl ?? defaultBase(profile)).replace(/\/$/, "");
  const path =
    profile.product === "chatgpt-codex"
      ? "/responses"
      : protocol === "responses"
        ? "/v1/responses"
        : profile.product === "kimi-platform"
          ? "/anthropic/v1/messages"
          : "/v1/messages";
  return base + path;
}
/** Intentionally empty until exact product/region/capability live gates pass (#74). */
export const VERIFIED_MODEL_EQUIVALENCES: readonly string[] = [];

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
