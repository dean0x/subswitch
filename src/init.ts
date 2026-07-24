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

// ALL_CODEX_MODELS derives from the config constant — no duplicated literals.
export const ALL_CODEX_MODELS = DEFAULT_CODEX_MODELS;
export type CodexModelName = (typeof ALL_CODEX_MODELS)[number];

// ---------------------------------------------------------------------------
// Prompts seam — injectable for tests (A2.12) [F25/F4/F23]
// ---------------------------------------------------------------------------

interface TextOptions {
  readonly message: string;
  readonly placeholder?: string;
  readonly initialValue?: string;
  readonly validate?: (value: string) => string | undefined;
}

interface SelectOption {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
}

interface MultiselectOptions {
  readonly message: string;
  readonly options: ReadonlyArray<SelectOption>;
  readonly initialValues?: readonly string[];
}

interface SelectOptions {
  readonly message: string;
  readonly options: ReadonlyArray<SelectOption>;
  readonly initialValue?: string;
}

interface Spinner {
  start(msg: string): void;
  stop(msg: string): void;
}

/**
 * Abstraction seam for clack prompts — injectable for tests.
 * The real implementation (makeClackPrompts) lazy-imports @clack/prompts so
 * the heavy module is never loaded on non-interactive paths.
 */
export interface InitPrompts {
  intro(title: string): void;
  warn(message: string): void;
  text(opts: TextOptions): Promise<string | symbol>;
  multiselect(opts: MultiselectOptions): Promise<readonly string[] | symbol>;
  select(opts: SelectOptions): Promise<string | symbol>;
  isCancel(v: unknown): v is symbol;
  cancel(message: string): void;
  spinner(): Spinner;
  note(message: string, title?: string): void;
  outro(message: string): void;
}

/**
 * Factory: lazily imports @clack/prompts and adapts it as InitPrompts.
 * Lazy import means clack is NEVER loaded on non-interactive paths (doctor, serve,
 * help, version). Call only when actually entering the interactive path. [F25/F4/F23]
 *
 * @clack/prompts was compiled without exactOptionalPropertyTypes, so its optional
 * property types include `undefined` implicitly. We bridge with `as unknown` casts
 * at the call sites — this is intentional and locally contained to this factory.
 */
export const makeClackPrompts = async (): Promise<InitPrompts> => {
  const clack = await import("@clack/prompts");

  // Typed bridge: relax exactOptionalPropertyTypes at the clack boundary.
  // clack's types pre-date exactOptionalPropertyTypes, so optional props are
  // effectively `T | undefined`. We cast to `unknown` then to the clack type
  // to satisfy tsc without leaking `any` into our own interface. [boundary-validation]
  type ClackText = typeof clack.text;
  type ClackMultiselect = typeof clack.multiselect;
  type ClackSelect = typeof clack.select;

  const callText = clack.text as unknown as (o: unknown) => ReturnType<ClackText>;
  const callMultiselect = clack.multiselect as unknown as (o: unknown) => ReturnType<ClackMultiselect>;
  const callSelect = clack.select as unknown as (o: unknown) => ReturnType<ClackSelect>;

  return {
    intro: (title) => clack.intro(title),
    warn: (message) => clack.log.warn(message),
    text: (opts) =>
      callText({
        message: opts.message,
        ...(opts.placeholder !== undefined ? { placeholder: opts.placeholder } : {}),
        ...(opts.initialValue !== undefined ? { initialValue: opts.initialValue } : {}),
        ...(opts.validate !== undefined ? { validate: opts.validate } : {}),
      }) as Promise<string | symbol>,
    multiselect: (opts) =>
      callMultiselect({
        message: opts.message,
        options: opts.options.map((o) => ({
          value: o.value,
          label: o.label,
          ...(o.hint !== undefined ? { hint: o.hint } : {}),
        })),
        ...(opts.initialValues !== undefined ? { initialValues: [...opts.initialValues] } : {}),
      }) as Promise<readonly string[] | symbol>,
    select: (opts) =>
      callSelect({
        message: opts.message,
        options: opts.options.map((o) => ({
          value: o.value,
          label: o.label,
          ...(o.hint !== undefined ? { hint: o.hint } : {}),
        })),
        ...(opts.initialValue !== undefined ? { initialValue: opts.initialValue } : {}),
      }) as Promise<string | symbol>,
    isCancel: (v) => clack.isCancel(v),
    cancel: (message) => clack.cancel(message),
    spinner: () => {
      const s = clack.spinner();
      return { start: (m) => s.start(m), stop: (m) => s.stop(m) };
    },
    note: (message, title) => clack.note(message, title),
    outro: (message) => clack.outro(message),
  };
};

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
 * Parse `json` and assert it is a plain object.
 * Returns the parsed object on success, or a malformed_json error referencing `path`.
 * Shared by planSettingsWrite and planConfigWrite.
 */
