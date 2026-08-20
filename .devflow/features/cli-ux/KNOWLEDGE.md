---
feature: cli-ux
name: CLI / init command / terminal UX
description: "Use when modifying the CLI entry point, init wizard, doctor preflight command, logger output format, log event names, config load and provider config resolution, the models alias table, or any terminal UX concern (colors, TTY detection, FORCE_COLOR, dry-run, CI safety). Keywords: cli, parseArgs, CliCommand, init, doctor, models, logger, providerEvents, provider-events, log injection, FIELD_KEYS, renderToken, clack, picocolors, TTY, NO_COLOR, FORCE_COLOR, interactive, non-interactive, dry-run, smoke-tarball, tty.ts, models.ts, agent-scan, buildRoutingTable, buildDeps, ProviderConfigs, PROVIDER_SCHEMAS, PROVIDER_RESOLVERS, detectUnknownProviderKeys, detectLegacyConfigKeys, LEGACY_KEY_ENTRIES, renderLegacyKeyEntry, credentialUsable, providersWithCredentials, enumerateDestinations, RoutingDestination, isLoopbackHost, isLoopbackHostname, strictObject, oauthTokenUrl, PROVIDER_AUTH_INSPECTORS, plain-object, SERVER_TUNING, applyInboundPolicy, SYNTHESIZED_HEADER, SYNTHESIZED_MARKER, drainRejectedUpload, hostGateVerdict, responseForClientError, client_disconnected, respondJson, anthropic:ambiguous, anthropic:fallback, ADR-010."
category: architecture
directories: [src/cli.ts, src/init.ts, src/doctor.ts, src/logger.ts, src/provider-events.ts, src/tty.ts, src/models.ts, src/agent-scan.ts, src/config.ts, src/server.ts, src/plain-object.ts, src/inbound-policy.ts, src/provider-transport.ts]
created: 2026-07-23
updated: 2026-08-20
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

**`resolveConfig` builds `anthropic` and `limits` field-by-field** (not by spreading `file.anthropic` or `file.limits`) so removed keys cannot accidentally reach the runtime `Config` even if the schema were to parse them.

**All top-level sub-schemas are `z.strictObject`.** `CodexProviderSchema`, `AnthropicSchema`, `LimitsSchema`, and `FileConfigSchema` all use `z.strictObject`; `reasoningCache` within `CodexProviderSchema` is also a `z.strictObject`. A typo'd leaf key is a hard load error rather than a silent revert to default (avoids PF-010). `AliasesSchema` stays `z.record` by design.

**`isLoopbackHost(hostname)` — exported, strict, exact-match only.** Accepts `localhost`, `::1`, and full dotted-quad `127.x.y.z`. The `^…$` anchors are load-bearing: `127.0.0.1.evil.test` has four groups separated by more than three dots and fails; `127.1` has only two groups and likewise fails. Brackets are stripped before comparison so `[::1]` (WHATWG URL form) passes. This function receives hostnames from `new URL().hostname` — the WHATWG parser preserves brackets on IPv6.

**Deliberate divergence from `inbound-policy.ts`'s `isLoopbackHostname`.** Both are strict, but handle different input provenance: `isLoopbackHost` (config.ts) judges WHATWG-parsed URL hostnames where brackets are preserved by the parser; `isLoopbackHostname` (inbound-policy.ts, private) judges wire Host-header authority strings where brackets must be stripped by the function itself. Neither reuses the other — the input shapes are incompatible. See Gotchas.

**https-or-loopback URL refinement.** `requireHttpsOrLoopback` is applied to `providers.codex.baseUrl`, `providers.codex.oauthTokenUrl`, and `anthropic.baseUrl`. `isLoopbackHost` is **exported** so `buildDeps` can apply the same logic at startup (no duplication). The loopback exemption covers the e2e dev workflow at `http://127.0.0.1:4142`.

**One mechanism for rejected config keys — there is no soft-deprecation subsystem:**

`LEGACY_KEY_ENTRIES` (a `readonly LegacyKeyEntry[]`, private to `config.ts`) is the single table. Each entry is either a `moved` row (old path → new path, e.g. restructure migration) or a `removed` row (key outright deleted). `detectLegacyConfigKeys(raw)` walks it and `renderLegacyKeyEntry` formats each hit for the error message. Both kinds produce the same outcome: `loadConfig` returns `err` and the relay refuses to start. The table is append-only.

