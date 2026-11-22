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
- **Claude Code → Together AI (paid, opt-in per model):** `together:<model-id>` names
  are translated to Together Chat Completions and billed to your own Together API key.
  Claude Code is the only supported client for this route; the Codex client integration
  does not route to Together. See [Together AI (paid API key)](#together-ai-paid-api-key).
- **Claude Code → Kimi Code (opt-in):** with a `providers.kimi` block in your user
  configuration, Kimi model names go to the Kimi coding Messages API with the sign-in of
  your Kimi CLI. Claude Code is the only supported client for this route; the Codex
  client integration does not route to Kimi. See [Kimi Code](#kimi-code-kimi-cli-sign-in).
- **Codex → Claude:** registered Claude models and aliases are translated to
  Messages. OpenAI models continue to OpenAI. Reverse-enabled sessions adapt the
  collaboration namespace so cross-provider task messages are readable.

Default routing does not switch models or billing modes after a failure.
Opt-in explicit routes can select another subscription profile before response commitment.
Unknown models retain their originating provider's fallback behavior, except that an unregistered
`claude-*` or `claude:*` name sent by Codex is refused rather than forwarded to OpenAI. Native
settings and client binaries are not patched or downgraded.

```
Claude Code ──► SubSwitch ──► OpenAI for selected OpenAI models
                         ├─► Together for together: models (your paid key)
                         ├─► Kimi for Kimi models (with the opt-in block)
                         └─► Anthropic for other requests

Codex ───────► SubSwitch ──► Anthropic for selected Claude models
                         └─► OpenAI for other requests
```

## Requirements

- Node 22.15 or newer within Node 22, or Node 24+ (native zstd support); Node 23 is unsupported
- A claude.ai subscription login in Claude Code (no `ANTHROPIC_API_KEY` set)
- Codex CLI logged in (`codex login` → `~/.codex/auth.json`)
- Optional, for the paid Together AI route only: your own Together API key

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
model: sol   # newest Sol generation registered in your installed SubSwitch
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
  stop      Stop a verified local relay
  service install     Install the macOS login service
  service uninstall   Remove the macOS login service
  doctor    Check config, subscription auth, and network reachability
  init      Interactive setup — wires the selected client(s)
  models    Show effective alias table (registry × aliases)
            --json   Output model registry as JSON (no color, no TTY check)
            --schema-version 3 --client <client> --json   Common route discovery
  limits    Show recorded upstream limit/error formats (--json, --port <n>)
  run-action --client <client> [--conversation <id>] -- <native command>
            Scope one native invocation, including its tools and children

Flags (global):
  -h, --help       Show this help message
  -v, --version    Print version

Flags (serve):
      --verbose    Set log level to debug for this run
      --quiet      Set log level to warn for this run
      --port <n>   Override listen port (default: 4141)
      --detach     Start the proxy in its own session and print its PID

Flags (stop):
      --port <n>   Select the relay port (default: user config port or 4141)
      --by <label> Add a label to the stop request (1 to 32 lowercase letters,
                   digits, dots, underscores or dashes)

Flags (service install):
      --port <n>       Override the config port
      --config <path>  Use an absolute config path instead of the user config

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
  SUBSWITCH_LIMIT_RECORDING=0   Disable private limit observations (enabled by default)
  SUBSWITCH_LIMIT_DIR           Override private observation root directory

```

**Exit codes:**

| Command | Condition | Code |
|---------|-----------|------|
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
| `doctor` | all checks pass | 0 |
| `doctor` | any check fails | 1 |
| `init` | success (interactive, non-interactive, or dry-run) | 0 |
| `init` | cancel at any prompt / empty selection / write failure / invalid flag | 1 |
| `init` | non-TTY or CI without `--yes` (fail-closed, zero writes) | 1 |
| unknown command or flag | always | 1 |

`doctor` exits 1 whenever any preflight check fails — use it as a gate in scripts. `init` without `--yes` refuses to write anything when stdin is not a TTY (e.g. in CI) and exits 1 immediately with no filesystem side effects.

### Start a relay in its own session

On macOS and Linux, use `subswitch serve --detach` to start a relay in its own session.
It can stay active after its launcher exits.
Use `--port` to select the port. Without `--port`, detach ignores the project config port.
The child uses the caller's current folder and can load other permitted project settings.

For a new child, the launcher checks that the record and `GET /__subswitch/health`
identify that child. The check uses the relay name, PID and nonce.
The launcher returns a PID only if that process is still active.
If another verified relay starts first, the command can return that relay's PID.
On success with a verified relay, stdout contains only the PID and a newline.
If the version differs, stderr also shows a notice.
For a legacy relay, stderr asks you to restart it to get the PID.

On failure, stderr shows one of the reason codes above or a CLI error message.
After a child exit, stderr can also show one sanitized line from `boot.log`.
After `not_ready`, the child can stay active.
The launcher sets `SUBSWITCH_MANAGED_BY=detach` for the child.
For `serve` without `--detach`, leave this variable unset for foreground use.
`detach` is the only value that `serve` accepts for this variable.

See [Relay files and exit events](#relay-files-and-exit-events) for the record and logs.

### Recording real request limits

`serve` automatically saves private, sanitized observations of upstream HTTP errors,
SSE errors and native WebSocket errors. View the latest records with:

```sh
subswitch limits --json
subswitch limits --json --port 8080
```

Records live under `~/.cache/subswitch/limits/<port>/` (four files, at most 8 MiB per
port). They include provider/access product, available target/attempt metadata,
status, validated retry/reset headers and the sanitized JSON structure. Known public
error codes and known limit-message prefixes are retained. Arbitrary strings,
unknown field names, prompts, tool contents and credentials are omitted; unknown
string codes receive a fingerprint. No raw body archive is created.

Set `SUBSWITCH_LIMIT_DIR` to choose the storage root or
`SUBSWITCH_LIMIT_RECORDING=0` to disable recording. Files use owner-only permissions.
Observation does not change provider responses, trigger retries or authorize paid
fallback. Unknown formats remain unknown until their contract is verified.

Body capture is capped at 64 KiB. Oversized, truncated or undecodable errors are
marked explicitly. Compressed HTTP error bodies are decoded within that cap;
compressed native SSE and raw compressed WebSocket messages are not inspected.
A native WebSocket coverage gap produces `limit_observation_partial`. Recording
covers traffic through the relay; direct native-client traffic is outside its view.
Programmatic servers can opt in by supplying a logger from `withLimitRecorder`.

Automatic subscription re-entry applies to explicit routes on a subsequent eligible
action, using one ordinary request to check recovery. Active fallback actions remain
pinned. It does not restart an interrupted response, rerun completed tools, retry a
finished invocation indefinitely, or restore relay state after a restart.

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
A project file can not set sign-in addresses, credential files or `allowInsecureBaseUrl`
opt-ins. The example file also lists these keys. Set them in the user config (see
[Configuration](#configuration)).

### Run from source

```sh
git clone https://github.com/dean0x/subswitch.git
cd subswitch
npm install
npm run serve      # same as `subswitch serve`
npm run doctor     # same as `subswitch doctor`
```

## Together AI (paid API key)

> **This route costs money.** Together AI bills each request per token to your own
> Together API key. It is the only paid destination in SubSwitch. SubSwitch uses it only
> when a request names a `together:` model; all other traffic stays on your subscriptions.

Claude Code is the only supported client for this route. The Codex client integration
does not route to Together. This section describes the configured behavior; a live
check against the Together API is not done yet.

Set the model of a Claude Code subagent to `together:<model-id>`:

```yaml
---
name: together-worker
model: together:<model-id>   # replace with a Together model ID available to your account
---
```

- Only `together:<model-id>` names route to Together in this version. SubSwitch registers
  no Together model IDs, so a bare Together ID does not route to Together.
  `subswitch models` shows the `together:<model-id>` pass-through line with the output cap.
- The ID must start with a letter or digit, use only letters, digits and `. _ / : -`, and
  have at most 200 characters. Any other name after `together:` gets a local 400
  (`Invalid model id after the together: qualifier.`). Nothing goes upstream.
- SubSwitch translates the request to Together Chat Completions
  (`<baseUrl>/chat/completions`) and translates the reply back to Anthropic Messages.
  It makes one attempt per request and does not retry. `count_tokens` gets a local
  estimate and makes no upstream call.

### Together key

SubSwitch reads the key from one of two sources:

1. `TOGETHER_API_KEY` in the environment of `subswitch serve`.
2. On macOS only, when `TOGETHER_API_KEY` is not set: the Keychain item with service
   `Subswitch Together API key` and account `subswitch`.

Add the Keychain item with this command. Keep `-w` last with no value: `security` then
prompts for the key, so the key stays out of your shell history and the process list.
Never type the key on the command line.

```sh
security add-generic-password -s "Subswitch Together API key" -a subswitch -w
```

- Set `TOGETHER_API_KEY` only in the environment that starts `subswitch serve`. Do not
  put it in Claude Code settings or in a shell profile that Claude Code and its tools
  also load. `subswitch run-action` removes `TOGETHER_API_KEY` from the environment of
  the native client that it starts.
- When `TOGETHER_API_KEY` is set, SubSwitch uses it and does not read the Keychain, even
  when the value is malformed.
- SubSwitch reads the key once, on the first Together request, and keeps it in process
  memory until `subswitch serve` stops. Restart the proxy after you change the key.
  The Keychain read has a 10 s limit. A failed read is not kept: the next Together
  request tries again, so macOS can ask again.
- The key goes only to the Together host, as `authorization: Bearer <key>`. Client
  credentials and client headers never go to Together. The key is not in logs, error
  bodies, `doctor` output, `models --json` or `/__subswitch/health`.
- A missing or malformed key gives a local 401 (`Together key is missing.` or
  `Together key is malformed.`, then the env var and Keychain item names). SubSwitch
  sends no upstream request and does not fall back to Anthropic. A key is malformed
  when it has fewer than 16 or more than 512 characters, or any whitespace, control or
  non-ASCII character. One trailing newline is removed.
- `subswitch doctor` reads the key and shows only its source: `OK (env)` or
  `OK (keychain)`. It fails when a `providers.together` block or a Together agent pin
  exists and no usable key is found. `subswitch models` and the health endpoint never
  read the Keychain.

### Together spend

Together has no budgets and no per-key spend caps, and SubSwitch has no spend counter.

- Use a small prepaid balance and turn auto-recharge off. A prepaid account stops at a
  zero balance, but Together meters usage with a delay, so spend can overshoot the
  balance.
- `providers.together.outputCap` (default `16384` tokens) bounds output only. SubSwitch
  sends the smaller of the request `max_tokens` and the cap (the cap when the request has
  none), and logs `output_cap_clamped` when it lowers the value. Nothing in SubSwitch
  bounds input tokens; only the model's context window does.
- Worst case, with per-token prices from Together's pricing page for the model:

  ```
  worst-case cost = requests × (input tokens × input price + outputCap × output price)
  ```

  Count every request. A Claude Code agent sends one request per model turn, and each
  tool call adds a turn. Use the largest input that you expect, up to the model's
  context window.
- When the balance is too low, Together returns 402. SubSwitch then returns a 402 with
  `Together account balance is insufficient. Add funds before you retry.` and
  `x-should-retry: false`, so the client does not retry. After a top-up, Together can
  continue to return 402 for up to 5 minutes.
- An upstream 504 or 524, and the SubSwitch timeout 504, also send `x-should-retry: false`.

### Together data

Each Together request sends the conversation to Together: the system prompt, the
messages, the tool definitions, the tool results (which can hold the contents of files
that tools read) and images. Together's terms and data policies apply to this data.
Together thinking is not shown to the client. SubSwitch keeps the reasoning of a turn in
process memory and sends it back to Together on the next request of the same
conversation. Reasoning above the per-turn bound (`reasoningCache.maxTurnBytes`, 1 MiB by
default), or in a request that SubSwitch cannot link to a conversation, is not kept and
is not sent back.

### Together local access

SubSwitch listens on `127.0.0.1` and has no local token. **Any local process on this
machine can send a `together:` request to the proxy, and SubSwitch sends that request to
Together with your key.** The [`Host`/`Origin` gate](#loopback-hostorigin-gate) stops web
pages, not local processes. Keep the Together balance small, and stop `subswitch serve`
when you do not use Together.

### Together configuration

The whole `providers.together` block loads only from the user configuration
(`$XDG_CONFIG_HOME/subswitch/config.json`, default `~/.config/subswitch/config.json`) or
from the file that `SUBSWITCH_CONFIG` names. A project `subswitch.config.json` that sets
`providers.together`, even to `{}` or `null`, fails at load. Do not copy the
`providers.together` block of the example config into a project file. The block is
optional; without it the defaults apply.

```json
{
  "providers": {
    "together": {
      "outputCap": 8192
    }
  }
}
```

`providers.together.baseUrl` defaults to `https://api.together.ai/v1`. With
`providers.together.allowInsecureBaseUrl: true`, SubSwitch also accepts
`api-inference.together.ai` and `us-api.together.ai` on the default HTTPS port, and no
other host. Together charges more for the US-only host `us-api.together.ai`.
`api.together.xyz` and every other host stop `subswitch serve` at startup. Loopback URLs
are always accepted, for tests. A URL with userinfo, a query or a fragment fails at load.
The [config reference](#config-reference) lists every `providers.together` key.

A workspace file can name a `together:` model, for example in a project
`.claude/agents/*.md` file or a project Claude Code settings file. When a key is
available, those requests spend your Together balance and send the conversation to
Together. Before you use Claude Code in a cloned repository, check its agent files and
settings for `together:` models. `subswitch doctor` lists a Together agent pin only when
no usable key is found.

## Kimi Code (Kimi CLI sign-in)

> **The Kimi route is off by default.** SubSwitch sends a request to Kimi only when your
> user configuration has a `providers.kimi` block and the request names a Kimi model.
> Without the block, a Kimi model name gets a local 400 (`Kimi is not turned on. ...`),
> and SubSwitch reads no Kimi file and sends nothing.

Claude Code is the only supported client for this route. The Codex client integration
does not route to Kimi. The Kimi route works on macOS and Linux. This section describes
the configured behavior. The tests use simulated Kimi servers only; a live check against
Kimi is not done yet.

1. Sign in with `kimi login` in your own Terminal. For the mainland China region, use
   `kimi login --region mainland-cn`. SubSwitch supports the files of Kimi CLI versions
   0.38.0 to 2.7.2.
2. Add the block to your user configuration (`~/.config/subswitch/config.json`), then
   restart `subswitch serve`:

   ```json
   {
     "providers": {
       "kimi": {}
     }
   }
   ```

3. Set the model of a Claude Code subagent to a Kimi model, for example
   `model: kimi-for-coding`.

Without the block, the `kimi` row of the serve banner ends in `(not turned on)`, and the
`kimi auth:` row of `subswitch doctor` shows `not turned on`. With the block, the banner
row shows the Kimi host.

### Kimi sign-in

- SubSwitch never runs the Kimi CLI and never starts a sign-in. It reads the sign-in file
  that the Kimi CLI writes for the region, under `~/.kimi-code/credentials/`.
- SubSwitch renews the sign-in when the Kimi CLI does: when less than 300 s, or less than
  half of the token life, is left. It also renews once after Kimi refuses an access token
  (401), then sends the request once more. Each renewal runs under the Kimi CLI lock in
  `~/.kimi-code/oauth/`, and SubSwitch writes the new sign-in back to the same file, with
  every key of the file. So the Kimi CLI and SubSwitch can share one sign-in.
- SubSwitch keeps a small renewal record beside the lock (a file that ends in
  `.subswitch-renewal.json`). A renewal that may have reached Kimi is not sent again. When
  the sign-in ends, SubSwitch returns a local 401 that tells you to run `kimi login`.
- The sign-in file and its folders must be private to your user: mode 0700 on the folders,
  mode 0600 on the file, owned by you, with no links. A folder above them must not be open
  to writes by other users. Otherwise SubSwitch refuses the file with a local 401.
- SubSwitch does not read `KIMI_CODE_HOME`. If you set it for the Kimi CLI, set
  `providers.kimi.authFile` to the sign-in file in that folder.
- The Kimi token goes only to the Kimi hosts of the region. Client headers and client
  credentials never go to Kimi. Kimi gets the name and version of SubSwitch and a random
  device id that is new for each process. Redirects from Kimi are refused. The token is
  not in logs, error bodies, `doctor` output, `models --json` or the health endpoint.
- `subswitch doctor` reads the file with the same checks and shows the expiry and whether a
  renewal is due. It never renews and takes no lock.

### Kimi models

- The Kimi models are `k3.1-pro`, `k3.1-pro-highspeed`, `k3`, `k3-256k`,
  `kimi-for-coding` and `kimi-for-coding-highspeed`. The Kimi Code docs list these models.
  They are not live-verified on this route.
- A Kimi model routes by its exact id, by `kimi:<id>`, or by a `providers.kimi.aliases`
  entry. Kimi models have no family alias.
- SubSwitch sends the request to `<baseUrl>/messages?beta=true`. `count_tokens` gets a
  local estimate and makes no Kimi call.
- Thinking blocks in the client history are not sent to Kimi, because their signatures
  belong to another service. Kimi thinking is not shown to the client. SubSwitch keeps the
  Kimi thinking of a tool turn in process memory and sends it back only to Kimi.

### Kimi failures (no fallback)

A Kimi failure gives a fixed local error: an error status from Kimi, an error in the
stream, a refused connection or a sign-in problem. SubSwitch does not send the request to
Anthropic or to another provider, and it does not retry, except for the one renewal after
a 401.

### Kimi data

Each Kimi request sends the conversation to Kimi: the system prompt, the messages, the tool
definitions, the tool results (which can hold the contents of files that tools read) and
images. Kimi's terms and data policies apply to this data.

### Kimi configuration

The whole `providers.kimi` block loads only from the user configuration or from the file
that `SUBSWITCH_CONFIG` names. A project `subswitch.config.json` that sets
`providers.kimi`, even to `{}` or `null`, fails at load.

- `providers.kimi.region` is `global` (the default: `api.kimi.ai` and `auth.kimi.ai`) or
  `mainland-cn` (`api.kimi.com` and `auth.kimi.com`). The region selects the Kimi hosts
  and the Kimi CLI sign-in file.
- `baseUrl` and `oauthTokenUrl` must use the HTTPS host of the region on the default port.
  `authFile` must end in `credentials/<file of the region>`. Any other value fails at load.
  The Kimi block has no `allowInsecureBaseUrl` key. A loopback URL loads, but it stops
  `subswitch serve` at startup.
- The [config reference](#config-reference) lists every `providers.kimi` key.

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
Permitted project settings merge over this fallback; explicit `SUBSWITCH_CONFIG`
remains authoritative. Profiles, routes, sign-in addresses, credential files and
`allowInsecureBaseUrl` opt-ins require the user file or an explicit file.
Start the proxy before launching Codex. Existing custom
providers are not replaced. A custom upstream is preserved only when it is loopback or
you have explicitly set `codexIngress.allowInsecureBaseUrl: true` in the SubSwitch user
config or the `SUBSWITCH_CONFIG` file.
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

Use `sonnet`, `opus`, `fable`, `haiku`, or a listed canonical Claude ID. Custom aliases live
under `codexIngress.claude.aliases`. Canonical IDs retain precedence, and family
aliases select the newest registered generation, as in the forward resolver.
Custom targets outside the registry can route but do not gain invented native
capability metadata; doctor flags them for review. Model registration does not override provider
account availability. Native model discovery preserves OpenAI's catalog and adds
Claude entries. API-authenticated native Codex traffic retains its API endpoint;
translated Claude inference uses the configured subscription, with no billing fallback.

| Canonical ID | Alias | Rejects effort `none` | Forced tool choice | Default effort |
| --- | --- | --- | --- | --- |
| `claude-sonnet-5-5` | `sonnet` | yes | no | `high` |
| `claude-haiku-5-5` | `haiku` | no | yes | `medium` |
| `claude-sonnet-5` | — | no | yes | `high` |
| `claude-opus-5` | — | no | yes | `high` |
| `claude-opus-5-5` | `opus` | yes | no | `medium` |
| `claude-fable-5` | — | yes | yes | `high` |
| `claude-fable-5-1` | — | yes | no | `high` |
| `claude-fable-5-2` | `fable` | yes | no | `high` |

`sonnet` resolves to Sonnet 5.5, `opus` to Opus 5.5, and `fable` to Fable 5.2.
Use an exact ID, such as `claude-sonnet-5`, `claude-opus-5`, or `claude-fable-5-1`, to keep an earlier model.
Sonnet 5.5 rejects disabled thinking;
its upstream `between_tools` setting is not exposed as effort `none`, because it
still permits thinking between tool calls. Native
model discovery advertises each model's default effort, and outgoing `max_tokens` is
capped at the model's output ceiling (128,000 tokens for every model listed). A request
the model cannot honour is refused with a 400 before anything is sent to Claude:

- `reasoning_effort_unsupported_by_model`: effort `none` on a model that always thinks.
  The Codex picker offers only `low` through `max`, so this comes from a hand-written
  `model_reasoning_effort = "none"`.
- `tool_choice_unsupported_by_model`: `required` or a named tool on a model without
  forced tool choice. Use `auto`.
- `unregistered_claude_model`: a `claude-*` (or `claude:*`) name that no registered model
  or alias routes. SubSwitch refuses it rather than forwarding it to OpenAI. To use a
  Claude model before SubSwitch registers it, add an alias that targets it, for example
  `"codexIngress": { "claude": { "aliases": { "sonnet-next": "claude-sonnet-future" } } }`
  (replace the illustrative target with a real model ID available to your account).
  The alias and the target ID then both route. An unregistered target has no capability
  metadata, so SubSwitch neither caps its `max_tokens` nor applies the refusals above.

The reverse path uses the existing Claude Keychain/file credential store and
refreshes it when needed. `codexIngress.claude.configDir` selects a native Claude
configuration directory; if omitted, `CLAUDE_CONFIG_DIR` and then the native default
apply. `codexIngress.claude.authFile` explicitly selects a file-backed store.
Set these two keys in the user config or in a file selected with `SUBSWITCH_CONFIG`.
A project `subswitch.config.json` can not set them.
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

A single-target explicit Claude route to `https://api.anthropic.com` can accept
complete native Messages history from before proxy startup, after a restart, or after
cache eviction. Signed blocks reach Anthropic unchanged for validation. An active
cold import reserves its signatures until that attempt completes or releases them.
Emitted signatures retain their provenance through a failed or cancelled response.
SubSwitch records signature ownership only for first-party destinations that validate signatures.
Other destinations get no ownership claim, so replay from another scope fails with 409.
Claude subscription routes with custom endpoints retain exact same-scope continuation after a successful response.
Cross-scope replay returns 409 without an upstream request.
This does not restore translated continuation handles or import signed history into
fallback routes. Later system-role messages remain a separate unsupported case on
explicit Messages routes.

The [2026-10-19 offline record](e2e/gates/native-thinking-continuity-offline-2026-10-19.json)
describes source commit `a1e2471` only. Its hashes and results do not qualify the current
HEAD. The run does not cover `test/integration/native-messages-aggregation.test.ts` or
later replay changes.

## Effort control

The optional `effort` frontmatter field works on the Codex leg too. Claude Code
sends it as `output_config.effort`, and subswitch forwards it as Responses
`reasoning.effort`. The GPT-5.6 models and `gpt-5.5` retain the backend set:
`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max` (Claude Code itself
emits only the last five). The GPT-6 entries register `low`, `medium`, `high`, `xhigh`, and `max`:
`gpt-6.2-sol`, `gpt-6.2-astra`, `gpt-6.1-terra`, `gpt-6.1-sol`, `gpt-6-astra`, `gpt-6-sol`, and `gpt-6-luna`.
The registry excludes `none` and `minimal` for these entries.
The Codex leg drops an unsupported value with an `unsupported_effort_dropped` warning.
The backend default then applies.
Explicit `routes` targets instead reject an unsupported value with `unsupported_effort` at config load.
For a forwarded effort, subswitch logs `codex_effort_applied`.

Sol 6.2 and Astra 6.2 use the Codex effort set.
Their model pages do not confirm `xhigh` or `max` per model.
These two effort sets are not live-verified.

## Configuration

Optional configuration goes in the user config or in a project `subswitch.config.json`
(gitignored). See [`subswitch.config.example.json`](subswitch.config.example.json) for
every knob and its default. Some keys in the example load only from the user config or
an explicit file. The list follows below.

The config file is located by the following precedence (highest wins):

1. `SUBSWITCH_CONFIG` env var — absolute or `~`-relative path; **missing file is an error**
2. Permitted settings from `subswitch.config.json` in the current directory, merged over the user fallback
3. `$XDG_CONFIG_HOME/subswitch/config.json` (default `~/.config/subswitch/config.json`), then built-in defaults.
   SubSwitch uses `XDG_CONFIG_HOME` only when it is an absolute path. A relative or empty value is ignored.

An explicit `SUBSWITCH_CONFIG` file is authoritative and is not merged with the user fallback.
Explicit config paths passed by callers of `loadConfig` also bypass the merge.
`doctor` displays every loaded source, and errors identify source paths.

`accessProfiles`, `routes`, and the whole `providers.together` and `providers.kimi` blocks
load only from the user configuration or an explicit file.
This rule includes each profile's `allowInsecureBaseUrl` value.
A project file that declares any of these keys fails with an error, even for an empty value.
Move those keys to the user file, or select the file with `SUBSWITCH_CONFIG`.
Use `configVersion: 2` for explicit profiles and routes.
The [Wave 1 example](subswitch.wave1.example.json) shows their format.

Sign-in addresses, credential files and the `allowInsecureBaseUrl` opt-ins also load
only from the user configuration or an explicit file. These keys are
`anthropic.baseUrl`, `providers.codex.baseUrl`, `providers.codex.oauthTokenUrl`,
`providers.codex.authFile`, `codexIngress.subscriptionBaseUrl`,
`codexIngress.apiBaseUrl`, `codexIngress.claude.baseUrl`,
`codexIngress.claude.oauthTokenUrl`, `codexIngress.claude.authFile`,
`codexIngress.claude.configDir`, and `allowInsecureBaseUrl` in `anthropic`,
`providers.codex`, `codexIngress` and `codexIngress.claude`. A project file that sets
one of these keys fails with an error that names the key. Set the key in the user file,
or select the file with `SUBSWITCH_CONFIG`.
The example file lists these keys, so do not copy all of it into a project file.

Other project settings retain their merge behavior, except the `run-action` port.
`run-action` uses the user or explicit file's port, then the built-in default.
It does not use the project port to select an existing proxy.
Set the same port in the user file or `SUBSWITCH_CONFIG` when an action must use a custom-port proxy.

**An unrecognised key is rejected, not ignored.** Two checks run against the raw file
before it is parsed, and a hit on either is a hard load failure — subswitch prints the
offending key and exits 1 rather than starting:

1. **Keys from an older layout.** A top-level `codex` block or a `codex.models` key is
   rejected with a message naming exactly where each key moved.
2. **Unknown provider ids.** A `providers.<id>` block whose id this build does not ship —
   a typo like `providers.codexx`, or a provider from a future release — is rejected, and
   the message lists the ids that *are* known. Today those are `codex`, `together` and
   `kimi`, so `providers.codex`, `providers.together` and `providers.kimi` are the only
   valid blocks.

This is deliberate, and the reason is the same in both cases: the config schema **strips**
keys it does not recognise instead of reporting them, so the only alternative to failing
the load is a config file that still sits on disk looking correct while the proxy runs
entirely on defaults — custom aliases gone, `baseUrl` silently back to the public
endpoint, `userAgent` back to the built-in value, and your configured provider reported as
absent. A stripping schema can never tell you what it discarded, which is why the check has
to run on the raw file first and why a refusal to start is the better failure.

### Routable set and aliases

The routable set is the **built-in model registry**:
`gpt-6.2-sol`, `gpt-6.2-astra`, `gpt-6.1-terra`, `gpt-6.1-sol`, `gpt-6-astra`, `gpt-6-sol`,
`gpt-6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna`, plus the six
[Kimi models](#kimi-models). A Kimi model name routes to Kimi only with a `providers.kimi`
block; without it, the name gets a local 400 and does not go to Anthropic. Routing follows
the registry so a new model becomes available on upgrade with no config edit, and
unconfigured names outside it pass through to Anthropic. The registry itself is not
configurable; to reach a Codex model before subswitch registers it, point a
`providers.codex.aliases` entry at its id (`"sol-next": "gpt-future-sol"`, replacing
the illustrative target with a real model ID available to your account). The alias
routes to Codex, as do its declared full target ID and qualified spellings such as
`codex:sol-next` and `codex:gpt-future-sol`. A family override such as
`"sol": "gpt-future-sol"` also applies to `codex:sol`. Exact registered IDs remain
pinned. `doctor` warns that the target is unregistered without failing that check;
the provider still determines model availability and account access. Run
`subswitch models --json` for the machine-readable registry.

**Family aliases** (`astra`, `sol`, `terra`, `luna`) let you write a model name that
tracks the newest stable, non-retired generation registered in your installed
SubSwitch. Upgrading SubSwitch advances these defaults without editing agents.
The proxy does not poll provider catalogs or guess future model IDs at startup.
Config aliases override family defaults, and exact canonical IDs stay pinned.

Defaults verified against the [Codex catalog](https://learn.chatgpt.com/docs/models)
and [Claude catalog](https://platform.claude.com/docs/en/models/overview) on 2026-11-18:

| Client | Agent model | Default upstream model |
| --- | --- | --- |
| Claude Code | `sol` | `gpt-6.2-sol` |
| Claude Code | `astra` | `gpt-6.2-astra` |
| Claude Code | `luna` | `gpt-6-luna` |
| Claude Code | `terra` | `gpt-5.6-terra` |
| Codex (Claude routing enabled) | `sonnet` | `claude-sonnet-5-5` |
| Codex (Claude routing enabled) | `opus` | `claude-opus-5-5` |
| Codex (Claude routing enabled) | `fable` | `claude-fable-5-2` |
| Codex (Claude routing enabled) | `haiku` | `claude-haiku-5-5` |

The date above applies to every row except `terra`.
The `terra` row retains `gpt-5.6-terra`, which was not checked again on 2026-11-18.

The Codex catalog requires Codex CLI 0.159.0 or later for Terra 6.1.
Subswitch sends `codex_cli_rs/0.144.6` as its default user agent.
Access to the new Codex models with this value is not verified.
Set `providers.codex.userAgent` to change this value.
Terra 6.1 stays available by exact ID only because its documented client floor exceeds the default user agent.
The `terra` family default stays on `gpt-5.6-terra`.
Catalog registration does not verify live provider access.

Run `subswitch models --client all` to see both catalogs and effective aliases,
or add `--json` for machine-readable output. Older registered IDs such as
`gpt-6-sol` and `claude-sonnet-5` remain available explicitly.

An exact model id always wins over an alias, so a `providers.codex.aliases` entry
can never hijack a real model name. Neither side of an alias entry may be a
Claude Code model name (`claude-*`, `sonnet`, `opus`, `haiku`, `fable`, `best`,
`inherit`) — such a config is rejected at load, because either the key or the
target would route your main agent's traffic to Codex. `fable` and `best` are
reserved only as the exact word or with a `[...]` suffix, so a name like `bestie`
stays available.

**Retired models.** A model that Codex is shutting down is marked retired in the
registry. It still routes by its exact id, but it no longer wins a family alias,
counts toward the routable set, or appears in the `subswitch models` table.
`models --json` lists it with `retired: true` and `routable: false`, and `doctor`
reports any agent pinned to it as an info finding so you can move it. `gpt-5.5` is
retired: Codex stops serving it on 2026-10-14, after which requests for it fail
upstream.

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
| `providers.together.baseUrl` | `"https://api.together.ai/v1"` | Together AI base URL; requests go to `<baseUrl>/chat/completions`. **User config or `SUBSWITCH_CONFIG` only** — a project file that sets any `providers.together` key fails at load. HTTPS only (HTTP on loopback); no userinfo, query or fragment. |
| `providers.together.allowInsecureBaseUrl` | `false` | **Security opt-in** — when `true`, `subswitch serve` also accepts `api-inference.together.ai` and `us-api.together.ai` on the default HTTPS port. Every other host, `api.together.xyz` included, stops the startup. Loopback addresses are always exempt. |
| `providers.together.aliases` | `{}` | Alias targets must be registered Together model ids. This version registers none, so an alias is rejected with an `alias_rejected` warning; use `together:<model-id>`. |
| `providers.together.outputCap` | `16384` | Maximum `max_tokens` sent to Together per request. Bounds output tokens only, not input tokens or spend. |
| `providers.together.reasoningCache.maxEntries` | `1024` | Maximum LRU entries in the Together reasoning cache |
| `providers.together.reasoningCache.maxBytes` | `16777216` (16 MiB) | Maximum total byte footprint of the Together reasoning cache |
| `providers.together.reasoningCache.maxTurnBytes` | `1048576` (1 MiB) | Maximum reasoning bytes kept for one turn (at most 1 MiB); larger reasoning is not kept |
| `providers.together.requestTimeoutMs` | `600000` (10 min) | Wall-clock time limit per Together request |
| `providers.together.streamIdleTimeoutMs` | `300000` (5 min) | Together stream idle timeout — resets on each SSE chunk |
| `providers.together.maxSseEventBytes` | `4194304` (4 MiB) | Maximum bytes per individual SSE event from Together |
| `providers.together.maxAggregateBytes` | `67108864` (64 MiB) | Maximum total accumulated frame bytes for non-streaming response aggregation; exceeding this returns 502 |
| `providers.kimi` | not set | **Opt-in block.** Without it, Kimi model names get a local 400 and SubSwitch reads no Kimi file. **User config or `SUBSWITCH_CONFIG` only** — a project file that sets any `providers.kimi` key fails at load. |
| `providers.kimi.region` | `"global"` | `global` (`api.kimi.ai`, `auth.kimi.ai`) or `mainland-cn` (`api.kimi.com`, `auth.kimi.com`). Selects the Kimi hosts and the Kimi CLI sign-in file. |
| `providers.kimi.baseUrl` | `"https://api.kimi.ai/coding/v1"` (global), `"https://api.kimi.com/coding/v1"` (mainland-cn) | Kimi coding API base URL; requests go to `<baseUrl>/messages?beta=true`. Must use the HTTPS host of the region on the default port. |
| `providers.kimi.oauthTokenUrl` | `"https://auth.kimi.ai/api/oauth/token"` (global), `"https://auth.kimi.com/api/oauth/token"` (mainland-cn) | Kimi sign-in renewal endpoint. Must use the HTTPS sign-in host of the region on the default port. |
| `providers.kimi.authFile` | `"~/.kimi-code/credentials/kimi-code-env-0e4f99c69cc27850.json"` (global), `"~/.kimi-code/credentials/kimi-code.json"` (mainland-cn) | The Kimi CLI sign-in file. Must be an absolute or `~` path that ends in `credentials/` and the file name of the region. Set it when the Kimi CLI uses `KIMI_CODE_HOME`. |
| `providers.kimi.aliases` | `{}` | Custom aliases — map a short name to a Kimi model id. Exact registry ids win over an alias. |
| `providers.kimi.reasoningCache.maxEntries` | `1024` | Maximum LRU entries in the Kimi thinking cache |
| `providers.kimi.reasoningCache.maxBytes` | `16777216` (16 MiB) | Maximum total byte footprint of the Kimi thinking cache |
| `providers.kimi.reasoningCache.maxTurnBytes` | `1048576` (1 MiB) | Maximum thinking bytes kept for one turn (at most 1 MiB); larger thinking is not kept |
| `providers.kimi.requestTimeoutMs` | `600000` (10 min) | Wall-clock time limit per Kimi request |
| `providers.kimi.streamIdleTimeoutMs` | `300000` (5 min) | Kimi stream idle timeout — resets on each SSE chunk |
| `providers.kimi.maxSseEventBytes` | `4194304` (4 MiB) | Maximum bytes per individual SSE event from Kimi |
| `providers.kimi.maxAggregateBytes` | `67108864` (64 MiB) | Maximum total accumulated frame bytes for non-streaming response aggregation; exceeding this returns 502 |
| `limits.maxBufferedBodyBytes` | `33554432` (32 MiB) | Maximum request body bytes the relay buffers. A larger body is streamed to Anthropic unmodified; on a translated (Codex, Together or Kimi) route it is answered `413 request_too_large`. |
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
> This is deliberate: a relay that invents a 504 for a wedged origin produces a
> status the origin never emitted. A direct connection to api.anthropic.com would hang
> the same way. `server.requestTimeout` (600 s, above) bounds only request _receipt_,
> not the response, so nothing relay-side fires in this case.

### Server connection tuning

subswitch configures its inbound `http.Server` with the following fixed values:

| Property | Value | Rationale |
|----------|-------|-----------|
| `requestTimeout` | `600 000` ms (10 min) | Bounds **receipt of the request only** — it stops once the request body has arrived, so it can never cut short a slow completion or a long stream. On expiry subswitch returns an Anthropic-shaped `408`. |
| `headersTimeout` | `120 000` ms (2 min) | Bounds receipt of the **request headers** only. Same `408` on expiry. |
| `keepAliveTimeout` | `300 000` ms (5 min) | **Deliberately long.** Claude Code's connection pool keeps sockets open for reuse. At Node's default 5 s, an idle socket gets a FIN/RST from subswitch; if that close races an outgoing POST, undici will **not** retry the resulting ECONNRESET for a non-idempotent request. 300 s means sockets outlive any realistic inter-request gap. |
| `maxRequestsPerSocket` | `0` (unlimited) | Prevents connection cycling on long-lived agents |
| `maxHeaderSize` | `65 536` bytes (64 KiB) | Anthropic's own limit; subswitch returns a `431 Request Header Fields Too Large` (Anthropic-shaped) when exceeded |

When a client sends a body larger than `limits.maxBufferedBodyBytes` to a translated
(Codex, Together or Kimi) route, subswitch returns 413 and then **drains the remaining upload bytes** before
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
    { "id": "codex", "displayName": "Codex", "routing": "registry" },
    { "id": "together", "displayName": "Together", "routing": "registry" },
    { "id": "kimi", "displayName": "Kimi", "routing": "registry" }
  ],
  "models": [
    {
      "id": "gpt-6.2-sol",
      "provider": "codex",
      "aliases": [{ "name": "sol", "source": "derived" }],
      "family": "sol",
      "gen": [6, 2],
      "reasoningEfforts": ["low", "medium", "high", "xhigh", "max"],
      "routable": true,
      "preview": false,
      "retired": false,
      "source": "registry"
    },
    {
      "id": "gpt-5.5",
      "provider": "codex",
      "aliases": [],
      "gen": [5, 5],
      "routable": false,
      "preview": false,
      "retired": true,
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
  A retired entry is still listed so consumers can see it, but it reports
  `routable: false` and carries no derived alias; it routes only by its exact id.
- `family` is omitted for models with no family alias (e.g. `gpt-5.5`).
- `reasoningEfforts` is an array of strings, present only when the registry entry
  narrows the accepted Responses effort vocabulary below the backend default
  (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`). Absence means the
  full backend set applies. Every GPT-6 entry declares `low`, `medium`, `high`, `xhigh`, `max`.
- Anthropic appears in `providers` with zero model rows. subswitch cannot enumerate Claude
  model names — it prefix-matches them and relays verbatim — so including a fabricated list
  would be a lie that consumers might cache. The `fallbackProvider: "anthropic"` field
  identifies where everything unresolved goes.
- `aliases[].source` is `"derived"` for family aliases computed from the registry, or
  `"config"` for entries you wrote in `providers.codex.aliases`.

For `--client codex`, version 2 has this shape (model rows are abbreviated):

```json
{"kind":"models","schemaVersion":2,"client":"codex","subswitchVersion":"0.6.0","fallbackProvider":"codex","enabled":true,"models":[{"id":"claude-sonnet-5-5","provider":"claude","registered":true,"aliases":["sonnet"]}]}
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
  route decision. Unresolved models retain OpenAI handling, except unregistered
  `claude-*`/`claude:*` names, which return `unregistered_claude_model`. Operator Codex credential
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

### Relay files and exit events

The relay uses `~/.cache/subswitch/relay/<port>/relay.log` for the active log.
`XDG_CACHE_HOME` does not change this path. The other relay files share this port folder.
The port folder has mode `0700`. The relay creates its files with mode `0600`.
Only the owner can have write access to the folders from the home folder to the port folder.

| File | Contents |
|------|----------|
| `relay.json` | The relay record. The relay publishes it atomically after it binds the port. |
| `relay.log` | The active relay log. Each line starts with an ISO 8601 time and has no color codes. |
| `relay.1.log` to `relay.3.log` | Older logs, from newest to oldest. Normal writes limit each log to 4 MiB. |
| `boot.log` | The detached child's stderr, which includes the ready banner. |

The record fields are `schemaVersion`, `pid`, `port`, `version`, `startedAt`, `managedBy` and `nonce`.
`schemaVersion` is `1`. `managedBy` is `launchd` for a launchd relay and `none` otherwise.
Health returns the same `pid` and `nonce` as the record.
On a stop signal, the relay removes its record before it releases the port.
On a fatal error, the relay removes its record at exit if it has not tried before.
The relay removes the record only if the nonce still matches.

Foreground `serve` writes structured logs to stderr and `relay.log`.
Detached and launchd relays write structured logs only to `relay.log` and keep the ready banner on stderr.
At startup, launchd mode truncates a regular stderr file if it exceeds 256 KiB.
If a line would put the file queue over 256 KiB, the relay drops the line.
The next successful write reports the number of dropped lines.
If the file sink fails, the relay reports the fault once on stderr.

| Exit event | Fields and order |
|------------|------------------|
| `relay_stopped` | Time, PID, exit code and signal for `SIGINT`, `SIGTERM` or `SIGHUP`. |
| `relay_fatal` | Time and PID, with no error message or stack. A fatal error writes this line before `relay_stopped`, which has exit code 1 and no signal. |

Each stop signal consumes `stop-request.json` if present.
A `SIGTERM` stop adds numeric `requesterPid` and `requesterPpid` if the target PID and nonce match.
The request must be at most 40 seconds old at the time of the signal.

Use `relay.log` for exit events. A hard kill does not write an exit line or remove the record.

### `route` field values

The `route` field on `request_complete` and `client_disconnected` events identifies
how the request was dispatched. Valid values:

| Value | When |
|-------|------|
| `anthropic` | Request forwarded to Anthropic verbatim (normal passthrough — unresolved or plain Anthropic model names) |
| `anthropic:ambiguous` | Fail-open forward: two providers claim the same family name; relay forwards to Anthropic and emits `ambiguous_model_name` warn |
| `anthropic:fallback` | Fail-open forward: colon-qualified name whose prefix is not a registered provider; relay forwards to Anthropic and emits `unknown_provider_qualifier` warn |
| `codex:{endpoint}:{model}` | Request routed to the Codex provider leg (e.g. `codex:messages:gpt-5.6-sol`, `codex:count_tokens:gpt-5.6-sol`) |
| `together:{endpoint}:{model}` | Request routed to the paid Together AI leg; `{model}` is the id after the `together:` prefix |
| `kimi:{endpoint}:{model}` | Request routed to the Kimi leg (e.g. `kimi:messages:kimi-for-coding`). Without a `providers.kimi` block, the relay returned a synthesized 400 and sent nothing upstream |
| `invalid_qualified` | Malformed model id after the `together:` prefix; relay returned a synthesized 400 and sent nothing upstream |
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
- **Together-leg responses**: the same rule applies to the Together leg, which
  translates Together Chat Completions → Anthropic Messages.
- **Kimi-leg responses**: the same rule applies to the Kimi leg, which rebuilds the
  Kimi Messages stream before it reaches the client.
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
- The Together AI route is not live-verified. Some Together wire details, such as
  stream usage and `tool_choice` values, are not confirmed. The Together key stays in
  process memory until `subswitch serve` stops, and the output cap does not bound input
  tokens.
- The wire recorder is HTTP-only. It inspects explicit SSE responses and successful
  streamed `POST .../responses` requests whose upstream omits `Content-Type`; other
  missing-header responses remain transparent pass-through.
- The Kimi route is not live-verified. The tests use simulated Kimi servers. A live
  renewal of the Kimi sign-in is also not verified: under the caps of the live check, the
  sign-in may not be due, so that result can stay unknown.
- SubSwitch supports the sign-in files of Kimi CLI versions 0.38.0 to 2.7.2. It refuses
  other file layouts.
- One SubSwitch process supports one Kimi account. The error-text scrub keeps only the
  current and the previous Kimi token.
- SubSwitch cannot detect `KIMI_DISABLE_OAUTH_LOCK` in the Kimi CLI environment. Do not
  set it while SubSwitch uses the same sign-in, because both can then renew at the same
  time and end the sign-in.
- A Kimi home folder made under umask 002 is open to group writes, so SubSwitch refuses
  its sign-in file. Run `chmod g-w` on the folder, or use umask 022 before `kimi login`.
- The Kimi device id is new for each SubSwitch process.
- Kimi has no `accessProfiles` (configVersion 2) routes. Kimi models route only through
  the model registry.
- The Kimi route has no failover, also after the first turn of a conversation. A Kimi
  failure goes back to the client.
- Kimi gets no `anthropic-beta` value. A value is added only after a live check on Kimi.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for prerequisites, quality gates, and
commit conventions. By participating you agree to the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Security

subswitch is a loopback-only proxy that handles subscription credentials and, for the
Together AI route, a paid API key. It has no local token, so any local process can send
requests that spend the Together key; keep the Together balance small (see
[Together local access](#together-local-access)). With a `providers.kimi` block,
SubSwitch also reads and renews the sign-in file of your Kimi CLI (see
[Kimi sign-in](#kimi-sign-in)), and any local process can send Kimi requests that use
your Kimi plan. Report vulnerabilities privately — see [SECURITY.md](SECURITY.md). Do not
open a public issue for security reports.

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
local development. For the same reason, the gate does not stop a local process: any
process on the machine can send a `together:` request that spends your Together key.

## License

[MIT](LICENSE) © 2026 dean0x

### Wave 1 explicit routes

Version 2 access profiles, action-scoped failover, recovery behavior, configuration examples
and current evidence gates are described in [the Wave 1 notes](e2e/gates/wave1.md).
Explicit routes use Claude and Codex subscription sign-ins only.
Each profile uses `native-oauth` and `billing: "subscription"`. Provider keys and paid fallback are not supported.
Fallback between subscription profiles remains available.
See the [evidence manifest](e2e/gates/wave1-evidence.json) for past runs.
