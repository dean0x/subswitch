---
feature: cli-ux
name: CLI / init command / terminal UX
description: "Use when changing the CLI, init wizard, doctor, serve banner, Kimi doctor row, probe:kimi, config load, models table or terminal UX (TTY, colors, dry-run). Keywords: cli, doctor, banner, optedIn, config."
category: architecture
directories: [src/cli.ts, src/init.ts, src/doctor.ts, src/codex-doctor.ts, src/logger.ts, src/provider-events.ts, src/tty.ts, src/models.ts, src/agent-scan.ts, src/config.ts, src/server.ts, src/plain-object.ts, src/inbound-policy.ts, src/provider-transport.ts, e2e/gates/kimi-live-check.ts, test/helpers]
created: 2026-07-23
updated: 2026-11-21
---

# CLI / init command / terminal UX

## Rules
- **KB-INV-1** A new provider log event goes into the `ProviderEvents<P>` type and the `scopedEvents` table in `src/provider-events.ts`; the type pins the table, so do not quote a field count.
- **KB-INV-2** `subswitch doctor` lists a Together agent pin only when no usable key is found; with a key, a workspace `together:` pin routes to Together and spends the user's balance.
- **KB-INV-3** `src/doctor.ts` writes each provider auth line through `redactCredentials` at the write site, so a credential in an inspector line never reaches the terminal.
- **KB-INV-4** `detectConfiguredProviders` in `src/config.ts` is the one owner of "the provider block exists". `resolveConfig` sets each `optedIn` from its set, `LoadConfigResult.configuredProviders` returns the same set, and `buildDeps` and doctor both read these two. No other code decides this.
- **KB-INV-5** `ProviderRuntimeConfig.active` is false only for a provider that needs its block and has none (today Kimi, from `optedIn`). Then the serve banner, doctor and health do not read or stat its credential and do not probe its host.
- **KB-INV-6** The doctor Kimi row only reads. With the block, it reads the file through the store, then shows the expiry and whether renewal is due (`kimiRenewalDue`). It never renews and makes no lock or marker. A store fault shows the fixed text of its code, with no path and no file text.
- **KB-INV-7** The Kimi sign-in hint is `kimi login`. Only the `mainland-cn` region adds `--region mainland-cn`. `kimiCredentialFor` builds it, and Kimi has no host opt-in (`hostOptIn` false, https required).
- **KB-INV-8** `npm run probe:kimi` has two modes. `--live` refuses under CI, without a TTY on stdin and stdout, and without the typed cap phrase. `--dry-run` skips that gate and the cooldown: it uses fake upstreams and a fabricated sign-in.
- **KB-INV-9** The live check starts its client (Claude Code, or the fake client in the dry run) in a new temp folder that holds only a copy of `package.json`. The narrow allow rule (`Read(./package.json)`) stays as the second control. A `finally` path removes the folder with the scratch folder. The dry run uses the same path and runs in the suite in `test/integration/kimi-live-dry-run.test.ts`.
- **KB-AP-1** Do not add a new check of "is the block there" next to `detectConfiguredProviders`, and do not read, stat or probe for a provider before you test `active`. A provider without its block must cause no file call under its home and no host probe.
- **KB-AP-2** Do not write a "no file call" CLI test without a positive control. Use `recordFsUnder` in `test/helpers/cli-child.ts` and also run the same command with the block, so you see the recorder log the read.
- The Rules list starts with this refresh. Older rules stay in `## Anti-Patterns` and `## Gotchas` below.

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
  models    — show effective alias table (registry × aliases), then the
              together:<model-id> pass-through line with the output cap
              --json  Output model registry as JSON (no color, no TTY check)