**Two raw pre-parse scans reject unrecognised keys (avoids PF-010):**
- `detectLegacyConfigKeys(raw)` — pre-`providers.*` layout keys, each paired with its replacement path.
- `detectUnknownProviderKeys(raw)` — `providers.<id>` blocks whose id is not in `PROVIDER_IDS`.

Both walk with `Object.hasOwn` only, through the shared `isPlainObject` predicate.

**`LoadConfigResult.configuredProviders`** is a `ReadonlySet<ProviderId>` of providers whose block was literally present in the raw config. Zod fills all provider defaults unconditionally, so `Config` alone cannot answer "did the user opt in?" (avoids PF-006).

**Totality is compile-enforced for providers.** Adding a member to `PROVIDER_IDS` produces `tsc` errors at `PROVIDER_SCHEMAS`, `ProviderConfigs`, `PROVIDER_CONFIG_ACCESSORS`, `aliasesByProvider`, `PROVIDER_RESOLVERS`, `resolveConfig`, and `buildDeps` — none has a `default` arm or returns a sentinel.

**`enumerateDestinations(config): readonly RoutingDestination[]`** enumerates all routing destinations in topology order: Anthropic (passthrough) first, then each registered provider. Both `/__subswitch/health` and `subswitch models --json` build their `providers[]` array from this single source (no drift).

### src/provider-events.ts — Compile-time-safe log event names

`providerEvents<P extends ProviderId>(providerId: P): ProviderEvents<P>` derives **19** provider-scoped log event names from a provider id using template-literal types. This is a security control: a config-supplied `string` containing `"\n"` is a COMPILE error at the call site — only a closed `ProviderId` union member can reach the derivation.

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

**`serve` now takes `LoadConfigResult`** (not a resolved `Config`) — matching the shape already used by `doctor` and `modelsJson`. Legacy or removed config keys cause `loadConfig` to return `err` before `serve` is dispatched; there is no soft-deprecation path that lets startup proceed.

`out()` / `errOut()` write directly to stdout / stderr — NOT routed through the structured logger. Use the structured logger for runtime request telemetry so output respects `--quiet`, `--verbose`, and the field allow-list.

### src/inbound-policy.ts — Server policy layer

**`applyInboundPolicy(server, logger)`** (exported): the single entry point that owns both `SERVER_TUNING` application and the Anthropic-shaped `clientError` handler. `attachClientErrorHandler` no longer exists — the two halves are unified because applying the tuning without the error handler (or vice versa) reproduces the original defect.

**`appliedServers` WeakSet.** `applyInboundPolicy` guards itself with a `WeakSet<http.Server>` to prevent double-application. Calling it twice on the same server is a no-op and logs a warning rather than registering a second `clientError` listener.

**`hostGateVerdict(headers)`** (exported, pure): strict wire-side predicate that gates on Host/Origin. Returns a discriminated verdict (`{ verdict: "allow" } | { verdict: "reject"; reason: string; observed: string; message: string }`). Uses the module-private `isLoopbackHostname`, which handles wire Host-header authority strings directly (brackets stripped, port stripped). Deliberately does NOT reuse `config.ts`'s `isLoopbackHost` — different input provenance (see config.ts section). Called as the **first gate** in the dispatch handler: a foreign Host gets a 403 `permission_error` + `drainRejectedUpload` before any body is read.

**`responseForClientError(code)`** (exported): looks up the Anthropic-shaped response for a Node `clientError` error code (`HPE_HEADER_OVERFLOW`, `HPE_INVALID_*`, etc.). Uses `Object.hasOwn` — prototype-safe. Without the guard, a bracket-read on a non-existent key returns `undefined`, and `res.writeHead(undefined, undefined)` emits `HTTP/1.1 undefined undefined` on the wire.

**Per-request reply guard (WeakMap).** The `clientError` handler uses `writtenAtLastResponse: WeakMap<Duplex, number>` keyed on the socket. On every `res` "finish" event, it snapshots `socket.bytesWritten`. At `clientError` time, it compares the current `socket.bytesWritten` to the snapshot — if they differ, bytes have been sent since the last response finished, meaning the socket is mid-stream and writing a new response would corrupt it. `socket.bytesWritten` is per-socket-lifetime (counts across all keep-alive responses), so comparing it without the snapshot gives false positives. See Gotchas.

### src/server.ts — The one wiring site

