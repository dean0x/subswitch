/** Live native-Claude control. Does not implement or certify direct subscription inference. */
import http from "node:http";
import https from "node:https";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config.js";
import { buildDeps, createProxyServer, listenServer } from "../../src/server.js";
import { filterRawHeaders, HOP_BY_HOP, RESPONSE_STRIP, setRawRequestHeaders } from "../../src/raw-http-passthrough.js";
import { probeHeaders } from "./credentials.js";
import { nativeProcess, isolatedNativeEnv } from "./native-process.js";
import { object } from "./probe.js";
import { decodeBody } from "../../src/content-encoding.js";

export async function runNativeClaude(destination: "claude" | "openai" = "claude", synthetic = false, explicitProfiles = false) {
  if (synthetic && destination !== "claude") throw new Error("synthetic_destination_not_supported");
  const headers = synthetic ? { authorization: "Bearer fabricated-native-control" } : await probeHeaders({ provider: "claude", auth: "subscription" });
  const openaiHeaders = destination === "openai" ? await probeHeaders({ provider: "openai", auth: "subscription" }) : undefined;
  const temp = await mkdtemp(join(tmpdir(), "subswitch-claude-contract-"));
  const work = join(temp, "work"), configDir = join(temp, "config");
  const secretTestValue = `native-read-${randomUUID()}`;
  const observations = { messages: 0, sonnetRequests: 0, nativeAgentCall: false,
    nativeReadCall: false, toolResultContinuation: false, upstreamStatuses: [] as number[], translatedRequests: 0,
    compressedRequests: 0, nativeDiagnostic: "none", clientVersion: "unknown", synthetic,
    childRequests: 0, parentRequests: 0, routeErrors: [] as string[] };
  const observe = async (raw: Buffer, encoding: string | string[] | undefined) => {
    try {
      observations.messages++;
      if (encoding && encoding !== "identity") observations.compressedRequests++;
      const body = object(JSON.parse((await decodeBody(raw, encoding, 4 * 1024 * 1024)).toString("utf8")));
      if (typeof body?.["model"] === "string" && body["model"].startsWith("claude-sonnet-")) observations.sonnetRequests++;
      if (Array.isArray(body?.["messages"])) for (const message of body["messages"]) {
        const content = object(message)?.["content"];
        if (!Array.isArray(content)) continue;
        for (const value of content) {
          const block = object(value);
          if (block?.["type"] === "tool_use" && block["name"] === "Agent") observations.nativeAgentCall = true;
          if (block?.["type"] === "tool_use" && block["name"] === "Read") observations.nativeReadCall = true;
          if (block?.["type"] === "tool_result" && JSON.stringify(block["content"]).includes(secretTestValue))
            observations.toolResultContinuation = true;
        }
      }
    } catch { /* In-memory structural observation only; no response changes. */ }
  };
  const outgoing = new Set<http.ClientRequest>();
  let parentCalled = false, childRead = false;
  const syntheticReply = async (raw: Buffer, req: http.IncomingMessage, res: http.ServerResponse) => {
    if (req.url?.endsWith("/count_tokens")) { res.end(JSON.stringify({ input_tokens: 1 })); return; }
    const body = object(JSON.parse((await decodeBody(raw, req.headers["content-encoding"], 4 * 1024 * 1024)).toString("utf8")));
    if (!body || !Array.isArray(body["tools"])) throw new Error("synthetic_tools_missing");
    const parent = body["tools"].some(t => object(t)?.["name"] === "Agent");
    if (parent) observations.parentRequests++; else observations.childRequests++;
    let block: Record<string, unknown>, stop: string;
    if (parent && !parentCalled) {
      parentCalled = true; stop = "tool_use";
      block = { type: "tool_use", id: "toolu_synthetic_agent", name: "Agent", input: {
        subagent_type: "sonnet_probe", description: "Read fixed fixture", prompt: "Read check.txt with Read and report its exact content.",
      } };
    } else if (!parent && !childRead) {
      childRead = true; stop = "tool_use";
      block = { type: "tool_use", id: "toolu_synthetic_read", name: "Read", input: { file_path: join(work, "check.txt") } };
    } else { block = { type: "text", text: secretTestValue }; stop = "end_turn"; }
    const model = typeof body["model"] === "string" ? body["model"] : "claude-sonnet-5";
    const frames = [
      { type: "message_start", message: { id: `msg_${randomUUID()}`, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: block.type === "tool_use" ? { ...block, input: {} } : { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: block.type === "tool_use" ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) } : { type: "text_delta", text: block.text } },
      { type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ];
    observations.upstreamStatuses.push(200);
    res.writeHead(200, { "content-type": "text/event-stream" }); res.end(frames.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""));
  };
  const relay = http.createServer(async (req, res) => {
    try {
      if (req.url === "/disabled-refresh") { res.writeHead(400); res.end(); return; }
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 4 * 1024 * 1024) throw new Error(); chunks.push(chunk); }
      const raw = Buffer.concat(chunks);
      if (synthetic) { await syntheticReply(raw, req, res); return; }
      if (observations.messages > 12) { res.writeHead(400); res.end(); return; }
      const upstream = https.request({ hostname: "api.anthropic.com", method: req.method, path: req.url,
        signal: AbortSignal.timeout(180000) }, (response) => {
        observations.upstreamStatuses.push(response.statusCode ?? 502);
        res.writeHead(response.statusCode ?? 502, filterRawHeaders(response.rawHeaders, RESPONSE_STRIP));
        response.pipe(res);
      });
      outgoing.add(upstream);
      upstream.on("close", () => outgoing.delete(upstream));
      upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      setRawRequestHeaders(upstream, filterRawHeaders(req.rawHeaders, HOP_BY_HOP));
      upstream.end(raw);
    } catch { if (!res.headersSent) res.writeHead(400); res.end(); }
  });
  let proxy: http.Server | undefined;
  const failedProfile = new AbortController();
  try {
    await mkdir(work, { mode: 0o700 });
    await mkdir(configDir, { mode: 0o700 });
    await writeFile(join(work, "check.txt"), secretTestValue, { mode: 0o600 });
    if (!(await listenServer(relay, 0, "127.0.0.1")).ok) throw new Error();
    const address = relay.address();
    if (!address || typeof address === "string") throw new Error();
    const authFile = join(temp, "isolated-openai-auth.json");
    if (openaiHeaders) await writeFile(authFile, JSON.stringify({ tokens: {
      access_token: openaiHeaders["authorization"]!.slice("Bearer ".length),
      account_id: openaiHeaders["chatgpt-account-id"], refresh_token: "",
    } }), { mode: 0o600 });
    const config = loadConfig({ env: {}, configPath: join(temp, "inline.json"), readFile: () => JSON.stringify({
      anthropic: { baseUrl: `http://127.0.0.1:${address.port}` },
      providers: { codex: { authFile, oauthTokenUrl: `http://127.0.0.1:${address.port}/disabled-refresh` } },
      ...(explicitProfiles && destination === "openai" ? { configVersion: 2, accessProfiles: {
        openai: { provider: "codex", product: "chatgpt-codex", billing: "subscription", account: "isolated-openai", credential: { kind: "native-oauth", authFile } },
      }, routes: { sol: { clients: ["claude-code"], primary: { profile: "openai", model: "gpt-6-sol", effort: "high" } } } } : {}),
    }) });
    if (!config.ok) throw new Error();
    const deps = buildDeps(config.value.config, { log: (_level, event, fields) => {
      if (event === "request_complete" && (fields?.route?.startsWith("codex:") || fields?.route === "explicit:sol")) observations.translatedRequests++;
      if (event === "route_request_failed" && fields?.errorCode) {
        if (explicitProfiles && !observations.routeErrors.includes(fields.errorCode))
          process.stderr.write(JSON.stringify({ gate: "explicit-profile", code: fields.errorCode }) + "\n");
        observations.routeErrors.push(fields.errorCode);
        if (explicitProfiles) failedProfile.abort();
      }
    } });
    if (!deps.ok) throw new Error();
    proxy = createProxyServer(deps.value);
    proxy.prependListener("request", (req: http.IncomingMessage) => {
      if (!req.url?.startsWith("/v1/messages")) return;
      const parts: Buffer[] = []; let bytes = 0;
      req.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes <= 4 * 1024 * 1024) parts.push(chunk); });
      req.on("end", () => { if (bytes <= 4 * 1024 * 1024) void observe(Buffer.concat(parts), req.headers["content-encoding"]); });
    });
    if (!(await listenServer(proxy, 0, "127.0.0.1")).ok) throw new Error();
    const proxyAddress = proxy.address();
    if (!proxyAddress || typeof proxyAddress === "string") throw new Error();
    const env = isolatedNativeEnv({
      CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_OAUTH_TOKEN: headers["authorization"]!.slice("Bearer ".length),
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${proxyAddress.port}`,
    });
    const version = await nativeProcess("claude", ["--version"], { cwd: work, env, timeoutMs: 10000 });
    observations.clientVersion = version.stdout.match(/(\d+\.\d+\.\d+)/)?.[1] ?? "unknown";
    const result = await nativeProcess("claude", [
      "--print", "--setting-sources", "", "--settings", '{"disableAllHooks":true}',
      "--disable-slash-commands", "--strict-mcp-config", "--no-session-persistence",
      "--tools", "Agent,Read", "--allowedTools", "Agent,Read", "--permission-mode", "dontAsk",
      "--model", "sonnet", "--output-format", "json",
      "--effort", "low",
      "--agents", JSON.stringify({ sonnet_probe: {
        description: "Read the isolated contract fixture.", model: destination === "openai" ? "sol" : "sonnet", tools: ["Read"],
        prompt: "Read check.txt with the Read tool and report its exact content. Do not use other tools.",
      } }),
      "Delegate to sonnet_probe to read check.txt. Return the exact value reported by that child. Do not read it yourself.",
    ], { cwd: work, env, timeoutMs: synthetic ? 45000 : 190000, signal: failedProfile.signal });
    observations.nativeDiagnostic = ["permission", "authentication", "connection", "model", "trust", "timeout", "onboarding"]
      .filter(code => result.stderr.toLowerCase().includes(code)).join(",") || "none";
    let answer: Record<string, unknown> | undefined;
    try { answer = object(JSON.parse(result.stdout)); } catch { /* Never emit CLI output. */ }
    return { schemaVersion: 1, destination, explicitProfiles, success: result.code === 0 && !result.failure && answer?.["is_error"] === false &&
      typeof answer["result"] === "string" && answer["result"].includes(secretTestValue) &&
      observations.nativeAgentCall && observations.nativeReadCall && observations.toolResultContinuation &&
      (!synthetic || observations.childRequests >= 2) &&
      (destination !== "openai" || observations.translatedRequests >= 2),
    nativeExit: result.failure ?? `exit_${result.code}`, ...observations };
  } finally {
    for (const request of outgoing) request.destroy();
    proxy?.closeAllConnections();
    await new Promise<void>((resolve) => { if (proxy) proxy.close(() => resolve()); else resolve(); });
    relay.closeAllConnections();
    await new Promise<void>((resolve) => relay.close(() => resolve()));
    await rm(temp, { recursive: true, force: true });
  }
}

if (process.argv[1]?.endsWith("native-claude.ts")) {
  try { const report = await runNativeClaude(process.argv.includes("--openai") ? "openai" : "claude", process.argv.includes("--synthetic"), process.argv.includes("--profiles")); console.log(JSON.stringify(report)); process.exitCode = report.success ? 0 : 1; }
  catch { console.log(JSON.stringify({ schemaVersion: 1, success: false, code: "native_control_unavailable" })); process.exitCode = 2; }
}
