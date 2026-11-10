import { RoutingError } from "./routing-types.js";
import { MODEL_REGISTRY, reasoningEffortsForModel } from "../models.js";
import { CLAUDE_MODELS, CLAUDE_REASONING_EFFORTS } from "../claude-models.js";
import type {
  AccessProfile,
  DestinationProviderId,
  Item,
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
    "k3.1-pro",
    "k3.1-pro-highspeed",
    "k3",
    "k3-256k",
    "kimi-for-coding",
    "kimi-for-coding-highspeed",
  ],
  "kimi-platform": ["kimi-k3"],
} as const;

/** Native OAuth stores are implemented only for these exact provider/product pairs. */
export const supportsNativeOAuth = (profile: AccessProfile): boolean =>
  !(profile.credential.kind === "native-oauth" && profile.credential.source !== undefined &&
    (profile.credential.source !== "kimi-code" || profile.provider !== "kimi")) && (
    (profile.provider === "codex" && profile.product === "chatgpt-codex") ||
    (profile.provider === "claude" && profile.product === "claude-code") ||
    (profile.provider === "kimi" && profile.product === "kimi-code"));

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
  // K2.7 Highspeed has fixed thinking, not adjustable effort. A route requires
  // an explicit effort; reject it until fixed-thinking targets are supported.
  // Source: https://www.kimi.com/code/docs/en/kimi-code/models.html (2026-10-28).
  if (model === "kimi-for-coding-highspeed") return [];
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
  return base + path + (profile.product === "kimi-code" && profile.credential.kind === "native-oauth" && protocol === "messages" ? "?beta=true" : "");
}
/** Intentionally empty until exact product/region/capability live gates pass (#74). */
export const VERIFIED_MODEL_EQUIVALENCES: readonly string[] = [];

/** Internal function data, never a caller capability. Scope is validated by the owning ActionStore. */
export interface DestinationSelection {
  readonly protocol: WireProtocol;
  readonly codec?: "kimi-ordered-messages-v4";
}

/** One resolver for capability checks, ownership, adaptation, replay and refusal classification. */
export function resolveDestination(
  profile: AccessProfile,
  ingress: WireProtocol,
  body: Item,
  activeExplicitClaudeAction = false,
): Readonly<DestinationSelection> {
  const eligible = ingress === "messages" && profile.provider === "kimi" && profile.product === "kimi-code" &&
    profile.region === "global" && profile.billing === "subscription" && profile.credential.kind === "native-oauth";
  if (eligible) {
    if (activeExplicitClaudeAction)
      return Object.freeze({ protocol: "responses", codec: "kimi-ordered-messages-v4" });
    // Unscoped leading Messages retains the native path. Late instructions still
    // require an explicit action; no body or metadata can supply that authority.
    let history = false;
    if (Array.isArray(body["messages"])) for (const message of body["messages"]) {
      if (message && typeof message === "object" && message.role === "system") {
        if (history) throw new RoutingError("action_identity_required", 409);
      } else history = true;
    }
  }
  const definition = DESTINATIONS.find(destination => destination.id === profile.provider)!;
  return Object.freeze({ protocol: definition.protocols.includes(ingress) ? ingress : definition.protocols[0]! });
}
