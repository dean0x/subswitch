---
feature: cli-ux
name: CLI / init command / terminal UX
description: "Use when modifying the CLI entry point, init wizard, doctor preflight command, logger output format, or any terminal UX concern (colors, TTY detection, CI safety). Keywords: cli, parseArgs, init, doctor, logger, clack, picocolors, TTY, NO_COLOR, interactive, non-interactive, smoke-tarball."
category: architecture
directories: [src/cli.ts, src/init.ts, src/doctor.ts, src/logger.ts, scripts/smoke-tarball.sh]
created: 2026-07-23
updated: 2026-07-23
---

# CLI / init command / terminal UX

## Overview

This knowledge base covers the full user-facing surface of subswitch: the CLI entry point (`src/cli.ts`), the `init` wizard (`src/init.ts`), the `doctor` preflight command (`src/doctor.ts`), and the structured logger (`src/logger.ts`). These four files share two cross-cutting contracts that are easy to break silently: the non-interactive safety guarantee in `init` and the closed-field redaction guarantee in `logger`. Both are described in detail below.

The CLI is a thin dispatcher — its only job is to parse flags, route to the right module, and plumb I/O. Business logic lives in pure functions inside each module, making the real behavior unit-testable without spawning a process.

## System Context

`src/cli.ts` is the `#!/usr/bin/env node` binary entry point. It uses Node's built-in `parseArgs` (no third-party arg-parsing library). Subcommands are positional args; `serve` is the implicit default when no positional is given.

```
subswitch [command] [flags]
  serve     (default) — start the MITM proxy
  doctor    — preflight health checks; exits non-zero on any failure
  init      — interactive or non-interactive first-time setup
```

Global flags (`--help/-h`, `--version/-v`) are handled before subcommand dispatch and always exit 0. `SUBSWITCH_VERSION` is imported from `src/version.js`. `serve` accepts `--verbose`/`--quiet` as runtime log-level overrides. `init` accepts `-y/--yes`, `--port`, `--codex-model` (repeatable), `--codex-models` (csv), and `--settings-target`.

`init` is the only subcommand that does NOT require a pre-existing config file — it is dispatched before `loadConfig()` is called.

## Component Architecture

### src/cli.ts — Dispatcher

`parseArgs` runs with `strict: true`, so unknown flags produce an error surfaced via `fail()` (writes to stderr, sets `exitCode = 1`, does not throw). The `fail()` helper sets `process.exitCode` rather than calling `process.exit()`, which keeps the async tail clean. `out()` / `errOut()` are local helpers that write to stdout / stderr respectively; they are NOT routed through the structured logger — they are for human-readable one-shot messages (banners, ready lines, init output).

Verbosity override in `serve` is a non-mutating spread rather than a mutation of the loaded config:

```typescript
// cli.ts — non-mutating log-level override
const logLevel =
  verbose ? ("debug" as const)
  : quiet  ? ("warn" as const)
  :          config.logLevel;
// effectiveConfig is a new object; config is unchanged
const effectiveConfig = logLevel !== config.logLevel ? { ...config, logLevel } : config;
```

Key takeaway: never mutate the `config` object returned by `loadConfig()`.

### src/init.ts — Functional-core / imperative-shell

The module is split into a pure planning layer and an effectful execution layer. This is not stylistic — it's what makes the logic testable without touching the filesystem.

Pure functions (no side effects, unit-tested directly):
- `resolveInitDispatch(stdinIsTTY, stdoutIsTTY, hasCIEnv, yesFlag)` → dispatch decision
- `resolveOptionsFromFlags(flags)` → validated `InitOptions` or `InitError`
- `planSettingsWrite(existingJson, port, settingsTarget, projectDir)` → write plan or `InitError`
- `buildSubswitchConfig(port, codexModels)` → JSON string

Effectful layer:
- `executeInit(options, deps, projectDir)` — calls the two pure planners then writes files via the injected `InitFsDeps`
- `runInitInteractive(projectDir, deps, env)` — clack wizard; lazy-imports `@clack/prompts`
- `runInitNonInteractive(flags, projectDir, deps, write, errWrite)` — calls `resolveOptionsFromFlags` then `executeInit`
- `makeRealFsDeps()` — production `InitFsDeps` implementation

