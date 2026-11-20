// The closed set of Kimi sign-in failures. Each code has one ProxyError kind and client
// status, fixed text, a hint for the user and one log event. The text names no path and
// holds no record text, so a reply or a log line can not carry a credential or a local path.
import type { ProxyError } from "./errors.js";
import { KIMI_EVENTS } from "./provider-events.js";

type KimiEventName = (typeof KIMI_EVENTS)[keyof typeof KIMI_EVENTS];

/** Each ProxyError kind, with the client status that `proxyErrorToAnthropic` gives it. */
type KimiErrorClass =
  | { readonly kind: "auth"; readonly status: 401 }
  | { readonly kind: "timeout"; readonly status: 504 }
  | { readonly kind: "upstream"; readonly status: 503 };

export type KimiErrorEntry = KimiErrorClass & {
  readonly text: string;
  readonly hint: string;
  readonly event: KimiEventName;
};

const SIGN_IN = "Run `kimi login` in your own Terminal.";
const RUN_CLI_ONCE = "Run the Kimi CLI once in your own Terminal, then retry.";
const RETRY = "Retry the request.";

export const KIMI_ERRORS = {
  // Failures of the sign-in store: the file, its folders, the lock and the renewal marker.
  platform_unsupported: {
    kind: "auth", status: 401, event: KIMI_EVENTS.credentialLoadFailed,
    text: "Kimi sign-in is not available on this platform.", hint: "Use the Kimi route on macOS or Linux.",
  },
  credential_missing: {
    kind: "auth", status: 401, event: KIMI_EVENTS.credentialLoadFailed,
    text: "Subswitch did not find the Kimi sign-in file.", hint: SIGN_IN,
  },
  unsafe_path: {
    kind: "auth", status: 401, event: KIMI_EVENTS.credentialLoadFailed,
    text: "The Kimi sign-in file or one of its folders is not private to your user.",
    hint: "Set mode 0700 on the folders and mode 0600 on the file, remove links, then retry.",
  },
  changed: {
    kind: "upstream", status: 503, event: KIMI_EVENTS.credentialLoadFailed,
    text: "The Kimi sign-in file changed while Subswitch read it.", hint: RETRY,
  },
  invalid_record: {
    kind: "auth", status: 401, event: KIMI_EVENTS.credentialLoadFailed,
    text: "The Kimi sign-in file does not hold a valid sign-in record.", hint: SIGN_IN,
  },
  layout_unsupported: {
    kind: "auth", status: 401, event: KIMI_EVENTS.credentialLoadFailed,
    text: "The Kimi sign-in files do not match a supported Kimi CLI version.",
    hint: "Use Kimi CLI version 0.38.0 to 2.7.2, then run `kimi login` in your own Terminal.",
  },
  reauthorization_required: {
    kind: "auth", status: 401, event: KIMI_EVENTS.tokenRefreshFailed,
    text: "The Kimi sign-in has ended.", hint: SIGN_IN,
  },
  invalid_marker: {
    kind: "auth", status: 401, event: KIMI_EVENTS.credentialLoadFailed,
    text: "The Subswitch renewal record for the Kimi sign-in is not valid.",
    hint: "Remove the file that ends in .subswitch-renewal.json from the Kimi oauth folder, then retry.",
  },
  lock_busy: {
    kind: "upstream", status: 503, event: KIMI_EVENTS.lockBusy,
    text: "Another process holds the Kimi sign-in lock.", hint: "Retry the request in a few seconds.",
  },
  lock_lost: {
    kind: "upstream", status: 503, event: KIMI_EVENTS.lockLost,
    text: "Subswitch lost the Kimi sign-in lock during a renewal.", hint: RUN_CLI_ONCE,
  },
  cancelled: {
    kind: "timeout", status: 504, event: KIMI_EVENTS.credentialWaitEnded,
    text: "The Kimi sign-in wait stopped because the request ended.", hint: RETRY,
  },
  unavailable: {
    kind: "auth", status: 401, event: KIMI_EVENTS.credentialLoadFailed,
    text: "Subswitch could not read or write the Kimi sign-in files.",
    hint: "Make sure that your user can read and write the Kimi sign-in files, then retry.",
  },
  // Failures of the renewal of the sign-in.
  refresh_required: {
    kind: "auth", status: 401, event: KIMI_EVENTS.tokenRefreshFailed,
    text: "Subswitch sent no Kimi renewal, because the request named no refused sign-in.", hint: RETRY,
  },
  refresh_busy: {
    kind: "upstream", status: 503, event: KIMI_EVENTS.tokenRefreshFailed,
    text: "The Kimi sign-in renewal must wait before the next try.", hint: "Retry the request later.",
  },
  refresh_unavailable: {
    kind: "upstream", status: 503, event: KIMI_EVENTS.tokenRefreshFailed,
    text: "Subswitch could not connect to the Kimi sign-in service.", hint: "Check the network connection, then retry.",
  },
  refresh_recovery_required: {
    kind: "auth", status: 401, event: KIMI_EVENTS.refreshRecoveryRequired,
    text: "A Kimi sign-in renewal has no known result, so Subswitch does not send it again.", hint: RUN_CLI_ONCE,
  },
  refresh_rejected: {
    kind: "auth", status: 401, event: KIMI_EVENTS.tokenRefreshFailed,
    text: "The Kimi sign-in service refused the renewal.", hint: SIGN_IN,
  },
  client_rejected: {
    kind: "auth", status: 401, event: KIMI_EVENTS.tokenRefreshFailed,
    text: "The Kimi sign-in service refused the Subswitch client, so Subswitch does not send this renewal again.",
    hint: "Update Subswitch, or run the Kimi CLI once in your own Terminal, then retry.",
  },
  timeout: {
    kind: "timeout", status: 504, event: KIMI_EVENTS.credentialWaitEnded,
    text: "The Kimi sign-in renewal did not complete in time.", hint: RETRY,
  },
} as const satisfies Readonly<Record<string, KimiErrorEntry>>;

export type KimiErrorCode = keyof typeof KIMI_ERRORS;

/** A typed Kimi failure. Its message is its code only: no path, no record text, no cause. */
export class KimiNativeError extends Error {
  override readonly name = "KimiNativeError";

  constructor(readonly code: KimiErrorCode) {
    super(code);
  }
}

/** The code of a typed Kimi failure. Any other value fails closed as `unavailable`. */
export const kimiErrorCodeOf = (error: unknown): KimiErrorCode =>
  error instanceof KimiNativeError ? error.code : "unavailable";

/** The client error for a code: its kind, its status and its fixed text and hint. */
export const toKimiProxyError = (code: KimiErrorCode): ProxyError => {
  const entry: KimiErrorEntry = KIMI_ERRORS[code];
  const message = `${entry.text} ${entry.hint}`;
  return entry.kind === "upstream" ? { kind: "upstream", status: entry.status, message } : { kind: entry.kind, message };
};
