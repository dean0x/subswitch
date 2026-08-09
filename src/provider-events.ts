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
  /**
   * A URL (baseUrl or oauthTokenUrl) uses http to a non-loopback host, sending
   * credentials over cleartext. Emitted at startup by `buildDeps` for each affected
   * provider. Loopback addresses (127.0.0.0/8, localhost, ::1) are exempt — the e2e dev
   * workflow intentionally points baseUrl at http://127.0.0.1:4142.
   *
   * COMPILE-TIME SAFETY: this field is a template literal over `P extends ProviderId`
   * for the same reason every other field here is — a config-supplied string cannot
   * reach the derivation, so it cannot inject a newline or `=` into the log line.
   */
  readonly insecureBaseUrlScheme: `${P}_insecure_base_url_scheme`;
  /**
   * A URL (baseUrl or oauthTokenUrl) points at a non-default host and
   * `allowInsecureBaseUrl` is false. Emitted at error level; `buildDeps` returns an
   * error Result so `serve` can exit non-zero. Loopback hosts are always exempt.
   *
   * COMPILE-TIME SAFETY: template literal over `P extends ProviderId` — same guarantee
   * as every other field in this interface.
   */
  readonly baseUrlHostRejected: `${P}_base_url_host_rejected`;

  // -------------------------------------------------------------------------
  // Auth manager events (formerly hardcoded in codex-auth.ts).
  //
  // Moving them into this table gives a second provider's auth manager the same
  // table-derived naming guarantee and removes the one place where a hardcoded
  // `codex_*` literal lived outside the derivation.  The compile-time guarantee
  // is identical to the fields above: every name is a template literal over
  // `P extends ProviderId`, so a config-supplied string cannot reach it.
  // -------------------------------------------------------------------------

  /** OAuth access token was successfully refreshed via the token endpoint. */
  readonly tokenRefreshed: `${P}_token_refreshed`;
  /**
   * A concurrent process (e.g. the Codex CLI) rotated the refresh token under
   * us while our invalid_grant was in flight; we re-read the file and retry.
   */
  readonly refreshTokenRotatedExternally: `${P}_refresh_token_rotated_externally`;
  /** Token refresh failed at the token endpoint (invalid_grant or network error). */
  readonly tokenRefreshFailed: `${P}_token_refresh_failed`;
  /**
   * The auth refresh retry bound was violated — the loop exited without a return,
   * meaning the loop bound and the continue guard have drifted apart.  This is a
   * programming error, never a credential or upstream condition.
   */
  readonly refreshRetryBoundViolated: `${P}_refresh_retry_bound_violated`;
  /**
   * The on-disk auth file was written more recently than our own refresh result,
   * meaning a concurrent process (e.g. the Codex CLI) won the race; the newer
   * file's token is used instead of persisting ours.
   */
  readonly authFileNewerThanRefresh: `${P}_auth_file_newer_than_refresh`;
  /**
   * Writing the refreshed auth file failed.  Emitted at warn unless the response
   * carried a new refresh_token (in which case the on-disk copy is now stale and
   * the next OAuth call will fail with invalid_grant — emitted at error).
   */
  readonly authFileWriteFailed: `${P}_auth_file_write_failed`;
  /**
   * The auth file could not be read immediately after a successful token refresh
   * (vanished or corrupted mid-refresh).  The fresh in-memory token is served
   * for this request; the next cycle re-reads from disk.
   */
  readonly authFileUnreadableAfterRefresh: `${P}_auth_file_unreadable_after_refresh`;
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
  insecureBaseUrlScheme: `${providerId}_insecure_base_url_scheme`,
  baseUrlHostRejected: `${providerId}_base_url_host_rejected`,
  tokenRefreshed: `${providerId}_token_refreshed`,
  refreshTokenRotatedExternally: `${providerId}_refresh_token_rotated_externally`,
  tokenRefreshFailed: `${providerId}_token_refresh_failed`,
  refreshRetryBoundViolated: `${providerId}_refresh_retry_bound_violated`,
  authFileNewerThanRefresh: `${providerId}_auth_file_newer_than_refresh`,
  authFileWriteFailed: `${providerId}_auth_file_write_failed`,
  authFileUnreadableAfterRefresh: `${providerId}_auth_file_unreadable_after_refresh`,
});