`InitFsDeps` is the injection seam: tests supply fake implementations; production wires Node `fs/promises`.

### src/doctor.ts — Preflight gate

`runDoctor` returns `0` (all checks pass) or `1` (any check fails). `cli.ts` assigns the return value to `process.exitCode`. The check list: config file detection, codex auth file parse (via lazy import of `inspectAuthFile`), subswitch health endpoint probe, Anthropic TLS reachability, Codex TLS reachability. Each failure increments `failures`; the final verdict line is colored red on failure, green on all-pass.

Color is decided at the call site in `cli.ts` (`process.stdout.isTTY === true && !("NO_COLOR" in process.env)`) and passed as a boolean `io.color` into `runDoctor`. Inside, `createColors(io.color)` is used so there is exactly one source of truth for color enablement.

### src/logger.ts — Structured key=value logger

The logger emits to stderr. Output format is `level=<L> event=<E> key=value …` with an optional `HH:MM:SS` dim timestamp prepended when color is on. Fields are serialized by iterating `FIELD_KEYS` in order — any field present in the `LogFields` object that is NOT in `FIELD_KEYS` is silently dropped.

Color is configured the same way as doctor: `createColors(color)` where `color` defaults to `process.stderr.isTTY === true && !("NO_COLOR" in process.env)`. Tests that need to assert colored output pass `color: true` explicitly — the default in test environments (non-TTY stderr) is `false`, so existing test assertions work without modification.

## Non-interactive Safety Contract

This is the most important invariant in `init`. `resolveInitDispatch` is the single gateway:

```typescript
// src/init.ts
export const resolveInitDispatch = (
  stdinIsTTY: boolean,
  stdoutIsTTY: boolean,
  hasCIEnv: boolean,
  yesFlag: boolean,
): InitDispatchDecision => {
  if (stdinIsTTY && stdoutIsTTY && !hasCIEnv && !yesFlag) return "interactive";
  if (yesFlag) return "non-interactive";   // --yes is the ONLY sanctioned non-interactive write path
  return "refuse";                          // non-TTY or CI without --yes → fail closed
};
```

The three outcomes:
- `"interactive"` — both stdin and stdout are TTYs, no `CI` env var, no `--yes`. Runs the clack wizard.
- `"non-interactive"` — `--yes` is set. Runs the flag-driven writer regardless of TTY state or CI.
- `"refuse"` — non-TTY or CI env detected but `--yes` not provided. Exits 1. **No files are written.**

The `"refuse"` branch is a deliberate fail-closed design: a CI pipeline that accidentally invokes `subswitch init` without `--yes` will fail loudly rather than silently writing files with default settings. Do not change this to fail-open.

## Settings Write: Idempotency and Non-destructive Merge

`planSettingsWrite` only ever touches the `env.ANTHROPIC_BASE_URL` key inside the target settings file. All other keys — including other `env` entries, `permissions`, `mcpServers`, etc. — are preserved verbatim.

`ANTHROPIC_BASE_URL` is always derived from the chosen port (`http://127.0.0.1:{port}`), which is also what goes into `subswitch.config.json`. This coupling is intentional: the URL in Claude Code settings and the proxy port in the subswitch config cannot drift from each other because they come from the same source.

Malformed existing JSON returns a `Result` error before any write occurs. There are no partial writes: `planSettingsWrite` completes successfully before `executeInit` writes either file. If planning fails, nothing is written.

## Clack Lazy Import

`@clack/prompts` is imported with `await import("@clack/prompts")` inside `runInitInteractive`. This means the clack module is never loaded in non-interactive or CI paths. Tests that test `resolveInitDispatch` or `runInitNonInteractive` do not pay the clack import cost and will never accidentally trigger terminal control sequences.

Every clack prompt call is followed by an `isCancel` guard. Missing a guard means a ctrl-C press produces a Symbol value that downstream code tries to use as a string, causing cryptic errors.

