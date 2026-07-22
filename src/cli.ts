import { readFile } from "node:fs/promises";
import { type Config, loadConfig } from "./config.js";
import { inspectAuthFile } from "./codex-auth.js";
import { buildDeps, createProxyServer, listenServer } from "./server.js";
import { probeCroxy, probeTlsReachable, makeLiveHttpGet, makeLiveTlsConnect } from "./doctor.js";

const SHUTDOWN_GRACE_MS = 5000;

const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const fail = (message: string): void => {
  process.stderr.write(`croxy: ${message}\n`);
  process.exitCode = 1;
};

const serve = async (config: Config, configPath: string, fileFound: boolean): Promise<void> => {
  const deps = buildDeps(config);
  const server = createProxyServer(deps);
  const listenResult = await listenServer(server, config.port, "127.0.0.1");
  if (!listenResult.ok) {
    if (listenResult.error.code === "EADDRINUSE") {
      fail(`port ${config.port} already in use — is another croxy running?`);
    } else {
      fail(`failed to start: ${listenResult.error.message}`);
    }
    return;
  }
  deps.logger.log("info", "config_loaded", { path: configPath, eventType: fileFound ? "loaded" : "defaults" });
  deps.logger.log("info", "listening", { path: `http://127.0.0.1:${config.port}` });

  const shutdown = (): void => {
    deps.logger.log("info", "shutting_down");
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
};

const doctor = async (config: Config, configPath: string, fileFound: boolean): Promise<void> => {
  out("croxy doctor");
  out(`  config:             ${configPath}${fileFound ? "" : " (defaults — file not found)"}`);
  out(`  port:               ${config.port}`);
  out(`  logLevel:           ${config.logLevel}`);
  out(`  anthropic.baseUrl:  ${config.anthropic.baseUrl}`);
  out(`  codex.baseUrl:      ${config.codex.baseUrl}`);
  out(`  codex.models:       ${config.codex.models.join(", ")}`);
  out(`  codex.authFile:     ${config.codex.authFile}`);

  try {
    const raw = await readFile(config.codex.authFile, "utf8");
    const inspection = inspectAuthFile(raw);
    if (!inspection.ok) {
      out(`  codex auth:         INVALID (${inspection.error.message})`);
    } else {
      const info = inspection.value;
      out(`  codex auth mode:    ${info.authMode}`);
      out(`  codex account:      ${info.accountIdSuffix}`);
      out(`  token expires:      ${info.accessTokenExpiresAt ?? "(no exp claim)"}`);
      out(`  last refresh:       ${info.lastRefresh ?? "(unknown)"}`);
    }
  } catch {
    out("  codex auth:         UNAVAILABLE (cannot read auth file — run `codex login`)");
    out("  note: the Anthropic leg works without codex auth; only configured codex models are affected");
  }

  const httpGet = makeLiveHttpGet();
  const tlsConnect = makeLiveTlsConnect();

  const croxyStatus = await probeCroxy(config.port, { httpGet });
  switch (croxyStatus.kind) {
    case "running":
      out(`  croxy running:      YES (version ${croxyStatus.version})`);
      break;
    case "connection_refused":
      out(`  croxy running:      NO (port ${config.port} not in use)`);
      break;
    case "not_croxy":
      out(`  croxy running:      UNKNOWN (something else is on port ${config.port})`);
      break;
  }

  const anthropicHost = new URL(config.anthropic.baseUrl).hostname;
  const codexHost = new URL(config.codex.baseUrl).hostname;

  const anthropicTls = await probeTlsReachable(anthropicHost, { tlsConnect });
  out(
    anthropicTls.kind === "reachable"
      ? `  anthropic TLS:      OK (${anthropicHost})`
      : `  anthropic TLS:      FAIL (${anthropicHost}: ${anthropicTls.message})`,
  );

  const codexTls = await probeTlsReachable(codexHost, { tlsConnect });
  out(
    codexTls.kind === "reachable"
      ? `  codex TLS:          OK (${codexHost})`
      : `  codex TLS:          FAIL (${codexHost}: ${codexTls.message})`,
  );
};

const main = async (): Promise<void> => {
  const command = process.argv[2] ?? "serve";
  const configResult = loadConfig();
  if (!configResult.ok) {
    fail(configResult.error.message);
    return;
  }
  const { config, configPath, fileFound } = configResult.value;
  if (command === "serve") {
    await serve(config, configPath, fileFound);
    return;
  }
  if (command === "doctor") {
    await doctor(config, configPath, fileFound);
    return;
  }
  fail(`unknown command "${command}" — usage: croxy [serve|doctor]`);
};

void main();
