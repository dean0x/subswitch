/**
 * The Kimi live check, and its offline dry run.
 *
 *   npm run probe:kimi -- --dry-run --evidence-root <absolute folder>
 *   npm run probe:kimi -- --live --evidence-root <absolute folder>
 *
 * Run it from the repository root, and stop `subswitch serve` first: the check listens on
 * the configured port. Only the owner runs the live mode, in his own Terminal, after a
 * passing dry run. The live mode refuses under CI, without a TTY on stdin and stdout, and
 * without the typed cap phrase. The dry run skips that gate and the cooldown. It uses a
 * temporary home, a free port, a fabricated Kimi sign-in and in-process fake upstreams.
 *
 * Both modes run these steps:
 * 1. Check the folders and the hosts, stat the Kimi sign-in file, and load the user
 *    configuration as `run-action` does. That configuration must have no providers.kimi
 *    block. The opt-in block exists only in the in-process configuration of the check, so
 *    a client that does not attach gets the fixed "not turned on" error.
 * 2. Start the capped proxy on the configured port. Each Kimi request goes through
 *    providerDeps.kimi.fetch, which reserves a cap before it sends. Each Claude request goes
 *    through the capped Anthropic forwarder, and each loopback call through the capped
 *    request listener.
 * 3. Probe layer: plain HTTP requests to the proxy. No Claude Code process.
 * 4. Wait the cooldown, publish the action control file and print the client commands.
 *    Live: run the printed live command in a second Terminal. Dry run: the check runs the
 *    printed dry-run command. Both start the client in a new folder with only package.json.
 * 5. Remove the control file and client folder, stop the proxy, and write report.json with fixed fields only
 *    to a new dated folder under the evidence root.
 *
 * In the live mode, a Kimi renewal happens only when the sign-in is due: the check does not
 * force one. The dry run makes its fabricated sign-in due, so it runs the renewal.
 */
import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AnthropicForwarder, ForwardedBody } from "../../src/anthropic-passthrough.js";
import { DEFAULT_PORT, loadConfig, type LoadConfigResult } from "../../src/config.js";
import { toAnthropicErrorBody, type ProxyError } from "../../src/errors.js";
import { KIMI_REGION_TABLE } from "../../src/kimi-constants.js";
import { KIMI_ERRORS, type KimiErrorCode } from "../../src/kimi-errors.js";
import { createConsoleLogger, type Logger } from "../../src/logger.js";
import { isPlainObject } from "../../src/plain-object.js";
import type { ProviderHandler } from "../../src/provider-handler.js";
import { respondJson } from "../../src/provider-transport.js";
import { err, ok, type Result } from "../../src/result.js";
import { actionControlPath, publishActionControl } from "../../src/routing/action-control.js";
import { buildDeps, createProxyServer, listenServer, liveKimiStoreDeps, type ServerDeps } from "../../src/server.js";
import type { TogetherKeyReaderDeps } from "../../src/together-auth.js";
import { closeWithCompletion, nativeProcess } from "./native-process.js";
import { actionsDirectory, askLine, confirmLive, dryConfigEnv, freePort, parseArguments, prepareClientFolder, privateFolder,
  type GateIO, type LiveArguments, type Mode } from "./live-check-common.js";

export { parseArguments, type GateCode, type GateIO, type LiveArguments, type Mode } from "./live-check-common.js";

// The owner-approved caps of one run.
export const MAX_KIMI_ATTEMPTS = 18;
export const MAX_KIMI_TOKENS = 4608;
export const MAX_OUTPUT_TOKENS = 256;
export const MAX_CLAUDE_REQUESTS = 8;
export const MAX_OAUTH_REFRESHES = 1;
export const MAX_LOOPBACK_CALLS = 32;
export const COOLDOWN_MS = 75_000;
export const MAX_BODY_BYTES = 4 * 1024 * 1024;
export const LIVE_PHRASE = `start the Kimi live check: ${MAX_KIMI_ATTEMPTS} Kimi attempts, ${MAX_KIMI_TOKENS} tokens, ` +
  `${MAX_OUTPUT_TOKENS} tokens per request, ${MAX_CLAUDE_REQUESTS} Claude requests, ${MAX_OAUTH_REFRESHES} refresh`;

// The hosts are written here, apart from the product table. The check stops when the two differ.
const KIMI_API = "https://api.kimi.ai/coding/v1";
export const KIMI_MESSAGES_URL = `${KIMI_API}/messages?beta=true`;
export const KIMI_TOKEN_URL = "https://auth.kimi.ai/api/oauth/token";
export const PROBE_MODEL = "kimi-for-coding";
const KIMI_SLOT = KIMI_REGION_TABLE.global.credentialFile;

const SEND_TIMEOUT_MS = 180_000;
const PROBE_TIMEOUT_MS = 240_000;
const PROBE_REPLY_BYTES = 1024 * 1024;
const CANCEL_WAIT_MS = 5_000;
const HELD_STREAM_MS = 10_000;
const ATTACH_TIMEOUT_MS = 90_000;
const LIVE_SESSION_MS = 15 * 60_000;
const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const cooldownFor = (mode: Mode): number => mode === "live" ? COOLDOWN_MS : 0;

const MODES = ["dry-run", "live"] as const;
const CAP_CODES = ["broken_cap", "cost_cap", "request_cap"] as const;
const REFUSAL_CODES = [...CAP_CODES, "unknown_destination", "invalid_body", "unexpected_model", "unexpected_request",
  "refused_route"] as const;
const FAILURE_CODES = ["repo_root_required", "evidence_root_invalid", "host_mismatch", "user_config_invalid",
  "user_config_has_kimi_block", "dry_run_port_refused", "kimi_sign_in_missing", "evidence_dir_exists", "config_failed",
  "server_failed", "listen_failed", "probe_failed", "renewal_missing", "renewal_failed", "control_failed", "client_folder_failed", "attach_failed",
  "session_timeout", "action_not_completed", "no_session_requests", "session_error_reply", "no_kimi_session_dispatch",
  "dispatch_refused", "interrupted", "cleanup_failed", "evidence_rejected"] as const;
const PROBE_NAMES = ["stream", "json", "tool_call", "tool_result", "count_tokens", "cancel"] as const;
const STATUS_CLASSES = ["2xx", "3xx", "4xx", "5xx", "none"] as const;
const OUTCOMES = ["complete", "cancel", "none"] as const;

