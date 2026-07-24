# subswitch

[![CI](https://github.com/dean0x/subswitch/actions/workflows/ci.yml/badge.svg)](https://github.com/dean0x/subswitch/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node 22+](https://img.shields.io/badge/node-22%2B-brightgreen.svg)](https://nodejs.org/)

**Route Claude Code subagents to a different model - keep everything else on Claude.**

subswitch is a local subscription-routing proxy for Claude Code. Give a subagent a
Codex model in its frontmatter (`model: gpt-5.5`) and *that subagent alone* runs
on your **Codex subscription**; your main agent and every other request stay on
your **claude.ai subscription**, untouched. No API keys — subswitch forwards the
subscription credential each leg already uses.

## Why this is different

Every other Claude Code proxy is all-or-nothing. `ANTHROPIC_BASE_URL` is a single
global setting, so existing routers point *all* of Claude Code's traffic at one
endpoint and typically swap the model for the entire session — your orchestrator,
your utility calls, everything moves at once.

subswitch is the first proxy that splits traffic **per subagent, by model name**:

- Requests whose `model` is one of the exact names in your `codex.models` list are
  translated and sent to the Codex backend.
- Everything else — the main agent, background utility calls (token counting,
  context management), all non-matching models — is relayed to Anthropic as
  **verbatim bytes**, credentials and all.

So you keep Claude Opus/Sonnet driving the session and delegate a specific
subagent to GPT for a second opinion, a cheaper worker, or a specialized task —
without giving up either subscription and without touching an API key.

```
Claude Code ──► subswitch (127.0.0.1:4141)
                  ├─ model ∈ codex.models ──► chatgpt.com Codex backend
                  │    (Anthropic Messages ⇄ OpenAI Responses translation,
                  │     ~/.codex/auth.json OAuth, reasoning round-trip cache)
                  └─ everything else ──────► api.anthropic.com
                       (verbatim byte relay, claude.ai OAuth untouched)
```

Routing is by the request body's `model` field, **exact membership** in
`codex.models`. Unknown models pass through to Anthropic and fail visibly there;
non-matching utility traffic is never misrouted.

## Requirements

- Node 22+
- A claude.ai subscription login in Claude Code (no `ANTHROPIC_API_KEY` set)
- Codex CLI logged in (`codex login` → `~/.codex/auth.json`)

## Quick start

**1. Install** — use it on demand with `npx`, or install the CLI globally:

```sh
npm install -g subswitch          # then run `subswitch <command>`
# or, without installing, prefix any command with npx, e.g. `npx subswitch serve`
```

**2. Run interactive setup:**

```sh
subswitch init
```

`init` walks you through port selection and model configuration, then writes
`ANTHROPIC_BASE_URL` into `.claude/settings.local.json` (per-developer, typically
gitignored — safe default) and saves `subswitch.config.json` in your project directory.

> **Non-interactive / CI:**
> ```sh
> subswitch init --yes --port 4141 --settings-target local
> ```
> `--settings-target local` (default) writes `.claude/settings.local.json` — per-developer,
> typically gitignored. Use `--settings-target shared` to write `.claude/settings.json`
> instead (committed, visible to all team members).
>
> `init` without `--yes` refuses to write anything when stdin is not a TTY (e.g., in CI)
> and exits with code 1. Use `--dry-run` to preview what would be written without actually
> writing — `--dry-run` works in non-TTY and CI contexts.

**3. Start the proxy and verify your setup:**

```sh
subswitch serve      # starts on 127.0.0.1:4141
subswitch doctor     # checks config + codex auth + network (exits non-zero on problems)
```

**4. Route a subagent to Codex** — add a `model:` line to the subagent's frontmatter:

```yaml
---
name: gpt-worker
model: gpt-5.6-sol   # any exact name from codex.models routes to Codex
effort: low          # optional reasoning effort (see Effort control below)
---
```

That subagent alone now runs on Codex; your main agent and every other request stay
on Claude.

### CLI reference

```
subswitch — local subscription-routing proxy for Claude Code

Usage: subswitch [command] [flags]

Commands:
  serve     Start the proxy (default command)
  doctor    Check config, codex auth, and network reachability
  init      Interactive setup — writes config + wires Claude Code

Flags (global):
  -h, --help       Show this help message
  -v, --version    Print version

Flags (serve):
      --verbose    Set log level to debug for this run
      --quiet      Set log level to warn for this run
      --port <n>   Override listen port (default: 4141)

Flags (init):
  -y, --yes                  Non-interactive mode — use flags + defaults
      --dry-run              Show what would be written; writes nothing
      --port <n>             Proxy port (default: 4141)
      --codex-model <name>   Include this Codex model (repeatable)
      --codex-models <csv>   Comma-separated list of Codex models
      --settings-target <t>  "local" (.claude/settings.local.json, default)
                             or "shared" (.claude/settings.json)

Examples:
  subswitch serve                      # start proxy on port 4141
  subswitch serve --port 8080          # start proxy on a custom port
  subswitch init                       # interactive setup
  subswitch init --yes                 # non-interactive with defaults
  subswitch init --dry-run             # preview what would be written
  subswitch doctor                     # check config + auth health

Environment:
  NO_COLOR      Disable color output (also respected as standard)
  FORCE_COLOR   Force color output even when not a TTY
  CI            Non-interactive detection — init refuses without --yes
```

**Exit codes:**

| Command | Condition | Code |
|---------|-----------|------|
| `serve` | server listening | 0 (kept alive) |
| `serve` | invalid `--port`, EADDRINUSE, config error | 1 |
| `doctor` | all checks pass | 0 |
| `doctor` | any check fails | 1 |
| `init` | success (interactive, non-interactive, or dry-run) | 0 |
| `init` | cancel at any prompt / empty selection / write failure / invalid flag | 1 |
| `init` | non-TTY or CI without `--yes` (fail-closed, zero writes) | 1 |
| unknown command or flag | always | 1 |

`doctor` exits 1 whenever any preflight check fails — use it as a gate in scripts. `init` without `--yes` refuses to write anything when stdin is not a TTY (e.g. in CI) and exits 1 immediately with no filesystem side effects.

**Model flag merging** (`--codex-model` and `--codex-models`): the two flags are additive — use `--codex-model` multiple times to add individual models and/or `--codex-models` to pass a comma-separated list; the results are combined and deduplicated. When `--yes` or the wizard confirms, the merged set becomes `codex.models` in the written config.

### Advanced: manual setup

If you prefer to configure manually instead of using `init`:

**Point Claude Code at subswitch** in your project's `.claude/settings.local.json`
(recommended, gitignored) or `.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:4141"
  }
}
```

Optionally create `subswitch.config.json` in your project root for custom port or
model selection (all fields optional — see
[`subswitch.config.example.json`](subswitch.config.example.json)).

### Run from source

```sh
git clone https://github.com/dean0x/subswitch.git
cd subswitch
npm install
npm run serve      # same as `subswitch serve`
npm run doctor     # same as `subswitch doctor`
```

## Effort control

The optional `effort` frontmatter field works on the Codex leg too. Claude Code
sends it as `output_config.effort`, and subswitch forwards it verbatim as Responses
`reasoning.effort`. The Codex backend accepts `none`, `minimal`, `low`,
`medium`, `high`, `xhigh`, and `max` (Claude Code itself emits the last five); a
value outside that set is dropped with an `unsupported_effort_dropped` warning
and the backend default applies. When effort is forwarded, subswitch logs
`codex_effort_applied`.

## Configuration

Optional configuration goes in `subswitch.config.json` (gitignored). See
[`subswitch.config.example.json`](subswitch.config.example.json) for every knob and its
default.

The config file is located by the following precedence (highest wins):

1. `SUBSWITCH_CONFIG` env var — absolute or `~`-relative path; **missing file is an error**
2. `subswitch.config.json` in the current working directory — silently uses defaults if absent

The routing knob that matters most is **`codex.models`** — the exact model names that
get sent to Codex (everything else passes through to Anthropic). It defaults to
`gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, and `gpt-5.5`. Add the exact
model name to a subagent's `model:` frontmatter to route it; names not in this
list always go to Anthropic.

New knobs added in this release:

| Key | Default | Description |
|-----|---------|-------------|
| `reasoningCache.maxEntries` | `4096` | Maximum number of reasoning cache LRU entries |
| `reasoningCache.maxBytes` | `67108864` (64 MiB) | Maximum total byte footprint of the reasoning cache |
| `limits.maxUpstreamSockets` | `32` | Maximum sockets in the Anthropic keep-alive connection pool |

## How the Codex leg works

- **Auth**: reads `~/.codex/auth.json`, proactively refreshes the OAuth access
  token when it expires within 120 s, and writes back atomically while
  preserving unknown keys. If the Codex CLI rotates tokens concurrently, the
  newer file wins. On a 401 mid-flight, subswitch force-refreshes and retries
  exactly once.
- **Request**: Anthropic Messages → OpenAI Responses (`system` →
  `instructions`, tools → function tools, `tool_use`/`tool_result` →
  `function_call`/`function_call_output`). Always streams upstream with
  `store: false` and `include: ["reasoning.encrypted_content"]`.
- **Reasoning round-trip**: encrypted reasoning items are held in a bounded
  in-memory LRU keyed by tool `call_id` and re-injected directly before the
  matching `function_call` on the follow-up request. A cache miss degrades
  (logged as `reasoning_cache_miss`) rather than breaks.
- **Response**: Responses SSE is translated to the Anthropic SSE event
  sequence, with pings during upstream silence; non-streaming clients get an
  aggregated JSON message.

## Logging

Structured single-line logs with a closed field set (model, path, route,
status, latency, event/error codes). Token material and request/response
content are unrepresentable in the logger *by type* — nothing sensitive can be
logged. When stderr is a TTY and `NO_COLOR` is unset, level and event tokens
are colorized and a timestamp prefix is added; the key=value structure is
unchanged.

Color behavior is controlled by three environment variables (all standard):
`NO_COLOR` — disable color output; `FORCE_COLOR` — force color even when stderr
is not a TTY (useful in terminals that misreport TTY state); `CI` — also suppresses
color and disables interactive `init` prompts (treated as a non-interactive
environment).

## Testing

```sh
npm run check   # tsc --noEmit + unit + integration (fake upstreams, no network)
```

End-to-end verification against the real CLI and real upstreams:
[`e2e/README.md`](e2e/README.md).

## Known limitations

- `count_tokens` for Codex models is a chars/4 estimate — good enough for
  Claude Code's context bookkeeping, but not exact.
- `max_tokens` is not forwarded: the Codex backend rejects `max_output_tokens`
  with a 400 (verified live). Server-side truncation still maps to
  `stop_reason: "max_tokens"`.
- The Codex backend API is undocumented and can change without notice; unknown
  SSE event types are logged at debug level and ignored.
- Images in tool results are dropped on the Codex leg (logged as
  `image_dropped`).
- One subswitch instance holds the reasoning cache in memory; restarting it
  mid-conversation degrades the next Codex turn to a cache miss.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for prerequisites, quality gates, and
commit conventions. By participating you agree to the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Security

subswitch is a loopback-only proxy that handles subscription credentials. Report
vulnerabilities privately — see [SECURITY.md](SECURITY.md). Do not open a public
issue for security reports.

## License

[MIT](LICENSE) © 2026 dean0x
