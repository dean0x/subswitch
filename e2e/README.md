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

## Troubleshooting

- `npm run doctor` — prints config plus codex auth state (mode, account
  suffix, token expiry). Never prints token material.
- Codex requests failing 401 after a refresh → run `codex login`, then retry.
- `claude-*` traffic must never appear with `route=codex:*` in the logs;
  if it does, check `codex.models` in croxy.config.json.