export type CapCode = (typeof CAP_CODES)[number];
export type RefusalCode = (typeof REFUSAL_CODES)[number];
export type FailureCode = (typeof FAILURE_CODES)[number];
export type ProbeName = (typeof PROBE_NAMES)[number];
export type StatusClass = (typeof STATUS_CLASSES)[number];
export type Outcome = (typeof OUTCOMES)[number];
export type DispatchKind = "kimi" | "refresh" | "claude" | "claude_count" | "loopback";
type Phase = "probe" | "session";

// ---------------------------------------------------------------------------
// Arguments and the live gate
// ---------------------------------------------------------------------------

export const liveGate = (io: GateIO) => confirmLive(LIVE_PHRASE, io);

export interface MainIO extends GateIO {
  out(line: string): void;
  run(args: LiveArguments): Promise<boolean>;
}

/** Exit 2 for refused input or a refused gate, 1 for a failed check, 0 for a passed check. */
export async function main(args: readonly string[], io: MainIO): Promise<number> {
  const parsed = parseArguments(args);
  if (parsed === undefined) {
    io.out(JSON.stringify({ success: false, code: "invalid_input" }));
    return 2;
  }
  if (parsed.mode === "live") {
    const gate = await liveGate(io);
    if (!gate.ok) {
      io.out(JSON.stringify({ success: false, code: gate.error }));
      return 2;
    }
  }
  return (await io.run(parsed)) ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Caps
// ---------------------------------------------------------------------------

export interface Counts {
  readonly kimi: number;
  readonly kimiTokens: number;
  readonly claude: number;
  readonly refresh: number;
  readonly loopback: number;
}

export const CAP_LIMITS: Counts = Object.freeze({
  kimi: MAX_KIMI_ATTEMPTS, kimiTokens: MAX_KIMI_TOKENS, claude: MAX_CLAUDE_REQUESTS, refresh: MAX_OAUTH_REFRESHES,
  loopback: MAX_LOOPBACK_CALLS,
});
const COUNT_KEYS = Object.keys(CAP_LIMITS) as readonly (keyof Counts)[];
export const emptyCounts = (): Counts => ({ kimi: 0, kimiTokens: 0, claude: 0, refresh: 0, loopback: 0 });
const KIND_COUNTER: { readonly [L in DispatchKind]: keyof Counts } = {
  kimi: "kimi", refresh: "refresh", claude: "claude", claude_count: "claude", loopback: "loopback",
};

const validOutputCap = (cap: unknown): cap is number =>
  typeof cap === "number" && Number.isSafeInteger(cap) && cap >= 1 && cap <= MAX_OUTPUT_TOKENS;

/**
 * The counts after one more dispatch, or the reason to refuse it. A Kimi or Claude
 * Messages request must name an output cap of 1 to 256 tokens. The input does not change.
 */
export function reserveDispatch(counts: Counts, kind: DispatchKind, outputCap?: unknown): Result<Counts, CapCode> {
  if (COUNT_KEYS.some((key) => !Number.isSafeInteger(counts[key]) || counts[key] < 0 || counts[key] > CAP_LIMITS[key])) {
    return err("broken_cap");
  }
  const metered = kind === "kimi" || kind === "claude";
  if (metered && !validOutputCap(outputCap)) return err("request_cap");
  const tokens = kind === "kimi" && validOutputCap(outputCap) ? outputCap : 0;
  const counter = KIND_COUNTER[kind];
  const next: Counts = { ...counts, [counter]: counts[counter] + 1, kimiTokens: counts.kimiTokens + tokens };
  return COUNT_KEYS.some((key) => next[key] > CAP_LIMITS[key]) ? err("cost_cap") : ok(next);
}

const STATUS_BY_HUNDRED: ReadonlyMap<number, StatusClass> = new Map([[2, "2xx"], [3, "3xx"], [4, "4xx"], [5, "5xx"]]);
const statusClass = (status: number): StatusClass => STATUS_BY_HUNDRED.get(Math.floor(status / 100)) ?? "none";

interface Dispatch {
  readonly kind: DispatchKind;
  readonly phase: Phase;
  status: StatusClass;
  /** The request signal of the product aborted before the reply ended. */
  aborted: boolean;
  /** The request holds a tool_result block. Only this flag is kept, not the block. */
  readonly toolResult: boolean;
}

/** The counts, dispatches and first failure of one run. */
export class CapLedger {
  counts: Counts = emptyCounts();
  phase: Phase = "probe";
  failure: FailureCode | undefined;
  readonly refusals: RefusalCode[] = [];
  readonly dispatches: Dispatch[] = [];
  readonly kimiCodes = new Set<KimiErrorCode>();
  readonly stop = new AbortController();

  /** Reserve one dispatch before it is sent. A refusal fails the check and stops it. */
  reserve(kind: DispatchKind, outputCap?: unknown): Result<void, RefusalCode> {
    const next = reserveDispatch(this.counts, kind, outputCap);
    if (!next.ok) return this.refuse(next.error);
    this.counts = next.value;
    return ok(undefined);
  }

  refuse(code: RefusalCode): Result<never, RefusalCode> {
    if (this.refusals.length < 16) this.refusals.push(code);
    this.fail("dispatch_refused");
    return err(code);
  }

  /** Keep the first failure and stop every wait and send of the run. */
  fail(code: FailureCode): void {
    this.failure ??= code;
    this.stop.abort();
  }

  record(kind: DispatchKind, toolResult: boolean): Dispatch {
    const dispatch: Dispatch = { kind, phase: this.phase, status: "none", aborted: false, toolResult };
    this.dispatches.push(dispatch);
    return dispatch;
  }
}

const parseObject = (text: string): Record<string, unknown> | undefined => {
  try {
    const value: unknown = JSON.parse(text);
    return isPlainObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
};

const holdsToolResult = (body: Record<string, unknown>): boolean => Array.isArray(body["messages"]) &&
  body["messages"].some((message) => isPlainObject(message) && Array.isArray(message["content"]) &&
    message["content"].some((block) => isPlainObject(block) && block["type"] === "tool_result"));

/**
 * A refused dispatch did not leave, so it fails as a refused connection. The Kimi sign-in
 * manager reads that code as "nothing was sent", so a refused renewal leaves no recovery
 * state in the Kimi home.
 */
const notSent = (code: string): TypeError => new TypeError(code, { cause: Object.assign(new Error(code), { code: "ECONNREFUSED" }) });

const KIMI_KINDS: ReadonlyMap<string, DispatchKind> = new Map([[`POST ${KIMI_MESSAGES_URL}`, "kimi"], [`POST ${KIMI_TOKEN_URL}`, "refresh"]]);

/**
 * providerDeps.kimi.fetch of the check: only the two hard-coded Kimi URLs, a body of at most
 * 4 MiB, the probe model and an output cap of at most 256 tokens. It reserves before it sends.
 */
export const cappedKimiFetch = (ledger: CapLedger, transport: typeof fetch): typeof fetch => async (input, init) => {
  const refused = (code: RefusalCode): never => {
    ledger.refuse(code);
    throw notSent(code);
  };
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : undefined;
  const kind = url === undefined ? undefined : KIMI_KINDS.get(`${init?.method ?? "GET"} ${url}`);
  if (url === undefined || kind === undefined) return refused("unknown_destination");
  const raw = init?.body;
  const text = typeof raw === "string" ? raw : raw instanceof URLSearchParams ? raw.toString() : undefined;
  if (text === undefined || Buffer.byteLength(text) > MAX_BODY_BYTES) return refused("invalid_body");
  const body = kind === "kimi" ? parseObject(text) : undefined;
  if (kind === "kimi" && body === undefined) return refused("invalid_body");
  if (body !== undefined && body["model"] !== PROBE_MODEL) return refused("unexpected_model");
  const reserved = ledger.reserve(kind, body?.["max_tokens"]);
  if (!reserved.ok) throw notSent(reserved.error);
  const dispatch = ledger.record(kind, body !== undefined && holdsToolResult(body));
  const signal = init?.signal ?? undefined;
  signal?.addEventListener("abort", () => { dispatch.aborted = true; }, { once: true });
  const response = await transport(url, {
    ...init, redirect: "error",
    signal: AbortSignal.any([ledger.stop.signal, AbortSignal.timeout(SEND_TIMEOUT_MS), ...(signal === undefined ? [] : [signal])]),
  });
  dispatch.status = statusClass(response.status);
  return response;
};

const refusalReply = (req: IncomingMessage, res: ServerResponse, status: 400 | 429, message: string): void => {
  respondJson(res, status, toAnthropicErrorBody(status === 429 ? "rate_limit_error" : "invalid_request_error", message));
  req.resume();
};

const CLAUDE_KINDS: ReadonlyMap<string, DispatchKind> = new Map([["POST /v1/messages", "claude"], ["POST /v1/messages/count_tokens", "claude_count"]]);

/** The Anthropic forwarder of the check: only complete Messages and count_tokens bodies, reserved before they are sent. */
export const cappedClaudeForwarder = (ledger: CapLedger, inner: AnthropicForwarder): AnthropicForwarder => {
  const forward = (req: IncomingMessage, res: ServerResponse, body?: ForwardedBody): void => {
    const kind = CLAUDE_KINDS.get(`${req.method ?? ""} ${(req.url ?? "").split("?")[0] ?? ""}`);
    const parsed = kind !== undefined && body?.kind === "complete" && body.bytes.length <= MAX_BODY_BYTES
      ? parseObject(body.bytes.toString("utf8")) : undefined;
    if (kind === undefined || parsed === undefined) {
      ledger.refuse("unexpected_request");
      refusalReply(req, res, 400, "The live check refused this request.");
      return;
    }
    if (!ledger.reserve(kind, parsed["max_tokens"]).ok) {
      refusalReply(req, res, 400, "The live check refused this request.");
      return;
    }
    const dispatch = ledger.record(kind, false);
    res.once("close", () => { dispatch.status = res.headersSent ? statusClass(res.statusCode) : "none"; });
    inner(req, res, body);
  };
  return Object.assign(forward, { close: () => inner.close?.() });
};

/** The check sends no Codex or Together request. */
const refusingHandler = (ledger: CapLedger): ProviderHandler => {
  const reply = (req: IncomingMessage, res: ServerResponse): void => {
    ledger.refuse("refused_route");
    refusalReply(req, res, 400, "The live check sends only Kimi and Claude requests.");
  };
  return { handleMessages: async (req, res) => reply(req, res), handleCountTokens: (req, res) => reply(req, res) };
};

const REFUSING_TOGETHER: TogetherKeyReaderDeps = {
  env: {}, platform: "linux", setTimer: () => () => undefined,
  exec: async () => { throw notSent("refused_route"); },
};

const ACTION_CREATE = "/__subswitch/actions";
const ACTION_END = /^\/__subswitch\/actions\/[a-f0-9-]{36}\/(complete|cancel)$/;
const ACTION_INGRESS = /^\/__subswitch\/action\/[a-f0-9-]{36}\/ingress\//;

export interface SessionFacts {
  actionStarted: boolean;
  outcome: Outcome;
  /** Claude Code requests that came through the action ingress. */
  requests: number;
  /** Ingress requests that got no reply or a status of 400 or more. */
  errorReplies: number;
}

interface Session extends SessionFacts {
  onEnd: () => void;
}

/**
 * Reserve a loopback call for each request before the proxy handles it, and watch the action
 * ingress. The first request listener is the proxy handler, which the server constructor
 * adds. The listeners after it (the inbound socket policy) stay as they are, in order.
 */
const capInbound = (server: Server, ledger: CapLedger, session: Session): boolean => {
  const [handler, ...others] = server.listeners("request");
  if (handler === undefined) return false;
  server.removeAllListeners("request");
  server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    if (!ledger.reserve("loopback").ok) {
      refusalReply(req, res, 429, "The live check reached its loopback call cap.");
      return;
    }
    const path = (req.url ?? "").split("?")[0] ?? "";
    const end = ACTION_END.exec(path)?.[1];
    if (path === ACTION_CREATE) {
      res.once("close", () => { session.actionStarted ||= res.statusCode === 201; });
    } else if (end === "complete" || end === "cancel") {
      res.once("close", () => {
        if (res.statusCode !== 200) return;
        session.outcome = end;
        session.onEnd();
      });
    } else if (ACTION_INGRESS.test(path)) {
      session.requests += 1;
      res.once("close", () => { if (!res.headersSent || res.statusCode >= 400) session.errorReplies += 1; });
    }
    handler.call(server, req, res);
  });
  for (const listener of others) server.on("request", listener as (req: IncomingMessage, res: ServerResponse) => void);
  return true;
};

