---
feature: cli-ux
name: CLI / init command / terminal UX
description: "Use when modifying the CLI entry point, init wizard, doctor preflight command, logger output format, models alias table, or any terminal UX concern (colors, TTY detection, FORCE_COLOR, dry-run, CI safety). Keywords: cli, parseArgs, CliCommand, init, doctor, models, logger, clack, picocolors, TTY, NO_COLOR, FORCE_COLOR, interactive, non-interactive, dry-run, smoke-tarball, tty.ts, models.ts, agent-scan."
category: architecture
directories: [src/cli.ts, src/init.ts, src/doctor.ts, src/logger.ts, src/tty.ts, src/models.ts, src/agent-scan.ts, src/config.ts]
created: 2026-07-23
updated: 2026-07-26
---

# CLI / init command / terminal UX

## Overview

This knowledge base covers the full user-facing surface of subswitch: the CLI entry point (`src/cli.ts`), the `init` wizard (`src/init.ts`), the `doctor` preflight command (`src/doctor.ts`), the structured logger (`src/logger.ts`), and the single color-resolution utility (`src/tty.ts`). As of the model-family-aliases feature, `src/models.ts` (pure model registry) and `src/agent-scan.ts` (doctor's frontmatter scanner) are tightly coupled to the CLI surface.

These files share three cross-cutting contracts that are easy to break silently: the non-interactive safety guarantee in `init`, the closed-field redaction guarantee in `logger`, and the single color-enable source of truth in `tty.ts`.

The CLI is a thin dispatcher — its only job is to parse flags, route to the right module, and plumb I/O. Business logic lives in pure functions inside each module, making the real behavior unit-testable without spawning a process. All fallible operations return `Result` types (never throw in business logic).

## System Context

`src/cli.ts` is the `#!/usr/bin/env node` binary entry point using Node's built-in `parseArgs` (no third-party arg-parsing library). Subcommands are positional; `serve` is the implicit default.

```
subswitch [command] [flags]
  serve     (default) — start the MITM proxy
  doctor    — preflight health checks; exits non-zero on any failure
  init      — interactive or non-interactive first-time setup
  models    — print effective alias table (registry × config × codex.models)
```

Global flags (`--help/-h`, `--version/-v`) are handled before subcommand dispatch and always exit 0. `init` is the only subcommand dispatched BEFORE `loadConfig()` — it must not depend on a pre-existing config file. `doctor`, `serve`, and `models` all call `loadConfig()` before dispatching.

**USAGE invariant.** The `USAGE` constant in `src/cli.ts` (including Examples and Environment sections) must stay byte-identical to the CLI reference block in the README. If you update one, update the other. Drift here breaks the "single canonical reference" property.

## Component Architecture

### src/tty.ts — Single color-resolution source

`resolveColorEnabled(env, isTTY)` is the single source of truth for color enable/disable logic. Precedence (highest wins):

1. `FORCE_COLOR` set to a non-empty value other than `"0"` → `true`
2. `NO_COLOR` key present in env (presence semantics — value is irrelevant) → `false`
3. `isTTY` fallback

Both `logger.ts` and `cli.ts` import this function. `FORCE_COLOR=0` and `FORCE_COLOR=""` are intentionally NOT treated as force-on; they fall through to `NO_COLOR`/`isTTY`. Any code that re-implements this logic in-line is a bug.

### src/config.ts — Constants and config loading

`DEFAULT_PORT` (`4141`) and `DEFAULT_CODEX_MODELS` are exported constants. `DEFAULT_CODEX_MODELS = ALL_MODEL_IDS` — derived from the canonical `MODEL_REGISTRY` in `models.ts`; the name is kept for import compatibility. Both the Zod schema defaults and init's planning functions derive from these constants — no duplicated literals.

`LoadConfigResult` exposes `codexModelsPinned: boolean` — true when `codex.models` was explicitly present in the raw config AND at least one entry is a generation-specific id (e.g. `gpt-5.6-sol`) whose family has a floating alias. Computed from the raw JSON BEFORE normalization (only computable there) and consumed by doctor's alias nudge.

Two new `codex.*` config knobs: `codex.aliases` (record, defaults to `{}`) and `codex.models` (`.min(1)`, thunk default `() => [...ALL_MODEL_IDS]`). The thunk keeps `Config["codex"]["models"]` typed `string[]` so no consumer has type churn. `.min(1)` is intentional — `"models": []` would silently disable all Codex routing while the ready banner still printed `routing: → Codex`.

`loadConfig` deliberately separates read from parse. Step 1 reads the file (catches `ENOENT` and permission errors). Step 2 parses JSON only when a file was found. A malformed JSON file returns a `Result` error with the message `malformed JSON in <path> — fix or delete the file`. An ENOENT on the implicit cwd path silently falls back to pure defaults; an ENOENT on an explicitly-requested path (via `configPath` option or `SUBSWITCH_CONFIG` env var) is an error.

`ANTHROPIC_BASE_URL` is always derived from `config.port` as `http://127.0.0.1:{port}`. This coupling is intentional: the Claude Code settings URL and the proxy port cannot drift from each other because they come from the same source.

### src/models.ts — Pure model registry (no repo imports)

Deliberately imports nothing from the rest of the repo — `config.ts` imports it, and the edge must stay one-way. See `codex-leg/KNOWLEDGE.md` for the full resolution contract. What matters for CLI UX:

- `formatModelsReport(input)` is the output engine for both `subswitch models` and doctor's alias table. Renders rows: `alias → canonical  gen:X.Y  enabled|disabled  (derived)|(config)|(direct)`.
- `isAnthropicModelName(name)` is prefix-based (not exact) — guards three surfaces in config validation (aliases keys, aliases targets, `codex.models` entries) and the agent-scan skip list. Prefix coverage catches variant tier names like `sonnet[1m]` and `opusplan`.

### src/cli.ts — Dispatcher

`parseCliArgs` returns a discriminated `CliCommand` union. `parseArgs` runs with `tokens: true` so the raw token stream is available for per-command flag validation after the global parse. Flag sets per command:

- `serve`: `verbose`, `quiet`, `port`
- `doctor`: (none — any flag on `doctor` is an error)
- `models`: (none — any flag on `models` is an error)
- `init`: `yes`, `dry-run`, `port`, `codex-model`, `codex-models`, `settings-target`

`ERR_PARSE_ARGS_UNKNOWN_OPTION` and `ERR_PARSE_ARGS_INVALID_OPTION_VALUE` from `parseArgs` are caught and translated to clean `unknown flag '<flag>'` messages; other `ERR_PARSE_ARGS_*` codes produce `invalid arguments`. Unknown errors re-throw.

The main switch is exhaustive: the `default` branch assigns to `never` and calls `fail()`, the TypeScript exhaustiveness guard pattern.

`serve --port` uses the same `PortSchema.safeParse` and the same error wording (`port must be an integer between 1 and 65535`) as `init --port`. Both paths import `PortSchema` from `init.ts`.

The `models` subcommand calls `loadConfig()`, builds `new Set(config.codex.models)` as the routable set, calls `formatModelsReport({registry: MODEL_REGISTRY, routable, overrides: config.codex.aliases})`, then colorizes the `enabled`/`disabled` and `(derived)`/`(config)`/`(direct)` columns via picocolors. It writes to stdout via `out()`.

`out()` / `errOut()` write directly to stdout / stderr. They are NOT routed through the structured logger — they are for human-readable one-shot messages (banners, init confirmation lines). Runtime request telemetry goes through the structured logger so it respects `--quiet`, `--verbose`, and the field allow-list.

### src/init.ts — Functional-core / imperative-shell

**Pure planning layer (no side effects, unit-testable directly):**

- `resolveInitDispatch(stdinIsTTY, stdoutIsTTY, hasCIEnv, yesFlag)` → `InitDispatchDecision`
- `mergeModelFlags(flags)` → `string[]` — named export backing both `resolveOptionsFromFlags` and `seedWizard`; trims, drops empties, deduplicates preserving first-occurrence order
- `resolveOptionsFromFlags(flags: InitFlags)` → `Result<InitOptions, InitError>` — all normalization, dedup, and validation. When no model flags are present, **omits `codexModels` from the result** so the written config floats with the registry default (no list is written). When model flags are given but resolve to empty (e.g. `--codex-models ""`), returns `invalid_input`.
- `planConfigWrite(existingJson, port, models, projectDir)` → `Result<ConfigWritePlan, InitError>` — deep-merge preserving all existing top-level and `codex.*` keys except `models`. **When `models` is `undefined`, DELETES any pre-existing `codex.models` key** — a mere omission is not enough because deep-merge would leave a stale pin in place; re-running `init` without model flags must fully un-pin an existing user.
- `planSettingsWrite(existingJson, port, settingsTarget, projectDir)` → `Result<SettingsWritePlan, InitError>` — merges only `env.ANTHROPIC_BASE_URL`; all other keys preserved
- `collectPreconditionWarnings(env, authFileExists, authFilePath)` → `string[]` — auth path must be computed from `homedir()` by the caller, not `env.HOME` (undefined on Windows)
- `settingsPathFor(target, projectDir)` — single source of truth for the settings file path
- `isPlainObject(v)` — plain-object guard re-used by init planning and by `doctor.ts`

`InitFlags` is the raw CLI shape (strings, no normalization). All normalization and deduplication happen inside `mergeModelFlags` → `resolveOptionsFromFlags`. `InitOptions.codexModels` is optional (`exactOptionalPropertyTypes` is on — never write `codexModels: undefined`). Absent means the config is written WITHOUT the `codex.models` key so the proxy auto-tracks registry additions.

**Effectful execution layer:**

`executeInit(options, deps, projectDir)` returns `Result<readonly [configPath, settingsPath], InitError>`. Write order is config-first: a dangling settings pointer (ANTHROPIC_BASE_URL pointing at a port with no config) is the more harmful partial state. All reads happen before any write; if either plan fails, nothing is written.

`InitFsDeps` is the injection seam. Production: `makeRealFsDeps()`. Tests: `makeFakeDeps()` from `test/unit/init-test-helpers.ts`. `makeRealFsDeps().writeFile` uses atomic temp-then-rename: writes to `<path>.tmp.<pid>`, then renames over the target.

**Wizard (`runInitInteractive`):**

Signature: `runInitInteractive(projectDir, deps, env, prompts, flags?)`. The `prompts` parameter is an `InitPrompts` interface — the injection seam for tests. The real implementation (`makeClackPrompts()`) lazy-imports `@clack/prompts` via dynamic `import()`. The factory is called in `cli.ts` only when entering the interactive path, so clack is never loaded on `serve`, `doctor`, `models`, `--help`, or `--version` paths.

Seeding precedence: flags → existing `subswitch.config.json` → defaults. Unknown models from flags or the existing config appear as `(custom)` options in the multiselect. Cancel at any prompt returns 1 with zero writes.

**Float behavior in the wizard:** When the user's multiselect covers every current registry id and nothing extra, `codexModels` is omitted from `InitOptions` — the written config floats with the registry and auto-picks new generations without user action.

**Dry-run path:** `init --dry-run` bypasses `resolveInitDispatch`. It prints both plans to stdout and writes nothing, always exits 0 on success, and is allowed without `--yes` in a non-TTY or CI environment — the fail-closed contract only protects writes.

### src/doctor.ts — Preflight gate

`runDoctor` accepts an injected `DoctorIO`. `listAgentFiles` and `readTextFile` are **required** fields (added with the model-family-aliases feature) — they enable the agent frontmatter scan. Color is resolved in `cli.ts` and passed as a boolean so `runDoctor` never touches `process.env`.

Full signature: `runDoctor(config, configPath, fileFound, io, codexModelsPinned = false)`. The fifth parameter is trailing-defaulted so the seven existing unit test call sites with four arguments compile unchanged. When `codexModelsPinned` is true, doctor emits an informational `aliases:` row nudging the user toward family aliases rather than pinned generation-specific ids.

After the config summary rows, doctor renders the effective alias table via `formatModelsReport` (indented under the `codex.models` row).

All three network probes (`probeSubswitch`, `probeTlsReachable` for anthropic, `probeTlsReachable` for codex) run via `Promise.all` for speed, but output is written in fixed order after all results are in.

Doctor scans BOTH `.claude/agents/` (relative to project cwd) AND `~/.claude/agents/` (user-global). Paths are de-duplicated with a `Set` of absolute strings before reading file contents. File texts are passed to `checkAgentModels` from `src/agent-scan.ts`.

`row(label, value)` pads the label to `LABEL_WIDTH` (22) characters — all output is columnar. Config-file missing is informational: logs `(defaults — file not found)` but does NOT increment `failures`. `makeLiveHttpGet` caps body reads at `MAX_BODY_BYTES` (8 KiB). Returns `0` (all checks pass) or `1` (any failure). `cli.ts` assigns the return value to `process.exitCode`.

### src/agent-scan.ts — Agent frontmatter scanner

No external dependencies. Imports `isAnthropicModelName` from `models.ts` to skip Claude subagents.

`parseFrontmatterModel(text)` extracts the `model:` value: requires `---` on line 1, scans to closing `---`, capped at 8 KiB / 200 lines, handles CRLF, strips surrounding quotes and trailing `# comment`. `modelPreference:` and similar prefixed keys are NOT matched (regex is `^model:\s*(.+)$`).

`checkAgentModels(files, routable, overrides)` builds two resolvers — one scoped to the actual routable set (route-resolver) and one scoped to all known ids (full-resolver). For each file:
- Anthropic-shaped names (`inherit`, `sonnet`, `opus`, `haiku`, `claude-*`) are skipped — **the skip list is required in production code**, not just tests; without it doctor fails on every repo with Claude subagents.
- Model routes successfully → no finding.
- Unresolvable by both resolvers → `"unresolvable"` finding (increments `failures`).
- Resolves but excluded from narrowed `codex.models` → `"excluded"` finding (informational; no `failures++`, matching doctor's own precedent for missing config files).

### src/logger.ts — Structured key=value logger

Emits to stderr. Format: `[HH:MM:SS] level=<L> event=<E> key=value …` (timestamp only when color is on). `createColors(color)` bypasses picocolors' own TTY detection so the `color` parameter is the single source of truth. Fields are serialized by iterating `FIELD_KEYS` in order — any field NOT in `FIELD_KEYS` is silently dropped (the compliance redaction boundary).

**Log injection prevention:** `\r\n` characters are stripped from all field values before serialization — prevents a crafted model string from forging a second log line. Values containing whitespace or `=` are wrapped in double-quotes — prevents field-token forgery (an injected `event=fake` token cannot masquerade as a real field). Normal values (model ids, route names, status codes) never contain these characters, so quoting is rare and the log format is unchanged for typical inputs.

Both log sites deliberately keep using the as-requested model name (what the user typed and would grep for). The alias-to-canonical mapping is discoverable via `subswitch models`.

## Non-interactive Safety Contract

`resolveInitDispatch` is the single gateway. Three outcomes:

- `"interactive"` — both stdin and stdout are TTYs, no `CI` env var, no `--yes`. Runs the clack wizard.
- `"non-interactive"` — `--yes` is set. Runs the flag-driven writer regardless of TTY state or CI.
- `"refuse"` — non-TTY or CI env detected but `--yes` not provided. Exits 1. No files written.

`yesFlag` is checked before `hasCIEnv` in the decision tree. Do not add a branch that inspects CI state before checking `yesFlag` — that breaks `subswitch init --yes` in CI pipelines.

**Exception:** `--dry-run` bypasses `resolveInitDispatch` entirely. `runInitDryRun` is allowed in any environment because it writes nothing.

## Settings Write: Idempotency and Non-destructive Merge

`planSettingsWrite` only touches `env.ANTHROPIC_BASE_URL`. All other keys are preserved verbatim. `planConfigWrite` only touches `port` and `codex.models`; all other top-level and `codex.*` keys are preserved. Both functions deep-merge, never replace the whole object.

`planConfigWrite` with `models: undefined` DELETES the `codex.models` key from the output — a mere omission would leave a pre-existing pin in place on re-run. No partial writes: both plans complete successfully before `executeInit` writes either file. Config is written before settings (config-first order).

## Exit-code Contract

| Command | Condition | Exit code |
|---------|-----------|-----------|
| `serve` | Listening successfully | 0 (never exits — waits for signal) |
| `serve` | Port in use | 1 |
| `serve` | Bad config | 1 |
| `doctor` | All checks pass | 0 |
| `doctor` | Any check fails | 1 |
| `init` | Files written | 0 |
| `init` | User cancelled / empty select | 1 |
| `init` | Refused (non-TTY, no `--yes`) | 1 |
| `init --dry-run` | Plans printed | 0 |
| `init --dry-run` | Bad flags / malformed config | 1 |
| `models` | Table printed | 0 |
| `--help`, `--version` | Always | 0 |

## Anti-Patterns

- **Re-implementing color logic inline** — always import `resolveColorEnabled` from `tty.ts`. Any inline `isTTY && !NO_COLOR` check will miss the `FORCE_COLOR` precedence and diverge from the logger and doctor color decisions.

- **Using picocolors' global default export instead of `createColors(bool)`** — the global export re-detects TTY state itself, making the caller's boolean a no-op.

- **Widening `FIELD_KEYS` in logger.ts without a compliance review** — the closed field list is the redaction boundary. Any new field needs a documented non-reversible form (a count or a truncated prefix, never raw content).

- **Calling `out()` / `errOut()` from `serve` for runtime request logs** — these helpers are for startup banners and one-shot messages. Use the structured logger so output respects `--quiet`, `--verbose`, and the field allow-list.

- **Mutating the `config` object** from `loadConfig()` — apply overrides via object spread to produce a new `effectiveConfig`.

- **Asserting `subswitch doctor` exits 0 in smoke tests** — doctor exits non-zero whenever any check fails. In CI (no proxy running, no codex auth), all live checks fail (applies PF-006).

- **Adding a `cwd` field to `InitFsDeps`** — `InitFsDeps` is intentionally stateless; `projectDir` is passed explicitly to each function. Adding `cwd` would make the test fake stateful.

- **Duplicating `DEFAULT_PORT` literals** — exported from `config.ts`, single source. `DEFAULT_CODEX_MODELS` is derived from `ALL_MODEL_IDS` in `models.ts` and re-exported from `config.ts` for import compatibility — never re-derive the model list elsewhere.

## Gotchas

**Doctor always exits non-zero in CI.** The subswitch proxy is not running, codex auth is not configured, and TLS reachability depends on network policy. `scripts/smoke-tarball.sh` uses `subswitch --version` — which always exits 0 — not `subswitch doctor` (applies PF-006).

**`FORCE_COLOR=0` and `FORCE_COLOR=""` do not force color.** Both fall through the FORCE_COLOR branch (`forceColor !== undefined && forceColor !== "" && forceColor !== "0"`) and hit the NO_COLOR / isTTY tiers.

**No model flags → `codex.models` omitted from config.** When `--codex-model` and `--codex-models` are both absent, `resolveOptionsFromFlags` returns `InitOptions` without `codexModels`. `planConfigWrite` with `models: undefined` DELETES any pre-existing `codex.models` key — the proxy floats with the registry default and auto-tracks new generations. **`--codex-models ""` is an error** — if model flags are provided but resolve empty, `resolveOptionsFromFlags` returns `invalid_input`.

**`makeLiveListAgentFiles` must resolve dirs to absolute paths.** The factory calls `pathResolve(dir)` before scanning. Without this, when running from `$HOME` (where the project `.claude/agents/` relative and user `~/.claude/agents/` absolute happen to be the same directory), identical physical paths produce different strings, the `Set`-based deduplication in `runDoctor` fails silently, and every file is scanned twice — doubling finding counts. A test injecting fakes through `DoctorIO` cannot catch this defect; the regression test must exercise the real factory against the filesystem.

**`makeClackPrompts()` must only be called on the interactive path.** It triggers a dynamic `import("@clack/prompts")` which loads terminal control sequences. Call it only inside the `if (decision === "interactive")` branch.

**`clack.multiselect` and friends return a Symbol on cancel.** `isCancel` must be checked before treating the return value as `string[]`. The `prompt()` helper inside `runInitInteractive` centralizes this guard.

**`parseArgs` with `strict: true` throws on unknown flags.** The catch block translates `ERR_PARSE_ARGS_*` errors to `Result` errors. Always `return` after `fail()` — code after it still runs unless the caller returns explicitly.

**`init` does not load `subswitch.config.json` at dispatch time.** It is dispatched before `loadConfig()`. Port and model selections come from flags, the wizard, or `seedWizard` (which reads the file independently and silently ignores parse errors).

**Atomic write uses `<path>.tmp.<pid>`.** A crash mid-write may leave a `.tmp.<pid>` file. The cleanup `catch` block attempts `unlink` on the temp file but swallows cleanup errors to avoid masking the original write error.

**`exactOptionalPropertyTypes` conditional spreads in `makeClackPrompts`.** `@clack/prompts` predates `exactOptionalPropertyTypes`. The factory uses `...(field !== undefined ? { field } : {})` spreads at every optional clack option — intentional and locally contained.

## Key Files

- `src/tty.ts` — `resolveColorEnabled(env, isTTY)` — single color-enable source of truth
- `src/cli.ts` — Binary entry point; `parseCliArgs` → `CliCommand` union; per-command flag sets; exhaustive switch with `never` guard; `models` subcommand dispatcher
- `src/init.ts` — Pure planning (`resolveInitDispatch`, `planConfigWrite`, `planSettingsWrite`, `mergeModelFlags`, `resolveOptionsFromFlags`, `collectPreconditionWarnings`, `settingsPathFor`, `isPlainObject`); `InitFsDeps` seam; `InitPrompts` seam; `makeClackPrompts()` factory; all three runners
- `src/doctor.ts` — `runDoctor` preflight gate; `DoctorIO` interface (including required `listAgentFiles` + `readTextFile`); `makeLiveListAgentFiles` (absolute-path resolution required)
- `src/agent-scan.ts` — `parseFrontmatterModel` (hand-rolled, no YAML dep); `checkAgentModels`; Anthropic skip list load-bearing in production
- `src/logger.ts` — `createConsoleLogger`; `FIELD_KEYS` compliance allow-list; newline + quote-wrapper log injection prevention; `noopLogger`
- `src/models.ts` — Pure registry; `MODEL_REGISTRY`, `ALL_MODEL_IDS`, `makeModelResolver`, `normalizeModelList`, `formatModelsReport`, `isAnthropicModelName`
- `src/config.ts` — `DEFAULT_PORT`, `DEFAULT_CODEX_MODELS`; `LoadConfigResult` with `codexModelsPinned`; `codex.aliases` + `codex.models` schemas with Anthropic-guard refines
- `test/unit/init-test-helpers.ts` — `makeFakeDeps` shared factory for init unit tests
- `scripts/smoke-tarball.sh` — Uses `--version` not `doctor` for binary-resolves assertion

## Related

- PF-006: Doctor exits non-zero without live services; smoke uses `--version` not `doctor`
- ADR-005: Exact model-membership routing — `isAnthropicModelName` guards prevent Anthropic names entering the routable set, maintaining ADR-005's invariant that `decideRoute` only receives canonical Codex ids
- ADR-004: `@types/node` pinned to Node-22 majors — affects `parseArgs` type signatures and `readdir({recursive:true})` in `makeLiveListAgentFiles`
- `.devflow/features/codex-leg/KNOWLEDGE.md` — Full model resolution contract (`makeModelResolver`, "a pin pins", numeric gen comparison, canonical threading)
- `src/models.ts` — `formatModelsReport` drives both `subswitch models` output and doctor's alias table
- `src/config.ts` — `loadConfig()` consumed by `serve`, `doctor`, and `models`; `init` reads it only in `seedWizard` (best-effort, errors silently swallowed)
- `src/version.js` — Source of `SUBSWITCH_VERSION` used by `--version` and doctor output
