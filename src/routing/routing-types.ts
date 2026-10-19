/** Explicit-route contracts. Legacy provider identifiers retain their existing meaning. */
export type DestinationProviderId = "codex" | "claude" | "kimi";
export type OriginatingClient = "claude-code" | "codex";
export type WireProtocol = "messages" | "responses";
export type BillingMode = "subscription" | "api";
export type CredentialReference =
  | { kind: "env"; name: string }
  | { kind: "native-oauth"; authFile: string };
export interface AccessProfile {
  provider: DestinationProviderId;
  product:
    | "chatgpt-codex"
    | "openai-api"
    | "claude-code"
    | "anthropic-api"
    | "kimi-code"
    | "kimi-platform";
  region?: "mainland-cn" | "global" | undefined;
  billing: BillingMode;
  account: string;
  credential: CredentialReference;
  baseUrl?: string | undefined;
  allowInsecureBaseUrl?: boolean | undefined;
}
export interface RouteTarget {
  profile: string;
  model: string;
  effort: string;
}
export interface RoutePolicy {
  clients: OriginatingClient[];
  primary: RouteTarget;
  sameModelApi?: RouteTarget | undefined;
  fallbacks: RouteTarget[];
  transientTriggers: ("overload" | "transport")[];
  affinity: "native-or-explicit";
}
export interface AllowanceScope {
  provider: DestinationProviderId;
  product: string;
  region?: string;
  account: string;
  allowanceGroup: string;
  modelScope?: string;
}
export interface QuotaObservation {
  id: string;
  exhausted: boolean | "unknown";
  resetAt?: number;
  observedAt: number;
  source: "inference" | "usage";
}
export type FailureKind =
  | "quota"
  | "rate_limit"
  | "concurrency"
  | "overload"
  | "auth"
  | "permission"
  | "invalid_request"
  | "transport"
  | "protocol"
  | "cancelled"
  | "unknown";
export interface ClassifiedFailure {
  kind: FailureKind;
  status?: number;
  providerCode?: string;
  evidence: "documented" | "source-inspected" | "live-observed" | "unknown";
  scope?: AllowanceScope;
  windows: readonly QuotaObservation[];
  retryAt?: number;
  bodyTruncated: boolean;
  responseCommitted: boolean;
}
export interface ActionContext {
  client: OriginatingClient;
  namespace: string;
  conversationId: string;
  actionId: string;
  agentId: string;
  parentActionId?: string;
}
export interface ActionAffinity {
  context: ActionContext;
  logicalRoute: string;
  selectedTarget?: RouteTarget;
  chainIndex: number;
  selectedOwner?: string;
  phase: "active" | "closing" | "completed" | "cancelled" | "interrupted";
}
export type Item = Record<string, unknown>;
export interface ClientEvent {
  protocol: WireProtocol;
  payload: Item;
}
export class RoutingError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400,
  ) {
    super(code);
  }
}
export const allowanceScope = (profile: AccessProfile): AllowanceScope => ({
  provider: profile.provider,
  product: profile.product,
  account: profile.account,
  ...(profile.region ? { region: profile.region } : {}),
  allowanceGroup: profile.product,
});
