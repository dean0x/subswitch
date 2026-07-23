---
feature: cli-ux
name: CLI / init command / terminal UX
description: "Use when modifying the CLI entry point, init wizard, doctor preflight command, logger output format, or any terminal UX concern (colors, TTY detection, FORCE_COLOR, dry-run, CI safety). Keywords: cli, parseArgs, CliCommand, init, doctor, logger, clack, picocolors, TTY, NO_COLOR, FORCE_COLOR, interactive, non-interactive, dry-run, smoke-tarball, tty.ts."
category: architecture
directories: [src/cli.ts, src/init.ts, src/doctor.ts, src/logger.ts, src/tty.ts]
created: 2026-07-23
updated: 2026-07-24
---

# CLI / init command / terminal UX

## Overview

This knowledge base covers the full user-facing surface of subswitch: the CLI entry point (`src/cli.ts`), the `init` wizard (`src/init.ts`), the `doctor` preflight command (`src/doctor.ts`), the structured logger (`src/logger.ts`), and the single color-resolution utility (`src/tty.ts`). These files share three cross-cutting contracts that are easy to break silently: the non-interactive safety guarantee in `init`, the closed-field redaction guarantee in `logger`, and the single color-enable source of truth in `tty.ts`.

The CLI is a thin dispatcher — its only job is to parse flags, route to the right module, and plumb I/O. Business logic lives in pure functions inside each module, making the real behavior unit-testable without spawning a process. All fallible operations return `Result` types (never throw in business logic).

## System Context

`src/cli.ts` is the `#!/usr/bin/env node` binary entry point using Node's built-in `parseArgs` (no third-party arg-parsing library). Subcommands are positional; `serve` is the implicit default.

```
subswitch [command] [flags]
  serve     (default) — start the MITM proxy
  doctor    — preflight health checks; exits non-zero on any failure
  init      — interactive or non-interactive first-time setup
```

Global flags (`--help/-h`, `--version/-v`) are handled before subcommand dispatch and always exit 0. `init` is the only subcommand dispatched BEFORE `loadConfig()` is called — it must not depend on a pre-existing config file.

**USAGE invariant.** The `USAGE` constant in `src/cli.ts` (including the Examples and Environment sections) must stay byte-identical to the CLI reference block in the README. If you update one, update the other. Drift here breaks the "single canonical reference" property.

## Component Architecture

### src/tty.ts — Single color-resolution source

`resolveColorEnabled(env, isTTY)` is the single source of truth for color enable/disable logic. Precedence (highest wins):

1. `FORCE_COLOR` set to a non-empty value other than `"0"` → `true`
2. `NO_COLOR` key present in env (presence semantics — value is irrelevant) → `false`
3. `isTTY` fallback

Both `logger.ts` and `cli.ts` import this function. `FORCE_COLOR=0` and `FORCE_COLOR=""` are intentionally NOT treated as force-on; they fall through to `NO_COLOR`/`isTTY`. Any code that re-implements this logic in-line is a bug.

### src/config.ts — Constants and config loading

`DEFAULT_PORT` (`4141`) and `DEFAULT_CODEX_MODELS` (the four `gpt-5.6-*` / `gpt-5.5` names) are exported constants. Both the Zod schema defaults in `config.ts` and the init planning functions in `init.ts` derive from these constants — no duplicated literals.

`loadConfig` deliberately separates read from parse. Step 1 reads the file (catches `ENOENT` and permission errors). Step 2 parses JSON only when a file was found. A malformed JSON file returns a `Result` error with the message `malformed JSON in <path> — fix or delete the file`. An ENOENT on the implicit cwd path silently falls back to pure defaults; an ENOENT on an explicitly-requested path (via `configPath` option or `SUBSWITCH_CONFIG` env var) is an error.

`ANTHROPIC_BASE_URL` is always derived from `config.port` as `http://127.0.0.1:{port}`. This coupling is intentional: the Claude Code settings URL and the proxy port in `subswitch.config.json` cannot drift from each other because they come from the same source.

### src/cli.ts — Dispatcher

`parseCliArgs` returns a discriminated `CliCommand` union. `parseArgs` runs with `tokens: true` so the raw token stream is available for per-command flag validation after the global parse. Flag sets per command:

- `serve`: `verbose`, `quiet`, `port`
- `doctor`: (none — any flag on `doctor` is an error)
- `init`: `yes`, `dry-run`, `port`, `codex-model`, `codex-models`, `settings-target`

`ERR_PARSE_ARGS_UNKNOWN_OPTION` and `ERR_PARSE_ARGS_INVALID_OPTION_VALUE` from `parseArgs` are caught and translated to clean `unknown flag '<flag>'` messages; other `ERR_PARSE_ARGS_*` codes produce `invalid arguments`. Unknown errors re-throw.

