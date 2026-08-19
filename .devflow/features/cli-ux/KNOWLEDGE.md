---
feature: cli-ux
name: CLI / init command / terminal UX
description: "Use when modifying the CLI entry point, init wizard, doctor preflight command, logger output format, log event names, config load and provider config resolution, the models alias table, or any terminal UX concern (colors, TTY detection, FORCE_COLOR, dry-run, CI safety). Keywords: cli, parseArgs, CliCommand, init, doctor, models, logger, providerEvents, provider-events, log injection, FIELD_KEYS, renderToken, clack, picocolors, TTY, NO_COLOR, FORCE_COLOR, interactive, non-interactive, dry-run, smoke-tarball, tty.ts, models.ts, agent-scan, buildRoutingTable, buildDeps, ProviderConfigs, PROVIDER_SCHEMAS, PROVIDER_RESOLVERS, detectUnknownProviderKeys, detectLegacyConfigKeys, DEPRECATED_KEYS, detectDeprecatedConfigKeys, DeprecatedConfigKey, credentialUsable, providersWithCredentials, enumerateDestinations, RoutingDestination, isLoopbackHost, strictObject, oauthTokenUrl, PROVIDER_AUTH_INSPECTORS, plain-object, SERVER_TUNING, attachClientErrorHandler, drainRejectedUpload, ADR-010."
category: architecture
directories: [src/cli.ts, src/init.ts, src/doctor.ts, src/logger.ts, src/provider-events.ts, src/tty.ts, src/models.ts, src/agent-scan.ts, src/config.ts, src/server.ts, src/plain-object.ts]
created: 2026-07-23
updated: 2026-08-19
---

# CLI / init command / terminal UX

## Overview

