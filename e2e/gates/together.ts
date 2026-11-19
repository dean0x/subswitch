/**
 * Bounded live check of the paid Together leg. Only the founder runs it, with
 * `SUBSWITCH_TOGETHER_PROBE_ACK_USD=<ceiling> npm run probe:together`; npm test and CI never do.
 *
 * Controls, in this order: refuse when CI is set; parse the spend acknowledgement; refuse a
 * worst case above it; load the key through the product loader; read the free model list and
 * refuse again at max(catalog, live) prices, all before any paid request. Every Together request
 * goes through a loopback relay that counts and bounds it. The key is never in argv or output.
 */
import http from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { loadConfig, TOGETHER_DEFAULT_HOST } from "../../src/config.js";
import { err, ok, type Result } from "../../src/result.js";
import { childEnvWithoutTogetherKey } from "../../src/run-action.js";
import { buildDeps, createProxyServer, listenServer, liveTogetherKeyReaderDeps } from "../../src/server.js";
import { createTogetherKeyReader, type TogetherKeyReaderDeps } from "../../src/together-auth.js";
import { TOGETHER_MODELS } from "../../src/together-models.js";
import { CredentialUnavailable, probeHeaders } from "./credentials.js";
import { isolatedNativeEnv, nativeProcess } from "./native-process.js";
import { object } from "./probe.js";

export type Part = 1 | 2 | 3;
export interface Price { readonly in: number; readonly out: number }
export type PlanRefusal = "ci_refused" | "ack_missing" | "ack_invalid" | "above_ceiling";
export interface RunPlan { readonly paidRequests: number; readonly ceilingUsd: number; readonly worstCaseUsd: number }

interface PhaseBound { readonly requests: number; readonly maxTokens: number; readonly bodyBytes: number; readonly worstInputTokens: number }
const KIB = 1024;
const PART1_MARGIN_BYTES = 64 * KIB;
/** Assumed upper bound of the input tokens of one 8x8 image. The live run decides it. */
const IMAGE_TOKENS = 4_096;
// Body bytes count as input tokens: a token holds at least one byte. Part 1 bodies after the
// first may grow to the first size plus the margin, so its worst case uses 128 KiB + 64 KiB.
const PHASES: Readonly<Record<Part, PhaseBound>> = {
  1: { requests: 4, maxTokens: 4_096, bodyBytes: 128 * KIB, worstInputTokens: 128 * KIB + PART1_MARGIN_BYTES },
  2: { requests: 8, maxTokens: 2_048, bodyBytes: 16 * KIB, worstInputTokens: 16 * KIB },
  3: { requests: 6, maxTokens: 16, bodyBytes: 8 * KIB, worstInputTokens: 8 * KIB + IMAGE_TOKENS },
};
const PARTS: readonly Part[] = [1, 2, 3];
const PAID_REQUESTS = PARTS.reduce((sum, part) => sum + PHASES[part].requests, 0);
const BOUNDS = {
  part1: { requests: PHASES[1].requests, firstBodyBytes: PHASES[1].bodyBytes, laterBodyBytes: `first + ${PART1_MARGIN_BYTES}`,
    maxTokens: PHASES[1].maxTokens },
  part2: { requests: PHASES[2].requests, bodyBytes: PHASES[2].bodyBytes, maxTokens: PHASES[2].maxTokens },
  part3: { requests: PHASES[3].requests, bodyBytes: PHASES[3].bodyBytes, maxTokens: PHASES[3].maxTokens },
};
const ACK_ENV = "SUBSWITCH_TOGETHER_PROBE_ACK_USD";
const ACK_PATTERN = /^\d+(\.\d{1,2})?$/;