The main switch is exhaustive: the `default` branch assigns to `never` and calls `fail()`, which is the TypeScript exhaustiveness guard pattern.

`serve --port` uses the same `PortSchema.safeParse` and the same error wording (`port must be an integer between 1 and 65535`) as `init --port`. These must stay in sync — both paths import `PortSchema` from `init.ts`.

`out()` / `errOut()` are local helpers writing directly to stdout / stderr. They are NOT routed through the structured logger — they are for human-readable one-shot messages (banners, init confirmation lines). Runtime request telemetry goes through the structured logger so it respects `--quiet`, `--verbose`, and the field allow-list.

### src/init.ts — Functional-core / imperative-shell

**Pure planning layer (no side effects, unit-testable directly):**

- `resolveInitDispatch(stdinIsTTY, stdoutIsTTY, hasCIEnv, yesFlag)` → `InitDispatchDecision`
- `resolveOptionsFromFlags(flags: InitFlags)` → `Result<InitOptions, InitError>` — all normalization, dedup, and validation; unified error shape `invalid --flag "value": reason`
- `planConfigWrite(existingJson, port, models, projectDir)` → `Result<ConfigWritePlan, InitError>` — deep-merge preserving all existing top-level and `codex.*` keys except `models`
- `planSettingsWrite(existingJson, port, settingsTarget, projectDir)` → `Result<SettingsWritePlan, InitError>` — merges only `env.ANTHROPIC_BASE_URL`; all other keys preserved
- `collectPreconditionWarnings(env, authFileExists, authFilePath)` → `string[]` — auth path must be computed from `homedir()` by the caller, not `env.HOME` (undefined on Windows)
- `settingsPathFor(target, projectDir)` — single source of truth for the settings file path
- `isPlainObject(v)` — plain-object guard re-used by init planning and by `doctor.ts`

`InitFlags` is the raw CLI shape (strings, no normalization). All normalization and deduplication of `--codex-model` (repeatable) and `--codex-models` (CSV) happens inside `resolveOptionsFromFlags`. `--codex-models ""` is always an error (flags were provided but resolved to empty).

**Effectful execution layer:**

`executeInit(options, deps, projectDir)` returns `Result<readonly [configPath, settingsPath], InitError>`. Write order is config-first: a dangling settings pointer (ANTHROPIC_BASE_URL pointing at a port with no config) is the more harmful partial state. All reads happen before any write; if either plan fails, nothing is written.

`InitFsDeps` is the injection seam. Production: `makeRealFsDeps()`. Tests: `makeFakeDeps()` from `test/unit/init-test-helpers.ts` (records `written` map and `writeOrder` array). `makeRealFsDeps().writeFile` uses atomic temp-then-rename: writes to `<path>.tmp.<pid>`, then renames over the target. A crash mid-write never leaves a partially-written config.

**Wizard (`runInitInteractive`):**

Signature: `runInitInteractive(projectDir, deps, env, prompts, flags?)` — returns an exit code (0 = success, 1 = cancel / empty selection / write failure). The `prompts` parameter is an `InitPrompts` interface — the injection seam for tests. The real implementation (`makeClackPrompts()`) lazy-imports `@clack/prompts` via dynamic `import()`. The factory is called in `cli.ts` only when actually entering the interactive path, so clack is never loaded on `serve`, `doctor`, `--help`, or `--version` paths.

Seeding precedence: flags → existing `subswitch.config.json` → defaults. Unknown models from flags or the existing config are offered as `(custom)` options in the multiselect list alongside the known model set. Cancel at any prompt returns 1 with zero writes.

**Dry-run path (`runInitDryRun`):**

`init --dry-run` is the only case where `resolveInitDispatch` is bypassed. It prints both plans to stdout and writes nothing, always exits 0 on success, and is allowed without `--yes` in a non-TTY or CI environment. This is not a fail-closed exception to the safety contract — it's correct because the contract only protects writes.

### src/doctor.ts — Preflight gate

`runDoctor` accepts an injected `DoctorIO` (including `color: boolean`). Color is resolved in `cli.ts` via `resolveColorEnabled(process.env, process.stdout.isTTY === true)` and passed as a boolean so `runDoctor` never touches `process.env` itself.

All three network probes (`probeSubswitch`, `probeTlsReachable` for anthropic, `probeTlsReachable` for codex) run via `Promise.all` for speed, but output is written in a fixed order after all results are available.

`row(label, value)` pads the label to `LABEL_WIDTH` (22) characters — all output is columnar. `passStr` / `failStr` are local helpers wrapping `pc.green` / `pc.red`.

Config-file detection is informational: a missing config file logs `(defaults — file not found)` but does NOT increment `failures`. Defaults produce a working proxy, so this is not a failure condition.