const parseExistingJson = (json: string, path: string): Result<Record<string, unknown>, InitError> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return err({ kind: "malformed_json", message: `${path}: malformed JSON — fix or delete this file and run init again` });
  }
  if (!isPlainObject(parsed)) {
    return err({ kind: "malformed_json", message: `${path}: expected a JSON object — fix or delete this file and run init again` });
  }
  return ok(parsed);
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
    const parseResult = parseExistingJson(existingJson, path);
    if (!parseResult.ok) return err(parseResult.error);
    existing = parseResult.value;
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
    const parseResult = parseExistingJson(existingJson, path);
    if (!parseResult.ok) return err(parseResult.error);
    existing = parseResult.value;
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
    // Deduplicate, preserving first-occurrence order — the two model flags are
    // documented as "combined and deduplicated" (README CLI reference). [F16/F17]
    const deduped = [...new Set(filtered)];
    if (deduped.length === 0) {
      // Model flags were given but resolved to nothing (e.g. --codex-models "").
      return err({
        kind: "invalid_input",
        message: `invalid --codex-models "${flags.codexModels ?? ""}": at least one model is required`,
      });
    }
    resolvedModels = deduped;
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
// Interactive path (clack wizard) — only called when TTY is available (A2.12-15)
// ---------------------------------------------------------------------------

/**
 * Seed values for the interactive wizard, derived from flags and any existing
 * subswitch.config.json. Returns plain values ready to pass as initialValue(s)
 * to prompts. All fields are always defined (defaults fill any gaps).
 */
const seedWizard = async (
  flags: InitFlags,
  deps: InitFsDeps,
  projectDir: string,
): Promise<{
  readonly portSeed: string;
  readonly modelsSeed: readonly string[];
  readonly settingsTargetSeed: string;
}> => {
  // Try to read existing config for seeding — ignore read/parse errors here;
  // the real planning step (executeInit → planConfigWrite) will report them.
  const configPath = join(projectDir, "subswitch.config.json");
  let existingPort: number | undefined;
  let existingModels: readonly string[] | undefined;
  try {
    const existingJson = await deps.readFile(configPath);
    if (existingJson !== null) {
      const parsed: unknown = JSON.parse(existingJson);
      if (isPlainObject(parsed)) {
        if (typeof parsed["port"] === "number") existingPort = parsed["port"];
        const codex = parsed["codex"];
        if (isPlainObject(codex) && Array.isArray(codex["models"])) {
          const models = (codex["models"] as unknown[]).filter(
            (m): m is string => typeof m === "string" && m.length > 0,
          );
          if (models.length > 0) existingModels = models;
        }
      }
    }
  } catch {
    // Silently ignore — seeding is best-effort; planning catches real errors.
  }

  // Port: flags → existing config → default
  let portSeed: string;
  if (flags.port !== undefined) {
    portSeed = flags.port;
  } else if (existingPort !== undefined) {
    portSeed = String(existingPort);
  } else {
    portSeed = String(DEFAULT_PORT);
  }

  // Models: flags → existing config → all defaults [F1]
  let modelsSeed: readonly string[];
  const hasModelFlags = flags.codexModel !== undefined || flags.codexModels !== undefined;
  if (hasModelFlags) {
    const merged: string[] = [...(flags.codexModel ?? [])];
    if (flags.codexModels !== undefined && flags.codexModels !== "") {
      merged.push(...flags.codexModels.split(",").map((s) => s.trim()).filter((s) => s.length > 0));
    }
    modelsSeed = merged.length > 0 ? merged : ALL_CODEX_MODELS;
  } else if (existingModels !== undefined) {
    modelsSeed = existingModels;
  } else {
    modelsSeed = ALL_CODEX_MODELS;
  }

  // Settings target: flags → default (no config file source for this one)
  const settingsTargetSeed = flags.settingsTarget ?? "local";

  return { portSeed, modelsSeed, settingsTargetSeed };
};

