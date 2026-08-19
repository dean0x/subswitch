# subswitch

[![CI](https://github.com/dean0x/subswitch/actions/workflows/ci.yml/badge.svg)](https://github.com/dean0x/subswitch/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node 22+](https://img.shields.io/badge/node-22%2B-brightgreen.svg)](https://nodejs.org/)

**Route Claude Code subagents to a different model - keep everything else on Claude.**

subswitch is a local subscription-routing proxy for Claude Code. Give a subagent a
Codex model in its frontmatter (`model: sol`) and *that subagent alone* runs
on your **Codex subscription**; your main agent and every other request stay on
your **claude.ai subscription**, untouched. No API keys — subswitch forwards the
subscription credential each leg already uses.

## Why this is different

Every other Claude Code proxy is all-or-nothing. `ANTHROPIC_BASE_URL` is a single
global setting, so existing routers point *all* of Claude Code's traffic at one
endpoint and typically swap the model for the entire session — your orchestrator,
your utility calls, everything moves at once.

subswitch is the first proxy that splits traffic **per subagent, by model name**:

- Requests whose `model` resolves to a canonical id in the built-in model
  registry (by exact match, family alias, or custom alias) are translated and
  sent to the Codex backend.
- Everything else — the main agent, background utility calls (token counting,
  context management), all non-matching models — is relayed to Anthropic as
  **verbatim bytes**, credentials and all.

So you keep Claude Opus/Sonnet driving the session and delegate a specific
subagent to GPT for a second opinion, a cheaper worker, or a specialized task —
without giving up either subscription and without touching an API key.

```
Claude Code ──► subswitch (127.0.0.1:4141)
                  ├─ model ∈ registry ─────► chatgpt.com Codex backend
                  │    (Anthropic Messages ⇄ OpenAI Responses translation,
                  │     ~/.codex/auth.json OAuth, reasoning round-trip cache)
                  └─ everything else ──────► api.anthropic.com
                       (verbatim byte relay, claude.ai OAuth untouched)
```

Routing is by the request body's `model` field, resolved against the built-in
model registry (by exact id, family alias, or custom alias). Unresolvable models
pass through to Anthropic; non-matching utility traffic is never misrouted.

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
model: sol   # family alias — always the latest sol generation
effort: low  # optional reasoning effort (see Effort control below)
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
  models    Show effective alias table (registry × aliases)
            --json   Output model registry as JSON (no color, no TTY check)

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
      --settings-target <t>  "local" (.claude/settings.local.json, default)
                             or "shared" (.claude/settings.json)

Examples:
  subswitch serve                      # start proxy on port 4141
  subswitch serve --port 8080          # start proxy on a custom port
  subswitch init                       # interactive setup
  subswitch init --yes                 # non-interactive with defaults
  subswitch init --dry-run             # preview what would be written
  subswitch doctor                     # check config + auth health
  subswitch models                     # show alias table (registry × aliases)

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

**An unrecognised key is rejected, not ignored.** Two checks run against the raw file
before it is parsed, and a hit on either is a hard load failure — subswitch prints the
offending key and exits 1 rather than starting:

1. **Keys from an older layout.** A top-level `codex` block or a `codex.models` key is
   rejected with a message naming exactly where each key moved.
2. **Unknown provider ids.** A `providers.<id>` block whose id this build does not ship —
   a typo like `providers.codexx`, or a provider from a future release — is rejected, and
   the message lists the ids that *are* known. Today that is `codex`, so `providers.codex`
   is the only valid block.

This is deliberate, and the reason is the same in both cases: the config schema **strips**
keys it does not recognise instead of reporting them, so the only alternative to failing
the load is a config file that still sits on disk looking correct while the proxy runs
entirely on defaults — custom aliases gone, `baseUrl` silently back to the public
endpoint, `userAgent` back to the built-in value, and your configured provider reported as
absent. A stripping schema can never tell you what it discarded, which is why the check has
to run on the raw file first and why a refusal to start is the better failure.

### Routable set and aliases

The routable set is the **built-in model registry** — `gpt-5.6-sol`,
`gpt-5.6-terra`, `gpt-5.6-luna`, and `gpt-5.5`. It is not configurable: routing
follows the registry so a new model becomes available on upgrade with no config
edit, and everything outside it passes through to Anthropic. Run
`subswitch models --json` for the machine-readable registry.

**Family aliases** (`sol`, `terra`, `luna`) let you write a model name that
auto-tracks the latest generation in that family — `model: sol` always resolves
to whichever `gpt-5.6-sol` (or future `gpt-5.7-sol`) generation is in the registry,
without any config change. Exact canonical ids (`gpt-5.6-sol`) are also accepted
and resolve to themselves. Run `subswitch models` to see the current alias table.

An exact model id always wins over an alias, so a `providers.codex.aliases` entry
can never hijack a real model name. Neither side of an alias entry may be an
Anthropic model name (`claude-*`, `sonnet`, `opus`, `haiku`, `inherit`) — such a
config is rejected at load, because either the key or the target would route your
main agent's traffic to Codex.

### Config reference

Minimal example — only override what you need:

```json
{
  "providers": {
    "codex": {
      "aliases": {
        "fast": "gpt-5.6-sol"
      }
    }
  },
  "limits": {
    "maxInFlightBytes": 1073741824
  }
}
```

All keys and their defaults:

| Key | Default | Description |
|-----|---------|-------------|
| `port` | `4141` | Port the proxy listens on |
| `logLevel` | `"info"` | Log verbosity: `debug`, `info`, `warn`, or `error` |
| `anthropic.baseUrl` | `"https://api.anthropic.com"` | Anthropic passthrough base URL |
| `anthropic.connectTimeoutMs` | `10000` (10 s) | **Anthropic leg only** — TCP connection establishment timeout (see note below) |
| `anthropic.headerTimeoutMs` | `660000` (11 min) | **Anthropic leg only** — time from TCP connect to first response byte; defaults to 60 s above Anthropic's own ~600 s server-side ceiling so the relay never fires before the origin does (the relay's clock starts earlier than the origin's — see note below) |
| `anthropic.streamIdleTimeoutMs` | `300000` (5 min) | Anthropic stream idle timeout (headers→stream-end, reset by every chunk) |
| `anthropic.maxUpstreamSockets` | `256` | **Anthropic leg only** — max sockets in the keep-alive pool (see note below) |
| `anthropic.allowInsecureBaseUrl` | `false` | **Security opt-in** — when false (the default), `subswitch serve` refuses to start if `anthropic.baseUrl` points at a host other than `api.anthropic.com`. Set to `true` only when routing through a trusted proxy in front of Anthropic's API. Loopback addresses are always exempt. |
| `providers.codex.baseUrl` | `"https://chatgpt.com/backend-api/codex"` | Codex backend base URL — override to route subswitch through the wire recorder |
| `providers.codex.oauthTokenUrl` | `"https://auth.openai.com/oauth/token"` | Token refresh endpoint for the Codex OAuth flow |
| `providers.codex.authFile` | `"~/.codex/auth.json"` | Path to the Codex credential file written by `codex login` |
| `providers.codex.userAgent` | `"codex_cli_rs/0.144.6"` | User-agent string sent on Codex leg requests |
| `providers.codex.aliases` | `{}` | Custom alias overrides — map a short name to a canonical model id. Wins over derived family aliases; loses to exact registry ids. |
| `providers.codex.reasoningCache.maxEntries` | `4096` | Maximum LRU entries in the reasoning round-trip cache |
| `providers.codex.reasoningCache.maxBytes` | `67108864` (64 MiB) | Maximum total byte footprint of the reasoning cache |
| `providers.codex.requestTimeoutMs` | `600000` (10 min) | Wall-clock time limit per Codex request |
| `providers.codex.streamIdleTimeoutMs` | `300000` (5 min) | Codex stream idle timeout — resets on each SSE chunk |
| `providers.codex.maxSseEventBytes` | `4194304` (4 MiB) | Maximum bytes per individual SSE event from the Codex upstream |
| `providers.codex.maxAggregateBytes` | `67108864` (64 MiB) | Maximum total accumulated frame bytes for non-streaming response aggregation; exceeding this returns 502 |
| `providers.codex.allowInsecureBaseUrl` | `false` | **Security opt-in** — when false (the default), `subswitch serve` refuses to start if `providers.codex.baseUrl` or `providers.codex.oauthTokenUrl` points at a host other than `chatgpt.com` or `auth.openai.com`. This prevents credential forwarding to an untrusted host. Set to `true` only when routing through a trusted proxy. Loopback addresses are always exempt. |
| `limits.maxBodyBytes` | `33554432` (32 MiB) | Maximum request body bytes buffered before the routing decision |
| `limits.pingIntervalMs` | `15000` (15 s) | Interval between SSE ping frames sent to clients during long Codex streams |
| `limits.maxInFlightBytes` | `2147483648` (2 GiB) | Total budget for simultaneous in-flight request bodies in bytes. Requests that would exceed the budget are **queued** (not rejected) until space opens; queuing is FIFO so no request starves. A single request larger than the budget is still admitted when the server is idle (single-request progress). The budget rarely fires under normal load (~100 concurrent × a few MB each ≈ 300 MB). Worst case at budget: ~6.6 GiB RSS at 3.3× amplification. Chunked `/v1/messages` requests reserve `maxBodyBytes` (32 MiB) during body buffering only; the reservation is reconciled to the actual size once the body is read. |
| `limits.maxQueueDepth` | `1000` | Maximum requests that may wait in the admission queue simultaneously. When this bound is exceeded the server returns HTTP **529 overloaded_error** — the correct Anthropic status for overload. |
| `limits.maxQueueWaitMs` | `60000` (60 s) | Maximum time a queued request will wait for a budget slot before receiving HTTP 529 overloaded_error. |
| `limits.maxConcurrentRequests` | `32` | **Deprecated** — superseded by `maxInFlightBytes`. Kept in the schema so existing config files do not error. The value is no longer used by the admission gate; replace with `maxInFlightBytes`. |

> **Why `connectTimeoutMs`, `headerTimeoutMs`, and `maxUpstreamSockets` are Anthropic-leg-only**: the
> Anthropic passthrough uses a node:http agent with an explicit keep-alive pool, so
> all three knobs have meaningful effect there. The Codex leg uses Node's global `fetch`
> (undici's global dispatcher), which these knobs do not control — shipping them as
> per-provider keys would be config that bounds nothing on the Codex side.

### `subswitch models --json`

`subswitch models --json` outputs a single JSON object describing the full model registry
and alias resolution under the current config. It is the machine-readable counterpart to
the human-readable `subswitch models` table.

```
subswitch models --json | jq .models[].id
```

**Schema** (`schemaVersion: 1`):

```json
{
  "kind": "models",
  "schemaVersion": 1,
  "subswitchVersion": "0.1.0",
  "name": "subswitch",
  "fallbackProvider": "anthropic",
  "configPath": "/path/to/subswitch.config.json",
  "configFileFound": false,
  "providers": [
    { "id": "anthropic", "displayName": "Anthropic", "routing": "passthrough" },
    { "id": "codex", "displayName": "Codex", "routing": "registry" }
  ],
  "models": [
    {
      "id": "gpt-5.6-sol",
      "provider": "codex",
      "aliases": [{ "name": "sol", "source": "derived" }],
      "family": "sol",
      "gen": [5, 6],
      "routable": true,
      "preview": false,
      "retired": false,
      "source": "registry"
    }
  ]
}
```

**Field notes**:

- `schemaVersion` is an integer that bumps on any breaking change to this structure.
  Consumers must check `schemaVersion === 1` before reading other fields.
- `gen` is an integer tuple (`[5, 6]`), not a string (`"5.6"`). String comparison sorts
  `"5.10"` before `"5.9"` — the tuple is the correct form for numeric comparison.
  `gen` is omitted when the generation is unknown; it is always present for registry entries.
- `preview` and `retired` are always-present booleans — no `?? false` needed in consumers.
- `family` is omitted for models with no family alias (e.g. `gpt-5.5`).
- Anthropic appears in `providers` with zero model rows. subswitch cannot enumerate Claude
  model names — it prefix-matches them and relays verbatim — so including a fabricated list
  would be a lie that consumers might cache. The `fallbackProvider: "anthropic"` field
  identifies where everything unresolved goes.
- `aliases[].source` is `"derived"` for family aliases computed from the registry, or
  `"config"` for entries you wrote in `providers.codex.aliases`.

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

## `x-subswitch-synthesized`

Every HTTP response that subswitch generates itself — rather than proxying
verbatim from an upstream — carries the response header:

```
x-subswitch-synthesized: 1
```

This header is present on:

- **Anthropic-leg relay errors**: 502 (upstream connection failure), 504
  (upstream timeout), 413 (request body too large), 529 (concurrency gate),
  500 (internal proxy error).
- **Codex-leg responses**: every byte returned on the codex leg is synthesized
  by the relay (it translates OpenAI Responses format → Anthropic Messages
  format), so the header is present on both streaming and non-streaming codex
  responses, and on all codex-leg error responses.
- **Relay management endpoints**: `/__subswitch/health`, `/__subswitch/404`,
  and all other relay-internal routes.

The header is **absent** on responses proxied verbatim from the Anthropic
origin — including upstream errors (429 rate-limit, 529 overloaded, 500
upstream internal error, etc.).  The header is also **stripped** from any
upstream response that carries it, so the marker is authoritative: its presence
means the relay synthesised the response; its absence means the upstream did.

Operators can use this header in load-balancer health rules, log filters, or
alerting to distinguish relay faults from upstream outages.

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
- The wire recorder (`e2e/capture/codex-recorder.ts`) silently degrades to
  pass-through when run against the live Codex backend: the production
  `/responses` stream carries no `content-type` header, so the recorder's SSE
  detection never fires and it records zero events and no usage — with no error
  and no warning. The recorder works correctly only against local fixture
  upstreams, which do set the header. Anyone repeating the live-capture workflow
  with the checked-in recorder will get an empty capture and may wrongly conclude
  the stream is broken.

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