/** Worst-case spend in USD: every paid request at its bounds, at the highest row price. */
export const worstCaseUsd = (live: ReadonlyMap<string, Price> = new Map()): number => {
  const rows = TOGETHER_MODELS.map((model) => ({
    in: Math.max(model.priceInPerMTokens, live.get(model.id)?.in ?? 0),
    out: Math.max(model.priceOutPerMTokens, live.get(model.id)?.out ?? 0),
  }));
  const priceIn = Math.max(...rows.map((row) => row.in));
  const priceOut = Math.max(...rows.map((row) => row.out));
  // One division at the end keeps the fixed phases an exact decimal.
  const perMillion = PARTS.reduce((sum, part) => {
    const phase = PHASES[part];
    return sum + phase.requests * (phase.worstInputTokens * priceIn + phase.maxTokens * priceOut);
  }, 0);
  return perMillion / 1e6;
};

export const planRun = (env: Readonly<Record<string, string | undefined>>,
  live: ReadonlyMap<string, Price> = new Map()): Result<RunPlan, PlanRefusal> => {
  if ((env["CI"] ?? "") !== "") return err("ci_refused");
  const ack = env[ACK_ENV] ?? "";
  if (ack === "") return err("ack_missing");
  const ceilingUsd = Number(ack);
  if (!ACK_PATTERN.test(ack) || !Number.isFinite(ceilingUsd) || ceilingUsd <= 0) return err("ack_invalid");
  const worst = worstCaseUsd(live);
  // A NaN worst case fails this comparison too, so it refuses.
  if (!(worst <= ceilingUsd)) return err("above_ceiling");
  return ok({ paidRequests: PAID_REQUESTS, ceilingUsd, worstCaseUsd: worst });
};

export type RelayRefusal = "route" | "no_part" | "request_cap" | "body_bound" | "max_tokens";
export interface RelayRecord {
  /** 0 is the free model list before Part 1. */
  readonly phase: 0 | Part;
  readonly refused: RelayRefusal | null;
  /** Upstream status; null when the relay refused or no upstream response arrived. */
  readonly status: number | null;
  readonly requestBytes: number;
  readonly model: string | null;
  readonly stream: boolean;
  readonly maxTokens: number | null;
  /** Reasoning replay fields in the assistant messages of the request. */
  readonly replayFields: readonly string[];
  readonly toolResults: number;
  readonly finishReasons: readonly string[];
  /** Each raw `arguments` value of a tool call, as Together sent it. */
  readonly toolArguments: readonly unknown[];
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  /** The relay client closed before the upstream response ended. */
  readonly closedEarly: boolean;
}
export interface CountingRelay {
  readonly url: string;
  readonly records: readonly RelayRecord[];
  setPart(part: Part): void;
  /** Wait, at most 5 s, until no request is in flight. */
  settled(): Promise<void>;
  close(): Promise<void>;
}

const FORWARDED_HEADERS = ["authorization", "content-type", "accept", "user-agent"] as const;
const MAX_BODY_READ = 1024 * KIB;
const MAX_RESPONSE_BYTES = 8 * 1024 * KIB;
const MAX_RECORDS = 256;
const MAX_TOOL_ARGUMENTS = 64;
const RELAY_TIMEOUT_MS = 180_000;

const closeServer = (server: http.Server): Promise<void> => new Promise((done) => {
  server.closeAllConnections();
  server.close(() => done());
});

const readBody = async (req: http.IncomingMessage): Promise<Buffer | undefined> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_READ) {
      req.destroy();
      return undefined;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};

const jsonParse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};
const jsonObject = (text: string): Record<string, unknown> | undefined => object(jsonParse(text));

const requestFacts = (body: Record<string, unknown> | undefined) => {
  const fields = new Set<string>();
  let toolResults = 0;
  const messages = body?.["messages"];
  for (const value of Array.isArray(messages) ? messages : []) {
    const message = object(value);
    if (message?.["role"] === "tool") toolResults++;
    if (message?.["role"] !== "assistant") continue;
    for (const field of ["reasoning", "reasoning_content"]) if (Object.hasOwn(message, field)) fields.add(field);
  }
  const model = body?.["model"], maxTokens = body?.["max_tokens"];
  return { model: typeof model === "string" ? model : null, stream: body?.["stream"] === true,
    maxTokens: typeof maxTokens === "number" ? maxTokens : null, replayFields: [...fields].sort(), toolResults };
};