// ---------------------------------------------------------------------------
// The user configuration (opt-in only in the check)
// ---------------------------------------------------------------------------

/** The port of the user configuration that `run-action` loads. A providers.kimi block there stops the check. */
export function checkUserConfig(loaded: Result<LoadConfigResult, ProxyError>): Result<{ readonly port: number }, FailureCode> {
  if (!loaded.ok) return err("user_config_invalid");
  if (loaded.value.configuredProviders.has("kimi")) return err("user_config_has_kimi_block");
  return ok({ port: loaded.value.config.port });
}

// ---------------------------------------------------------------------------
// The client commands
// ---------------------------------------------------------------------------

const RUN_ACTION = [process.execPath, "--import", import.meta.resolve("tsx"), join(REPO_ROOT, "src/cli.ts"),
  "run-action", "--client", "claude-code", "--"] as const;
/** Claude Code reads these: a 256-token output cap and no extra traffic. */
const CLIENT_ENV: Readonly<Record<string, string>> = {
  CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(MAX_OUTPUT_TOKENS), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
};
const KIMI_AGENT = JSON.stringify({ kimi_probe: {
  description: "Read one file and report one value.", model: PROBE_MODEL, tools: ["Read"],
  prompt: "Use Read once on package.json. Reply with the value of its name field only. Use no other tool.",
} });
const DRY_RUN_COMMAND: readonly string[] = [...RUN_ACTION, process.execPath, join(REPO_ROOT, "e2e/gates/kimi-live-fake-client.mjs")];
/** Claude, then a Kimi sub-agent with one Read call and its result, then Claude again. */
const LIVE_COMMAND: readonly string[] = [...RUN_ACTION, "claude", "--print", "--setting-sources", "",
  "--settings", '{"disableAllHooks":true}', "--disable-slash-commands", "--strict-mcp-config", "--no-session-persistence",
  "--tools", "Agent,Read", "--allowedTools", "Agent,Read(./package.json)", "--permission-mode", "dontAsk",
  "--model", "sonnet", "--effort", "low", "--output-format", "json", "--agents", KIMI_AGENT,
  "Delegate once to kimi_probe. Return its exact answer. Do not read the file yourself."];

