import { readFile } from "node:fs/promises";
import { loadConfig, type Config } from "./config.js";
import { inspectAuthFile } from "./codex-auth.js";
import { buildDeps, createProxyServer } from "./server.js";

const SHUTDOWN_GRACE_MS = 5000;

const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const fail = (message: string): void => {
  process.stderr.write(`croxy: ${message}\n`);
  process.exitCode = 1;
};

const serve = (config: Config): void => {
  const deps = buildDeps(config);
  const server = createProxyServer(deps);
  server.listen(config.port, "127.0.0.1", () => {
    deps.logger.log("info", "listening", { path: `http://127.0.0.1:${config.port}` });
  });

  const shutdown = (): void => {
    deps.logger.log("info", "shutting_down");
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
};

const doctor = async (config: Config): Promise<void> => {
  out("croxy doctor");
  out(`  port:               ${config.port}`);
  out(`  logLevel:           ${config.logLevel}`);
  out(`  anthropic.baseUrl:  ${config.anthropic.baseUrl}`);
  out(`  codex.baseUrl:      ${config.codex.baseUrl}`);
  out(`  codex.models:       ${config.codex.models.join(", ")}`);
  out(`  codex.authFile:     ${config.codex.authFile}`);

  let raw: string;
  try {
    raw = await readFile(config.codex.authFile, "utf8");
  } catch {
    out("  codex auth:         UNAVAILABLE (cannot read auth file — run `codex login`)");
    out("  note: the Anthropic leg works without codex auth; only configured codex models are affected");
    return;
  }
  const inspection = inspectAuthFile(raw);
  if (!inspection.ok) {
    out(`  codex auth:         INVALID (${inspection.error.message})`);
    return;
  }
  const info = inspection.value;
  out(`  codex auth mode:    ${info.authMode}`);
  out(`  codex account:      ${info.accountIdSuffix}`);
  out(`  token expires:      ${info.accessTokenExpiresAt ?? "(no exp claim)"}`);
  out(`  last refresh:       ${info.lastRefresh ?? "(unknown)"}`);
};

const main = async (): Promise<void> => {
  const command = process.argv[2] ?? "serve";
  const configResult = loadConfig();
  if (!configResult.ok) {
    fail(configResult.error.message);
    return;
  }
  if (command === "serve") {
    serve(configResult.value);
    return;
  }
  if (command === "doctor") {
    await doctor(configResult.value);
    return;
  }
  fail(`unknown command "${command}" — usage: croxy [serve|doctor]`);
};

void main();
