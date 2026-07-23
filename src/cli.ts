#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { type Config, loadConfig } from "./config.js";
import { buildDeps, createProxyServer, listenServer } from "./server.js";
import { runDoctor, makeLiveHttpGet, makeLiveTlsConnect } from "./doctor.js";
import {
  runInitInteractive,
  runInitNonInteractive,
  makeRealFsDeps,
  resolveInitDispatch,
} from "./init.js";
import { resolveColorEnabled } from "./tty.js";
import { SUBSWITCH_VERSION } from "./version.js";

const SHUTDOWN_GRACE_MS = 5000;

const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const errOut = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

const fail = (message: string): void => {
  process.stderr.write(`subswitch: ${message}\n`);
  process.exitCode = 1;
};

// ---------------------------------------------------------------------------
// Usage help
// ---------------------------------------------------------------------------

const USAGE = `\
Usage: subswitch [command] [flags]

Commands:
  serve     Start the proxy (default command)
  doctor    Check config, codex auth, and network reachability
  init      Interactive setup — writes config + wires Claude Code

Flags (global):
  -h, --help       Show this help message
  -v, --version    Print version

Flags (serve):
      --verbose    Set log level to debug for this run
      --quiet      Set log level to warn for this run

Flags (init):
  -y, --yes                  Non-interactive mode — use flags + defaults
      --port <n>             Proxy port (default: 4141)
      --codex-model <name>   Include this Codex model (repeatable)
      --codex-models <csv>   Comma-separated list of Codex models
      --settings-target <t>  "local" (.claude/settings.local.json, default)
                             or "shared" (.claude/settings.json)
`;

// ---------------------------------------------------------------------------
// serve
// ---------------------------------------------------------------------------

const serve = async (
  config: Config,
  configPath: string,
  fileFound: boolean,
  verbose: boolean,
  quiet: boolean,
): Promise<void> => {
  // Apply verbosity flag override without mutating config.
  const logLevel =
    verbose ? ("debug" as const)
    : quiet  ? ("warn" as const)
    :          config.logLevel;
  const effectiveConfig = logLevel !== config.logLevel ? { ...config, logLevel } : config;

  const deps = buildDeps(effectiveConfig);
  const server = createProxyServer(deps);
  const listenResult = await listenServer(server, effectiveConfig.port, "127.0.0.1");
  if (!listenResult.ok) {
    if (listenResult.error.code === "EADDRINUSE") {
      fail(`port ${effectiveConfig.port} already in use — is another subswitch running?`);
    } else {
      fail(`failed to start: ${listenResult.error.message}`);
    }
    return;
  }
  deps.logger.log("info", "config_loaded", {
    path: configPath,
    eventType: fileFound ? "loaded" : "defaults",
  });
  deps.logger.log("info", "listening", { path: `http://127.0.0.1:${effectiveConfig.port}` });

  // Human-readable ready banner (one-shot startup moment, safe to use a distinct format).
  const modelsStr = effectiveConfig.codex.models.join(", ");
  errOut(`\nsubswitch ready — http://127.0.0.1:${effectiveConfig.port}`);
  errOut(`  routing: ${modelsStr} → Codex`);
  errOut(`  run \`subswitch doctor\` to verify setup\n`);

  const shutdown = (): void => {
    deps.logger.log("info", "shutting_down");
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
};

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

const doctor = async (config: Config, configPath: string, fileFound: boolean): Promise<void> => {
  const color = resolveColorEnabled(
    process.env as Record<string, string | undefined>,
    process.stdout.isTTY === true,
  );

  const exitCode = await runDoctor(config, configPath, fileFound, {
    write: out,
    readAuthFile: (path) => readFile(path, "utf8"),
    httpGet: makeLiveHttpGet(),
    tlsConnect: makeLiveTlsConnect(),
    color,
  });

  process.exitCode = exitCode;
};

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

const init = async (
  yes: boolean,
  portFlag: string | undefined,
  codexModelFlags: string[],
  codexModelsFlag: string | undefined,
  settingsTargetFlag: string | undefined,
): Promise<void> => {
  const projectDir = process.cwd();
  const fsDeps = makeRealFsDeps();

  // Pass raw CLI flag values directly — merging of --codex-model / --codex-models
  // and all normalization happens inside resolveOptionsFromFlags.
  const flags = {
    ...(portFlag !== undefined ? { port: portFlag } : {}),
    ...(codexModelFlags.length > 0 ? { codexModel: codexModelFlags } : {}),
    ...(codexModelsFlag !== undefined ? { codexModels: codexModelsFlag } : {}),
    ...(settingsTargetFlag !== undefined ? { settingsTarget: settingsTargetFlag } : {}),
  };

  const decision = resolveInitDispatch(
    process.stdin.isTTY === true,
    process.stdout.isTTY === true,
    "CI" in process.env,
    yes,
  );

  if (decision === "interactive") {
    await runInitInteractive(projectDir, fsDeps, process.env as Record<string, string | undefined>);
  } else if (decision === "non-interactive") {
    const exitCode = await runInitNonInteractive(flags, projectDir, fsDeps, out, errOut);
    process.exitCode = exitCode;
  } else {
    // decision === "refuse": non-TTY / CI without --yes — fail closed, no files written
    errOut(
      "subswitch init: no interactive terminal detected. Re-run with --yes to accept defaults " +
        "(optionally with --port / --settings-target / --codex-models), or run in an interactive shell.",
    );
    process.exitCode = 1;
  }
};

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const main = async (): Promise<void> => {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      options: {
        help:              { type: "boolean", short: "h" },
        version:           { type: "boolean", short: "v" },
        // serve flags
        verbose:           { type: "boolean" },
        quiet:             { type: "boolean" },
        // init flags
        yes:               { type: "boolean", short: "y" },
        port:              { type: "string" },
        "codex-models":    { type: "string" },
        "codex-model":     { type: "string", multiple: true },
        "settings-target": { type: "string" },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (e) {
    fail(`${String(e)}\n\n${USAGE}`);
    return;
  }

  const { values, positionals } = parsed;

  if (values.help === true) {
    out(USAGE);
    return;
  }

  if (values.version === true) {
    out(SUBSWITCH_VERSION);
    return;
  }

  const command = positionals[0] ?? "serve";

  // Commands that don't need config.
  if (command === "init") {
    await init(
      values.yes === true,
      typeof values.port === "string" ? values.port : undefined,
      Array.isArray(values["codex-model"])
        ? (values["codex-model"] as string[])
        : typeof values["codex-model"] === "string"
          ? [values["codex-model"]]
          : [],
      typeof values["codex-models"] === "string" ? values["codex-models"] : undefined,
      typeof values["settings-target"] === "string" ? values["settings-target"] : undefined,
    );
    return;
  }

  // Commands that need config.
  const configResult = loadConfig();
  if (!configResult.ok) {
    fail(configResult.error.message);
    return;
  }
  const { config, configPath, fileFound } = configResult.value;

  if (command === "serve") {
    await serve(config, configPath, fileFound, values.verbose === true, values.quiet === true);
    return;
  }

  if (command === "doctor") {
    await doctor(config, configPath, fileFound);
    return;
  }

  fail(`unknown command "${command}" — run \`subswitch --help\` for usage`);
};

void main();
