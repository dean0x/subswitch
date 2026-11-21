/**
 * npm run probe:gemini -- --dry-run --evidence-root <absolute folder>
 * npm run probe:gemini -- --live --evidence-root <absolute folder>
 *
 * The live command refuses until D4. The dry run starts run-action with a fake client.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { DEFAULT_PORT, loadConfig } from "../../src/config.js";
import { isPlainObject } from "../../src/plain-object.js";
import type { ProviderHandler } from "../../src/provider-handler.js";
import { readBoundedBody, respondJson } from "../../src/provider-transport.js";
import { ok } from "../../src/result.js";
import { actionControlPath, publishActionControl } from "../../src/routing/action-control.js";
import { buildDeps, createProxyServer, listenServer, type ProviderDepsById } from "../../src/server.js";
import { noopLogger } from "../../src/logger.js";
import { BOOTSTRAP_URL, CAPS, CountsSchema, GENERATE_URL, PROBE_BYTES, PROBE_MS, REQUEST_MS, SESSION_MS,
  cappedFetch, createLedger, type RequestBudget } from "./gemini-live-caps.js";
import { actionsDirectory, askLine, confirmLive, dryConfigEnv, freePort, parseArguments, prepareClientFolder,
  privateFolder, type GateIO, type LiveArguments } from "./live-check-common.js";
import { closeWithCompletion, nativeProcess } from "./native-process.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TSX = import.meta.resolve("tsx");
const LIVE_REFUSAL = "D4_values_required";
export const LIVE_PHRASE = `start the Gemini live check: ${CAPS.probe.load} loadCodeAssist, 0 onboardUser, ` +
  `${CAPS.probe.generate} probe calls, ${CAPS.probe.output} probe output tokens, no probe tools, 30 s, 1 MiB; ` +
  `${CAPS.session.generate} Claude Code calls, ${CAPS.session.output} output tokens, ${CAPS.session.thinking} thinking tokens, ` +
  `60 s per request, 5 min total, ${CAPS.cancel} cancel run, 0 agy runs`;
export const liveGate = (io: GateIO) => confirmLive(LIVE_PHRASE, io);

interface MainIO extends GateIO {
  out(line: string): void;
  dryRun(args: LiveArguments): Promise<boolean>;
}

export async function main(args: readonly string[], io: MainIO): Promise<number> {
  const parsed = parseArguments(args);
  const refuse = (code: string): number => { io.out(JSON.stringify({ success: false, code })); return 2; };
  if (parsed === undefined) return refuse("invalid_input");
  if (parsed.mode === "live") {
    const gate = await liveGate(io);
    // No live site or transport exists while the model, UA and project extractor are unqualified.
    return refuse(gate.ok ? LIVE_REFUSAL : gate.error);
  }
  return (await io.dryRun(parsed)) ? 0 : 1;
}

const EvidenceSchema = z.strictObject({
  schemaVersion: z.literal(1), mode: z.literal("dry-run"), success: z.boolean(),
  code: z.enum(["broken_cap", "cost_cap", "setup_failed", "probe_failed", "attach_failed", "cancel_failed", "cleanup_failed",
    "interrupted"]).nullable(),
  counts: CountsSchema, probeStatus: z.enum(["2xx", "3xx", "4xx", "5xx", "none"]),
  actionRequests: z.number().int().min(0).max(CAPS.session.generate),
  controlPublished: z.boolean(), controlRemoved: z.boolean(), cancelled: z.boolean(),
});
type Evidence = z.infer<typeof EvidenceSchema>;
export const checkEvidence = (value: unknown): boolean => EvidenceSchema.safeParse(value).success;

const SYNTHETIC_ALIAS = "test-data-gemini";
const SYNTHETIC_MODEL = `gemini:${SYNTHETIC_ALIAS}`;
const PROJECT = "test-data-project";
const TEST_REPLY = "test-data-reply";
const CANCEL_TEXT = "test-data-cancel";

/** Test data only. No verified Google wire fields or Keychain I/O. */
const fakeUpstream = () => {
  const access = `test-data-access-${randomUUID()}`;
  const record = { token: { access_token: access, refresh_token: `test-data-refresh-${randomUUID()}`, expiry: "2099-01-01T00:00:00Z" } };
  const reader: ProviderDepsById["gemini"]["reader"] = {
    probe: async () => ok({ modifiedAtMs: 0 }),
    readSecret: async () => ok(`go-keyring-base64:${Buffer.from(JSON.stringify(record)).toString("base64")}`),
  };
  let cancelled = false;
  const transport: typeof fetch = async (input, init) => {
    if (new Headers(init?.headers).get("authorization") !== `Bearer ${access}`) return new Response(null, { status: 401 });
    if (input === BOOTSTRAP_URL) return Response.json({ fixtureProject: PROJECT });
    if (input !== GENERATE_URL || typeof init?.body !== "string") return new Response(null, { status: 404 });
    const body: unknown = JSON.parse(init.body);
    if (!isPlainObject(body) || body["project"] !== PROJECT) return new Response(null, { status: 400 });
    const frame = (finish: boolean) => `data: ${JSON.stringify({ response: { candidates: [{
      content: { parts: [{ text: TEST_REPLY }] }, ...(finish ? { finishReason: "STOP" } : {}),
    }] } })}\n\n`;
    const headers = { "content-type": "text/event-stream" };
    if (!init.body.includes(CANCEL_TEXT)) return new Response(frame(true), { headers });
    let clean = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(frame(false)));
        const signal = init.signal;
        const timer = setTimeout(() => { clean(); controller.close(); }, 10_000);
        const abort = () => { cancelled = true; clean(); controller.close(); };
        clean = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      },
      cancel() { cancelled = true; clean(); },
    });
    return new Response(stream, { headers });
  };
  const extractProjectId = (value: unknown): string | undefined =>
    isPlainObject(value) && value["fixtureProject"] === PROJECT ? PROJECT : undefined;
  return { reader, transport, extractProjectId, get cancelled() { return cancelled; } };
};

