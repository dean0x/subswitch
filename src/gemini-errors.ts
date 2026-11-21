import { proxyErrorToAnthropic, type ProxyError } from "./errors.js";
import { GEMINI_EVENTS } from "./provider-events.js";

type GeminiErrorClass =
  | { readonly kind: "auth"; readonly status: 401 }
  | { readonly kind: "timeout"; readonly status: 504 }
  | { readonly kind: "translate"; readonly status: 400 }
  | { readonly kind: "upstream"; readonly status: 403 | 409 | 429 | 500 | 502 | 503 };

type GeminiErrorEntry = GeminiErrorClass & {
  readonly text: string;
  readonly hint: string;
  readonly event: (typeof GEMINI_EVENTS)[keyof typeof GEMINI_EVENTS];
};

const SIGN_IN = "Sign in again with `agy` in your own Terminal.";
const RETRY = "Retry the request.";
const RESTART = "Check your account, then restart Subswitch.";

// Preparation diagnostics share the runner's fixed 500 contract. No wire text enters this table.
const preparation = (hint: string) => ({ kind: "upstream", status: 500, event: GEMINI_EVENTS.credentialLoadFailed,
  text: "Gemini could not prepare the request.", hint } as const);
const BOOTSTRAP_ERRORS = {
  bootstrap_busy: preparation(RETRY), bootstrap_cancelled: preparation(RETRY), bootstrap_credential: preparation(SIGN_IN),
  bootstrap_project: preparation("Check for a Subswitch update."), bootstrap_response: preparation(RETRY),
  bootstrap_timeout: preparation(RETRY), bootstrap_transport: preparation(RETRY),
};
export type GeminiPrepareCode = keyof typeof BOOTSTRAP_ERRORS | "account_blocked";
export const geminiPrepareErrorCodes: ReadonlySet<string> = new Set([...Object.keys(BOOTSTRAP_ERRORS), "account_blocked"]);

export const GEMINI_ERRORS = {
  ...BOOTSTRAP_ERRORS,
  request_timeout: { kind: "timeout", status: 504, event: GEMINI_EVENTS.streamInterrupted,
    text: "The Gemini request timed out.", hint: RETRY },
  bootstrap_blocked: preparation(RESTART),
  credential_failed: { kind: "upstream", status: 500, event: GEMINI_EVENTS.credentialLoadFailed,
    text: "Gemini could not load the sign-in.", hint: SIGN_IN },
  unsupported_platform: {
    kind: "auth", status: 401, event: GEMINI_EVENTS.credentialLoadFailed,
    text: "Gemini sign-in is not available on this platform.", hint: "Use the Gemini route on macOS.",
  },
  missing: {
    kind: "auth", status: 401, event: GEMINI_EVENTS.credentialLoadFailed,
    text: "Subswitch did not find the Gemini sign-in in Keychain.", hint: SIGN_IN,
  },
  denied: {
    kind: "auth", status: 401, event: GEMINI_EVENTS.credentialLoadFailed,
    text: "Keychain did not permit access to the Gemini sign-in.", hint: "Check Keychain access, then restart Subswitch.",
  },
  timeout: {
    kind: "timeout", status: 504, event: GEMINI_EVENTS.credentialLoadFailed,
    text: "Keychain did not reply in time.", hint: "Check Keychain access, then restart Subswitch.",
  },
  exec_failed: {
    kind: "upstream", status: 503, event: GEMINI_EVENTS.credentialLoadFailed,
    text: "Subswitch could not read from Keychain.", hint: "Check Keychain access, then restart Subswitch.",
  },
  malformed: {
    kind: "auth", status: 401, event: GEMINI_EVENTS.credentialLoadFailed,
    text: "The Gemini Keychain read returned an invalid value.", hint: SIGN_IN,
  },
  output_too_large: {
    kind: "auth", status: 401, event: GEMINI_EVENTS.credentialLoadFailed,
    text: "The Gemini Keychain read returned too much data.", hint: SIGN_IN,
  },
  invalid_record: {
    kind: "auth", status: 401, event: GEMINI_EVENTS.credentialLoadFailed,
    text: "The Gemini sign-in record is not valid.", hint: SIGN_IN,
  },
  sign_in_again: {
    kind: "auth", status: 401, event: GEMINI_EVENTS.tokenRefreshFailed,
    text: "The Gemini sign-in is not usable.", hint: SIGN_IN,
  },
  cancelled: {
    kind: "timeout", status: 504, event: GEMINI_EVENTS.credentialLoadFailed,
    text: "The Gemini sign-in wait ended.", hint: RETRY,
  },
  account_blocked: {
    kind: "upstream", status: 403, event: GEMINI_EVENTS.upstreamError,
    text: "Gemini account access is blocked.", hint: RESTART,
  },
  invalid_request: {
    kind: "translate", status: 400, event: GEMINI_EVENTS.translateWarning,
    text: "Gemini does not support this request content.", hint: "Check the request and retry.",
  },
  image_unsupported: {
    kind: "translate", status: 400, event: GEMINI_EVENTS.translateWarning,
    text: "Gemini requests do not support images.", hint: "Remove the images and retry.",
  },
  signature_missing: {
    kind: "upstream", status: 409, event: GEMINI_EVENTS.translateWarning,
    text: "Gemini tool history needs a signature that Subswitch does not have.", hint: "Start a new conversation.",
  },
  // REPORTED reason names. The wire field that carries the reason is not qualified.
  TOS_VIOLATION: {
    kind: "upstream", status: 403, event: GEMINI_EVENTS.upstreamError,
    text: "Gemini blocked access to the account.", hint: RESTART,
  },
  UNSUPPORTED_CLIENT: {
    kind: "upstream", status: 403, event: GEMINI_EVENTS.upstreamError,
    text: "Gemini refused this client.", hint: "Check for a Subswitch update.",
  },
  VALIDATION_REQUIRED: {
    kind: "upstream", status: 403, event: GEMINI_EVENTS.upstreamError,
    text: "Gemini requires account validation.", hint: "Open `agy` in your own Terminal.",
  },
  RESOURCE_EXHAUSTED: {
    kind: "upstream", status: 429, event: GEMINI_EVENTS.upstreamError,
    text: "Gemini has no quota for this request.", hint: "Retry later.",
  },
  rate_limited: {
    kind: "upstream", status: 429, event: GEMINI_EVENTS.upstreamError,
    text: "Gemini limited the request rate.", hint: "Retry later.",
  },
  upstream_error: {
    kind: "upstream", status: 502, event: GEMINI_EVENTS.upstreamError,
    text: "Gemini did not complete the request.", hint: "Retry later.",
  },
} as const satisfies Readonly<Record<string, GeminiErrorEntry>>;