/** Read stop reasons, token counts and raw tool arguments from an SSE or JSON chat reply. */
const summarizeChat = (text: string) => {
  const finishReasons: string[] = [], toolArguments: unknown[] = [];
  let promptTokens: number | null = null, completionTokens: number | null = null;
  const payloads = text.trimStart().startsWith("{") ? [text]
    : text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim());
  for (const payload of payloads) {
    const chunk = jsonObject(payload), choices = chunk?.["choices"], usage = object(chunk?.["usage"]);
    for (const value of Array.isArray(choices) ? choices : []) {
      const choice = object(value), finish = choice?.["finish_reason"];
      if (typeof finish === "string") finishReasons.push(finish);
      const calls = (object(choice?.["delta"]) ?? object(choice?.["message"]))?.["tool_calls"];
      for (const call of Array.isArray(calls) ? calls : []) {
        const fn = object(object(call)?.["function"]);
        if (fn && Object.hasOwn(fn, "arguments") && toolArguments.length < MAX_TOOL_ARGUMENTS) toolArguments.push(fn["arguments"]);
      }
    }
    const prompt = usage?.["prompt_tokens"], completion = usage?.["completion_tokens"];
    if (typeof prompt === "number") promptTokens = prompt;
    if (typeof completion === "number") completionTokens = completion;
  }
  return { finishReasons, toolArguments, promptTokens, completionTokens };
};

const routeOf = (req: http.IncomingMessage): "models" | "chat" | undefined => {
  if (req.method === "GET" && req.url === "/v1/models") return "models";
  if (req.method === "POST" && req.url === "/v1/chat/completions") return "chat";
  return undefined;
};

/**
 * Loopback relay in front of Together. It forwards one free model list before Part 1, then
 * at most the planned paid requests of each part, each under its body and max_tokens bound.
 * A refusal is a local 400 (Claude Code does not retry it). It never retries.
 */
