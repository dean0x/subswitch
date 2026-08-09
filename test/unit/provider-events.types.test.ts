/**
 * Compile-time proof that log event names can only be derived from the closed
 * `ProviderId` union.
 *
 * This is the PRIMARY control for the event-token injection hole described in
 * `src/provider-events.ts` and `src/logger.ts`. The newline stripping in `renderToken`
 * is defence in depth; the guarantee that no attacker-controlled string ever becomes an
 * event name is enforced here, by the type of `providerEvents`' parameter.
 *
 * No runtime assertions and no test cases — `npm run typecheck` is the gate, and it
 * covers this file because tsconfig.json includes `test/**\/*.ts`. Everything lives in
 * functions that are never called.
 *
 * `@ts-expect-error` fails in both directions: it errors if the line below it compiles
 * (the guarantee was lost) and the line itself errors if the annotation is removed.
 */
import { providerEvents } from "../../src/provider-events.js";
import type { ProviderId } from "../../src/models.js";

const onlyProviderIdsCanBecomeEventNames = (): void => {
  // The one legitimate call shape: a compile-time literal from the closed union.
  const events = providerEvents("codex");
  const name: "codex_upstream_error" = events.upstreamError;
  void name;

  // The new insecureBaseUrlScheme event is also a compile-time template literal.
  const schemeEvent: "codex_insecure_base_url_scheme" = events.insecureBaseUrlScheme;
  void schemeEvent;

  // @ts-expect-error a value read from config is `string`, and `string` is not a
  // ProviderId. THIS is the log-injection barrier: a provider id supplied by a config
  // file cannot reach the derivation at all, so it cannot carry a newline into the
  // event token no matter what it contains.
  providerEvents(configSuppliedProviderId);

  // @ts-expect-error a literal carrying a forged record is not a ProviderId either. The
  // rejection is by union membership, not by inspecting the string, so it holds for
  // every payload — `\r`, `=`, whitespace — not just the newline case spelled here.
  providerEvents("codex\nlevel=error event=fake");

  // @ts-expect-error a plausible-looking id that is not in PROVIDER_IDS is still rejected;
  // the union is the allow-list.
  providerEvents("kimi");
};
void onlyProviderIdsCanBecomeEventNames;

declare const configSuppliedProviderId: string;

const eventNamesAreTiedToTheProviderTheyName = <P extends ProviderId>(providerId: P): void => {
  const events = providerEvents(providerId);

  // Each name's type is a template literal over the provider's own type parameter, so a
  // name cannot be reassigned to a different provider's — and, inside `providerEvents`
  // itself, a hardcoded `"codex_upstream_error"` is not assignable to `${P}_upstream_error`.
  // That is what makes re-hardcoding any single event name a `tsc` failure rather than a
  // silent regression that stays green while PROVIDER_IDS has one member.
  const upstreamError: `${P}_upstream_error` = events.upstreamError;
  void upstreamError;

  // @ts-expect-error an event name derived for provider P is not a name for some other
  // suffix — the suffixes are literals, not free-form strings.
  const mismatchedSuffix: `${P}_upstream_error` = events.streamInterrupted;
  void mismatchedSuffix;

  // insecureBaseUrlScheme is a template literal over P — same guarantee as every other event.
  const insecureScheme: `${P}_insecure_base_url_scheme` = events.insecureBaseUrlScheme;
  void insecureScheme;

  // Auth manager events are template literals over P — same guarantee as handler events.
  const tokenRefreshed: `${P}_token_refreshed` = events.tokenRefreshed;
  void tokenRefreshed;

  const refreshTokenRotatedExternally: `${P}_refresh_token_rotated_externally` = events.refreshTokenRotatedExternally;
  void refreshTokenRotatedExternally;

  const tokenRefreshFailed: `${P}_token_refresh_failed` = events.tokenRefreshFailed;
  void tokenRefreshFailed;

  const refreshRetryBoundViolated: `${P}_refresh_retry_bound_violated` = events.refreshRetryBoundViolated;
  void refreshRetryBoundViolated;

  const authFileNewerThanRefresh: `${P}_auth_file_newer_than_refresh` = events.authFileNewerThanRefresh;
  void authFileNewerThanRefresh;

  const authFileWriteFailed: `${P}_auth_file_write_failed` = events.authFileWriteFailed;
  void authFileWriteFailed;

  const authFileUnreadableAfterRefresh: `${P}_auth_file_unreadable_after_refresh` = events.authFileUnreadableAfterRefresh;
  void authFileUnreadableAfterRefresh;
};
void eventNamesAreTiedToTheProviderTheyName;