`makeLiveHttpGet` caps body reads at `MAX_BODY_BYTES` (8 KiB) using a stream reader loop — prevents unbounded buffering if the port is occupied by a chatty service.

Returns `0` (all checks pass) or `1` (any check fails). `cli.ts` assigns the return value to `process.exitCode`.

### src/logger.ts — Structured key=value logger

Emits to stderr. Format: `[HH:MM:SS] level=<L> event=<E> key=value …` (timestamp only when color is on). Color defaults to `resolveColorEnabled(process.env, process.stderr.isTTY === true)`. `createColors(color)` bypasses picocolors' own TTY detection so the `color` parameter is the single source of truth. Tests never run in a TTY so `color` defaults to `false` and existing assertions hold without explicit override.

Fields are serialized by iterating `FIELD_KEYS` in order. Any field in `LogFields` NOT in `FIELD_KEYS` is silently dropped — this is the compliance redaction boundary.

## Non-interactive Safety Contract

`resolveInitDispatch` is the single gateway. Three outcomes:

- `"interactive"` — both stdin and stdout are TTYs, no `CI` env var, no `--yes`. Runs the clack wizard.
- `"non-interactive"` — `--yes` is set. Runs the flag-driven writer regardless of TTY state or CI.
- `"refuse"` — non-TTY or CI env detected but `--yes` not provided. Exits 1. No files written.

`yesFlag` is checked before `hasCIEnv` in the decision tree. Do not add a branch that inspects CI state before checking `yesFlag` — that breaks `subswitch init --yes` in CI pipelines.

The `"refuse"` branch is deliberate: a CI pipeline that accidentally invokes `subswitch init` without `--yes` fails loudly rather than silently writing default-value files. Do not change this to fail-open.

**Exception:** `--dry-run` bypasses `resolveInitDispatch` entirely. `runInitDryRun` is allowed in any environment because it writes nothing.

## Settings Write: Idempotency and Non-destructive Merge

`planSettingsWrite` only touches `env.ANTHROPIC_BASE_URL`. All other keys are preserved verbatim. `planConfigWrite` only touches `port` and `codex.models`; all other top-level and `codex.*` keys are preserved. Both functions deep-merge, never replace the whole object.

Malformed existing JSON returns a `Result` error before any write occurs. There are no partial writes: both plans complete successfully before `executeInit` writes either file. Config is written before settings (config-first order).

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
| `--help`, `--version` | Always | 0 |

## Anti-Patterns

- **Re-implementing color logic inline** — always import `resolveColorEnabled` from `tty.ts`. Any inline `isTTY && !NO_COLOR` check will miss the `FORCE_COLOR` precedence and will diverge from the logger and doctor color decisions.

- **Using picocolors' global default export instead of `createColors(bool)`** — the global export re-detects TTY state itself, making the caller's boolean a no-op. Always use `createColors(bool)` so the `color` parameter passed in from the call site is the source of truth.

- **Widening `FIELD_KEYS` in logger.ts without a compliance review** — the closed field list is the redaction boundary. Adding a field that can carry token material, request content, or user data breaks the compliance guarantee. Any new field needs a documented non-reversible form (a count or a truncated prefix, never raw content).

- **Calling `out()` / `errOut()` from `serve` for runtime request logs** — these helpers are for startup banners and one-shot messages. Use the structured logger so output respects `--quiet`, `--verbose`, and the field allow-list.

- **Mutating the `config` object** from `loadConfig()` — apply overrides via object spread to produce a new `effectiveConfig`. The original `config` object is shared across the request lifecycle.

- **Asserting `subswitch doctor` exits 0 in smoke tests** — doctor exits non-zero whenever any check fails. In CI (no proxy running, no codex auth), all live checks fail. See the Gotchas section.

- **Adding a `cwd` field to `InitFsDeps`** — `InitFsDeps` is intentionally stateless; `projectDir` is passed explicitly to each function that needs it. Adding `cwd` to the interface would make the fake in tests stateful and harder to reason about.

- **Duplicating `DEFAULT_PORT` or `DEFAULT_CODEX_MODELS` literals** — both constants are exported from `config.ts` and imported by `init.ts`. Duplicating them anywhere else creates drift. `ALL_CODEX_MODELS` in `init.ts` is just a re-export alias: `export const ALL_CODEX_MODELS = DEFAULT_CODEX_MODELS`.

## Gotchas

**Doctor always exits non-zero in CI.** In CI environments: the subswitch proxy is not running (health probe fails), codex auth is not configured (auth file check fails), and TLS reachability depends on network policy. `scripts/smoke-tarball.sh` uses `subswitch --version` as the "binary resolves" signal — which always exits 0 — not `subswitch doctor`. If you add a new smoke assertion and are tempted to use doctor, use `--version` instead, or start a real serve instance and poll the health endpoint (applies PF-006).

