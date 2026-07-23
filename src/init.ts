import { mkdir, readFile as fsReadFile, writeFile as fsWriteFile, rename as fsRename, unlink as fsUnlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { type Result, ok, err } from "./result.js";
import { DEFAULT_PORT, DEFAULT_CODEX_MODELS } from "./config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SettingsTarget = "local" | "shared";

export interface InitOptions {
  readonly port: number;
  readonly codexModels: readonly string[];
  readonly settingsTarget: SettingsTarget;
}

export type InitError =
  | { readonly kind: "malformed_json"; readonly message: string }
  | { readonly kind: "invalid_input"; readonly message: string }
  | { readonly kind: "write_error"; readonly message: string };

// ---------------------------------------------------------------------------
// Validation schemas (parse at boundaries)
// ---------------------------------------------------------------------------

export const PortSchema = z.coerce.number().int().min(1).max(65535, { message: "port must be between 1 and 65535" });

export const SettingsTargetSchema = z.enum(["local", "shared"]);

// ---------------------------------------------------------------------------
// Plain-object guard (used in all JSON object checks)
// ---------------------------------------------------------------------------

export const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// ---------------------------------------------------------------------------
// Init dispatch decision (pure — injectable for tests)
// ---------------------------------------------------------------------------

export type InitDispatchDecision = "interactive" | "non-interactive" | "refuse";

/**
 * Pure: determine which init path to take based on terminal/environment state.
 * - "interactive": both TTYs present, no CI env, no --yes → run the clack wizard.
 * - "non-interactive": --yes is set (anywhere) → run the non-interactive writer.
 * - "refuse": non-TTY / CI without explicit --yes → fail closed; caller must not write files.
 */
export const resolveInitDispatch = (
  stdinIsTTY: boolean,
  stdoutIsTTY: boolean,
  hasCIEnv: boolean,
  yesFlag: boolean,
): InitDispatchDecision => {
  if (stdinIsTTY && stdoutIsTTY && !hasCIEnv && !yesFlag) return "interactive";
  if (yesFlag) return "non-interactive";
  return "refuse";
};

// ALL_CODEX_MODELS derives from the config constant — no duplicated literals [F10].
export const ALL_CODEX_MODELS = DEFAULT_CODEX_MODELS;
export type CodexModelName = (typeof ALL_CODEX_MODELS)[number];

// ---------------------------------------------------------------------------
// Pure planning (no side effects — unit-testable)
// ---------------------------------------------------------------------------

export interface SettingsWritePlan {
  readonly path: string;
  readonly content: string;
}

export interface ConfigWritePlan {
  readonly path: string;
  readonly content: string;
}

/**
 * Single source of truth for the Claude settings file path.
 * Used by planSettingsWrite and executeInit to avoid drift.
 */
export const settingsPathFor = (target: SettingsTarget, projectDir: string): string => {
  const filename = target === "local" ? ".claude/settings.local.json" : ".claude/settings.json";
  return join(projectDir, filename);
};

/**
 * Pure: merge ANTHROPIC_BASE_URL into an existing (or absent) settings JSON file.
 * Preserves all other keys. Fails on malformed JSON.
 * No side effects — callers supply the current file content.
 */
export const planSettingsWrite = (
  existingJson: string | null,
  port: number,
  settingsTarget: SettingsTarget,
  projectDir: string,
): Result<SettingsWritePlan, InitError> => {
  const path = settingsPathFor(settingsTarget, projectDir);
  const baseUrl = `http://127.0.0.1:${port}`;

  let existing: Record<string, unknown> = {};
  if (existingJson !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existingJson);
    } catch {
      return err({
        kind: "malformed_json",
        message: `${path}: malformed JSON — fix or delete this file and run init again`,
      });
    }
    if (!isPlainObject(parsed)) {
      return err({
        kind: "malformed_json",
        message: `${path}: expected a JSON object — fix or delete this file and run init again`,
      });
    }
    existing = parsed;
  }

  // Merge ONLY env.ANTHROPIC_BASE_URL — preserve all other keys untouched.
  const existingEnv = isPlainObject(existing["env"]) ? existing["env"] : {};

  const merged: Record<string, unknown> = {
    ...existing,
    env: { ...existingEnv, ANTHROPIC_BASE_URL: baseUrl },
  };

  return ok({ path, content: `${JSON.stringify(merged, null, 2)}\n` });
};