async function openDrySite(scratch: string) {
  const home = join(scratch, "home"), temp = join(scratch, "tmp");
  await mkdir(home, { mode: 0o700 });
  await mkdir(temp, { mode: 0o700 });
  const env = await dryConfigEnv(scratch, home, temp, await freePort());
  const loaded = loadConfig({ env, homeDir: home, cwd: REPO_ROOT, allowProjectPort: false });
  if (!loaded.ok || loaded.value.configuredProviders.has("gemini") || loaded.value.config.port === DEFAULT_PORT) return undefined;
  return { home, env, port: loaded.value.config.port, fake: fakeUpstream() };
}

type DrySite = NonNullable<Awaited<ReturnType<typeof openDrySite>>>;
const refusingHandler: ProviderHandler = {
  async handleMessages(_req, res) { respondJson(res, 400, "{}"); },
  handleCountTokens(_req, res) { respondJson(res, 400, "{}"); },
};

function openProxy(site: DrySite, ledger: ReturnType<typeof createLedger>) {
  const config = loadConfig({ configPath: join(site.home, "in-process.json"), env: {}, readFile: () => JSON.stringify({
    port: site.port,
    providers: { gemini: { aliases: { [SYNTHETIC_ALIAS]: SYNTHETIC_ALIAS }, requestTimeoutMs: REQUEST_MS, streamIdleTimeoutMs: REQUEST_MS } },
    codexIngress: { enabled: false },
    limits: { maxBufferedBodyBytes: PROBE_BYTES },
  }) });
  if (!config.ok || !config.value.config.providers.gemini.optedIn) return undefined;
  const budget = new AsyncLocalStorage<RequestBudget>();
  const refuseNetwork: typeof fetch = async () => { ledger.refuse("broken_cap"); throw new Error("broken_cap"); };
  const { reader, extractProjectId, transport } = site.fake;
  const deps = buildDeps(config.value.config, noopLogger, {
    fetchImpl: refuseNetwork,
    providerDeps: {
      gemini: { reader, extractProjectId, fetch: cappedFetch(ledger, () => budget.getStore(), transport) },
      together: { env: {}, platform: "linux", exec: async () => { throw new Error("unexpected_reader"); }, setTimer: () => () => {} },
    },
  });
  if (!deps.ok) return undefined;
  deps.value.forwardAnthropic.close?.();
  if (deps.value.sharedRouting === undefined) return undefined;
  const handler = deps.value.providers.gemini;
  let phase: RequestBudget["phase"] = "probe";
  let end = performance.now() + PROBE_MS;
  const gemini: ProviderHandler = {
    ...handler,
    async handleMessages(req, res, raw, parsed, model) {
      const value = isPlainObject(parsed) ? parsed : {};
      const output = value["max_tokens"];
      const thinking = value["thinking"];
      const disabled = isPlainObject(thinking) && thinking["type"] === "disabled";
      const tokens = thinking === undefined || disabled ? 0 : isPlainObject(thinking) && thinking["type"] === "enabled"
        ? thinking["budget_tokens"] : undefined;
      if (typeof output !== "number" || typeof tokens !== "number") {
        ledger.refuse("broken_cap");
        respondJson(res, 400, "{}");
        return;
      }
      await budget.run({ phase, output, thinking: tokens,
        tools: value["tools"] !== undefined || value["tool_choice"] !== undefined,
        deadline: Math.min(end, performance.now() + REQUEST_MS),
      }, () => handler.handleMessages(req, res, raw, parsed, model));
    },
  };
  const proxy = createProxyServer({ ...deps.value, providers: {
    codex: refusingHandler, together: refusingHandler, kimi: refusingHandler, gemini,
  }, forwardAnthropic: (_req, res) => respondJson(res, 400, "{}") });
  return { proxy, capability: deps.value.sharedRouting.actions.capability,
    startSession() { phase = "session"; end = performance.now() + SESSION_MS; } };
}