export const createCountingRelay = async (options: { readonly upstream: string; readonly timeoutMs?: number }):
  Promise<Result<CountingRelay, "relay_listen_failed">> => {
  const records: RelayRecord[] = [];
  const counts: Record<Part, number> = { 1: 0, 2: 0, 3: 0 };
  let phase: 0 | Part = 0, firstPart1Bytes: number | undefined, modelListServed = false, inflight = 0;
  const record = (entry: RelayRecord): void => {
    if (records.length < MAX_RECORDS) records.push(entry);
  };

  const refusalFor = (route: "models" | "chat" | undefined, current: 0 | Part, bytes: number,
    body: Record<string, unknown> | undefined): RelayRefusal | undefined => {
    if (route === "models") return current === 0 && !modelListServed && bytes === 0 ? undefined : "route";
    if (route !== "chat") return "route";
    if (current === 0) return "no_part";
    const bound = PHASES[current];
    // The phase caps sum to the paid request total, so request 19 meets the Part 3 cap.
    if (counts[current] >= bound.requests) return "request_cap";
    const limit = current === 1 && firstPart1Bytes !== undefined ? firstPart1Bytes + PART1_MARGIN_BYTES : bound.bodyBytes;
    if (bytes > limit) return "body_bound";
    const maxTokens = body?.["max_tokens"];
    const bounded = typeof maxTokens === "number" && Number.isInteger(maxTokens) && maxTokens >= 1 && maxTokens <= bound.maxTokens;
    return bounded ? undefined : "max_tokens";
  };

  const forward = async (req: http.IncomingMessage, res: http.ServerResponse, current: 0 | Part, raw: Buffer,
    facts: ReturnType<typeof requestFacts>): Promise<void> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? RELAY_TIMEOUT_MS);
    let closedEarly = false;
    res.on("error", () => undefined);
    res.once("close", () => {
      closedEarly = !res.writableFinished;
      controller.abort();
    });
    const headers: Record<string, string> = {};
    for (const name of FORWARDED_HEADERS) {
      const value = req.headers[name];
      if (typeof value === "string") headers[name] = value;
    }
    const tap: Buffer[] = [];
    let status: number | null = null, bytes = 0;
    try {
      // No retry and no redirect: a repeated POST can spend again, and a redirect can move the key.
      const upstream = await fetch(`${options.upstream}${req.url}`, { method: req.method ?? "GET", headers,
        body: req.method === "POST" ? new Uint8Array(raw) : null, redirect: "error", signal: controller.signal });
      status = upstream.status;
      res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/octet-stream" });
      if (upstream.body) for await (const chunk of upstream.body) {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) break;
        if (current !== 0) tap.push(Buffer.from(chunk));
        res.write(chunk);
      }
    } catch {
      // The record keeps what arrived before the stream stopped.
    } finally {
      clearTimeout(timer);
    }
    if (!res.headersSent) res.writeHead(502);
    res.end();
    record({ phase: current, refused: null, status, requestBytes: raw.length, ...facts, closedEarly,
      ...summarizeChat(Buffer.concat(tap).toString("utf8")) });
  };

  const refuse = (res: http.ServerResponse, current: 0 | Part, refused: RelayRefusal, requestBytes: number,
    facts: ReturnType<typeof requestFacts>): void => {
    record({ phase: current, refused, status: null, requestBytes, ...facts, closedEarly: false, ...summarizeChat("") });
    if (res.destroyed) return;
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { type: "invalid_request_error", message: `Probe relay refused the request (${refused}).` } }));
  };

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const route = routeOf(req), current = phase;
    const raw = await readBody(req);
    if (raw === undefined) {
      refuse(res, current, "body_bound", MAX_BODY_READ, requestFacts(undefined));
      return;
    }
    const body = route === "chat" ? jsonObject(raw.toString("utf8")) : undefined;
    const facts = requestFacts(body);
    const refused = refusalFor(route, current, raw.length, body);
    if (refused !== undefined) {
      refuse(res, current, refused, raw.length, facts);
      return;
    }
    if (route === "models") modelListServed = true;
    if (route === "chat" && current !== 0) {
      counts[current]++;
      if (current === 1) firstPart1Bytes ??= raw.length;
    }
    await forward(req, res, current, raw, facts);
  };

  const server = http.createServer((req, res) => {
    inflight++;
    handle(req, res)
      .catch(() => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      })
      .finally(() => { inflight--; });
  });
  const listening = await listenServer(server, 0, "127.0.0.1");
  const address = server.address();
  if (!listening.ok || address === null || typeof address === "string") {
    await closeServer(server);
    return err("relay_listen_failed");
  }
  return ok({
    url: `http://127.0.0.1:${address.port}`,
    records,
    setPart: (part) => { phase = part; },
    settled: async () => {
      for (let i = 0; i < 200 && inflight > 0; i++) await delay(25);
    },
    close: () => closeServer(server),
  });
};

const KEY_IN_REPORT = JSON.stringify({ success: false, code: "key_in_report" });

/** Serialize the report, or only a refusal code when it holds the exact key in any form. */
export const renderReport = (report: unknown, key: string): string => {
  const text = JSON.stringify(report);
  // JSON escapes a quote or a backslash in the key, so search the escaped form too.
  return text.includes(key) || text.includes(JSON.stringify(key).slice(1, -1)) ? KEY_IN_REPORT : text;
};

const readCapped = async (response: Response, maxBytes: number): Promise<string | undefined> => {
  const chunks: Buffer[] = [];
  let size = 0;
  if (response.body) for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxBytes) return undefined;
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
};

const MODEL_LIST_TIMEOUT_MS = 60_000;
const finitePrice = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

