---
feature: cli-ux
name: CLI / init command / terminal UX
description: "Use when modifying the CLI entry point, init wizard, doctor preflight command, logger output format, log event names, config load and provider config resolution, the models alias table, or any terminal UX concern (colors, TTY detection, FORCE_COLOR, dry-run, CI safety). Keywords: cli, parseArgs, CliCommand, init, doctor, models, logger, providerEvents, provider-events, log injection, FIELD_KEYS, clack, picocolors, TTY, NO_COLOR, FORCE_COLOR, interactive, non-interactive, dry-run, smoke-tarball, tty.ts, models.ts, agent-scan, buildRoutingTable, buildDeps, ProviderConfigs, PROVIDER_SCHEMAS, PROVIDER_RESOLVERS, detectUnknownProviderKeys, detectLegacyConfigKeys, configuredProviders, providerConfigFor."
category: architecture
directories: [src/cli.ts, src/init.ts, src/doctor.ts, src/logger.ts, src/provider-events.ts, src/tty.ts, src/models.ts, src/agent-scan.ts, src/config.ts, src/server.ts]
created: 2026-07-23
updated: 2026-07-28
---

# CLI / init command / terminal UX

## Overview

This knowledge base covers the full user-facing surface of subswitch: the CLI entry point (`src/cli.ts`), the `init` wizard (`src/init.ts`), the `doctor` preflight command (`src/doctor.ts`), the structured logger (`src/logger.ts`) with its event-name table (`src/provider-events.ts`), and the single color-resolution utility (`src/tty.ts`). `src/config.ts` (load + resolve), `src/models.ts` (pure model registry) and `src/agent-scan.ts` (doctor's frontmatter scanner) are tightly coupled to it, and `src/server.ts`'s `buildDeps` is the wiring seam every CLI path funnels through.

These files share four cross-cutting contracts that are easy to break silently: the non-interactive safety guarantee in `init`, the closed-field redaction guarantee plus the compile-time event-name guarantee in `logger`, the single color-enable source of truth in `tty.ts`, and the **fail-the-load-on-unrecognised-key** guarantee in `config.ts`.

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

Both `logger.ts` and `cli.ts` import this function. `FORCE_COLOR=0` and `FORCE_COLOR=""` are intentionally NOT treated as force-on; they fall through to `NO_COLOR`/`isTTY`. Any code that re-implements this logic in-line is a bug. See Gotchas for the deliberate no-color.org divergence.

### src/config.ts — Config load and resolution

`DEFAULT_PORT` (`4141`) and `DEFAULT_CODEX_AUTH_FILE` (`~/.codex/auth.json`) are the exported constants. The model-list constants (`DEFAULT_CODEX_MODELS`, `ALL_MODEL_IDS`) no longer exist — the routable set comes from `MODEL_REGISTRY` in `models.ts` (applies ADR-006).

**`FileConfig` / `Config` split.** `FileConfigSchema.safeParse` produces a `FileConfig` (on-disk shape). `resolveConfig(file)` is a pure mapping into the runtime `Config`. `Config` is hand-written, NOT `z.infer`, so `authFile` is always tilde-expanded and the parse-time `kind` discriminant cannot leak into the runtime shape.

**The resolved `Config` is keyed by `ProviderId`, not a top-level `codex` block.** Consumers read `config.providers.codex.*`. `anthropic` deliberately stays top-level and is NOT folded into `providers`: it has no model list, no auth config of its own (the client's credential is forwarded verbatim, applies ADR-002), there is exactly one, and it is always present. Symmetry would give it fields it does not have.

**Totality is compile-enforced, and this list is the checklist for adding a provider.** Adding a member to `PROVIDER_IDS` produces `tsc` errors at every declaration below; none of them is a switch with a `default` arm, so there is no unreachable fallback returning sentinels that callers must then guard:

| Declaration | File | Mechanism |
|---|---|---|
| `PROVIDER_SCHEMAS` | config.ts | `satisfies { [K in ProviderId]: z.ZodType }` — checks both directions (missing id AND misspelled excess key) |
| `ProviderConfigs` | config.ts | `{ [K in ProviderId]: ProviderConfigShape[K] }` — mapped over the union, not written out |
| `PROVIDER_CONFIG_ACCESSORS` | config.ts | `Record<ProviderId, (config) => ProviderRuntimeConfig>` |
| `aliasesByProvider` | config.ts | declared return type `Record<ProviderId, Record<string,string>>` |
| `PROVIDER_RESOLVERS` | config.ts | per-key signature `(file: FileConfig["providers"][K]) => ProviderConfigShape[K]` — correlates each file slice with its own resolved slice, so a resolver cannot be wired to the wrong provider's shape |
| `resolveConfig` | config.ts | `providers: { codex: … }` object literal vs `ProviderConfigs` |
| `buildDeps` | server.ts | `providers: { codex: … }` vs `ServerDeps.providers: Record<ProviderId, ProviderHandler>` |

`resolveConfig` builds providers key-by-key rather than iterating `PROVIDER_IDS` on purpose: a loop cannot preserve the key→slice-type correlation without a cast, and that cast is exactly the completeness check `PROVIDER_RESOLVERS` exists to provide. Each resolver builds its slice field-by-field rather than by spread, so a field added to the schema but not to the resolver fails to compile instead of riding along untransformed.

**Provider slices are heterogeneous by design.** `CodexProviderConfig` carries `oauthTokenUrl`, which is a detail of the ChatGPT OAuth flow — it must not be forced onto a provider that authenticates with a static key or not at all.

**`kind` discriminant.** Zod reads discriminator fields before defaults fire, so `kind: z.literal("codex")` in `CodexProviderSchema` cannot carry `.default("codex")`. `PROVIDER_SCHEMAS` wraps each schema in `z.preprocess(raw => injectKind(raw, "<id>"), …)` to inject `{ kind: key }` from the record key before parsing.

**Two raw pre-parse scans reject unrecognised keys — this is the load-fails-loudly contract (avoids PF-010).** Zod's `z.object` STRIPS unknown keys rather than reporting them, so a stripping schema can never say what it discarded. Both scans therefore run on the RAW parsed JSON, before `FileConfigSchema.safeParse`, and a hit is a hard `exit 1`:

- `detectLegacyConfigKeys(raw)` — keys from the pre-`providers.*` layout (`codex`, `reasoningCache`, the moved `limits.*` keys, plus deleted `codex.models`), each paired with its replacement path. Table is append-only: every future restructure owes it a row.
- `detectUnknownProviderKeys(raw)` — `providers.<id>` blocks whose id is not in `PROVIDER_IDS`. A typo (`providers.codexx`) or a block for a provider this build does not ship parses clean and does absolutely nothing.

Without these, a legacy or typo'd config looks correct on disk while `baseUrl` silently reverts to the public endpoint, `userAgent` to the built-in default, custom aliases vanish, and the user's configured provider is reported as absent — with no diagnostic anywhere. Verified end-to-end by the QA pass and documented in the README ("An unrecognised key is rejected, not ignored").

Both scans and `detectConfiguredProviders` walk with `Object.hasOwn` only, through the file's single `isPlainObject` predicate (there is deliberately one implementation to harden), so a polluted prototype can neither forge a match nor mask one.

**`LoadConfigResult.configuredProviders`** is a `ReadonlySet<ProviderId>` of providers whose block was literally present in the raw config (own-property check only). Zod fills all provider defaults unconditionally, so `Config` alone cannot answer "did the user opt in?" — but doctor's severity rules depend on it (an unconfigured provider stays informational and never fails the exit code, avoids PF-006).

**`providerConfigFor(config, id)`** returns the provider-neutral `ProviderRuntimeConfig` slice (`displayName`, `authFile`, `baseUrl`, `loginCommand`, `defaultHost`) that doctor, `/__subswitch/health`, the serve banner, and `models --json` all read. `defaultHost` lives here rather than as a constant in `server.ts` so the base-URL-override warning is per-provider by construction — one provider's default host can never be used to vet another's.

**`loginCommand`** has two consumers: `src/doctor.ts` (names the command in the auth-status check, original usage) and `src/server.ts`, which wires it into `CodexHandlerDeps` so the 401 remediation path can suffix `` — run `<loginCommand>` `` on an unresolvable 401 (after a refresh cycle). It is config-sourced rather than synthesized because a provider whose id is `kimi` may log in via `kimi auth login`, not `kimi login` — so `` `${providerId} login` `` is not a safe derivation. Test U2.1 exists to catch exactly this mistake.

**Three per-provider limits.** Each provider has `requestTimeoutMs`, `streamIdleTimeoutMs`, `maxSseEventBytes`. `connectTimeoutMs` and `maxUpstreamSockets` are Anthropic-leg-only (under `anthropic.*`) because the Codex leg uses global `fetch`. The global `limits.*` block holds `maxBodyBytes`, `pingIntervalMs`, and `maxConcurrentRequests` (default 32) — a single leaked decrement-without-increment permanently degrades the server to 503.

`ANTHROPIC_BASE_URL` is always derived from `config.port` as `http://127.0.0.1:{port}`. Coupling is intentional: the Claude Code settings URL and the proxy port cannot drift from each other because they come from the same source.

### src/provider-events.ts — Compile-time-safe log event names

`providerEvents<P extends ProviderId>(providerId: P): ProviderEvents<P>` derives the 11 provider-scoped log event names from a provider id using template-literal types. **This is a security control, not a naming convenience.** `logger.ts` interpolates the event *name* into the same line as everything else; before this existed, only field *values* were stripped and quoted, so a config-derived event name was a log-injection vector.

The guarantee is **compile-time**, not a runtime check that could be bypassed:

```ts
export interface ProviderEvents<P extends ProviderId> {
  // Every field is a template literal over the type parameter. Two consequences:
  //   1. Only a member of the closed ProviderId union (compile-time string literals)
  //      can reach the derivation — a config-supplied `string` containing "\n" is a
  //      COMPILE error at the call site, so it can never become an event name.
  //   2. Each name is falsifiable: inside the generic function a hardcoded
  //      "codex_upstream_error" is not assignable to `${P}_upstream_error`, so
  //      re-hardcoding any single name fails tsc.
  readonly upstreamError: `${P}_upstream_error`;
  readonly baseUrlOverrideDetected: `${P}_base_url_override_detected`;
  // …9 more
}
```

Takeaways: never widen the parameter to `string` "for flexibility" — that deletes the control. Callers (`codex-handler.ts`, `codex-response.ts`, `server.ts`) resolve the record **once at construction time** and hold it, so the hot streaming path does no string work. `FIELD_KEYS` in `logger.ts` is a different axis (which *fields* may be logged) and is deliberately untouched by this — nothing here adds or widens a field.

**Known gap.** Six `codex_*` event names remain hardcoded in `src/codex-auth.ts` (≈ lines 224, 232, 239, 300, 319, 329), outside the 11-name `ProviderEvents` table. They are compile-time string literals, so the log-injection guarantee holds — but they are **not** table-derived. A second provider's auth manager would emit `codex_*` events or need its own hand-written copies. The guarantee to state is "literal", not "table-derived".

### src/models.ts — Pure model registry (no repo imports)

Deliberately imports nothing from the rest of the repo — `config.ts` imports it, and the edge must stay one-way. See `codex-leg/KNOWLEDGE.md` for the full resolution contract.

Key exports for CLI UX:

- `PROVIDER_IDS = ["codex"] as const` and `ProviderId` — the closed union all the totality anchors above key on.
- `MODEL_REGISTRY` — the routable set source (applies ADR-006).
- `buildRoutingTable(registry, aliasesByProvider)` — called in both `buildDeps` (server) and `runDoctor` (CLI).
- `resolveModel(table, name)` — five-rule resolution returning `ModelResolution`.
- `isReservedAnthropicName(name)` — prefix-based (not exact); guards alias keys and targets in `buildRoutingTable` and `AliasesSchema` refines in `config.ts`. Also the skip predicate in `agent-scan.ts`.
- `formatModelsReport(input)` — human-readable alias table. Takes `{ registry, aliasesByProvider }`.
- `buildModelRows(registry, aliasesByProvider)` — model-centric rows for `--json` output.
- `buildAliasRows(registry, aliasesByProvider)` — alias-centric rows used internally by `formatModelsReport`.

All three row-building entry points take the **same per-provider alias record** that `buildRoutingTable` takes — `aliasesByProvider(config)` from `config.ts` — so the routing table and the displayed alias table cannot disagree about their input.

### src/cli.ts — Dispatcher

`parseCliArgs` returns a discriminated `CliCommand` union. Flag sets per command:

- `serve`: `verbose`, `quiet`, `port`
- `doctor`: (none — any flag on `doctor` is an error)
- `models`: `json` only
- `init`: `yes`, `dry-run`, `port`, `settings-target`

Per-command flag validation walks `parseArgs` **tokens**, not `values` — `values` cannot tell a flag that was passed from one that merely has a default. `ERR_PARSE_ARGS_UNKNOWN_OPTION` and `ERR_PARSE_ARGS_INVALID_OPTION_VALUE` are caught and translated to clean `unknown flag '<flag>'` messages.

The main switch is exhaustive: the `default` branch assigns to `never` and calls `fail()`. `main()` has a top-level `.catch` so any escaped rejection still produces the `subswitch: <message>` stderr contract rather than a raw Node stack trace.

**`models` subcommand.** Calls `loadConfig()`, then dispatches on `--json`:
- Without `--json`: `formatModelsReport({registry: MODEL_REGISTRY, aliasesByProvider: aliasesByProvider(config)})`, colorized via picocolors.
- With `--json`: `buildModelRows(…)` inside a payload carrying `kind`, `schemaVersion`, `subswitchVersion`, `name`, `fallbackProvider: "anthropic"`, `configPath`, `configFileFound`, `providers[]`, `models[]`. Anthropic is listed in `providers[]` with `routing: "passthrough"` even though it contributes no model rows — everything unresolved falls through to it, so a consumer enumerating destinations must not have to special-case it.

The JSON branch **returns before `resolveColorEnabled` is ever called** (`cli.ts` `main()` `case "models"`, and `modelsJson` itself never calls it). This is structural, not conditional: `FORCE_COLOR` cannot bleed into JSON output even on a real TTY. Re-verified 2026-07-28: `FORCE_COLOR=1 subswitch models --json` emits zero ANSI bytes while the table form emits them; two consecutive runs are byte-identical; alias declaration order does not leak into output.

**Per-provider ready banner.** On `serve`, the banner prints one line per `PROVIDER_IDS` entry with model count and host, via `providerConfigFor`.

`out()` / `errOut()` write directly to stdout / stderr — NOT routed through the structured logger. Use the structured logger for runtime request telemetry so output respects `--quiet`, `--verbose`, and the field allow-list.

### src/server.ts — The one wiring site

`buildDeps(config, logger = createConsoleLogger(config.logLevel))` is the only place production dependencies are constructed. The **logger is a defaulted parameter, not a local**. This shape is load-bearing: when the logger was built inside `buildDeps` and only spread onto its result, `startSubswitch`'s `logger` option replaced only the request-loop's logger while every handler kept the internally-built one — a test that injected a logger to observe handler records saw none of them and its assertions passed vacuously. See Anti-Patterns.

`createCodexProvider(config, logger)` constructs `ReasoningCache` and `CodexAuthManager` only when a Codex provider is actually wired (applies ADR-002). The auth object is **annotated**, not inferred, as `ProviderAuth<"codex">` so conformance is checked at the wiring site — the place a mismatched credential would enter — as well as at `implements`.

`src/provider-auth.ts` is the real seam that replaced the old tripwire comment: `ProviderAuth<P>` and `ProviderCredential<P>`. The brand is a real `provider: P` field, not a phantom `unique symbol`, so a credential is constructible without a cast — and `ProviderCredential<"codex">` is not assignable to another provider's, making cross-wiring a subscription token a compile error rather than a runtime leak to a third-party host. The credential carries **only** auth headers; transport constants (`openai-beta`, `originator`, `session_id`) stay out, so everything secret sits under one key with a single redaction boundary to audit.

At startup `buildDeps` warns (`<id>_base_url_override_detected`) when a provider's configured `baseUrl` hostname differs from its own `defaultHost`, and logs `alias_rejected`, `alias_dangling_target`, `ambiguous_family`, and `registry_entry_uses_reserved_name` from the `buildRoutingTable` result. `buildRoutingTable` is total and reports problems as data rather than throwing — which only helps if someone reads them.

### src/init.ts — Functional-core / imperative-shell

**`InitFlags`** is `{ port?: string; settingsTarget?: string }`.

**Pure planning layer (no side effects, unit-testable directly):**

- `resolveInitDispatch(stdinIsTTY, stdoutIsTTY, hasCIEnv, yesFlag)` → `InitDispatchDecision`
- `resolveOptionsFromFlags(flags)` → `Result<InitOptions, InitError>` — validates port and settings-target only.
- `planConfigWrite(existingJson, port, projectDir)` → `Result<ConfigWritePlan, InitError>` — deep-merges only `port`; all other top-level keys preserved. No model list is ever written.
- `planSettingsWrite(existingJson, port, settingsTarget, projectDir)` — merges only `env.ANTHROPIC_BASE_URL`.
- `collectPreconditionWarnings(env, authFileExists, authFilePath)` — auth path must be computed from `homedir()` by the caller, not `env.HOME` (undefined on Windows).
- `settingsPathFor(target, projectDir)` — single source of truth for the settings file path.
- `isPlainObject(v)` — re-used by `doctor.ts` (note: `config.ts` keeps its own copy deliberately, because that one is a prototype-pollution boundary).

**Effectful execution layer:** `executeInit(options, deps, projectDir)` returns `Result<readonly [configPath, settingsPath], InitError>`. Write order is config-first: a dangling settings pointer is the harmful partial state. All reads happen before any write; if either plan fails, nothing is written. `InitFsDeps` is the injection seam; `makeRealFsDeps().writeFile` uses atomic temp-then-rename.

**Wizard (`runInitInteractive(projectDir, deps, env, prompts, flags?)`):** prompts only for **port** and **settings-target**. `seedWizard` seeds port from flags → existing config → default. `makeClackPrompts()` lazy-imports `@clack/prompts` via dynamic `import()` and is called only when entering the interactive path.

**Dry-run:** `init --dry-run` bypasses `resolveInitDispatch`, prints both plans, writes nothing. Allowed without `--yes` in any environment — the fail-closed contract only protects writes.

### src/doctor.ts — Preflight gate

`runDoctor(config, configPath, fileFound, io, configuredProviderIds)`. The fifth parameter is `ReadonlySet<ProviderId>` defaulting to `new Set<ProviderId>()` — the conservative default, because a provider the user never asked for must never fail their exit code.

**N-provider auth check (PF-006 severity rules):**
- Provider absent from config file → informational; no `failures++`.
- Provider present in config file but credential missing or broken → failure. The user opted in, so a broken opt-in is a real problem.
- A credential file that exists but does not parse is a failure **regardless** of opt-in — the user clearly has one.

Each `checkOneProvider` call returns its output lines rather than writing them, so N concurrent checks cannot interleave — lines are written in `PROVIDER_IDS` order after all complete. The subswitch probe, the Anthropic TLS probe, the per-provider TLS probes, and the per-provider auth checks all run in one `Promise.all`.

Doctor calls `buildRoutingTable` once at the start; `table` goes to `checkAgentModels`, and `danglingAliases` drives dangling-alias warnings (each increments `failures`).

**Agent scan:** both `.claude/agents/` (relative to cwd) AND `~/.claude/agents/` (user-global), deduplicated with a `Set` of absolute strings.

`row(label, value)` pads the label to `LABEL_WIDTH` (22) characters. Config-file missing is informational. Returns `0` or `1`; `cli.ts` assigns to `process.exitCode`.

### src/agent-scan.ts — Agent frontmatter scanner

No external dependencies. Imports `isReservedAnthropicName` from `models.ts` to skip Anthropic-named subagents.

`parseFrontmatterModel(text)` extracts the `model:` value: requires `---` on line 1, scans to closing `---`, capped at 8 KiB / 200 lines, handles CRLF, strips surrounding quotes and trailing `# comment`. `modelPreference:` and similar prefixed keys are NOT matched.

`checkAgentModels(files, table, configuredProviders)` calls `resolveModel(table, model)` per file and maps to six finding kinds. Severity travels with each `AgentFinding` struct — never re-derived by the renderer.

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

**Log injection prevention — two axes, don't conflate them:**
- `FIELD_KEYS` bounds *which fields* may be logged. It says nothing about the event token.
- `renderToken(value)` strips `[\r\n]` then quotes anything containing whitespace or `=` (which would otherwise parse as extra top-level fields under logfmt's last-wins semantics). It is applied to **both** field values **and the event token**. On real values it is a no-op.

The event-token treatment is defence in depth. The primary control is that every event name in the tree is a compile-time string literal — the 11 provider-scoped ones via `providerEvents` (see above), the rest hand-written constants.

## Non-interactive Safety Contract

`resolveInitDispatch` is the single gateway. Three outcomes: `"interactive"` (both TTYs, no CI, no `--yes`), `"non-interactive"` (`--yes` set), `"refuse"` (non-TTY or CI without `--yes`). `yesFlag` is checked before `hasCIEnv` — do not add a branch that inspects CI state before checking `yesFlag`.

**Exception:** `--dry-run` bypasses `resolveInitDispatch` entirely — it writes nothing.

## Exit-code Contract

| Command | Condition | Exit code |
|---------|-----------|-----------|
| `serve` | Listening successfully | 0 (never exits — waits for signal) |
| `serve` | Port in use / bad config | 1 |
| any | Unrecognised config key (legacy or unknown provider block) | 1 (load fails before dispatch) |
| `doctor` | All checks pass / any check fails | 0 / 1 |
| `init` | Files written | 0 |
| `init` | User cancelled, or refused (non-TTY, no `--yes`) | 1 |
| `init --dry-run` | Plans printed / bad flags | 0 / 1 |
| `models`, `models --json` | Output emitted | 0 |
| `--help`, `--version` | Always | 0 |

## Anti-Patterns

- **Building a dependency inside a factory and then spreading it onto the result, when callers can also inject it.** This is the fake-ignores-its-argument shape and it makes tests pass vacuously. `buildDeps` hit it exactly: handlers closed over the logger `buildDeps` built itself, so an injected test logger observed nothing and its assertions were trivially satisfied. Fix is structural — take the dependency as a **defaulted parameter** so the injected instance reaches everything constructed from it. Anyone writing a rig against this server should assert their fake was actually *used*, not merely accepted.

- **Widening `providerEvents`' parameter to `string`** — the compile-time closed-union input IS the log-injection control. A runtime sanitization check is not an equivalent substitute; it can be bypassed, and it moves a compile error to a runtime hope.

- **Re-hardcoding a provider event name** — inside `providerEvents` a literal is not assignable to its template-literal type, so `tsc` catches it. Outside it (the `codex-auth.ts` six), nothing catches it. Prefer threading the resolved `ProviderEvents<P>` record.

- **Re-implementing color logic inline** — always import `resolveColorEnabled` from `tty.ts`. Any inline `isTTY && !NO_COLOR` check misses the `FORCE_COLOR` precedence and diverges from the logger and doctor color decisions.

- **Using picocolors' global default export instead of `createColors(bool)`** — the global export re-detects TTY state itself, making the caller's boolean a no-op.

- **Widening `FIELD_KEYS` in logger.ts without a compliance review** — the closed field list is the redaction boundary. Any new field needs a documented non-reversible form (a count or truncated prefix, never raw content).

- **Adding a provider dispatch as a `switch` with a `default` arm, or as a `Partial`/`Map`** — every provider-keyed structure in `config.ts` and `server.ts` is a total `Record`/mapped type precisely so the completeness check is structural. A `default` arm returning empty-string sentinels turns a compile error into a runtime guard every caller has to remember.

- **Adding a config restructure without a `LEGACY_KEY_MOVES` row** — reintroduces PF-010 exactly. The table is append-only.

- **Calling `out()` / `errOut()` from `serve` for runtime request logs** — use the structured logger so output respects `--quiet`, `--verbose`, and the field allow-list.

- **Mutating the `config` object** from `loadConfig()` — apply overrides via object spread to produce a new `effectiveConfig`.

- **Asserting `subswitch doctor` exits 0 in smoke tests** — doctor exits non-zero whenever any check fails (applies PF-006).

- **Adding a `cwd` field to `InitFsDeps`** — it is intentionally stateless; `projectDir` is passed explicitly.

## Gotchas

**`FORCE_COLOR` beats `NO_COLOR` here — this inverts the no-color.org convention.** `FORCE_COLOR=1 NO_COLOR=1 subswitch models` emits ANSI. That is deliberate (explicit force-on is treated as the more specific intent) and verified 2026-07-28. Do not "fix" it by reordering the tiers in `tty.ts` without a decision record — every color-emitting surface reads that one function, so the reorder is global.

**`FORCE_COLOR=0` and `FORCE_COLOR=""` do not force color.** Both fall through the FORCE_COLOR branch (`!== undefined && !== "" && !== "0"`) and hit the NO_COLOR / isTTY tiers.

**Doctor probes TLS on port 443 unconditionally.** `probeTlsReachable(host, deps)` calls `deps.tlsConnect(host, 443)` and the host comes from `new URL(baseUrl).hostname` — the configured URL's scheme and port are discarded. An operator with an `http://` or non-443 `baseUrl` (a local mock, a proxy on 8443) always sees `TLS: FAIL` and a `failures++`. Pre-existing; the fix is to derive port and skip the probe for non-TLS schemes.

**A trailing positional is silently ignored.** `parseCliArgs` reads `positionals[0]` and never checks `positionals.length`, so `subswitch models --json extra` exits 0 and emits normal JSON, while a bad *first* positional (`subswitch modelz`) is rejected with exit 1. Minor inconsistency; verified 2026-07-28.

**Doctor always exits non-zero in CI.** The proxy is not running, codex auth is not configured, and TLS reachability depends on network policy. `scripts/smoke-tarball.sh` uses `subswitch --version` — always exits 0 — not `subswitch doctor` (applies PF-006).

**Zod strips unknown keys — the two raw pre-parse scans are the only thing standing between a stale config and a silent revert to defaults.** `detectLegacyConfigKeys` and `detectUnknownProviderKeys` both run on the raw object before `safeParse`, because the schema can never report what it discarded (avoids PF-010).

**`isReservedAnthropicName` guards places that must never disagree.** `AliasesSchema` refines in `config.ts`, `buildRoutingTable` at table-build time, and the agent-scan skip list all use the same predicate. Any new guard surface must import it rather than reimplement it.

**`makeLiveListAgentFiles` must resolve dirs to absolute paths.** The factory calls `pathResolve(dir)` before scanning. Without this, running from `$HOME` makes the project relative path and the user absolute path produce different strings for the same directory, the `Set` dedup in `runDoctor` fails silently, and finding counts double. A test injecting fakes through `DoctorIO` cannot catch this.

**`makeClackPrompts()` must only be called on the interactive path.** It triggers a dynamic `import("@clack/prompts")` loading terminal control sequences. Call it only inside the `if (decision === "interactive")` branch.

**`clack.multiselect` and friends return a Symbol on cancel.** `isCancel` must be checked before treating the return value as a string; the `prompt()` helper centralizes this guard.

**`parseArgs` with `strict: true` throws on unknown flags.** The catch block translates `ERR_PARSE_ARGS_*` to `Result` errors. Always `return` after `fail()` — code after it still runs unless the caller returns explicitly.

## Key Files

- `src/tty.ts` — `resolveColorEnabled(env, isTTY)` — single color-enable source of truth
- `src/cli.ts` — Binary entry point; `parseCliArgs` → `CliCommand` union; token-based per-command flag validation; `models --json` payload; per-provider serve banner; exhaustive switch with `never` guard
- `src/config.ts` — `FileConfig`/`Config` split; `ProviderConfigs` keyed by `ProviderId` with `anthropic` deliberately top-level; `PROVIDER_SCHEMAS` / `PROVIDER_RESOLVERS` / `PROVIDER_CONFIG_ACCESSORS` totality anchors; `detectLegacyConfigKeys` + `detectUnknownProviderKeys` raw pre-parse scans; `providerConfigFor`; `aliasesByProvider`; `LoadConfigResult.configuredProviders`
- `src/provider-events.ts` — `providerEvents<P extends ProviderId>`; template-literal `ProviderEvents<P>`; the compile-time log-injection control
- `src/logger.ts` — `createConsoleLogger`; `FIELD_KEYS` compliance allow-list; `renderToken` applied to values AND the event token; `noopLogger`
- `src/server.ts` — `buildDeps(config, logger?)` — the one wiring site, logger as defaulted parameter; `createCodexProvider`; startup base-URL-override and routing-table warnings
- `src/provider-auth.ts` — `ProviderAuth<P>` / `ProviderCredential<P>` branded seam; auth-headers-only credential surface
- `src/doctor.ts` — `runDoctor` preflight gate; `DoctorIO`; N-provider fan-out; `checkOneProvider` (returns lines, never writes); `makeLiveListAgentFiles` (absolute-path resolution critical); `probeTlsReachable` (hardcoded 443)
- `src/init.ts` — Pure planning + `InitFsDeps` / `InitPrompts` seams; wizard prompts only port + settings-target
- `src/agent-scan.ts` — `parseFrontmatterModel` (hand-rolled, no YAML dep); `checkAgentModels`; six finding kinds
- `src/models.ts` — Pure registry; `MODEL_REGISTRY`, `PROVIDER_IDS`, `buildRoutingTable`, `resolveModel`, `isReservedAnthropicName`, `formatModelsReport`, `buildModelRows`
- `src/codex-auth.ts` — Holds the six hardcoded `codex_*` event names outside the `ProviderEvents` table (known gap)
- `test/unit/init-test-helpers.ts` — `makeFakeDeps` shared factory for init unit tests
- `scripts/smoke-tarball.sh` — Uses `--version` not `doctor` for the binary-resolves assertion

## Related

- PF-010: Zod strips unknown keys → a pre-restructure config parses clean while every setting silently reverts to defaults. Both `detectLegacyConfigKeys` and `detectUnknownProviderKeys` exist because of this; the README config section states the same reasoning to operators.
- PF-006: Doctor exits non-zero without live services; smoke uses `--version` not `doctor`; drives the `configuredProviders` severity split.
- PF-007: Alias targets as well as keys must be validated against `isReservedAnthropicName`.
- PF-005: Live-verified protocol constants must not be re-derived — the reason `ProviderCredential` carries only auth headers and not transport headers.
- ADR-006: `MODEL_REGISTRY` as sole routable set source; `codex.models` config key deleted.
- ADR-005: Exact model-membership routing — `isReservedAnthropicName` guards keep Anthropic names out of the routing table.
- ADR-004: `@types/node` pinned to Node-22 majors — affects `parseArgs` type signatures and `readdir({recursive:true})` in `makeLiveListAgentFiles`.
- ADR-002: Subscription OAuth passthrough — why `anthropic` has no auth config of its own and stays top-level in `Config`, and why the Codex auth manager is constructed lazily in `createCodexProvider`.
- `.devflow/features/codex-leg/KNOWLEDGE.md` — Full model resolution contract (`buildRoutingTable`, five-rule resolution, canonical threading) and the Codex handler/translator side of `providerEvents`.
- `src/version.ts` — Source of `SUBSWITCH_VERSION` used by `--version`, doctor, `/__subswitch/health`, and the `models --json` payload.
