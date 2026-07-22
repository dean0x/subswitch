# Contributing to subroute

Thanks for your interest in improving subroute.

## Prerequisites

- **Node 22+** — the only runtime. Check with `node --version`.
- **git**.
- For end-to-end work: Claude Code, a claude.ai subscription login, and the
  Codex CLI logged in (`codex login` → `~/.codex/auth.json`). Unit and
  integration tests need none of these — they run against fake upstreams with no
  network.

## Setup

```bash
npm ci
```

## Quality gates (must all pass before pushing)

These run verbatim in CI:

```bash
npm run typecheck   # tsc --noEmit, strict
npm test            # unit + integration, fake upstreams, no network
```

Or both at once:

```bash
npm run check
```

Zero-warnings policy: the TypeScript config is strict (`noUnusedLocals`,
`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and more). Do not
introduce new warnings.

## End-to-end verification

Changes that touch the wire protocol (request/response translation, auth,
routing) should be verified against the real CLI and real upstreams. See
[`e2e/README.md`](e2e/README.md) for the runbook.

## Repo layout

| Path | Contents |
|------|----------|
| `src/` | Proxy source — router, Anthropic passthrough, Codex leg (auth, request/response translation), reasoning cache, config, logger, CLI |
| `test/unit/` | Unit tests |
| `test/integration/` | Integration tests against fake upstreams |
| `test/fixtures/` | Recorded request/response fixtures |
| `e2e/` | End-to-end runbook and the example `gpt-worker` agent |

## Commit message convention

Lowercase `type: subject` — for example:

```
feat: forward reasoning effort on the Codex leg
fix: preserve unknown keys when rewriting auth.json
docs: clarify per-subagent routing in the README
ci: pin actions to commit SHAs
chore: bump zod to 4.4.3
```

Types: `feat`, `fix`, `docs`, `ci`, `chore`, `refactor`, `test`, `perf`.

## Pull requests

- Add or update tests for any behaviour change.
- `npm run check` must pass with no new warnings.
- Keep changes focused — one logical change per PR.

By contributing, you agree that your contributions are licensed under the
project's [MIT License](LICENSE).
