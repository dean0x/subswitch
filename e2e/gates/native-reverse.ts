/** Source-only reverse experiment. Native clients/configuration are isolated; no production activation. */
import http from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync, brotliDecompressSync, inflateSync, zstdDecompressSync } from "node:zlib";
import { WebSocketServer } from "ws";
import { loadConfig } from "../../src/config.js";
import { buildDeps, createProxyServer, listenServer } from "../../src/server.js";
import { createSseParser } from "../../src/codex-response.js";
import { nativeProcess, isolatedNativeEnv, nativeGateFailureReport, runWithObservedTeardown, closeWithCompletion,
  type NativeCleanupError, type NativeDiagnosticSink } from "./native-process.js";
import { withNativeClaudeCapture } from "./claude-system-control.js";
import { probeHeaders } from "./credentials.js";
import { namespaceRequest, namespaceEvent } from "./namespace-adapter.js";
import { object } from "./probe.js";
import { reverseRequest, reverseResponse, reverseEvents, ReverseContractError, type Item } from "./reverse-adapter.js";
import { ReverseState } from "./reverse-state.js";

class ExperimentError extends Error { constructor(readonly code: string) { super(code); } }

const PARENT = "gpt-6-astra", CHILD = "claude-sonnet-5", MAX_BYTES = 4 * 1024 * 1024;
const TASK = "Read check.txt using the native code tool functions.exec and tools.exec_command. Return the file's exact content. You must execute the tool before answering.";
const textOutput = (text: string): Item => ({ type: "message", id: `msg_${randomUUID()}`, role: "assistant", phase: "final_answer", status: "completed",
  content: [{ type: "output_text", text, annotations: [] }] });
const functionOutput = (name: string, args: Item): Item => ({ type: "function_call", id: `fc_${randomUUID()}`, call_id: `call_${randomUUID()}`,
  namespace: "collaboration", name, arguments: JSON.stringify(args), encrypted_function_args: [], status: "completed" });