const shellWord = (word: string): string => /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
const renderCommand = (folder: string, argv: readonly string[]): string =>
  `(cd ${shellWord(folder)} && ${[...Object.entries(CLIENT_ENV).map(([name, value]) => `${name}=${value}`), ...argv.map(shellWord)].join(" ")})`;

// ---------------------------------------------------------------------------
// Sites: the live home, or a fabricated one with fake upstreams
// ---------------------------------------------------------------------------

interface Site {
  readonly mode: Mode;
  /** The home of the control file and of the user configuration that `run-action` loads. */
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly kimiAuthFile: string;
  /** A private temporary folder of this run. */
  readonly scratch: string;
  readonly renewalExpected: boolean;
  readonly kimiTransport: typeof fetch;
  /** The fake Anthropic forwarder of the dry run. The live mode uses the product forwarder. */
  readonly claudeForwarder: AnthropicForwarder | undefined;
  readonly sessionTimeoutMs: number;
  /** The dry run runs the dry-run command here. The live mode waits for the owner. */
  attach(folder: string, signal: AbortSignal, out: (line: string) => void): Promise<boolean>;
}

const fabricated = (kind: string): string => `dry-run-kimi-${kind}-${randomUUID()}`;

const sseText = (events: readonly Record<string, unknown>[]): string =>
  events.map((event) => `event: ${String(event["type"])}\ndata: ${JSON.stringify(event)}\n\n`).join("");

