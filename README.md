# subswitch

[![CI](https://github.com/dean0x/subswitch/actions/workflows/ci.yml/badge.svg)](https://github.com/dean0x/subswitch/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node 22.15+ or 24+](https://img.shields.io/badge/node-22.15%2B%20or%2024%2B-brightgreen.svg)](https://nodejs.org/)

**Route native sub-agents between Claude Code and Codex, using your subscriptions.**

SubSwitch is a local protocol bridge. Claude Code can delegate a sub-agent to an
OpenAI model; Codex can delegate a native sub-agent to a Claude model. Routing is
selected by the requested model. The originating client keeps its agents, tools,
permissions, and execution loop.

## Model-based routing

- **Claude Code → Codex:** registered OpenAI models and aliases are translated to
  Responses. Other traffic continues to Anthropic as a raw relay.
- **Codex → Claude:** registered Claude models and aliases are translated to
  Messages. OpenAI models continue to OpenAI. Reverse-enabled sessions adapt the
  collaboration namespace so cross-provider task messages are readable.

SubSwitch does not switch models or billing modes after a failure. Unknown models
retain their originating provider's fallback behavior. Native settings and client
binaries are not patched or downgraded.

```
Claude Code ──► SubSwitch ──► OpenAI for selected OpenAI models
                         └─► Anthropic for other requests

Codex ───────► SubSwitch ──► Anthropic for selected Claude models
                         └─► OpenAI for other requests
```

## Requirements

- Node 22.15 or newer within Node 22, or Node 24+ (native zstd support); Node 23 is unsupported
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
subswitch — local subscription-routing proxy for Claude Code and Codex

Usage: subswitch [command] [flags]

Commands:
  serve     Start the proxy (default command)
  doctor    Check config, subscription auth, and network reachability
  init      Interactive setup — wires the selected client(s)
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

Flags (init, doctor, models):
      --client <client>     "claude-code", "codex", or "all"
                            init/models default to claude-code; doctor defaults to all
                            all selects supported clients; both is a compatibility alias

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

## Codex → Claude

Sign in normally with both clients, then enable the reverse path:

```sh
subswitch init --client codex
subswitch serve
subswitch doctor --client codex
subswitch models --client codex
```

`init --client codex --dry-run` previews changes. Use `--yes` for non-interactive
setup, or `--client all` to configure native Codex and the existing project-level
Claude Code integration together. The default `init` behavior remains Claude Code.
`all` selects every client supported by this build (currently Claude Code and Codex);
`both` remains accepted as a compatibility alias. New clients require their own adapters.

Codex setup changes only the user-level `openai_base_url` value, preserving other
TOML settings and comments. It writes SubSwitch's user config to
`$XDG_CONFIG_HOME/subswitch/config.json` (default `~/.config/subswitch/config.json`).
Project configuration merges over this fallback; explicit `SUBSWITCH_CONFIG`
remains authoritative. Start the proxy before launching Codex. Existing custom
providers are not replaced. A custom upstream is preserved only when it is loopback or
you have explicitly set `codexIngress.allowInsecureBaseUrl: true` in the SubSwitch config.
Setup names an unapproved host and stops before writing files.

Set the model in a native Codex role file, for example `~/.codex/claude-worker.toml`:

```toml
model = "sonnet"
model_reasoning_effort = "medium"
```

Reference that file from native `~/.codex/config.toml` if the role is not already
configured:

```toml
[agents.claude_worker]
description = "Delegate a task to Claude"
config_file = "claude-worker.toml"
```

Use `sonnet`, `opus`, `fable`, or a listed canonical Claude ID. Custom aliases live
under `codexIngress.claude.aliases`. Canonical IDs retain precedence, and family
aliases select the newest registered generation, as in the forward resolver.
Custom targets outside the registry can route but do not gain invented native
capability metadata; doctor flags them for review. Model registration does not override provider
account availability. Native model discovery preserves OpenAI's catalog and adds
Claude entries. API-authenticated native Codex traffic retains its API endpoint;
translated Claude inference uses the configured subscription, with no billing fallback.

The reverse path uses the existing Claude Keychain/file credential store and
refreshes it when needed. `codexIngress.claude.configDir` selects a native Claude
configuration directory; if omitted, `CLAUDE_CONFIG_DIR` and then the native default
apply. `codexIngress.claude.authFile` explicitly selects a file-backed store.
Automatic prompt caching is enabled, with cached-token counts and a short hashed
native thread identifier available in logs. If native Codex omits its bearer token on the local
endpoint, SubSwitch uses its existing Codex credential manager only when the
native account ID matches. Incoming credentials are never reused for Claude.

Claude subscription requests include a native identity system preamble. This
compatibility behavior is explicit; SubSwitch does not forge billing attestations,
rewrite product names in user instructions, or run a second agent runtime. Provider
credential-use policies still apply. See [security](SECURITY.md) and the
[live verification notes](e2e/gates/production-parity.md).

State is process-local in both directions. Durable restart/resume and translated
compaction are tracked in [#45](https://github.com/dean0x/subswitch/issues/45), setup
undo in [#46](https://github.com/dean0x/subswitch/issues/46), explicit API auth for
both translating paths in [#47](https://github.com/dean0x/subswitch/issues/47), and
broader content/tool support in [#48](https://github.com/dean0x/subswitch/issues/48).
These are not included in the parity release. Missing reverse continuation state
produces an explicit error; keep the proxy running during active translated sessions.

## Effort control

The optional `effort` frontmatter field works on the Codex leg too. Claude Code
sends it as `output_config.effort`, and subswitch forwards it as Responses
`reasoning.effort`. Every registered model except Astra retains the backend set:
`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max` (Claude Code itself
emits only the last five). Astra accepts `low`, `medium`, `high`, `xhigh`, and
`max`; its `none` and `minimal` values are dropped. An unsupported value is
dropped with an `unsupported_effort_dropped` warning and the backend default
applies. When effort is forwarded, subswitch logs `codex_effort_applied`.

## Configuration

Optional configuration goes in `subswitch.config.json` (gitignored). See
[`subswitch.config.example.json`](subswitch.config.example.json) for every knob and its
default.

The config file is located by the following precedence (highest wins):

1. `SUBSWITCH_CONFIG` env var — absolute or `~`-relative path; **missing file is an error**
2. `subswitch.config.json` in the current working directory, merged over the user fallback
3. `$XDG_CONFIG_HOME/subswitch/config.json` (default `~/.config/subswitch/config.json`), then built-in defaults

An explicit `SUBSWITCH_CONFIG` file is authoritative and is not merged with the user fallback.
This merge applies to all commands, including forward-only use. `doctor` displays every
loaded source, and errors identify source paths. Explicit config paths passed by callers
of `loadConfig` also bypass the merge.

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

The routable set is the **built-in model registry** — `gpt-6-astra`, `gpt-5.6-sol`,
`gpt-5.6-terra`, `gpt-5.6-luna`, and `gpt-5.5`. It is not configurable: routing
follows the registry so a new model becomes available on upgrade with no config
edit, and everything outside it passes through to Anthropic. Run
`subswitch models --json` for the machine-readable registry.

**Family aliases** (`astra`, `sol`, `terra`, `luna`) let you write a model name that
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
  }
}
```

All keys and their defaults:

| Key | Default | Description |
|-----|---------|-------------|
| `port` | `4141` | Port the proxy listens on |
| `logLevel` | `"info"` | Log verbosity: `debug`, `info`, `warn`, or `error` |
| `anthropic.baseUrl` | `"https://api.anthropic.com"` | Anthropic passthrough base URL |
| `anthropic.connectTimeoutMs` | `10000` (10 s) | **Anthropic leg only** — DNS resolution and TCP connection establishment timeout (see note below) |
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
| `limits.maxBufferedBodyBytes` | `33554432` (32 MiB) | Maximum request body bytes the relay buffers. A larger body is streamed to Anthropic unmodified; on a translated (Codex) route it is answered `413 request_too_large`. |
| `limits.pingIntervalMs` | `15000` (15 s) | Interval between SSE ping frames sent to clients during long Codex streams |
| `codexIngress.enabled` | `false` | Enable the reserved native Codex ingress endpoints. |
| `codexIngress.subscriptionBaseUrl` | `"https://chatgpt.com/backend-api/codex"` | Native Codex subscription upstream. |
| `codexIngress.apiBaseUrl` | `"https://api.openai.com/v1"` | Native OpenAI API upstream; uses client-supplied credentials. |
| `codexIngress.connectTimeoutMs` | `10000` | TCP connection establishment budget only; no TLS, HTTP-header, or WebSocket-handshake deadline. |
| `codexIngress.maxUpstreamSockets` | `256` | Maximum sockets per raw HTTP upstream pool, plus a shared bound for native upstream WebSocket lifetimes. |
| `codexIngress.allowInsecureBaseUrl` | `false` | **Security opt-in** — allow non-default OpenAI upstream hosts or ports only when trusted. Loopback is exempt. |
| `codexIngress.claude.enabled` | `false` | Enable Claude model resolution, translation, discovery, and collaboration namespace adaptation. |
| `codexIngress.claude.baseUrl` | `"https://api.anthropic.com"` | Claude Messages upstream. |
| `codexIngress.claude.oauthTokenUrl` | `"https://platform.claude.com/v1/oauth/token"` | Claude subscription refresh endpoint. |
| `codexIngress.claude.configDir` | `unset` | Native Claude config directory; otherwise uses `CLAUDE_CONFIG_DIR` or `~/.claude`. |
| `codexIngress.claude.authFile` | `unset` | Explicit credential file; otherwise uses the native macOS Keychain or the config directory credential file. |
| `codexIngress.claude.aliases` | `{}` | Custom aliases targeting `claude-*` IDs; cannot claim OpenAI names. Exact canonical IDs retain precedence. |
| `codexIngress.claude.allowInsecureBaseUrl` | `false` | **Security opt-in** — allow trusted non-default Claude inference/refresh hosts or ports. Loopback is exempt. |
| `codexIngress.claude.requestTimeoutMs` | `600000` | Wall-clock limit for each translated Claude request, including refresh and streaming. |
| `codexIngress.claude.streamIdleTimeoutMs` | `300000` | Maximum upstream SSE idle interval; resets when data arrives. |
| `codexIngress.claude.maxSseEventBytes` | `4194304` | Maximum bytes in one Claude SSE event. |
| `codexIngress.claude.maxAggregateBytes` | `67108864` | Maximum accumulated Claude event bytes per response; excess returns a synthesized 502. |
| `codexIngress.claude.reasoningCache.maxEntries` | `4096` | Shared LRU entry ceiling across continuation snapshots, thinking replay, and adapted-response markers. |
| `codexIngress.claude.reasoningCache.maxBytes` | `67108864` | Shared serialized UTF-8 byte ceiling, including cache keys. Oversized entries are not cached; evicted continuation/replay state returns 409. |

> **Transport scope**: `anthropic.*` and `codexIngress.*` transport limits control their
> raw HTTP pools. `codexIngress.maxUpstreamSockets` also bounds the total pending/active
> upstream WebSocket connections until they close; waiting clients acquire a slot when
> one closes. Translating provider requests use `fetch` and their own request/idle limits.

> **Operator caveats for `connectTimeoutMs`**: (1) **No effect on pooled sockets.**
> With `maxUpstreamSockets: 256` and keep-alive on, steady-state traffic reuses
> existing connections — there is no connect phase — so the budget does nothing after
> warm-up. (2) **TLS negotiation is not covered.** On `https://api.anthropic.com`,
> the budget ends when the TCP connection is established (`'connect'` event); the TLS
> handshake occurs after and is not bounded by this knob.

> **BREAKING (0.4.0):** `limits.maxBodyBytes` has been renamed to
> `limits.maxBufferedBodyBytes`. If your config contains `limits.maxBodyBytes`, subswitch
> will refuse to start and print a message naming the replacement key. Rename the key to
> continue. Additionally, the cap no longer applies to Anthropic-bound request bodies:
> a body above the window is now streamed to `api.anthropic.com` verbatim instead of
> being answered with a relay-synthesized `413 request_too_large`, because Anthropic
> enforces its own payload limits with authoritative errors.

> **BREAKING (0.3.0):** Two config keys were removed: `anthropic.streamIdleTimeoutMs`
> and `limits.maxConcurrentRequests`. If your config contains either of these,
> `subswitch` will refuse to start and print a message naming each offending key. Delete
> them from your config to continue. See the
> [0.3.0 changelog](CHANGELOG.md#030---2026-08-19) for details.

> **Behavior when an upstream connects but never responds**: the Anthropic leg has no
> relay-side timer on the response phase. If an upstream accepts the TCP connection and
> request body but then goes silent, the client will receive no response until its own
> timeout fires (measured: `STATUS=000 TOTAL=20s curl_rc=28` with a 20 s curl timeout).
> This is deliberate per ADR-010: a relay that invents a 504 for a wedged origin produces a
> status the origin never emitted. A direct connection to api.anthropic.com would hang
> the same way. `server.requestTimeout` (600 s, above) bounds only request _receipt_,
> not the response, so nothing relay-side fires in this case.

### Server connection tuning

subswitch configures its inbound `http.Server` with the following fixed values:

| Property | Value | Rationale |
|----------|-------|-----------|
| `requestTimeout` | `600 000` ms (10 min) | Bounds **receipt of the request only** — it stops once the request body has arrived, so it can never cut short a slow completion or a long stream. On expiry subswitch returns an Anthropic-shaped `408`. |
| `headersTimeout` | `120 000` ms (2 min) | Bounds receipt of the **request headers** only. Same `408` on expiry. |
| `keepAliveTimeout` | `300 000` ms (5 min) | **Deliberately long.** Claude Code's connection pool keeps sockets open for reuse. At Node's default 5 s, an idle socket gets a FIN/RST from subswitch; if that close races an outgoing POST, undici will **not** retry the resulting ECONNRESET for a non-idempotent request (PF-018). 300 s means sockets outlive any realistic inter-request gap. |
| `maxRequestsPerSocket` | `0` (unlimited) | Prevents connection cycling on long-lived agents |
| `maxHeaderSize` | `65 536` bytes (64 KiB) | Anthropic's own limit; subswitch returns a `431 Request Header Fields Too Large` (Anthropic-shaped) when exceeded |

When a client sends a body larger than `limits.maxBufferedBodyBytes` to a translated
(Codex) route, subswitch returns 413 and then **drains the remaining upload bytes** before
closing the connection. This lets the client read the 413 response; without the drain, the
TCP write-buffer fills and the client's `recv()` never sees the 413 body. For
Anthropic-bound bodies above the window, subswitch streams the body verbatim and Anthropic
enforces its own payload limits with authoritative errors. Note that to route an over-window
body the relay must read enough bytes to identify the model; a client that declares a large
Content-Length and then dribbles data slowly will hold the connection open until
`server.requestTimeout` (10 min) — this is inherent to needing the model name for routing.

### Token counting on the Codex leg

`/v1/messages/count_tokens` requests that route to the Codex leg return an **estimate**
rather than forwarding to Anthropic. This is deliberate: forwarding to Anthropic would
count tokens against a different model's vocabulary and return a misleading count.
The estimate is the least-wrong option available.

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
  Consumers of the default/`--client claude-code` shape must check `schemaVersion === 1` before reading other fields.
  The Codex and combined shapes use version 2 and the `client` discriminator described below.
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

For `--client codex`, version 2 has this shape (model rows are abbreviated):

```json
{"kind":"models","schemaVersion":2,"client":"codex","subswitchVersion":"0.4.0","fallbackProvider":"codex","enabled":true,"models":[{"id":"claude-sonnet-5","provider":"claude","registered":true,"aliases":["sonnet"]}]}
```

For `--client all`, version 2 uses `client: "all"` and a `clients` object:
`{"kind":"models","schemaVersion":2,"client":"all","clients":{"claude-code":<version-1 object>,"codex":<version-2 Codex object>}}`.
Branch on both `schemaVersion` and `client`. Codex rows contain `id`, `provider`,
`registered`, and `aliases`; they do not use the version-1 row schema.

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

## How the Claude reverse leg works

- **Auth:** reads native Claude subscription storage and refreshes a rejected token once.
  Requests include the Claude subscription identity preamble and beta headers. Native
  OpenAI credentials never reach Claude; translated failures never switch billing modes.
- **Routing:** HTTP and WebSocket requests use the same resolved Claude destination and
  route decision. Unresolved models retain OpenAI handling. Operator Codex credential
  substitution is limited to exact `/responses`, `/responses/compact`, and `/models` paths
  in subscription mode and requires a matching native account.
- **Translation:** Responses input becomes Messages history. Text streams incrementally;
  executable tool calls commit only after a valid terminal message. Response protocol
  failures return 502; missing process-local continuation or thinking state returns 409
  with guidance to start a new conversation. Missing relay-side Claude credentials return
  503 with Claude-specific sign-in guidance, avoiding an unrelated native OpenAI login refresh.
- **State:** snapshots, authenticated thinking replay, and collaboration adaptation markers
  share one bounded process-local LRU. Interrupted streams retain an empty replay handle
  so native cancellation notices and readable partial text can continue in the same
  conversation. Unfinished thinking and tool calls are not replayed. Restart or eviction
  makes that state unavailable.
- **Collaboration:** when Claude routing is enabled, native collaboration definitions and
  structured calls are adapted for the whole Codex session, including OpenAI turns. The
  affected message arguments use the explicit plaintext tool contract. Existing opaque
  histories and prompt text remain unchanged; encrypted arguments cannot become executable
  plaintext calls. Disabling Claude routing disables this adaptation.
- **Raw relay:** connection-specific headers, including headers named by `Connection`, are
  stripped on both legs in both directions. Other provider headers and payload bytes survive.
  The `/codex` namespace stays reserved when disabled and returns OpenAI-shaped errors.

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

### `route` field values

The `route` field on `request_complete` and `client_disconnected` events identifies
how the request was dispatched. Valid values:

| Value | When |
|-------|------|
| `anthropic` | Request forwarded to Anthropic verbatim (normal passthrough — unresolved or plain Anthropic model names) |
| `anthropic:ambiguous` | Fail-open forward: two providers claim the same family name; relay forwards to Anthropic and emits `ambiguous_model_name` warn |
| `anthropic:fallback` | Fail-open forward: colon-qualified name whose prefix is not a registered provider; relay forwards to Anthropic and emits `unknown_provider_qualifier` warn |
| `codex:{endpoint}:{model}` | Request routed to the Codex provider leg (e.g. `codex:messages:gpt-5.6-sol`, `codex:count_tokens:gpt-5.6-sol`) |
| `host_rejected` | Request refused by the loopback `Host`/`Origin` gate before routing; relay returned a synthesized 403 |
| `codex_ingress:subscription:passthrough` | Subscription-mode Codex ingress; the gateway may translate a resolved Claude request. |
| `codex_ingress:api:passthrough` | API-mode Codex ingress; the gateway may translate a resolved Claude request. |
| `codex_ingress:unknown` | Reserved `/codex` path not belonging to either supported endpoint base. |
| `internal_error` | Unhandled exception during request handling; relay returned a synthesized 500 |

The `anthropic:ambiguous` and `anthropic:fallback` values both carry the `anthropic` prefix so
leg-level filtering (`route starts with anthropic`) continues to work. Codex ingress
uses the separate `codex_ingress` prefix; its ingress route label is not a destination-provider label. The suffix makes
fail-open forwards distinguishable from intended Anthropic routes in log queries and alerting.

### Log events

| Event | Level | Fields | Notes |
|-------|-------|--------|-------|
| `request_complete` | `info` | path, route, model, status, latencyMs | Emitted once per request that received a response. `model` is omitted when not present in the request body. |
| `client_disconnected` | `info` | path, route, model, latencyMs | Emitted instead of `request_complete` when the client closed the connection before any response headers were sent (e.g. cancelled upload). No `status` field — `res.statusCode` would be Node's 200 initialiser, not a real status. |
| `ambiguous_model_name` | `warn` | model | Two providers claim the same family name. `model` carries the ambiguous name annotated with the provider list: `"name (p1, p2)"`. Request is forwarded to Anthropic (route `anthropic:ambiguous`). |
| `unknown_provider_qualifier` | `warn` | model | Colon-qualified model name whose prefix is not a registered provider. `model` is the full as-requested name (e.g. `"kimee:k2"`). Request is forwarded to Anthropic (route `anthropic:fallback`). |
| `host_rejected` | `warn` | path, errorCode, status | The [loopback `Host`/`Origin` gate](#loopback-hostorigin-gate) refused the request. `errorCode` is the reason (`missing_host`, `foreign_host`, `foreign_origin`) followed by the offending value, lower-cased, restricted to the authority charset and capped at 64 characters. The value appears here and nowhere else — it is never reflected into the response body. |

## `x-subswitch-synthesized`

Every HTTP response that subswitch generates itself — rather than proxying
verbatim from an upstream — carries the response header:

```
x-subswitch-synthesized: 1
```

This header is present on:

- **Anthropic-leg relay errors**: 502 (upstream connection failure), 504
  (upstream connect timeout), 413 (request body too large), 431 (request headers
  too large), 408 (inbound request not fully received within `requestTimeout` /
  `headersTimeout`), 400 (malformed request), 500 (internal proxy error).
- **Codex-leg responses**: every byte returned on the codex leg is synthesized
  by the relay (it translates OpenAI Responses format → Anthropic Messages
  format), so the header is present on both streaming and non-streaming codex
  responses, and on all codex-leg error responses.
- **Relay management endpoints**: `/__subswitch/health` (200 OK), and any
  unrecognized `/__subswitch/*` path (404 — fixed body, path not reflected).

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
- The wire recorder is HTTP-only. It inspects explicit SSE responses and successful
  streamed `POST .../responses` requests whose upstream omits `Content-Type`; other
  missing-header responses remain transparent pass-through.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for prerequisites, quality gates, and
commit conventions. By participating you agree to the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Security

subswitch is a loopback-only proxy that handles subscription credentials. Report
vulnerabilities privately — see [SECURITY.md](SECURITY.md). Do not open a public
issue for security reports.

### Loopback `Host`/`Origin` gate

subswitch listens on `127.0.0.1` and requires no authentication, so reachability is
its only access control — and DNS rebinding defeats reachability. A web page served
from `http://evil.test:4141` whose name resolves to `127.0.0.1` is *same-origin*
with the proxy as far as the browser is concerned: it can send requests **and read
the responses**, including Codex completions billed to your ChatGPT subscription.
The one thing that page cannot change is the `Host` header, which names the domain
the page was loaded from rather than the address it resolved to. So every request
is checked before it is routed: the `Host` must name a loopback address
(`localhost`, `::1`, or any `127.0.0.0/8` address in dotted-quad form), and an
`Origin` header, when present, must be a loopback origin. Anything else is answered
`403` with an Anthropic-shaped `permission_error` body, is never forwarded to an
upstream, and never reaches provider credentials — `/__subswitch/*` included.
Clients that talk to the proxy directly (Claude Code, `curl`) send a loopback
`Host` and no `Origin` at all, so they are unaffected, and a page served from
another loopback port keeps working — the gate stops the cross-site case, not
local development.

## License

[MIT](LICENSE) © 2026 dean0x