async function runProbes(port: number, signal: AbortSignal): Promise<Evidence["probeStatus"]> {
  for (const stream of [false, true]) {
    const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST", redirect: "error", signal, headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: SYNTHETIC_MODEL, max_tokens: 16, stream, messages: [{ role: "user", content: "test-data-probe" }] }),
    });
    const status = Math.floor(response.status / 100);
    if (!response.ok) { await response.body?.cancel(); return status === 4 ? "4xx" : status === 5 ? "5xx" : "3xx"; }
    const reply = await readBoundedBody(response.body, PROBE_BYTES, signal);
    if (!reply.complete || !reply.text.includes(TEST_REPLY) || (stream && !reply.text.includes("event: message_stop"))) return "none";
  }
  return "2xx";
}

async function attach(site: DrySite, folder: string, signal: AbortSignal, cancel: boolean): Promise<boolean> {
  const result = await nativeProcess(process.execPath, ["--import", TSX, join(REPO_ROOT, "src/cli.ts"),
    "run-action", "--client", "claude-code", "--", process.execPath, "--import", TSX, join(REPO_ROOT, "e2e/gates/gemini-live-fake-client.ts"),
    String(site.port), SYNTHETIC_MODEL, cancel ? CANCEL_TEXT : "test-data-session", TEST_REPLY],
  { cwd: folder, env: site.env, timeoutMs: REQUEST_MS, signal, maxBytes: PROBE_BYTES });
  return result.failure === undefined && result.code === (cancel ? 42 : 0);
}

