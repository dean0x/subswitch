#!/usr/bin/env node
import { CLIENT_IDS, parseClientSelection, selectedClients, type ClientId, type ClientSelection as Client } from "./clients.js";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { createColors } from "picocolors";
import { type Config, type LoadConfigResult, aliasesByProvider, enumerateDestinations, loadConfig, providerConfigFor, DEFAULT_PORT } from "./config.js";
import { buildDeps, createProxyServer, listenServer } from "./server.js";
import { runDoctor, makeLiveHttpGet, makeLiveTlsConnect, makeLiveListAgentFiles, makeLiveReadTextFile } from "./doctor.js";
import {
  runInitInteractive,
  runInitNonInteractive,
  runInitDryRun,
  makeClackPrompts,
  makeRealFsDeps,
  resolveInitDispatch,
  PortSchema,
  type InitFlags,
} from "./init.js";
import { MODEL_REGISTRY, formatModelsReport, buildModelRows, routableModelCount, PROVIDER_IDS } from "./models.js";
import { resolveColorEnabled } from "./tty.js";
import { SUBSWITCH_NAME, SUBSWITCH_VERSION } from "./version.js";
import { claudeModelRows } from "./claude-models.js";
import { routingDiscovery } from "./routing/routing-discovery.js";
import { runAction } from "./run-action.js";
import { publishActionControl } from "./routing/action-control.js";
import { createConsoleLogger } from "./logger.js";
import { LimitRecorder, limitDirectory, withLimitRecorder, readLimitObservations } from "./limit-recorder.js";

const SHUTDOWN_GRACE_MS = 5000;

const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const errOut = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

/** Write a prefixed error to stderr and set exit code 1. Always `return` after calling. */
const fail = (message: string): void => {
  process.stderr.write(`subswitch: ${message}\n`);
  process.exitCode = 1;
};

// ---------------------------------------------------------------------------
// Usage help (A3.23)
// ---------------------------------------------------------------------------

const USAGE = `\
subswitch — local subscription-routing proxy for Claude Code and Codex

Usage: subswitch [command] [flags]

Commands:
  serve     Start the proxy (default command)
  doctor    Check config, subscription auth, and network reachability
  init      Interactive setup — wires the selected client(s)
  models    Show effective alias table (registry × aliases)
            --json   Output model registry as JSON (no color, no TTY check)
            --schema-version 3 --client <client> --json   Common route discovery
  limits    Show recorded upstream limit/error formats (--json, --port <n>)
  run-action --client <client> [--conversation <id>] -- <native command>
            Scope one native invocation, including its tools and children

Flags (global):
  -h, --help       Show this help message
  -v, --version    Print version

Flags (serve):
      --verbose    Set log level to debug for this run
      --quiet      Set log level to warn for this run
      --port <n>   Override listen port (default: ${DEFAULT_PORT})

Flags (init):
  -y, --yes                  Non-interactive mode — use flags + defaults
      --dry-run              Show what would be written; writes nothing
      --port <n>             Proxy port (default: ${DEFAULT_PORT})
      --settings-target <t>  "local" (.claude/settings.local.json, default)
                             or "shared" (.claude/settings.json)

Flags (init, doctor, models):
      --client <client>     "claude-code", "codex", or "all"
                            init/models default to claude-code; doctor defaults to all
                            all selects supported clients; both is a compatibility alias

Examples:
  subswitch serve                      # start proxy on port ${DEFAULT_PORT}
  subswitch serve --port 8080          # start proxy on a custom port
  subswitch init                       # interactive setup
  subswitch init --yes                 # non-interactive with defaults
  subswitch init --dry-run             # preview what would be written
  subswitch doctor                     # check config + auth health
  subswitch models                     # show alias table (registry × aliases)

Environment:
  NO_COLOR      Disable color output (also respected as standard)
  FORCE_COLOR   Force color output even when not a TTY
  CI            Non-interactive detection — init refuses without --yes
  SUBSWITCH_LIMIT_RECORDING=0   Disable private limit observations (enabled by default)
  SUBSWITCH_LIMIT_DIR           Override private observation root directory
`;