/**
 * Pure: merge port and codex.models into an existing (or absent) subswitch.config.json.
 * Preserves every other top-level key and every other codex.* key.
 * Fails on malformed JSON or non-object input.
 * No side effects — callers supply the current file content.
 */
export const planConfigWrite = (
  existingJson: string | null,
  port: number,
  models: readonly string[],
  projectDir: string,
): Result<ConfigWritePlan, InitError> => {
  const path = join(projectDir, "subswitch.config.json");

  let existing: Record<string, unknown> = {};
  if (existingJson !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existingJson);
    } catch {
      return err({
        kind: "malformed_json",
        message: `${path}: malformed JSON — fix or delete this file and run init again`,
      });
    }
    if (!isPlainObject(parsed)) {
      return err({
        kind: "malformed_json",
        message: `${path}: expected a JSON object — fix or delete this file and run init again`,
      });
    }
    existing = parsed;
  }

  // Preserve all codex.* keys except models (deep merge).
  const existingCodex = isPlainObject(existing["codex"]) ? existing["codex"] : {};

  const merged: Record<string, unknown> = {
    ...existing,
    port,
    codex: {
      ...existingCodex,
      models: [...models],
    },
  };

  return ok({ path, content: `${JSON.stringify(merged, null, 2)}\n` });
};

// ---------------------------------------------------------------------------
// Effectful write (injectable fs deps for tests)
// ---------------------------------------------------------------------------

export interface InitFsDeps {
  /** Read file; returns null on ENOENT, throws on other errors. */
  readonly readFile: (path: string) => Promise<string | null>;
  /** Write file atomically (creates parent directories first). */
  readonly writeFile: (path: string, content: string) => Promise<void>;
  /** Returns true if path exists. */
  readonly exists: (path: string) => boolean;
}

