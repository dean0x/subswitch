import { object } from "../plain-object.js";
import type { BoundedText } from "../provider-transport.js";
import type { Logger, ProviderErrorHints } from "../logger.js";
import {
  allowanceScope,
  type AccessProfile,
  type ClassifiedFailure,
  type FailureKind,
} from "./routing-types.js";

const FAILURE_STAGES = ["http_response", "sse_error"] as const;
const FAILURE_CATEGORIES = [
  "quota", "rate_limit", "concurrency", "overload", "auth", "permission",
  "invalid_request", "transport", "protocol", "cancelled", "unknown",
] as const satisfies readonly FailureKind[];

const HINT_VALUES = {
  rejectionEnvelope: ["nested_error", "top_level_error", "non_json", "incomplete", "unrecognized"],
  rejectionReason: ["unsupported_tool_type", "invalid_tool_schema", "unsupported_effort", "model_unavailable",
    "unsupported_field", "identity_rejected", "authentication_rejected", "ambiguous", "unrecognized"],
  rejectionField: ["tools", "reasoning", "model", "text", "input", "max_output_tokens", "unknown"],
  rejectionCode: ["unsupported_tool_type", "invalid_tool_schema", "unsupported_reasoning_effort", "model_not_found",
    "model_not_available", "unsupported_parameter", "unknown_parameter", "invalid_client", "unauthorized_client",
    "invalid_api_key", "authentication_error", "invalid_request_error", "invalid_request", "invalid_value", "ambiguous", "unrecognized"],
} as const satisfies { [K in keyof ProviderErrorHints]: readonly ProviderErrorHints[K][] };

// Descriptor reads do not execute arbitrary getters or coerce unknown values.
function ownData(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}
function hintValue<K extends keyof ProviderErrorHints>(key: K, value: unknown): ProviderErrorHints[K] {
  return (HINT_VALUES[key].find(candidate => candidate === value) ??
    (key === "rejectionField" ? "unknown" : "unrecognized")) as ProviderErrorHints[K];
}

/** Inspect only the existing bounded body in memory. Never return provider text.
 * Hints supplement diagnostics; classifyFailure remains the sole retry authority. */
