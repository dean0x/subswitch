import { object } from "../plain-object.js";
import type { BoundedText } from "../provider-transport.js";
import type { Logger } from "../logger.js";
import {
  allowanceScope,
  type AllowanceScope,
  type ClassifiedFailure,
  type FailureKind,
} from "./routing-types.js";

const FAILURE_STAGES = ["http_response", "sse_error"] as const;
const FAILURE_CATEGORIES = [
  "quota", "rate_limit", "concurrency", "overload", "auth", "permission",
  "invalid_request", "transport", "protocol", "cancelled", "unknown",
] as const satisfies readonly FailureKind[];

/** Diagnostic only: status is the HTTP response's status, never an SSE envelope's.
 * Only fixed enums and numeric/null status reach the log sink. */
export function logProviderFailure(
  logger: Logger | undefined,
  stage: (typeof FAILURE_STAGES)[number],
  kind: FailureKind,
  httpStatus: unknown,
): void {
  try {
    logger?.log("info", "route_provider_failure", {
      eventType: FAILURE_STAGES.some(value => value === stage) ? stage : "unknown",
      errorCode: FAILURE_CATEGORIES.some(value => value === kind) ? kind : "unknown",
      status: typeof httpStatus === "number" && Number.isInteger(httpStatus) &&
        httpStatus >= 100 && httpStatus <= 599 ? httpStatus : null,
    });
  } catch {
    // A diagnostic sink must not replace the original failure or change retries.
  }
}

export function validatedRetryAt(
  value: string | null,
  now: number,
): number | undefined {
  if (!value) return undefined;
  if (/^\d{1,10}$/.test(value)) return now + Number(value) * 1000;
  if (
    !/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(
      value,
    )
  )
    return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed >= now ? parsed : undefined;
}
/** Classify the original envelope, before any ingress error translation. Never echo it. */
export function classifyFailure(
  profile: Pick<AllowanceScope, "provider" | "product" | "account">,
  status: number,
  body: BoundedText,
  now: number,
  retryAfter: string | null = null,
): ClassifiedFailure {
  let kind: FailureKind = "unknown",
    providerCode: string | undefined;
  let error: Record<string, unknown> | undefined;
  if (body.complete && !body.truncated) {
    try {
      error = object(object(JSON.parse(body.text))?.["error"]);
    } catch {
      /* Unknown envelope. */
    }
  }
  if (error && (profile.product === "claude-code" || profile.product === "chatgpt-codex")) {
    const type = error["type"],
      code = error["code"];
    const candidates = [type, code].filter(
      (v): v is string => typeof v === "string" && /^[a-z_]{1,80}$/.test(v),
    );
    const common: Record<string, FailureKind> = {
      insufficient_quota: "quota",
      rate_limit_error: "rate_limit",
      rate_limit_exceeded: "rate_limit",
      overloaded_error: "overload",
      authentication_error: "auth",
      permission_error: "permission",
      invalid_request_error: "invalid_request",
    };
    const matches = candidates.filter((c) => common[c]);
    if (
      matches.length &&
      matches.every((c) => common[c] === common[matches[0]!])
    ) {
      const found = common[matches[0]!]!;
      const expected =
        found === "auth"
          ? 401
          : found === "permission"
            ? 403
            : found === "invalid_request"
              ? 400
              : found === "overload"
                ? 529
                : 429;
      if (status === expected) {
        kind = found;
        providerCode = matches[0];
      }
    }
  }
  const retryAt = validatedRetryAt(retryAfter, now);
  return {
    kind,
    status,
    ...(providerCode ? { providerCode } : {}),
    evidence: kind === "unknown" ? "unknown" : "documented",
    scope: allowanceScope(profile),
    windows:
      kind === "quota" || kind === "rate_limit"
        ? [
            {
              id: kind,
              exhausted: true,
              observedAt: now,
              source: "inference",
              ...(retryAt === undefined ? {} : { resetAt: retryAt }),
            },
          ]
        : [],
    ...(retryAt === undefined ? {} : { retryAt }),
    bodyTruncated: body.truncated,
    responseCommitted: false,
  };
}