// ---------------------------------------------------------------------------
// Typed CLI command union (A3.18)
// ---------------------------------------------------------------------------

type CliCommand =
  | { readonly kind: "help" }
  | { readonly kind: "version" }
  | { readonly kind: "serve"; readonly verbose: boolean; readonly quiet: boolean; readonly port?: string }
  | { readonly kind: "doctor"; readonly client: Client }
  | { readonly kind: "models"; readonly json: boolean; readonly client: Client; readonly schemaVersion?: 3 }
  | { readonly kind: "limits"; readonly json: boolean; readonly port?: string }
  | { readonly kind: "run-action"; readonly client: ClientId; readonly native: string[]; readonly conversation?: string }
  | { readonly kind: "init"; readonly yes: boolean; readonly dryRun: boolean; readonly flags: InitFlags; readonly client: Client };

// Flag sets per command — used for per-command validation (A3.19)
const GLOBAL_FLAGS = new Set(["help", "version"]);
const SERVE_FLAGS = new Set(["verbose", "quiet", "port"]);
const DOCTOR_FLAGS = new Set(["client"]);
const MODELS_FLAGS = new Set(["json", "client", "schema-version"]);
const LIMITS_FLAGS = new Set(["json", "port"]);
const INIT_FLAGS = new Set(["yes", "dry-run", "port", "settings-target", "client"]);

/**
 * Pure: parse process.argv slice into a typed CliCommand.
 * Returns err with a human-readable message (without "subswitch: " prefix —
 * callers pass it to fail() which adds the prefix). [A3.18/A3.19/A3.21]
 */
