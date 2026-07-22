# subroute

[![CI](https://github.com/dean0x/subroute/actions/workflows/ci.yml/badge.svg)](https://github.com/dean0x/subroute/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node 22+](https://img.shields.io/badge/node-22%2B-brightgreen.svg)](https://nodejs.org/)

**Route one Claude Code subagent to a different model — keep everything else on Claude.**

subroute is a local subscription-routing proxy for Claude Code. Give a subagent a
Codex model in its frontmatter (`model: gpt-5.5`) and *that subagent alone* runs
on your **Codex subscription**; your main agent and every other request stay on
your **claude.ai subscription**, untouched. No API keys — subroute forwards the
subscription credential each leg already uses.

## Why this is different

Every other Claude Code proxy is all-or-nothing. `ANTHROPIC_BASE_URL` is a single
global setting, so existing routers point *all* of Claude Code's traffic at one
endpoint and typically swap the model for the entire session — your orchestrator,
your utility calls, everything moves at once.

subroute is the first proxy that splits traffic **per subagent, by model name**:

- Requests whose `model` is one of your configured `gpt-*` models are translated
  and sent to the Codex backend.
- Everything else — the main agent, background `claude-*` utility calls, token
  counting — is relayed to Anthropic as **verbatim bytes**, credentials and all.

So you keep Claude Opus/Sonnet driving the session and delegate a specific
subagent to GPT for a second opinion, a cheaper worker, or a specialized task —
without giving up either subscription and without touching an API key.

```
Claude Code ──► subroute (127.0.0.1:4141)
                  ├─ model ∈ codex.models ──► chatgpt.com Codex backend
                  │    (Anthropic Messages ⇄ OpenAI Responses translation,
                  │     ~/.codex/auth.json OAuth, reasoning round-trip cache)
                  └─ everything else ──────► api.anthropic.com
                       (verbatim byte relay, claude.ai OAuth untouched)
```

Routing is by the request body's `model` field, exact match against
`codex.models`. Unknown models pass through to Anthropic and fail visibly there;
background `claude-*` utility traffic is never misrouted.

## Requirements

- Node 22+
- A claude.ai subscription login in Claude Code (no `ANTHROPIC_API_KEY` set)
- Codex CLI logged in (`codex login` → `~/.codex/auth.json`)

## Quick start

```sh
git clone https://github.com/dean0x/subroute.git
cd subroute
npm install
npm run serve      # starts on 127.0.0.1:4141
npm run doctor     # config + codex auth health (never prints tokens)
```

Wire a project to subroute with `.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:4141"
  }
}
```

Then give a subagent a Codex model in its frontmatter
(see [`e2e/agents/gpt-worker.md`](e2e/agents/gpt-worker.md)):

```yaml
---
name: gpt-worker
model: gpt-5.5
effort: low
---
```

Now that subagent runs on Codex while the rest of the session stays on Claude.

## Effort control

The optional `effort` frontmatter field works on the Codex leg too. Claude Code
sends it as `output_config.effort`, and subroute forwards it verbatim as Responses
`reasoning.effort`. The Codex backend accepts `none`, `minimal`, `low`,
`medium`, `high`, `xhigh`, and `max` (Claude Code itself emits the last five); a
value outside that set is dropped with an `unsupported_effort_dropped` warning
and the backend default applies. When effort is forwarded, subroute logs
`codex_effort_applied`.

## Configuration

Optional configuration goes in `subroute.config.json` (gitignored). See
[`subroute.config.example.json`](subroute.config.example.json) for every knob and its
default.

The config file is located by the following precedence (highest wins):

1. `SUBROUTE_CONFIG` env var — absolute or `~`-relative path; **missing file is an error**
2. `subroute.config.json` in the current working directory — silently uses defaults if absent

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
  newer file wins. On a 401 mid-flight, subroute force-refreshes and retries
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
logged.

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
- One subroute instance holds the reasoning cache in memory; restarting it
  mid-conversation degrades the next Codex turn to a cache miss.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for prerequisites, quality gates, and
commit conventions. By participating you agree to the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Security

subroute is a loopback-only proxy that handles subscription credentials. Report
vulnerabilities privately — see [SECURITY.md](SECURITY.md). Do not open a public
issue for security reports.

## License

[MIT](LICENSE) © 2026 dean0x