/** Part 0 (free): the live price of each catalog row, in USD per 1M tokens. */
const readLivePrices = async (relayUrl: string, key: string): Promise<Result<Map<string, Price>, "model_list_unavailable">> => {
  const response = await fetch(`${relayUrl}/v1/models`, { headers: { authorization: `Bearer ${key}`, accept: "application/json" },
    signal: AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS) });
  const text = await readCapped(response, MAX_RESPONSE_BYTES);
  const parsed = text === undefined || response.status !== 200 ? undefined : jsonParse(text);
  const list = Array.isArray(parsed) ? parsed : object(parsed)?.["data"];
  if (!Array.isArray(list)) return err("model_list_unavailable");
  const ids = new Set(TOGETHER_MODELS.map((model) => model.id));
  const prices = new Map<string, Price>();
  for (const entry of list) {
    const row = object(entry), pricing = object(row?.["pricing"]), id = row?.["id"];
    const input = finitePrice(pricing?.["input"]), output = finitePrice(pricing?.["output"]);
    if (typeof id === "string" && ids.has(id) && input !== undefined && output !== undefined) prices.set(id, { in: input, out: output });
  }
  return ok(prices);
};

class ProbeStop extends Error {
  constructor(readonly code: string) { super(code); }
}

/** A key reader seam that returns a key the probe already holds, so the proxy reads no Keychain item again. */
const keySeam = (key: string): TogetherKeyReaderDeps => ({
  env: {}, platform: "darwin", exec: async () => ({ stdout: key }),
  setTimer: (expire, delayMs) => {
    const timer = setTimeout(expire, delayMs);
    return () => clearTimeout(timer);
  },
});

interface LocalProxy { readonly url: string; close(): Promise<void> }
const startProxy = async (configPath: string, key: string, events: Set<string>): Promise<LocalProxy> => {
  const config = loadConfig({ env: { SUBSWITCH_CONFIG: configPath }, globalConfigPath: false });
  if (!config.ok) throw new ProbeStop("config_rejected");
  const deps = buildDeps(config.value.config, { log: (_level, event) => { if (events.size < 64) events.add(event); } },
    { togetherKeyReader: keySeam(key) });
  if (!deps.ok) throw new ProbeStop("proxy_rejected");
  const server = createProxyServer(deps.value);
  const listening = await listenServer(server, 0, "127.0.0.1");
  const address = server.address();
  if (!listening.ok || address === null || typeof address === "string") {
    await closeServer(server);
    throw new ProbeStop("proxy_listen_failed");
  }
  return { url: `http://127.0.0.1:${address.port}`, close: () => closeServer(server) };
};

const CLIENT_TIMEOUT_MS = 180_000;
interface ClientResult { readonly summary: Record<string, unknown>; readonly content: unknown }

