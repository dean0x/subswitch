# croxy end-to-end verification

Manual verification against the real Claude Code CLI and real upstreams.
Run each step in order; every step depends on the previous one working.

## 1. Start the proxy

```sh
npm run serve
```

Expect a `listening` log line for `http://127.0.0.1:4141`.

## 2. Anthropic leg (claude.ai subscription)

```sh
ANTHROPIC_BASE_URL=http://127.0.0.1:4141 claude -p "say hi"
```

Must behave identically to running without the proxy. croxy logs one
`request_complete` line per call with `route=anthropic`. No credential
env vars should be set — the stored claude.ai OAuth login is forwarded
verbatim.

## 3. Codex leg via a subagent

Create a scratch project and copy `agents/gpt-worker.md` into
`.claude/agents/` there:

```sh
mkdir -p /tmp/croxy-e2e/.claude/agents
cp e2e/agents/gpt-worker.md /tmp/croxy-e2e/.claude/agents/
cd /tmp/croxy-e2e
ANTHROPIC_BASE_URL=http://127.0.0.1:4141 claude -p "Use the gpt-worker agent to list files here and summarize"
```

This exercises, in one run:
- the Codex leg (`model: gpt-5.5` from the agent frontmatter routes to chatgpt.com),
- multi-turn tool calling — the second Codex request must carry the cached
  encrypted reasoning item (watch for `reasoning_cache_miss` warnings in the
  croxy log; there should be none),
- concurrent `claude-*` utility traffic on the Anthropic leg.

## 4. Per-project wiring (the deliverable)

In any project that should use croxy, add `.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:4141"
  }
}
```

No credential variables — the subscription OAuth flows through. Projects
without this setting are completely unaffected.

## Codex wire capture

A dev-only recorder tool that sits transparently between croxy and the real
Codex backend, printing the wire shape of every request and response to
stdout. Credential values are **never** printed — headers like
`authorization`, `cookie`, and `openai-sentinel-*` are replaced with a
structural fingerprint: `<len:N,sha8:XXXXXXXX>`. All other string values in
JSON bodies are replaced with `<len:N>`.

### How to run

In one terminal start the recorder:

```sh
npx tsx e2e/capture/codex-recorder.ts
```

It listens on `http://127.0.0.1:4142` and by default forwards to
`https://chatgpt.com/backend-api/codex`. Override the upstream with the
`CODEX_RECORDER_UPSTREAM` environment variable:

```sh
CODEX_RECORDER_UPSTREAM=https://chatgpt.com/backend-api/codex \
  npx tsx e2e/capture/codex-recorder.ts
```

### Routing croxy through the recorder

Edit (or create) `croxy.config.json` and set `codex.baseUrl` to point at the
recorder instead of directly to Codex:

```json
{
  "codex": {
    "baseUrl": "http://127.0.0.1:4142"
  }
}
```

Then start croxy as normal (`npm run serve`). Every Codex-leg request will
flow through the recorder, which logs the wire details and forwards them to
the real backend transparently.

### What the output means

For each round-trip the recorder prints two sections separated by a
horizontal rule.

**REQUEST block** — logged before forwarding:
- `REQUEST HEADERS` — all headers in original casing and order; sensitive
  headers shown as `<len:N,sha8:XXXXXXXX>` (length + first 8 hex of SHA-256)
- `REQUEST BODY SHAPE` — structural skeleton of the JSON body. Every string
  value is replaced with `<len:N>`. JWT-looking strings get
  `<jwt,len:N,sha8:XXXXXXXX>`. Arrays appear as `{ "_array": N, "_item": <shape> }`.
  Numbers and booleans are shown verbatim (non-sensitive). Capped at 100
  fields / depth 6.

**RESPONSE block** — logged while streaming:
- `RESPONSE HEADERS` — same redaction rules as request headers
- `SSE EVENTS` — one line per event showing its `type` field (from the JSON
  `data` payload). For `response.completed` events the `usage` object is
  printed verbatim (token counts are not sensitive). Capped at the first 200
  events; beyond that a running counter appears.
- `SSE TOTAL` — total event count for the response.

### Bounds and safety

| Limit | Value |
|---|---|
| Max body-shape fields | 100 |
| Max body-shape depth | 6 |
| SSE events printed | 200 (counter continues) |

The recorder never writes files. All output goes to stdout.

### Live-capture findings (Phase A — codex-cli 0.144.6)

> WARNING: This table uses FABRICATED example values for all credential fields.
> Never commit actual captured output.

Captured 2026-07-22 by driving `codex exec "say hi"` through the recorder with
`OPENAI_API_KEY=""` and `chatgpt_base_url="http://127.0.0.1:4142"`.

#### Architecture finding

