---
feature: cli-ux
name: CLI / init command / terminal UX
description: "Use when modifying the CLI entry point, init wizard, doctor preflight command, logger output format, models alias table, or any terminal UX concern (colors, TTY detection, FORCE_COLOR, dry-run, CI safety). Keywords: cli, parseArgs, CliCommand, init, doctor, models, logger, clack, picocolors, TTY, NO_COLOR, FORCE_COLOR, interactive, non-interactive, dry-run, smoke-tarball, tty.ts, models.ts, agent-scan, buildRoutingTable, provider, configuredProviders."
category: architecture
directories: [src/cli.ts, src/init.ts, src/doctor.ts, src/logger.ts, src/tty.ts, src/models.ts, src/agent-scan.ts, src/config.ts]
created: 2026-07-23
updated: 2026-07-28
---

# CLI / init command / terminal UX

## Overview

This knowledge base covers the full user-facing surface of subswitch: the CLI entry point (`src/cli.ts`), the `init` wizard (`src/init.ts`), the `doctor` preflight command (`src/doctor.ts`), the structured logger (`src/logger.ts`), and the single color-resolution utility (`src/tty.ts`). `src/models.ts` (pure model registry) and `src/agent-scan.ts` (doctor's frontmatter scanner) are tightly coupled to the CLI surface.

These files share three cross-cutting contracts that are easy to break silently: the non-interactive safety guarantee in `init`, the closed-field redaction guarantee in `logger`, and the single color-enable source of truth in `tty.ts`.

The CLI is a thin dispatcher — its only job is to parse flags, route to the right module, and plumb I/O. Business logic lives in pure functions inside each module, making the real behavior unit-testable without spawning a process. All fallible operations return `Result` types (never throw in business logic).

## System Context

`src/cli.ts` is the `#!/usr/bin/env node` binary entry point using Node's built-in `parseArgs` (no third-party arg-parsing library). Subcommands are positional; `serve` is the implicit default.

```
subswitch [command] [flags]
  serve     (default) — start the MITM proxy
  doctor    — preflight health checks; exits non-zero on any failure
  init      — interactive or non-interactive first-time setup
  models    — show effective alias table (registry × aliases)
              --json  Output model registry as JSON (no color, no TTY check)
```

Global flags (`--help/-h`, `--version/-v`) are handled before subcommand dispatch and always exit 0. `init` is the only subcommand dispatched BEFORE `loadConfig()` — it must not depend on a pre-existing config file. `doctor`, `serve`, and `models` all call `loadConfig()` before dispatching.

**USAGE invariant.** The `USAGE` constant in `src/cli.ts` must stay byte-identical to the CLI reference block in the README. If you update one, update the other.

## Component Architecture

### src/tty.ts — Single color-resolution source

`resolveColorEnabled(env, isTTY)` is the single source of truth for color enable/disable logic. Precedence (highest wins):

1. `FORCE_COLOR` set to a non-empty value other than `"0"` → `true`
2. `NO_COLOR` key present in env (presence semantics — value is irrelevant) → `false`
3. `isTTY` fallback

Both `logger.ts` and `cli.ts` import this function. `FORCE_COLOR=0` and `FORCE_COLOR=""` are intentionally NOT treated as force-on; they fall through to `NO_COLOR`/`isTTY`. Any code that re-implements this logic in-line is a bug.

### src/config.ts — Config load and resolution

`DEFAULT_PORT` (`4141`) is the only model-independent constant exported. The model-list constants (`DEFAULT_CODEX_MODELS`, `ALL_MODEL_IDS`) no longer exist — the routable set now comes from `MODEL_REGISTRY` in `models.ts` (applies ADR-006).

**`FileConfig` / `Config` split.** `FileConfigSchema.safeParse` produces a `FileConfig` (on-disk shape). `resolveConfig(file)` is a pure mapping that expands `providers.codex.*` → `config.codex.*` and tilde-expands `authFile`. Consumers use `Config`; only `loadConfig` sees `FileConfig`.

**On-disk layout.** All provider settings live under `providers.<id>.*` (e.g. `providers.codex.aliases`, `providers.codex.requestTimeoutMs`). The top-level `codex.*` block from the previous layout is now `providers.codex.*`. A config with a legacy top-level `codex` key, a `codex.models` key, or any of the moved `limits.*` keys is **rejected** at load with per-key move instructions (`detectLegacyConfigKeys`). This prevents the "Zod strips unknown keys → settings silently revert to defaults" failure mode.

**`kind` discriminant.** Zod reads discriminator fields before defaults fire. `kind: z.literal("codex")` in `CodexProviderSchema` cannot carry `.default("codex")`. `ProvidersSchema` uses `z.preprocess` to inject `{ kind: key }` from the record key before parsing each provider block.

**`LoadConfigResult.configuredProviders`** is a `ReadonlySet<ProviderId>` of providers whose block was literally present in the raw config (own-property check only). Zod fills all provider defaults unconditionally, so `Config` alone cannot answer "did the user opt in?" — but doctor's severity rules depend on it (an unconfigured provider stays informational, never fails the exit code, avoids PF-006).

**Three per-provider limits.** Each provider has `requestTimeoutMs`, `streamIdleTimeoutMs`, `maxSseEventBytes`. `connectTimeoutMs` and `maxUpstreamSockets` are Anthropic-leg-only (under `anthropic.*`) because the Codex leg uses global `fetch`.

**Global `limits.*` block.** `maxConcurrentRequests` (default 32) lives here. A single leaked decrement-without-increment permanently degrades the server to 503.

`ANTHROPIC_BASE_URL` is always derived from `config.port` as `http://127.0.0.1:{port}`. Coupling is intentional: the Claude Code settings URL and the proxy port cannot drift from each other because they come from the same source.

### src/models.ts — Pure model registry (no repo imports)

Deliberately imports nothing from the rest of the repo — `config.ts` imports it, and the edge must stay one-way. See `codex-leg/KNOWLEDGE.md` for the full resolution contract.

Key exports for CLI UX:

- `PROVIDER_IDS = ["codex"] as const` and `ProviderId` — closed union; ensures provider dispatch tables are compile-time complete.
- `MODEL_REGISTRY` — the routable set source (applies ADR-006).
- `buildRoutingTable(registry, aliasesByProvider)` — called in both `buildDeps` (server) and `runDoctor` (CLI).
- `resolveModel(table, name)` — five-rule resolution returning `ModelResolution`.
- `isReservedAnthropicName(name)` — prefix-based (not exact); guards alias keys and targets in `buildRoutingTable` and `AliasesSchema` refines in `config.ts`. Also the skip predicate in `agent-scan.ts`.
- `formatModelsReport(input)` — human-readable alias table: `alias → canonical  provider  gen:X.Y  enabled|disabled  (derived)|(config)|(direct)`. Takes `{ registry, aliasesByProvider }`.
- `buildModelRows(registry, aliasesByProvider)` — model-centric rows for `--json` output.
- `buildAliasRows(registry, aliasesByProvider)` — alias-centric rows used internally by `formatModelsReport`.

All three row-building entry points take the **same per-provider alias record** that `buildRoutingTable` takes — `aliasesByProvider(config)` from `config.ts`. They previously took a flat `Record<string, string>` of just the codex aliases, which is why the display layer had to guess a provider for a target it could not find.

### src/cli.ts — Dispatcher

`parseCliArgs` returns a discriminated `CliCommand` union. Flag sets per command:

- `serve`: `verbose`, `quiet`, `port`
- `doctor`: (none — any flag on `doctor` is an error)
- `models`: `json` only
- `init`: `yes`, `dry-run`, `port`, `settings-target`

`--codex-model` and `--codex-models` were removed when the `codex.models` config key was deleted (applies ADR-006). The init wizard no longer prompts for model selection.

`ERR_PARSE_ARGS_UNKNOWN_OPTION` and `ERR_PARSE_ARGS_INVALID_OPTION_VALUE` are caught and translated to clean `unknown flag '<flag>'` messages.

The main switch is exhaustive: the `default` branch assigns to `never` and calls `fail()`.

**`models` subcommand.** Calls `loadConfig()`, then dispatches on `--json`:
- Without `--json`: calls `formatModelsReport({registry: MODEL_REGISTRY, aliasesByProvider: aliasesByProvider(config)})` and colorizes the `enabled`/`disabled` and source columns via picocolors.
- With `--json`: calls `buildModelRows(MODEL_REGISTRY, aliasesByProvider(config))` and emits a JSON payload including `providers[]`, `models[]`, `schemaVersion`, and metadata. The JSON branch returns BEFORE `resolveColorEnabled` so `FORCE_COLOR` cannot bleed into JSON output. Verified 2026-07-28: two consecutive `models --json` runs are byte-identical, and `FORCE_COLOR=1` adds zero ANSI bytes to `--json` while the table form emits them.

**Per-provider ready banner.** On `serve`, the banner prints one line per `PROVIDER_IDS` entry with model count and host. `providerConfigFor(effectiveConfig, id)` is the single source for per-provider display metadata.

`out()` / `errOut()` write directly to stdout / stderr — NOT routed through the structured logger. Use the structured logger for runtime request telemetry so output respects `--quiet`, `--verbose`, and the field allow-list.

### src/init.ts — Functional-core / imperative-shell

**`InitFlags`** is `{ port?: string; settingsTarget?: string }`. The `--codex-model`/`--codex-models` flags no longer exist; `mergeModelFlags` is gone.

**Pure planning layer (no side effects, unit-testable directly):**

- `resolveInitDispatch(stdinIsTTY, stdoutIsTTY, hasCIEnv, yesFlag)` → `InitDispatchDecision`
- `resolveOptionsFromFlags(flags)` → `Result<InitOptions, InitError>` — validates port and settings-target only. `InitOptions` is `{ port, settingsTarget }`.
- `planConfigWrite(existingJson, port, projectDir)` → `Result<ConfigWritePlan, InitError>` — deep-merges only `port`; all other top-level keys are preserved. No model list is ever written.
- `planSettingsWrite(existingJson, port, settingsTarget, projectDir)` → `Result<SettingsWritePlan, InitError>` — merges only `env.ANTHROPIC_BASE_URL`; all other keys preserved.
- `collectPreconditionWarnings(env, authFileExists, authFilePath)` — auth path must be computed from `homedir()` by caller, not `env.HOME` (undefined on Windows).
- `settingsPathFor(target, projectDir)` — single source of truth for the settings file path.
- `isPlainObject(v)` — re-used by init planning and `doctor.ts`.

**Effectful execution layer:**
`executeInit(options, deps, projectDir)` returns `Result<readonly [configPath, settingsPath], InitError>`. Write order is config-first: a dangling settings pointer is the harmful partial state. All reads happen before any write; if either plan fails, nothing is written.

`InitFsDeps` is the injection seam. `makeRealFsDeps().writeFile` uses atomic temp-then-rename.

**Wizard (`runInitInteractive`):**
Signature: `runInitInteractive(projectDir, deps, env, prompts, flags?)`. The wizard prompts only for **port** and **settings-target** — no model multiselect. `seedWizard` seeds port from flags → existing config → default; settings-target from flags → default. `makeClackPrompts()` lazy-imports `@clack/prompts` via dynamic `import()` and is called only when entering the interactive path.

**Dry-run:** `init --dry-run` bypasses `resolveInitDispatch`. Prints both plans to stdout and writes nothing. Allowed without `--yes` in any environment — the fail-closed contract only protects writes.

### src/doctor.ts — Preflight gate

`runDoctor(config, configPath, fileFound, io, configuredProviderIds)`. The fifth parameter is `ReadonlySet<ProviderId>` defaulting to `new Set<ProviderId>()`. The previous `codexModelsPinned: boolean` parameter is gone.

**N-provider auth check (PF-006 severity rules):**
- Provider absent from config file → informational; no `failures++`. A user who never added a `providers.codex` block must not fail the exit code when a second provider ships.
- Provider present in config file but credential missing or broken → failure. The user opted in, so a broken opt-in is a real problem.

Each `checkOneProvider` call returns its output lines rather than writing them, so N concurrent checks cannot interleave — lines are written in `PROVIDER_IDS` order after all complete.

Doctor runs a per-provider TLS probe alongside the Anthropic TLS probe — all in `Promise.all` for speed, written in deterministic order after all complete.

Doctor calls `buildRoutingTable` once at the start of the run. The returned `table` is passed to `checkAgentModels`; the returned `danglingAliases` list drives dangling-alias warnings (each increments `failures`).

**Agent scan:** Doctor scans both `.claude/agents/` (relative to cwd) AND `~/.claude/agents/` (user-global). Paths are deduplicated with a `Set` of absolute strings. File texts are passed to `checkAgentModels(fileTexts, table, configuredProviders)`.

`row(label, value)` pads the label to `LABEL_WIDTH` (22) characters — all output is columnar. Config-file missing is informational. Returns `0` or `1`; `cli.ts` assigns to `process.exitCode`.

### src/agent-scan.ts — Agent frontmatter scanner

No external dependencies. Imports `isReservedAnthropicName` from `models.ts` to skip Anthropic-named subagents.

`parseFrontmatterModel(text)` extracts the `model:` value: requires `---` on line 1, scans to closing `---`, capped at 8 KiB / 200 lines, handles CRLF, strips surrounding quotes and trailing `# comment`. `modelPreference:` and similar prefixed keys are NOT matched.

`checkAgentModels(files, table, configuredProviders)` calls `resolveModel(table, model)` for each file and maps the result to six finding kinds. Severity travels with each `AgentFinding` struct — never re-derived by the renderer.

| Finding kind | Severity | Trigger |
|---|---|---|
| `unresolvable` | fail | `resolveModel` returns `unresolved` |
| `ambiguous` | fail | `resolveModel` returns `ambiguous` |
| `unknown_provider` | fail | `resolveModel` returns `unknown_qualifier` |
| `retired` | info | Resolves to a registry entry marked `retired` |
| `provider_unconfigured` | info | Resolves ok but provider not in `configuredProviders` |
| `preview_only` | info | Resolves to a registry entry marked `preview` |

**The Anthropic skip list is required in production code**, not just tests — without it doctor fails on every repo that has Claude subagents.

### src/logger.ts — Structured key=value logger

Emits to stderr. Format: `[HH:MM:SS] level=<L> event=<E> key=value …` (timestamp only when color is on). `createColors(color)` bypasses picocolors' own TTY detection so the `color` parameter is the single source of truth. Fields are serialized by iterating `FIELD_KEYS` in order — any field NOT in `FIELD_KEYS` is silently dropped (the compliance redaction boundary).

**Log injection prevention:** `\r\n` characters are stripped from all field values; values containing whitespace or `=` are wrapped in double-quotes.

## Non-interactive Safety Contract

`resolveInitDispatch` is the single gateway. Three outcomes: `"interactive"` (both TTYs, no CI, no `--yes`), `"non-interactive"` (`--yes` set), `"refuse"` (non-TTY or CI without `--yes`). `yesFlag` is checked before `hasCIEnv` — do not add a branch that inspects CI state before checking `yesFlag`.

**Exception:** `--dry-run` bypasses `resolveInitDispatch` entirely — it writes nothing.

## Settings Write: Idempotency and Non-destructive Merge

`planSettingsWrite` only touches `env.ANTHROPIC_BASE_URL`. `planConfigWrite` only touches `port`. Both deep-merge, never replace the whole object. No partial writes: both plans complete before `executeInit` writes either file. Config is written before settings.

## Exit-code Contract

| Command | Condition | Exit code |
|---------|-----------|-----------|
| `serve` | Listening successfully | 0 (never exits — waits for signal) |
| `serve` | Port in use | 1 |
| `serve` | Bad config | 1 |
| `doctor` | All checks pass | 0 |
| `doctor` | Any check fails | 1 |
| `init` | Files written | 0 |
| `init` | User cancelled | 1 |
| `init` | Refused (non-TTY, no `--yes`) | 1 |
| `init --dry-run` | Plans printed | 0 |
| `init --dry-run` | Bad flags / malformed config | 1 |
| `models` | Table printed | 0 |
| `models --json` | JSON emitted | 0 |
| `--help`, `--version` | Always | 0 |

## Anti-Patterns

- **Re-implementing color logic inline** — always import `resolveColorEnabled` from `tty.ts`. Any inline `isTTY && !NO_COLOR` check will miss the `FORCE_COLOR` precedence and diverge from the logger and doctor color decisions.

- **Using picocolors' global default export instead of `createColors(bool)`** — the global export re-detects TTY state itself, making the caller's boolean a no-op.

- **Widening `FIELD_KEYS` in logger.ts without a compliance review** — the closed field list is the redaction boundary. Any new field needs a documented non-reversible form (a count or truncated prefix, never raw content).

- **Calling `out()` / `errOut()` from `serve` for runtime request logs** — these helpers are for startup banners and one-shot messages. Use the structured logger so output respects `--quiet`, `--verbose`, and the field allow-list.

- **Mutating the `config` object** from `loadConfig()` — apply overrides via object spread to produce a new `effectiveConfig`.

- **Asserting `subswitch doctor` exits 0 in smoke tests** — doctor exits non-zero whenever any check fails. In CI (no proxy running, no codex auth), all live checks fail (applies PF-006).

- **Adding a `cwd` field to `InitFsDeps`** — `InitFsDeps` is intentionally stateless; `projectDir` is passed explicitly to each function.

- **Duplicating `DEFAULT_PORT` literals** — exported from `config.ts`, single source. Do not re-add `DEFAULT_CODEX_MODELS` or `ALL_MODEL_IDS` — the routable set comes from `MODEL_REGISTRY` (ADR-006).

## Gotchas

**Doctor always exits non-zero in CI.** The subswitch proxy is not running, codex auth is not configured, and TLS reachability depends on network policy. `scripts/smoke-tarball.sh` uses `subswitch --version` — which always exits 0 — not `subswitch doctor` (applies PF-006).

**`FORCE_COLOR=0` and `FORCE_COLOR=""` do not force color.** Both fall through the FORCE_COLOR branch (`forceColor !== undefined && forceColor !== "" && forceColor !== "0"`) and hit the NO_COLOR / isTTY tiers.

**Zod strips unknown keys — a legacy config parses clean and runs on defaults.** `detectLegacyConfigKeys` checks for top-level `codex.*`, `codex.models`, and moved `limits.*` keys and returns a hard error before Zod runs. Without it, a pre-`providers.*` config would silently lose all aliases and custom settings with no diagnostic.

**`isReservedAnthropicName` guards two places that must never disagree.** `AliasesSchema` refines in `config.ts` reject reserved names at parse time. `buildRoutingTable` rejects them again at table-build time. The agent-scan skip list uses the same predicate. Any new guard surface must import `isReservedAnthropicName` rather than reimplementing it.

**`makeLiveListAgentFiles` must resolve dirs to absolute paths.** The factory calls `pathResolve(dir)` before scanning. Without this, running from `$HOME` causes the project `.claude/agents/` relative path and the user `~/.claude/agents/` absolute path to produce different strings for the same directory, the `Set`-based deduplication in `runDoctor` fails silently, and finding counts double. A test injecting fakes through `DoctorIO` cannot catch this defect.

**`makeClackPrompts()` must only be called on the interactive path.** It triggers a dynamic `import("@clack/prompts")` which loads terminal control sequences. Call it only inside the `if (decision === "interactive")` branch.

**`clack.multiselect` and friends return a Symbol on cancel.** `isCancel` must be checked before treating the return value as a string. The `prompt()` helper inside `runInitInteractive` centralizes this guard.

**`parseArgs` with `strict: true` throws on unknown flags.** The catch block translates `ERR_PARSE_ARGS_*` errors to `Result` errors. Always `return` after `fail()` — code after it still runs unless the caller returns explicitly.

**Doctor unconfigured-provider vs. configured-but-broken severity is decided by `configuredProviders`.** Doctor receives `LoadConfigResult.configuredProviders`, which uses own-property checks to detect which provider blocks were literally present in the raw config. Zod fills all provider defaults unconditionally, so the resolved `Config` alone cannot answer this question.

## Key Files

- `src/tty.ts` — `resolveColorEnabled(env, isTTY)` — single color-enable source of truth
- `src/cli.ts` — Binary entry point; `parseCliArgs` → `CliCommand` union; `models --json` dispatch; per-provider serve banner; exhaustive switch with `never` guard
- `src/init.ts` — Pure planning (`resolveInitDispatch`, `planConfigWrite`, `planSettingsWrite`, `resolveOptionsFromFlags`, `collectPreconditionWarnings`, `settingsPathFor`, `isPlainObject`); `InitFsDeps` seam; `InitPrompts` seam; wizard prompts only port + settings-target
- `src/doctor.ts` — `runDoctor` preflight gate; `DoctorIO` interface; N-provider fan-out with `PROVIDER_IDS`; `checkOneProvider`; `makeLiveListAgentFiles` (absolute-path resolution critical)
- `src/agent-scan.ts` — `parseFrontmatterModel` (hand-rolled, no YAML dep); `checkAgentModels`; six finding kinds; `isReservedAnthropicName` skip list load-bearing in production
- `src/logger.ts` — `createConsoleLogger`; `FIELD_KEYS` compliance allow-list; log injection prevention; `noopLogger`
- `src/models.ts` — Pure registry; `MODEL_REGISTRY`, `PROVIDER_IDS`, `buildRoutingTable`, `resolveModel`, `isReservedAnthropicName`, `formatModelsReport`, `buildModelRows`
- `src/config.ts` — `DEFAULT_PORT`; `FileConfig`/`Config` split; `resolveConfig`; `LoadConfigResult.configuredProviders`; `detectLegacyConfigKeys`; provider `kind` preprocess injection
- `test/unit/init-test-helpers.ts` — `makeFakeDeps` shared factory for init unit tests
- `scripts/smoke-tarball.sh` — Uses `--version` not `doctor` for binary-resolves assertion

## Related

- PF-006: Doctor exits non-zero without live services; smoke uses `--version` not `doctor`
- ADR-006: `MODEL_REGISTRY` as sole routable set source; `codex.models` config key deleted; pre-restructure config rejected with per-key move instructions
- ADR-005: Exact model-membership routing — `isReservedAnthropicName` guards prevent Anthropic names entering the routing table, maintaining ADR-005's invariant
- ADR-004: `@types/node` pinned to Node-22 majors — affects `parseArgs` type signatures and `readdir({recursive:true})` in `makeLiveListAgentFiles`
- `.devflow/features/codex-leg/KNOWLEDGE.md` — Full model resolution contract (`buildRoutingTable`, five-rule resolution, canonical threading)
- `src/models.ts` — `formatModelsReport` and `buildModelRows` drive both `subswitch models` output and doctor's alias table
- `src/config.ts` — `loadConfig()` consumed by `serve`, `doctor`, and `models`; `init` reads it only in `seedWizard` (best-effort, errors silently swallowed)
- `src/version.ts` — Source of `SUBSWITCH_VERSION` used by `--version` and doctor output
