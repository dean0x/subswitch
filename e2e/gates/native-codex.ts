/** Isolated native-client contract test. Every upstream response and credential is fabricated. */
import http from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, brotliDecompressSync, inflateSync, zstdDecompressSync } from "node:zlib";
import { WebSocketServer } from "ws";
import { loadConfig } from "../../src/config.js";
import { buildDeps, createProxyServer, listenServer } from "../../src/server.js";
import { object } from "./probe.js";
import { nativeProcess, isolatedNativeEnv } from "./native-process.js";
import { BRIDGE_NAMESPACE, namespaceRequest, namespaceEvent } from "./namespace-adapter.js";

const PARENT = "gpt-6-astra";
const CHILD = "claude-sonnet-5";
const marker = "native-tool-ok";
type Item = Record<string, unknown>;

function events(id: string, output: Item[]): Item[] {
  const response = { id, object: "response", created_at: 0, status: "in_progress", output: [] };
  const frames: Item[] = [{ type: "response.created", response }, { type: "response.in_progress", response }];
  for (const [output_index, item] of output.entries()) {
    frames.push({ type: "response.output_item.added", output_index, item: {
      ...item, status: "in_progress", ...(item["type"] === "function_call" ? { arguments: "" } : {}),
    } });
    if (item["type"] === "message") frames.push({
      type: "response.output_text.delta", output_index, content_index: 0, item_id: item["id"],
      delta: (item["content"] as Item[])[0]?.["text"],
    });
    if (item["type"] === "function_call") {
      frames.push({ type: "response.function_call_arguments.delta", output_index, item_id: item["id"], delta: item["arguments"] });
      frames.push({ type: "response.function_call_arguments.done", output_index, item_id: item["id"], arguments: item["arguments"] });
    }
    frames.push({ type: "response.output_item.done", output_index, item });
  }
  frames.push({ type: "response.completed", response: { ...response, status: "completed", output,
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
  return frames.map((frame, sequence_number) => ({ ...frame, sequence_number }));
}

const message = (id: string, text = marker): Item => ({
  type: "message", id, role: "assistant", status: "completed", phase: "final_answer",
  content: [{ type: "output_text", text, annotations: [] }],
});
const call = (id: string, name: string, args: Item, namespace?: string): Item => ({
  type: "function_call", id: `fc_${id}`, call_id: id, name, status: "completed",
  ...(namespace ? { namespace } : {}), arguments: JSON.stringify(args),
  // These arguments are authored by the fixture, never relabeled upstream ciphertext.
  ...(namespace === "collaboration" ? { encrypted_function_args: [] } : {}),
});

const successfulExec = (value: unknown, depth = 0): boolean => {
  if (depth > 8) return false;
  if (typeof value === "string") {
    try { return successfulExec(JSON.parse(value), depth + 1); } catch {
      return /Process exited with code 0[\s\S]*Final output:\s*native-tool-ok/.test(value);
    }
  }
  if (Array.isArray(value)) return value.some((entry) => successfulExec(entry, depth + 1));
  const entry = object(value);
  if (!entry) return false;
  if (entry["exit_code"] === 0 && typeof entry["output"] === "string" && entry["output"].includes(marker)) return true;
  return ["content", "output", "text"].some((key) => successfulExec(entry[key], depth + 1));
};

/** Fake catalog uses native public metadata to keep the installed client's defaults valid. */
async function catalog(version: "v1" | "v2"): Promise<Item[]> {
  const native: Item = JSON.parse(await readFile(new URL("../../test/fixtures/native/codex-0.153.3-model.json", import.meta.url), "utf8"));
  return [PARENT, CHILD].map((slug) => ({
    ...native, slug, display_name: slug, description: "Fabricated native contract model",
    model_messages: null, base_instructions: "Perform the fixed native contract check. Follow the provided tool definitions.",
    supported_in_api: true, multi_agent_version: version,
  }));
}

export async function runNativeCodex(version: "v1" | "v2" = "v2", transport: "websocket" | "http" = "websocket", adaptNamespace = false) {
  const collaborationNamespace = adaptNamespace ? BRIDGE_NAMESPACE : "collaboration";
  const models = await catalog(version);
  const temp = await mkdtemp(join(tmpdir(), "subswitch-codex-contract-"));
  const codexDir = join(temp, "codex");
  const work = join(temp, "work");
  const observations = {
    version, transport, adaptNamespace, clientVersion: "unknown", websocketConnections: 0, httpResponses: 0, warmups: 0, continuations: 0, compressedRequests: 0,
    parentRequests: 0, childRequests: 0, nativeToolExecuted: false, childReplyDelivered: false,
    nativeV2Schema: false, unknownModel: false, fixtureErrors: 0,
    execToolType: "missing", stage: "setup", nativeExit: "not_started", nativeDiagnostic: "none",
    nativeEventTypes: [] as string[], nativeStderrBytes: 0, nativeStdoutBytes: 0, multiplexed: false,
    followupReceived: false, followupReplyDelivered: false,
    childTaskReadable: false, childIdentityPreserved: false, replyIdentityPreserved: false,
  };
  const history = new Map<string, Item[]>();
  let serial = 0;
  let childStarted = false;
  let childCalled = false;
  let parentSpawned = false;
  let parentWaited = false;
  let parentFollowedUp = false;
  let parentFollowupWaited = false;
  const respond = (body: Item): Item[] => {
    const id = `resp_native_${++serial}`;
    if (serial > 24) throw new Error("fixture_request_limit");
    const previous = body["previous_response_id"];
    if (typeof previous === "string" && !history.has(previous)) throw new Error("fixture_missing_state");
    if (typeof previous === "string") observations.continuations++;
    const input = [...(typeof previous === "string" ? history.get(previous) ?? [] : []),
      ...(Array.isArray(body["input"]) ? body["input"] as Item[] : [])];
    const toolSources = [...(Array.isArray(body["tools"]) ? body["tools"] as Item[] : []),
      ...input.flatMap((item) => item["type"] === "additional_tools" && Array.isArray(item["tools"]) ? item["tools"] as Item[] : [])];
    if (toolSources.some((t) => t["name"] === collaborationNamespace)) observations.nativeV2Schema = true;
    const functions = toolSources.find((t) => t["name"] === "functions");
    const execTool = Array.isArray(functions?.["tools"]) ? functions["tools"].find((t: Item) => t["name"] === "exec") : undefined;
    if (execTool) observations.execToolType = execTool["type"] === "custom" ? "custom" : "function";
    if (body["generate"] === false) {
      observations.warmups++; history.set(id, input);
      return events(id, []);
    }
    let output: Item[];
    if (body["model"] === CHILD) {
      childStarted = true;
      observations.childRequests++;
      observations.childTaskReadable ||= input.some((item) => item["type"] === "agent_message" &&
        JSON.stringify(item["content"]).includes("Run the fixed tool check"));
      observations.childIdentityPreserved ||= input.some((item) => item["type"] === "agent_message" &&
        item["author"] === "/root" && item["recipient"] === "/root/sonnet");
      if (input.some((item) => item["type"] === "agent_message" && JSON.stringify(item["content"]).includes("Repeat the fixed check"))) {
        observations.followupReceived = true;
        output = [message("msg_child_followup", "native-followup-ok")];
      } else if (!childCalled) {
        childCalled = true;
        output = execTool?.["type"] === "custom" ? [{
          type: "custom_tool_call", id: "ctc_native_exec", call_id: "native_exec", namespace: "functions", name: "exec",
          input: `const r = await tools.exec_command({cmd: "printf '${marker}'", login: false, max_output_tokens: 32}); text(r);`,
        }] : [call("native_exec", "exec_command", { cmd: `printf '${marker}'`, login: false, max_output_tokens: 32 }, "functions")];
      } else {
        observations.nativeToolExecuted = input.some((item) => ["function_call_output", "custom_tool_call_output"].includes(String(item["type"])) &&
          item["call_id"] === "native_exec" && successfulExec(item["output"]));
        output = [message("msg_child")];
      }
    } else if (body["model"] === PARENT) {
      observations.parentRequests++;
      observations.replyIdentityPreserved ||= input.some((item) => item["type"] === "agent_message" &&
        item["author"] === "/root/sonnet" && item["recipient"] === "/root");
      if (!parentSpawned) {
        parentSpawned = true;
        output = [version === "v2" ? call("native_spawn", "spawn_agent", {
          task_name: "sonnet", message: "Run the fixed tool check, then reply with native-tool-ok.",
          model: CHILD, fork_turns: "none",
        }, collaborationNamespace) : call("native_spawn", "spawn_agent", { message: "Run the fixed tool check, then reply with native-tool-ok.", agent_type: "sonnet" }, "multi_agent_v1")];
      } else if (!parentWaited) {
        parentWaited = true;
        const result = input.find((item) => ["function_call_output", "custom_tool_call_output"].includes(String(item["type"])) && item["call_id"] === "native_spawn");
        let childId: unknown;
        try { childId = object(JSON.parse(String(result?.["output"])))?.["agent_id"]; } catch { /* Checked by the final report. */ }
        if (!childId) childId = JSON.stringify(result?.["output"])?.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/)?.[0];
        output = [version === "v2" ? call("native_wait", "wait_agent", { timeout_ms: 10000 }, collaborationNamespace) :
          call("native_wait", "wait_agent", { targets: [childId], timeout_ms: 10000 }, "multi_agent_v1")];
      } else {
        observations.childReplyDelivered = input.some((item) =>
          (item["type"] === "agent_message" || (["function_call_output", "custom_tool_call_output"].includes(String(item["type"])) && item["call_id"] === "native_wait")) &&
          JSON.stringify(item).includes(marker));
        if (version === "v2" && !parentFollowedUp) {
          parentFollowedUp = true;
          output = [call("native_followup", "followup_task", { target: "sonnet", message: "Repeat the fixed check and return native-followup-ok." }, collaborationNamespace)];
        } else if (version === "v2" && !parentFollowupWaited) {
          parentFollowupWaited = true;
          output = [call("native_followup_wait", "wait_agent", { timeout_ms: 10000 }, collaborationNamespace)];
        } else {
          observations.followupReplyDelivered = input.some((item) => item["type"] === "agent_message" && JSON.stringify(item["content"]).includes("native-followup-ok"));
          output = [message("msg_parent")];
        }
      }
    } else { observations.unknownModel = true; output = [message("msg_unknown")]; }
    history.set(id, [...input, ...output]);
    return events(id, output);
  };
  const exchange = (body: Item): Item[] => adaptNamespace ?
    respond(namespaceRequest(body)).map(namespaceEvent) : respond(body);

  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  const upstream = http.createServer(async (req, res) => {
    try {
      if (req.url?.includes("/models")) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ models })); return; }
      if (!req.url?.includes("/responses")) { res.writeHead(404); res.end(); return; }
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 4 * 1024 * 1024) throw new Error(); chunks.push(chunk); }
      observations.httpResponses++;
      let raw: Buffer = Buffer.concat(chunks);
      const decoders: Record<string, (body: Buffer, options: { maxOutputLength: number }) => Buffer> = {
        gzip: gunzipSync, br: brotliDecompressSync, deflate: inflateSync, zstd: zstdDecompressSync,
      };
      const encoding = req.headers["content-encoding"];
      if (typeof encoding === "string" && encoding !== "identity") {
        const decode = decoders[encoding];
        if (!decode) throw new Error();
        raw = decode(raw, { maxOutputLength: 4 * 1024 * 1024 });
        observations.compressedRequests++;
      }
      const frames = exchange(JSON.parse(raw.toString("utf8")));
      res.setHeader("content-type", "text/event-stream");
      res.end(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""));
    } catch { observations.fixtureErrors++; res.writeHead(400); res.end(); }
  });
  upstream.on("upgrade", (req, socket, head) => {
    if (transport === "http") { socket.end("HTTP/1.1 426 Upgrade Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
    observations.websocketConnections++;
    ws.on("error", () => undefined);
    ws.on("message", (data) => {
      try {
        const request = JSON.parse(data.toString());
        const streamId = typeof request.stream_id === "string" ? request.stream_id : undefined;
        if (streamId) observations.multiplexed = true;
        for (const frame of exchange(request)) ws.send(JSON.stringify({ ...frame, ...(streamId ? { stream_id: streamId } : {}) }));
      }
      catch { observations.fixtureErrors++; ws.close(1008, "fixture_contract_error"); }
    });
    });
  });
  let proxy: http.Server | undefined;
  try {
    await mkdir(codexDir, { mode: 0o700 });
    await mkdir(work, { mode: 0o700 });
    const env = isolatedNativeEnv({ CODEX_HOME: codexDir, OPENAI_API_KEY: "fabricated-native-test-key" });
    const versionResult = await nativeProcess("codex", ["--version"], { cwd: work, env, timeoutMs: 10000 });
    const clientVersion = versionResult.stdout.match(/codex-cli (\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?)/)?.[1];
    if (versionResult.failure || versionResult.code !== 0 || !clientVersion) throw new Error("native_version_unavailable");
    observations.clientVersion = clientVersion;
    const bound = await listenServer(upstream, 0, "127.0.0.1");
    if (!bound.ok) throw new Error("fixture_listen_failed");
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error();
    const base = `http://127.0.0.1:${address.port}`;
    const loaded = loadConfig({ env: {}, configPath: join(temp, "inline.json"), readFile: () => JSON.stringify({
      anthropic: { baseUrl: base }, providers: { codex: { authFile: join(temp, "unused-auth.json") } },
      codexIngress: { enabled: true, subscriptionBaseUrl: `${base}/backend-api/codex`, apiBaseUrl: `${base}/v1` },
    }) });
    if (!loaded.ok) throw new Error("fixture_config_failed");
    const deps = buildDeps(loaded.value.config, { log: () => undefined });
    if (!deps.ok) throw new Error("fixture_proxy_failed");
    proxy = createProxyServer(deps.value);
    const listening = await listenServer(proxy, 0, "127.0.0.1");
    if (!listening.ok) throw new Error("fixture_proxy_listen_failed");
    const proxyAddress = proxy.address();
    if (!proxyAddress || typeof proxyAddress === "string") throw new Error();
    await writeFile(join(codexDir, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "fabricated-native-test-key" }), { mode: 0o600 });
    await writeFile(join(codexDir, "models_cache.json"), JSON.stringify({
      fetched_at: new Date().toISOString(), etag: "fixture", client_version: clientVersion, models,
    }), { mode: 0o600 });
    await writeFile(join(codexDir, "native_catalog.json"), JSON.stringify({ models }), { mode: 0o600 });
    await writeFile(join(codexDir, "sonnet.toml"), `model = "${CHILD}"\ndeveloper_instructions = "Perform the fixed native contract check."\n`, { mode: 0o600 });
    await writeFile(join(codexDir, "config.toml"), [
      `model = "${PARENT}"`, `model_catalog_json = "${join(codexDir, "native_catalog.json")}"`, `openai_base_url = "http://127.0.0.1:${proxyAddress.port}/codex/v1"`,
      'approval_policy = "never"', 'sandbox_mode = "read-only"',
      '[agents.sonnet]', 'description = "Fixed Sonnet contract check"', 'config_file = "sonnet.toml"',
    ].join("\n"), { mode: 0o600 });
    observations.stage = "native_client";
    const result = await nativeProcess("codex", ["exec", "--skip-git-repo-check", "--ephemeral", "--ignore-rules", "--json",
      "Perform the fixed native contract check using the sonnet child."], {
      cwd: work, env,
    });
    observations.nativeExit = result.failure ?? `exit_${result.code}`;
    observations.nativeStdoutBytes = result.stdout.length;
    observations.nativeStderrBytes = result.stderr.length;
    observations.nativeDiagnostic = ["unsupported call", "failed to parse", "not found", "not allowed", "sandbox", "model", "permission", "fork_turns", "agent_type"]
      .filter((code) => result.stderr.toLowerCase().includes(code)).join(",") || "none";
    observations.nativeEventTypes = result.stdout.split("\n").flatMap((line) => {
      try { const type = JSON.parse(line).type; return ["thread.started", "item.started", "item.completed", "turn.started", "turn.completed", "turn.failed", "error"].includes(type) ? [type] : ["other"]; }
      catch { return []; }
    });
    const success = result.code === 0 && !result.failure && childStarted && observations.nativeToolExecuted && observations.childReplyDelivered &&
      result.stdout.includes(marker) && (version !== "v2" ||
        (observations.nativeV2Schema && observations.followupReceived && observations.followupReplyDelivered &&
          observations.childTaskReadable && observations.childIdentityPreserved && observations.replyIdentityPreserved));
    return { schemaVersion: 1, success, ...observations };
  } catch (error) {
    const failure = error as { code?: unknown; killed?: boolean; stderr?: string; message?: string };
    observations.nativeExit = failure.killed ? "timeout" : typeof failure.code === "number" ? `exit_${failure.code}` : "fixture_error";
    const diagnostic = `${failure.stderr ?? ""} ${failure.message ?? ""}`;
    for (const token of ["fixture_config_failed", "fixture_proxy_failed", "config.toml", "unexpected argument", "API key", "sandbox", "model", "authentication", "connection", "permission"])
      if (diagnostic.includes(token)) observations.nativeDiagnostic = token;
    return { schemaVersion: 1, success: false, ...observations };
  }
  finally {
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    await new Promise<void>((resolve) => { if (proxy) proxy.close(() => resolve()); else resolve(); });
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(temp, { recursive: true, force: true });
  }
}

if (process.argv[1]?.endsWith("native-codex.ts")) {
  const version = process.argv.includes("--v1") ? "v1" : "v2";
  const transport = process.argv.includes("--http") ? "http" : "websocket";
  if (process.argv.includes("--namespace-adapter")) {
    const control = await runNativeCodex(version, transport);
    console.log(JSON.stringify({ gate: "native_control", ...control }));
    if (!control.success) { process.exitCode = 1; } else {
      const report = await runNativeCodex(version, transport, true);
      console.log(JSON.stringify({ gate: "namespace_adapter", ...report }));
      process.exitCode = report.success ? 0 : 1;
    }
  } else {
    const report = await runNativeCodex(version, transport);
    console.log(JSON.stringify(report));
    process.exitCode = report.success ? 0 : 1;
  }
}
