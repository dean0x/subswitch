import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { expandHome } from "./config.js";
import type { Logger } from "./logger.js";
import type { LimitContext } from "./limit-observation.js";
import { object } from "./plain-object.js";

export interface CodexQuotaWindow {
  readonly window_minutes: number;
  readonly used_percent: number;
  readonly resets_at: number;
}
export interface CodexQuotaCredits {
  readonly has_credits: boolean | null;
  readonly unlimited: boolean | null;
  readonly balance: number | null;
}
export interface CodexQuotaAdditionalLimit {
  readonly limit_id: string;
  readonly limit_name: string | null;
  readonly windows: readonly CodexQuotaWindow[];
}
export interface CodexQuotaSnapshot {
  readonly version: 1;
  readonly observed_at: number;
  readonly windows: readonly CodexQuotaWindow[];
  readonly rate_limit_reached_type: string | null;
  readonly source: "response-headers" | "usage-endpoint";
  readonly plan_type: string | null;
  readonly active_limit: string | null;
  readonly limit_name: string | null;
  readonly credits: CodexQuotaCredits | null;
  readonly additional_limits: readonly CodexQuotaAdditionalLimit[];
}
export interface CodexQuotaParse {
  readonly snapshot?: CodexQuotaSnapshot;
  readonly resetRejected: boolean;
}
export interface CodexQuotaSink {
  readonly credentialFile: string;
  now(): number;
  record(parse: CodexQuotaParse): void;
  noteActivity(): void;
}
export interface CodexQuotaPollWriter extends CodexQuotaSink {
  pollState(): { readonly observedAt: number | undefined; readonly resetsAt: readonly number[]; readonly activityAt: number | undefined };
}
export interface QuotaHeaders {
  get(name: string): string | null;
  entries(): Iterator<[string, string]>;
}
export type CodexQuotaWarning = "codex_quota_unavailable" | "codex_quota_directory_unsafe" | "codex_quota_reset_out_of_range" | "codex_quota_dropped";
export type CodexQuotaWriteResult = { readonly ok: true } | { readonly ok: false; readonly code: CodexQuotaWarning; readonly errorCode: string };
interface WriterOptions {
  readonly credentialFile: string;
  readonly write: (text: string) => Promise<CodexQuotaWriteResult>;
  readonly logger: Logger;
  readonly now: () => number;
}

export function codexQuotaSnapshotPaths(home: string): { path: string; credentialFile: string } | undefined {
  if (!isAbsolute(home)) return undefined;
  return { path: join(home, ".cache", "subswitch", "codex-quota.json"), credentialFile: join(home, ".codex", "auth.json") };
}
export function isCodexQuotaSource(context: LimitContext, credentialFile: string, cliCredentialFile: string): boolean {
  return context.provider === "codex" && context.product === "chatgpt-codex" &&
    resolve(expandHome(credentialFile)) === resolve(expandHome(cliCredentialFile));
}
/** Optional diagnostics must not affect the response or read credentials. */
export function observeCodexQuota(logger: Logger, context: LimitContext, credentialFile: string, headers: QuotaHeaders): void {
  try {
    const sink = logger.codexQuota;
    if (!sink || !isCodexQuotaSource(context, credentialFile, sink.credentialFile)) return;
    sink.noteActivity();
    sink.record(parseCodexQuotaHeaders(headers, Math.floor(sink.now() / 1000)));
  } catch { /* The response path never depends on diagnostics. */ }
}