`buildDeps(config, logger = createConsoleLogger(config.logLevel))` is the only place production dependencies are constructed. The **logger is a defaulted parameter, not a local** — this shape is load-bearing so injected test loggers observe all handler records (see Anti-Patterns).

**`SERVER_TUNING`** (exported `as const`): `{ requestTimeout: 600_000, headersTimeout: 120_000, keepAliveTimeout: 300_000, maxRequestsPerSocket: 0, maxHeaderSize: 64*1024 }`. `maxHeaderSize` must go through `http.createServer({ maxHeaderSize }, …)` — it is not a settable property on the server object. Exported so tests can apply identical values to their own test servers (no fixture drift).

**Dispatch order in the request handler:**

1. `res.on("close", …)` listener registered first — must be the earliest hook.
2. `hostGateVerdict(req.headers)` — foreign Host → 403 + `drainRejectedUpload(req)` + return.
3. `/__subswitch/*` namespace — handled locally, never forwarded.
4. `bufferBody(req, limits.maxBodyBytes)` — rejects early if `Content-Length` header exceeds the cap (before reading a byte); otherwise streams and rejects once the byte count crosses the cap.
5. Exhaustive `BufferBodyError` switch:
   - `body_too_large` → 413 `request_too_large` + `drainRejectedUpload(req)`.
   - `client_disconnected` → no response (client gone; logged by the close handler already).

**`client_disconnected` log event.** When `res.close` fires with `!res.headersSent`, the handler logs `info client_disconnected { path, route, model?, latencyMs }` instead of `request_complete`. This is correct: `res.statusCode` is Node's 200 initialiser when no response has been sent, so `request_complete status=200` would make a vanished client indistinguishable from a served request. `res` "close" fires **before** `req` "error" on Node 22 — the decision must live in the `close` handler.

**Route log labels.** `route` defaults to `"anthropic"` and is updated before dispatch:
- `"host_rejected"` — foreign Host gate fired.
- `"anthropic:ambiguous"` — `resolveModel` returned `"ambiguous"`; fails open (ADR-010).
- `"anthropic:fallback"` — `resolveModel` returned `"unknown_qualifier"`; fails open (ADR-010).
- `"{provider}:{endpoint}:{model}"` — routed to a configured provider.
- `"internal_error"` — unhandled `dispatch()` rejection.
- Retired values (no producer): `"rate_limited"`, `"ambiguous"`, `"unknown_provider"`.

**`BufferBodyError`** (module-local type): `{ kind: "body_too_large" } | { kind: "client_disconnected" }`. Intentionally excluded from `ProxyError` so `proxyErrorToAnthropic` can never accidentally be called with them — any attempt is a compile error.

**Byte-budget admission gate is GONE.** The old `inFlightBytes`, `queue`, `acquireSlot`, `drainQueue`, `releaseSlot`, `getReservationBytes`, `SlotError`, `QueueEntry`, and the synthesized 529/`rate_limited`/`disconnected_while_queued` labels were all removed as ADR-010 violations.

**Ambiguous model routing fails open (ADR-010).** When `resolveModel` returns `"ambiguous"`, the relay logs `warn ambiguous_model_name` and forwards to Anthropic unchanged — it does not synthesize a 400.

### src/provider-transport.ts — Shared transport helpers

**`drainRejectedUpload(req)`** (exported): drains an in-flight upload after a rejection response has been sent, so the socket closes with FIN rather than RST (which can cause the client to discard the already-sent response). Bounds: 2-second unref'd timer (`REJECTED_UPLOAD_DRAIN_MS = 2_000`) + 32 MiB byte cap (`REJECTED_UPLOAD_DRAIN_BYTES = 32 * 1024 * 1024`). Four callers:
- `server.ts` host-gate 403 path.
- `server.ts` 413 `body_too_large` path.
- `anthropic-passthrough.ts` unbuffered 504 (upstream timeout) path.
- `anthropic-passthrough.ts` unbuffered 502 (upstream error) path.

**`respondJson(res, status, body, extraHeaders?)`** (exported): writes a JSON response. `extraHeaders` is spread **before** `SYNTHESIZED_HEADER` in the `writeHead` call — the synthesized marker always wins over any caller-supplied header with the same name. The `extraHeaders` parameter exists specifically for the Codex 429 `retry-after` passthrough.

### src/errors.ts

