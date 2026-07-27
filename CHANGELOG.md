# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **Model family aliases**: `sol`, `terra`, and `luna` are now valid `model:` values
  in agent frontmatter. Each alias resolves to the highest-generation canonical id
  for that family (e.g. `sol` → `gpt-5.6-sol`). Resolution follows five rules in
  priority order: exact registry id, custom alias override, qualified `provider:name`,
  family (unique claimant), then unresolved (passes to Anthropic).
- **`subswitch models`**: new subcommand that prints the effective model registry and
  alias resolution table under the current config. `--json` emits a machine-readable
  document (see README §`subswitch models --json`) with an integer `schemaVersion`
  contract. `gen` is an integer tuple (`[5, 6]`) rather than a string (`"5.6"`)
  because string comparison sorts `"5.10"` before `"5.9"`. `preview` and `retired`
  are always-present booleans. Anthropic is listed with zero model rows — we
  prefix-match Claude names and cannot enumerate them; fabricating a list would be a
  lie consumers cache.
- **`providers.codex.aliases`** config key: free-form map of custom model name
  overrides. Aliases win over derived family aliases but never over exact registry ids.
  Neither key nor target may be an Anthropic model name; such a config is rejected at
  load because either side would route main-agent traffic to Codex.
- **`subswitch doctor`** per-provider diagnostics: doctor fans out to all configured
  providers, prints a per-provider ready banner on startup, and scans `.claude/agents/`
  for six finding kinds (unresolvable model, misrouted Anthropic name, dangling alias
  target, ambiguous family, unknown provider qualifier, and missing auth). Finding
  severity follows provider configuration — a provider the user never configured stays
  informational; only explicitly configured providers can fail the exit code.
- **`limits.maxConcurrentRequests`** (default: `32`): in-flight request ceiling. Requests
  above this limit receive an immediate 503. Protects against burst overload and makes
  resource usage predictable.
- **`providers.codex.requestTimeoutMs`**, **`providers.codex.streamIdleTimeoutMs`**,
  **`providers.codex.maxSseEventBytes`**: three per-Codex-leg timeout/size limits,
  split out from the old flat `limits.*` block.
- **`writeFrame` abort safety**: the SSE frame drain wait is now raced against the
  request abort signal, preventing a hang when the client disconnects mid-stream.
- **`/health` endpoint `providers[]`**: the health JSON now includes a `providers`
  array so monitoring scripts can check provider-level ready state without parsing
  server logs.
- **New modules**: `anthropic-wire-types.ts`, `anthropic-parse.ts`,
  `provider-transport.ts`, `provider-handler.ts` — provider-neutral seams for the
  future second provider.

### Breaking change — config file format restructured

**This is a breaking change if you have an existing `subswitch.config.json`.** There
is no automatic migration and no compatibility shim. At the time of this release there
are zero published users, which is exactly why no shim was written.

What moved and what was removed:

| Old key | New location |
|---------|-------------|
| `codex.*` (entire block) | `providers.codex.*` |
| `reasoningCache.*` (top-level) | `providers.codex.reasoningCache.*` |
| `limits.connectTimeoutMs` | `anthropic.connectTimeoutMs` |
| `limits.maxUpstreamSockets` | `anthropic.maxUpstreamSockets` |
| `limits.streamIdleTimeoutMs` | `anthropic.streamIdleTimeoutMs` and/or `providers.codex.streamIdleTimeoutMs` |
| `limits.requestTimeoutMs` | `providers.codex.requestTimeoutMs` |
| `limits.maxSseEventBytes` | `providers.codex.maxSseEventBytes` |
| `codex.models` | **Removed** — routing now follows the built-in model registry; use `providers.codex.aliases` for custom names |

An old config file is **rejected at load** with an error that names each key and its
replacement. This is intentional: Zod's default behaviour strips unknown keys, so
without the detection gate every custom setting would silently revert to defaults.

For the same reason, a `providers.<id>` block written under an id subswitch does not
ship — a typo like `providers.codexx`, or a provider from a future release — is also
**rejected at load**, naming the offending key and listing the known provider ids.
Such a block would otherwise be stripped by the schema and do nothing at all.

