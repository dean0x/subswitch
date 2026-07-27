/**
 * Compile-time proof that a credential branded for one provider cannot be wired into
 * another provider's handler.
 *
 * This is the ONLY valid proof of the brand. No runtime test can observe a type error,
 * so a `.test.ts` file with assertions in it would be testing something else entirely.
 * `npm run typecheck` is the gate and it covers this file because tsconfig.json includes
 * `test/**\/*.ts`. Everything lives in functions that are never called.
 *
 * `@ts-expect-error` fails in BOTH directions: it errors if the line below it compiles
 * (the brand stopped being load-bearing) and the line itself errors if the annotation is
 * removed. Dropping the `provider` field from `ProviderCredential` — the mutation this
 * file exists to catch — erases `P` from the type's structure, makes every mismatch below
 * legal, and turns each directive into an unused-directive error.
 *
 * WHY THE MISMATCH IS EXPRESSED WITH TWO TYPE PARAMETERS rather than two concrete ids.
 * `PROVIDER_IDS` has one member, so `ProviderId` and `"codex"` are the *same* type today
 * and `ProviderAuth<ProviderId>` is assignable to `ProviderAuth<"codex">` in both
 * directions. A `@ts-expect-error` on that pair would be an unused directive, i.e. a
 * failing typecheck that says nothing about the brand. Two unrelated parameters
 * `P`/`Q extends ProviderId` are not collapsed by the compiler, so they express "two
 * different providers" with no cast and no fictional id — the same technique
 * `provider-events.types.test.ts` uses, and the exact situation a second real provider
 * creates. (mirrors test/unit/provider-events.types.test.ts)
 */
import { createCodexHandler } from "../../src/codex-handler.js";
import type { ProviderAuth, ProviderCredential } from "../../src/provider-auth.js";
import type { ProviderId } from "../../src/models.js";
import type { CodexProviderConfig } from "../../src/config.js";
import type { Logger } from "../../src/logger.js";
import type { ReasoningCache } from "../../src/reasoning-cache.js";

declare const provider: CodexProviderConfig;
declare const logger: Logger;
declare const cache: ReasoningCache;
declare const pingIntervalMs: number;

/**
 * THE BARRIER. `providerId` and `auth` share one type parameter, so wiring provider Q's
 * credential into provider P's handler cannot compile. This is the failure mode the
 * deleted CROSS-PROVIDER CREDENTIAL HAZARD comment in server.ts described in prose: one
 * provider's subscription token going out to another provider's host. It is now a `tsc`
 * diagnostic at the wiring site, which is where the mistake gets made. (applies ADR-002)
 */
const wiringAnotherProvidersCredentialIsACompileError = <P extends ProviderId, Q extends ProviderId>(
  providerId: P,
  otherProvidersAuth: ProviderAuth<Q>,
): void => {
  createCodexHandler({
    // @ts-expect-error the handler's id and its credential must name the same provider.
    // Inference fixes the parameter from `auth`, so the mismatch surfaces here.
    providerId,
    provider,
    pingIntervalMs,
    logger,
    auth: otherProvidersAuth,
    cache,
  });
};
void wiringAnotherProvidersCredentialIsACompileError;

/** The matching wiring — the same shape with one provider — must still compile. */
const wiringOwnCredentialCompiles = <P extends ProviderId>(providerId: P, ownAuth: ProviderAuth<P>): void => {
  createCodexHandler({ providerId, provider, pingIntervalMs, logger, auth: ownAuth, cache });
};
void wiringOwnCredentialCompiles;

const credentialsAreNotInterchangeable = <P extends ProviderId, Q extends ProviderId>(): void => {
  declare2<ProviderAuth<Q>>();

  // @ts-expect-error the seam itself, independent of the handler: one provider's auth is
  // not another's, even though `refreshable` and `authHeaders` are structurally identical.
  const swappedAuth: ProviderAuth<P> = declare2<ProviderAuth<Q>>();
  void swappedAuth;

  // @ts-expect-error and neither is a single credential, which is what actually reaches
  // the outbound request headers.
  const swappedCredential: ProviderCredential<P> = declare2<ProviderCredential<Q>>();
  void swappedCredential;
};
void credentialsAreNotInterchangeable;

/**
 * Widening MUST stay legal: a dispatch table typed `Record<ProviderId, ProviderAuth<ProviderId>>`
 * has to accept each provider's own auth. A brand that blocked this would be unusable.
 */
const wideningToTheUnionIsAllowed = <P extends ProviderId>(ownAuth: ProviderAuth<P>): void => {
  const anyProvidersAuth: ProviderAuth<ProviderId> = ownAuth;
  void anyProvidersAuth;
};
void wideningToTheUnionIsAllowed;

// TODO(second-provider): when PROVIDER_IDS grows past one member, add the concrete pair —
// `const narrowed: ProviderAuth<"codex"> = anyAuth` with anyAuth: ProviderAuth<ProviderId> —
// which only becomes a real narrowing once the union has something to narrow from. Do NOT
// cast a fabricated "kimi" through `string` into ProviderId to fake it here: that would
// pin the cast, not the brand.

/** Stand-in for a value of an arbitrary type, so the cases above need no fixtures. */
declare function declare2<T>(): T;