`ProxyError` (no `body_too_large`/`client_disconnected`); `AnthropicErrorType` (includes `not_found_error`; `overloaded_error` removed — upstream 5xx incl. 529 → `api_error`); `SYNTHESIZED_HEADER`/`SYNTHESIZED_MARKER` exported as single chokepoint for `x-subswitch-synthesized`; `redactCredentials` inside `toAnthropicErrorBody` (ADR-008).

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

### src/agent-scan.ts — Agent frontmatter scanner

`parseFrontmatterModel(text)` hand-rolled, no YAML dependency. `checkAgentModels(files, table, configuredProviders)` maps to six finding kinds.

**`unknown_provider` is now severity `"info"`, not `"fail"` (ADR-010).** An unknown qualifier does not make the request fail — subswitch forwards it to Anthropic unchanged. By contrast `ambiguous` stays `"fail"` because that conflict is subswitch-derived and WILL produce a routing error.

### src/logger.ts — Structured key=value logger

Emits to stderr. Format: `[HH:MM:SS] level=<L> event=<E> key=value …`. Fields are serialized by iterating `FIELD_KEYS` in order — any field NOT in `FIELD_KEYS` is silently dropped (the compliance redaction boundary).

**`FIELD_KEYS` now has a bidirectional compile-time completeness check:**
- `as const satisfies readonly (keyof LogFields)[]` — every listed key must exist in `LogFields`.
- `type _FieldKeysComplete = Exclude<keyof LogFields, (typeof FIELD_KEYS)[number]> extends never ? true : never` — every field in `LogFields` must appear in `FIELD_KEYS`. Adding a field to `LogFields` without adding it to `FIELD_KEYS` is a compile error.

**Log injection prevention:** `renderToken(value)` strips all C0 control characters (U+0000–U+001F), DEL (U+007F), and C1 control characters (U+0080–U+009F) — not just `\r\n` — then quotes anything matching `/[\s="\\]/`. Applied to both field values AND the event token. The primary control is that every event name is a compile-time string literal.

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

- **Building a dependency inside a factory and then spreading it onto the result, when callers can also inject it.** This is the fake-ignores-its-argument shape. Fix is structural — take the dependency as a **defaulted parameter** so the injected instance reaches everything constructed from it.

- **Widening `providerEvents`' parameter to `string`** — the compile-time closed-union input IS the log-injection control. A runtime sanitization check is not an equivalent substitute.

- **Re-implementing color logic inline** — always import `resolveColorEnabled` from `tty.ts`.

- **Using picocolors' global default export instead of `createColors(bool)`** — the global export re-detects TTY state itself, making the caller's boolean a no-op.

- **Widening `FIELD_KEYS` in logger.ts without a compliance review** — the closed field list is the redaction boundary.

- **Adding a provider dispatch as a `switch` with a `default` arm, or as a `Partial`/`Map`** — every provider-keyed structure is a total `Record`/mapped type precisely so the completeness check is structural.

- **Adding a config restructure without a `LEGACY_KEY_ENTRIES` row** — reintroduces PF-010. Both renamed keys (`moved`) and removed keys (`removed`) go into `LEGACY_KEY_ENTRIES` as hard errors; there is no soft-deprecation path.

- **Calling `out()` / `errOut()` from `serve` for runtime request logs** — use the structured logger.

- **Assembling the `providers[]` array independently in health or models --json** — always use `enumerateDestinations(config)`.

- **Calling `req.destroy()` after a rejection response** — use `drainRejectedUpload(req)` instead. `req.destroy()` causes the kernel to send RST, which may cause the client to discard the already-sent response before reading it.

## Gotchas

**The byte-budget admission gate is gone. Any text describing a concurrency cap, byte-based admission, queueing, or a 503/529 from the relay is now false.** `"overloaded_error"` was removed from `AnthropicErrorType` — upstream 5xx including 529 maps to `"api_error"` via `upstreamStatusToAnthropicError`.

**`FORCE_COLOR` beats `NO_COLOR` here — this inverts the no-color.org convention.** `FORCE_COLOR=1 NO_COLOR=1 subswitch models` emits ANSI. Do not "fix" it without a decision record.

**`FORCE_COLOR=0` and `FORCE_COLOR=""` do not force color.** Both fall through to the `NO_COLOR`/`isTTY` tiers.

**Doctor probes TLS on port 443 unconditionally.** An operator with an `http://` or non-443 `baseUrl` (a local mock) always sees `TLS: FAIL` and a `failures++`.