This knowledge base covers the full user-facing surface of subswitch: the CLI entry point (`src/cli.ts`), the `init` wizard (`src/init.ts`), the `doctor` preflight command (`src/doctor.ts`), the structured logger (`src/logger.ts`) with its event-name table (`src/provider-events.ts`), and the single color-resolution utility (`src/tty.ts`). `src/config.ts` (load + resolve), `src/models.ts` (pure model registry), `src/plain-object.ts` (shared guard), and `src/agent-scan.ts` (doctor's frontmatter scanner) are tightly coupled to it, and `src/server.ts`'s `buildDeps` is the wiring seam every CLI path funnels through.

These files share five cross-cutting contracts that are easy to break silently: the non-interactive safety guarantee in `init`, the closed-field redaction guarantee plus the compile-time event-name guarantee in `logger`, the single color-enable source of truth in `tty.ts`, the **fail-the-load-on-unrecognised-key** guarantee in `config.ts`, and the **https-or-loopback** URL refinement that prevents cleartext credential leaks.

The CLI is a thin dispatcher — its only job is to parse flags, route to the right module, and plumb I/O. Business logic lives in pure functions inside each module, making the real behavior unit-testable without spawning a process. All fallible operations return `Result` types (never throw in business logic).

**Governing principle (ADR-010).** A relay fronting an origin API must be indistinguishable from the origin. A bound that reclaims a provably dead connection is legitimate; a bound that can terminate a request the origin was about to answer, or emit a status the origin never sends, is a defect. This principle drove the `wave/passthrough-hardening` refactor: the byte-budget admission gate, the per-request queue, the synthesized 529/503, the relay-invented 400 for ambiguous models — all removed as ADR-010 violations.

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

`DEFAULT_PORT` (`4141`) and `DEFAULT_CODEX_AUTH_FILE` (`~/.codex/auth.json`) are the exported constants.

**`FileConfig` / `Config` split.** `FileConfigSchema.safeParse` produces a `FileConfig` (on-disk shape). `resolveConfig(file)` is a pure mapping into the runtime `Config`. `Config` is hand-written, NOT `z.infer`, so `authFile` is always tilde-expanded and the parse-time `kind` discriminant cannot leak into the runtime shape.

**Current `Config` shapes (post-ADR-010 hardening):**

- `Config.anthropic`: `{ baseUrl, connectTimeoutMs, maxUpstreamSockets, allowInsecureBaseUrl }`. The `headerTimeoutMs` and `streamIdleTimeoutMs` fields were **removed** — the relay must never bound the headers or stream-idle phase on a connected client (ADR-010).
- `Config.limits`: `{ maxBodyBytes, pingIntervalMs }`. The admission-gate fields (`maxConcurrentRequests`, `maxInFlightBytes`, `maxQueueDepth`, `maxQueueWaitMs`) were **removed** — the byte-budget gate was an ADR-010 violation.

**`resolveConfig` builds `anthropic` and `limits` field-by-field** (not by spreading `file.anthropic` or `file.limits`) so deprecated keys cannot accidentally reach the runtime `Config` even if the schema parses them.

**All top-level sub-schemas are `z.strictObject`.** `CodexProviderSchema`, `AnthropicSchema`, `LimitsSchema`, and `FileConfigSchema` all use `z.strictObject`. A typo'd leaf key is a hard load error rather than a silent revert to default (avoids PF-010). `AliasesSchema` stays `z.record` by design.

**https-or-loopback URL refinement.** `requireHttpsOrLoopback` is applied to `providers.codex.baseUrl`, `providers.codex.oauthTokenUrl`, and `anthropic.baseUrl`. `isLoopbackHost(hostname)` is **exported** so `buildDeps` can apply the same logic at startup (no duplication). The loopback exemption covers the e2e dev workflow at `http://127.0.0.1:4142`.

**Two parallel mechanisms for rejected/soft-rejected config keys — know the distinction:**

| Mechanism | Function | Effect | When to add a row |
|---|---|---|---|
| `LEGACY_KEY_MOVES` | `detectLegacyConfigKeys` | **Hard error** — load fails | A key was renamed/moved: old path has a new destination |
| `DEPRECATED_KEYS` | `detectDeprecatedConfigKeys` | **Soft warning** — load succeeds, value ignored | A key's feature was removed: there is no destination for the value |

Both tables are append-only. The six currently deprecated keys (`anthropic.headerTimeoutMs`, `anthropic.streamIdleTimeoutMs`, `limits.maxConcurrentRequests`, `limits.maxInFlightBytes`, `limits.maxQueueDepth`, `limits.maxQueueWaitMs`) stay in the Zod schemas as `.optional()` so existing operator configs continue to load — only their values are discarded. `LoadConfigResult.deprecatedKeys: readonly DeprecatedConfigKey[]` carries the matches to the `serve` command for warning display.

**Two raw pre-parse scans reject unrecognised keys (avoids PF-010):**
- `detectLegacyConfigKeys(raw)` — pre-`providers.*` layout keys, each paired with its replacement path.
- `detectUnknownProviderKeys(raw)` — `providers.<id>` blocks whose id is not in `PROVIDER_IDS`.

Both walk with `Object.hasOwn` only, through the shared `isPlainObject` predicate.

**`LoadConfigResult.configuredProviders`** is a `ReadonlySet<ProviderId>` of providers whose block was literally present in the raw config. Zod fills all provider defaults unconditionally, so `Config` alone cannot answer "did the user opt in?" (avoids PF-006).

**Totality is compile-enforced for providers.** Adding a member to `PROVIDER_IDS` produces `tsc` errors at `PROVIDER_SCHEMAS`, `ProviderConfigs`, `PROVIDER_CONFIG_ACCESSORS`, `aliasesByProvider`, `PROVIDER_RESOLVERS`, `resolveConfig`, and `buildDeps` — none has a `default` arm or returns a sentinel.

**`enumerateDestinations(config): readonly RoutingDestination[]`** enumerates all routing destinations in topology order: Anthropic (passthrough) first, then each registered provider. Both `/__subswitch/health` and `subswitch models --json` build their `providers[]` array from this single source (no drift).

**`loginCommand`** is config-sourced rather than synthesised because `${providerId} login` is not always a safe derivation (e.g. `kimi auth login`).

**Per-provider limits.** Each provider config carries: `requestTimeoutMs`, `streamIdleTimeoutMs`, `maxSseEventBytes`, `maxAggregateBytes`. These are provider-scoped (in `providers.codex.*`), not in the global `limits.*` block.

### src/provider-events.ts — Compile-time-safe log event names

`providerEvents<P extends ProviderId>(providerId: P): ProviderEvents<P>` derives **19** provider-scoped log event names from a provider id using template-literal types. This is a security control: a config-supplied `string` containing `"\n"` is a COMPILE error at the call site — only a closed `ProviderId` union member can reach the derivation.

The 19 fields break down as 11 handler/translator events, 1 security event (`insecureBaseUrlScheme`), and 7 auth manager events.

### src/models.ts — Pure model registry (no repo imports)

Deliberately imports nothing from the rest of the repo — `config.ts` imports it, and the edge must stay one-way.

Key exports: `PROVIDER_IDS`, `ProviderId`, `AliasesByProvider`, `MODEL_REGISTRY`, `routableModelCount`, `buildRoutingTable`, `resolveModel`, `isReservedAnthropicName`, `formatModelsReport`, `buildModelRows`, `buildAliasRows`.

### src/cli.ts — Dispatcher

`parseCliArgs` returns a discriminated `CliCommand` union. Flag sets per command:

- `serve`: `verbose`, `quiet`, `port`
- `doctor`: (none — any flag on `doctor` is an error)
- `models`: `json` only
- `init`: `yes`, `dry-run`, `port`, `settings-target`

Per-command flag validation walks `parseArgs` **tokens**, not `values`. The main switch is exhaustive (`default` assigns to `never` and calls `fail()`).

**`serve` now takes `LoadConfigResult`** (not a resolved `Config`) — matching the shape already used by `doctor` and `modelsJson`. On startup it emits one deprecation warning per deprecated key found in the config on two surfaces:
1. `deps.logger.log("warn", "config_key_deprecated", { path })` — structured log (path only; `reason` cannot pass through `LogFields`, which is a closed allow-list by design).
2. `errOut("subswitch: deprecated config key \"<path>\" — <reason>")` — human-readable stderr notice carrying the reason.

**`models` subcommand.** The JSON branch returns before `resolveColorEnabled` is ever called — `FORCE_COLOR` cannot bleed into JSON output even on a real TTY.

`out()` / `errOut()` write directly to stdout / stderr — NOT routed through the structured logger. Use the structured logger for runtime request telemetry so output respects `--quiet`, `--verbose`, and the field allow-list.

### src/server.ts — The one wiring site

`buildDeps(config, logger = createConsoleLogger(config.logLevel))` is the only place production dependencies are constructed. The **logger is a defaulted parameter, not a local** — this shape is load-bearing so injected test loggers observe all handler records (see Anti-Patterns).

**`SERVER_TUNING`** (exported `as const`): `{ requestTimeout: 600_000, headersTimeout: 120_000, keepAliveTimeout: 300_000, maxRequestsPerSocket: 0, maxHeaderSize: 64*1024 }`. Applied to `http.createServer` and then to the server instance post-construction. `maxHeaderSize` must go through `http.createServer({ maxHeaderSize }, …)` — it is not a settable property on the server object. Exported so tests can apply identical values to their own test servers (no fixture drift).

**`attachClientErrorHandler(server, logger)`** (exported): registers a `clientError` listener that converts Node's bodyless 400/408/431 responses into Anthropic-shaped bodies carrying `x-subswitch-synthesized: 1`. Guards against writing to a non-writable socket or one that has already sent bytes.

**`drainRejectedUpload(req)`** (module-local): called after sending a 413 so remaining upload data drains cleanly before TCP teardown. Uses FIN rather than RST, giving the client a chance to read the 413. A 2-second unref'd timer destroys the socket if draining stalls. Replaces the old `req.destroy()` which caused RST and risked the 413 being discarded.

**`BufferBodyError`** (module-local type): `{ kind: "body_too_large" } | { kind: "client_disconnected" }`. Intentionally excluded from `ProxyError` so `proxyErrorToAnthropic` can never accidentally be called with them — any attempt is a compile error.

**Byte-budget admission gate is GONE.** The old `inFlightBytes`, `queue`, `acquireSlot`, `drainQueue`, `releaseSlot`, `getReservationBytes`, `SlotError`, `QueueEntry`, and the synthesized 529/`rate_limited`/`disconnected_while_queued` labels were all removed as ADR-010 violations. `"overloaded_error"` survives in `src/errors.ts` only as a pass-through for upstream 529 responses — the relay must never synthesize it.

**Ambiguous model routing fails open (ADR-010).** When `resolveModel` returns `"ambiguous"`, the relay now logs `warn ambiguous_model_name { model: "name (p1, p2)" }` and forwards to Anthropic unchanged — it does not synthesize a 400. This matches the `unknown_qualifier` precedent: the origin may support the name; at minimum, forwarding lets it answer with its own error.

**404 for `/__subswitch/*`** is now shaped via `toAnthropicErrorBody("not_found_error", "not found")` — same chokepoint as every other synthesized error (ADR-008). The path is NOT reflected in the message.

**`route = "internal_error"`** is set on unhandled `dispatch()` rejections (previously unlabeled).

**`src/errors.ts` changes:** `body_too_large` and `client_disconnected` were removed from `ProxyError` (now `BufferBodyError` in server.ts). `not_found_error` was added to `AnthropicErrorType`. `overloaded_error` remains — upstream pass-through only.

### src/init.ts — Functional-core / imperative-shell

**`InitFlags`** is `{ port?: string; settingsTarget?: string }`.

Pure planning layer (no side effects): `resolveInitDispatch`, `resolveOptionsFromFlags`, `planConfigWrite`, `planSettingsWrite`, `collectPreconditionWarnings`, `settingsPathFor`.

**Effectful execution layer:** `executeInit(options, deps, projectDir)` returns `Result<readonly [configPath, settingsPath], InitError>`. Write order is config-first. All reads happen before any write.

**Wizard:** prompts only for port and settings-target. `makeClackPrompts()` lazy-imports `@clack/prompts` via dynamic `import()` — called only when entering the interactive path.

### src/doctor.ts — Preflight gate

`runDoctor(config, configPath, fileFound, io, configuredProviderIds)`. The fifth parameter is `ReadonlySet<ProviderId>` defaulting to `new Set<ProviderId>()`.

**`PROVIDER_AUTH_INSPECTORS`** is now an **exported** `Readonly<Record<ProviderId, AuthInspector>>` — adding a `ProviderId` without an inspector entry is a `tsc` error.

**N-provider auth check severity (PF-006 rules):**
- Provider absent from config file → informational.
- Provider present but credential missing/broken → failure.
- Credential file exists but does not parse → failure regardless of opt-in.

The `ProviderCheck` interface uses **`credentialUsable: boolean`** (not `configured`). The local accumulator is **`providersWithCredentials`** (not `configuredProviders`).

### src/agent-scan.ts — Agent frontmatter scanner

`parseFrontmatterModel(text)` hand-rolled, no YAML dependency. `checkAgentModels(files, table, configuredProviders)` maps to six finding kinds.

| Finding kind | Severity | Trigger |
|---|---|---|
| `unresolvable` | fail | `resolveModel` returns `unresolved` |
| `ambiguous` | fail | `resolveModel` returns `ambiguous` |
| `unknown_provider` | **info** | `resolveModel` returns `unknown_qualifier` |
| `retired` | info | Resolves to a registry entry marked `retired` |
| `provider_unconfigured` | info | Resolves ok but provider not in `configuredProviders` |
| `preview_only` | info | Resolves to a registry entry marked `preview` |

**`unknown_provider` is now severity `"info"`, not `"fail"` (ADR-010).** An unknown qualifier does not make the request fail — subswitch forwards it to Anthropic unchanged. By contrast `ambiguous` stays `"fail"` because that conflict is subswitch-derived and WILL produce a routing error.

**The Anthropic skip list is required in production code** — without it doctor fails on every repo that has Claude subagents.

### src/logger.ts — Structured key=value logger

Emits to stderr. Format: `[HH:MM:SS] level=<L> event=<E> key=value …`. Fields are serialized by iterating `FIELD_KEYS` in order — any field NOT in `FIELD_KEYS` is silently dropped (the compliance redaction boundary).

**`FIELD_KEYS` now has a bidirectional compile-time completeness check:**
- `as const satisfies readonly (keyof LogFields)[]` — every listed key must exist in `LogFields`.
- `type _FieldKeysComplete = Exclude<keyof LogFields, (typeof FIELD_KEYS)[number]> extends never ? true : never` — every field in `LogFields` must appear in `FIELD_KEYS`. Adding a field to `LogFields` without adding it to `FIELD_KEYS` is a compile error.

`inFlightBytes` and `reservationBytes` were removed from `LogFields` (byte-gate removed). New/updated log events: `config_key_deprecated` (warn, from `serve`), `ambiguous_model_name` (warn, from `createProxyServer`), `client_error` (warn, from `attachClientErrorHandler`), `route = "internal_error"` (from unhandled dispatch rejections).

**Log injection prevention:** `renderToken(value)` strips `[\r\n]` then quotes anything matching `/[\s="\\]/`. Applied to both field values AND the event token. The primary control is that every event name is a compile-time string literal.

## Non-interactive Safety Contract

`resolveInitDispatch` is the single gateway. Three outcomes: `"interactive"`, `"non-interactive"` (`--yes` set), `"refuse"` (non-TTY or CI without `--yes`). `yesFlag` is checked before `hasCIEnv`. **Exception:** `--dry-run` bypasses `resolveInitDispatch` entirely.

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

- **Synthesizing a status the origin never produces** — the byte-budget 529, the ambiguous-model 400, a relay-invented 503. ADR-010: emit only what the origin would have sent, or forward and let the origin answer. If a synthesized status is unavoidable, always mark it with `x-subswitch-synthesized: 1`.

- **Building a dependency inside a factory and then spreading it onto the result, when callers can also inject it.** This is the fake-ignores-its-argument shape and it makes tests pass vacuously. `buildDeps` hit it exactly: handlers closed over the logger `buildDeps` built itself, so an injected test logger observed nothing and its assertions were trivially satisfied. Fix is structural — take the dependency as a **defaulted parameter** so the injected instance reaches everything constructed from it.

- **Widening `providerEvents`' parameter to `string`** — the compile-time closed-union input IS the log-injection control. A runtime sanitization check is not an equivalent substitute.

- **Re-hardcoding a provider event name as a literal anywhere outside `providerEvents`** — inside `providerEvents` a literal is not assignable to its template-literal type, so `tsc` catches it.

- **Re-implementing color logic inline** — always import `resolveColorEnabled` from `tty.ts`.

- **Using picocolors' global default export instead of `createColors(bool)`** — the global export re-detects TTY state itself, making the caller's boolean a no-op.

- **Widening `FIELD_KEYS` in logger.ts without a compliance review** — the closed field list is the redaction boundary.

- **Adding a provider dispatch as a `switch` with a `default` arm, or as a `Partial`/`Map`** — every provider-keyed structure is a total `Record`/mapped type precisely so the completeness check is structural.

- **Adding a config restructure without a `LEGACY_KEY_MOVES` row** — reintroduces PF-010. Adding a removed feature's key to `DEPRECATED_KEYS` instead of `LEGACY_KEY_MOVES` when it WAS renamed (i.e. the value has a new home) is equally wrong — the distinction matters.

- **Calling `out()` / `errOut()` from `serve` for runtime request logs** — use the structured logger.

- **Mutating the `config` object** from `loadConfig()` — apply overrides via object spread.

- **Asserting `subswitch doctor` exits 0 in smoke tests** — doctor exits non-zero whenever any check fails (applies PF-006).

- **Assembling the `providers[]` array independently in health or models --json** — always use `enumerateDestinations(config)`.

## Gotchas

**The byte-budget admission gate is gone. Any text describing a concurrency cap, byte-based admission, queueing, or a 503/529 from the relay is now false.** `"overloaded_error"` in `src/errors.ts` is inert — upstream pass-through only.

**`FORCE_COLOR` beats `NO_COLOR` here — this inverts the no-color.org convention.** `FORCE_COLOR=1 NO_COLOR=1 subswitch models` emits ANSI. Do not "fix" it without a decision record.

**`FORCE_COLOR=0` and `FORCE_COLOR=""` do not force color.** Both fall through to the `NO_COLOR`/`isTTY` tiers.

**Doctor probes TLS on port 443 unconditionally.** An operator with an `http://` or non-443 `baseUrl` (a local mock) always sees `TLS: FAIL` and a `failures++`.

**A trailing positional is silently ignored.** `parseArgs` reads `positionals[0]` and never checks `positionals.length`, so `subswitch models --json extra` exits 0 and emits normal JSON.

**Doctor always exits non-zero in CI.** `scripts/smoke-tarball.sh` uses `subswitch --version` — always exits 0 — not `subswitch doctor` (applies PF-006).

**Zod strips unknown keys at the top-level `providers.*` and pre-restructure positions — the raw pre-parse scans are the only guard there.** Inside a known block (e.g. a misspelled field inside `providers.codex`), `z.strictObject` catches it (avoids PF-010).

**`subswitch.config.example.json` must stay in sync with the strict schema.** A stale example with an unknown key is a hard load error. Any schema refactor must update the example simultaneously.

**A deprecated key's VALUE is still schema-validated even though it is discarded.** An invalid value (e.g. a string where an int is expected) can still veto startup. Not a regression — the validators are byte-identical to pre-change — but a sharp edge when operators have malformed deprecated keys in their config.

**`ambiguous` model routing fails open.** The relay forwards to Anthropic and logs a `warn`. It does NOT synthesize a 400. If you see an `ambiguous_model_name` warn in logs, it means two providers claim the same family name (only reachable once a second provider ships).

**`drainRejectedUpload` must be called instead of `req.destroy()` after a 413.** Calling `req.destroy()` with unread inbound bytes causes the kernel to send RST, which may cause the client to discard the 413 before reading it. The 2-second timer is unref'd so it never prevents process exit.

**`maxHeaderSize` must go through `http.createServer({ maxHeaderSize }, ...)`.** It is not a settable property on the server object after construction. Apply other `SERVER_TUNING` fields post-construction via direct assignment.

**Test suite gotchas:**
- Test globs are FLAT and NON-RECURSIVE (`test/unit/*.test.ts`, `test/integration/*.test.ts`). A new test file in a subdirectory silently never runs.
- There is a 30-second hard per-test timeout and no fake timers. Wall-clock assertions must account for realistic elapsed time.
- Run the suite alone — it has wall-clock assertions and flakes under parallel load alongside other processes (e.g., concurrent `tsc`).

**`isReservedAnthropicName` guards places that must never disagree.** `AliasesSchema` refines in `config.ts`, `buildRoutingTable` at table-build time, and the agent-scan skip list all use the same predicate.

**`config.ts` keeps its own private `isPlainObject` copy — deliberately.** The shared copy in `src/plain-object.ts` is for `doctor.ts` and `init.ts`. The `config.ts` copy is the prototype-pollution boundary for `hasOwnPath`, `detectUnknownProviderKeys`, and `detectConfiguredProviders`.

**`makeLiveListAgentFiles` must resolve dirs to absolute paths.** Without `pathResolve(dir)`, the project-relative path and the user-global path produce different strings for the same directory, the `Set` dedup fails silently, and finding counts double.

**`makeClackPrompts()` must only be called on the interactive path.** It triggers a dynamic `import("@clack/prompts")` loading terminal control sequences.

## Key Files

- `src/tty.ts` — `resolveColorEnabled(env, isTTY)` — single color-enable source of truth
- `src/cli.ts` — Binary entry point; `parseCliArgs` → `CliCommand` union; `serve` now takes `LoadConfigResult`; deprecation warning dual-surface (structured log + `errOut`); exhaustive switch with `never` guard
- `src/config.ts` — `FileConfig`/`Config` split; `z.strictObject` for all top-level sub-schemas; https-or-loopback refinements; `isLoopbackHost` (exported); `DEPRECATED_KEYS` + `DeprecatedConfigKey` + `detectDeprecatedConfigKeys` (soft-deprecation); `LEGACY_KEY_MOVES` + `detectLegacyConfigKeys` (hard-error); `resolveConfig` field-by-field (no spreading deprecated fields); `enumerateDestinations` + `RoutingDestination`; totality anchors; `LoadConfigResult.deprecatedKeys`
- `src/provider-events.ts` — `providerEvents<P extends ProviderId>`; template-literal `ProviderEvents<P>`; 19-field table; compile-time log-injection control
- `src/logger.ts` — `createConsoleLogger`; `FIELD_KEYS` bidirectional completeness check (`satisfies` + `Exclude`); `renderToken` escapes `"` and `\`; applied to values AND event token
- `src/server.ts` — `buildDeps(config, logger?)` — the one wiring site; `SERVER_TUNING` (exported); `attachClientErrorHandler` (exported); `drainRejectedUpload` (module-local); `BufferBodyError` (module-local); no byte-budget gate; ambiguous fails open; 404 via `toAnthropicErrorBody`; `route = "internal_error"`
- `src/errors.ts` — `ProxyError` (no `body_too_large`/`client_disconnected`); `AnthropicErrorType` (added `not_found_error`); `overloaded_error` inert for upstream pass-through only
- `src/doctor.ts` — `runDoctor`; `PROVIDER_AUTH_INSPECTORS` (exported totality anchor); `makeLiveListAgentFiles` (absolute-path resolution critical); `probeTlsReachable` (hardcoded 443)
- `src/init.ts` — Pure planning + `InitFsDeps` / `InitPrompts` seams; wizard prompts only port + settings-target
- `src/agent-scan.ts` — `parseFrontmatterModel`; `checkAgentModels`; `unknown_provider` severity now `"info"` (ADR-010)
- `src/models.ts` — Pure registry; no repo imports; `MODEL_REGISTRY`, `PROVIDER_IDS`, `buildRoutingTable`, `resolveModel`, `isReservedAnthropicName`, `routableModelCount`
- `src/plain-object.ts` — Shared `isPlainObject` guard for `doctor.ts` and `init.ts`; `config.ts` keeps its own private copy (prototype-pollution boundary)
- `scripts/smoke-tarball.sh` — Uses `--version` not `doctor` for the binary-resolves assertion

## Related

- ADR-010: Relay transparency — a relay must be indistinguishable from the origin; drove removal of the byte-budget gate, the synthesized 529, and the ambiguous-model 400.
- PF-010: Zod strips unknown keys → a pre-restructure config parses clean while every setting silently reverts to defaults. `z.strictObject` now guards leaf sub-schemas; the raw pre-parse scans guard the outer structure.
- PF-006: Doctor exits non-zero without live services; smoke uses `--version` not `doctor`; drives the `configuredProviders` severity split.
- PF-007: Alias targets as well as keys must be validated against `isReservedAnthropicName`.
- PF-005: Live-verified protocol constants must not be re-derived.
- PF-011: A green suite proves nothing until each control has been proven RED against the mutation it claims to catch.
- PF-012: The mutation-proof pass needs its own controls.
- ADR-008: Credential redaction applied once at the error render site — the chokepoint pattern also used for the 404 body (no path reflection).
- ADR-006: `MODEL_REGISTRY` as sole routable set source.
- ADR-005: Exact model-membership routing — `isReservedAnthropicName` guards keep Anthropic names out of the routing table.
- ADR-004: `@types/node` pinned to Node-22 majors — affects `parseArgs` type signatures.
- ADR-002: Subscription OAuth passthrough — why `anthropic` has no auth config of its own and stays top-level in `Config`.
- `.devflow/features/codex-leg/KNOWLEDGE.md` — Full model resolution contract, `buildHeaders`, `ProviderEvents<P>` 19-field table, and the Codex handler/translator/auth side.
- `src/version.ts` — Source of `SUBSWITCH_VERSION` used by `--version`, doctor, `/__subswitch/health`, and `models --json`.
