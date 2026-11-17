/**
 * Usage (one approved live check only):
 * node --import tsx e2e/gates/kimi-live-check.ts --kimi-auth-file <abs> --region global --evidence-dir <abs new> --confirm-live
 * A second run needs a new founder go. Do not reuse an evidence directory.
 * Use only a Subswitch-managed store from subswitch kimi-login. Do not use a native Kimi CLI store.
 * The 429 and 401 are fabricated. This check does not prove real quota exhaustion.
 * It does not test refresh before expiry, prove agent identity, or measure Kimi identity acceptance.
 */
import type { Server } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { loadConfig } from "../../src/config.js";
import { buildDeps, createProxyServer, listenServer } from "../../src/server.js";
import { KIMI_OAUTH_ORIGINS } from "../../src/kimi-auth.js";
import { defaultBase } from "../../src/routing/destination-catalog.js";
import { LimitRecorder, readLimitObservations, withLimitRecorder } from "../../src/limit-recorder.js";
import { recordLimitFailure } from "../../src/limit-observation.js";
import type { Logger } from "../../src/logger.js";
import { object } from "../../src/plain-object.js";
import { probeHeaders } from "./credentials.js";
import { closeWithCompletion, isolatedNativeEnv, nativeProcess } from "./native-process.js";

// Founder-approved cost limit: 18 Kimi attempts, 4,608 requested tokens, one refresh,
// and eight Claude requests. Each inference request has at most 256 output tokens.
export const MAX_KIMI_ATTEMPTS = 18;
export const MAX_KIMI_OUTPUT_TOKENS = 4608;
export const MAX_CLAUDE_REQUESTS = 8;
export const MAX_OUTPUT_TOKENS = 256;
export const MAX_OAUTH_REFRESHES = 1;
const MAX_LOOPBACK_CALLS = 32;
const COOLDOWN_MS = 75_000;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const CHILD_MODEL = "claude-sonnet-5";
const PARENT_MODEL = "claude-sonnet-5-5";
const OAUTH_URL = KIMI_OAUTH_ORIGINS.global + "/api/oauth/token";
const KIMI_BASE = defaultBase({ provider: "kimi", product: "kimi-code", region: "global", billing: "subscription",
  account: "live-check", credential: { kind: "native-oauth", authFile: "/unused" } });