/**
 * Run the interactive init wizard.
 *
 * Returns exit code: 0 on success, 1 on cancel / empty selection / write failure.
 * Callers (cli.ts) must assign `process.exitCode = exitCode` — this function
 * does not mutate process state. [F18]
 *
 * Cancel at ANY prompt → return 1 with zero writes.
 * Empty multiselect selection → return 1 with zero writes.
 * Write failure → return 1.
 */
export const runInitInteractive = async (
  projectDir: string,
  deps: InitFsDeps,
  env: Record<string, string | undefined>,
  prompts: InitPrompts,
  flags: InitFlags = {},
): Promise<number> => {
  // Helper: await a prompt, cancel on symbol. [F23 — eliminates duplicated isCancel guards]
  const prompt = async <T>(p: Promise<T | symbol>): Promise<{ readonly v: T } | null> => {
    const r = await p;
    if (prompts.isCancel(r)) {
      prompts.cancel("Setup cancelled — no files written.");
      return null;
    }
    return { v: r as T };
  };

  prompts.intro("subswitch init — interactive setup");

  // --- Precondition checks --- [F13]
  const authFilePath = join(homedir(), ".codex", "auth.json");
  const warnings = collectPreconditionWarnings(env, deps.exists(authFilePath), authFilePath);
  for (const w of warnings) {
    prompts.warn(w);
  }

  // --- Seed from flags → existing config → defaults --- [F1]
  const { portSeed, modelsSeed, settingsTargetSeed } = await seedWizard(flags, deps, projectDir);

  // --- Port ---
  const portResult = await prompt<string>(
    prompts.text({
      message: "Proxy port",
      placeholder: String(DEFAULT_PORT),
      initialValue: portSeed,
      validate(value) {
        const r = PortSchema.safeParse(value);
        return r.success ? undefined : `invalid port: ${r.error.issues.map((i) => i.message).join("; ")}`;
      },
    }),
  );
  if (portResult === null) return 1;

  // safeParse — never throw in business logic [F54]
  const portParsed = PortSchema.safeParse(portResult.v);
  if (!portParsed.success) {
    prompts.cancel("Invalid port — no files written.");
    return 1;
  }
  const port = portParsed.data;

  // --- Codex models ---
  // Build options: all known models first, then any extra models from flags/existing config
  // that are not in ALL_CODEX_MODELS. This ensures a custom/forward-compat model that is
  // already in the config appears as a selectable option and can be preselected. [self-review P2]
  const knownModelSet = new Set<string>(ALL_CODEX_MODELS);
  const extraModelOptions = modelsSeed.filter((m) => !knownModelSet.has(m));
  const allModelsForOptions = [...ALL_CODEX_MODELS, ...extraModelOptions];
  const extraModelSet = new Set<string>(extraModelOptions);
  const modelOptions: SelectOption[] = allModelsForOptions.map((m) => ({
    value: m,
    label: m,
    ...(m === "gpt-5.6-sol"
      ? { hint: "recommended fast model" }
      : extraModelSet.has(m)
      ? { hint: "(custom)" }
      : {}),
  }));

  const modelsResult = await prompt<readonly string[]>(
    prompts.multiselect({
      message: "Which Codex models should subswitch route?",
      options: modelOptions,
      initialValues: [...modelsSeed],
    }),
  );
  if (modelsResult === null) return 1;

  const selectedModels = modelsResult.v;
  if (selectedModels.length === 0) {
    prompts.cancel("At least one model must be selected — no files written.");
    return 1;
  }

  // --- Settings target ---
  const settingsResult = await prompt<string>(
    prompts.select({
      message: "Where should ANTHROPIC_BASE_URL be written?",
      options: [
        {
          value: "local",
          label: ".claude/settings.local.json",
          hint: "gitignored — recommended for per-developer setup",
        },
        {
          value: "shared",
          label: ".claude/settings.json",
          hint: "shared — all team members get the proxy wiring",
        },
      ],
      initialValue: settingsTargetSeed,
    }),
  );
  if (settingsResult === null) return 1;

  const targetParsed = SettingsTargetSchema.safeParse(settingsResult.v);
  if (!targetParsed.success) {
    prompts.cancel("Invalid settings target — no files written.");
    return 1;
  }
  const settingsTarget = targetParsed.data;

  const options: InitOptions = {
    port,
    codexModels: selectedModels,
    settingsTarget,
  };

  // --- Write files ---
  const spinner = prompts.spinner();
  spinner.start("Writing files…");

  const result = await executeInit(options, deps, projectDir);

  if (!result.ok) {
    spinner.stop("Write failed.");
    prompts.warn(result.error.message);
    prompts.outro("Setup incomplete — see error above.");
    return 1;
  }

  spinner.stop("Files written.");

  // --- Outro summary --- [F13/F54]
  const [configFile, settingsFile] = result.value;
  prompts.note(
    [
      `Written: ${configFile}`,
      `Written: ${settingsFile}`,
      "",
      `Next steps:`,
      `  1. Run \`subswitch serve\` from ${projectDir}`,
      `     (subswitch.config.json is resolved from the working directory)`,
      `  2. Run \`subswitch doctor\` to verify config + codex auth health`,
      `  3. Restart any running Claude Code session to pick up ANTHROPIC_BASE_URL`,
      `  4. Route a subagent to Codex by adding to its frontmatter:`,
      `       model: gpt-5.6-sol   # any of: ${options.codexModels.join(", ")}`,
      `       effort: low           # optional reasoning effort`,
    ].join("\n"),
    "Setup complete",
  );

  prompts.outro(`subswitch is ready — point Claude Code at http://127.0.0.1:${port}`);
  return 0;
};

