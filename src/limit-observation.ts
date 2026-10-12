import { createHash } from "node:crypto";
import type { Logger } from "./logger.js";

export const LIMIT_CAPTURE_BYTES = 64 * 1024;
const SANITIZED_OBSERVATION = Symbol("sanitized-limit-observation");
export interface LimitContext {
  provider: "codex" | "claude" | "kimi";
  product:
    | "chatgpt-codex"
    | "openai-api"
    | "claude-code"
    | "anthropic-api"
    | "kimi-code"
    | "kimi-platform"
    | "anthropic-unknown";
  protocol: "messages" | "responses";
  profile?: string;
  route?: string;
  attempt?: number;
  scopeHash?: string;
  model?: string;
  region?: "global" | "mainland-cn";
  ingress?: "messages" | "responses";
  configuredCredentialKind?: "native-oauth" | "coding-plan-key" | "api-key";
}
export interface LimitObservation {
  readonly [SANITIZED_OBSERVATION]: true;
  schemaVersion: 1;
  observedAt: string;
  source: "upstream-response";
  context: Omit<LimitContext, "profile" | "route"> & {
    profileHash?: string;
    routeHash?: string;
  };
  transport: "http" | "sse" | "websocket";
  status?: number;
  committed: boolean | "unknown";
  providerStartSeen?: boolean;
  candidate: "limit" | "possible-limit" | "other-error";
  headers: Record<string, string>;
  bodyState: "json" | "non-json" | "empty" | "truncated" | "encoded";
  body: unknown;
  /** Free text and unknown string values are excluded, including error messages. */
  redacted: true;
}
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const publicFields = new Set([
  "error",
  "errors",
  "type",
  "code",
  "message",
  "detail",
  "details",
  "status",
  "status_code",
  "response",
  "headers",
  "retry_after",
  "retry_after_seconds",
  "retry_at",
  "reset",
  "reset_at",
  "resets_at",
  "resets_in_seconds",
  "reset_after_seconds",
  "retry_after_ms",
  "limit",
  "limits",
  "remaining",
  "used",
  "usage",
  "window",
  "windows",
  "duration",
  "duration_seconds",
  "limit_type",
  "plan_type",
  "reason",
  "object",
  "success",
]);
const numericFields = new Set([
  "code",
  "status",
  "status_code",
  "retry_after",
  "retry_after_seconds",
  "retry_at",
  "reset",
  "reset_at",
  "resets_at",
  "resets_in_seconds",
  "reset_after_seconds",
  "retry_after_ms",
  "limit",
  "remaining",
  "used",
  "duration",
  "duration_seconds",
]);
const publicCodes = new Set([
  "error",
  "response.failed",
  "usage_limit_reached",
  "insufficient_quota",
  "exceeded_current_quota_error",
  "rate_limit_reached_error",
  "rate_limit_error",
  "rate_limit_exceeded",
  "overloaded_error",
  "engine_overloaded_error",
  "concurrency_limit_exceeded",
  "too_many_requests",
  "resource_exhausted",
  "billing_hard_limit_reached",
  "authentication_error",
  "invalid_authentication_error",
  "permission_error",
  "permission_denied_error",
  "invalid_request_error",
  "quota_exceeded",
]);
const limitPrefixes = [
  "You've reached your 5-hour usage limit.",
  "You've reached your weekly (7-day) usage limit.",
  "You've reached your monthly usage limit for this billing cycle.",
  "You've reached your concurrent request limit.",
];
const headerNames = new Set([
  "retry-after",
  ...["requests", "tokens"].flatMap((unit) =>
    ["limit", "remaining", "reset"].map(
      (kind) => "x-ratelimit-" + kind + "-" + unit,
    ),
  ),
  ...["requests", "tokens", "input-tokens", "output-tokens"].flatMap((unit) =>
    ["limit", "remaining", "reset"].map(
      (kind) => "anthropic-ratelimit-" + unit + "-" + kind,
    ),
  ),
  ...["", "-5h", "-7d", "-7d-sonnet", "-7d-opus", "-overage"].flatMap(
    (window) =>
      ["status", "reset", "utilization"].map(
        (kind) => "anthropic-ratelimit-unified" + window + "-" + kind,
      ),
  ),
]);
function safeHeader(value: string): string {
  if (value.length > 128) return "<redacted>";
  return /^(?:\d+(?:\.\d+)?|(?:\d+(?:\.\d+)?(?:ms|s|m|h|d))+|allowed|allowed_warning|rejected)$/.test(
    value,
  ) ||
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) ||
    /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(
      value,
    )
    ? value
    : "<redacted>";
}
export function limitHeaders(
  headers: Headers | Readonly<Record<string, string | string[] | undefined>>,
): Record<string, string> {
  const result: Record<string, string> = {};
  const entries =
    headers instanceof Headers ? headers.entries() : Object.entries(headers);
  for (const [name, value] of entries) {
    const key = name.toLowerCase();
    if (!headerNames.has(key) || value === undefined) continue;
    result[key] = safeHeader(Array.isArray(value) ? value.join(",") : value);
  }
  return result;
}
/** Keep public error identifiers, never arbitrary vendor text or request echoes. */
function publicCode(value: string): boolean {
  return publicCodes.has(value);
}
function project(
  value: unknown,
  field = "",
  depth = 0,
  budget = { nodes: 0 },
): unknown {
  if (++budget.nodes > 128 || depth > 5) return "<structure-limit>";
  if (typeof value === "string") {
    if (value.length > 256) return "<oversized-string>";
    if (["type", "code", "reason"].includes(field) && publicCode(value))
      return value;
    if (["type", "code", "reason"].includes(field))
      return { kind: "unrecognized-string-code", fingerprint: digest(value) };
    if (field === "message") {
      const prefix = limitPrefixes.find((prefix) => value.startsWith(prefix));
      if (prefix) return prefix + " <redacted>";
    }
    if (
      numericFields.has(field) &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)
    )
      return value;
    return "<string>";
  }
  if (typeof value === "number")
    return numericFields.has(field) &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= 253402300799000
      ? value
      : "<number>";
  if (typeof value === "boolean") return "<boolean>";
  if (value === null) return null;
  if (Array.isArray(value))
    return value
      .slice(0, 3)
      .map((entry) => project(entry, field, depth + 1, budget));
  if (typeof value !== "object" || value === undefined) return "<unknown>";
  const result: Record<string, unknown> = Object.create(null);
  let unknown = 0;
  for (const [key, entry] of Object.entries(value).slice(0, 32)) {
    const name = publicFields.has(key) ? key : "unknown_field_" + ++unknown;
    result[name] = project(entry, key, depth + 1, budget);
  }
  return result;
}
export function recordLimitFailure(
  logger: Logger,
  context: LimitContext,
  input: {
    transport: LimitObservation["transport"];
    status?: number;
    committed: LimitObservation["committed"];
    headers?:
      | Headers
      | Readonly<Record<string, string | string[] | undefined>>
      | undefined;
    body?: unknown;
    text?: string | undefined;
    truncated?: boolean;
    encoded?: boolean;
    providerStartSeen?: boolean;
  },
): void {
  if (!logger.recordLimit) return;
  try {
    let body = input.body,
      state: LimitObservation["bodyState"] = "json";
    if (input.encoded) state = "encoded";
    else if (body === undefined && input.text === undefined && !input.truncated)
      state = "empty";
    else if (input.truncated) state = "truncated";
    else if (input.text !== undefined) {
      state = input.text.length ? "non-json" : "empty";
      try {
        body = JSON.parse(input.text);
        state = "json";
      } catch {
        /* Never retain non-JSON text. */
      }
    }
    const projected = state === "json" ? project(body) : null;
    const symbols = JSON.stringify(projected);
    const limit =
      /(?:quota|usage limit|concurrent request limit|limit_reached|limit_exceeded|rate_limit|exhaust)/.test(
        symbols,
      ) || input.status === 429;
    const { profile, route, model, scopeHash, ...publicContext } = context;
    logger.recordLimit({
      [SANITIZED_OBSERVATION]: true,
      schemaVersion: 1,
      observedAt: new Date().toISOString(),
      source: "upstream-response",
      context: {
        ...publicContext,
        ...(model &&
        /^(?:gpt-|claude-|kimi-|k[123](?:$|-))[a-z0-9._/-]*$/.test(model) &&
        model.length <= 128
          ? { model }
          : {}),
        ...(scopeHash && /^[a-f0-9]{64}$/.test(scopeHash) ? { scopeHash } : {}),
        ...(profile ? { profileHash: digest(profile) } : {}),
        ...(route ? { routeHash: digest(route) } : {}),
      },
      transport: input.transport,
      ...(input.status !== undefined ? { status: input.status } : {}),
      committed: input.committed,
      candidate: limit
        ? "limit"
        : [402, 403, 503, 529].includes(input.status ?? 0)
          ? "possible-limit"
          : "other-error",
      ...(input.providerStartSeen !== undefined
        ? { providerStartSeen: input.providerStartSeen }
        : {}),
      headers: limitHeaders(input.headers ?? {}),
      bodyState: state,
      body: projected,
      redacted: true,
    });
  } catch {
    /* Observation must never affect routing or delivery. */
  }
}
export function recordLimitEvent(
  logger: Logger,
  context: LimitContext,
  event: unknown,
  transport: "sse" | "websocket",
  metadata: {
    committed?: LimitObservation["committed"];
    headers?: Headers;
    providerStartSeen?: boolean;
    truncated?: boolean;
    eventType?: string;
  } = {},
): void {
  try {
    if (
      !logger.recordLimit ||
      !event ||
      typeof event !== "object" ||
      Array.isArray(event)
    )
      return;
    const item = event as Record<string, unknown>;
    const type = metadata.eventType ?? item["type"];
    if (
      type !== "error" &&
      type !== "response.failed" &&
      !(
        type === undefined &&
        Object.hasOwn(item, "error") &&
        item["error"] !== null
      )
    )
      return;
    const response = item["response"] as Record<string, unknown> | undefined;
    const error = (item["error"] ?? response?.["error"]) as
      | Record<string, unknown>
      | undefined;
    const rawStatus =
      error?.["status"] ??
      error?.["status_code"] ??
      item["status"] ??
      item["status_code"];
    const status =
      typeof rawStatus === "number"
        ? rawStatus
        : typeof rawStatus === "string" && /^[1-5]\d{2}$/.test(rawStatus)
          ? Number(rawStatus)
          : undefined;
    const headers =
      metadata.headers ??
      (item["headers"] &&
      typeof item["headers"] === "object" &&
      !Array.isArray(item["headers"])
        ? (item["headers"] as Record<string, string>)
        : undefined);
    recordLimitFailure(logger, context, {
      transport,
      committed: metadata.committed ?? "unknown",
      headers,
      body: item,
      ...(metadata.truncated !== undefined
        ? { truncated: metadata.truncated }
        : {}),
      ...(metadata.providerStartSeen !== undefined
        ? { providerStartSeen: metadata.providerStartSeen }
        : {}),
      ...(status !== undefined &&
      Number.isInteger(status) &&
      status >= 100 &&
      status <= 599
        ? { status }
        : {}),
    });
  } catch {
    /* Observations never change provider delivery. */
  }
}