export interface LiveArguments { kimiAuthFile: string; region: "global"; evidenceDir: string }
function safePath(path: string): boolean {
  return isAbsolute(path) && normalize(path) === path && !/[\x00-\x1f\x7f]/.test(path) &&
    !path.split("/").some(part => [".claude", ".codex", ".kimi", ".kimi-code", "kimi-code.json"].includes(part) ||
      /^kimi-code-env-[a-f0-9]+\.json$/.test(part));
}
/** Parse all arguments before any filesystem or credential operation. */
export function parseArguments(args: readonly string[]): LiveArguments | undefined {
  if (args.length !== 7) return undefined;
  const values = new Map<string, string>();
  let confirmed = false;
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (key === "--confirm-live") { if (confirmed) return undefined; confirmed = true; continue; }
    if (!key || !["--kimi-auth-file", "--region", "--evidence-dir"].includes(key) || values.has(key)) return undefined;
    const value = args[++index];
    if (!value || value.startsWith("--")) return undefined;
    values.set(key, value);
  }
  const kimiAuthFile = values.get("--kimi-auth-file"), evidenceDir = values.get("--evidence-dir");
  if (!confirmed || values.get("--region") !== "global" || !kimiAuthFile || !evidenceDir ||
    !safePath(kimiAuthFile) || !safePath(evidenceDir) || kimiAuthFile === evidenceDir) return undefined;
  return { kimiAuthFile, region: "global", evidenceDir };
}
export interface Counts { calls: number; kimi: number; kimiTokens: number; claude: number; refresh: number; loopback: number }
export const emptyCounts = (): Counts => ({ calls: 0, kimi: 0, kimiTokens: 0, claude: 0, refresh: 0, loopback: 0 });
type Provider = "kimi" | "claude" | "refresh" | "loopback";
/** Reserve before transport, including fabricated replies. A broken cap throws. */
export function reserveDispatch(counts: Readonly<Counts>, rawUrl: string, method: string, cap: unknown,
  loopbackOrigin: string): { counts: Counts; provider: Provider } {
  const bounds: Counts = { calls: MAX_KIMI_ATTEMPTS + MAX_CLAUDE_REQUESTS + MAX_OAUTH_REFRESHES + MAX_LOOPBACK_CALLS,
    kimi: MAX_KIMI_ATTEMPTS, kimiTokens: MAX_KIMI_OUTPUT_TOKENS, claude: MAX_CLAUDE_REQUESTS,
    refresh: MAX_OAUTH_REFRESHES, loopback: MAX_LOOPBACK_CALLS };
  for (const key of Object.keys(bounds) as (keyof Counts)[]) {
    if (!Number.isSafeInteger(counts[key]) || counts[key] < 0 || counts[key] > bounds[key]) throw new Error("broken_cap");
  }
  const url = new URL(rawUrl);
  if (url.href !== rawUrl || url.username || url.password || url.hash) throw new Error("unknown_destination");
  let provider: Provider;
  if (rawUrl === OAUTH_URL && method === "POST") provider = "refresh";
  else if (url.protocol === "http:" && url.hostname === "127.0.0.1" && url.origin === loopbackOrigin) provider = "loopback";
  else if (method === "POST" && rawUrl === "https://api.anthropic.com/v1/messages") provider = "claude";
  else if (method === "POST" && [KIMI_BASE + "/v1/messages?beta=true", KIMI_BASE + "/v1/responses"].includes(rawUrl)) provider = "kimi";
  else throw new Error("unknown_destination");
  if ((provider === "kimi" || provider === "claude") &&
    (typeof cap !== "number" || !Number.isSafeInteger(cap) || cap < 1 || cap > MAX_OUTPUT_TOKENS)) throw new Error("request_cap");
  const next = { ...counts, calls: counts.calls + 1, [provider]: counts[provider] + 1,
    kimiTokens: counts.kimiTokens + (provider === "kimi" && typeof cap === "number" ? cap : 0) };
  for (const key of Object.keys(bounds) as (keyof Counts)[]) if (next[key] > bounds[key]) throw new Error("cost_cap");
  return { counts: next, provider };
}

/** Stat only. The managed store performs the credential read at runtime. */
async function validatePaths(args: LiveArguments): Promise<boolean> {
  try {
    if (await realpath(args.kimiAuthFile) !== args.kimiAuthFile ||
      await realpath(dirname(args.evidenceDir)) !== dirname(args.evidenceDir)) return false;
    const auth = await lstat(args.kimiAuthFile), parent = await lstat(dirname(args.kimiAuthFile));
    if (!auth.isFile() || auth.nlink !== 1 || (auth.mode & 0o777) !== 0o600 ||
      !parent.isDirectory() || (parent.mode & 0o777) !== 0o700 ||
      (process.getuid && (auth.uid !== process.getuid() || parent.uid !== process.getuid()))) return false;
    try { await lstat(args.evidenceDir); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
  } catch { return false; }
}
/** Use the existing native-production snapshot shape and the gate helper only. */
async function claudeSnapshot(directory: string, headers: Record<string, string>): Promise<string> {
  const bearer = headers["authorization"];
  if (!bearer?.startsWith("Bearer ")) throw new Error("claude_auth_unavailable");
  await mkdir(directory, { mode: 0o700 });
  const path = join(directory, "auth.json");
  await writeFile(path, JSON.stringify({ claudeAiOauth: {
    accessToken: bearer.slice(7), expiresAt: Date.now() + 3600_000,
  } }), { mode: 0o600, flag: "wx" });
  return path;
}
interface RunFacts {
  run: number; nativeOk: boolean; finalNonce: boolean; childNonce: boolean; readResult: boolean;
  agentCalls: Set<string>; readCalls: Set<string>; primaryCommitted: boolean; fallbackCommitted: boolean;
}
const newRun = (run: number): RunFacts => ({ run, nativeOk: false, finalNonce: false, childNonce: false,
  readResult: false, agentCalls: new Set(), readCalls: new Set(), primaryCommitted: false, fallbackCommitted: false });
interface Dispatch { order: number; run: number; provider: Provider; route: "kimi-check" | "claude-control" | null;
  fabricated: boolean; status: number | null }

/** Inspect tool history in memory. Never emit arguments, results, paths, or the nonce. */
function inspectHistory(body: Record<string, unknown>, facts: RunFacts, route: string, file: string, nonce: string): void {
  const reads = new Set<string>(), agents = new Set<string>();
  const seeCall = (name: unknown, id: unknown, input: unknown) => {
    if (typeof id !== "string") return;
    if (route === "claude-control" && name === "Agent") { agents.add(id); facts.agentCalls.add(id); }
    if (name === "Read") {
      if (route !== "kimi-check" || object(input)?.["file_path"] !== file) throw new Error("unexpected_read");
      reads.add(id); facts.readCalls.add(id);
    }
  };
  const seeResult = (id: unknown, content: unknown) => {
    if (typeof id !== "string" || !JSON.stringify(content ?? null).includes(nonce)) return;
    if (route === "kimi-check" && reads.has(id)) facts.readResult = true;
    if (route === "claude-control" && agents.has(id)) facts.childNonce = true;
  };
  if (Array.isArray(body["messages"])) for (const message of body["messages"]) {
    const content = object(message)?.["content"];
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      const block = object(item);
      if (block?.["type"] === "tool_use") seeCall(block["name"], block["id"], block["input"]);
      if (block?.["type"] === "tool_result") seeResult(block["tool_use_id"], block["content"]);
    }
  }
  if (Array.isArray(body["input"])) for (const item of body["input"]) {
    const block = object(item);
    if (block?.["type"] === "function_call") {
      const raw = block["arguments"];
      seeCall(block["name"], block["call_id"], typeof raw === "string" ? JSON.parse(raw) as unknown : undefined);
    }
    if (block?.["type"] === "function_call_output") seeResult(block["call_id"], block["output"]);
  }
}

