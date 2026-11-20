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
 * (the guarantee was lost) and the line itself errors if the annotation is removed.
 *
 * TWO MECHANISMS, MEASURED SEPARATELY — do not conflate them. Dropping the `provider`
 * field from `ProviderCredential` was applied as a mutation, and the result was more
 * precise than expected:
 *
 *   1. `CodexHandlerDeps<P>` sharing one type parameter between `providerId` and `auth`
 *      is what fails the WIRING SITE. That diagnostic survives the brand's removal —
 *      inference still fixes the parameter from one field and rejects the other.
 *   2. The `provider: P` field is what keeps `ProviderCredential`/`ProviderAuth` VALUES
 *      from being interchangeable anywhere else — passed to a helper, stored in a table,
 *      returned from a factory — where no shared parameter is doing the work. Without it,
 *      `P` is structurally absent and the two cases in
 *      `credentialsAreNotInterchangeable` below go green (their directives go unused,
 *      which fails typecheck — that is the mutation's red).
 *
 * Both are needed and both are pinned here: case 1 by
 * `wiringAnotherProvidersCredentialIsACompileError`, case 2 by
 * `credentialsAreNotInterchangeable`.
 *
 * The handler uses two type parameters because its model catalog has one provider.
 * The credential seam also accepts native destination ids, so its test can use two real ids.
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
declare const loginCommand: string;

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
    loginCommand,
    logger,
    auth: otherProvidersAuth,
    cache,
  });
};
void wiringAnotherProvidersCredentialIsACompileError;

/** The matching wiring — the same shape with one provider — must still compile. */
const wiringOwnCredentialCompiles = <P extends ProviderId>(providerId: P, ownAuth: ProviderAuth<P>): void => {
  createCodexHandler({ providerId, provider, pingIntervalMs, loginCommand, logger, auth: ownAuth, cache });
};
void wiringOwnCredentialCompiles;

/**
 * THE BRAND, isolated from the handler. These are the cases that go green — and so fail
 * typecheck on an unused directive — the moment `ProviderCredential` stops carrying `P`
 * as a real field. They cover every place a credential travels by value rather than
 * through `CodexHandlerDeps<P>`'s shared type parameter.
 */
const credentialsAreNotInterchangeable = (): void => {
  // @ts-expect-error Claude auth cannot supply Codex credentials.
  const swappedAuth: ProviderAuth<"codex"> = anyValue<ProviderAuth<"claude">>();
  void swappedAuth;

  // @ts-expect-error A Codex credential cannot supply Claude auth headers.
  const swappedCredential: ProviderCredential<"claude"> = anyValue<ProviderCredential<"codex">>();
  void swappedCredential;
};
void credentialsAreNotInterchangeable;

/**
 * `forceRefresh` takes the refused credential with its brand. Thus an auth for one provider
 * does not widen to `ProviderAuth<ProviderId | DestinationProviderId>`, because that type
 * would accept another provider's credential as `failed`. Key a table of auths by provider id.
 */
const refreshTakesOnlyItsOwnFailedCredential = (codexAuth: ProviderAuth<"codex">, signal: AbortSignal): void => {
  // @ts-expect-error A Claude credential cannot be the refused Codex credential.
  void codexAuth.forceRefresh(signal, anyValue<ProviderCredential<"claude">>());
};
void refreshTakesOnlyItsOwnFailedCredential;

const credentialLoadAcceptsAnOptionalSignal = (auth: ProviderAuth<ProviderId>, signal: AbortSignal): void => {
  void auth.getCredentials();
  void auth.getCredentials(signal);
};
void credentialLoadAcceptsAnOptionalSignal;

/** Callers that pass no arguments, or only the signal, need no change. */
const refreshAcceptsOptionalArguments = (auth: ProviderAuth<"codex">, signal: AbortSignal,
  failed: ProviderCredential<"codex">): void => {
  void auth.forceRefresh();
  void auth.forceRefresh(signal);
  void auth.forceRefresh(signal, failed);
};
void refreshAcceptsOptionalArguments;

/** Stand-in for a value of an arbitrary type, so the cases above need no fixtures. */
declare function anyValue<T>(): T;