/** Post a Messages request to the proxy. The summary keeps statuses, stop reasons and counts, never text. */
const post = async (url: string, body: object, cancelAfterFirstChunk = false): Promise<ClientResult> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);
  try {
    const response = await fetch(`${url}/v1/messages`, { method: "POST", signal: controller.signal,
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" }, body: JSON.stringify(body) });
    const head = { status: response.status, shouldRetry: response.headers.get("x-should-retry") };
    if (cancelAfterFirstChunk) {
      await response.body?.getReader().read();
      return { summary: { ...head, cancelled: true }, content: undefined };
    }
    const text = await readCapped(response, MAX_RESPONSE_BYTES);
    const reply = text === undefined ? undefined : object(jsonParse(text));
    const usage = object(reply?.["usage"]);
    return { summary: { ...head, stopReason: reply?.["stop_reason"] ?? null, errorType: object(reply?.["error"])?.["type"] ?? null,
      inputTokens: usage?.["input_tokens"] ?? null, outputTokens: usage?.["output_tokens"] ?? null }, content: reply?.["content"] };
  } finally {
    clearTimeout(timer);
    // For the cancel step this abort is the cancel: the proxy sees its client close.
    controller.abort();
  }
};

const KIMI = "moonshotai/Kimi-K3.1-Pro", GLM = "zai-org/GLM-5.3", DEEPSEEK = "deepseek-ai/DeepSeek-V4-Pro-0813";
const PART1_AGENT = "together_probe";
const PART1_TIMEOUT_MS = 300_000;

/** Part 1: a Claude Code parent on the subscription delegates one Read to a Together sub-agent. */
const runPart1 = async (proxyUrl: string, temp: string) => {
  const claude = await probeHeaders({ provider: "claude", auth: "subscription" });
  const work = join(temp, "work"), configDir = join(temp, "claude");
  await mkdir(work, { mode: 0o700 });
  await mkdir(configDir, { mode: 0o700 });
  const fixture = `together-read-${randomUUID()}`;
  await writeFile(join(work, "check.txt"), fixture, { mode: 0o600 });
  // The child gets no form of the paid key name: Windows matches env names in any letter case.
  const env = childEnvWithoutTogetherKey(isolatedNativeEnv({ CLAUDE_CONFIG_DIR: configDir,
    CLAUDE_CODE_OAUTH_TOKEN: (claude["authorization"] ?? "").slice("Bearer ".length), ANTHROPIC_BASE_URL: proxyUrl }));
  const result = await nativeProcess("claude", [
    "--print", "--setting-sources", "", "--settings", '{"disableAllHooks":true}', "--disable-slash-commands",
    "--strict-mcp-config", "--no-session-persistence", "--tools", "Agent,Read", "--allowedTools", "Agent,Read",
    "--permission-mode", "dontAsk", "--model", "sonnet", "--effort", "low", "--output-format", "json",
    "--agents", JSON.stringify({ [PART1_AGENT]: { description: "Read the probe fixture.", model: `together:${KIMI}`, tools: ["Read"],
      prompt: "Read check.txt with the Read tool and report its exact content. Do not use other tools." } }),
    `Delegate to ${PART1_AGENT} to read check.txt. Return the exact value that the child reports. Do not read it yourself.`,
  ], { cwd: work, env, timeoutMs: PART1_TIMEOUT_MS });
  let answer: Record<string, unknown> | undefined;
  try { answer = object(JSON.parse(result.stdout)); } catch { /* Never emit CLI output. */ }
  return { nativeExit: result.failure ?? `exit_${result.code}`,
    answerMatched: answer?.["is_error"] === false && typeof answer["result"] === "string" && answer["result"].includes(fixture) };
};

const user = (text: string) => ({ role: "user", content: text });
const ask = (model: string, messages: readonly object[], extra: object = {}) =>
  ({ model: `together:${model}`, max_tokens: PHASES[2].maxTokens, stream: false, messages, ...extra });

/** Part 2: eight direct requests through the proxy: non-stream, cancel, 401, text replay, M16, zero-argument tool. */
const runPart2 = async (relay: CountingRelay, proxyUrl: string, fabricatedProxyUrl: string) => {
  const steps: object[] = [];
  const step = async (name: string, run: () => Promise<ClientResult>): Promise<ClientResult> => {
    const before = relay.records.length;
    const result = await run();
    await relay.settled();
    steps.push({ step: name, client: result.summary, relay: relay.records.slice(before) });
    return result;
  };
  await step("non_stream", () => post(proxyUrl, ask(KIMI, [user("Reply with the word ready.")])));
  await step("stream_cancel", () => post(proxyUrl, ask(KIMI, [user("Count from 1 to 300, one number per line.")], { stream: true }), true));
  await step("fabricated_key", () => post(fabricatedProxyUrl, ask(KIMI, [user("Reply with the word ready.")])));
  const opening = [user("Name one primary color. Reply with one word.")];
  const textTurn = await step("text_turn", () => post(proxyUrl, ask(KIMI, opening)));
  if (Array.isArray(textTurn.content)) {
    const replay = ask(KIMI, [...opening, { role: "assistant", content: textTurn.content }, user("Name another one. Reply with one word.")]);
    await step("text_turn_replay", () => post(proxyUrl, replay));
  }
  await step("reasoning_fills_max_tokens", () => post(proxyUrl, ask(GLM, [user("Think step by step: what is 17 times 23?")], { max_tokens: 16 })));
  const tools = [{ name: "current_time", description: "Return the current time. It takes no arguments.",
    input_schema: { type: "object", properties: {} } }];
  const question = [user("What time is it? Use the current_time tool.")];
  const call = await step("zero_argument_tool", () => post(proxyUrl, ask(DEEPSEEK, question, { tools, tool_choice: { type: "tool", name: "current_time" } })));
  const blocks = Array.isArray(call.content) ? call.content : [];
  const toolUseId = blocks.map((block) => object(block)).find((block) => block?.["type"] === "tool_use")?.["id"];
  if (typeof toolUseId === "string") {
    const continuation = ask(DEEPSEEK, [...question, { role: "assistant", content: blocks },
      { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: "12:00" }] }], { tools });
    await step("tool_continuation", () => post(proxyUrl, continuation));
  }
  return steps;
};