/** One Anthropic Messages stream with one text or tool_use block. */
const replyEvents = (model: string, block: Record<string, unknown>): Record<string, unknown>[] => {
  const tool = block["type"] === "tool_use";
  return [
    { type: "message_start", message: { id: `msg_${randomUUID()}`, type: "message", role: "assistant", model, content: [],
      usage: { input_tokens: 9, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: tool ? { ...block, input: {} } : { type: "text", text: "" } },
    { type: "content_block_delta", index: 0,
      delta: tool ? { type: "input_json_delta", partial_json: JSON.stringify(block["input"]) } : { type: "text_delta", text: block["text"] } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ];
};

/** A stream that sends its first frames and then holds until the request ends, or for 10 s. */
const heldStream = (prefix: string, signal: AbortSignal | null | undefined): ReadableStream<Uint8Array> => new ReadableStream({
  start(controller) {
    controller.enqueue(new TextEncoder().encode(prefix));
    const end = (): void => {
      clearTimeout(timer);
      try { controller.error(new Error("fake stream ended")); } catch { /* The reader is gone. */ }
    };
    const timer = setTimeout(end, HELD_STREAM_MS);
    signal?.addEventListener("abort", end, { once: true });
  },
});

const jsonResponse = (status: number, value: unknown): Response =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

/** The fake Kimi Messages and token services of the dry run. Nothing leaves the process. */
const fakeKimiTransport: typeof fetch = async (input, init) => {
  const url = String(input);
  if (url === KIMI_TOKEN_URL) {
    return jsonResponse(200, { access_token: fabricated("access"), refresh_token: fabricated("refresh"), token_type: "Bearer",
      expires_in: 3600, scope: "kimi-code" });
  }
  const body = parseObject(String(init?.body));
  if (url !== KIMI_MESSAGES_URL || body === undefined) return jsonResponse(404, { type: "error", error: { type: "not_found_error", message: "fake" } });
  const choice = isPlainObject(body["tool_choice"]) ? body["tool_choice"] : undefined;
  const tools = body["tools"];
  const hasProbeTool = Array.isArray(tools) && tools.some((tool: unknown) => isPlainObject(tool) && tool["name"] === PROBE_TOOL.name);
  const block = choice?.["type"] === "auto" && hasProbeTool
    ? { type: "tool_use", id: `toolu_${randomUUID().replaceAll("-", "")}`, name: PROBE_TOOL.name, input: { key: "color" } }
    : { type: "text", text: holdsToolResult(body) ? "blue" : "ready" };
  const events = replyEvents(String(body["model"]), block);
  const held = JSON.stringify(body["messages"]).includes(CANCEL_ASK.content);
  return new Response(held ? heldStream(sseText(events.slice(0, 3)), init?.signal) : sseText(events),
    { status: 200, headers: { "content-type": "text/event-stream" } });
};

const fakeClaudeForwarder: AnthropicForwarder = (_req, res) => respondJson(res, 200, JSON.stringify({
  id: "msg_dry_run", type: "message", role: "assistant", model: "dry-run-claude", content: [{ type: "text", text: "ready" }],
  stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 9, output_tokens: 1 },
}));

/** Run the dry-run command: `run-action` attaches to the check proxy and starts the fake client. */
const runAttach = async (folder: string, env: Readonly<Record<string, string>>, signal: AbortSignal, out: (line: string) => void): Promise<boolean> => {
  const result = await nativeProcess(process.execPath, DRY_RUN_COMMAND.slice(1),
    { cwd: folder, env: { ...env, ...CLIENT_ENV }, timeoutMs: ATTACH_TIMEOUT_MS, signal });
  const passed = result.failure === undefined && result.code === 0;
  if (!passed) out(`The dry-run command failed (${result.failure ?? `exit ${String(result.code)}`}): ${result.stderr.slice(-2000)}`);
  return passed;
};

async function openDrySite(scratch: string): Promise<Site> {
  const home = join(scratch, "home"), temp = join(scratch, "tmp"), credentials = join(home, ".kimi-code", "credentials");
  await mkdir(credentials, { recursive: true, mode: 0o700 });
  await mkdir(temp, { mode: 0o700 });
  const kimiAuthFile = join(credentials, KIMI_SLOT);
  // Due now: less than max(300 s, expires_in / 2) of life is left, so the first Kimi request renews it.
  await writeFile(kimiAuthFile, JSON.stringify({ access_token: fabricated("access"), refresh_token: fabricated("refresh"),
    expires_at: Math.floor(Date.now() / 1000) + 240, scope: "kimi-code", token_type: "Bearer", expires_in: 3600 }),
  { mode: 0o600, flag: "wx" });
  const env = await dryConfigEnv(scratch, home, temp, await freePort());
  return { mode: "dry-run", home, env, kimiAuthFile, scratch, renewalExpected: true, kimiTransport: fakeKimiTransport,
    claudeForwarder: fakeClaudeForwarder, sessionTimeoutMs: ATTACH_TIMEOUT_MS + 10_000,
    attach: (folder, signal, out) => runAttach(folder, env, signal, out) };
}

function openLiveSite(scratch: string): Site {
  const home = homedir();
  return { mode: "live", home, env: process.env, kimiAuthFile: join(home, ".kimi-code", "credentials", KIMI_SLOT), scratch,
    renewalExpected: false, kimiTransport: liveKimiStoreDeps().fetch, claudeForwarder: undefined, sessionTimeoutMs: LIVE_SESSION_MS,
    attach: async () => true };
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

interface Start { readonly port: number; readonly evidenceDir: string; readonly signIn: Stats }

const sameRealPath = async (left: string, right: string): Promise<boolean> => {
  try { return await realpath(left) === await realpath(right); } catch { return false; }
};

async function preflight(args: LiveArguments, site: Site, startedAt: string): Promise<Result<Start, FailureCode>> {
  if (!await sameRealPath(process.cwd(), REPO_ROOT)) return err("repo_root_required");
  if (!await privateFolder(args.evidenceRoot)) return err("evidence_root_invalid");
  const region = KIMI_REGION_TABLE.global;
  if (region.baseUrl !== KIMI_API || region.oauthTokenUrl !== KIMI_TOKEN_URL) return err("host_mismatch");
  const user = checkUserConfig(loadConfig({ env: site.env, homeDir: site.home, cwd: REPO_ROOT, allowProjectPort: false }));
  if (!user.ok) return user;
  if (site.mode === "dry-run" && user.value.port === DEFAULT_PORT) return err("dry_run_port_refused");
  // A stat only. The Kimi sign-in store reads the file when the first Kimi request needs it.
  const signIn = await lstat(site.kimiAuthFile).catch(() => undefined);
  if (signIn?.isFile() !== true) return err("kimi_sign_in_missing");
  // The new dated folder is the one-run guard: mkdir fails when it exists.
  const evidenceDir = join(args.evidenceRoot, `kimi-${site.mode}-${startedAt.replaceAll(/[:.]/g, "-")}`);
  try { await mkdir(evidenceDir, { mode: 0o700 }); } catch { return err("evidence_dir_exists"); }
  return ok({ port: user.value.port, evidenceDir, signIn });
}

// ---------------------------------------------------------------------------
// Probe layer
// ---------------------------------------------------------------------------

export interface ProbeResult { readonly name: ProbeName; readonly status: StatusClass; readonly ok: boolean }

const PROBE_TOOL = { name: "read_value", description: "Return the stored value for a key.",
  input_schema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } };
const ASK = { role: "user", content: "Reply with the single word ready." };
const TOOL_ASK = { role: "user", content: "Call read_value with the key color, then report the value." };
const CANCEL_ASK = { role: "user", content: "Count from 1 to 200, one number on each line." };

const readCapped = async (response: Response, limit: number): Promise<string> => {
  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (let step = 0; step < 65_536 && size <= limit; step++) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks).toString("utf8");
    size += value.byteLength;
    chunks.push(value);
  }
  await reader.cancel();
  return "";
};

const sseEvents = (text: string): Record<string, unknown>[] => text.split("\n")
  .filter((line) => line.startsWith("data: ")).flatMap((line): Record<string, unknown>[] => {
    const event = parseObject(line.slice("data: ".length));
    return event === undefined ? [] : [event];
  });

const streamPassed = (text: string): boolean => {
  const events = sseEvents(text);
  const start = events.find((event) => event["type"] === "message_start")?.["message"];
  return events.some((event) => event["type"] === "message_stop") && isPlainObject(start) && start["model"] === PROBE_MODEL;
};

const jsonMessage = (text: string): Record<string, unknown> | undefined => {
  const message = parseObject(text);
  return message?.["type"] === "message" && message["model"] === PROBE_MODEL && Array.isArray(message["content"]) ? message : undefined;
};

