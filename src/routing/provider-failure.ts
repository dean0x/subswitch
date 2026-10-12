import { object } from "../plain-object.js";
import type { BoundedText } from "../provider-transport.js";
import {
  allowanceScope,
  type AccessProfile,
  type ClassifiedFailure,
  type FailureKind,
} from "./routing-types.js";

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
  profile: AccessProfile,
  status: number,
  body: BoundedText,
  now: number,
  retryAfter: string | null = null,
): ClassifiedFailure {
  let kind: FailureKind = "unknown",
    providerCode: string | undefined,
    window: string | undefined;
  let error: Record<string, unknown> | undefined;
  if (body.complete && !body.truncated) {
    try {
      error = object(object(JSON.parse(body.text))?.["error"]);
    } catch {
      /* Unknown envelope. */
    }
  }
  if (error) {
    const type = error["type"],
      code = error["code"],
      message = error["message"];
    const candidates = [type, code].filter(
      (v): v is string => typeof v === "string" && /^[a-z_]{1,80}$/.test(v),
    );
    const platform: Record<string, { kind: FailureKind; status: number }> = {
      exceeded_current_quota_error: { kind: "quota", status: 429 },
      rate_limit_reached_error: { kind: "rate_limit", status: 429 },
      engine_overloaded_error: { kind: "overload", status: 429 },
      invalid_authentication_error: { kind: "auth", status: 401 },
      permission_denied_error: { kind: "permission", status: 403 },
      invalid_request_error: { kind: "invalid_request", status: 400 },
    };
    if (profile.product === "kimi-platform") {
      const matches = candidates
        .map((c) => platform[c])
        .filter((v) => v !== undefined);
      if (
        matches.length &&
        matches.every((v) => v.status === status && v.kind === matches[0]?.kind)
      ) {
        kind = matches[0]!.kind;
        providerCode = candidates.find((c) => platform[c]?.status === status);
      }
    } else if (profile.product === "kimi-code") {
      const signatures: [RegExp, number, FailureKind, string?][] = [
        [
          /^You've reached your 5-hour usage limit\./,
          403,
          "quota",
          "five-hour",
        ],
        [
          /^You've reached your weekly \(7-day\) usage limit\./,
          403,
          "quota",
          "weekly",
        ],
        [
          /^You've reached your monthly usage limit for this billing cycle\./,
          403,
          "quota",
          "monthly",
        ],
        [/^You've reached your concurrent request limit\./, 403, "concurrency"],
        [
          /^We're receiving too many requests at the moment\./,
          429,
          "rate_limit",
        ],
        [
          /^The engine is currently overloaded, please try again later/,
          429,
          "overload",
        ],
        [
          /^Your current subscription does not have access to /,
          401,
          "permission",
        ],
        [/^Your current plan supports only k3 /, 401, "permission"],
      ];
      const matches = signatures.filter(
        ([pattern, expected]) =>
          status === expected &&
          typeof message === "string" &&
          pattern.test(message),
      );
      if (matches.length === 1) {
        kind = matches[0]![2];
        window = matches[0]![3];
        providerCode = `kimi_code_${kind}`;
      }
      // A conflicting code must not activate paid fallback.
      if (candidates.some((c) => platform[c] && platform[c]!.kind !== kind))
        kind = "unknown";
    } else {
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
              id: window ?? kind,
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