// An 8x8 red RGB PNG.
const PNG_8X8 = "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC";
const IMAGE_PROMPT = "What color is this image? Reply with one word.";

const imageStatus = (status: number | null): "accepted" | "rejected" | "unknown" => {
  if (status === 200) return "accepted";
  if (status === 400 || status === 422) return "rejected";
  return "unknown";
};

/**
 * Part 3: one image request per row. Rows marked without images skip the proxy, which
 * would refuse the image itself, and go to the relay with a probe-built body.
 */
const runPart3 = async (relay: CountingRelay, proxyUrl: string, key: string) => {
  const rows: object[] = [];
  for (const model of TOGETHER_MODELS) {
    const before = relay.records.length;
    if (model.images) {
      await post(proxyUrl, { model: `together:${model.id}`, max_tokens: PHASES[3].maxTokens, stream: false, messages: [{ role: "user",
        content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG_8X8 } }, { type: "text", text: IMAGE_PROMPT }] }] });
    } else {
      const response = await fetch(`${relay.url}/v1/chat/completions`, { method: "POST", signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS),
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ model: model.id, max_tokens: PHASES[3].maxTokens, messages: [{ role: "user", content: [
          { type: "image_url", image_url: { url: `data:image/png;base64,${PNG_8X8}` } }, { type: "text", text: IMAGE_PROMPT }] }] }) });
      await readCapped(response, MAX_RESPONSE_BYTES);
    }
    await relay.settled();
    const status = relay.records.slice(before).find((entry) => entry.refused === null)?.status ?? null;
    rows.push({ id: model.id, route: model.images ? "subswitch" : "direct", catalogImages: model.images,
      upstreamStatus: status, images: imageStatus(status) });
  }
  return rows;
};

const runLiveParts = async (relay: CountingRelay, key: string, live: ReadonlyMap<string, Price>, plan: RunPlan) => {
  const temp = await mkdtemp(join(tmpdir(), "subswitch-together-probe-"));
  const events = new Set<string>();
  const proxies: LocalProxy[] = [];
  try {
    const configPath = join(temp, "subswitch.config.json");
    await writeFile(configPath, JSON.stringify({ logLevel: "error",
      providers: { together: { baseUrl: `${relay.url}/v1`, outputCap: PHASES[1].maxTokens } } }), { mode: 0o600 });
    const proxy = await startProxy(configPath, key, events);
    proxies.push(proxy);
    const fabricated = await startProxy(configPath, `fabricated-${randomUUID()}`, events);
    proxies.push(fabricated);
    relay.setPart(1);
    const part1 = await runPart1(proxy.url, temp);
    await relay.settled();
    const part1Relay = relay.records.filter((entry) => entry.phase === 1);
    relay.setPart(2);
    const part2 = await runPart2(relay, proxy.url, fabricated.url);
    relay.setPart(3);
    const part3 = await runPart3(relay, proxy.url, key);
    const passed = part1.nativeExit === "exit_0" && part1.answerMatched &&
      part1Relay.some((entry) => entry.finishReasons.includes("tool_calls")) && part1Relay.some((entry) => entry.toolResults > 0);
    const refusals = relay.records.filter((entry) => entry.refused !== null).length;
    return {
      schemaVersion: 1, success: passed && refusals === 0, refusals,
      plan: { ...plan, worstCaseUsdCatalog: worstCaseUsd() },
      prices: TOGETHER_MODELS.map((model) => ({ id: model.id,
        catalog: { in: model.priceInPerMTokens, out: model.priceOutPerMTokens }, live: live.get(model.id) ?? null })),
      part1: { ...part1, passed, relay: part1Relay }, part2, part3, events: [...events].sort(),
    };
  } finally {
    for (const proxy of proxies) await proxy.close();
    await rm(temp, { recursive: true, force: true });
  }
};

