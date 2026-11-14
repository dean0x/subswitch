## What

Existing native Claude Messages history can now continue through a single-target explicit Claude route after proxy startup or restart. Complete thinking, redacted-thinking and tool history is forwarded unchanged to its original native upstream for validation.

Cold signatures reserve ownership before dispatch. Successful terminal publication records the owner/conversation atomically; rejection or cancellation releases pending claims. Recorded tampering, known foreign scopes and cross-provider imports remain rejected.

## Why

The explicit-route adapter previously treated every cold signature-cache miss as foreign history, rejecting an existing session before contacting Claude. This fixes that confirmed path. The original released-user incident remains unproven because released ordinary Claude passthrough bypasses this adapter.

Depends on #81; base is `codex/wave1-kimi-failover` at `7e6962c177b679bb2cbd55d8334df071bee262ad`.

## Review and validation

Independent source review approved the revised patch with no remaining findings. CONT-01 was resolved with exclusive bounded reservations and publication revalidation. CONT-02 was resolved with isolated fixture endpoints/auth paths, an exact fetch allowlist, and local rejection of unexpected routing. All nine source/test/README hashes remain unchanged after the conflict-free dependency rebase.

- All 14 offline continuity integration cases pass, including both HTTP stream modes, startup/follow-up/restart, concurrent scope rejection, cancellation cleanup and route-miss isolation.
- Full `npm run check` passed under the shared nonblocking test lock: 1,177 passed, zero failures or skips.
- `npm run build` and whitespace checks pass.
- [All four CI matrix jobs](https://github.com/dean0x/subswitch/actions/runs/39239116548) pass on `dfe7429756e89be123f2b6d1e1d4689b6c1fa717` (Ubuntu/macOS, Node 22/24; includes build and tarball smoke checks).
- Evidence: [`e2e/gates/native-thinking-continuity-offline-2026-10-19.json`](e2e/gates/native-thinking-continuity-offline-2026-10-19.json).

Real native client/provider validation and reproduction of the original released-user incident remain unverified. Later system messages and durable translated Responses continuation are separate work. No real provider calls or existing client/auth/history access were performed.

## Related issues

N/A — bounded continuity follow-up to #81.

## Checklist

- [x] `npm run typecheck` passes (no new warnings)
- [x] `npm test` passes
- [x] Tests added or updated for behaviour changes
- [ ] End-to-end verified with a disposable native client/provider (offline production HTTP fixture passes)
- [x] Docs updated for user-facing behaviour
