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

export async function runNativeClaude(destination: "claude" | "openai" = "claude") {
  const headers = await probeHeaders({ provider: "claude", auth: "subscription" });
  const openaiHeaders = destination === "openai" ? await probeHeaders({ provider: "openai", auth: "subscription" }) : undefined;
  const temp = await mkdtemp(join(tmpdir(), "subswitch-claude-contract-"));
  const work = join(temp, "work"), configDir = join(temp, "config");
  const secretTestValue = `native-read-${randomUUID()}`;
  const observations = { messages: 0, sonnetRequests: 0, nativeAgentCall: false,
    nativeReadCall: false, toolResultContinuation: false, upstreamStatuses: [] as number[], translatedRequests: 0 };
  const observe = (raw: Buffer) => {
    try {
      observations.messages++;
      const body = object(JSON.parse(raw.toString("utf8")));
      if (body?.["model"] === "claude-sonnet-5") observations.sonnetRequests++;
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
  const relay = http.createServer(async (req, res) => {
    try {
      if (req.url === "/disabled-refresh") { res.writeHead(400); res.end(); return; }
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 4 * 1024 * 1024) throw new Error(); chunks.push(chunk); }
      const raw = Buffer.concat(chunks);
      if (observations.messages > 12) { res.writeHead(400); res.end(); return; }
      const upstream = https.request({ hostname: "api.anthropic.com", method: req.method, path: req.url,
        signal: AbortSignal.timeout(30000) }, (response) => {
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
    }) });
    if (!config.ok) throw new Error();
    const deps = buildDeps(config.value.config, { log: (_level, event, fields) => {
      if (event === "request_complete" && fields?.route?.startsWith("codex:")) observations.translatedRequests++;
    } });
    if (!deps.ok) throw new Error();
    proxy = createProxyServer(deps.value);
    proxy.prependListener("request", (req: http.IncomingMessage) => {
      if (!req.url?.startsWith("/v1/messages")) return;
      const parts: Buffer[] = []; let bytes = 0;
      req.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes <= 4 * 1024 * 1024) parts.push(chunk); });
      req.on("end", () => { if (bytes <= 4 * 1024 * 1024) observe(Buffer.concat(parts)); });
    });
    if (!(await listenServer(proxy, 0, "127.0.0.1")).ok) throw new Error();
    const proxyAddress = proxy.address();
    if (!proxyAddress || typeof proxyAddress === "string") throw new Error();
    const env = isolatedNativeEnv({
      CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_OAUTH_TOKEN: headers["authorization"]!.slice("Bearer ".length),
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${proxyAddress.port}`,
    });
    const result = await nativeProcess("claude", [
      "--print", "--setting-sources", "", "--settings", '{"disableAllHooks":true}',
      "--disable-slash-commands", "--strict-mcp-config", "--no-session-persistence",
      "--tools", "Agent,Read", "--allowedTools", "Agent,Read", "--permission-mode", "dontAsk",
      "--model", "sonnet", "--output-format", "json",
      "--agents", JSON.stringify({ sonnet_probe: {
        description: "Read the isolated contract fixture.", model: destination === "openai" ? "sol" : "sonnet", tools: ["Read"],
        prompt: "Read check.txt with the Read tool and report its exact content. Do not use other tools.",
      } }),
      "Delegate to sonnet_probe to read check.txt. Return the exact value reported by that child. Do not read it yourself.",
    ], { cwd: work, env, timeoutMs: 60000 });
    let answer: Record<string, unknown> | undefined;
    try { answer = object(JSON.parse(result.stdout)); } catch { /* Never emit CLI output. */ }
    return { schemaVersion: 1, destination, success: result.code === 0 && !result.failure && answer?.["is_error"] === false &&
      typeof answer["result"] === "string" && answer["result"].includes(secretTestValue) &&
      observations.nativeAgentCall && observations.nativeReadCall && observations.toolResultContinuation &&
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
  try { const report = await runNativeClaude(process.argv.includes("--openai") ? "openai" : "claude"); console.log(JSON.stringify(report)); process.exitCode = report.success ? 0 : 1; }
  catch { console.log(JSON.stringify({ schemaVersion: 1, success: false, code: "native_control_unavailable" })); process.exitCode = 2; }
}
