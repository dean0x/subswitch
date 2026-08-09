---
feature: cli-ux
name: CLI / init command / terminal UX
description: "Use when modifying the CLI entry point, init wizard, doctor preflight command, logger output format, log event names, config load and provider config resolution, the models alias table, or any terminal UX concern (colors, TTY detection, FORCE_COLOR, dry-run, CI safety). Keywords: cli, parseArgs, CliCommand, init, doctor, models, logger, providerEvents, provider-events, log injection, FIELD_KEYS, renderToken, clack, picocolors, TTY, NO_COLOR, FORCE_COLOR, interactive, non-interactive, dry-run, smoke-tarball, tty.ts, models.ts, agent-scan, buildRoutingTable, buildDeps, ProviderConfigs, PROVIDER_SCHEMAS, PROVIDER_RESOLVERS, detectUnknownProviderKeys, detectLegacyConfigKeys, credentialUsable, providersWithCredentials, enumerateDestinations, RoutingDestination, isLoopbackHost, strictObject, oauthTokenUrl, PROVIDER_AUTH_INSPECTORS, plain-object."
category: architecture
directories: [src/cli.ts, src/init.ts, src/doctor.ts, src/logger.ts, src/provider-events.ts, src/tty.ts, src/models.ts, src/agent-scan.ts, src/config.ts, src/server.ts, src/plain-object.ts]
created: 2026-07-23
updated: 2026-08-08
---

# CLI / init command / terminal UX

## Overview