export async function runNativeReverse(options: { liveParent?: boolean; http?: boolean; followup?: boolean;
  nativeSubscription?: boolean; onDiagnostic?: NativeDiagnosticSink } = {}) {
  return withNativeClaudeCapture(async (capture, claudeHeaders, scope) => {
    const nativePreamble = (capture.body["system"] as unknown[]).map(object).filter((block): block is Item =>
      !!block && typeof block["text"] === "string" && /^(You are Claude Code,|You are a Claude agent,)/.test(block["text"]));
    if (nativePreamble.length !== 1) throw new Error("missing_native_preamble");
    const parentHeaders = options.liveParent ? await probeHeaders({ provider: "openai", auth: "subscription" }) : undefined;
    const temp = await mkdtemp(join(tmpdir(), "subswitch-native-reverse-"));
    const work = join(temp, "work"), codexDir = join(temp, "codex");
    const marker = `reverse-read-${randomUUID()}`;
    const followupMarker = `reverse-followup-${randomUUID()}`;
    const followupTask = TASK.replace("check.txt", "followup.txt");
    const stats = { parentRequests: 0, childRequests: 0, warmups: 0, websocketConnections: 0, httpRequests: 0,
      toolRequested: false, nativeToolResult: false, childAnswered: false, parentReceived: false,
      followupToolResult: false, followupAnswered: false, followupReceived: false,
      upstreamStatuses: [] as { provider: string; status: number }[], errors: [] as string[], nativeExit: "not_started",
      nativeCleanupError: null as NativeCleanupError | null };
    const abort = new AbortController();
    const history = new Map<string, { input: Item[]; model: string; tools?: unknown }>();
    const state = new ReverseState();
    let spawned = false;
    let followedUp = false;
    const fetchBody = async (provider: string, url: string, headers: Record<string, string>, body: Item): Promise<Buffer> => {
      const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), redirect: "error",
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30000)]) });
      stats.upstreamStatuses.push({ provider, status: response.status });
      const reader = response.body?.getReader();
      if (!reader) throw new ExperimentError("missing_upstream_body");
      const chunks: Buffer[] = []; let bytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          bytes += value.byteLength; if (bytes > MAX_BYTES) throw new ExperimentError("upstream_body_limit"); chunks.push(Buffer.from(value));
        }
      } finally { await reader.cancel(); }
      if (!response.ok) {
        let detail = "";
        try {
          const message = object(object(JSON.parse(Buffer.concat(chunks).toString("utf8")))?.["error"])?.["message"];
          if (typeof message === "string") detail = ["thinking", "signature", "tool_use", "tool_result", "system", "extra usage", "max_tokens", "beta"]
            .filter(word => message.toLowerCase().includes(word)).map(word => word.replace(" ", "_")).join("_");
        } catch { /* Closed diagnostic categories only. */ }
        throw new ExperimentError(`${provider}_http_${response.status}${detail ? `_${detail}` : ""}`);
      }
      return Buffer.concat(chunks);
    };
    const exchange = async (body: Item): Promise<Item[]> => {
      if (stats.parentRequests + stats.childRequests + stats.warmups >= 24) throw new ExperimentError("experiment_request_limit");
      const previous = typeof body["previous_response_id"] === "string" ? history.get(body["previous_response_id"]) : undefined;
      if (body["previous_response_id"] !== undefined && !previous) throw new ExperimentError("missing_continuation_state");
      const model = typeof body["model"] === "string" ? body["model"] : previous?.model;
      if (model !== CHILD && model !== PARENT) throw new ExperimentError("unexpected_model");
      const input = [...previous?.input ?? [], ...(Array.isArray(body["input"]) ? body["input"] as Item[] : [])];
      const tools = body["tools"] ?? previous?.tools;
      let id = `resp_reverse_${randomUUID()}`;
      let output: Item[];
      let frames: Item[];
      if (body["generate"] === false) {
        stats.warmups++; output = []; frames = reverseEvents(id, model, []);
      } else if (model === CHILD) {
        stats.childRequests++;
        stats.nativeToolResult ||= input.some(entry => ["function_call_output", "custom_tool_call_output"].includes(String(entry["type"])) && JSON.stringify(entry["output"]).includes(marker));
        stats.followupToolResult ||= input.some(entry => ["function_call_output", "custom_tool_call_output"].includes(String(entry["type"])) && JSON.stringify(entry["output"]).includes(followupMarker));
        const full = { ...body, model, input, ...(tools === undefined ? {} : { tools }) };
        const request = reverseRequest(full, nativePreamble, state);
        const raw = await fetchBody("claude", "https://api.anthropic.com/v1/messages", {
          ...claudeHeaders, "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
        }, request.body);
        const response = object(JSON.parse(raw.toString("utf8")));
        if (!response) throw new ExperimentError("invalid_claude_response");
        output = reverseResponse(response, request, state);
        stats.toolRequested ||= output.some(entry => ["function_call", "custom_tool_call"].includes(String(entry["type"])) && entry["namespace"] === "functions");
        stats.childAnswered ||= output.some(entry => entry["type"] === "message" && JSON.stringify(entry["content"]).includes(marker));
        stats.followupAnswered ||= output.some(entry => entry["type"] === "message" && JSON.stringify(entry["content"]).includes(followupMarker));
        frames = reverseEvents(id, model, output, object(response["usage"]) ?? {});
      } else {
        stats.parentRequests++;
        stats.parentReceived ||= input.some(entry => entry["type"] === "agent_message" && JSON.stringify(entry["content"]).includes(marker));
        stats.followupReceived ||= input.some(entry => entry["type"] === "agent_message" && JSON.stringify(entry["content"]).includes(followupMarker));
        if (parentHeaders) {
          const request = namespaceRequest({ ...body, model, input, ...(tools === undefined ? {} : { tools }), store: false, stream: true });
          delete request["previous_response_id"]; delete request["type"]; delete request["stream_id"];
          const raw = await fetchBody("openai", "https://chatgpt.com/backend-api/codex/responses", parentHeaders, request);
          const parser = createSseParser(MAX_BYTES); parser.end(raw);
          frames = []; output = []; let completed = false;
          for await (const event of parser) {
            if (!event.data || event.data === "[DONE]") continue;
            const frame = namespaceEvent(JSON.parse(event.data));
            if (["error", "response.failed", "response.incomplete"].includes(String(frame["type"]))) throw new ExperimentError("openai_terminal_failure");
            frames.push(frame);
            if (frame["type"] === "response.output_item.done") output.push(object(frame["item"]) ?? {});
            if (frame["type"] === "response.completed") {
              const response = object(frame["response"]);
              if (response?.["status"] !== "completed" || typeof response["id"] !== "string") throw new ExperimentError("invalid_openai_terminal");
              id = response["id"]; completed = true;
              if (!output.length && Array.isArray(response["output"])) output = response["output"] as Item[];
            }
          }
          if (!completed) throw new ExperimentError("missing_openai_terminal");
        } else {
          if (stats.errors.length) output = [textOutput("The reverse experiment failed.")];
          else if (!spawned) { spawned = true; output = [functionOutput("spawn_agent", { task_name: "sonnet", model: CHILD, fork_turns: "none", message: TASK })]; }
          else if (stats.parentReceived && options.followup && !followedUp) {
            followedUp = true; output = [functionOutput("followup_task", { target: "sonnet", message: followupTask })];
          } else if (stats.parentReceived && (!options.followup || stats.followupReceived)) output = [textOutput(options.followup ? `${marker}\n${followupMarker}` : marker)];
          else output = [functionOutput("wait_agent", { timeout_ms: 10000 })];
          frames = reverseEvents(id, model, output);
        }
      }
      history.set(id, { model, input: [...input, ...output], ...(tools === undefined ? {} : { tools }) });
      return frames;
    };
    const errorFrame = (error: unknown) => {
      const code = (error instanceof ExperimentError || error instanceof ReverseContractError) ? error.code : "experiment_error";
      stats.errors.push(code);
      process.stderr.write(JSON.stringify({ stage: "reverse_contract", code }) + "\n");
      return { type: "error", code, message: "The isolated reverse contract failed." };
    };
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BYTES });
    let models: Item[] = [];
    const upstream = http.createServer(async (req, res) => {
      try {
        if (req.url?.includes("/models")) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ models })); return; }
        if (req.method !== "POST" || !req.url?.includes("/responses")) { res.writeHead(404); res.end(); return; }
        const chunks: Buffer[] = []; let bytes = 0;
        for await (const chunk of req) { bytes += chunk.length; if (bytes > MAX_BYTES) throw new ExperimentError("incoming_body_limit"); chunks.push(chunk); }
        let raw: Buffer = Buffer.concat(chunks);
        const decoders: Record<string, (body: Buffer, options: { maxOutputLength: number }) => Buffer> = {
          gzip: gunzipSync, br: brotliDecompressSync, deflate: inflateSync, zstd: zstdDecompressSync,
        };
        const encoding = req.headers["content-encoding"];
        if (typeof encoding === "string" && encoding !== "identity") {
          const decode = decoders[encoding]; if (!decode) throw new ExperimentError("unsupported_encoding");
          raw = decode(raw, { maxOutputLength: MAX_BYTES });
        }
        stats.httpRequests++;
        const frames = await exchange(JSON.parse(raw.toString("utf8")));
        res.setHeader("content-type", "text/event-stream"); res.end(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(""));
      } catch (error) { res.writeHead(502, { "content-type": "text/event-stream" }); res.end(`data: ${JSON.stringify(errorFrame(error))}\n\n`); }
    });
    upstream.on("upgrade", (req, socket, head) => {
      if (options.http) { socket.end("HTTP/1.1 426 Upgrade Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"); return; }
      wss.handleUpgrade(req, socket, head, ws => {
        stats.websocketConnections++; ws.on("error", () => undefined);
        let queue = Promise.resolve();
        ws.on("message", data => {
          queue = queue.then(async () => {
            try {
              const body = JSON.parse(data.toString());
              for (const frame of await exchange(body)) if (ws.readyState === 1)
                ws.send(JSON.stringify({ ...frame, ...(typeof body.stream_id === "string" ? { stream_id: body.stream_id } : {}) }));
            } catch (error) { if (ws.readyState === 1) ws.send(JSON.stringify(errorFrame(error))); }
          });
        });
      });
    });
    let proxy: http.Server | undefined;
    return runWithObservedTeardown(async () => {
      try {
        await mkdir(work, { mode: 0o700 }); await mkdir(codexDir, { mode: 0o700 });
        await writeFile(join(work, "check.txt"), marker, { mode: 0o600 });
        if (options.followup) await writeFile(join(work, "followup.txt"), followupMarker, { mode: 0o600 });
        const env = isolatedNativeEnv({ CODEX_HOME: codexDir, ...(options.nativeSubscription ? {} : { OPENAI_API_KEY: "fabricated-local-client-key" }) });
        const version = await nativeProcess("codex", ["--version"], { cwd: work, env, timeoutMs: 10000,
          onDiagnostic: scope.bindNative("reverse_version") });
        stats.nativeCleanupError = version.cleanupError ?? null;
        if (version.failure) {
          stats.nativeExit = version.failure;
          scope.markFailure(version.failure, version.cleanupError);
          return { schemaVersion: 1, success: false, liveParent: !!options.liveParent, ...stats };
        }
        const clientVersion = version.stdout.match(/codex-cli (\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?)/)?.[1];
        if (version.code !== 0 || !clientVersion) throw new ExperimentError("codex_version_unavailable");
        const fixture = JSON.parse(await readFile(new URL("../../test/fixtures/native/codex-0.153.3-model.json", import.meta.url), "utf8"));
        models = [PARENT, CHILD].map(slug => ({ ...fixture, slug, display_name: slug, multi_agent_version: "v2",
          model_messages: null, base_instructions: "You are an agent running inside native Codex. Follow the supplied tool definitions and user task.", supported_in_api: true }));
        if (!(await listenServer(upstream, 0, "127.0.0.1")).ok) throw new ExperimentError("listen_failed");
        const address = upstream.address(); if (!address || typeof address === "string") throw new ExperimentError("listen_failed");
        const base = `http://127.0.0.1:${address.port}`;
        const config = loadConfig({ env: {}, configPath: join(temp, "inline.json"), readFile: () => JSON.stringify({
          anthropic: { baseUrl: base }, providers: { codex: { authFile: join(temp, "unused-auth.json") } },
          codexIngress: { enabled: true, subscriptionBaseUrl: `${base}/backend-api/codex`, apiBaseUrl: `${base}/v1` },
        }) });
        if (!config.ok) throw new ExperimentError("config_failed");
        const deps = buildDeps(config.value.config, { log: () => undefined });
        if (!deps.ok) throw new ExperimentError("proxy_failed");
        proxy = createProxyServer(deps.value);
        if (!(await listenServer(proxy, 0, "127.0.0.1")).ok) throw new ExperimentError("proxy_listen_failed");
        const proxyAddress = proxy.address(); if (!proxyAddress || typeof proxyAddress === "string") throw new ExperimentError("proxy_listen_failed");
        let localAuth: Item = { OPENAI_API_KEY: "fabricated-local-client-key" };
        if (options.nativeSubscription) {
          // A restricted, temporary access-only copy. The live shared refresh token is never copied.
          const source = object(JSON.parse(await readFile(join(process.env["CODEX_HOME"] ?? join(homedir(), ".codex"), "auth.json"), "utf8")));
          const tokens = object(source?.["tokens"]);
          if (!tokens || typeof tokens["access_token"] !== "string") throw new ExperimentError("native_subscription_missing");
          localAuth = { auth_mode: "chatgpt", tokens: { ...tokens, refresh_token: "" } };
        }
        await writeFile(join(codexDir, "auth.json"), JSON.stringify(localAuth), { mode: 0o600 });
        await writeFile(join(codexDir, "models_cache.json"), JSON.stringify({ fetched_at: new Date().toISOString(), etag: "reverse-fixture", client_version: clientVersion, models }), { mode: 0o600 });
        await writeFile(join(codexDir, "sonnet.toml"), `model = "${CHILD}"\ndeveloper_instructions = "${TASK}"\n`, { mode: 0o600 });
        await writeFile(join(codexDir, "config.toml"), [
          `model = "${PARENT}"`, `openai_base_url = "http://127.0.0.1:${proxyAddress.port}/codex/${options.nativeSubscription ? "backend-api/codex" : "v1"}"`,
          'approval_policy = "never"', 'sandbox_mode = "read-only"', '[agents.sonnet]',
          'description = "Read the isolated file using Claude"', 'config_file = "sonnet.toml"',
        ].join("\n"), { mode: 0o600 });
        const native = await nativeProcess("codex", ["exec", "--skip-git-repo-check", "--ephemeral", "--ignore-rules", "--json",
          `Spawn exactly one sonnet child with model ${CHILD}, task_name sonnet, fork_turns none. Ask it: ${TASK} Wait for its result. ${options.followup ? `Then send followup_task to the same child asking: ${followupTask} Wait for its second result and return both exact values.` : "Return the exact value it read."} Do not read the files yourself.`],
        { cwd: work, env, timeoutMs: 90000, onDiagnostic: scope.bindNative("reverse_native") });
        stats.nativeExit = native.failure ?? `exit_${native.code}`;
        stats.nativeCleanupError = native.cleanupError ?? null;
        const success = native.code === 0 && !native.failure &&
          stats.toolRequested && stats.nativeToolResult && stats.childAnswered && stats.parentReceived && native.stdout.includes(marker) && !stats.errors.length &&
          (!options.followup || (stats.followupToolResult && stats.followupAnswered && stats.followupReceived && native.stdout.includes(followupMarker)));
        if (!success) scope.markFailure(native.failure ?? "gate_error", native.cleanupError);
        return { schemaVersion: 1, liveParent: !!options.liveParent, nativePreambleUsed: true, clientVersion,
          nativeAuthentication: options.nativeSubscription ? "subscription" : "fabricated_local_api",
          nativeDiagnostics: ["error decoding", "missing field", "failed to parse", "unsupported call", "stream disconnected", "invalid response"]
            .filter(word => native.stderr.toLowerCase().includes(word)),
          transport: options.http ? "http" : "websocket", followup: !!options.followup, success, ...stats };
      } catch (error) {
        scope.recordFailure(error);
        errorFrame(error); return { schemaVersion: 1, success: false, liveParent: !!options.liveParent,
          ...stats, ...scope.failureReport() };
      }
    }, () => [
      { step: "transport_stop", run: () => { abort.abort(); } },
      ...Array.from(wss.clients, ws => ({ step: "transport_stop" as const, run: () => { ws.terminate(); } })),
      { step: "transport_stop", run: () => closeWithCompletion(done => wss.close(done)) },
      { step: "transport_stop", run: () => { proxy?.closeAllConnections(); } },
      { step: "proxy_close", run: () => {
        const server = proxy;
        return server ? closeWithCompletion(done => server.close(done), "node_server") : undefined;
      } },
      { step: "transport_stop", run: () => { upstream.closeAllConnections(); } },
      { step: "upstream_close", run: () => closeWithCompletion(done => upstream.close(done), "node_server") },
      { step: "transport_stop", run: () => { history.clear(); } },
      { step: "temp_remove", run: () => rm(temp, { recursive: true, force: true }) },
    ], scope, "reverse_teardown");
  }, options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { const report = await runNativeReverse({ liveParent: process.argv.includes("--live-parent"), http: process.argv.includes("--http"), followup: process.argv.includes("--followup"), nativeSubscription: process.argv.includes("--native-subscription"),
    onDiagnostic: diagnostic => { process.stderr.write(JSON.stringify(diagnostic) + "\n"); } });
    console.log(JSON.stringify(report)); process.exitCode = report.success ? 0 : 1;
  } catch (error) { console.log(JSON.stringify({ schemaVersion: 1, success: false, code: "native_reverse_unavailable",
    ...nativeGateFailureReport(error) })); process.exitCode = 2; }
}