**`FORCE_COLOR=0` and `FORCE_COLOR=""` do not force color.** Both fall through the FORCE_COLOR branch (the condition is `forceColor !== undefined && forceColor !== "" && forceColor !== "0"`) and hit the NO_COLOR / isTTY tiers. Only a non-empty, non-"0" value activates force-on.

**`--codex-models ""` is always an error.** If any model flag is provided (`--codex-model` or `--codex-models`) and the resolved list is empty after dedup and trimming, `resolveOptionsFromFlags` returns an `invalid_input` error. The empty-string case is specifically called out in the error message. No model flags at all defaults to `DEFAULT_CODEX_MODELS`.

**`makeClackPrompts()` must only be called on the interactive path.** It triggers a dynamic `import("@clack/prompts")` which loads the full clack module including terminal control sequences. Call it only inside the `if (decision === "interactive")` branch in `cli.ts`.

**`clack.multiselect` and friends return a Symbol on cancel.** `isCancel` must be checked before treating the return value as `string[]`. The `prompt()` helper inside `runInitInteractive` centralizes this guard — do not call prompts directly without an `isCancel` check.

**`parseArgs` with `strict: true` throws on unknown flags.** The catch block translates `ERR_PARSE_ARGS_*` errors to `Result` errors surfaced via `fail()`. Code after `fail()` still runs unless the caller returns explicitly — always `return` after `fail()`.

**`init` does not load `subswitch.config.json`.** It is dispatched before `loadConfig()`. Port and model selections come from flags, the wizard, or the `seedWizard` reader (which reads the file independently and silently ignores parse errors).

**Atomic write uses `<path>.tmp.<pid>`.** If a write is interrupted (process killed), a `.tmp.<pid>` file may be left behind. The cleanup `catch` block in `makeRealFsDeps().writeFile` attempts `unlink` on the temp file, but swallows the cleanup error to avoid masking the original write error.

**`exactOptionalPropertyTypes` conditional spreads in `makeClackPrompts`.** `@clack/prompts` was compiled without `exactOptionalPropertyTypes`, so passing optional fields directly would fail under strict mode. The factory uses `...(field !== undefined ? { field } : {})` spreads at every optional clack option. These are intentional and locally contained to the factory function.

## Key Files

- `src/tty.ts` — `resolveColorEnabled(env, isTTY)` — single color-enable source of truth imported by logger and cli
- `src/cli.ts` — Binary entry point; `parseCliArgs` → `CliCommand` union, `fail()`/`out()`/`errOut()` helpers, per-command flag sets, exhaustive switch with `never` guard
- `src/init.ts` — Pure planning (`resolveInitDispatch`, `planConfigWrite`, `planSettingsWrite`, `resolveOptionsFromFlags`, `collectPreconditionWarnings`, `settingsPathFor`, `isPlainObject`); `InitFsDeps` injection seam; `InitPrompts` seam; `makeClackPrompts()` factory; `runInitInteractive`, `runInitNonInteractive`, `runInitDryRun`
- `src/doctor.ts` — `runDoctor` preflight gate; `row()`/`LABEL_WIDTH` columnar output; `makeLiveHttpGet` with 8 KiB body cap; `makeLiveTlsConnect`
- `src/logger.ts` — `createConsoleLogger`; `FIELD_KEYS` compliance allow-list; `noopLogger`
- `src/config.ts` — `DEFAULT_PORT`, `DEFAULT_CODEX_MODELS`; `loadConfig` with read/parse split; malformed-JSON error
- `test/unit/init-test-helpers.ts` — `makeFakeDeps` shared factory for init unit tests (records `written` map and `writeOrder` array)
- `scripts/smoke-tarball.sh` — Tarball install + serve smoke test; uses `--version` not `doctor` for the binary-resolves assertion

## Related

- PF-006: Doctor exits non-zero without live services; smoke uses `--version` not `doctor`
- ADR-005: Exact model-membership routing (the model list in `DEFAULT_CODEX_MODELS` is the ground truth for which models the proxy routes)
- ADR-004: `@types/node` pinned to Node-22 majors (affects `parseArgs` type signatures)
- `.devflow/features/codex-leg/KNOWLEDGE.md` — The Codex request translation layer; `serve` wires `buildDeps` which creates the logger that this KB documents
- `src/config.ts` — `loadConfig()` consumed by `serve` and `doctor`; `init` reads it only in `seedWizard` (best-effort, errors silently swallowed)
- `src/version.js` — Source of `SUBSWITCH_VERSION` used by `--version` and doctor output