## Anti-Patterns

- **Widening `FIELD_KEYS` in logger.ts without a compliance review** — the closed field list is the redaction boundary. Adding a field that can carry token material, request content, or user data breaks the compliance guarantee. Any new field needs a documented purpose and must be non-reversible (e.g., a count or a truncated prefix, never raw content).

- **Calling `out()` / `errOut()` from `serve` for runtime request logs** — these helpers are for startup banners and one-shot messages. Runtime request telemetry goes through the structured logger so it respects `--quiet`, `--verbose`, and the field allow-list.

- **Using picocolors' global default export instead of `createColors(enabled)`** — the global export detects TTY state itself, which means the caller's boolean becomes a no-op. Always use `createColors(bool)` to keep color control at the call site.

- **Asserting `subswitch doctor` exits 0 in smoke tests** — doctor exits non-zero whenever any check fails. In CI (no proxy running, no codex auth), all live checks fail. See the Gotchas section.

- **Mutating the `config` object** in `serve` or anywhere else — `loadConfig()` returns an object shared across the request lifecycle. Apply overrides with object spread to produce a new `effectiveConfig`.

## Gotchas

**Doctor always exits non-zero in CI.** `runDoctor` counts failures and returns `1` if any check fails. In CI environments: the subswitch proxy is not running (health probe fails), codex auth is not configured (auth file check fails), and TLS reachability depends on network policy. `scripts/smoke-tarball.sh` uses `subswitch --version` — which always exits 0 — as the "binary resolves" signal. It does NOT call `subswitch doctor`. If you add a new smoke assertion and are tempted to use doctor, use `--version` instead, or start a real serve instance and poll the health endpoint (which the script already does for the serve check).

**`resolveInitDispatch` with `yesFlag: true` short-circuits TTY and CI checks.** `--yes` makes the non-interactive path execute even on a real interactive terminal. This is correct for scripting but means that `yesFlag` is always checked before `hasCIEnv` in the decision tree. Adding a new branch that checks CI state before `yesFlag` would break `subswitch init --yes` in CI pipelines.

**`parseArgs` with `strict: true` throws on unknown flags.** The catch block in `main` surfaces the error via `fail()`, which does not throw — it sets `process.exitCode = 1` and returns. Code after `fail()` still runs unless the caller returns explicitly. Always return after `fail()`.

**`init` does not load `subswitch.config.json`.** It is dispatched before `loadConfig()`. Port and model selections are collected from flags or the clack wizard, not from any existing config file.

**`clack.multiselect` returns a `Symbol` (not an array) on cancel.** `isCancel` must be checked before treating the return value as `string[]`. The same applies to `clack.text` and `clack.select`. Omitting the guard causes a runtime type error that manifests as a confusing `TypeError` deep in the write path.

## Key Files

- `src/cli.ts` — Binary entry point; `parseArgs` dispatch, `fail()`/`out()`/`errOut()` helpers, verbosity override pattern
- `src/init.ts` — Pure planning functions (`resolveInitDispatch`, `planSettingsWrite`, `buildSubswitchConfig`, `resolveOptionsFromFlags`), `InitFsDeps` injection seam, clack wizard
- `src/doctor.ts` — `runDoctor` preflight gate, `probeSubswitch`, `probeTlsReachable`, production live I/O factories (`makeLiveHttpGet`, `makeLiveTlsConnect`)
- `src/logger.ts` — `createConsoleLogger`, `FIELD_KEYS` compliance allow-list, `noopLogger`
- `scripts/smoke-tarball.sh` — Tarball install + serve smoke test; uses `--version` not `doctor` for the binary-resolves assertion

## Related

- `.devflow/features/codex-leg/KNOWLEDGE.md` — The Codex request translation layer; `serve` wires `buildDeps` which creates the logger that this KB documents
- `src/version.js` — Source of `SUBSWITCH_VERSION` used by `--version` and doctor output
- `src/config.ts` — `loadConfig()` consumed by `serve` and `doctor`; `init` bypasses it deliberately