export const makeRealFsDeps = (): InitFsDeps => ({
  readFile: async (path: string): Promise<string | null> => {
    try {
      return await fsReadFile(path, "utf8");
    } catch (e) {
      if (e instanceof Error && (e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  },
  writeFile: async (path: string, content: string): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    // Atomic write: write to a temp file then rename over the target so a
    // crash mid-write never leaves a partially-written config. [F2]
    const tmp = `${path}.tmp.${process.pid}`;
    try {
      await fsWriteFile(tmp, content, "utf8");
      await fsRename(tmp, path);
    } catch (e) {
      try { await fsUnlink(tmp); } catch { /* ignore cleanup error */ }
      throw e;
    }
  },
  exists: (path: string): boolean => existsSync(path),
});

/**
 * Execute the init plan: write subswitch.config.json then the settings file.
 *
 * Write order is config-first: a dangling settings pointer (ANTHROPIC_BASE_URL
 * pointing at a port with no config) is the harmful partial state. [F1/F50]
 *
 * Returns [configPath, settingsPath] on success.
 * If either plan fails, nothing is written.
 */
export const executeInit = async (
  options: InitOptions,
  deps: InitFsDeps,
  projectDir: string,
): Promise<Result<readonly [string, string], InitError>> => {
  const configPath = join(projectDir, "subswitch.config.json");
  const settingsPath = settingsPathFor(options.settingsTarget, projectDir);

  // 1. Read both existing files (all reads before any write).
  let existingConfigJson: string | null;
  let existingSettingsJson: string | null;
  try {
    existingConfigJson = await deps.readFile(configPath);
  } catch (e) {
    return err({ kind: "write_error", message: `cannot read ${configPath}: ${String(e)}` });
  }
  try {
    existingSettingsJson = await deps.readFile(settingsPath);
  } catch (e) {
    return err({ kind: "write_error", message: `cannot read ${settingsPath}: ${String(e)}` });
  }

  // 2. Plan both writes (pure — if either fails, nothing is written).
  const configPlan = planConfigWrite(existingConfigJson, options.port, options.codexModels, projectDir);
  if (!configPlan.ok) return err(configPlan.error);

  const settingsPlan = planSettingsWrite(existingSettingsJson, options.port, options.settingsTarget, projectDir);
  if (!settingsPlan.ok) return err(settingsPlan.error);

  // 3. Write: config before settings (config-first order). [F6]
  try {
    await deps.writeFile(configPlan.value.path, configPlan.value.content);
    await deps.writeFile(settingsPlan.value.path, settingsPlan.value.content);
  } catch (e) {
    return err({ kind: "write_error", message: `file write failed: ${String(e)}` });
  }

  return ok([configPlan.value.path, settingsPlan.value.path] as const);
};

// ---------------------------------------------------------------------------
// Non-interactive path (from flags + defaults)
// ---------------------------------------------------------------------------

/**
 * Raw CLI flag shape as produced by parseArgs.
 *
 * - codexModel: from --codex-model (multiple, repeatable)
 * - codexModels: from --codex-models (single CSV string)
 * Merging and normalisation happen inside resolveOptionsFromFlags. [F11]
 */
export interface InitFlags {
  readonly port?: string;
  readonly codexModel?: readonly string[];
  readonly codexModels?: string;
  readonly settingsTarget?: string;
}

export const resolveOptionsFromFlags = (flags: InitFlags): Result<InitOptions, InitError> => {
  // Validate port.
  const rawPort = flags.port ?? String(DEFAULT_PORT);
  const portResult = PortSchema.safeParse(rawPort);
  if (!portResult.success) {
    return err({
      kind: "invalid_input",
      message: `invalid --port "${rawPort}": port must be an integer between 1 and 65535`,
    });
  }

  // Validate settings-target.
  const rawTarget = flags.settingsTarget ?? "local";
  const targetResult = SettingsTargetSchema.safeParse(rawTarget);
  if (!targetResult.success) {
    return err({
      kind: "invalid_input",
      message: `invalid --settings-target "${rawTarget}": must be "local" or "shared"`,
    });
  }

  // Merge codex model flags.
  // Distinguish "no model flags at all → use defaults" from
  // "model flags given but resolve to empty → error" so --codex-models ""
  // is always an error. [F16/F17/F35]
  const hasModelFlags = flags.codexModel !== undefined || flags.codexModels !== undefined;

  let resolvedModels: readonly string[];
  if (!hasModelFlags) {
    // No model flags provided — default to ALL_CODEX_MODELS.
    resolvedModels = DEFAULT_CODEX_MODELS;
  } else {
    const merged: string[] = [...(flags.codexModel ?? [])];
    if (flags.codexModels !== undefined && flags.codexModels !== "") {
      merged.push(...flags.codexModels.split(",").map((s) => s.trim()).filter((s) => s.length > 0));
    }
    const filtered = merged.map((m) => m.trim()).filter((m) => m.length > 0);
    if (filtered.length === 0) {
      // Model flags were given but resolved to nothing (e.g. --codex-models "").
      return err({
        kind: "invalid_input",
        message: `invalid --codex-models "${flags.codexModels ?? ""}": at least one model is required`,
      });
    }
    resolvedModels = filtered;
  }

  return ok({
    port: portResult.data,
    codexModels: resolvedModels,
    settingsTarget: targetResult.data,
  });
};

// ---------------------------------------------------------------------------
// Precondition warnings (pure — injectable for tests)
// ---------------------------------------------------------------------------

/**
 * Pure: collect warning strings for known precondition problems.
 * Auth path must be computed from homedir() by the caller, not env.HOME
 * (env.HOME is undefined on Windows). [F12/F13]
 */
export const collectPreconditionWarnings = (
  env: Record<string, string | undefined>,
  authFileExists: boolean,
  authFilePath: string,
): string[] => {
  const warnings: string[] = [];
  if (env["ANTHROPIC_API_KEY"] !== undefined && env["ANTHROPIC_API_KEY"] !== "") {
    warnings.push(
      "ANTHROPIC_API_KEY is set. This variable breaks claude.ai subscription auth in Claude Code.\n" +
        "  Unset it before starting Claude Code to avoid auth errors.",
    );
  }
  if (!authFileExists) {
    warnings.push(
      `Codex auth file not found at ${authFilePath}.\n` +
        "  Run `codex login` first to authenticate your Codex subscription.",
    );
  }
  return warnings;
};

// ---------------------------------------------------------------------------
// Interactive path (clack wizard) — only called when TTY is available
// ---------------------------------------------------------------------------

export const runInitInteractive = async (
  projectDir: string,
  deps: InitFsDeps,
  env: Record<string, string | undefined>,
): Promise<void> => {
  // Lazy import so clack is only loaded when needed.
  const clack = await import("@clack/prompts");

  clack.intro("subswitch init — interactive setup");

  // --- Precondition checks ---
  const authFilePath = join(homedir(), ".codex", "auth.json");
  const warnings = collectPreconditionWarnings(env, deps.exists(authFilePath), authFilePath);
  for (const warning of warnings) {
    clack.log.warn(warning);
  }

  // --- Port ---
  const portInput = await clack.text({
    message: "Proxy port",
    placeholder: String(DEFAULT_PORT),
    initialValue: String(DEFAULT_PORT),
    validate(value) {
      const r = PortSchema.safeParse(value);
      return r.success ? undefined : `invalid port: ${r.error.issues.map((i) => i.message).join("; ")}`;
    },
  });
  if (clack.isCancel(portInput)) {
    clack.cancel("Setup cancelled — no files written.");
    return;
  }
  const port = PortSchema.parse(portInput as string);

  // --- Codex models ---
  const modelOptions = ALL_CODEX_MODELS.map((m) =>
    m === "gpt-5.6-sol"
      ? { value: m, label: m, hint: "recommended fast model" }
      : { value: m, label: m },
  );
  const selectedModels = await clack.multiselect<string>({
    message: "Which Codex models should subswitch route?",
    options: modelOptions,
    initialValues: [...ALL_CODEX_MODELS],
  });
  if (clack.isCancel(selectedModels)) {
    clack.cancel("Setup cancelled — no files written.");
    return;
  }
  if ((selectedModels as string[]).length === 0) {
    clack.cancel("At least one model must be selected — no files written.");
    return;
  }

  // --- Settings target ---
  const settingsTargetInput = await clack.select<SettingsTarget>({
    message: "Where should ANTHROPIC_BASE_URL be written?",
    options: [
      {
        value: "local" as SettingsTarget,
        label: ".claude/settings.local.json",
        hint: "gitignored — recommended for per-developer setup",
      },
      {
        value: "shared" as SettingsTarget,
        label: ".claude/settings.json",
        hint: "shared — all team members get the proxy wiring",
      },
    ],
  });
  if (clack.isCancel(settingsTargetInput)) {
    clack.cancel("Setup cancelled — no files written.");
    return;
  }

  const options: InitOptions = {
    port,
    codexModels: selectedModels as string[],
    settingsTarget: settingsTargetInput as SettingsTarget,
  };

  // --- Write files ---
  const spinner = clack.spinner();
  spinner.start("Writing files…");

  const result = await executeInit(options, deps, projectDir);

  if (!result.ok) {
    spinner.stop("Write failed.");
    clack.log.error(result.error.message);
    clack.outro("Setup incomplete — see error above.");
    process.exitCode = 1;
    return;
  }

  spinner.stop("Files written.");

  // --- Outro summary ---
  const [configFile, settingsFile] = result.value;
  clack.note(
    [
      `Written: ${configFile}`,
      `Written: ${settingsFile}`,
      "",
      `Next steps:`,
      `  1. Run \`subswitch serve\` from ${projectDir}`,
      `     (subswitch.config.json is resolved from the working directory)`,
      `  2. Run \`subswitch doctor\` to verify config + codex auth health`,
      `  3. Route a subagent to Codex by adding to its frontmatter:`,
      `       model: gpt-5.6-sol   # any of: ${options.codexModels.join(", ")}`,
      `       effort: low           # optional reasoning effort`,
    ].join("\n"),
    "Setup complete",
  );

  clack.outro(`subswitch is ready — point Claude Code at http://127.0.0.1:${port}`);
};

// ---------------------------------------------------------------------------
// Non-interactive runner (prints to provided write fn, returns exit code)
// ---------------------------------------------------------------------------

export const runInitNonInteractive = async (
  flags: InitFlags,
  projectDir: string,
  deps: InitFsDeps,
  write: (line: string) => void,
  errWrite: (line: string) => void,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): Promise<number> => {
  // Emit precondition warnings before resolving options. [F12/F13]
  const authFilePath = join(homedir(), ".codex", "auth.json");
  const warnings = collectPreconditionWarnings(env, deps.exists(authFilePath), authFilePath);
  for (const w of warnings) {
    errWrite(`warning: ${w}`);
  }

  const optionsResult = resolveOptionsFromFlags(flags);
  if (!optionsResult.ok) {
    errWrite(`subswitch init: ${optionsResult.error.message}`);
    return 1;
  }

  const result = await executeInit(optionsResult.value, deps, projectDir);
  if (!result.ok) {
    errWrite(`subswitch init: ${result.error.message}`);
    return 1;
  }

  const [configFile, settingsFile] = result.value;
  write(`Written: ${configFile}`);
  write(`Written: ${settingsFile}`);
  write(`Next: run \`subswitch serve\` from ${projectDir}`);
  write(`      add \`model: ${optionsResult.value.codexModels[0] ?? "gpt-5.6-sol"}\` to a subagent's frontmatter to route it`);
  return 0;
};
