import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { type Result, ok, err } from "./result.js";

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

export const ALL_CODEX_MODELS = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"] as const;
export type CodexModelName = (typeof ALL_CODEX_MODELS)[number];

// ---------------------------------------------------------------------------
// Pure planning (no side effects — unit-testable)
// ---------------------------------------------------------------------------

export interface SettingsWritePlan {
  readonly path: string;
  readonly content: string;
}

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
  const filename =
    settingsTarget === "local" ? ".claude/settings.local.json" : ".claude/settings.json";
  const path = join(projectDir, filename);
  const baseUrl = `http://127.0.0.1:${port}`;

  let existing: Record<string, unknown> = {};
  if (existingJson !== null) {
    try {
      const parsed = JSON.parse(existingJson) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return err({
          kind: "malformed_json",
          message: `${path}: expected a JSON object — fix or delete this file and run init again`,
        });
      }
      existing = parsed as Record<string, unknown>;
    } catch {
      return err({
        kind: "malformed_json",
        message: `${path}: malformed JSON — fix or delete this file and run init again`,
      });
    }
  }

  // Merge ONLY env.ANTHROPIC_BASE_URL — preserve all other keys untouched.
  const existingEnv =
    typeof existing["env"] === "object" &&
    existing["env"] !== null &&
    !Array.isArray(existing["env"])
      ? (existing["env"] as Record<string, unknown>)
      : {};

  const merged: Record<string, unknown> = {
    ...existing,
    env: { ...existingEnv, ANTHROPIC_BASE_URL: baseUrl },
  };

  return ok({ path, content: `${JSON.stringify(merged, null, 2)}\n` });
};

/**
 * Pure: build the subswitch.config.json content.
 */
export const buildSubswitchConfig = (port: number, codexModels: readonly string[]): string =>
  `${JSON.stringify({ port, codex: { models: [...codexModels] } }, null, 2)}\n`;

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
  /** Current working directory for subswitch.config.json. */
  readonly cwd: string;
}

export const makeRealFsDeps = (): InitFsDeps => ({
  readFile: async (path: string): Promise<string | null> => {
    try {
      return await readFile(path, "utf8");
    } catch (e) {
      if (e instanceof Error && (e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  },
  writeFile: async (path: string, content: string): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  },
  exists: (path: string): boolean => existsSync(path),
  cwd: process.cwd(),
});

/**
 * Execute the init plan: write settings file + subswitch.config.json.
 * Returns the list of files written on success.
 */
export const executeInit = async (
  options: InitOptions,
  deps: InitFsDeps,
  projectDir: string,
): Promise<Result<readonly string[], InitError>> => {
  // 1. Plan the settings file write.
  const settingsPath =
    options.settingsTarget === "local"
      ? join(projectDir, ".claude/settings.local.json")
      : join(projectDir, ".claude/settings.json");

  let existingJson: string | null = null;
  try {
    existingJson = await deps.readFile(settingsPath);
  } catch (e) {
    return err({
      kind: "write_error",
      message: `cannot read ${settingsPath}: ${String(e)}`,
    });
  }

  const settingsPlan = planSettingsWrite(existingJson, options.port, options.settingsTarget, projectDir);
  if (!settingsPlan.ok) return err(settingsPlan.error);

  // 2. Build the subswitch.config.json content.
  const configPath = join(deps.cwd, "subswitch.config.json");
  const configContent = buildSubswitchConfig(options.port, options.codexModels);

  // 3. Write both files (no partial writes — plan phase catches all validation errors above).
  try {
    await deps.writeFile(settingsPlan.value.path, settingsPlan.value.content);
    await deps.writeFile(configPath, configContent);
  } catch (e) {
    return err({
      kind: "write_error",
      message: `file write failed: ${String(e)}`,
    });
  }

  return ok([settingsPlan.value.path, configPath]);
};

// ---------------------------------------------------------------------------
// Non-interactive path (from flags + defaults)
// ---------------------------------------------------------------------------

export interface InitFlags {
  readonly port?: string;
  readonly codexModels?: readonly string[];
  readonly settingsTarget?: string;
}

export const resolveOptionsFromFlags = (flags: InitFlags): Result<InitOptions, InitError> => {
  // Validate port.
  const rawPort = flags.port ?? "4141";
  const portResult = PortSchema.safeParse(rawPort);
  if (!portResult.success) {
    return err({
      kind: "invalid_input",
      message: `invalid --port "${rawPort}": ${portResult.error.issues.map((i) => i.message).join("; ")}`,
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

  // Validate codex-models.
  const rawModels = flags.codexModels ?? ALL_CODEX_MODELS;
  if (rawModels.length === 0) {
    return err({ kind: "invalid_input", message: "--codex-models: at least one model is required" });
  }
  const models = rawModels.map((m) => m.trim()).filter((m) => m.length > 0);
  if (models.length === 0) {
    return err({ kind: "invalid_input", message: "--codex-models: at least one non-empty model is required" });
  }

  return ok({
    port: portResult.data,
    codexModels: models,
    settingsTarget: targetResult.data,
  });
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
  if (env["ANTHROPIC_API_KEY"] !== undefined && env["ANTHROPIC_API_KEY"] !== "") {
    clack.log.warn(
      "ANTHROPIC_API_KEY is set. This variable breaks claude.ai subscription auth in Claude Code.\n" +
        "  Unset it before starting Claude Code to avoid auth errors.",
    );
  }

  const authFile = join(
    env["HOME"] ?? (process.env["HOME"] ?? "~"),
    ".codex",
    "auth.json",
  );
  if (!deps.exists(authFile)) {
    clack.log.warn(
      `Codex auth file not found at ${authFile}.\n` +
        "  Run \`codex login\` first to authenticate your Codex subscription.",
    );
  }

  // --- Port ---
  const portInput = await clack.text({
    message: "Proxy port",
    placeholder: "4141",
    initialValue: "4141",
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
  const [settingsFile, configFile] = result.value;
  clack.note(
    [
      `Written: ${settingsFile ?? "(settings file)"}`,
      `Written: ${configFile ?? "(config file)"}`,
      "",
      `Next steps:`,
      `  1. Run \`subswitch serve\` from ${deps.cwd}`,
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
): Promise<number> => {
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

  const [settingsFile, configFile] = result.value;
  write(`Written: ${settingsFile ?? "(settings file)"}`);
  write(`Written: ${configFile ?? "(config file)"}`);
  write(`Next: run \`subswitch serve\` from ${deps.cwd}`);
  write(`      add \`model: ${optionsResult.value.codexModels[0] ?? "gpt-5.6-sol"}\` to a subagent's frontmatter to route it`);
  return 0;
};