**`isLoopbackHost` and `isLoopbackHostname` are NOT interchangeable.** `isLoopbackHost` (config.ts, exported) receives WHATWG-parsed hostnames (`new URL().hostname`) where IPv6 brackets are preserved by the parser — it strips them. `isLoopbackHostname` (inbound-policy.ts, private) receives wire Host-header authority strings and handles brackets/ports itself. Passing a wire Host header directly to `isLoopbackHost` will fail on port-qualified addresses like `127.0.0.1:4141`.

**`socket.bytesWritten` is a per-socket-lifetime counter.** In the `clientError` handler, comparing `socket.bytesWritten !== 0` gives false positives on keep-alive sockets that have already served responses. The WeakMap snapshot (taken at each `res` "finish") is the correct guard.

**`res` "close" fires BEFORE `req` "error" on Node 22 (measured).** In the `bufferBody` flow, the `client_disconnected` decision must live in the `res` "close" handler — not in a `req` "error" handler — or the log entry can be emitted after the close event has already been processed.

**Doctor always exits non-zero in CI.** `scripts/smoke-tarball.sh` uses `subswitch --version` — always exits 0 — not `subswitch doctor` (applies PF-006).

**Zod strips unknown keys at the top-level `providers.*` and pre-restructure positions — the raw pre-parse scans are the only guard there.** Inside a known block (e.g. a misspelled field inside `providers.codex`), `z.strictObject` catches it (avoids PF-010).

**`subswitch.config.example.json` must stay in sync with the strict schema.** A stale example with an unknown key is a hard load error.

**Legacy or removed keys hard-error immediately via `LEGACY_KEY_ENTRIES`.** There is no path where a legacy key's value is validated before being discarded — the load fails at the pre-parse scan before Zod runs.

**`ambiguous` model routing fails open.** The relay forwards to Anthropic and logs `warn ambiguous_model_name`. It does NOT synthesize a 400. Route label is `anthropic:ambiguous`.

**`maxHeaderSize` must go through `http.createServer({ maxHeaderSize }, ...)`.** It is not a settable property on the server object after construction.

**Test suite gotchas:**
- Test globs are FLAT and NON-RECURSIVE (`test/unit/*.test.ts`, `test/integration/*.test.ts`). A new test file in a subdirectory silently never runs.
- Run the suite alone — it has wall-clock assertions and flakes under parallel load alongside other processes (e.g., concurrent `tsc`).
- `version.test.ts` pins both `package-lock.json` version fields AND the newest `CHANGELOG.md` heading — bumping the version requires updating all three simultaneously.

**Parallel-agent git atomicity.** `git add <paths>` followed by a separate `git commit` is not atomic — another agent can stage its own files between the two commands. Use `git commit --only -m "…" -- <paths>` (no prior `git add`) to stage and commit only the named paths in a single operation.

## Key Files

