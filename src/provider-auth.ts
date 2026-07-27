import type { ProviderId } from "./models.js";
import type { ProxyError } from "./errors.js";
import type { Result } from "./result.js";

/**
 * Authentication material for exactly one provider, expressed as the HTTP headers
 * that carry it — and nothing else.
 *
 * `provider` is the brand, and it is a real field rather than a `unique symbol`
 * phantom, so a credential is constructible without a cast. Because `P` also appears
 * in that field, `ProviderCredential<"codex">` is not assignable to
 * `ProviderCredential<"kimi">` even though both carry structurally identical headers:
 * wiring one provider's subscription token into another provider's outbound request is
 * a COMPILE error rather than a runtime leak of that token to a third-party host.
 * (applies ADR-002)
 *
 * Headers rather than a token, and *only* the auth headers:
 *
 * - Headers, because the three auth flavours a second provider can plausibly bring are
 *   all expressible without inventing a value. Codex →
 *   `{ authorization: "Bearer <jwt>", "chatgpt-account-id": "<acct>" }`. A static API
 *   key → `{ authorization: "Bearer sk-…" }` or `{ "x-api-key": "…" }`. A local no-auth
 *   model → `{}`, which is a truthful statement; a token-shaped seam would force that
 *   provider to write `accessToken: ""` and call a fabricated value a credential.
 *   A token-shaped seam would also elevate one provider's credential fields
 *   (`{accessToken, accountId}` — literally the ChatGPT OAuth pair) into the shape every
 *   other provider has to pretend to have.
 *
 * - *Only* the auth headers, because the rest of what goes on a `/responses` request is
 *   transport, not credential: `openai-beta`, `originator`, `session_id`, `accept`,
 *   `content-type` are live-verified protocol constants that must not be re-derived
 *   (avoids PF-005), and `user-agent` comes from config as a vendor-drift valve. The
 *   deleted first attempt at this file put all of that behind `headers`, which would
 *   have moved the protocol into the auth manager. It also declared headers while
 *   `CodexAuthManager` returned a token, so nothing in `src/` ever produced the type it
 *   described. Both halves are fixed here: the scope is narrowed to auth, and
 *   `CodexAuthManager` now actually returns this.
 *
 * One further payoff: everything secret sits under one key, so there is a single
 * redaction boundary to audit and `test/integration/credential-leak.test.ts` asserts
 * against the same surface the producer builds.
 */
export interface ProviderCredential<P extends ProviderId> {
  readonly provider: P;
  readonly authHeaders: Readonly<Record<string, string>>;
}

/**
 * The credential-supplying half of a provider leg, branded with the provider it speaks for.
 *
 * Members are declared as readonly properties of function type rather than with method
 * shorthand on purpose: method parameters are compared bivariantly even under
 * `strictFunctionTypes`, so the day one of these takes an argument, method syntax would
 * quietly stop enforcing the brand across it. Property syntax keeps the check strict by
 * construction rather than by remembering to revisit it.
 *
 * A class may still `implement` this with ordinary methods — a method is assignable to a
 * property of function type — so `CodexAuthManager` needs no shape change to conform.
 */
export interface ProviderAuth<P extends ProviderId> {
  /**
   * Whether this provider's credential can be renewed in-process.
   *
   * Read by the handler to size its retry bound: `maxAttempts = refreshable ? 2 : 1`.
   * `false` ⇒ exactly one attempt, so a static-credential provider's truthful 401
   * reaches the client instead of a synthesised refresh failure.
   */
  readonly refreshable: boolean;
  readonly getCredentials: () => Promise<Result<ProviderCredential<P>, ProxyError>>;
  readonly forceRefresh: () => Promise<Result<ProviderCredential<P>, ProxyError>>;
}