const FIXED_HEADERS = [
  "x-codex-primary-used-percent", "x-codex-primary-window-minutes", "x-codex-primary-reset-at",
  "x-codex-secondary-used-percent", "x-codex-secondary-window-minutes", "x-codex-secondary-reset-at",
  "x-codex-rate-limit-reached-type", "x-codex-credits-has-credits", "x-codex-credits-unlimited",
  "x-codex-credits-balance", "x-codex-plan-type", "x-codex-active-limit", "x-codex-limit-name",
] as const;
const NUMBER_TEXT = /^\d{1,15}(\.\d{1,6})?$/;
const FAMILY_ID = /^[a-z0-9]+(?:[-_][a-z0-9]+){0,3}$/;
const LIMIT_TYPE = /^[a-z0-9_-]{1,64}$/;
const PLAN_TYPE = /^[a-z0-9_-]{1,32}$/;
const LIMIT_NAME = /^[A-Za-z0-9._ -]{1,64}$/;
const safeText = (value: string | null, pattern: RegExp): string | null =>
  value !== null && pattern.exec(value)?.[0] === value ? value : null;
const numberText = (value: string | null): number | null =>
  value !== null && value.length <= 32 && NUMBER_TEXT.exec(value)?.[0] === value ? Number(value) : null;
function booleanText(value: string | null): boolean | null {
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}
interface WindowText { used: string | null; minutes: string | null; reset: string | null }
interface FamilyText { primary: WindowText; secondary: WindowText; name: string | null }
const emptyWindow = (): WindowText => ({ used: null, minutes: null, reset: null });