`codex exec` uses **WebSocket app-server transport** (`rpc_transport: "app_server"`)
for all AI inference — it does NOT POST to `/backend-api/codex/responses` over
HTTP. The HTTP REST calls captured are analytics, plugin lists, and session
management — not the inference leg. As a consequence:
- `/responses` body field inventory, prompt_cache_key, and SSE event sequence
  cannot be captured via HTTP interception of `codex exec`.
- The captured analytics events DO carry token counts including cache stats.

#### Request headers (names, casing, order)

All chatgpt.com REST calls from `codex exec` carry these headers in this order:

| Header name | Example / shape | Notes |
|---|---|---|
| `authorization` | `Bearer eyJhbGciOiJSUzI1NiJ9.<len:1800>` | JWT; fabricated |
| `chatgpt-account-id` | `00000000-0000-4000-a000-000000000001` | fabricated UUID |
| `oai-product-sku` | `codex` | **MISSING from croxy** |
| `accept` | `*/*` | croxy sends `text/event-stream` |
| `originator` | `codex_exec` | croxy sends `codex_cli_rs` |
| `user-agent` | see below | **MISSING from croxy** |
| `host` | `127.0.0.1:4142` | set by recorder; real: `chatgpt.com` |

Not present on REST calls: `openai-beta`, `session_id`, `content-type`
(GET/HEAD requests), `accept-encoding` (not set explicitly by CLI).

#### User-agent string

Two distinct forms observed in a single session:

| Call | User-agent |
|---|---|
| First request in session | `codex_exec/0.144.6 (Mac OS 26.2.0; arm64) Apple_Terminal/466` |
| All subsequent requests | `codex_exec/0.144.6 (Mac OS 26.2.0; arm64) Apple_Terminal/466 (codex_exec; 0.144.6)` |

Format: `<product>/<version> (<os> <os-version>; <arch>) <terminal>/<terminal-version>`
Confirmed consistent across two independent capture runs.

#### session_id

| Property | Value |
|---|---|
| Location | Request **body** (analytics events only) — NOT a request header |
| Field path | `events[].event_params.session_id` |
| Format | UUID v7 (time-sortable): `019fXXXX-XXXX-7XXX-XXXX-XXXXXXXXXXXX` |
| Stability | Stable within a single `codex exec` invocation; new value per invocation |
| Example (fabricated) | `019f0000-0000-7000-a000-000000000001` |

croxy currently sends `session_id` as a **request header** — this is wrong per
the live capture. The real CLI never sends `session_id` as a header on REST calls.

#### Request body field inventory (analytics events)

Fields observed in the analytics event body (`POST /backend-api/codex/ps/event`):

| Field | Shape | Example / notes |
|---|---|---|
| `events[].event_params.session_id` | `<len:36>` | UUID v7 |
| `events[].event_params.thread_id` | `<len:36>` | UUID |
| `events[].event_params.model` | `<len:11>` | `gpt-5.6-sol` |
| `events[].event_params.runtime.codex_rs_version` | `<len:7>` | `0.144.6` |
| `events[].event_params.rpc_transport` | `<len:10>` | `app_server` |
| `events[].event_params.experimental_api_enabled` | `true` | bool |
| `events[].event_params.input_tokens` | number | e.g. 13038 |
| `events[].event_params.cached_input_tokens` | number | e.g. 9984 (76%) |
| `events[].event_params.output_tokens` | number | e.g. 8 |
| `events[].event_params.service_tier` | `<len:7>` | `default` |
| `events[].event_params.reasoning_effort` | `null` | when not set |
| `events[].event_params.reasoning_summary` | `null` | when not set |

`prompt_cache_key` was NOT observed in any captured body (inference goes via
WebSocket, not HTTP POST).

#### Parity gaps — croxy vs real CLI

| # | Field | Real CLI | croxy current | Fix |
|---|---|---|---|---|
| 1 | `originator` header | `codex_exec` | `codex_cli_rs` | Update `buildHeaders` |
| 2 | `oai-product-sku` header | `codex` | absent | Add to `buildHeaders` |
| 3 | `user-agent` header | `codex_exec/0.144.6 ...` | absent | Add to `buildHeaders` |
| 4 | `openai-beta` header | absent on REST calls | `responses=experimental` | Drop from `buildHeaders` |
| 5 | `accept` header | `*/*` | `text/event-stream` | Update in `buildHeaders` |
| 6 | `session_id` | body field (analytics only) | request header | Remove header; keep body only |

## Troubleshooting

- `npm run doctor` — prints config plus codex auth state (mode, account
  suffix, token expiry). Never prints token material.
- Codex requests failing 401 after a refresh → run `codex login`, then retry.
- `claude-*` traffic must never appear with `route=codex:*` in the logs;
  if it does, check `codex.models` in croxy.config.json.
