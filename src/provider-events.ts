import type { ProviderId } from "./models.js";

/**
 * Log event names for one provider leg, derived from that provider's id.
 *
 * SECURITY — why the input type is `P extends ProviderId` and not `string`:
 *
 * `Logger.log(level, event, fields)` renders the event token into the same line as
 * everything else. `logger.ts` strips and quotes it (see `renderToken`), but that is
 * defence in depth, not the control. The control is here: the only value that can
 * reach the derivation is a member of the closed `ProviderId` union — a union of
 * compile-time string literals — so a config-supplied `string` is a COMPILE error at
 * the call site, not a runtime check that could be bypassed. A provider id read from
 * a config file and containing `\n` cannot become an event name, because it cannot
 * become a `ProviderId`.
 *
 * This also makes each name falsifiable. Every field's type is a template literal over
 * the type parameter, so inside this generic function a hardcoded `"codex_upstream_error"`
 * is not assignable to `` `${P}_upstream_error` `` — re-hardcoding any single name fails
 * `tsc`, and the runtime `providerId`-threading tests cover the rest.
 *
 * `FIELD_KEYS` in `logger.ts` is a different axis and is deliberately untouched: it
 * bounds which *fields* may be logged. Nothing here adds or widens a field.
 */
export interface ProviderEvents<P extends ProviderId> {
  /** A request the translator could only partially represent. */
  readonly translateWarning: `${P}_translate_warning`;
  /** Reasoning effort was forwarded to the upstream. */
  readonly effortApplied: `${P}_effort_applied`;
  /** Upstream returned 401; a credential refresh is being attempted. */
  readonly upstream401Refreshing: `${P}_upstream_401_refreshing`;
  /**
   * The bounded auth retry ended without a response — the retry bound and the refresh
   * guard disagree. A programming error, never an upstream or credential condition.
   */
  readonly retryBoundViolated: `${P}_retry_bound_violated`;
  /** Upstream returned a non-2xx status. */
  readonly upstreamError: `${P}_upstream_error`;
  /** The response stream failed after the first frame reached the client. */
  readonly streamInterrupted: `${P}_stream_interrupted`;
  /** An SSE event whose `data:` payload is not JSON. */
  readonly sseUnparseableData: `${P}_sse_unparseable_data`;
  /** An SSE event of a type this translator does not handle. */
  readonly sseEventIgnored: `${P}_sse_event_ignored`;
  /** Cached input-token count from the upstream's terminal usage report. */
  readonly cacheTokens: `${P}_cache_tokens`;
  /** Truncated conversation-key prefix, for verifying session stability. */
  readonly sessionKey: `${P}_session_key`;
  /** The configured base URL points at a host other than this provider's default. */
  readonly baseUrlOverrideDetected: `${P}_base_url_override_detected`;
}

/**
 * Resolve a provider's event names once, at construction time.
 *
 * Callers hold the returned record for the life of the handler or translator rather
 * than re-deriving per chunk, so the hot streaming path does no string work.
 */
export const providerEvents = <P extends ProviderId>(providerId: P): ProviderEvents<P> => ({
  translateWarning: `${providerId}_translate_warning`,
  effortApplied: `${providerId}_effort_applied`,
  upstream401Refreshing: `${providerId}_upstream_401_refreshing`,
  retryBoundViolated: `${providerId}_retry_bound_violated`,
  upstreamError: `${providerId}_upstream_error`,
  streamInterrupted: `${providerId}_stream_interrupted`,
  sseUnparseableData: `${providerId}_sse_unparseable_data`,
  sseEventIgnored: `${providerId}_sse_event_ignored`,
  cacheTokens: `${providerId}_cache_tokens`,
  sessionKey: `${providerId}_session_key`,
  baseUrlOverrideDetected: `${providerId}_base_url_override_detected`,
});