/** INFERRED: reset-at epoch s, window-minutes minutes. No unit conversion. */
function parseWindow(input: WindowText, nowSec: number): { window?: CodexQuotaWindow; resetRejected: boolean } {
  return parseWindowValues(numberText(input.used), numberText(input.minutes), numberText(input.reset), nowSec);
}
function parseWindowValues(used: number | null, minutes: number | null, reset: number | null, nowSec: number): { window?: CodexQuotaWindow; resetRejected: boolean } {
  if (used === null || minutes === null || reset === null || !Number.isInteger(minutes) || minutes < 1 || minutes > 527040)
    return { resetRejected: false };
  if (!Number.isInteger(reset) || reset < nowSec - 300 || reset > nowSec + minutes * 60 + 300)
    return { resetRejected: true };
  return { window: { window_minutes: minutes, used_percent: Math.min(100, Math.max(0, used)), resets_at: reset }, resetRejected: false };
}
function parseWindows(primary: WindowText, secondary: WindowText, nowSec: number): { windows: CodexQuotaWindow[]; resetRejected: boolean } {
  const p = parseWindow(primary, nowSec), s = parseWindow(secondary, nowSec);
  return combineWindows(p, s);
}
function combineWindows(p: ReturnType<typeof parseWindowValues>, s: ReturnType<typeof parseWindowValues>): { windows: CodexQuotaWindow[]; resetRejected: boolean } {
  const windows = p.window ? [p.window] : [];
  if (s.window && s.window.window_minutes !== p.window?.window_minutes) windows.push(s.window);
  return { windows: windows.sort((a, b) => a.window_minutes - b.window_minutes), resetRejected: p.resetRejected || s.resetRejected };
}
export function parseCodexQuotaHeaders(headers: QuotaHeaders, nowSec: number): CodexQuotaParse {
  const [pu, pm, pr, su, sm, sr, reached, hasCredits, unlimited, balance, plan, active, name] = FIXED_HEADERS.map((key) => headers.get(key));
  const codex = parseWindows({ used: pu ?? null, minutes: pm ?? null, reset: pr ?? null },
    { used: su ?? null, minutes: sm ?? null, reset: sr ?? null }, nowSec);
  if (codex.windows.length === 0) return { resetRejected: codex.resetRejected };
  const families = new Map<string, FamilyText>();
  const iterator = headers.entries();
  for (let count = 0; count < 512; count++) {
    const next = iterator.next();
    if (next.done) break;
    const [key, value] = next.value;
    if (key.length > 96) continue;
    const window = /^x-codex-(.+)-(primary|secondary)-(used-percent|window-minutes|reset-at)$/.exec(key);
    const label = window ? null : /^x-codex-(.+)-limit-name$/.exec(key);
    const id = window?.[1] ?? label?.[1];
    if (!id || id === "codex" || id.length > 48 || !FAMILY_ID.test(id)) continue;
    let family = families.get(id);
    if (!family) {
      if (families.size >= 8) continue;
      family = { primary: emptyWindow(), secondary: emptyWindow(), name: null };
      families.set(id, family);
    }
    if (label) family.name = value;
    else if (window) {
      const slot = window[2] === "primary" ? family.primary : family.secondary;
      switch (window[3]) {
        case "used-percent": slot.used = value; break;
        case "window-minutes": slot.minutes = value; break;
        case "reset-at": slot.reset = value; break;
      }
    }
  }
  const additional: CodexQuotaAdditionalLimit[] = [];
  let resetRejected = codex.resetRejected;
  for (const [id, family] of families) {
    const parsed = parseWindows(family.primary, family.secondary, nowSec);
    resetRejected ||= parsed.resetRejected;
    if (parsed.windows.length) additional.push({ limit_id: id, limit_name: safeText(family.name, LIMIT_NAME), windows: parsed.windows });
  }
  return { resetRejected, snapshot: {
    version: 1, observed_at: nowSec, windows: codex.windows, rate_limit_reached_type: safeText(reached ?? null, LIMIT_TYPE),
    source: "response-headers", plan_type: safeText(plan ?? null, PLAN_TYPE), active_limit: safeText(active ?? null, LIMIT_TYPE),
    limit_name: safeText(name ?? null, LIMIT_NAME), credits: hasCredits == null && unlimited == null && balance == null ? null : {
      has_credits: booleanText(hasCredits ?? null), unlimited: booleanText(unlimited ?? null), balance: numberText(balance ?? null),
    }, additional_limits: additional,
  } };
}
const jsonNumber = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const jsonText = (value: unknown, pattern: RegExp): string | null => safeText(typeof value === "string" ? value : null, pattern);
function usageWindows(value: unknown, nowSec: number): ReturnType<typeof parseWindows> {
  const rate = object(value);
  const window = (value: unknown): ReturnType<typeof parseWindowValues> => {
    const input = object(value), seconds = jsonNumber(input?.["limit_window_seconds"]);
    return parseWindowValues(jsonNumber(input?.["used_percent"]), seconds !== null && Number.isInteger(seconds) && seconds % 60 === 0 ? seconds / 60 : null,
      jsonNumber(input?.["reset_at"]), nowSec);
  };
  return combineWindows(window(rate?.["primary_window"]), window(rate?.["secondary_window"]));
}
/** INFERRED usage body: window seconds become minutes; reset_at is epoch seconds. */
export function parseCodexUsageBody(json: string, nowSec: number): CodexQuotaParse {
  let value: unknown;
  try { value = JSON.parse(json); } catch { return { resetRejected: false }; }
  const body = object(value), codex = usageWindows(body?.["rate_limit"], nowSec);
  if (!codex.windows.length) return { resetRejected: codex.resetRejected };
  const additional: CodexQuotaAdditionalLimit[] = [];
  const families = body?.["additional_rate_limits"];
  let resetRejected = codex.resetRejected;
  if (Array.isArray(families)) {
    for (const raw of families.slice(0, 8)) {
      const family = object(raw), id = jsonText(family?.["limit_id"], FAMILY_ID);
      if (!id || id === "codex" || id.length > 48 || additional.some((limit) => limit.limit_id === id)) continue;
      const parsed = usageWindows(family?.["rate_limit"], nowSec);
      resetRejected ||= parsed.resetRejected;
      if (parsed.windows.length) additional.push({ limit_id: id, limit_name: jsonText(family?.["limit_name"], LIMIT_NAME), windows: parsed.windows });
    }
  }
  const credits = object(body?.["credits"]);
  return { resetRejected, snapshot: { version: 1, observed_at: nowSec, windows: codex.windows, source: "usage-endpoint",
    rate_limit_reached_type: null, active_limit: null, limit_name: null, plan_type: jsonText(body?.["plan_type"], PLAN_TYPE),
    credits: credits ? { has_credits: typeof credits["has_credits"] === "boolean" ? credits["has_credits"] : null,
      unlimited: typeof credits["unlimited"] === "boolean" ? credits["unlimited"] : null, balance: jsonNumber(credits["balance"]) } : null,
    additional_limits: additional } };
}
const projectWindows = (windows: readonly CodexQuotaWindow[]): CodexQuotaWindow[] => windows.map((w) => ({
  window_minutes: w.window_minutes, used_percent: w.used_percent, resets_at: w.resets_at,
}));
export function serializeCodexQuota(snapshot: CodexQuotaSnapshot): string | undefined {
  const text = JSON.stringify({
    version: 1, observed_at: snapshot.observed_at, windows: projectWindows(snapshot.windows),
    rate_limit_reached_type: snapshot.rate_limit_reached_type, source: snapshot.source,
    plan_type: snapshot.plan_type, active_limit: snapshot.active_limit, limit_name: snapshot.limit_name,
    credits: snapshot.credits === null ? null : { has_credits: snapshot.credits.has_credits, unlimited: snapshot.credits.unlimited, balance: snapshot.credits.balance },
    additional_limits: snapshot.additional_limits.map((limit) => ({ limit_id: limit.limit_id, limit_name: limit.limit_name, windows: projectWindows(limit.windows) })),
  });
  return Buffer.byteLength(text) <= 4096 ? text : undefined;
}
const fsCode = (error: unknown, fallback: string): string => {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  return typeof code === "string" && /^E[A-Z0-9]{1,15}$/.exec(code)?.[0] === code ? code : fallback;
};

