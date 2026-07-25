# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **Model family aliases**: `sol`, `terra`, and `luna` are now valid `model:` values
  in agent frontmatter. Each alias resolves to the highest-generation canonical id
  for that family (e.g. `sol` → `gpt-5.6-sol`). Resolution follows four rules in
  priority order: exact registry id, custom `codex.aliases` override, family alias
  scoped to the routable set, then undefined (no match → Anthropic leg).
- **`subswitch models`**: new subcommand that prints the effective model registry,
  alias resolution table, and which ids are routed to Codex vs. Anthropic under the
  current config. Useful for confirming alias resolution before running agents.
- **Agent frontmatter scanner in `doctor`**: `subswitch doctor` now scans
  `.claude/agents/` (project and global) for agent files whose `model:` value cannot
  be resolved. Unresolvable models are reported as failures (exit 1); models known to
  the registry but excluded from `codex.models` are reported as informational notices.
  Anthropic-tier names (`claude-*`, `sonnet`, `opus`, `haiku`, `inherit`) are skipped.
- **`codex.aliases`** config key: a free-form map of custom model name overrides
  (`{ "my-model": "gpt-5.6-sol" }`). Aliases defined here win over family aliases.
- **Floating `codex.models` default**: `codex.models` is now optional in config.
  When omitted, all registry ids are routable and the key is not written to config
  by `subswitch init`. Narrowing (writing an explicit list) is still supported.

### Changed / Behavior

- **`subswitch init` no longer pins `codex.models`** when all registry ids are
  selected (the default). The key is omitted from the written config, keeping it
  floating against the registry. The key is written only when the user narrows the
  selection. Running `init` over an existing config that has a stale `codex.models`
  pin will delete it if the result matches the full registry default.
- **`subswitch doctor`** prints the alias resolution table after the `codex.models:`
  row and nudges the user to remove a stale explicit pin when one is detected.

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