```

The CLI handles `--help` and `--version` before it selects a command. Both exit 0.
`init` does not need an existing config file. `doctor`, foreground `serve` and `models` load config before they run.
The detach launcher loads config for the port only if `--port` is absent. A new child loads its own config.

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
- `Config.limits`: `{ maxBufferedBodyBytes, pingIntervalMs }`. Renamed from `maxBodyBytes` (v0.4.0 BREAKING; `LEGACY_KEY_ENTRIES` covers migration). The admission-gate fields (`maxConcurrentRequests`, `maxInFlightBytes`, `maxQueueDepth`, `maxQueueWaitMs`) were **removed** — the byte-budget gate was an ADR-010 violation.

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

`providerEvents<P extends ProviderId>(providerId: P): ProviderEvents<P>` derives the provider-scoped log event names from a provider id using template-literal types. The `ProviderEvents<P>` type pins the field set. The set includes `credentialLoadFailed` (`<provider>_credential_load_failed`), which the shared runner in `src/translated-leg.ts` logs with `model` and `errorCode` (the cause name) only. This is a security control: a config-supplied `string` containing `"\n"` is a COMPILE error at the call site — only a closed `ProviderId` union member can reach the derivation.

### src/models.ts — Pure model registry (no repo imports)

Deliberately imports nothing from the rest of the repo — `config.ts` imports it, and the edge must stay one-way.

Key exports: `PROVIDER_IDS`, `ProviderId`, `AliasesByProvider`, `MODEL_REGISTRY`, `routableModelCount`, `DEFAULT_REASONING_EFFORTS`, `reasoningEffortsForModel`, `buildRoutingTable`, `resolveModel`, `isReservedAnthropicName`, `formatModelsReport`, `buildModelRows`, `buildAliasRows`.

`buildModelRows` emits `ModelRow.reasoningEfforts` (surfaced by `subswitch models --json`) only when a registry entry narrows the default effort vocabulary. `buildRoutingTable` also reports an `unknownReasoningEfforts` diagnostic that `buildDeps` logs as `registry_entry_unknown_effort`, alongside its other startup diagnostics (`alias_rejected`, `alias_dangling_target`, `ambiguous_family`, `registry_entry_uses_reserved_name`).

**Never delete a `MODEL_REGISTRY` entry — mark it `retired: true` instead.** Deleting silently unroutes anyone pinned to that id (they'd fall through to Anthropic instead); `retired: true` keeps the id in `byId` so the request still reaches the provider and gets the upstream's own answer (a Codex 400, not a relay-invented 404). Retired entries are excluded from `routableModelCount` and from family-alias derivation (`selectFamilyWinners` skips `retired === true`), but `buildAliasRows` still renders a `direct` row for them with `enabled: false`, and `buildModelRows` always emits `routable: entry.retired !== true` / `retired: entry.retired === true` so `models --json` is exhaustive over history. `gpt-5.5` (retired 2026-10-14) is the live example: hidden from the human `models` table, still present in `models --json` as `{"id":"gpt-5.5", "retired":true, "routable":false}`, and an agent frontmatter pin to it produces `checkAgentModels`' `"retired"` finding at severity `"info"` (not `"fail"`) — it still routes.

**`isReservedAnthropicName` / `ANTHROPIC_NAME_RE` is two arms, not one regex style.** A prefix arm (`^(?:inherit|sonnet|opus|haiku|claude-)`) catches variant suffixes (`sonnet[1m]`, `opusplan`, `claude-3-7-sonnet-…`) by design (ADR-005 exact-membership routing still needs the *reservation* check to be prefix-based, or a variant tier name could slip through and reopen the main-thread→Codex misroute hole, PF-007). A second, exact-word arm (`` ^(?:fable|best)(?:$|\[) ``, case-insensitive) reserves the Claude Code `fable`/`best` aliases without reserving every word that starts with them — `bestie` and `fabled` stay available as ordinary Codex alias keys. `default` is deliberately NOT in either arm: Claude Code documents it as a value that *clears* a model override, not a subagent `model:` value, so a Codex alias literally named `default` still routes.

### src/cli.ts — Dispatcher

`parseCliArgs` returns a discriminated `CliCommand` union. Flag sets per command:

- `serve`: `verbose`, `quiet`, `port`, `detach`
- `doctor`: `client` (defaults to `all`; reverse checks run when configured)
- `models`: `json`, `client` (defaults to `claude-code`)
- `init`: `yes`, `dry-run`, `port`, `settings-target`, `client` (defaults to `claude-code`)

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
2. `hostGateVerdict(req.headers)` — foreign Host → 403 + `drainRejectedUpload(req)` + return. This also covers Together requests: a foreign Host or Origin gets the 403 before the key load.
3. `/__subswitch/*` namespace — handled locally, never forwarded.
4. `readBodyForRouting(req, limits.maxBufferedBodyBytes)` — reads up to the window. Returns discriminated `IngestedBody`: `complete` (body fits) or `over_window` (body exceeded cap, prefix held). `IngestError` has one variant: `client_disconnected`.
5. Exhaustive `IngestError` switch:
   - `client_disconnected` → no response (client gone; logged by the close handler already).
6. Over-window routing:
   - Anthropic-bound → sniff prefix for model key → `anthropic:streamed` (model found) or `anthropic:streamed:unsniffed` (fail-open); stream body to upstream; no 413.
   - Translated provider → 413 `request_too_large` + `drainRejectedUpload(req)` (relay is origin here).

**`client_disconnected` log event.** When `res.close` fires with `!res.headersSent`, the handler logs `info client_disconnected { path, route, model?, latencyMs }` instead of `request_complete`. This is correct: `res.statusCode` is Node's 200 initialiser when no response has been sent, so `request_complete status=200` would make a vanished client indistinguishable from a served request. `res` "close" fires **before** `req` "error" on Node 22 — the decision must live in the `close` handler.

**Route log labels.** `route` defaults to `"anthropic"` and is updated before dispatch:
- `"host_rejected"` — foreign Host gate fired.
- `"anthropic:streamed"` — over-window body; sniff resolved model key; body piped to upstream.
- `"anthropic:streamed:unsniffed"` — over-window body; model key not in prefix; fail-open to Anthropic (ADR-010).
- `"anthropic:ambiguous"` — `resolveModel` returned `"ambiguous"`; fails open (ADR-010).
- `"anthropic:fallback"` — `resolveModel` returned `"unknown_qualifier"`; fails open (ADR-010).
- `"{provider}:{endpoint}:{model}"` — routed to a configured provider.
- `"internal_error"` — unhandled `dispatch()` rejection.
- Retired values (no producer): `"rate_limited"`, `"ambiguous"`, `"unknown_provider"`.

**`bodyMode` log field** (optional string): `"buffered"` (complete path — full body in window) or `"streamed"` (over_window path — prefix sniffed, remainder piped). Present on `request_complete` log events whenever the body was processed.

**`IngestError`** (module-local type, `server.ts`): `{ kind: "client_disconnected"; message: string }`. Single variant — `body_too_large` was removed; over-window Anthropic bodies are streamed, not rejected. Intentionally excluded from `ProxyError` so `proxyErrorToAnthropic` can never be called with it — any attempt is a compile error.

**Together wiring.** The startup host check vets `providers.together.baseUrl`. It accepts the default `https://api.together.ai/v1` and loopback. It accepts `api-inference.together.ai` or `us-api.together.ai` only with `providers.together.allowInsecureBaseUrl: true`, and it refuses every other host (`api.together.xyz` too). A refused host stops the startup. Config load already refuses a Together URL with userinfo, a query or a fragment. The whole `providers.together` block loads only from the user config or SUBSWITCH_CONFIG. The health arm reports `configured` and `keySource: "env" | null` from `envKeyPresent(env)` and never runs the Keychain tool. A source-text guard keeps every read of the key env var in `src/together-auth.ts`. It also refuses a computed env index, an env object copy under another name, destructuring of `process`, computed destructuring of an env object, a reflective env read (`Reflect.get`, `Object.entries` and similar), and any use of the exported name constant outside three named uses (the run-action deletion and the provider accessor data).

**Byte-budget admission gate is GONE.** The old `inFlightBytes`, `queue`, `acquireSlot`, `drainQueue`, `releaseSlot`, `getReservationBytes`, `SlotError`, `QueueEntry`, and the synthesized 529/`rate_limited`/`disconnected_while_queued` labels were all removed as ADR-010 violations.

**Ambiguous model routing fails open (ADR-010).** When `resolveModel` returns `"ambiguous"`, the relay logs `warn ambiguous_model_name` and forwards to Anthropic unchanged — it does not synthesize a 400.

### src/provider-transport.ts — Shared transport helpers

**`drainRejectedUpload(req)`** (exported): drains an in-flight upload after a rejection response has been sent (or when dispatch() throws), so the socket closes with FIN rather than RST. Bounds: 2-second unref'd timer (`REJECTED_UPLOAD_DRAIN_MS = 2_000`) + 32 MiB byte cap (`REJECTED_UPLOAD_DRAIN_BYTES = 32 * 1024 * 1024`). Five callers:
- `server.ts` host-gate 403 path.
- `server.ts` 413 translated-provider over-window path.
- `server.ts` `dispatch().catch` — resumes paused req when dispatch() throws after over_window trip.
- `anthropic-passthrough.ts` unbuffered 504 (upstream timeout) path.
- `anthropic-passthrough.ts` unbuffered 502 (upstream error) path.

**`respondJson(res, status, body, extraHeaders?)`** (exported): writes a JSON response. `extraHeaders` is spread **before** `SYNTHESIZED_HEADER` in the `writeHead` call — the synthesized marker always wins over any caller-supplied header with the same name. The `extraHeaders` parameter exists specifically for the Codex 429 `retry-after` passthrough.

### src/errors.ts

`ProxyError` (no `body_too_large`/`client_disconnected`); `AnthropicErrorType` (includes `not_found_error`; `overloaded_error` removed — upstream 5xx incl. 529 → `api_error`); `SYNTHESIZED_HEADER`/`SYNTHESIZED_MARKER` exported as single chokepoint for `x-subswitch-synthesized`; `redactCredentials` inside `toAnthropicErrorBody` (ADR-008).

The scrub matches exact values only if a caller registers them. It keeps one current and one previous value per provider ID. In production, only `src/server.ts` registers a value: the Together key. If registration fails, the server treats the key as malformed. The scrub also matches Bearer and JWT patterns.

### src/init.ts — Functional-core / imperative-shell

**`InitFlags`** is `{ port?: string; settingsTarget?: string }`.

Pure planning layer (no side effects): `resolveInitDispatch`, `resolveOptionsFromFlags`, `planConfigWrite`, `planSettingsWrite`, `collectPreconditionWarnings`, `settingsPathFor`.

**Effectful execution layer:** `executeInit(options, deps, projectDir)` returns `Result<readonly [configPath, settingsPath], InitError>`. Write order is config-first. All reads happen before any write.

**Wizard:** prompts only for port and settings-target. `makeClackPrompts()` lazy-imports `@clack/prompts` via dynamic `import()` — called only when entering the interactive path. Neither init path asks for, prints or writes the Together key.

### src/doctor.ts — Preflight gate

`runDoctor(config, configPath, fileFound, io, configuredProviderIds)`. The fifth parameter is `ReadonlySet<ProviderId>` defaulting to `new Set<ProviderId>()`.

**`PROVIDER_AUTH_INSPECTORS`** is an **exported** record keyed by `ProviderId`. A `ProviderId` without an entry is a `tsc` error. Each inspector takes its own provider's config slice (`config.providers[id]`) and the doctor io, does its own credential read, and returns a `DoctorAuthInspection`. `runDoctor` calls each inspector by id. An `oauth-file` inspection carries a neutral `DoctorAuthRow`: the `identity` lines, the `token expires:` line, then the `renewal` lines. The Codex adapter `codexAuthRow` in doctor.ts maps `AuthInspection` to this row, so the Codex text does not change.

**N-provider auth check severity (PF-006 rules):**
- Provider absent from config file → informational.
- Provider present but credential missing/broken → failure.
- Credential file exists but does not parse → failure regardless of opt-in.

**Together (`api-key` kind).** Doctor reads the key once per run through the injected reader (env first, then the Keychain on macOS). It never prints the value.
- Key found → `OK (env)` or `OK (keychain)`.
- No usable key and no `providers.together` block → `unconfigured` (informational).
- No usable key with a block → `UNAVAILABLE` (failure). A malformed key adds `(key is malformed)`.
- An agent pin that resolves to Together with no key → `agent model: FAIL` (see agent-scan). With a usable key, doctor does not list the pin. A project `.claude/agents/*.md` file or a project Claude Code setting can name a `together:` model, so README and SECURITY.md tell users to check a cloned repository.
- The hint comes from `togetherKeyHintFor(platform)`: on macOS it names the env var and the Keychain item; elsewhere it says "environment variable only on this platform".

**Kimi (`oauth-file` kind, `inspectKimiAuth`).**
- No `providers.kimi` block: the inspector returns `not-opted-in` before any I/O. The row reads `not turned on`, with a hint to add the block to the user configuration or a `SUBSWITCH_CONFIG` file. It is not a failure, and doctor makes no host probe for Kimi (`providerHosts` leaves the host empty when `active` is false).
- With the block: the row shows the configured file path, `token expires:` and `renewal due:`. Doctor gets only the store maker and the clock (`kimiStore` in `DoctorIO`, built by `liveKimiStoreDeps` in `src/cli.ts`), not the fetch, so it can not renew.
- Fault split: `invalid_record`, `unsafe_path`, `layout_unsupported` and `platform_unsupported` are an invalid file. `credential_missing` is a missing file. Other codes are an unreadable file. All with a block are failures. The login hint comes from `kimiCredentialFor`.

**Read-only Keychain (`native-keychain` kind).** No provider uses this kind yet. Doctor probes only attributes and reports the modification time. It makes no probe for an inactive provider. Health reports whether the provider is active, with no Keychain access.

### src/agent-scan.ts — Agent frontmatter scanner

`parseFrontmatterModel(text)` has no YAML dependency. `checkAgentModels(files, table, configuredProviders, registry, keyRequiredProviders)` returns six finding kinds. `provider_unconfigured` has severity `"info"` unless its provider is in `keyRequiredProviders`. Doctor puts `api-key` and `native-keychain` providers in that set. A malformed `together:` pin is `unresolvable` (`"fail"`).

**`unknown_provider` is now severity `"info"`, not `"fail"` (ADR-010).** An unknown qualifier does not make the request fail — subswitch forwards it to Anthropic unchanged. By contrast `ambiguous` stays `"fail"` because that conflict is subswitch-derived and WILL produce a routing error.

**`fable` and `best` (and their `[…]`-suffixed variants) are silently skipped, not flagged.** `checkAgentModels` treats them the same as `sonnet`/`opus`/`haiku`/`claude-*` — they resolve on the Claude Code side, so an agent frontmatter pin to `model: best` produces zero findings, not an `unresolvable` one.

### src/codex-doctor.ts — `doctor --client codex` (reverse-leg checks)

`runCodexDoctor(config, write, options)` is the `--client codex` half of the doctor dispatch (native routing/auth/config checks; no refresh). Its agent-model scan reuses `isClaudeModelName` from `src/claude-models.ts` — the **same case-insensitive `claude-`/`claude:` namespace predicate** the reverse-leg gateway uses to refuse a name — so doctor flags exactly the agent models the gateway would reject (`Claude-Opus-5` fails identically to `claude-opus-5`), never more, never less. Full reverse-leg model-resolution contract (`CLAUDE_MODELS`, `claudeModel`, `displayModelName`, `unregistered_claude_model`) lives in the codex-leg KB — this file only owns the CLI-surfaced doctor row.

### src/logger.ts — Structured key=value logger

The console logger defaults to stderr. With color enabled, it adds a `[HH:MM:SS]` prefix.
Foreground `serve` also writes to `relay.log`. Detached `serve` writes structured logs to that file only.
The relay file logger adds an ISO 8601 time and does not use color.
The logger writes `level=<L> event=<E> key=value …` and uses only fields in `FIELD_KEYS`, in that order.

**`FIELD_KEYS` now has a bidirectional compile-time completeness check:**
- `as const satisfies readonly (keyof LogFields)[]` — every listed key must exist in `LogFields`.
- `type _FieldKeysComplete = Exclude<keyof LogFields, (typeof FIELD_KEYS)[number]> extends never ? true : never` — every field in `LogFields` must appear in `FIELD_KEYS`. Adding a field to `LogFields` without adding it to `FIELD_KEYS` is a compile error.

**Log injection prevention:** `renderToken(value)` strips all C0 control characters (U+0000–U+001F), DEL (U+007F), and C1 control characters (U+0080–U+009F) — not just `\r\n` — then quotes anything matching `/[\s="\\]/`. Applied to both field values AND the event token. The primary control is that every event name is a compile-time string literal.

## Non-interactive Safety Contract

`resolveInitDispatch` is the single gateway. Three outcomes: `"interactive"`, `"non-interactive"` (`--yes` set), `"refuse"` (non-TTY or CI without `--yes`). `yesFlag` is checked before `hasCIEnv`. **Exception:** `--dry-run` bypasses `resolveInitDispatch` entirely.

## Exit-code Contract

| Command | Condition | Exit code |
|---------|-----------|-----------|
| `serve` | The relay stops normally after a stop signal. | 0 |
| `serve` | Startup fails, shutdown times out or the relay exits after a fatal error. | 1 |
| `serve --detach` | A verified relay responds to the health request. Stdout contains its PID. | 0 |
| `serve --detach` | A legacy relay responds without a record. Stdout is empty. | 0 |
| `serve --detach` | `port_in_use`: A foreign listener answers on the port. | 1 |
| `serve --detach` | `child_exited`: The child cannot start or exits before it is ready. | 1 |
| `serve --detach` | `not_ready`: The new relay is not ready within 8 seconds. | 1 |
| `serve --detach` | `identity_mismatch`: The record or health response does not match the new relay. | 1 |
| `serve --detach` | `unsafe_path`: A relay file or folder is not safe to use. | 1 |
| `serve --detach` | The CLI reports an argument, port, config, platform or entry point error. | 1 |
| Command that loads config | Unknown config key or provider block | 1 (config load fails) |
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

- **Reserving a new Claude Code alias word with the prefix arm instead of the exact-word arm** — `sonnet`/`opus`/`haiku`/`claude-`/`inherit` are genuinely prefix-shaped (variant suffixes like `sonnet[1m]` must also be caught), but an ordinary English word like `fable` or `best` needs the exact-word arm (`^word(?:$|\[)`) or it silently blocks legitimate Codex alias keys that merely start with it (`fabled`, `bestie`).

- **Calling `out()` / `errOut()` from `serve` for runtime request logs** — use the structured logger.

- **Assembling the `providers[]` array independently in health or models --json** — always use `enumerateDestinations(config)`.

- **Calling `req.destroy()` after a rejection response** — use `drainRejectedUpload(req)` instead. `req.destroy()` causes the kernel to send RST, which may cause the client to discard the already-sent response before reading it.

## Gotchas

**KB-INV-3 — The doctor auth line is filtered where it is written.** The loop over `PROVIDER_IDS` in `src/doctor.ts` calls `io.write(redactCredentials(line))` for every provider auth result line. The inspectors do not filter their own lines. The filter matches the same exact values and Bearer and JWT patterns as the error render site (see the scrub scope above).

**KB-INV-4, KB-INV-5, KB-AP-1 — The serve banner marks a provider without its block.** In `src/cli.ts`, the banner row of an inactive provider ends with `(not turned on)` and names no host. An active provider shows its host from `BANNER_HOST`. Health reports `configured: false` for an inactive provider and does not stat its file. Codex and Together are always active, so their rows do not change. `buildDeps` builds the Kimi provider only when `optedIn` is true, so doctor, banner, health and the server agree on one answer.

**KB-INV-6, KB-INV-7 — One row, three read-only facts.** The Kimi doctor line goes through `redactCredentials` at the write site like every provider line (see KB-INV-3). A project config can not set the Kimi block, because the block turns on a sign-in route; see the config precedence section below.

**KB-INV-8 — The live check is for the owner.** `e2e/gates/kimi-live-check.ts` runs from the repository root, with `subswitch serve` stopped, because it listens on the configured port. The user config must have no `providers.kimi` block: the opt-in block exists only in the in-process config of the check. The dry run makes its fabricated sign-in due, so it also runs the renewal path; the live mode renews only when the sign-in is due.

**KB-AP-2 — The CLI child test helper.** `cliChildCommand` and `runCliChild` in `test/helpers/cli-child.ts` are the only way a test starts `src/cli.ts` (a source-text guard checks this). `recordFsUnder` takes a folder below the child home and logs each named file call at or inside it (`test/helpers/fs-path-recorder.ts`: first path argument only, not a sandbox). `test/integration/kimi-cli.test.ts` uses it: without the block, no call under the Kimi home; with the block, the read shows. The same file pins the banner rows and the `models` Kimi rows.

**The byte-budget admission gate is gone. Any text describing a concurrency cap, byte-based admission, queueing, or a 503/529 from the relay is now false.** `"overloaded_error"` was removed from `AnthropicErrorType` — upstream 5xx including 529 maps to `"api_error"` via `upstreamStatusToAnthropicError`.

**`FORCE_COLOR` beats `NO_COLOR` here — this inverts the no-color.org convention.** `FORCE_COLOR=1 NO_COLOR=1 subswitch models` emits ANSI. Do not "fix" it without a decision record.

**`FORCE_COLOR=0` and `FORCE_COLOR=""` do not force color.** Both fall through to the `NO_COLOR`/`isTTY` tiers.

**Doctor probes TLS on port 443 unconditionally.** An operator with an `http://` or non-443 `baseUrl` (a local mock) always sees `TLS: FAIL` and a `failures++`.

**`isLoopbackHost` and `isLoopbackHostname` are NOT interchangeable.** `isLoopbackHost` (config.ts, exported) receives WHATWG-parsed hostnames (`new URL().hostname`) where IPv6 brackets are preserved by the parser — it strips them. `isLoopbackHostname` (inbound-policy.ts, private) receives wire Host-header authority strings and handles brackets/ports itself. Passing a wire Host header directly to `isLoopbackHost` will fail on port-qualified addresses like `127.0.0.1:4141`.

**`socket.bytesWritten` is a per-socket-lifetime counter.** In the `clientError` handler, comparing `socket.bytesWritten !== 0` gives false positives on keep-alive sockets that have already served responses. The WeakMap snapshot (taken at each `res` "finish") is the correct guard.

**`res` "close" fires BEFORE `req` "error" on Node 22 (measured).** In the `readBodyForRouting` flow, the `client_disconnected` decision must live in the `res` "close" handler — not in a `req` "error" handler — or the log entry can be emitted after the close event has already been processed.

**Doctor always exits non-zero in CI.** `scripts/smoke-tarball.sh` uses `subswitch --version` — always exits 0 — not `subswitch doctor` (applies PF-006).

**Zod strips unknown keys at the top-level `providers.*` and pre-restructure positions — the raw pre-parse scans are the only guard there.** Inside a known block (e.g. a misspelled field inside `providers.codex`), `z.strictObject` catches it (avoids PF-010).

**`subswitch.config.example.json` must stay in sync with the strict schema.** A stale example with an unknown key is a hard load error.

**Legacy or removed keys hard-error immediately via `LEGACY_KEY_ENTRIES`.** There is no path where a legacy key's value is validated before being discarded — the load fails at the pre-parse scan before Zod runs.

**`ambiguous` model routing fails open.** The relay forwards to Anthropic and logs `warn ambiguous_model_name`. It does NOT synthesize a 400. Route label is `anthropic:ambiguous`.

**`maxHeaderSize` must go through `http.createServer({ maxHeaderSize }, ...)`.** It is not a settable property on the server object after construction.

**A `retired: true` registry entry disappears from the human `models` table but not from `models --json` or routing.** `buildAliasRows` still emits a `direct` row for it (`enabled: false`), `buildModelRows` always reports both `routable` and `retired` booleans, and `byId` still resolves it — only `routableModelCount` and family-alias derivation exclude it. An agent frontmatter pin to a retired id is an `"info"` doctor finding, not a `"fail"` — the pin still works, it is a nudge to move off it before the upstream stops answering.

**`default` is deliberately not a reserved Claude Code alias name.** Unlike `sonnet`/`opus`/`haiku`/`fable`/`best`, Claude Code documents `default` as a sentinel that *clears* a model override rather than a subagent `model:` value — a Codex config alias key literally named `default` is untouched by `isReservedAnthropicName` and still routes normally.

**Test suite gotchas:**
- Test globs are FLAT and NON-RECURSIVE (`test/unit/*.test.ts`, `test/integration/*.test.ts`). A new test file in a subdirectory silently never runs.
- Run the suite alone — it has wall-clock assertions and flakes under parallel load alongside other processes (e.g., concurrent `tsc`).
- `version.test.ts` pins both `package-lock.json` version fields AND the newest `CHANGELOG.md` heading — bumping the version requires updating all three simultaneously.

**Parallel-agent git atomicity.** `git add <paths>` followed by a separate `git commit` is not atomic — another agent can stage its own files between the two commands. Use `git commit --only -m "…" -- <paths>` (no prior `git add`) to stage and commit only the named paths in a single operation.

## Key Files

- `src/tty.ts` — `resolveColorEnabled(env, isTTY)` — single color-enable source of truth
- `src/cli.ts` — Binary entry point; `parseCliArgs` → `CliCommand` union; exhaustive switch with `never` guard
- `src/config.ts` — `detectConfiguredProviders` (one owner of "the block exists"), `optedIn`, `ProviderRuntimeConfig.active`, `kimiCredentialFor`; `FileConfig`/`Config` split; `z.strictObject` for all top-level sub-schemas; `isLoopbackHost` (exported, strict dotted-quad + localhost + ::1 only); https-or-loopback refinements; `LEGACY_KEY_ENTRIES` + `detectLegacyConfigKeys` — single hard-error mechanism; `resolveConfig` field-by-field; `enumerateDestinations` + `RoutingDestination`; totality anchors
- `src/provider-events.ts` — `providerEvents<P extends ProviderId>`; template-literal `ProviderEvents<P>`; one event table that the type pins; compile-time log-injection control
- `src/logger.ts` — `createConsoleLogger`; `FIELD_KEYS` bidirectional completeness check; `renderToken` strips all C0/DEL/C1 control characters then quotes — applied to values AND event token
- `src/inbound-policy.ts` — `SERVER_TUNING` (exported); `applyInboundPolicy(server, logger)` (single entry point — applies tuning AND registers `clientError` handler); `appliedServers` WeakSet (idempotency guard); `hostGateVerdict(headers)` (pure, exported — wire-side Host/Origin gate); `responseForClientError(code)` (Object.hasOwn, prototype-safe); `writtenAtLastResponse` WeakMap (per-request reply guard, snapshots `socket.bytesWritten` at each response finish)
- `src/server.ts` — `buildDeps(config, logger?)` — the one wiring site; `IngestError` (module-local, single variant `client_disconnected`); dispatch order: close listener → host gate → namespace → `readBodyForRouting` → exhaustive error switch → over-window routing → provider dispatch; `client_disconnected` log event for headerless close; `bodyMode` field (`buffered`/`streamed`); `anthropic:streamed`/`anthropic:streamed:unsniffed`/`anthropic:ambiguous`/`anthropic:fallback` route labels
- `src/provider-transport.ts` — `drainRejectedUpload(req)` (exported; 2 s + 32 MiB bounds; 5 callers); `respondJson(res, status, body, extraHeaders?)` (extraHeaders spread before marker so marker always wins)
- `src/errors.ts` — `ProxyError` (no `client_disconnected`); `AnthropicErrorType` (includes `not_found_error`; `overloaded_error` removed); `SYNTHESIZED_HEADER`/`SYNTHESIZED_MARKER` single chokepoint
- `src/doctor.ts` — `runDoctor`; `PROVIDER_AUTH_INSPECTORS` (exported totality anchor); `inspectKimiAuth` (read-only Kimi row); `makeLiveListAgentFiles` (absolute-path resolution critical)
- `e2e/gates/kimi-live-check.ts` — `npm run probe:kimi`: `--live` (CI, TTY and phrase gate) and `--dry-run` (fakes)
- `test/helpers/cli-child.ts`, `test/helpers/fs-path-recorder.ts` — the one CLI child starter and its file-call recorder; `test/integration/kimi-cli.test.ts` and `test/unit/kimi-doctor.test.ts` pin the Kimi banner and doctor rows
- `src/init.ts` — Pure planning + `InitFsDeps` / `InitPrompts` seams; wizard prompts only port + settings-target
- `src/agent-scan.ts` — `parseFrontmatterModel`; `checkAgentModels`; `unknown_provider` severity `"info"` (ADR-010)
- `src/models.ts` — Pure registry; no repo imports; `MODEL_REGISTRY` (`retired`/`preview` flags, never delete an entry); `PROVIDER_IDS`, `DEFAULT_REASONING_EFFORTS`, `reasoningEffortsForModel`, `buildRoutingTable`, `resolveModel`, `isReservedAnthropicName` (two-arm `ANTHROPIC_NAME_RE`: prefix arm for `sonnet`/`opus`/`haiku`/`claude-`/`inherit`, exact-word arm for `fable`/`best`), `routableModelCount` (excludes retired)
- `src/codex-doctor.ts` — `runCodexDoctor`; reuses `isClaudeModelName` (case-insensitive) from `src/claude-models.ts` so its agent-model scan matches the reverse-leg gateway's own refusal predicate exactly
- `src/plain-object.ts` — Shared `isPlainObject` guard for `doctor.ts` and `init.ts`; `config.ts` keeps its own private copy (prototype-pollution boundary)

## Related

- ADR-010: Relay transparency — a relay must be indistinguishable from the origin; drove removal of the byte-budget gate, the synthesized 529, and the ambiguous-model 400; governs `anthropic:ambiguous`/`anthropic:fallback` fail-open routing.
- ADR-009: Credential vetting — `isLoopbackHost` strictness is load-bearing here; the loopback exemption is what makes `http://127.0.0.1:4142` reachable in dev.
- ADR-008: Credential redaction applied once at the error render site — the chokepoint pattern also used for the 404 body (no path reflection).
- ADR-006: `MODEL_REGISTRY` as sole routable set source.
- PF-007: Alias TARGETS need the same reservation check as alias keys — `isReservedAnthropicName` is applied to both `Object.keys` and `Object.values` of `AliasesSchema`; the `fable`/`best` word-arm closes the same hole for the two new reserved names.
- ADR-005: Route by exact model-name membership in the routable set, not by prefix matching — governs why `isReservedAnthropicName`'s prefix arm exists (a variant suffix must still be caught) alongside the exact-word arm for `fable`/`best`.
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
- `.devflow/features/codex-leg/KNOWLEDGE.md` — Full model resolution contract, `buildHeaders`, the `ProviderEvents<P>` table, the runner's credential fault log, the `run-action` child env filter for the Together key, the Kimi sign-in store, `kimiRenewalDue` and renewal, and the Codex handler/translator/auth side.
- `src/version.ts` — Source of `SUBSWITCH_VERSION` used by `--version`, doctor, `/__subswitch/health`, and `models --json`.

## Bidirectional ingress and configuration (2026-09-08)

`Config.codexIngress` enables native Codex HTTP/WebSocket ingress; its `claude` slice
controls Claude translation. `init --client codex|all` plans native TOML and SubSwitch
writes through `codex-init.ts` Result-returning helpers; custom upstream trust is explicit.
`doctor --client codex` checks native setup/auth/connectivity without refresh. Default
`doctor` selects `all` but skips disabled reverse checks. `models --json` stays version 1
for `claude-code`; version 2 has `client: codex|all` and separately documented shapes.

Configuration precedence is explicit `SUBSWITCH_CONFIG` (no merge), otherwise permitted project
settings over `$XDG_CONFIG_HOME/subswitch/config.json` over defaults. `userConfigPath` uses
`XDG_CONFIG_HOME` only when it is absolute; a relative or empty value falls back to `~/.config`.
`accessProfiles` and `routes`, including profile endpoint opt-ins, require a user or explicit file.
So do every sign-in address, every credential file or folder key (`providers.<id>.authFile`,
`codexIngress.claude.authFile`, `codexIngress.claude.configDir`) and every `allowInsecureBaseUrl`
opt-in (`PROJECT_REFUSED_KEYS` in `src/config.ts`, matched with `hasOwnPath`). Project declarations fail the load, even for empty
values, and the error names each refused dotted key.
Explicit profiles use only Claude or Codex subscription sign-ins with `native-oauth`.
Unknown fields and unsupported product or credential values fail the load; the error names the value.
The removed branch-only settings never formed part of main; strict schemas reject them without a legacy migration row.
`run-action` ignores the project port and uses the user or explicit port, then the built-in default.
`LoadConfigResult.configPaths` lists every loaded source; legacy/unknown-provider errors
name the source containing the offending key. `configuredProviders` reflects all sources.

`src/clients.ts` owns the supported-client IDs and the `all` selector. Legacy `both`
normalizes to `all`; model JSON uses the canonical `client: "all"` discriminator.

`src/claude-models.ts`'s `isOpenaiModelName` (the gate behind `codexIngress.claude.aliases`) is built by `buildOpenaiModelNamePredicate(MODEL_REGISTRY)` rather than a hand-written alternation, so a family added to the registry is automatically reserved on the claude-ingress alias leg with no code change. Full detail in the codex-leg KB.
