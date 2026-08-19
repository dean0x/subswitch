/**
 * Match a Bearer token (token value may be any base64url-safe chars plus common extras).
 * Applied BEFORE the JWT pattern so that a `Bearer eyJ….….…` is consumed whole and
 * does not leave a dangling `Bearer ` prefix for the JWT pattern to trip over.
 *
 * The {12,} minimum prevents false positives: short words like "token" or "auth" that
 * follow "Bearer" in ordinary prose (e.g. "Missing bearer token in Authorization header")
 * are not redacted. Real credentials are always longer than 12 characters.
 *
 * Both patterns are linear (no nested quantifiers) — inputs are already bounded
 * by the 2 KB body peek cap and maxSseEventBytes.
 *
 * /g flag safety: safe with String.replace (resets lastIndex after each call).
 * Do NOT use these patterns with .test() or exec() without resetting lastIndex —
 * the stateful lastIndex of /g patterns alternates results on repeated calls.
 */
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9\-._~+/]{12,}=*/gi;

/**
 * Match a standalone JWT (three dot-separated base64url segments, first starting with eyJ).
 * The `\b` word boundary prevents a partial match inside a longer token that the Bearer
 * pattern already consumed.
 * The eyJ prefix (base64url for '{"') is structurally specific to JWTs — no minimum-length
 * guard is needed here because false positives in ordinary prose are not plausible.
 *
 * /g flag safety: same note as BEARER_PATTERN above.
 */
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;

/**
 * Strip Bearer tokens and JWTs from a string before it reaches client-visible surfaces.
 *
 * Total: any string in, a string out — no throw, no undefined.
 *
 * Call site: toAnthropicErrorBody — every caller (toAnthropicErrorSse, respondProxyError)
 * inherits the redaction by construction, including the mid-stream response.failed SSE path.
 * This mirrors how FIELD_KEYS draws the logger's redaction boundary at the render site
 * rather than at every individual call site.
 *
 * Deliberately does NOT extend to sk-… tokens (unbounded prefix in practice) or use the
 * recorder's header-name-driven hashing helper (different threat model / different job).
 */
export const redactCredentials = (text: string): string =>
  text.replace(BEARER_PATTERN, "Bearer <redacted>").replace(JWT_PATTERN, "<redacted-jwt>");

export type ProxyError =
  | { readonly kind: "auth"; readonly message: string }
  | { readonly kind: "upstream"; readonly message: string; readonly status?: number }
  | { readonly kind: "translate"; readonly message: string }
  | { readonly kind: "body_too_large"; readonly message: string }
  | { readonly kind: "timeout"; readonly message: string }
  | { readonly kind: "client_disconnected"; readonly message: string };

export type AnthropicErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "permission_error"
  | "request_too_large"
  | "rate_limit_error"
  | "api_error"
  | "overloaded_error";

export interface AnthropicError {
  readonly status: number;
  readonly type: AnthropicErrorType;
}

/** Map an upstream HTTP status onto the Anthropic error taxonomy Claude Code understands. */
export const upstreamStatusToAnthropicError = (status: number): AnthropicError => {
  if (status === 400) return { status: 400, type: "invalid_request_error" };
  if (status === 401) return { status: 401, type: "authentication_error" };
  if (status === 403) return { status: 403, type: "permission_error" };
  if (status === 429) return { status: 429, type: "rate_limit_error" };
  if (status >= 400 && status < 500) return { status, type: "invalid_request_error" };
  return { status: status >= 500 ? status : 502, type: "api_error" };
};

export const proxyErrorToAnthropic = (error: ProxyError): AnthropicError => {
  switch (error.kind) {
    case "auth":
      return { status: 401, type: "authentication_error" };
    case "upstream":
      return upstreamStatusToAnthropicError(error.status ?? 502);
    case "translate":
      return { status: 400, type: "invalid_request_error" };
    case "body_too_large":
      return { status: 413, type: "request_too_large" };
    case "timeout":
      return { status: 504, type: "api_error" };
    case "client_disconnected":
      return { status: 499, type: "api_error" };
  }
};

export const toAnthropicErrorBody = (type: AnthropicErrorType, message: string): string =>
  JSON.stringify({ type: "error", error: { type, message: redactCredentials(message) } });

export const toAnthropicErrorSse = (type: AnthropicErrorType, message: string): string =>
  `event: error\ndata: ${toAnthropicErrorBody(type, message)}\n\n`;
