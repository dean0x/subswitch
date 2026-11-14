## What

Configured future Codex models now resolve consistently through the alias, its declared full target ID, and qualified spellings. For example, `"sol": "gpt-future-sol"` selects that configured target for `sol`, `codex:sol`, `gpt-future-sol` and `codex:gpt-future-sol`.

`doctor` keeps an unregistered-target warning without failing that deliberate override. Exact registered IDs, one-hop aliases, family defaults and unrelated unknown-name behavior retain their precedence.

## Why

Published 0.6.0 already loads an unknown alias target, but qualified family aliases ignore the override and the full configured ID falls through to Anthropic. `doctor` also treats the supported forward-compatible alias mechanism as a failure. Five fixture regressions reproduced these inconsistencies before correction.

This PR is based directly on current main (`de137dedbd72d660657517251fe8a1051dd43465`), which matches npm 0.6.0's published git head. PRs #81 and #85 remain separate drafts.

## Validation and review

- All 14 new offline cases pass: config/selection/doctor controls plus production HTTP in both stream modes and authoritative provider rejection.
- Full `npm run check` passed under the shared nonblocking test lock: **973 passed, zero failures or skips**.
- `npm run build` and whitespace checks pass.
- [All four CI matrix jobs](https://github.com/dean0x/subswitch/actions/runs/39266322367) pass on `e582cd0cce239eb6eeeb9debcb4fe3664d6609ca` (Ubuntu/macOS, Node 22/24; includes tarball smoke checks).
- Full self-review complete; independent source review is pending with the coordinator.
- Evidence: [`e2e/gates/future-model-overrides-offline-2026-10-19.json`](https://github.com/dean0x/subswitch/blob/e582cd0cce239eb6eeeb9debcb4fe3664d6609ca/e2e/gates/future-model-overrides-offline-2026-10-19.json).

The provider still determines model availability and account access. No live inference or existing native client/auth/history access was performed. PR #81's new v2 explicit-target validator remains strict and needs a separate capability-declaration follow-up. The user's exact startup error was not reproduced on the released legacy alias path.

## Related issues

N/A — original future-model override bug follow-up.

## Checklist

- [x] `npm run typecheck` passes (no new warnings)
- [x] `npm test` passes
- [x] Tests added or updated for behaviour changes
- [ ] End-to-end verified with a real native client/provider (fake-only HTTP fixtures pass)
- [x] Docs updated for user-facing behaviour