export function providerErrorHints(body: BoundedText): ProviderErrorHints {
  const result: ProviderErrorHints = {
    rejectionEnvelope: "unrecognized", rejectionReason: "unrecognized", rejectionField: "unknown", rejectionCode: "unrecognized",
  };
  try {
    const text = ownData(body, "text");
    if (ownData(body, "complete") !== true || ownData(body, "truncated") !== false ||
        typeof text !== "string" || Buffer.byteLength(text, "utf8") > 64 * 1024)
      return { ...result, rejectionEnvelope: "incomplete" };
    let parsed: unknown;
    try { parsed = JSON.parse(text); }
    catch { return { ...result, rejectionEnvelope: "non_json" }; }
    const outer = object(parsed);
    if (!outer) return result;
    const nested = object(ownData(outer, "error"));
    const error = nested ?? (!Object.hasOwn(outer, "error") &&
      ["message", "code", "type"].some(key => typeof ownData(outer, key) === "string") ? outer : undefined);
    if (!error) return result;
    const envelope = nested ? "nested_error" : "top_level_error";
    const codes = [...new Set([ownData(error, "code"), ownData(error, "type")]
      .map(value => hintValue("rejectionCode", value)).filter(value => value !== "unrecognized"))];
    const reasons = new Set<ProviderErrorHints["rejectionReason"]>();
    const codeReasons = new Map<string, ProviderErrorHints["rejectionReason"]>([
      ["unsupported_tool_type", "unsupported_tool_type"], ["invalid_tool_schema", "invalid_tool_schema"],
      ["unsupported_reasoning_effort", "unsupported_effort"], ["model_not_found", "model_unavailable"],
      ["model_not_available", "model_unavailable"], ["unsupported_parameter", "unsupported_field"],
      ["unknown_parameter", "unsupported_field"], ["invalid_client", "identity_rejected"],
      ["unauthorized_client", "identity_rejected"], ["invalid_api_key", "authentication_rejected"],
      ["authentication_error", "authentication_rejected"],
    ]);
    for (const code of codes) { const reason = codeReasons.get(code); if (reason) reasons.add(reason); }
    const fields = [...new Set([ownData(error, "param"), ownData(error, "field")].flatMap(value => {
      if (typeof value !== "string" || value.length > 160 ||
          !/^[a-z_]+(?:\.[a-zA-Z_][a-zA-Z_0-9]*|\[\d+\])*$/.test(value)) return [];
      const root = value.split(/[.\[]/, 1)[0];
      const field = hintValue("rejectionField", root);
      return field === "unknown" ? [] : [field];
    }))];
    const message = ownData(error, "message");
    if (typeof message === "string" && message.length <= 4096) {
      const patterns: readonly [ProviderErrorHints["rejectionReason"], RegExp][] = [
        ["unsupported_tool_type", /\b(?:unsupported|unknown|invalid|unrecognized)\s+tool\s+type\b|\b(?:custom|namespace)['"]?\s+(?:tools?\s+)?(?:is\s+|are\s+)?(?:not supported|unsupported)\b/i],
        ["invalid_tool_schema", /\b(?:invalid|unsupported)\s+(?:function|tool)(?:\s+parameters?)?\s+schema\b|\bschema\s+for\s+(?:function|tool)\b[^\n]{0,120}\b(?:invalid|unsupported)\b/i],
        ["unsupported_effort", /\b(?:unsupported|invalid)\s+(?:reasoning[._ ]|thinking[._ ])?effort\b|\b(?:reasoning[._ ]|thinking[._ ])?effort\b[^\n]{0,80}\b(?:not supported|unsupported|invalid)\b/i],
        ["model_unavailable", /\bmodel\b[^\n]{0,120}\b(?:not found|does not exist|not available|unavailable|not supported)\b/i],
        ["unsupported_field", /\b(?:unsupported|unknown|unrecognized)\s+(?:parameter|field|argument)\b/i],
        ["identity_rejected", /\b(?:client|client identity|user.agent)\b[^\n]{0,80}\b(?:not allowed|not supported|unauthorized|rejected)\b|\b(?:invalid|unauthorized)\s+client\b/i],
        ["authentication_rejected", /\b(?:invalid|expired|revoked)\s+(?:access\s+token|api\s+key|authentication)\b/i],
      ];
      for (const [reason, pattern] of patterns) if (pattern.test(message)) reasons.add(reason);
      if (fields[0] === "tools" && /\b(?:unsupported|invalid)\s+value\b[^\n]{0,80}\b(?:custom|namespace)\b/i.test(message))
        reasons.add("unsupported_tool_type");
    }
    return { rejectionEnvelope: envelope,
      rejectionCode: codes.length > 1 ? "ambiguous" : codes[0] ?? "unrecognized",
      rejectionReason: reasons.size > 1 || fields.length > 1 ? "ambiguous" : [...reasons][0] ?? "unrecognized",
      rejectionField: fields.length === 1 ? fields[0]! : "unknown" };
  } catch { return result; } // Even hostile diagnostics must leave failure semantics intact.
}

/** Diagnostic only: status is the HTTP response's status, never an SSE envelope's.
 * Only fixed enums and numeric/null status reach the log sink. */
export function logProviderFailure(
  logger: Logger | undefined,
  stage: (typeof FAILURE_STAGES)[number],
  kind: FailureKind,
  httpStatus: unknown,
  hints?: ProviderErrorHints,
): void {
  try {
    logger?.log("info", "route_provider_failure", {
      eventType: FAILURE_STAGES.some(value => value === stage) ? stage : "unknown",
      errorCode: FAILURE_CATEGORIES.some(value => value === kind) ? kind : "unknown",
      status: typeof httpStatus === "number" && Number.isInteger(httpStatus) &&
        httpStatus >= 100 && httpStatus <= 599 ? httpStatus : null,
      ...(hints === undefined ? {} : {
        rejectionEnvelope: hintValue("rejectionEnvelope", ownData(hints, "rejectionEnvelope")),
        rejectionReason: hintValue("rejectionReason", ownData(hints, "rejectionReason")),
        rejectionField: hintValue("rejectionField", ownData(hints, "rejectionField")),
        rejectionCode: hintValue("rejectionCode", ownData(hints, "rejectionCode")),
      }),
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