/** Latest-wins state is separate from the bounded private event queue. No timer. */
export class CodexQuotaWriter implements CodexQuotaSink {
  readonly credentialFile: string;
  readonly now: () => number;
  private slot: CodexQuotaSnapshot | undefined;
  private idle = Promise.resolve();
  private settleDrain: (() => void) | undefined;
  private draining = false;
  private written: { observed: number; content: string; at: number } | undefined;
  private newestHeader: number | undefined;
  private accepted: CodexQuotaSnapshot | undefined;
  private activityAt: number | undefined;
  private readonly warned = new Set<CodexQuotaWarning>();
  constructor(private readonly options: WriterOptions) {
    this.credentialFile = options.credentialFile;
    this.now = options.now;
  }
  noteActivity(): void { this.activityAt = this.now(); }
  pollState(): ReturnType<CodexQuotaPollWriter["pollState"]> {
    return { observedAt: this.accepted?.observed_at, resetsAt: this.accepted?.windows.map((window) => window.resets_at) ?? [], activityAt: this.activityAt };
  }
  record(parse: CodexQuotaParse): void {
    if (parse.resetRejected) this.warn("codex_quota_reset_out_of_range", "RESET_RANGE");
    const snapshot = parse.snapshot;
    if (!snapshot || snapshot.windows.length === 0) return;
    const nowSec = Math.floor(this.now() / 1000);
    if (this.written && this.written.observed > nowSec + 300) this.written = undefined;
    if (this.newestHeader !== undefined && this.newestHeader > nowSec + 300) this.newestHeader = undefined;
    if (this.written && snapshot.observed_at < this.written.observed) return;
    if (snapshot.source === "usage-endpoint" && this.newestHeader !== undefined && snapshot.observed_at <= this.newestHeader) return;
    if (this.slot && snapshot.observed_at < this.slot.observed_at) return;
    if (this.accepted && this.accepted.observed_at <= nowSec + 300 && snapshot.observed_at < this.accepted.observed_at) return;
    this.accepted = snapshot;
    if (snapshot.source === "response-headers") this.newestHeader = Math.max(this.newestHeader ?? snapshot.observed_at, snapshot.observed_at);
    this.slot = snapshot;
    if (!this.draining) {
      this.draining = true;
      this.idle = new Promise((resolve) => { this.settleDrain = resolve; });
      this.start();
    }
  }
  private warn(code: CodexQuotaWarning, errorCode: string): void {
    if (this.warned.has(code)) return;
    this.warned.add(code);
    try { this.options.logger.log("warn", code, { errorCode }); } catch { /* Optional diagnostics. */ }
  }
  private start(): void {
    void Promise.resolve().then(() => this.drain()).finally(() => {
      if (this.slot) this.start();
      else {
        this.draining = false;
        this.settleDrain?.();
        this.settleDrain = undefined;
      }
    }).catch(() => {});
  }
  private async drain(): Promise<void> {
    // Each turn has a fixed work bound. A later slot starts another turn.
    for (let pass = 0; pass < 2; pass++) {
      const snapshot = this.slot;
      this.slot = undefined;
      if (!snapshot) return;
      const text = serializeCodexQuota(snapshot);
      if (text === undefined) { this.warn("codex_quota_dropped", "SNAPSHOT_SIZE"); continue; }
      const content = serializeCodexQuota({ ...snapshot, observed_at: 0 })!;
      const now = this.now();
      if (this.written && snapshot.observed_at < this.written.observed) continue;
      if (this.written && content === this.written.content && now - this.written.at >= 0 && now - this.written.at < 30000) continue;
      let completed = false;
      try {
        const result = await this.options.write(text);
        completed = true;
        if (!result.ok) {
          const fixedCause = ["DIRECTORY_UNSAFE", "FILE_UNSAFE", "DIRECTORY_FAILED", "WRITE_FAILED"].includes(result.errorCode) ? result.errorCode : "WRITE_FAILED";
          this.warn(result.code, fsCode({ code: result.errorCode }, fixedCause));
          continue;
        }
        this.written = { observed: snapshot.observed_at, content, at: this.now() };
      } finally {
        // A broken injected adapter can reject. The terminal catch contains it.
        if (!completed) this.warn("codex_quota_unavailable", "WRITE_FAILED");
      }
    }
  }
  async flush(): Promise<void> {
    await this.idle;
  }
}