This knowledge base covers the full user-facing surface of subswitch: the CLI entry point (`src/cli.ts`), the `init` wizard (`src/init.ts`), the `doctor` preflight command (`src/doctor.ts`), the structured logger (`src/logger.ts`) with its event-name table (`src/provider-events.ts`), and the single color-resolution utility (`src/tty.ts`). `src/config.ts` (load + resolve), `src/models.ts` (pure model registry), `src/plain-object.ts` (shared guard), and `src/agent-scan.ts` (doctor's frontmatter scanner) are tightly coupled to it, and `src/server.ts`'s `buildDeps` is the wiring seam every CLI path funnels through.

These files share five cross-cutting contracts that are easy to break silently: the non-interactive safety guarantee in `init`, the closed-field redaction guarantee plus the compile-time event-name guarantee in `logger`, the single color-enable source of truth in `tty.ts`, the **fail-the-load-on-unrecognised-key** guarantee in `config.ts`, and the **https-or-loopback** URL refinement that prevents cleartext credential leaks.

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

**All top-level sub-schemas are `z.strictObject`.** `CodexProviderSchema`, `AnthropicSchema`, `LimitsSchema`, and `FileConfigSchema` all use `z.strictObject`. A typo'd leaf key (e.g. `maxSseEventsBytes` instead of `maxSseEventBytes`) is now a hard load error rather than a silent revert to the default value. This extends PF-010 protection one level below where it was previously closed (avoids PF-010). `AliasesSchema` stays `z.record` by design — it is a user-defined map, not a known-key object.

**https-or-loopback URL refinement.** `requireHttpsOrLoopback` is applied to `providers.codex.baseUrl`, `providers.codex.oauthTokenUrl`, and `anthropic.baseUrl`. A non-loopback `http://` URL at any of these positions is a hard parse error because credentials would be sent in cleartext. `isLoopbackHost(hostname)` is **exported** from `src/config.ts` so `buildDeps` can apply the same logic at startup for its warning (avoiding duplication). The loopback exemption (`127.*`, `localhost`, `::1`) exists specifically for the e2e dev workflow that points `baseUrl` at `http://127.0.0.1:4142`.

**The resolved `Config` is keyed by `ProviderId`, not a top-level `codex` block.** Consumers read `config.providers.codex.*`. `anthropic` deliberately stays top-level and is NOT folded into `providers`: it has no model list, no auth config of its own (the client's credential is forwarded verbatim, applies ADR-002), there is exactly one, and it is always present. Symmetry would give it fields it does not have.

**Totality is compile-enforced, and this list is the checklist for adding a provider.** Adding a member to `PROVIDER_IDS` produces `tsc` errors at every declaration below; none of them is a switch with a `default` arm, so there is no unreachable fallback returning sentinels that callers must then guard:

| Declaration | File | Mechanism |
|---|---|---|
| `PROVIDER_SCHEMAS` | config.ts | `satisfies { [K in ProviderId]: z.ZodType }` — checks both directions (missing id AND misspelled excess key) |
| `ProviderConfigs` | config.ts | `{ [K in ProviderId]: ProviderConfigShape[K] }` — mapped over the union, not written out |
| `PROVIDER_CONFIG_ACCESSORS` | config.ts | `Record<ProviderId, (config) => ProviderRuntimeConfig>` |
| `aliasesByProvider` | config.ts | declared return type `Record<ProviderId, Record<string,string>>` |
| `PROVIDER_RESOLVERS` | config.ts | per-key signature `(file: FileConfig["providers"][K]) => ProviderConfigShape[K]` |
| `resolveConfig` | config.ts | `providers: { codex: … }` object literal vs `ProviderConfigs` |
| `buildDeps` | server.ts | `providers: { codex: … }` vs `ServerDeps.providers: Record<ProviderId, ProviderHandler>` |

**Provider slices are heterogeneous by design.** `CodexProviderConfig` carries `oauthTokenUrl`, which is a detail of the ChatGPT OAuth flow — it must not be forced onto a provider that authenticates with a static key or not at all.

**`ProviderRuntimeConfig`** (the provider-neutral slice returned by `providerConfigFor`) gained two new optional fields:
- `oauthTokenUrl?: string` — OAuth token endpoint, present only for OAuth providers.
- `defaultOauthHost?: string` — Expected hostname for the OAuth endpoint; `buildDeps` warns at startup when the configured `oauthTokenUrl` points at a different host.

`buildDeps` now vets both SCHEME and hostname for `oauthTokenUrl` — a compromised `oauthTokenUrl` leaks the long-lived refresh token, which is more damaging than a misconfigured `baseUrl`. It emits `<id>_insecure_base_url_scheme` (via `events.insecureBaseUrlScheme`) when a URL uses http to a non-loopback host.

**Two raw pre-parse scans reject unrecognised keys — this is the load-fails-loudly contract (avoids PF-010).** Zod's `z.strictObject` rejects unknown keys at any level it guards, but the raw pre-parse scans run on the RAW parsed JSON before `FileConfigSchema.safeParse` and catch whole-block mismatches that strictness alone cannot see:

- `detectLegacyConfigKeys(raw)` — keys from the pre-`providers.*` layout, each paired with its replacement path. Table is append-only.
- `detectUnknownProviderKeys(raw)` — `providers.<id>` blocks whose id is not in `PROVIDER_IDS`.

Both scans and `detectConfiguredProviders` walk with `Object.hasOwn` only, through the shared `isPlainObject` predicate from `src/plain-object.ts` (config.ts keeps its own private copy for the prototype-pollution boundary — see Key Files).

**`LoadConfigResult.configuredProviders`** is a `ReadonlySet<ProviderId>` of providers whose block was literally present in the raw config. Zod fills all provider defaults unconditionally, so `Config` alone cannot answer "did the user opt in?" — but doctor's severity rules depend on it (avoids PF-006).

**`providerConfigFor(config, id)`** returns the provider-neutral `ProviderRuntimeConfig` slice that doctor, `/__subswitch/health`, the serve banner, and `models --json` all read. `defaultHost` and `defaultOauthHost` live here rather than as constants in `server.ts` so the base-URL-override warning is per-provider by construction.

**`enumerateDestinations(config): readonly RoutingDestination[]`** enumerates all routing destinations in topology order: Anthropic (passthrough) first, then each registered provider in `PROVIDER_IDS` order. Both `/__subswitch/health` and `subswitch models --json` build their `providers[]` array from this single source, so the two surfaces cannot drift. Before this function existed, health omitted Anthropic while models included it.

`RoutingDestination` is a discriminated union (`routing: "passthrough" | "registry"`). The health endpoint and CLI JSON both use it without re-deriving what "all routing destinations" means.

**Two raw pre-parse scans reject unrecognised keys** are unchanged. `LEGACY_KEY_MOVES` table is append-only; every future restructure owes it a row.

**`loginCommand`** has two consumers: `src/doctor.ts` (names the command in the auth-status check) and `src/server.ts` (wires it into `CodexHandlerDeps` so the 401 remediation path suffixes `` — run `<loginCommand>` `` on an unresolvable 401). It is config-sourced rather than synthesised because a provider whose id is `kimi` may log in via `kimi auth login`, not `kimi login` — so `` `${providerId} login` `` is not a safe derivation.

**Three per-provider limits.** Each provider has `requestTimeoutMs`, `streamIdleTimeoutMs`, `maxSseEventBytes`, and now also `maxAggregateBytes` (64 MiB default, bounding non-streaming frame accumulation). The global `limits.*` block holds `maxBodyBytes`, `pingIntervalMs`, and `maxConcurrentRequests` (default 32) — a single leaked decrement-without-increment permanently degrades the server to 503.

### src/provider-events.ts — Compile-time-safe log event names

`providerEvents<P extends ProviderId>(providerId: P): ProviderEvents<P>` derives **19** provider-scoped log event names from a provider id using template-literal types. **This is a security control, not a naming convenience.** `logger.ts` interpolates the event *name* into the same line as everything else; before this existed, only field *values* were stripped and quoted, so a config-derived event name was a log-injection vector.

The guarantee is **compile-time**, not a runtime check that could be bypassed: only a member of the closed `ProviderId` union can reach the derivation — a config-supplied `string` containing `"\n"` is a COMPILE error at the call site. Each name is also falsifiable: inside the generic function a hardcoded `"codex_upstream_error"` is not assignable to `` `${P}_upstream_error` ``, so re-hardcoding any single name fails `tsc`.

The 19 fields break down as:
- **11 handler/translator events** — `translateWarning`, `effortApplied`, `upstream401Refreshing`, `retryBoundViolated`, `upstreamError`, `streamInterrupted`, `sseUnparseableData`, `sseEventIgnored`, `cacheTokens`, `sessionKey`, `baseUrlOverrideDetected`
- **1 security event** — `insecureBaseUrlScheme` (emitted by `buildDeps` when `baseUrl` or `oauthTokenUrl` uses http to a non-loopback host)
- **7 auth manager events** — `tokenRefreshed`, `refreshTokenRotatedExternally`, `tokenRefreshFailed`, `refreshRetryBoundViolated`, `authFileNewerThanRefresh`, `authFileWriteFailed`, `authFileUnreadableAfterRefresh` (formerly hardcoded `codex_*` literals in `codex-auth.ts` — now fully table-derived; the previously-documented "known gap" is closed)

Callers resolve the record **once at construction time** and hold it, so the hot streaming path does no string work. `FIELD_KEYS` in `logger.ts` is a different axis (which *fields* may be logged) and is deliberately untouched by this.

### src/models.ts — Pure model registry (no repo imports)

Deliberately imports nothing from the rest of the repo — `config.ts` imports it, and the edge must stay one-way. See `codex-leg/KNOWLEDGE.md` for the full resolution contract.

Key exports for CLI UX:

- `PROVIDER_IDS = ["codex"] as const` and `ProviderId` — the closed union all the totality anchors above key on.
- `AliasesByProvider` — exported type alias for `Readonly<Record<ProviderId, Readonly<Record<string, string>>>>`. Avoids triple-nested spelling at six call sites.
- `MODEL_REGISTRY` — the routable set source (applies ADR-006).
- `routableModelCount(registry, provider)` — count of non-retired, non-preview entries for one provider. Used by the serve banner and `models --json`.
- `buildRoutingTable(registry, aliasesByProvider)` — called in both `buildDeps` (server) and `runDoctor` (CLI).
- `resolveModel(table, name)` — five-rule resolution returning `ModelResolution`.
- `isReservedAnthropicName(name)` — prefix-based (not exact); guards alias keys and targets in `buildRoutingTable` and `AliasesSchema` refines in `config.ts`. Also the skip predicate in `agent-scan.ts`.
- `formatModelsReport(input)` — human-readable alias table. Takes `{ registry, aliasesByProvider }`.
- `buildModelRows(registry, aliasesByProvider)` — model-centric rows for `--json` output.
- `buildAliasRows(registry, aliasesByProvider)` — alias-centric rows used internally by `formatModelsReport`.

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
- With `--json`: `buildModelRows(…)` inside a payload carrying `kind`, `schemaVersion`, `subswitchVersion`, `name`, `fallbackProvider: "anthropic"`, `configPath`, `configFileFound`, `providers[]` (from `enumerateDestinations`), `models[]`. Anthropic is listed in `providers[]` with `routing: "passthrough"` — everything unresolved falls through to it.

The JSON branch **returns before `resolveColorEnabled` is ever called** — `FORCE_COLOR` cannot bleed into JSON output even on a real TTY.

**Per-provider ready banner.** On `serve`, the banner prints one line per `PROVIDER_IDS` entry with model count and host, via `providerConfigFor` and `routableModelCount`.

`out()` / `errOut()` write directly to stdout / stderr — NOT routed through the structured logger. Use the structured logger for runtime request telemetry so output respects `--quiet`, `--verbose`, and the field allow-list.

### src/server.ts — The one wiring site

`buildDeps(config, logger = createConsoleLogger(config.logLevel))` is the only place production dependencies are constructed. The **logger is a defaulted parameter, not a local**. This shape is load-bearing: when the logger was built inside `buildDeps` and only spread onto its result, a test that injected a logger to observe handler records saw none of them and its assertions passed vacuously. See Anti-Patterns.

`buildDeps` now vets SCHEME as well as hostname for both `baseUrl` and `oauthTokenUrl` on each provider. When a URL uses http to a non-loopback host, it emits `<id>_insecure_base_url_scheme` (via the events table). Loopback hosts are exempt by design — the e2e dev workflow intentionally uses `http://127.0.0.1`.

`createCodexProvider(config, logger)` constructs `ReasoningCache` and `CodexAuthManager` only when a Codex provider is actually wired (applies ADR-002). The auth object is annotated as `ProviderAuth<"codex">` — conformance is checked at the wiring site. `CodexAuthManager` now receives the full `events: providerEvents("codex")` record so all auth event names are table-derived.

`src/provider-auth.ts` is the real seam: `ProviderAuth<P>` and `ProviderCredential<P>`. The brand is a real `provider: P` field, not a phantom `unique symbol`, so a credential is constructible without a cast — and `ProviderCredential<"codex">` is not assignable to another provider's, making cross-wiring a compile error rather than a runtime credential leak.

### src/init.ts — Functional-core / imperative-shell

**`InitFlags`** is `{ port?: string; settingsTarget?: string }`.

**Pure planning layer (no side effects, unit-testable directly):**

- `resolveInitDispatch(stdinIsTTY, stdoutIsTTY, hasCIEnv, yesFlag)` → `InitDispatchDecision`
- `resolveOptionsFromFlags(flags)` → `Result<InitOptions, InitError>` — validates port and settings-target only.
- `planConfigWrite(existingJson, port, projectDir)` → `Result<ConfigWritePlan, InitError>` — deep-merges only `port`; all other top-level keys preserved.
- `planSettingsWrite(existingJson, port, settingsTarget, projectDir)` — merges only `env.ANTHROPIC_BASE_URL`.
- `collectPreconditionWarnings(env, authFileExists, authFilePath)` — auth path must be computed from `homedir()` by the caller, not `env.HOME` (undefined on Windows).
- `settingsPathFor(target, projectDir)` — single source of truth for the settings file path.

`isPlainObject` is no longer declared in `init.ts` directly; it is imported from `src/plain-object.ts` (shared with `doctor.ts`).

**Effectful execution layer:** `executeInit(options, deps, projectDir)` returns `Result<readonly [configPath, settingsPath], InitError>`. Write order is config-first: a dangling settings pointer is the harmful partial state. All reads happen before any write; if either plan fails, nothing is written.

**Wizard (`runInitInteractive(projectDir, deps, env, prompts, flags?)`):** prompts only for **port** and **settings-target**. `makeClackPrompts()` lazy-imports `@clack/prompts` via dynamic `import()` and is called only when entering the interactive path.

**Dry-run:** `init --dry-run` bypasses `resolveInitDispatch`, prints both plans, writes nothing.

### src/doctor.ts — Preflight gate

`runDoctor(config, configPath, fileFound, io, configuredProviderIds)`. The fifth parameter is `ReadonlySet<ProviderId>` defaulting to `new Set<ProviderId>()` — the conservative default.

**`PROVIDER_AUTH_INSPECTORS`** is now an **exported** `Readonly<Record<ProviderId, AuthInspector>>`. Every provider id must have a corresponding inspector function. Adding a `ProviderId` without an entry here is a `tsc` error. Using the record in `checkOneProvider` rather than calling `inspectAuthFile` directly ensures the same completeness check guards every future provider.

**N-provider auth check (PF-006 severity rules):**
- Provider absent from config file → informational; no `failures++`.
- Provider present in config file but credential missing or broken → failure. The user opted in, so a broken opt-in is a real problem.
- A credential file that exists but does not parse is a failure **regardless** of opt-in — the user clearly has one.

The `ProviderCheck` interface in `runDoctor` uses **`credentialUsable: boolean`** (not `configured`). The local set that accumulates providers with working credentials is **`providersWithCredentials`** (not `configuredProviders`) to distinguish it from the `configuredProviderIds` parameter.

Each `checkOneProvider` call returns its output lines rather than writing them, so N concurrent checks cannot interleave — lines are written in `PROVIDER_IDS` order after all complete.

**Agent scan:** both `.claude/agents/` (relative to cwd) AND `~/.claude/agents/` (user-global), deduplicated with a `Set` of absolute strings.

### src/agent-scan.ts — Agent frontmatter scanner

No external dependencies. Imports `isReservedAnthropicName` from `models.ts` to skip Anthropic-named subagents.

`parseFrontmatterModel(text)` extracts the `model:` value: requires `---` on line 1, scans to closing `---`, capped at 8 KiB / 200 lines, handles CRLF, strips surrounding quotes and trailing `# comment`.

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
- `renderToken(value)` strips `[\r\n]` then quotes anything matching `/[\s="\\]/` (whitespace, `=`, `"`, or `\`). Internal `"` and `\` are backslash-escaped so the surrounding quotes cannot be closed by a crafted value. **This closes a client-reachable logfmt field-forgery hole** — a value containing `=` or `"` would otherwise parse as additional top-level fields under logfmt's last-wins semantics. `renderToken` is applied to **both** field values **and the event token**.

The event-token treatment is defence in depth. The primary control is that every event name in the tree is a compile-time string literal — the 19 provider-scoped ones via `providerEvents` (see above, including all 7 auth events formerly hardcoded in `codex-auth.ts`), the rest hand-written constants.

## Non-interactive Safety Contract

`resolveInitDispatch` is the single gateway. Three outcomes: `"interactive"` (both TTYs, no CI, no `--yes`), `"non-interactive"` (`--yes` set), `"refuse"` (non-TTY or CI without `--yes`). `yesFlag` is checked before `hasCIEnv` — do not add a branch that inspects CI state before checking `yesFlag`.

**Exception:** `--dry-run` bypasses `resolveInitDispatch` entirely — it writes nothing.

## Exit-code Contract

| Command | Condition | Exit code |
|---------|-----------|-----------|
| `serve` | Listening successfully | 0 (never exits — waits for signal) |
| `serve` | Port in use / bad config | 1 |
| any | Unrecognised config key (legacy or unknown provider block) | 1 (load fails before dispatch) |
| any | Typo'd leaf key in strict schema | 1 (load fails before dispatch) |
| `doctor` | All checks pass / any check fails | 0 / 1 |
| `init` | Files written | 0 |
| `init` | User cancelled, or refused (non-TTY, no `--yes`) | 1 |
| `init --dry-run` | Plans printed / bad flags | 0 / 1 |
| `models`, `models --json` | Output emitted | 0 |
| `--help`, `--version` | Always | 0 |

## Anti-Patterns

- **Building a dependency inside a factory and then spreading it onto the result, when callers can also inject it.** This is the fake-ignores-its-argument shape and it makes tests pass vacuously. `buildDeps` hit it exactly: handlers closed over the logger `buildDeps` built itself, so an injected test logger observed nothing and its assertions were trivially satisfied. Fix is structural — take the dependency as a **defaulted parameter** so the injected instance reaches everything constructed from it.

- **Widening `providerEvents`' parameter to `string`** — the compile-time closed-union input IS the log-injection control. A runtime sanitization check is not an equivalent substitute; it can be bypassed, and it moves a compile error to a runtime hope.

- **Re-hardcoding a provider event name as a literal anywhere outside `providerEvents`** — inside `providerEvents` a literal is not assignable to its template-literal type, so `tsc` catches it. Thread the resolved `ProviderEvents<P>` record instead.

- **Re-implementing color logic inline** — always import `resolveColorEnabled` from `tty.ts`. Any inline `isTTY && !NO_COLOR` check misses the `FORCE_COLOR` precedence and diverges from the logger and doctor color decisions.

- **Using picocolors' global default export instead of `createColors(bool)`** — the global export re-detects TTY state itself, making the caller's boolean a no-op.

- **Widening `FIELD_KEYS` in logger.ts without a compliance review** — the closed field list is the redaction boundary. Any new field needs a documented non-reversible form (a count or truncated prefix, never raw content).

- **Adding a provider dispatch as a `switch` with a `default` arm, or as a `Partial`/`Map`** — every provider-keyed structure in `config.ts` and `server.ts` is a total `Record`/mapped type precisely so the completeness check is structural. A `default` arm returning empty-string sentinels turns a compile error into a runtime guard every caller has to remember.

- **Adding a config restructure without a `LEGACY_KEY_MOVES` row** — reintroduces PF-010 exactly. The table is append-only.

- **Calling `out()` / `errOut()` from `serve` for runtime request logs** — use the structured logger so output respects `--quiet`, `--verbose`, and the field allow-list.

- **Mutating the `config` object** from `loadConfig()` — apply overrides via object spread to produce a new `effectiveConfig`.

- **Asserting `subswitch doctor` exits 0 in smoke tests** — doctor exits non-zero whenever any check fails (applies PF-006).

- **Adding a `cwd` field to `InitFsDeps`** — it is intentionally stateless; `projectDir` is passed explicitly.

- **Assembling the `providers[]` array independently in health or models --json** — always use `enumerateDestinations(config)` so the two surfaces cannot drift from each other or from the routing topology.

## Gotchas

**`FORCE_COLOR` beats `NO_COLOR` here — this inverts the no-color.org convention.** `FORCE_COLOR=1 NO_COLOR=1 subswitch models` emits ANSI. That is deliberate and verified. Do not "fix" it by reordering the tiers in `tty.ts` without a decision record — every color-emitting surface reads that one function, so the reorder is global.

**`FORCE_COLOR=0` and `FORCE_COLOR=""` do not force color.** Both fall through the FORCE_COLOR branch and hit the NO_COLOR / isTTY tiers.

**Doctor probes TLS on port 443 unconditionally.** `probeTlsReachable(host, deps)` calls `deps.tlsConnect(host, 443)` and the host comes from `new URL(baseUrl).hostname` — the configured URL's scheme and port are discarded. An operator with an `http://` or non-443 `baseUrl` (a local mock, a proxy on 8443) always sees `TLS: FAIL` and a `failures++`.

**A trailing positional is silently ignored.** `parseCliArgs` reads `positionals[0]` and never checks `positionals.length`, so `subswitch models --json extra` exits 0 and emits normal JSON, while a bad *first* positional (`subswitch modelz`) is rejected with exit 1.

**Doctor always exits non-zero in CI.** The proxy is not running, codex auth is not configured, and TLS reachability depends on network policy. `scripts/smoke-tarball.sh` uses `subswitch --version` — always exits 0 — not `subswitch doctor` (applies PF-006).

**Zod strips unknown keys at the top-level `providers.*` and pre-restructure positions — the raw pre-parse scans are the only guard.** `detectLegacyConfigKeys` and `detectUnknownProviderKeys` both run on the raw object before `safeParse`. However, `z.strictObject` now guards the inner sub-schemas, so a typo inside a known block (e.g., a misspelled field inside `providers.codex`) is caught by the schema itself and produces a clear error message (avoids PF-010).

**`subswitch.config.example.json` must stay in sync with the strict schema.** Because the sub-schemas are now `z.strictObject`, a stale example file with an unknown key is a hard load error rather than a cosmetic drift. Any schema refactor must update the example file simultaneously.

**`isReservedAnthropicName` guards places that must never disagree.** `AliasesSchema` refines in `config.ts`, `buildRoutingTable` at table-build time, and the agent-scan skip list all use the same predicate. Any new guard surface must import it rather than reimplement it.

**`config.ts` keeps its own private `isPlainObject` copy — deliberately.** The shared copy in `src/plain-object.ts` is for `doctor.ts` and `init.ts`. The `config.ts` copy is the prototype-pollution boundary for the own-property walks in `hasOwnPath`, `detectUnknownProviderKeys`, and `detectConfiguredProviders` — isolating it means a future change to the shared copy cannot accidentally weaken this boundary.

**`makeLiveListAgentFiles` must resolve dirs to absolute paths.** The factory calls `pathResolve(dir)` before scanning. Without this, the project relative path and the user absolute path produce different strings for the same directory, the `Set` dedup in `runDoctor` fails silently, and finding counts double.

**`makeClackPrompts()` must only be called on the interactive path.** It triggers a dynamic `import("@clack/prompts")` loading terminal control sequences. Call it only inside the `if (decision === "interactive")` branch.

**`clack.multiselect` and friends return a Symbol on cancel.** `isCancel` must be checked before treating the return value as a string; the `prompt()` helper centralizes this guard.

**`parseArgs` with `strict: true` throws on unknown flags.** The catch block translates `ERR_PARSE_ARGS_*` to `Result` errors. Always `return` after `fail()` — code after it still runs unless the caller returns explicitly.

## Key Files

- `src/tty.ts` — `resolveColorEnabled(env, isTTY)` — single color-enable source of truth
- `src/cli.ts` — Binary entry point; `parseCliArgs` → `CliCommand` union; token-based per-command flag validation; `models --json` payload using `enumerateDestinations`; per-provider serve banner with `routableModelCount`; exhaustive switch with `never` guard
- `src/config.ts` — `FileConfig`/`Config` split; `z.strictObject` for all top-level sub-schemas; https-or-loopback refinements; `isLoopbackHost` (exported); `ProviderRuntimeConfig` with `oauthTokenUrl`/`defaultOauthHost`; `enumerateDestinations` + `RoutingDestination`; `PROVIDER_SCHEMAS` / `PROVIDER_RESOLVERS` / `PROVIDER_CONFIG_ACCESSORS` totality anchors; `detectLegacyConfigKeys` + `detectUnknownProviderKeys`; `providerConfigFor`; `aliasesByProvider`; `LoadConfigResult.configuredProviders`
- `src/provider-events.ts` — `providerEvents<P extends ProviderId>`; template-literal `ProviderEvents<P>`; 19-field table (all 7 auth events now included); compile-time log-injection control
- `src/logger.ts` — `createConsoleLogger`; `FIELD_KEYS` compliance allow-list; `renderToken` escapes `"` and `\`, quote trigger `/[\s="\\]/`; applied to values AND the event token
- `src/server.ts` — `buildDeps(config, logger?)` — the one wiring site, logger as defaulted parameter; `createCodexProvider`; startup URL-override, insecure-scheme, and routing-table warnings; `buildHealthBody` uses `enumerateDestinations`
- `src/provider-auth.ts` — `ProviderAuth<P>` / `ProviderCredential<P>` branded seam; auth-headers-only credential surface
- `src/doctor.ts` — `runDoctor` preflight gate; `PROVIDER_AUTH_INSPECTORS` (exported totality anchor); `DoctorIO`; `ProviderCheck.credentialUsable` (not `configured`); local `providersWithCredentials` (not `configuredProviders`); `makeLiveListAgentFiles` (absolute-path resolution critical); `probeTlsReachable` (hardcoded 443)
- `src/init.ts` — Pure planning + `InitFsDeps` / `InitPrompts` seams; wizard prompts only port + settings-target
- `src/agent-scan.ts` — `parseFrontmatterModel` (hand-rolled, no YAML dep); `checkAgentModels`; six finding kinds
- `src/models.ts` — Pure registry; `MODEL_REGISTRY`, `PROVIDER_IDS`, `AliasesByProvider`, `buildRoutingTable`, `resolveModel`, `isReservedAnthropicName`, `routableModelCount`, `formatModelsReport`, `buildModelRows`
- `src/plain-object.ts` — Shared `isPlainObject` guard for `doctor.ts` and `init.ts`; `config.ts` keeps its own private copy intentionally (prototype-pollution boundary isolation)
- `test/unit/source-text-guards.test.ts` — Asserts the literal `PROVIDER_IDS[0]` appears nowhere in `src/models.ts` or `src/server.ts` (guards against first-provider-fallback assumption)
- `test/integration/cli.test.ts` — `runCli` is memoized via `runCliCache` (Map keyed by args); cuts suite from ~9.9 s to ~4.4 s
- `scripts/smoke-tarball.sh` — Uses `--version` not `doctor` for the binary-resolves assertion

## Related

- PF-010: Zod strips unknown keys → a pre-restructure config parses clean while every setting silently reverts to defaults. `z.strictObject` now guards leaf sub-schemas; the raw pre-parse scans guard the outer structure. The README config section states the same reasoning to operators.
- PF-006: Doctor exits non-zero without live services; smoke uses `--version` not `doctor`; drives the `configuredProviders` severity split.
- PF-007: Alias targets as well as keys must be validated against `isReservedAnthropicName`.
- PF-005: Live-verified protocol constants must not be re-derived — the reason `ProviderCredential` carries only auth headers and not transport headers.
- PF-011: A green suite proves nothing until each control has been proven RED against the mutation it claims to catch.
- PF-012: The mutation-proof pass needs its own controls.
- ADR-008: Credential redaction applied once at the error render site — the reason `renderToken` in logger.ts does not need to strip auth-header values (they cannot reach `FIELD_KEYS`).
- ADR-006: `MODEL_REGISTRY` as sole routable set source; `codex.models` config key deleted.
- ADR-005: Exact model-membership routing — `isReservedAnthropicName` guards keep Anthropic names out of the routing table.
- ADR-004: `@types/node` pinned to Node-22 majors — affects `parseArgs` type signatures and `readdir({recursive:true})` in `makeLiveListAgentFiles`.
- ADR-002: Subscription OAuth passthrough — why `anthropic` has no auth config of its own and stays top-level in `Config`, and why the Codex auth manager is constructed lazily in `createCodexProvider`.
- `.devflow/features/codex-leg/KNOWLEDGE.md` — Full model resolution contract (`buildRoutingTable`, five-rule resolution, canonical threading), `buildHeaders` pure module-level function, `ProviderEvents<P>` 19-field table, and the Codex handler/translator/auth side.
- `src/version.ts` — Source of `SUBSWITCH_VERSION` used by `--version`, doctor, `/__subswitch/health`, and the `models --json` payload.
