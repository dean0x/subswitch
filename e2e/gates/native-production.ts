/** Live acceptance of the production gateway with native subscription auth and real model discovery. */
import http from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../../src/config.js";
import { buildDeps, createProxyServer, listenServer } from "../../src/server.js";
import { probeHeaders } from "./credentials.js";
import { nativeProcess, isolatedNativeEnv } from "./native-process.js";
import { object } from "./probe.js";
import { createRawHttpForwarder, type RawHttpForwarder } from "../../src/raw-http-passthrough.js";
import { decodeBody } from "../../src/content-encoding.js";
import { describeNativeHistory } from "./native-history-observer.js";

export async function runNativeProduction(model = "sonnet", followup = true, httpOnly = false, parentModel = "gpt-6-astra", observeHistory = false) {
  const claude = await probeHeaders({ provider: "claude", auth: "subscription" });
  const openai = await probeHeaders({ provider: "openai", auth: "subscription" });
  const temp = await mkdtemp(join(tmpdir(), "subswitch-production-native-"));
  const work = join(temp, "work"), codexDir = join(temp, "codex");
  const marker = `production-${randomUUID()}`, nextMarker = `followup-${randomUUID()}`;
  const counts = { claudeResponses: 0, openaiResponses: 0, toolCalls: 0, toolResults: 0, modelRequests: 0, cachedPromptObserved: false, errors: [] as string[],
    nativeCredentialMatches: false, nativeAccountHeaderMatches: false, upgradeRequests: 0 };
  let server: http.Server | undefined;
  const historyObservations: { request: number; target: "claude" | "parent" | "other"; items: ReturnType<typeof describeNativeHistory> }[] = [];
  const observers = new Set<Promise<void>>();
  let observedRequests = 0;
  let observationBytes = 0;
  let historyObservationTruncated = false;
  let relay: http.Server | undefined, forward: RawHttpForwarder | undefined;
  try {
    await mkdir(work, { mode: 0o700 }); await mkdir(codexDir, { mode: 0o700 });
    await writeFile(join(work, "check.txt"), marker, { mode: 0o600 });
    await writeFile(join(work, "followup.txt"), nextMarker, { mode: 0o600 });
    const authFile = join(temp, "claude.json");
    await writeFile(authFile, JSON.stringify({ claudeAiOauth: { accessToken: claude["authorization"]!.slice(7), expiresAt: Date.now() + 3600000 } }), { mode: 0o600 });
    const realAuth = object(JSON.parse(await readFile(join(process.env["CODEX_HOME"] ?? join(homedir(), ".codex"), "auth.json"), "utf8")));
    const tokens = object(realAuth?.["tokens"]); if (!tokens) throw new Error("auth_unavailable");
    const codexAuthFile = join(codexDir, "auth.json");
    await writeFile(codexAuthFile, JSON.stringify({ auth_mode: "chatgpt", tokens: { ...tokens, refresh_token: "" },
      ...(typeof realAuth?.["last_refresh"] === "string" ? { last_refresh: realAuth["last_refresh"] } : {}) }), { mode: 0o600 });
    let subscriptionBaseUrl: string | undefined;
    if (httpOnly) {
      forward = createRawHttpForwarder({ baseUrl: "https://chatgpt.com/backend-api/codex", connectTimeoutMs: 10000, maxUpstreamSockets: 8,
        logger: { log() {} }, errorBody: () => '{"error":{"message":"HTTP control failed"}}', logPath: () => "/control",
        events: { timeout: "openai_upstream_timeout", error: "openai_upstream_error" } });
      relay = http.createServer((req, res) => forward!(req, res));
      relay.on("upgrade", (_req, socket) => socket.end("HTTP/1.1 426 Upgrade Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"));
      if (!(await listenServer(relay, 0, "127.0.0.1")).ok) throw new Error("http_control_failed");
      const address = relay.address(); if (!address || typeof address === "string") throw new Error("http_control_failed");
      subscriptionBaseUrl = `http://127.0.0.1:${address.port}`;
    }
    const config = loadConfig({ configPath: join(temp, "inline.json"), env: {}, readFile: () => JSON.stringify({
      codexIngress: { enabled: true, ...(subscriptionBaseUrl ? { subscriptionBaseUrl } : {}), claude: { enabled: true, authFile } },
      providers: { codex: { authFile: codexAuthFile, oauthTokenUrl: "http://127.0.0.1:9/disabled-refresh" } },
    }) });
    if (!config.ok) throw new Error("config_failed");
    const deps = buildDeps(config.value.config, { log(_level, event, fields) {
      if (event === "claude_request_complete") counts.claudeResponses++;
      if (event === "claude_request_complete" && (fields?.cachedTokens ?? 0) > 0) counts.cachedPromptObserved = true;
      if (event === "codex_response_complete") counts.openaiResponses++;
      if (event === "claude_tool_call") counts.toolCalls++;
      if (event === "claude_tool_result") counts.toolResults++;
      if (["claude_upstream_error", "claude_request_failed"].includes(event)) counts.errors.push(fields?.errorCode ?? event);
      if (event === "openai_websocket_rejected" && !(httpOnly && fields?.status === 426)) counts.errors.push(`openai_websocket_${fields?.status}`);
    } });
    if (!deps.ok) throw new Error("deps_failed");
    server = createProxyServer(deps.value);
    server.prependListener("request", req => {
      if (req.url?.includes("/models")) counts.modelRequests++;
      if (!observeHistory || !req.url?.endsWith("/responses")) return;
      if (observedRequests >= 32) { historyObservationTruncated = true; return; }
      const request = observedRequests++;
      const parts: Buffer[] = []; let bytes = 0;
      // A data observer must not start flow before the gateway attaches its body reader.
      req.pause();
      req.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes <= 4 * 1024 * 1024) parts.push(chunk); });
      req.on("end", () => {
        if (bytes > 4 * 1024 * 1024) { historyObservationTruncated = true; return; }
        const observation = (async () => {
          try {
            const body = object(JSON.parse((await decodeBody(Buffer.concat(parts), req.headers["content-encoding"], 4 * 1024 * 1024)).toString("utf8")));
            if (!body) return;
            const target: "claude" | "parent" | "other" = body["model"] === model ? "claude" : body["model"] === parentModel ? "parent" : "other";
            const observation = { request, target, items: describeNativeHistory(body) };
            const size = Buffer.byteLength(JSON.stringify(observation));
            if (Array.isArray(body["input"]) && body["input"].length > 512) historyObservationTruncated = true;
            if (observationBytes + size > 65536) { historyObservationTruncated = true; return; }
            observationBytes += size;
            historyObservations.push(observation);
          } catch { /* No content or error text is emitted by this structural observer. */ }
        })();
        observers.add(observation);
        void observation.finally(() => observers.delete(observation));
      });
    });
    server.prependListener("upgrade", req => {
      counts.upgradeRequests++;
      counts.nativeCredentialMatches = req.headers.authorization === openai["authorization"];
      counts.nativeAccountHeaderMatches = req.headers["chatgpt-account-id"] === openai["chatgpt-account-id"];
    });
    if (!(await listenServer(server, 0, "127.0.0.1")).ok) throw new Error("listen_failed");
    const address = server.address(); if (!address || typeof address === "string") throw new Error("listen_failed");
    const base = `http://127.0.0.1:${address.port}/codex/backend-api/codex`;
    const env = isolatedNativeEnv({ CODEX_HOME: codexDir });
    const version = await nativeProcess("codex", ["--version"], { cwd: work, env, timeoutMs: 10000 });
    const clientVersion = version.stdout.match(/codex-cli (\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?)/)?.[1];
    if (version.code !== 0 || !clientVersion) throw new Error("version_unavailable");
    const catalogResponse = await fetch(`${base}/models?client_version=${clientVersion}`, {
      headers: { ...openai, accept: "application/json" }, signal: AbortSignal.timeout(30000),
    });
    if (!catalogResponse.ok) return { success: false, stage: "discovery", status: catalogResponse.status, ...counts };
    const catalog = object(await catalogResponse.json());
    if (!Array.isArray(catalog?.["models"]) || !catalog["models"].some(value => object(value)?.["slug"] === model)) throw new Error("model_not_discovered");
    const parentVersion = object(catalog["models"].find(value => object(value)?.["slug"] === parentModel))?.["multi_agent_version"];
    // Leave the native cache absent: the client must discover Claude models through the proxy itself.
    await writeFile(join(codexDir, "worker.toml"), `model = ${JSON.stringify(model)}\ndeveloper_instructions = "Read the requested file using native tools, then return its exact content."\n`, { mode: 0o600 });
    await writeFile(join(codexDir, "config.toml"), [
      `model = ${JSON.stringify(parentModel)}`, `openai_base_url = ${JSON.stringify(base)}`, 'approval_policy = "never"', 'sandbox_mode = "read-only"',
      '[agents.claude_worker]', 'description = "Read the isolated fixture with Claude"', 'config_file = "worker.toml"',
    ].join("\n"), { mode: 0o600 });
    const spawning = parentVersion === "v1" ? `Spawn exactly one native child using the configured claude_worker agent role (model ${model}).` :
      `Spawn exactly one native child with task_name claude_worker, model ${model}, fork_turns none.`;
    const following = parentVersion === "v2" ?
      "Call collaboration.followup_task on that same claude_worker to read followup.txt with the native tool. Call collaboration.wait_agent until its completed second reply arrives. Return both exact values after receiving that reply." :
      "Send a follow-up to that same child asking it to read followup.txt using the tool, wait for its completed reply, and return both exact values.";
    const result = await nativeProcess("codex", ["exec", "--ephemeral", "--ignore-rules", "--skip-git-repo-check", "--json",
      `${spawning} Ask it to read check.txt with the native tools and return the exact content. Wait for its completed reply. ${followup ? following : "Return the exact value it reported."} Do not read the files yourself.`],
    { cwd: work, env, timeoutMs: 120000 });
    await Promise.all(observers);
    return { schemaVersion: 1, productionGateway: true, nativeAuthentication: "subscription", realDiscovery: true, model, followup, httpOnly,
      parentModel, clientVersion, parentVersion: typeof parentVersion === "string" ? parentVersion : "default",
      firstValueReturned: result.stdout.includes(marker), followupValueReturned: result.stdout.includes(nextMarker),
      nativeDiagnostics: ["websocket", "schema", "unauthorized", "forbidden", "not found", "unknown variant", "not available", "missing field"]
        .filter(value => (result.stderr + result.stdout).toLowerCase().includes(value)),
      success: result.code === 0 && !result.failure && result.stdout.includes(marker) && (!followup || result.stdout.includes(nextMarker)) &&
        counts.modelRequests >= 2 && counts.claudeResponses >= (followup ? 4 : 2) && counts.openaiResponses >= 2 && counts.toolCalls >= (followup ? 2 : 1) && counts.toolResults >= (followup ? 2 : 1) && !counts.errors.length,
      nativeExit: result.failure ?? `exit_${result.code}`, ...counts,
      ...(observeHistory ? { historyObservations: historyObservations.sort((a, b) => a.request - b.request), historyObservationTruncated } : {}) };
  } finally {
    server?.closeAllConnections(); await new Promise<void>(resolve => { if (server) server.close(() => resolve()); else resolve(); });
    forward?.close(); relay?.closeAllConnections(); await new Promise<void>(resolve => { if (relay) relay.close(() => resolve()); else resolve(); });
    await rm(temp, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { const parentFlag = process.argv.indexOf("--parent");
    const report = await runNativeProduction(process.argv[2] ?? "sonnet", !process.argv.includes("--no-followup"), process.argv.includes("--http"), parentFlag < 0 ? undefined : process.argv[parentFlag + 1], process.argv.includes("--observe-history")); console.log(JSON.stringify(report)); process.exitCode = report.success ? 0 : 1; }
  catch { console.log(JSON.stringify({ success: false, code: "production_native_unavailable" })); process.exitCode = 2; }
}