// ---------------------------------------------------------------------------
// Dry-run path (A2.17) — plans but writes nothing; allowed without --yes
// ---------------------------------------------------------------------------

/**
 * Compute both write plans and print what would be written to stdout.
 * Writes NOTHING. Always exits 0 on success (even in non-TTY / CI). [F34]
 */
export const runInitDryRun = async (
  flags: InitFlags,
  projectDir: string,
  deps: InitFsDeps,
  write: (line: string) => void,
  errWrite: (line: string) => void,
): Promise<number> => {
  const optionsResult = resolveOptionsFromFlags(flags);
  if (!optionsResult.ok) {
    errWrite(`subswitch init --dry-run: ${optionsResult.error.message}`);
    return 1;
  }

  const options = optionsResult.value;

  // Forward-compat warning for unknown model names (non-fatal). [F32]
  // Parity with runInitNonInteractive — both non-interactive paths emit this warning. [self-review P2]
  const knownDryRunModels: ReadonlyArray<string> = ALL_CODEX_MODELS;
  for (const model of options.codexModels) {
    if (!knownDryRunModels.includes(model)) {
      errWrite(
        `warning: model "${model}" is not in the known list (${ALL_CODEX_MODELS.join(", ")}) — proceeding anyway`,
      );
    }
  }

  const configPath = join(projectDir, "subswitch.config.json");
  const settingsPath = settingsPathFor(options.settingsTarget, projectDir);

  const existingConfigJson = await deps.readFile(configPath);
  const existingSettingsJson = await deps.readFile(settingsPath);

  const configPlan = planConfigWrite(existingConfigJson, options.port, options.codexModels, projectDir);
  if (!configPlan.ok) {
    errWrite(`subswitch init --dry-run: ${configPlan.error.message}`);
    return 1;
  }

  const settingsPlan = planSettingsWrite(existingSettingsJson, options.port, options.settingsTarget, projectDir);
  if (!settingsPlan.ok) {
    errWrite(`subswitch init --dry-run: ${settingsPlan.error.message}`);
    return 1;
  }

  write("[dry-run] No files written.");
  write(`[dry-run] Would write ${configPlan.value.path}:`);
  write(configPlan.value.content.trimEnd());
  write(`[dry-run] Would write ${settingsPlan.value.path}:`);
  write(settingsPlan.value.content.trimEnd());
  return 0;
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

  // Forward-compat warning for unknown model names (non-fatal). [F32]
  const knownModels: ReadonlyArray<string> = ALL_CODEX_MODELS;
  for (const model of optionsResult.value.codexModels) {
    if (!knownModels.includes(model)) {
      errWrite(
        `warning: model "${model}" is not in the known list (${ALL_CODEX_MODELS.join(", ")}) — proceeding anyway`,
      );
    }
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
  write(`      run \`subswitch doctor\` to verify config + codex auth health`);
  write(
    `      add \`model: ${optionsResult.value.codexModels[0] ?? "gpt-5.6-sol"}\` to a subagent's frontmatter to route it`,
  );
  return 0;
};