async function runLive(args: LiveArguments): Promise<boolean> {
  const startedAt = new Date().toISOString(), snapshotDir = join(args.evidenceDir, ".claude-snapshot");
  const originalFetch = globalThis.fetch, previousLimitDir = process.env["SUBSWITCH_LIMIT_DIR"];
  const stop = new AbortController();
  let failed = false, cleanupOk = true, evidenceOk = true, refusedFetchCalls = 0;
  const fail = () => { failed = true; stop.abort(); };
  const signal = () => fail();
  process.on("SIGINT", signal); process.on("SIGTERM", signal);
  const limitDir = join(args.evidenceDir, "limit-store");
  process.env["SUBSWITCH_LIMIT_DIR"] = limitDir;
  let proxy: Server | undefined, temp: string | undefined, loopbackOrigin = "";
  let counts = emptyCounts(), active = newRun(1), nonce = "", file = "";
  const runs: RunFacts[] = [], dispatches: Dispatch[] = [], events: Record<string, unknown>[] = [], childEnvNames: string[] = [];
  let digest: string | undefined, beforeRefresh: Awaited<ReturnType<typeof lstat>> | undefined;
  let injected401 = false, bearerChanged = false, storeChanged = false;
  const logger: Logger = { log(_level, event, fields) {
    if (event === "route_request_failed" || event.startsWith("limit_recording_")) fail();
    if (!["route_attempt", "route_effort_applied", "route_provider_failure"].includes(event) ||
      !["kimi-check", "claude-control"].includes(fields?.route ?? "")) return;
    if (events.length >= 256) { fail(); return; }
    const code = fields?.errorCode;
    const allowed = ["attempt_started", "committed", "quota_blocked", "rate_limit", "quota", "auth", "transport",
      "committed_failure", "incompatible_candidate", "client_effort_overridden"];
    events.push({ order: events.length + 1, run: active.run, event, route: fields?.route,
      profile: ["claude-primary", "kimi-fallback"].includes(fields?.targetProfile ?? "") ? fields?.targetProfile : null,
      attempt: fields?.attemptOrder ?? null, status: fields?.status ?? null,
      code: typeof code === "string" && allowed.includes(code) ? code : "other" });
    if (fields?.route === "kimi-check" && event === "route_attempt" && code === "committed") {
      if (fields.targetProfile === "claude-primary" && fields.attemptOrder === 0) active.primaryCommitted = true;
      if (fields.targetProfile === "kimi-fallback" && fields.attemptOrder === 1) active.fallbackCommitted = true;
    }
  } };
  const recorder = new LimitRecorder(limitDir, logger);
  const recorded = withLimitRecorder(logger, recorder);
  const log: Logger = { ...recorded, recordLimit(observation) {
    // Omit even the library's redacted body. Evidence contains no response bodies.
    const safe = { ...observation, body: undefined, fabricated: active.run === 1 && [401, 429].includes(observation.status ?? 0) };
    recorder.record(safe);
  } };
  const guarded: typeof fetch = async (input, init) => {
    try {
      if (failed) throw new Error("check_stopped");
      const url = input instanceof Request ? input.url : String(input);
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      const inference = url.startsWith(KIMI_BASE + "/") || url.startsWith("https://api.anthropic.com/");
      let body: Record<string, unknown> | undefined, cap: unknown;
      if (inference) {
        if (typeof init?.body !== "string" || Buffer.byteLength(init.body) > MAX_BODY_BYTES) throw new Error("invalid_dispatch_body");
        const parsed: unknown = JSON.parse(init.body); body = object(parsed);
        if (!body) throw new Error("invalid_dispatch_body");
        for (const key of ["max_tokens", "max_output_tokens"]) {
          const value = body[key];
          if (value !== undefined && (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > MAX_OUTPUT_TOKENS))
            throw new Error("request_cap");
        }
        cap = body[url.endsWith("/responses") ? "max_output_tokens" : "max_tokens"];
      }
      const reservation = reserveDispatch(counts, url, method, cap, loopbackOrigin);
      counts = reservation.counts;
      const provider = reservation.provider;
      const route = provider === "kimi" || body?.["model"] === CHILD_MODEL ? "kimi-check" :
        body?.["model"] === PARENT_MODEL ? "claude-control" : null;
      if (inference && (!route || (provider === "kimi" && body?.["model"] !== "kimi-for-coding"))) throw new Error("unexpected_model");
      if (body && route) inspectHistory(body, active, route, file, nonce);
      if (provider === "refresh" && (!injected401 || active.run !== 1)) throw new Error("unexpected_refresh");
      if (provider === "kimi" && active.run !== 1) throw new Error("unexpected_fallback");
      let fabricated = active.run === 1 && provider === "claude" && route === "kimi-check";
      if (provider === "kimi") {
        const authorization = new Headers(init?.headers).get("authorization");
        if (!authorization?.startsWith("Bearer ")) throw new Error("missing_bearer");
        const current = createHash("sha256").update(authorization).digest("hex");
        if (!injected401) {
          digest = current; beforeRefresh = await lstat(args.kimiAuthFile); injected401 = true; fabricated = true;
        } else if (!bearerChanged) {
          const after = await lstat(args.kimiAuthFile);
          bearerChanged = current !== digest; digest = undefined;
          storeChanged = !!beforeRefresh && (beforeRefresh.ino !== after.ino || beforeRefresh.mtimeMs !== after.mtimeMs);
          if (counts.refresh !== 1 || !bearerChanged || !storeChanged) throw new Error("refresh_not_proved");
        }
      }
      const dispatch: Dispatch = { order: dispatches.length + 1, run: active.run, provider, route, fabricated, status: null };
      dispatches.push(dispatch);
      let response: Response;
      if (fabricated) {
        const status = provider === "kimi" ? 401 : 429;
        const text = JSON.stringify({ type: "error", error: { type: status === 429 ? "rate_limit_error" : "authentication_error", message: "Fabricated check reply." } });
        response = new Response(text, { status, headers: { "content-type": "application/json" } });
        if (status === 401) recordLimitFailure(log, { provider: "kimi", product: "kimi-code", region: "global",
          protocol: url.endsWith("/responses") ? "responses" : "messages", route: "kimi-check", profile: "kimi-fallback" },
        { transport: "http", status, committed: false, headers: response.headers, text, truncated: false });
      } else response = await originalFetch(input, { ...init, redirect: "error", signal: AbortSignal.any([
        stop.signal, AbortSignal.timeout(180_000), ...(init?.signal ? [init.signal] : []),
      ]) });
      dispatch.status = response.status;
      if (!fabricated && !response.ok) { await response.body?.cancel(); throw new Error("upstream_failed"); }
      return response;
    } catch { refusedFetchCalls++; fail(); throw new Error("live_check_dispatch_refused"); }
  };
  globalThis.fetch = guarded;
  try {
    temp = await mkdtemp(join(tmpdir(), "subswitch-kimi-check-"));
    const home = join(temp, "home"), configDir = join(temp, "config"), work = join(temp, "work");
    for (const directory of [home, configDir, work]) await mkdir(directory, { mode: 0o700 });
    // Keychain on macOS only. Never fall back to a credential file on another OS.
    if (process.platform !== "darwin") throw new Error("claude_keychain_required");
    const headers = await probeHeaders({ provider: "claude", auth: "subscription" });
    const authFile = await claudeSnapshot(snapshotDir, headers);
    const config = loadConfig({ env: {}, configPath: join(temp, "inline.json"), readFile: () => JSON.stringify({
      configVersion: 2, providers: { codex: { authFile: join(work, "disabled-codex-auth.json") } },
      codexIngress: { enabled: false }, accessProfiles: {
        "claude-primary": { provider: "claude", product: "claude-code", billing: "subscription", account: "live-check",
          credential: { kind: "native-oauth", authFile } },
        "kimi-fallback": { provider: "kimi", product: "kimi-code", billing: "subscription", region: args.region, account: "live-check",
          credential: { kind: "native-oauth", authFile: args.kimiAuthFile } },
      }, routes: {
        "claude-control": { clients: ["claude-code"], primary: { profile: "claude-primary", model: PARENT_MODEL, effort: "low" } },
        "kimi-check": { clients: ["claude-code"], primary: { profile: "claude-primary", model: CHILD_MODEL, effort: "low" },
          fallbacks: [{ profile: "kimi-fallback", model: "kimi-for-coding", effort: "high" }] },
      },
    }) });
    if (!config.ok) throw new Error("config_failed");
    const deps = buildDeps(config.value.config, log, { fetchImpl: guarded });
    if (!deps.ok || !deps.value.sharedRouting) throw new Error("server_failed");
    const routing = deps.value.sharedRouting;
    // Refuse every legacy path. It must not bypass the guarded explicit dispatch.
    const unusedForwarder = deps.value.forwardAnthropic;
    proxy = createProxyServer({ ...deps.value, resolve: () => ({ kind: "unresolved" }), forwardAnthropic(req, res) {
      fail(); req.resume(); res.writeHead(400); res.end();
    } });
    unusedForwarder.close?.();
    if (!(await listenServer(proxy, 0, "127.0.0.1")).ok) throw new Error("listen_failed");
    const address = proxy.address();
    if (!address || typeof address === "string") throw new Error("listen_failed");
    loopbackOrigin = `http://127.0.0.1:${address.port}`;
    for (const run of [1, 2]) {
      active = newRun(run); runs.push(active);
      nonce = `check-${randomUUID()}`; file = join(work, `nonce-${run}.txt`);
      await writeFile(file, nonce, { mode: 0o600, flag: "wx" });
      const action = routing.actions.create("claude-code", randomUUID());
      const inherited = isolatedNativeEnv({});
      // Retain PATH only. Do not pass unrelated credentials, proxies, or session state.
      const env: NodeJS.ProcessEnv = { PATH: inherited["PATH"] ?? "/usr/bin:/bin", LANG: "C", TERM: "dumb",
        HOME: home, TMPDIR: temp, XDG_CACHE_HOME: join(home, ".cache"), XDG_CONFIG_HOME: join(home, ".config"),
        CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_OAUTH_TOKEN: headers["authorization"]?.slice(7),
        ANTHROPIC_BASE_URL: loopbackOrigin + action.ingressPrefix,
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(MAX_OUTPUT_TOKENS), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        SUBSWITCH_LIMIT_DIR: limitDir };
      if (!childEnvNames.length) childEnvNames.push(...Object.keys(env).sort());
      const result = await nativeProcess("claude", [
        "--print", "--setting-sources", "", "--settings", '{"disableAllHooks":true}',
        "--disable-slash-commands", "--strict-mcp-config", "--no-session-persistence",
        "--tools", "Agent,Read", "--allowedTools", `Agent,Read(./nonce-${run}.txt)`, "--permission-mode", "dontAsk",
        "--model", "claude-control", "--output-format", "json", "--effort", "low",
        "--agents", JSON.stringify({ kimi_probe: { description: "Read the check file.", model: "kimi-check", tools: ["Read"],
          prompt: `Use Read once on ${file}. Reply with its exact content. Use no other tools.` } }),
        `Delegate once to kimi_probe. Tell it to use Read once on ${file}. Return its exact answer. Do not read the file yourself.`,
      ], { cwd: work, env, timeoutMs: 240_000, signal: stop.signal });
      routing.actions.complete(action.id);
      if (result.failure || result.cleanupError || result.code !== 0) throw new Error("native_failed");
      const answer: unknown = JSON.parse(result.stdout), parsed = object(answer);
      active.nativeOk = parsed?.["is_error"] === false;
      active.finalNonce = typeof parsed?.["result"] === "string" && parsed["result"].includes(nonce);
      if (!active.nativeOk || !active.finalNonce || !active.childNonce || !active.readResult ||
        active.agentCalls.size !== 1 || active.readCalls.size !== 1 || failed) throw new Error("nonce_check_failed");
      if (run === 1) {
        if (!active.fallbackCommitted || counts.refresh !== 1 || !bearerChanged || !storeChanged) throw new Error("fallback_check_failed");
        await sleep(COOLDOWN_MS, undefined, { signal: stop.signal });
      } else {
        const child = dispatches.filter(item => item.run === 2 && item.route === "kimi-check");
        if (!active.primaryCommitted || child[0]?.provider !== "claude" || child[0].status !== 200 ||
          child.some(item => item.provider === "kimi")) throw new Error("recovery_check_failed");
      }
    }
  } catch { fail(); }
  finally {
    stop.abort();
    try {
      if (proxy) { proxy.closeAllConnections(); await closeWithCompletion(done => proxy!.close(done), "node_server"); }
    } catch { cleanupOk = false; failed = true; }
    for (const path of [snapshotDir, temp]) {
      if (!path) continue;
      try { await rm(path, { recursive: true, force: true }); }
      catch { cleanupOk = false; failed = true; }
    }
    try {
      await recorder.flush();
      const limits = await readLimitObservations(limitDir);
      await writeFile(join(args.evidenceDir, "limits.json"), JSON.stringify({ observations: limits,
        fabricatedReplies: dispatches.filter(item => item.fabricated), cooldownMs: COOLDOWN_MS }, null, 2), { mode: 0o600, flag: "wx" });
      await writeFile(join(args.evidenceDir, "events.jsonl"), events.map(event => JSON.stringify(event) + "\n").join(""), { mode: 0o600, flag: "wx" });
    } catch { evidenceOk = false; failed = true; }
    globalThis.fetch = originalFetch;
    if (previousLimitDir === undefined) delete process.env["SUBSWITCH_LIMIT_DIR"];
    else process.env["SUBSWITCH_LIMIT_DIR"] = previousLimitDir;
    process.removeListener("SIGINT", signal); process.removeListener("SIGTERM", signal);
  }
  const report = { schemaVersion: 1, success: !failed && cleanupOk && evidenceOk && runs.length === 2,
    startedAt, endedAt: new Date().toISOString(), cleanupOk, evidenceOk, bearerChanged, storeChanged,
    childEnvNames, refusedFetchCalls, cooldownMs: COOLDOWN_MS, caps: { used: counts, limits: { kimi: MAX_KIMI_ATTEMPTS,
      kimiTokens: MAX_KIMI_OUTPUT_TOKENS, claude: MAX_CLAUDE_REQUESTS, refresh: MAX_OAUTH_REFRESHES,
      perRequestOutputTokens: MAX_OUTPUT_TOKENS, loopback: MAX_LOOPBACK_CALLS } }, dispatches,
    runs: runs.map(run => ({ ...run, agentCalls: run.agentCalls.size, readCalls: run.readCalls.size })) };
  try { await writeFile(join(args.evidenceDir, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600, flag: "wx" }); }
  catch { return false; }
  return report.success;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArguments(process.argv.slice(2));
  if (!args || !await validatePaths(args)) {
    console.log(JSON.stringify({ success: false, code: "invalid_input" })); process.exitCode = 2;
  } else {
    try {
      // Atomic mkdir is the one-run guard. No credential operation precedes it.
      await mkdir(args.evidenceDir, { mode: 0o700 });
      const success = await runLive(args);
      console.log(JSON.stringify({ success })); process.exitCode = success ? 0 : 1;
    } catch { console.log(JSON.stringify({ success: false, code: "check_failed" })); process.exitCode = 1; }
  }
}