const toolUse = (message: Record<string, unknown> | undefined): Record<string, unknown> | undefined => {
  const content = message?.["content"];
  const block = Array.isArray(content) ? content.find((item) => isPlainObject(item) && item["type"] === "tool_use") : undefined;
  return isPlainObject(block) && block["name"] === PROBE_TOOL.name && typeof block["id"] === "string" ? block : undefined;
};

const until = async (predicate: () => boolean, ms: number, signal: AbortSignal): Promise<boolean> => {
  for (let waited = 0; waited < ms && !signal.aborted; waited += 50) {
    if (predicate()) return true;
    await sleep(50);
  }
  return predicate();
};

async function runProbes(origin: string, ledger: CapLedger): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  const send = (path: string, body: unknown, signal: AbortSignal): Promise<Response> => fetch(`${origin}${path}`, {
    method: "POST", redirect: "error", signal: AbortSignal.any([signal, ledger.stop.signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)]),
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" }, body: JSON.stringify(body),
  });
  /** Send one probe and keep its status class and verdict. The reply text stays in memory. */
  const probe = async (name: ProbeName, path: string, body: unknown, check: (text: string) => boolean): Promise<string | undefined> => {
    if (ledger.failure !== undefined) {
      results.push({ name, status: "none", ok: false });
      return undefined;
    }
    try {
      const response = await send(path, body, new AbortController().signal);
      const text = await readCapped(response, PROBE_REPLY_BYTES);
      const passed = response.status === 200 && check(text);
      results.push({ name, status: statusClass(response.status), ok: passed });
      return passed ? text : undefined;
    } catch {
      results.push({ name, status: "none", ok: false });
      return undefined;
    }
  };
  const base = { model: PROBE_MODEL, max_tokens: MAX_OUTPUT_TOKENS };
  await probe("stream", "/v1/messages", { ...base, stream: true, messages: [ASK] }, streamPassed);
  await probe("json", "/v1/messages", { ...base, stream: false, messages: [ASK] }, (text) => jsonMessage(text) !== undefined);
  const callText = await probe("tool_call", "/v1/messages", { ...base, stream: false, tools: [PROBE_TOOL],
    tool_choice: { type: "auto" }, messages: [TOOL_ASK] }, (text) => toolUse(jsonMessage(text)) !== undefined);
  const call = callText === undefined ? undefined : jsonMessage(callText);
  const use = toolUse(call);
  if (call !== undefined && use !== undefined) {
    await probe("tool_result", "/v1/messages", { ...base, stream: false, tools: [PROBE_TOOL], messages: [TOOL_ASK,
      { role: "assistant", content: call["content"] }, { role: "user", content: [{ type: "tool_result", tool_use_id: use["id"], content: "blue" }] }] },
    (text) => jsonMessage(text) !== undefined);
  } else {
    results.push({ name: "tool_result", status: "none", ok: false });
  }
  const kimiBefore = ledger.counts.kimi;
  await probe("count_tokens", "/v1/messages/count_tokens", { model: PROBE_MODEL, messages: [ASK] },
    (text) => typeof parseObject(text)?.["input_tokens"] === "number" && ledger.counts.kimi === kimiBefore);
  results.push(await cancelProbe(send, ledger, base));
  return results;
}

/** Read the first chunk of a stream, close the client side, and check that the Kimi request stopped too. */
async function cancelProbe(send: (path: string, body: unknown, signal: AbortSignal) => Promise<Response>, ledger: CapLedger,
  base: Record<string, unknown>): Promise<ProbeResult> {
  if (ledger.failure !== undefined) return { name: "cancel", status: "none", ok: false };
  const client = new AbortController();
  const first = ledger.dispatches.length;
  try {
    const response = await send("/v1/messages", { ...base, stream: true, messages: [CANCEL_ASK] }, client.signal);
    const chunk = await response.body?.getReader().read();
    client.abort();
    const stopped = await until(() => ledger.dispatches.slice(first).some((item) => item.kind === "kimi" && item.aborted),
      CANCEL_WAIT_MS, ledger.stop.signal);
    return { name: "cancel", status: statusClass(response.status), ok: response.status === 200 && chunk?.done === false && stopped };
  } catch {
    client.abort();
    return { name: "cancel", status: "none", ok: false };
  }
}

// ---------------------------------------------------------------------------
// One run
// ---------------------------------------------------------------------------

export interface Renewal { readonly expected: boolean; readonly tokenPosts: number; readonly status: StatusClass; readonly storeChanged: boolean }
export interface Exercise {
  readonly probes: readonly ProbeResult[];
  readonly renewal: Renewal;
  readonly session: Readonly<SessionFacts>;
  readonly control: { readonly published: boolean; readonly removed: boolean };
  readonly cleanupOk: boolean;
}

const sameNode = (before: Stats, after: Stats | undefined): boolean =>
  after !== undefined && before.ino === after.ino && before.mtimeMs === after.mtimeMs && before.size === after.size;