async function exercise(scratch: string, stop: AbortSignal, out: MainIO["out"], report: Evidence,
  ledger: ReturnType<typeof createLedger>): Promise<void> {
  let proxy: Server | undefined, unpublish: (() => Promise<void>) | undefined;
  try {
    const site = await openDrySite(scratch);
    if (site === undefined) return;
    const setup = openProxy(site, ledger);
    if (setup === undefined) return;
    proxy = setup.proxy;
    if (!(await listenServer(proxy, site.port, "127.0.0.1")).ok) return;
    report.code = "probe_failed";
    report.probeStatus = await runProbes(site.port, AbortSignal.any([stop, AbortSignal.timeout(PROBE_MS)]));
    if (report.probeStatus !== "2xx" || ledger.failure !== undefined || ledger.used.probe.load !== 1) return;
    report.code = "attach_failed";
    const folder = await prepareClientFolder(scratch, REPO_ROOT);
    if (!folder.ok) return;
    const directory = actionsDirectory(site.home);
    const remove = await publishActionControl(site.port, setup.capability, directory);
    unpublish = async () => {
      await remove();
      report.controlRemoved = await lstat(actionControlPath(site.port, directory)).then(() => false, (error: NodeJS.ErrnoException) => error.code === "ENOENT");
    };
    report.controlPublished = true;
    proxy.prependListener("request", (req, res) => {
      if (req.method !== "POST") return;
      const path = req.url ?? "";
      if (/^\/__subswitch\/action\/[a-f0-9-]{36}\/ingress\/v1\/messages$/.test(path)) report.actionRequests += 1;
      if (/^\/__subswitch\/actions\/[a-f0-9-]{36}\/cancel$/.test(path))
        res.once("finish", () => { report.cancelled = res.statusCode === 200; });
    });
    setup.startSession();
    const session = AbortSignal.any([stop, AbortSignal.timeout(SESSION_MS)]);
    out(`Client folder: ${folder.value}`);
    const reachedGemini = (expected: number) => report.actionRequests === expected && ledger.used.session.generate === expected;
    if (!await attach(site, folder.value, session, false) || !reachedGemini(1)) return;
    report.code = "cancel_failed";
    if (!ledger.reserveCancel().ok || !await attach(site, folder.value, session, true)) return;
    if (!reachedGemini(2) || !report.cancelled || !site.fake.cancelled) return;
    report.code = null;
  } finally {
    if (unpublish !== undefined) await unpublish().catch(() => { report.controlRemoved = false; });
    if (proxy !== undefined) {
      proxy.closeAllConnections();
      await closeWithCompletion((done) => proxy?.close(done), "node_server").catch(() => { report.code = "cleanup_failed"; });
    }
  }
}

export async function runDryCheck(args: LiveArguments, out: MainIO["out"]): Promise<boolean> {
  if (args.mode !== "dry-run") { out(JSON.stringify({ success: false, code: LIVE_REFUSAL })); return false; }
  if (await realpath(process.cwd()).catch(() => undefined) !== await realpath(REPO_ROOT).catch(() => undefined) ||
    !await privateFolder(args.evidenceRoot)) {
    out(JSON.stringify({ success: false, code: "setup_failed" }));
    return false;
  }
  const ledger = createLedger();
  const report: Evidence = { schemaVersion: 1, mode: "dry-run", success: false, code: "setup_failed", counts: ledger.used,
    probeStatus: "none", actionRequests: 0, controlPublished: false, controlRemoved: false, cancelled: false };
  const stop = new AbortController();
  const interrupt = () => stop.abort();
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  let scratch: string | undefined;
  for (const signal of signals) process.on(signal, interrupt);
  try {
    scratch = await mkdtemp(join(await realpath(tmpdir()), "subswitch-gemini-dry-"));
    await exercise(scratch, stop.signal, out, report, ledger);
  } catch { report.code ??= "setup_failed"; }
  finally {
    if (scratch !== undefined) await rm(scratch, { recursive: true, force: true }).catch(() => { report.code = "cleanup_failed"; });
    for (const signal of signals) process.off(signal, interrupt);
  }
  if (report.controlPublished && !report.controlRemoved) report.code = "cleanup_failed";
  if (stop.signal.aborted) report.code ??= "interrupted";
  report.code = ledger.failure ?? report.code;
  report.counts = ledger.used;
  report.success = report.code === null;
  let written = false;
  if (checkEvidence(report)) {
    try {
      const folder = await mkdtemp(join(args.evidenceRoot, "gemini-dry-run-"));
      await writeFile(join(folder, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      written = true;
    } catch { /* Do not echo file paths or errors in the verdict. */ }
  }
  out(JSON.stringify({ success: written && report.success, code: written ? report.code : "evidence_failed" }));
  return written && report.success;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = (line: string) => process.stdout.write(`${line}\n`);
  process.exitCode = await main(process.argv.slice(2), {
    env: process.env, stdinIsTTY: process.stdin.isTTY === true, stdoutIsTTY: process.stdout.isTTY === true,
    ask: askLine, out, dryRun: (args) => runDryCheck(args, out),
  });
}