### Changed / Behavior

- **`codex.models` deleted**: the user-maintained model allowlist is gone. The compiled-in
  `MODEL_REGISTRY` is now the sole source of the routable set, built into a
  `RoutingTable` once at startup by `buildRoutingTable`. This is not a capability loss:
  every Codex route traces back to a model name the user wrote in agent frontmatter,
  and Codex auth is already a second gate. A `providers.codex.aliases` entry (rule 2)
  shadows a derived family alias but can never shadow an exact registry id (rule 1).
- **`subswitch init` no longer asks about model selection** and no longer writes a
  `codex.models` key to config. The routing decision belongs to the agent frontmatter.
- **`decideRoute` takes a typed `ModelResolution`** instead of a raw string. The router
  can no longer receive an unvalidated name via the deleted `?? model` fallback. The
  `Route` type is widened to four arms — `provider`, `anthropic`, `ambiguous`, and
  `unknown_provider` — handled by an exhaustive `switch` with a `never` default.
- **Log field `route`** now folds the canonical model id: `route=codex:messages:gpt-5.6-sol`.
  The closed `FIELD_KEYS` allow-list is unchanged; the model id rides inside the
  existing `route` value.
- **Per-provider ready banner**: startup now prints one line per provider with model
  count and target hostname, rather than a single Codex-only line.
- **Renames**: `codexStatusToAnthropicError` → `upstreamStatusToAnthropicError`;
  `isAnthropicModelName` → `isReservedAnthropicName`.
- **Resolved config is keyed by provider id**: the runtime `Config` now exposes
  `providers.<id>.*` instead of a top-level `codex` block, matching the on-disk shape.
  `anthropic` deliberately stays top-level — it is the privileged default leg, not a
  peer provider. Provider totality is now compile-enforced at every site (schemas,
  resolvers, accessors, alias records, handler table), replacing two comments that
  asked contributors to remember. The **on-disk format is unchanged** by this.
- **The provider handler is genuinely provider-neutral**: it receives its own config
  slice rather than the whole `Config`, takes a required `providerId` from the closed
  `ProviderId` union rather than an optional display name no caller ever set, and
  derives its log event names from that id. The Codex leg's output and log records are
  byte-identical — `codex_effort_applied` and friends are unchanged.
- **Log event tokens are sanitized** the same way field values already were (newlines
  stripped, whitespace/`=` quoted). The closed `FIELD_KEYS` allow-list is untouched;
  this is a different axis. Event names are constrained at compile time to the
  `ProviderId` union, so a config-supplied string cannot become an event name.
- **Provider credentials are branded with the provider they belong to**: the auth seam
  is now `ProviderAuth<P>`/`ProviderCredential<P>`, and the handler's `providerId` and
  `auth` share one type parameter. Wiring one provider's credential into another
  provider's handler is a compile error at the wiring site rather than a subscription
  token sent to a third-party host. The seam carries auth headers only — protocol
  constants stay with the handler that owns the transport. Codex sends the same two
  headers with the same values as before.
- **The SSE parser is linear in stream length**: undelivered text is held as an array of
  segments and joined only on the chunk that completes an event, instead of being
  concatenated into one string per chunk. Frame boundaries are unchanged by construction
  and pinned by a golden captured from the previous parser — 16,269 two-way and 49,770
  three-way splits, every one asserted to reproduce the same frame sequence. 8 MiB in
  8 KiB chunks went from 570 ms to 15 ms. No correctness test can see this change in
  either direction, so `test/tools/sse-parser.bench.ts` is the artifact that guards it.
- **Family derivation has exactly one implementation**: `selectFamilyWinners` returns the
  per-provider partition and the collapsed per-family verdict in one pass, and the router
  and the display both read it. Previously each side derived "newest non-preview,
  non-retired wins" for itself.

### Fixed

- **A credential that cannot be refreshed is no longer refreshed anyway**: the 401
  retry guard read `attempt === 0` while the retry budget was `refreshable ? 2 : 1`, so
  a static-credential provider spent a refresh its budget of one attempt did not allow
  and the client received a synthesised "authentication failed after refresh" instead of
  the upstream's own 401. The Codex leg sets `refreshable: true` and is unaffected — its
  request sequence and error text are unchanged.