const present = async (path: string): Promise<boolean> => {
  try { await lstat(path); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ENOENT"; }
};

/** The in-process configuration: the only place that has the Kimi opt-in block. */
const checkConfig = (site: Site, port: number) => loadConfig({
  configPath: join(site.scratch, "check-config.json"), env: {},
  readFile: () => JSON.stringify({
    port, logLevel: "warn",
    providers: { codex: { authFile: join(site.scratch, "absent-codex-auth.json") }, kimi: { region: "global", authFile: site.kimiAuthFile } },
    codexIngress: { enabled: false },
    limits: { maxBufferedBodyBytes: MAX_BODY_BYTES },
  }),
});

/** Product warnings go to the terminal. Only the fixed Kimi codes reach the evidence. */
const checkLogger = (ledger: CapLedger): Logger => {
  const terminal = createConsoleLogger("warn");
  return {
    log(level, event, fields) {
      const code = fields?.errorCode;
      if (code !== undefined && Object.hasOwn(KIMI_ERRORS, code) && ledger.kimiCodes.size < 16) ledger.kimiCodes.add(code as KimiErrorCode);
      terminal.log(level, event, fields);
    },
  };
};

const waitForEnd = (session: Session, ms: number, signal: AbortSignal): Promise<boolean> => new Promise((resolve) => {
  if (session.outcome !== "none") { resolve(true); return; }
  const finish = (ended: boolean): void => {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    session.onEnd = () => undefined;
    resolve(ended);
  };
  const onAbort = (): void => finish(false);
  const timer = setTimeout(() => finish(false), ms);
  if (signal.aborted) { finish(false); return; }
  signal.addEventListener("abort", onAbort, { once: true });
  session.onEnd = () => finish(true);
});

async function exercise(site: Site, start: Start, ledger: CapLedger, out: (line: string) => void): Promise<Exercise> {
  const session: Session = { actionStarted: false, outcome: "none", requests: 0, errorReplies: 0, onEnd: () => undefined };
  let probes: ProbeResult[] = [], proxy: Server | undefined, remove: (() => Promise<void>) | undefined, cleanupOk = true;
  const controlFile = actionControlPath(start.port, actionsDirectory(site.home));
  try {
    const config = checkConfig(site, start.port);
    if (!config.ok || !config.value.config.providers.kimi.optedIn) {
      ledger.fail("config_failed");
    } else {
      const deps = buildDeps(config.value.config, checkLogger(ledger), { fetchImpl: async () => { ledger.refuse("unknown_destination"); throw notSent("unknown_destination"); },
        providerDeps: { kimi: { openStore: liveKimiStoreDeps().openStore, fetch: cappedKimiFetch(ledger, site.kimiTransport), now: Date.now },
          together: REFUSING_TOGETHER } });
      const routing = deps.ok ? deps.value.sharedRouting : undefined;
      if (!deps.ok || routing === undefined) {
        ledger.fail("server_failed");
      } else {
        if (site.claudeForwarder !== undefined) deps.value.forwardAnthropic.close?.();
        const wrapped: ServerDeps = { ...deps.value, forwardAnthropic: cappedClaudeForwarder(ledger, site.claudeForwarder ?? deps.value.forwardAnthropic),
          providers: { ...deps.value.providers, codex: refusingHandler(ledger), together: refusingHandler(ledger) } };
        proxy = createProxyServer(wrapped);
        if (!capInbound(proxy, ledger, session)) ledger.fail("server_failed");
        else if (!(await listenServer(proxy, start.port, "127.0.0.1")).ok) ledger.fail("listen_failed");
        else {
          const origin = `http://127.0.0.1:${start.port}`;
          out(`The capped proxy listens on ${origin}. Probe layer: ${PROBE_NAMES.length} probes.`);
          probes = await runProbes(origin, ledger);
          if (probes.some((probe) => !probe.ok)) ledger.fail("probe_failed");
          if (ledger.failure === undefined) {
            const cooldownMs = cooldownFor(site.mode);
            out(`Probe layer passed. Cooldown: ${cooldownMs / 1000} s.`);
            if (cooldownMs > 0) await sleep(cooldownMs, undefined, { signal: ledger.stop.signal }).catch(() => ledger.fail("interrupted"));
          }
          if (ledger.failure === undefined) {
            ledger.phase = "session";
            remove = await publishActionControl(start.port, routing.actions.capability, actionsDirectory(site.home))
              .catch(() => { ledger.fail("control_failed"); return undefined; });
          }
          if (ledger.failure === undefined) {
            const folder = await prepareClientFolder(site.scratch, REPO_ROOT);
            if (!folder.ok) ledger.fail(folder.error);
            else if (ledger.failure === undefined) {
              out(`Client folder: ${folder.value}`);
              out(`  dry run: ${renderCommand(folder.value, DRY_RUN_COMMAND)}`);
              out(`  live:    ${renderCommand(folder.value, LIVE_COMMAND)}`);
              out(site.mode === "live" ? `Run the live command in a second Terminal now. The check waits up to ${LIVE_SESSION_MS / 60_000} min.`
                : "The dry run now runs the dry-run command itself.");
              const ended = waitForEnd(session, site.sessionTimeoutMs, ledger.stop.signal);
              const attached = await site.attach(folder.value, ledger.stop.signal, out);
              if (!attached) ledger.fail("attach_failed");
              if (!await ended) ledger.fail(ledger.stop.signal.aborted ? "interrupted" : "session_timeout");
            }
          }
        }
      }
    }
  } finally {
    if (remove !== undefined) await remove().catch(() => { cleanupOk = false; });
    if (proxy !== undefined) {
      const server = proxy;
      server.closeAllConnections();
      await closeWithCompletion((done) => server.close(done), "node_server").catch(() => { cleanupOk = false; });
    }
  }
  const removed = !(await present(controlFile));
  const refreshes = ledger.dispatches.filter((item) => item.kind === "refresh");
  const after = await lstat(site.kimiAuthFile).catch(() => undefined);
  const renewal: Renewal = { expected: site.renewalExpected, tokenPosts: refreshes.length, status: refreshes[0]?.status ?? "none",
    storeChanged: !sameNode(start.signIn, after) };
  return { probes, renewal, session, control: { published: remove !== undefined, removed }, cleanupOk: cleanupOk && removed };
}

/** The first rule that the run broke, or undefined. Each rule holds in both modes. */
export const verdict = (run: Exercise, ledger: CapLedger): FailureCode | undefined => {
  const sessionKimi = ledger.dispatches.filter((item) => item.phase === "session" && item.kind === "kimi");
  const rules: ReadonlyArray<readonly [boolean, FailureCode]> = [
    [run.renewal.expected && run.renewal.tokenPosts === 0, "renewal_missing"],
    [run.renewal.tokenPosts > 0 && (run.renewal.status !== "2xx" || !run.renewal.storeChanged), "renewal_failed"],
    [run.session.outcome !== "complete", "action_not_completed"],
    // Zero Claude Code requests through the action ingress is a failed run.
    [run.session.requests === 0, "no_session_requests"],
    [run.session.errorReplies > 0, "session_error_reply"],
    [!sessionKimi.some((item) => item.status === "2xx"), "no_kimi_session_dispatch"],
    [!run.cleanupOk, "cleanup_failed"],
  ];
  return ledger.failure ?? rules.find(([broken]) => broken)?.[1];
};

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

export interface Evidence {
  readonly schemaVersion: 1;
  readonly mode: Mode;
  readonly success: boolean;
  readonly failure: FailureCode | null;
  readonly durationMs: number;
  readonly cooldownMs: number;
  readonly caps: { readonly limits: Counts; readonly used: Counts };
  readonly refusals: readonly RefusalCode[];
  readonly probes: readonly ProbeResult[];
  readonly renewal: Renewal;
  readonly session: {
    readonly actionStarted: boolean;
    readonly outcome: Outcome;
    readonly requests: number;
    readonly errorReplies: number;
    readonly kimiDispatches: number;
    readonly claudeDispatches: number;
    /** A Claude request, then a Kimi request, then a Claude request again. */
    readonly switchObserved: boolean;
    /** A Kimi request held a tool result. */
    readonly toolRoundTrip: boolean;
  };
  readonly kimiCodes: readonly KimiErrorCode[];
  readonly control: { readonly published: boolean; readonly removed: boolean };
  readonly cleanupOk: boolean;
}

const EVIDENCE_KEYS: ReadonlySet<string> = new Set(["schemaVersion", "mode", "success", "failure", "durationMs", "cooldownMs",
  "caps", "limits", "used", ...COUNT_KEYS, "refusals", "probes", "name", "status", "ok", "renewal", "expected", "tokenPosts",
  "storeChanged", "session", "actionStarted", "outcome", "requests", "errorReplies", "kimiDispatches", "claudeDispatches",
  "switchObserved", "toolRoundTrip", "kimiCodes", "control", "published", "removed", "cleanupOk"]);
const EVIDENCE_STRINGS: ReadonlySet<string> = new Set([...MODES, ...FAILURE_CODES, ...REFUSAL_CODES, ...PROBE_NAMES,
  ...STATUS_CLASSES, ...OUTCOMES, ...Object.keys(KIMI_ERRORS)]);

/**
 * True when the report holds only fixed field names, counts, booleans, null and fixed codes.
 * Any other string fails, so a path, an e-mail address or a token can not reach the file.
 */
export function checkEvidence(value: unknown): boolean {
  let nodes = 0;
  const walk = (item: unknown, depth: number): boolean => {
    nodes += 1;
    if (nodes > 512 || depth > 6) return false;
    if (item === null || typeof item === "boolean") return true;
    if (typeof item === "number") return Number.isSafeInteger(item) && item >= 0;
    if (typeof item === "string") return EVIDENCE_STRINGS.has(item);
    if (Array.isArray(item)) return item.every((entry) => walk(entry, depth + 1));
    return isPlainObject(item) && Object.entries(item).every(([key, entry]) => EVIDENCE_KEYS.has(key) && walk(entry, depth + 1));
  };
  return walk(value, 0);
}

const buildEvidence = (mode: Mode, startedMs: number, run: Exercise, ledger: CapLedger): Evidence => {
  const failure = verdict(run, ledger);
  const session = ledger.dispatches.filter((item) => item.phase === "session" && item.kind !== "refresh" && item.kind !== "loopback");
  const order = session.map((item) => (item.kind === "kimi" ? "kimi" : "claude"));
  const firstKimi = order.indexOf("kimi");
  return {
    schemaVersion: 1, mode, success: failure === undefined, failure: failure ?? null, durationMs: Date.now() - startedMs,
    cooldownMs: cooldownFor(mode), caps: { limits: CAP_LIMITS, used: ledger.counts }, refusals: [...ledger.refusals], probes: run.probes,
    renewal: run.renewal,
    session: {
      actionStarted: run.session.actionStarted, outcome: run.session.outcome, requests: run.session.requests,
      errorReplies: run.session.errorReplies, kimiDispatches: order.filter((kind) => kind === "kimi").length,
      claudeDispatches: order.filter((kind) => kind === "claude").length,
      switchObserved: firstKimi > 0 && order.indexOf("claude") < firstKimi && order.lastIndexOf("claude") > firstKimi,
      toolRoundTrip: session.some((item) => item.kind === "kimi" && item.toolResult),
    },
    kimiCodes: [...ledger.kimiCodes], control: run.control, cleanupOk: run.cleanupOk,
  };
};

/** Write report.json, or a fixed refusal when the report fails the evidence check. */
const writeEvidence = async (folder: string, evidence: Evidence): Promise<boolean> => {
  const accepted = checkEvidence(evidence);
  const report = accepted ? evidence : { schemaVersion: 1, mode: evidence.mode, success: false, failure: "evidence_rejected" };
  try {
    await writeFile(join(folder, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    return accepted;
  } catch {
    return false;
  }
};

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/** One run of the check in the given mode. True only when every rule held and the evidence was written. */
export async function runCheck(args: LiveArguments, out: (line: string) => void): Promise<boolean> {
  const startedMs = Date.now();
  const ledger = new CapLedger();
  const interrupt = (): void => ledger.fail("interrupted");
  for (const name of SIGNALS) process.on(name, interrupt);
  let scratch: string | undefined;
  let scratchRemoved = false;
  let start: Start, run: Exercise;
  try {
    scratch = await mkdtemp(join(await realpath(tmpdir()), `subswitch-kimi-${args.mode}-`));
    const site = args.mode === "dry-run" ? await openDrySite(scratch) : openLiveSite(scratch);
    const prepared = await preflight(args, site, new Date(startedMs).toISOString());
    if (!prepared.ok) {
      out(JSON.stringify({ success: false, code: prepared.error }));
      return false;
    }
    start = prepared.value;
    run = await exercise(site, start, ledger, out);
  } finally {
    if (scratch !== undefined) scratchRemoved = await rm(scratch, { recursive: true, force: true }).then(() => true, () => false);
    for (const name of SIGNALS) process.off(name, interrupt);
  }
  const evidence = buildEvidence(args.mode, startedMs, { ...run, cleanupOk: run.cleanupOk && scratchRemoved }, ledger);
  const written = await writeEvidence(start.evidenceDir, evidence);
  out(JSON.stringify({ success: evidence.success && written, failure: evidence.failure, evidence: start.evidenceDir }));
  return evidence.success && written;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2), {
    env: process.env, stdinIsTTY: process.stdin.isTTY === true, stdoutIsTTY: process.stdout.isTTY === true, ask: askLine,
    out: (line) => process.stdout.write(`${line}\n`), run: (args) => runCheck(args, (line) => process.stdout.write(`${line}\n`)),
  });
}