type LiveRun = (relay: CountingRelay, key: string, live: ReadonlyMap<string, Price>, plan: RunPlan) =>
  Promise<{ readonly success: boolean }>;
export interface ProbeSeams {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly keyReader: TogetherKeyReaderDeps;
  /** Together origin, with no path. */
  readonly upstream: string;
  readonly print: (line: string) => void;
  /** Parts 1 to 3. Tests replace it, so no test reads the Claude sign-in or starts Claude Code. */
  readonly runLive?: LiveRun;
}

const KEY_TIMEOUT_MS = 30_000;
const refusal = (code: string, extra: object = {}): string => JSON.stringify({ success: false, code, ...extra });

/** Exit 0 on success, 1 when a check failed, 2 when a control refused or the run stopped. */
export const runProbe = async (seams: ProbeSeams): Promise<number> => {
  const plan = planRun(seams.env);
  if (!plan.ok) {
    seams.print(refusal(plan.error, plan.error === "above_ceiling" ? { worstCaseUsd: worstCaseUsd() } : {}));
    return 2;
  }
  seams.print(JSON.stringify({ plan: { ...plan.value, bounds: BOUNDS } }));
  const loaded = await createTogetherKeyReader(seams.keyReader).readKey(AbortSignal.timeout(KEY_TIMEOUT_MS));
  if (!loaded.ok) {
    seams.print(refusal(`key_${loaded.error}`));
    return 2;
  }
  const key = loaded.value.key;
  const relay = await createCountingRelay({ upstream: seams.upstream });
  if (!relay.ok) {
    seams.print(refusal(relay.error));
    return 2;
  }
  try {
    const live = await readLivePrices(relay.value.url, key);
    if (!live.ok) {
      seams.print(refusal(live.error));
      return 2;
    }
    const checked = planRun(seams.env, live.value);
    if (!checked.ok) {
      seams.print(renderReport({ success: false, code: checked.error, worstCaseUsd: worstCaseUsd(live.value) }, key));
      return 2;
    }
    const report = await (seams.runLive ?? runLiveParts)(relay.value, key, live.value, checked.value);
    const rendered = renderReport(report, key);
    seams.print(rendered);
    if (rendered === KEY_IN_REPORT) return 2;
    return report.success ? 0 : 1;
  } catch (error) {
    // Print only a fixed code: an error text could hold a header value.
    seams.print(refusal(error instanceof ProbeStop || error instanceof CredentialUnavailable ? error.code : "probe_failed"));
    return 2;
  } finally {
    await relay.value.close();
  }
};

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runProbe({ env: process.env, keyReader: liveTogetherKeyReaderDeps(),
    upstream: `https://${TOGETHER_DEFAULT_HOST}`, print: (line) => { process.stdout.write(`${line}\n`); } })
    .catch(() => {
      process.stdout.write(`${refusal("probe_failed")}\n`);
      return 2;
    });
}
