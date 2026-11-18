import { BoundedCapture } from "./bounded-capture.js";
import { isCodexQuotaSource, parseCodexUsageBody, type CodexQuotaPollWriter } from "./codex-quota-snapshot.js";
import type { ProviderAuth } from "./provider-auth.js";
import type { Logger, LogFields } from "./logger.js";
import { scheduleRoutingTimer, type RoutingClock } from "./routing/clock.js";

const FLOOR_MS = 60000;
const STALE_MS = 900000;
const RESET_GRACE_SEC = 60;
const TIMEOUT_MS = 10000;
const BODY_BYTES = 65536;
const DAY_MS = 86400000;
const DAILY_STARTS = 48;

export interface PollDecisionState {
  readonly startedAt: number;
  readonly startPending: boolean;
  readonly inFlight: boolean;
  readonly lastStart: number | undefined;
  readonly nextAllowedAt: number;
  readonly starts: readonly number[];
  readonly observedAt: number | undefined;
  readonly resetsAt: readonly number[];
  readonly usedResets: readonly number[];
}
export function deriveUsageUrl(base: string): string | undefined {
  try {
    const url = new URL(base);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) return undefined;
    const path = url.pathname.replace(/\/$/, "");
    if (!path.endsWith("/backend-api/codex")) return undefined;
    url.pathname = path.slice(0, -"/backend-api/codex".length) + "/backend-api/wham/usage";
    url.search = ""; url.hash = "";
    return url.href;
  } catch { return undefined; }
}
export function nextPollDecision(state: PollDecisionState, now: number): { kind: "wait" } | { kind: "poll"; dueResets: readonly number[] } {
  if (state.inFlight || now < state.nextAllowedAt || (state.lastStart !== undefined && now - state.lastStart < FLOOR_MS) ||
    state.starts.filter((start) => now - start < DAY_MS).length >= DAILY_STARTS) return { kind: "wait" };
  const dueResets = state.resetsAt.filter((reset) => now / 1000 >= reset + RESET_GRACE_SEC && !state.usedResets.includes(reset));
  // Both activity and idle are stale triggers. Activity never suppresses an idle poll.
  const stale = now - (state.observedAt === undefined ? state.startedAt : state.observedAt * 1000) >= STALE_MS;
  return state.startPending || dueResets.length > 0 || stale ? { kind: "poll", dueResets } : { kind: "wait" };
}
interface PollOptions {
  readonly fetchImpl: typeof fetch;
  readonly auth: ProviderAuth<"codex">;
  readonly url: string;
  readonly writer: CodexQuotaPollWriter;
  readonly logger: Logger;
  readonly clock: RoutingClock;
  readonly userAgent: string;
}
type FailureCode = "network" | "timeout" | "http_status" | "body_invalid";
export class CodexUsagePoller {
  private started = false;
  private stopped = false;
  private startedAt = 0;
  private startPending = true;
  private inFlight = false;
  private lastStart: number | undefined;
  private nextAllowedAt = 0;
  private failures = 0;
  private starts: number[] = [];
  private usedResets: number[] = [];
  private cancelTick: (() => void) | undefined;
  private cancelTimeout: (() => void) | undefined;
  private controller: AbortController | undefined;
  private readonly warned = new Set<string>();
  constructor(private readonly options: PollOptions) {}
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.startedAt = this.options.clock.now();
    this.schedule();
    this.tick();
  }
  private schedule(): void {
    this.cancelTick = scheduleRoutingTimer(this.options.clock, () => {
      if (this.stopped) return;
      this.schedule();
      this.tick();
    }, FLOOR_MS);
  }
  tick(): void {
    if (!this.started || this.stopped) return;
    try {
      const now = this.options.clock.now(), quota = this.options.writer.pollState();
      this.starts = this.starts.filter((start) => now - start < DAY_MS);
      // A new parsed reset cannot be older than 300 s. Keep current old values as well.
      this.usedResets = this.usedResets.filter((reset) => reset >= now / 1000 - 300 || quota.resetsAt.includes(reset));
      const decision = nextPollDecision({ ...quota, startedAt: this.startedAt, startPending: this.startPending, inFlight: this.inFlight,
        lastStart: this.lastStart, nextAllowedAt: this.nextAllowedAt, starts: this.starts, usedResets: this.usedResets }, now);
      if (decision.kind === "wait") return;
      this.startPending = false;
      this.lastStart = now;
      this.starts.push(now);
      this.usedResets = [...new Set([...this.usedResets, ...decision.dueResets])];
      this.inFlight = true;
      // The terminal catch also contains a faulty writer or logger adapter.
      void this.poll(now).catch(() => {}).finally(() => { this.inFlight = false; }).catch(() => {});
    } catch { this.warn("codex_usage_poll_failed", { errorCode: "body_invalid" }); }
  }
  stop(): void {
    this.stopped = true;
    this.cancelTick?.();
    this.cancelTimeout?.();
    this.controller?.abort();
  }
  private warn(code: string, fields: LogFields): void {
    if (this.warned.has(code)) return;
    this.warned.add(code);
    try { this.options.logger.log("warn", code, fields); } catch { /* Optional diagnostics. */ }
  }
  private fail(code: string, fields: LogFields, retryAfter = 0): void {
    this.failures = Math.min(6, this.failures + 1);
    this.nextAllowedAt = this.options.clock.now() + Math.max(Math.min(3600000, FLOOR_MS * 2 ** this.failures), retryAfter);
    this.warn(code, fields);
  }
  private ignoreResult(signal: AbortSignal): boolean {
    if (this.stopped) return true;
    if (!signal.aborted) return false;
    this.fail("codex_usage_poll_failed", { errorCode: "timeout" });
    return true;
  }
  private async poll(start: number): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;
    let timedOut = false;
    this.cancelTimeout = scheduleRoutingTimer(this.options.clock, () => { timedOut = true; controller.abort(); }, TIMEOUT_MS);
    let failureCode: FailureCode = "network";
    try {
      const credential = await this.options.auth.getCredentials();
      if (this.ignoreResult(controller.signal)) return;
      if (!credential.ok) { this.fail("codex_usage_poll_failed", { errorCode: "network" }); return; }
      const response = await this.options.fetchImpl(this.options.url, { method: "GET", redirect: "error", signal: controller.signal,
        headers: { ...credential.value.authHeaders, accept: "application/json", originator: "codex_cli_rs", "user-agent": this.options.userAgent } });
      if (this.ignoreResult(controller.signal)) { void response.body?.cancel().catch(() => {}); return; }
      if (response.status !== 200) {
        void response.body?.cancel().catch(() => {});
        if (response.status === 401 || response.status === 403) this.fail("codex_usage_poll_rejected", { status: response.status });
        else if (response.status === 429) {
          const retry = response.headers.get("retry-after");
          const seconds = retry !== null && /^\d{1,4}$/.test(retry) && Number(retry) <= 3600 ? Number(retry) : 0;
          this.fail("codex_usage_poll_rate_limited", { status: 429 }, seconds * 1000);
        } else this.fail("codex_usage_poll_failed", { errorCode: "http_status", status: response.status });
        return;
      }
      failureCode = "body_invalid";
      const text = await this.readBody(response);
      if (this.ignoreResult(controller.signal)) return;
      if (text === undefined) { this.fail("codex_usage_poll_body_too_large", { status: 200 }); return; }
      const parsed = parseCodexUsageBody(text, Math.floor(start / 1000));
      if (!parsed.snapshot) { this.fail("codex_usage_poll_failed", { errorCode: "body_invalid", status: 200 }); return; }
      this.options.writer.record(parsed);
      this.failures = 0;
      this.nextAllowedAt = 0;
    } catch {
      if (!this.stopped) this.fail("codex_usage_poll_failed", { errorCode: timedOut ? "timeout" : failureCode });
    } finally {
      this.cancelTimeout?.();
      this.cancelTimeout = undefined;
      this.controller = undefined;
    }
  }
  private async readBody(response: Response): Promise<string | undefined> {
    if (Number(response.headers.get("content-length")) > BODY_BYTES) { await response.body?.cancel(); return undefined; }
    if (!response.body) return "";
    const reader = response.body.getReader(), capture = new BoundedCapture(BODY_BYTES);
    try {
      // At most 65537 nonempty chunks can fit. Empty chunks also consume this bound.
      for (let n = 0; n <= BODY_BYTES; n++) {
        const chunk = await reader.read();
        if (chunk.done) return capture.bytes.toString("utf8");
        if (!capture.append(Buffer.from(chunk.value))) break;
      }
      await reader.cancel();
      return undefined;
    } finally { reader.releaseLock(); }
  }
}
export function buildCodexUsagePoller(options: Omit<PollOptions, "url" | "writer"> & {
  enabled: boolean; recording: boolean; writer: CodexQuotaPollWriter | undefined; authFile: string; baseUrl: string;
}): CodexUsagePoller | undefined {
  const { writer } = options;
  if (!options.enabled || !options.recording || !writer ||
    !isCodexQuotaSource({ provider: "codex", product: "chatgpt-codex", protocol: "responses" }, options.authFile, writer.credentialFile)) return undefined;
  const url = deriveUsageUrl(options.baseUrl);
  if (!url) {
    try { options.logger.log("info", "codex_usage_poll_unsupported_base_url"); } catch { /* Optional diagnostics. */ }
    return undefined;
  }
  if (new URL(url).origin !== new URL(options.baseUrl).origin) return undefined;
  return new CodexUsagePoller({ ...options, url, writer });
}
