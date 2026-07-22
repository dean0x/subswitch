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

## Troubleshooting

- `npm run doctor` — prints config plus codex auth state (mode, account
  suffix, token expiry). Never prints token material.
- Codex requests failing 401 after a refresh → run `codex login`, then retry.
- `claude-*` traffic must never appear with `route=codex:*` in the logs;
  if it does, check `codex.models` in croxy.config.json.