export type GeminiErrorCode = keyof typeof GEMINI_ERRORS;

export const toGeminiProxyError = (code: GeminiErrorCode): ProxyError => {
  const entry: GeminiErrorEntry = GEMINI_ERRORS[code];
  const message = `${entry.text} ${entry.hint}`;
  return entry.kind === "upstream" ? { kind: "upstream", status: entry.status, message } : { kind: entry.kind, message };
};

/** Runner failures have no qualified upstream detail. Keep its preparation status and fixed diagnostics. */
export const renderGeminiRunnerError = (error: ProxyError, diagnostic?: string): ProxyError => {
  if (diagnostic === "account_blocked") return toGeminiProxyError("bootstrap_blocked");
  if (diagnostic !== undefined && Object.hasOwn(BOOTSTRAP_ERRORS, diagnostic)) {
    return toGeminiProxyError(diagnostic as keyof typeof BOOTSTRAP_ERRORS);
  }
  if (diagnostic !== undefined) return toGeminiProxyError("credential_failed");
  if (error.kind === "timeout") return toGeminiProxyError("request_timeout");
  if (error.kind === "auth") return toGeminiProxyError("sign_in_again");
  return toGeminiProxyError("upstream_error");
};

export interface GeminiAccountBlockLatch {
  readonly isBlocked: () => boolean;
  readonly block: () => void;
}

/** Share one latch across auth, bootstrap and the Gemini request path. It has no reset. */
export const createGeminiAccountBlockLatch = (): GeminiAccountBlockLatch => {
  let blocked = false;
  return { isBlocked: () => blocked, block: () => { blocked = true; } };
};

const upstreamCode = (status: number, reportedReason: unknown): GeminiErrorCode => {
  if (reportedReason === "TOS_VIOLATION") return "TOS_VIOLATION";
  if (status === 403) {
    if (reportedReason === "UNSUPPORTED_CLIENT" || reportedReason === "VALIDATION_REQUIRED") return reportedReason;
    return "account_blocked";
  }
  if (status === 401) return "sign_in_again";
  if (status === 429) return reportedReason === "RESOURCE_EXHAUSTED" ? "RESOURCE_EXHAUSTED" : "rate_limited";
  return "upstream_error";
};

const RETRY_AFTER = /^\d{1,6}$/;

/** The caller supplies a reason candidate, never a message. No wire layout is assumed here. */
export const renderGeminiUpstreamError = (
  status: number, reportedReason: unknown, headers: Headers, accountBlock: GeminiAccountBlockLatch,
) => {
  const errorCode = upstreamCode(status, reportedReason);
  if (errorCode === "TOS_VIOLATION" || errorCode === "account_blocked") accountBlock.block();
  const error = toGeminiProxyError(errorCode);
  const retryAfter = headers.get("retry-after");
  return {
    ...proxyErrorToAnthropic(error), message: error.message, errorCode,
    headers: retryAfter !== null && RETRY_AFTER.test(retryAfter) ? { "retry-after": retryAfter } : {},
  };
};