const parseCliArgs = (argv: string[]): { ok: true; value: CliCommand } | { ok: false; error: { message: string } } => {
  try {
    if (argv[0] === "run-action") {
      const boundary = argv.indexOf("--");
      if (boundary < 0 || !argv[boundary + 1]) throw new Error("run-action requires -- <native command>");
      const { values } = parseArgs({ args: argv.slice(1, boundary), options: { client: { type: "string" }, conversation: { type: "string" } }, strict: true });
      if (values.client !== "codex" && values.client !== "claude-code") throw new Error("run-action requires --client codex or claude-code");
      return { ok: true, value: { kind: "run-action", client: values.client, native: argv.slice(boundary + 1),
        ...(values.conversation ? { conversation: values.conversation } : {}) } };
    }
    const parseResult = parseArgs({
      args: argv,
      options: {
        help:              { type: "boolean", short: "h" },
        version:           { type: "boolean", short: "v" },
        // serve flags
        verbose:           { type: "boolean" },
        quiet:             { type: "boolean" },
        // init flags
        yes:               { type: "boolean", short: "y" },
        "dry-run":         { type: "boolean" },
        port:              { type: "string" },
        "settings-target": { type: "string" },
        // models flags
        json:              { type: "boolean" },
        client:            { type: "string" },
        "schema-version":  { type: "string" },
      },
      allowPositionals: true,
      strict: true,
      tokens: true,
    });

    const { values, positionals, tokens } = parseResult;

    // Global flags take precedence over everything
    if (values.help === true) return { ok: true, value: { kind: "help" } };
    if (values.version === true) return { ok: true, value: { kind: "version" } };

    const command = positionals[0] ?? "serve";
    const client = parseClientSelection(values.client ?? (command === "doctor" ? "all" : "claude-code"));
    if (!client) return { ok: false, error: { message: `client must be ${CLIENT_IDS.join(", ")}, or all` } };

    // Unknown command
    if (command !== "serve" && command !== "doctor" && command !== "init" && command !== "models" && command !== "limits") {
      return {
        ok: false,
        error: { message: `unknown command "${command}" — run \`subswitch --help\` for usage` },
      };
    }

    // Per-command flag validation from tokens (A3.19)
    let allowedFlags: Set<string>;
    if (command === "serve") {
      allowedFlags = SERVE_FLAGS;
    } else if (command === "doctor") {
      allowedFlags = DOCTOR_FLAGS;
    } else if (command === "models") {
      allowedFlags = MODELS_FLAGS;
    } else if (command === "limits") {
      allowedFlags = LIMITS_FLAGS;
    } else {
      allowedFlags = INIT_FLAGS;
    }

    if (tokens !== undefined) {
      for (const token of tokens) {
        if (token.kind !== "option") continue;
        const flagName = token.name;
        if (GLOBAL_FLAGS.has(flagName)) continue;
        if (!allowedFlags.has(flagName)) {
          return {
            ok: false,
            error: {
              message: `flag '--${flagName}' is not valid for '${command}' — run \`subswitch --help\` for usage`,
            },
          };
        }
      }
    }

    if (command === "init") {
      return {
        ok: true,
        value: {
          kind: "init",
          client,
          yes: values.yes === true,
          dryRun: values["dry-run"] === true,
          flags: {
            ...(typeof values.port === "string" ? { port: values.port } : {}),
            ...(typeof values["settings-target"] === "string"
              ? { settingsTarget: values["settings-target"] }
              : {}),
          },
        },
      };
    }

    if (command === "serve") {
      return {
        ok: true,
        value: {
          kind: "serve",
          verbose: values.verbose === true,
          quiet: values.quiet === true,
          ...(typeof values.port === "string" ? { port: values.port } : {}),
        },
      };
    }

    if (command === "doctor") {
      return { ok: true, value: { kind: "doctor", client } };
    }
    if (command === "limits")
      return { ok: true, value: { kind: "limits", json: values.json === true, ...(typeof values.port === "string" ? { port: values.port } : {}) } };

    // command === "models"
    if (values["schema-version"] !== undefined && (values["schema-version"] !== "3" || values.json !== true || values.client === undefined))
      throw new Error("schema-version requires models --schema-version 3 --client <client> --json");
    return { ok: true, value: { kind: "models", json: values.json === true, client,
      ...(values["schema-version"] === "3" ? { schemaVersion: 3 as const } : {}) } };
  } catch (e) {
    // Translate parseArgs throw to Result err (A3.21)
    if (e instanceof Error) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" || code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") {
        // Extract flag name from message: "Unknown option '--foo'." or similar
        const match = /[Uu]nknown option '(--?[^']+)'/.exec(e.message);
        const flag = match?.[1] ?? "unknown";
        return { ok: false, error: { message: `unknown flag '${flag}' — run \`subswitch --help\`` } };
      }
      if (code?.startsWith("ERR_PARSE_ARGS_")) {
        return { ok: false, error: { message: `invalid arguments — run \`subswitch --help\`` } };
      }
    }
    throw e; // Unexpected error — let it propagate
  }
};

// ---------------------------------------------------------------------------
// serve
// ---------------------------------------------------------------------------