- `src/tty.ts` — `resolveColorEnabled(env, isTTY)` — single color-enable source of truth
- `src/cli.ts` — Binary entry point; `parseCliArgs` → `CliCommand` union; exhaustive switch with `never` guard
- `src/config.ts` — `FileConfig`/`Config` split; `z.strictObject` for all top-level sub-schemas; `isLoopbackHost` (exported, strict dotted-quad + localhost + ::1 only); https-or-loopback refinements; `LEGACY_KEY_ENTRIES` + `detectLegacyConfigKeys` — single hard-error mechanism; `resolveConfig` field-by-field; `enumerateDestinations` + `RoutingDestination`; totality anchors
- `src/provider-events.ts` — `providerEvents<P extends ProviderId>`; template-literal `ProviderEvents<P>`; 19-field table; compile-time log-injection control
- `src/logger.ts` — `createConsoleLogger`; `FIELD_KEYS` bidirectional completeness check; `renderToken` strips all C0/DEL/C1 control characters then quotes — applied to values AND event token
- `src/inbound-policy.ts` — `SERVER_TUNING` (exported); `applyInboundPolicy(server, logger)` (single entry point — applies tuning AND registers `clientError` handler); `appliedServers` WeakSet (idempotency guard); `hostGateVerdict(headers)` (pure, exported — wire-side Host/Origin gate); `responseForClientError(code)` (Object.hasOwn, prototype-safe); `writtenAtLastResponse` WeakMap (per-request reply guard, snapshots `socket.bytesWritten` at each response finish)
- `src/server.ts` — `buildDeps(config, logger?)` — the one wiring site; `BufferBodyError` (module-local); dispatch order: close listener → host gate → namespace → bufferBody → exhaustive error switch; `client_disconnected` log event for headerless close; `anthropic:ambiguous`/`anthropic:fallback` route labels
- `src/provider-transport.ts` — `drainRejectedUpload(req)` (exported; 2 s + 32 MiB bounds; 4 callers); `respondJson(res, status, body, extraHeaders?)` (extraHeaders spread before marker so marker always wins)
- `src/errors.ts` — `ProxyError` (no `body_too_large`/`client_disconnected`); `AnthropicErrorType` (includes `not_found_error`; `overloaded_error` removed); `SYNTHESIZED_HEADER`/`SYNTHESIZED_MARKER` single chokepoint
- `src/doctor.ts` — `runDoctor`; `PROVIDER_AUTH_INSPECTORS` (exported totality anchor); `makeLiveListAgentFiles` (absolute-path resolution critical)
- `src/init.ts` — Pure planning + `InitFsDeps` / `InitPrompts` seams; wizard prompts only port + settings-target
- `src/agent-scan.ts` — `parseFrontmatterModel`; `checkAgentModels`; `unknown_provider` severity `"info"` (ADR-010)
- `src/models.ts` — Pure registry; no repo imports; `MODEL_REGISTRY`, `PROVIDER_IDS`, `buildRoutingTable`, `resolveModel`, `isReservedAnthropicName`, `routableModelCount`
- `src/plain-object.ts` — Shared `isPlainObject` guard for `doctor.ts` and `init.ts`; `config.ts` keeps its own private copy (prototype-pollution boundary)

## Related

- ADR-010: Relay transparency — a relay must be indistinguishable from the origin; drove removal of the byte-budget gate, the synthesized 529, and the ambiguous-model 400; governs `anthropic:ambiguous`/`anthropic:fallback` fail-open routing.
- ADR-009: Credential vetting — `isLoopbackHost` strictness is load-bearing here; the loopback exemption is what makes `http://127.0.0.1:4142` reachable in dev.
- ADR-008: Credential redaction applied once at the error render site — the chokepoint pattern also used for the 404 body (no path reflection).
- ADR-006: `MODEL_REGISTRY` as sole routable set source.
- ADR-005: Live-verified protocol constants must not be re-derived.
- ADR-004: `@types/node` pinned to Node-22 majors — affects `parseArgs` type signatures.
- ADR-002: Subscription OAuth passthrough — why `anthropic` has no auth config of its own.
- PF-025: `respondJson` extraHeaders marker-last ordering — the synthesized marker must always be the last header written so it cannot be shadowed.
- PF-023: Distinct route labels (`anthropic:ambiguous`, `anthropic:fallback`) for fail-open paths — makes post-hoc log analysis unambiguous.
- PF-022: `client_disconnected` log event vs. `request_complete status=200` — `res.statusCode` is Node's 200 initialiser; the close-before-error ordering on Node 22 is the reason the decision lives in the close handler.
- PF-021: WeakMap per-request reply guard — `socket.bytesWritten` is per-socket-lifetime; snapshot at each response finish is required.
- PF-020: `hostGateVerdict` and `isLoopbackHostname` divergence from `isLoopbackHost` — wire authority vs. WHATWG hostname are different input shapes.
- PF-014: `version.test.ts` pins both `package-lock.json` version fields and newest `CHANGELOG.md` heading — closed structurally by the test.
- PF-011: A green suite proves nothing until each control has been proven RED against the mutation it claims to catch.
- PF-010: Zod strips unknown keys → a pre-restructure config parses clean while every setting silently reverts to defaults. `z.strictObject` now guards leaf sub-schemas; the raw pre-parse scans guard the outer structure.
- PF-006: Doctor exits non-zero without live services; smoke uses `--version` not `doctor`; drives the `configuredProviders` severity split.
- `.devflow/features/codex-leg/KNOWLEDGE.md` — Full model resolution contract, `buildHeaders`, `ProviderEvents<P>` 19-field table, and the Codex handler/translator/auth side.
- `src/version.ts` — Source of `SUBSWITCH_VERSION` used by `--version`, doctor, `/__subswitch/health`, and `models --json`.
