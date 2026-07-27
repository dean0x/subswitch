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

### Known limitations and deferred work

These items are deliberately deferred — they are real constraints that should be fixed
before adding a second production provider:

- **`codex-handler` is not yet provider-neutral**: `providerName` is parameterized but
  never set by any caller, and five `config.codex.*` reads plus five `codex_*` log event
  names are hardcoded. Deferred to the branch that adds a second provider.
- **Runtime `Config` still carries a top-level `codex` block** rather than
  `providers.<id>.*`. The on-disk shape generalized; the runtime shape did not. Moving it
  cascades into codex-handler and all call sites — deferred with the second provider.
- **SSE parser boundary scan is effectively quadratic in pathological cases**: the scan
  offset bounds the regex to O(new bytes), but `buffer.slice()` allocates per chunk and
  forces V8 to flatten the cons-string. Measured 37 / 138 / 557 ms at 2 / 4 / 8 MiB.
  Frame boundaries are correct (11,864/11,864 splits verified identical to base). Fix
  deferred — not on the critical path for current payload sizes.
- **`buildModelRows` and `buildAliasRows` duplicate the "newest non-preview non-retired
  wins" derivation** that `buildRoutingTable` also implements — two sources of truth that
  can drift. `buildAliasRows` also falls back to `PROVIDER_IDS[0]` for unknown targets,
  a first-provider assumption that becomes wrong with a second provider.
- **Branded `ProviderAuth` seam** is owed before a second credential is wired. An earlier
  `src/provider-auth.ts` was deleted because its headers-out shape contradicted the
  token-out `CodexCredentials` that `CodexAuthManager` actually returns. A tripwire
  comment at the `createCodexProvider` wiring site in `src/server.ts` marks the spot.
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