const serve = async (
  result: LoadConfigResult,
  verbose: boolean,
  quiet: boolean,
  portStr?: string,
): Promise<void> => {
  const { config, configPath, fileFound } = result;

  // Validate --port if given, with byte-identical wording to init port validation. [F3/F15]
  let effectivePort = config.port;
  if (portStr !== undefined) {
    const portResult = PortSchema.safeParse(portStr);
    if (!portResult.success) {
      fail(`invalid --port "${portStr}": port must be an integer between 1 and 65535`);
      return;
    }
    effectivePort = portResult.data;
  }

  // Apply verbosity flag override without mutating config.
  let logLevel: Config["logLevel"];
  if (verbose) {
    logLevel = "debug";
  } else if (quiet) {
    logLevel = "warn";
  } else {
    logLevel = config.logLevel;
  }

  const effectiveConfig = { ...config, logLevel, port: effectivePort };

  const baseLogger = createConsoleLogger(logLevel);
  const recorder = process.env["SUBSWITCH_LIMIT_RECORDING"] === "0" ? undefined : new LimitRecorder(limitDirectory(effectivePort), baseLogger);
  const depsResult = buildDeps(effectiveConfig, recorder ? withLimitRecorder(baseLogger, recorder) : baseLogger);
  if (!depsResult.ok) {
    fail(depsResult.error);
    return;
  }
  const deps = depsResult.value;
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
  let removeActionControl: (() => Promise<void>) | undefined;
  if (effectiveConfig.configVersion === 2 && deps.sharedRouting) {
    try { removeActionControl = await publishActionControl(effectiveConfig.port, deps.sharedRouting.actions.capability); }
    catch (error) { server.close(); throw error; }
  }
  deps.logger.log("info", "config_loaded", {
    path: configPath,
    eventType: fileFound ? "loaded" : "defaults",
  });

  deps.logger.log("info", "listening", { path: `http://127.0.0.1:${effectiveConfig.port}` });

  // Human-readable ready banner — one line per provider (7d).
  errOut(`\nsubswitch ready — http://127.0.0.1:${effectiveConfig.port}`);
  for (const id of PROVIDER_IDS) {
    const modelCount = routableModelCount(MODEL_REGISTRY, id);
    const { baseUrl } = providerConfigFor(effectiveConfig, id);
    let host: string;
    try {
      host = new URL(baseUrl).hostname;
    } catch {
      host = baseUrl;
    }
    const hostSuffix = host !== "" ? `  → ${host}` : "";
    errOut(`  ${id.padEnd(8)}  ${modelCount} model${modelCount === 1 ? "" : "s"}${hostSuffix}`);
  }
  if (effectiveConfig.codexIngress.enabled) {
    errOut(effectiveConfig.codexIngress.claude.enabled ? "  codex ingress  OpenAI passthrough + Claude model routing (HTTP/WebSocket)" :
      "  codex ingress  native OpenAI passthrough (HTTP/WebSocket); Claude translation unavailable");
  }
  errOut(`  run \`subswitch doctor\` to verify setup\n`);

  if (recorder) errOut("  limit observations: " + recorder.directory + " (view with subswitch limits --json)\n");
  const shutdown = (): void => {
    deps.logger.log("info", "shutting_down");
    server.close(() => { void Promise.all([removeActionControl?.(), recorder?.flush()]).finally(() => process.exit(0)); });
    server.closeIdleConnections();
    setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
};

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

const doctor = async (result: LoadConfigResult, client: Client): Promise<void> => {
  const color = resolveColorEnabled(
    process.env as Record<string, string | undefined>,
    process.stdout.isTTY === true,
  );

  process.exitCode = client === "codex" ? 0 : await runDoctor(
    result.config,
    result.configPaths.length ? result.configPaths.join(" + ") : result.configPath,
    result.fileFound,
    {
      write: out,
      readAuthFile: (path) => readFile(path, "utf8"),
      httpGet: makeLiveHttpGet(),
      tlsConnect: makeLiveTlsConnect(),
      color,
      listAgentFiles: makeLiveListAgentFiles(),
      readTextFile: makeLiveReadTextFile(),
    },
    // Only providers explicitly present in the loaded configuration sources can fail the exit code. (avoids PF-006)
    result.configuredProviders,
  );
  if (client === "codex" || (client === "all" && result.config.codexIngress.claude.enabled)) {
    const { runCodexDoctor } = await import("./codex-doctor.js");
    process.exitCode = Math.max(Number(process.exitCode ?? 0), await runCodexDoctor(result.config, out, { color }));
  }
};

// ---------------------------------------------------------------------------
// models — print effective alias table or JSON output
// ---------------------------------------------------------------------------

/**
 * Output model registry as machine-readable JSON.
 *
 * This function returns BEFORE resolveColorEnabled is called so that FORCE_COLOR
 * in the environment never affects JSON output (structural: not conditional). [7b]
 *
 * Never writes credentials, tokens, PII, or secrets. [compliance]
 */
const modelsJson = (result: LoadConfigResult, client: Client): void => {
  const { config, configPath, fileFound } = result;
  const rows = buildModelRows(MODEL_REGISTRY, aliasesByProvider(config));

  const payload = {
    kind: "models",
    schemaVersion: 1,
    subswitchVersion: SUBSWITCH_VERSION,
    name: SUBSWITCH_NAME,
    fallbackProvider: "anthropic",
    configPath,
    // Reported straight from the load that produced `models`, so the flag always
    // describes the config those rows were actually built from.
    configFileFound: fileFound,
    // enumerateDestinations provides the single topology source shared with the health
    // endpoint — Anthropic (passthrough) first, then registered providers.  (ARCH-04)
    providers: enumerateDestinations(config).map((d) => ({
      id: d.id,
      displayName: d.displayName,
      routing: d.routing,
    })),
    models: rows,
  };

  const reverse = { kind: "models", schemaVersion: 2, client: "codex", subswitchVersion: SUBSWITCH_VERSION,
    fallbackProvider: "codex", enabled: config.codexIngress.enabled && config.codexIngress.claude.enabled,
    models: claudeModelRows(config.codexIngress.claude.aliases) };
  const catalogs = { "claude-code": payload, codex: reverse } satisfies Record<ClientId, object>;
  if (client === "all") {
    out(JSON.stringify({ kind: "models", schemaVersion: 2, client: "all", clients: catalogs }));
    return;
  }
  out(JSON.stringify(catalogs[client]));
};

const models = (config: Config, client: Client): void => {
  if (client === "all") { for (const id of selectedClients(client)) models(config, id); return; }
  if (client === "codex") {
    out(`subswitch models — Codex → Claude (${config.codexIngress.enabled && config.codexIngress.claude.enabled ? "enabled" : "disabled"})`);
    for (const row of claudeModelRows(config.codexIngress.claude.aliases)) out(`  ${row.id}${row.aliases.length ? `  ${row.aliases.join(", ")}` : ""}`);
    return;
  }
  const color = resolveColorEnabled(
    process.env as Record<string, string | undefined>,
    process.stdout.isTTY === true,
  );
  const pc = createColors(color);

  const lines = formatModelsReport({
    registry: MODEL_REGISTRY,
    aliasesByProvider: aliasesByProvider(config),
  });

  if (lines.length === 0) {
    out("  (no aliases configured)");
    return;
  }

  out("subswitch models");
  for (const line of lines) {
    // Colorize the status and source columns while keeping the already-aligned text intact.
    const colorized = line
      .replace("enabled", pc.green("enabled"))
      .replace("disabled", pc.dim("disabled"))
      .replace("(config)", pc.yellow("(config)"))
      .replace("(derived)", pc.dim("(derived)"))
      .replace("(direct)", pc.dim("(direct)"));
    out(`  ${colorized}`);
  }
};

// ---------------------------------------------------------------------------
// init dispatch (A3.22 — single unified dispatch)
// ---------------------------------------------------------------------------

const runInit = async (command: Extract<CliCommand, { kind: "init" }>): Promise<void> => {
  const projectDir = process.cwd();
  const fsDeps = makeRealFsDeps();
  const env = process.env as Record<string, string | undefined>;

  if (command.client !== "claude-code") {
    const decision = resolveInitDispatch(process.stdin.isTTY === true, process.stdout.isTTY === true, "CI" in env, command.yes);
    if (!command.dryRun && decision === "refuse") { fail("no interactive terminal detected. Re-run with --yes, or preview with --dry-run."); return; }
    let port = command.flags.port;
    if (!command.dryRun && decision === "interactive") {
      const prompts = await makeClackPrompts(); prompts.intro("SubSwitch setup");
      const selected = await prompts.text({ message: "Proxy port", initialValue: port ?? String(DEFAULT_PORT), validate: value => PortSchema.safeParse(value).success ? undefined : "Use a port between 1 and 65535" });
      if (prompts.isCancel(selected)) { prompts.cancel("Setup cancelled"); process.exitCode = 1; return; }
      port = String(selected);
    }
    const { runCodexInit } = await import("./codex-init.js");
    const result = await runCodexInit({ client: command.client, dryRun: command.dryRun,
      ...(port === undefined ? {} : { port }), ...(command.flags.settingsTarget === undefined ? {} : { settingsTarget: command.flags.settingsTarget }),
    }, fsDeps, env, projectDir, out);
    if (!result.ok) fail(result.error.message);
    return;
  }

  // --dry-run: always use non-interactive planning path; no TTY check required
  // because it writes nothing — the fail-closed contract only protects writes. [F34]
  if (command.dryRun) {
    process.exitCode = await runInitDryRun(command.flags, projectDir, fsDeps, out, errOut);
    return;
  }

  const decision = resolveInitDispatch(
    process.stdin.isTTY === true,
    process.stdout.isTTY === true,
    "CI" in env,
    command.yes,
  );

  if (decision === "interactive") {
    const prompts = await makeClackPrompts();
    process.exitCode = await runInitInteractive(projectDir, fsDeps, env, prompts, command.flags);
  } else if (decision === "non-interactive") {
    process.exitCode = await runInitNonInteractive(command.flags, projectDir, fsDeps, out, errOut);
  } else {
    // refuse: non-TTY / CI without --yes — fail closed, no files written [F18]
    fail(
      "no interactive terminal detected. Re-run with --yes to accept defaults " +
        "(optionally with --port / --settings-target), or run in an interactive shell.",
    );
  }
};

// ---------------------------------------------------------------------------
// main — exhaustive switch with never guard
// ---------------------------------------------------------------------------

const main = async (): Promise<void> => {
  const parsed = parseCliArgs(process.argv.slice(2));
  if (!parsed.ok) {
    fail(parsed.error.message);
    return;
  }

  const command = parsed.value;

  switch (command.kind) {
    case "help":
      out(USAGE);
      return;

    case "version":
      out(SUBSWITCH_VERSION);
      return;

    case "init":
      await runInit(command);
      return;

    case "serve": {
      const configResult = loadConfig();
      if (!configResult.ok) {
        fail(configResult.error.message);
        return;
      }
      await serve(configResult.value, command.verbose, command.quiet, command.port);
      return;
    }

    case "doctor": {
      const configResult = loadConfig();
      if (!configResult.ok) {
        fail(configResult.error.message);
        return;
      }
      await doctor(configResult.value, command.client);
      return;
    }

    case "models": {
      const configResult = loadConfig();
      if (!configResult.ok) {
        fail(configResult.error.message);
        return;
      }
      // JSON branch returns before resolveColorEnabled — FORCE_COLOR cannot bleed into JSON. [7b]
      if (command.json) {
        if (command.schemaVersion === 3) { out(JSON.stringify(routingDiscovery(configResult.value.config, command.client))); return; }
        modelsJson(configResult.value, command.client);
        return;
      }
      models(configResult.value.config, command.client);
      return;
    }
    case "limits": {
      const loaded = command.port === undefined ? loadConfig() : undefined;
      const parsedPort = command.port === undefined ? { success: true, data: loaded?.ok ? loaded.value.config.port : DEFAULT_PORT } : PortSchema.safeParse(command.port);
      if (!parsedPort.success) { fail("invalid --port: expected an integer between 1 and 65535"); return; }
      const directory = limitDirectory(parsedPort.data!);
      const records = await readLimitObservations(directory);
      if (command.json) out(JSON.stringify({ schemaVersion: 1, directory, records }));
      else {
        out("Limit observations: " + directory);
        if (!records.length) out("No recorded upstream failures.");
        for (const record of records) out(record.observedAt + " " + record.context.product + " " + record.transport +
          " status=" + (record.status ?? "unknown") + " candidate=" + record.candidate + " body=" + record.bodyState);
        out("Use subswitch limits --json to inspect sanitized envelopes and reset/retry headers.");
      }
      return;
    }
    case "run-action": {
      const loaded = loadConfig(); if (!loaded.ok) { fail(loaded.error.message); return; }
      process.exitCode = await runAction(loaded.value.config, command.client, command.native, command.conversation);
      return;
    }

    default: {
      const _exhaustive: never = command;
      fail(`unreachable command: ${JSON.stringify(_exhaustive)}`);
    }
  }
};

// Any escaped rejection must still produce the clean `subswitch: <message>` contract
// on stderr rather than a raw Node stack trace.
void main().catch((cause: unknown) => {
  fail(cause instanceof Error ? cause.message : String(cause));
});
