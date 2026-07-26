import type { ProviderId } from "./models.js";
import type { ProxyError } from "./errors.js";
import type { Result } from "./result.js";

/**
 * Branded credentials for a specific provider.
 *
 * The phantom `provider` field prevents compile-silent cross-provider credential
 * injection. `ProviderCredentials<"codex">` is not assignable to
 * `ProviderCredentials<"kimi">` even though both carry `headers` of the same
 * structural type. A wiring mistake would be a compile error, not a silent runtime
 * data leak to a third-party host. (applies ADR-002)
 *
 * Headers-out rather than token-out: each provider builds its own auth headers so
 * a no-auth or static-key provider does not have to invent a fake token.
 */
export interface ProviderCredentials<P extends ProviderId> {
  readonly provider: P; // phantom brand — carries no runtime data
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * Provider-neutral auth abstraction.
 *
 * Retry semantics: `maxAttempts = auth.refreshable ? 2 : 1`.
 * - Codex sets `refreshable: true` — subscription token rotation via OAuth.
 * - A static-key provider sets `refreshable: false` — skip the retry entirely.
 *
 * `sessionId` derivation must stay OUTSIDE the retry loop so both attempts share
 * the same conversation key (applies ADR-003).
 */
export interface ProviderAuth<P extends ProviderId> {
  getCredentials(): Promise<Result<ProviderCredentials<P>, ProxyError>>;
  forceRefresh(): Promise<Result<ProviderCredentials<P>, ProxyError>>;
  /** false ⇒ skip the 401-refresh retry entirely */
  readonly refreshable: boolean;
}