### Known limitations and deferred work

These items are deliberately deferred — they are real constraints that should be fixed
before adding a second production provider:

- **An expired Codex credential produces a 401 with no remediation text.** The client
  sees `codex upstream error (401): <detail>` and is not told to run `codex login`.
  Nothing regressed — the message that was meant to carry that advice
  (`authentication failed after refresh`) had been unreachable in production, and
  removing it is what made the gap visible. `subswitch doctor` still names the command.
  Adding remediation to the 401 path is a one-line change, deliberately not made here
  because it alters a client-visible Codex string; it needs an owner and a decision.
- **An upstream error body is forwarded to the client verbatim** (first 2 KB). If a
  provider's backend ever echoed the bearer token in an error body, the proxy would
  relay it. No evidence the Codex backend does this, and the proxy binds `127.0.0.1`
  only — but the control is upstream behaviour rather than anything enforced here.
- **`PROVIDER_IDS[0]`-vs-declaring-provider and per-provider default-host checks are
  unfalsifiable with one provider id.** Both are correct by inspection and by an
  out-of-tree probe, but no in-suite test can distinguish them until a second id ships.
  The tests that touch these axes say so at the assertion site; do not read their green
  as coverage.
- **Kimi provider leg** is a separate branch, gated on a five-question live probe
  requiring a real subscription.

## [0.1.0] - 2026-07-24

### Added

- **Proxy core**: local subscription-routing proxy that splits Claude Code traffic
  by model name — requests whose `model` matches the `codex.models` list are
  translated and forwarded to the Codex backend; everything else is relayed to
  Anthropic verbatim.
- **`subswitch serve`**: starts the proxy on `127.0.0.1:4141` (configurable with
  `--port`); accepts `--verbose` / `--quiet` log-level overrides for the session.
- **`subswitch doctor`**: preflight health check that reports config, codex auth
  status, subswitch-running probe, and TLS reachability for both upstream hosts.
- **`subswitch init`**: interactive wizard (powered by `@clack/prompts`) that
  writes `subswitch.config.json` and wires `ANTHROPIC_BASE_URL` into the Claude
  Code settings file; supports `--yes` for non-interactive execution and `--dry-run`
  to preview the planned writes without touching the filesystem.
- **Codex leg**: full Anthropic Messages → OpenAI Responses translation including
  system prompts, tool calling, reasoning round-trip cache (bounded LRU), and
  effort-control forwarding (`output_config.effort` → `reasoning.effort`).
- **Codex OAuth**: reads `~/.codex/auth.json`, proactively refreshes access
  tokens, and retries once on a 401.
- **`subswitch.config.json`**: optional project-level config for port, log level,
  model list, reasoning cache limits, and upstream socket pool size.

### Changed / Behavior

- **`doctor` exits non-zero when any check fails** — exit code 0 means all
  checks passed; exit code 1 means at least one check failed. This makes
  `subswitch doctor` usable as a preflight gate in scripts and CI pipelines.
  (Note: do not invoke `doctor` bare under `set -e` in CI — in CI environments
  the live checks will always fail because the proxy is not running and codex
  auth is not configured. Use `subswitch --version` for a "binary resolves"
  smoke check instead.)
- **Strict per-command flag rejection** — a known flag passed to the wrong
  command (e.g. `doctor --verbose`) now produces a clean error and exits 1
  instead of being silently accepted or ignored.
- **`init` fails closed on non-TTY / CI** — running `subswitch init` without
  `--yes` in a non-interactive environment (no TTY, or `CI` env var set) exits 1
  immediately and writes no files. Use `--yes` to opt in to non-interactive mode
  with explicit intent. `--dry-run` is the only exception — it works in all
  contexts because it writes nothing.
- **Misapplied and unknown flags produce clean `subswitch:`-prefixed errors** —
  no stack traces; exit code 1 with a human-readable message and a pointer to
  `--help`.