/** The recorder supplies one state object per writer, not a process-wide path cache. */
export interface CodexQuotaDirectoryState { initialized: boolean }
export async function writeCodexQuotaFile(path: string, text: string, state: CodexQuotaDirectoryState = { initialized: false }): Promise<CodexQuotaWriteResult> {
  const directory = dirname(path);
  try {
    if (!state.initialized) {
      try { await mkdir(directory, { recursive: true, mode: 0o700 }); }
      catch (error) {
        const code = fsCode(error, "DIRECTORY_FAILED");
        return { ok: false, code: code === "EEXIST" || code === "ENOTDIR" ? "codex_quota_directory_unsafe" : "codex_quota_unavailable", errorCode: code };
      }
      state.initialized = true;
    }
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()))
      return { ok: false, code: "codex_quota_directory_unsafe", errorCode: "DIRECTORY_UNSAFE" };
    const temporary = `${path}.${randomUUID()}.tmp`;
    let created = false;
    try {
      const file = await open(temporary, "wx", 0o600);
      created = true;
      try {
        await file.writeFile(text);
        await file.sync();
        const stat = await file.stat();
        if (!stat.isFile() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o077) !== 0)
          return { ok: false, code: "codex_quota_unavailable", errorCode: "FILE_UNSAFE" };
      } finally { await file.close(); }
      await rename(temporary, path);
      return { ok: true };
    } finally { if (created) await unlink(temporary).catch(() => undefined); }
  } catch (error) { return { ok: false, code: "codex_quota_unavailable", errorCode: fsCode(error, "WRITE_FAILED") }; }
}
