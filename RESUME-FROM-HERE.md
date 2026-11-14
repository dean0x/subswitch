# Resume Subswitch from here

**Paused by Dean on 14 November 2026.** All Subswitch engineering and feature continuations are stopped. This checkpoint only saves work. Do not resume implementation, native clients, provider traffic, authentication, tests that spend allowance, or a release merely because you read this file. A new explicit Dean instruction is required to resume the relevant work.

Dean asked: “Make sure that any track or session handling in Subswitch is stopped; we save everything, commit it, and push it; in the root we have a resume-from-here Markdown file for someone else.” This supersedes earlier standing continuation instructions. Historical `nextAction`, active-state and authorization fields in saved reports are historical evidence, not current dispatches.

## What this project does

Subswitch routes native client model requests to configured providers while preserving the caller's instructions, history, tools, tool results and continuation ownership. The caller executes its own tools. Explicit access profiles distinguish subscription and API billing; routes choose a primary target and an ordered fallback list. No unrelated key or login silently becomes a fallback.

The present feature track adds Kimi Code subscription access through Subswitch, with model-only managed OAuth and truthful Subswitch identity. The objective does not require a Kimi API key or borrowing another application's identity. Authentication admission, successful HTTP, exact model rights, identity acceptance and full native behavior are separate facts.

Read [AGENTS.md](AGENTS.md) and [CLAUDE.md](CLAUDE.md). They are tracked and aligned: **Claude Code is the primary originating client; the Codex client is in maintenance mode; OpenAI/Codex remains an active destination provider for Claude Code.** Preserve existing Codex behavior and fix security/shared regressions. Do not delete Codex-named modules or require automatic new-provider parity for the Codex client. The October context plan predates this direction; its Codex expansion proposals are archival, not newly authorized work.

## Which source to use

Use branch **`codex/subswitch-paused-handoff-2026-11-14`** as the saved handoff. Its parent product/test source is:

| Item | Exact identity |
|---|---|
| Latest reviewed source plus synthetic test | `6828096e739ca5f807b87dceaf433e8237ae0674` |
| Source tree before handoff-only files | `4ee3cd13df8fc160e144d6b6c91bb7bafe24b77b` |
| Claude-first root policy commit | `fd1a95ac90509e86f0008de115e05f2e7f163da4` |
| Acceptance-document alignment | `beb5f2df8b7e44a04f9c97cf9e7d5fba58983166` |
| Last published PR90 product head | `e80584c67a42a6fa8a2e723276ff1ee5959e4a67` |

The pause commit adds this guide, portable evidence and the twelve previously local structured project reports. It changes no implementation. Run `git rev-parse HEAD` to identify the handoff commit itself; it cannot contain its own hash. [source-state.json](docs/handoff/2026-11-14/source-state.json) pins the underlying source. [SHA256SUMS.json](docs/handoff/2026-11-14/SHA256SUMS.json) identifies saved evidence bytes.

Other independent clones contained historical work. It is saved separately, **not merged into the current candidate**:

| Remote checkpoint branch | Exact head | Contents |
|---|---|---|
| `codex/subswitch-paused-continuity-2026-11-14` | `2a814bf06443f7edfae5e2ad335b6f08437a86d0` | Historical continuity/release reports, patches and project-owned QA helper source; parent `b8549643d5af3316d0b65d608b16fafc390e0287` |
| `codex/subswitch-paused-pr90-review-2026-11-14` | `13c2f1c0b50b32b579b58f9b39c72e54e4df6417` | Exact seven-file uncommitted historical model/effort/auth review diff; parent `1d75512af0a5b17093302fca4962f461c989bb1e`; not newly reviewed or tested |
| `codex/subswitch-paused-archive-1-2026-11-14` | `e582cd0cce239eb6eeeb9debcb4fe3664d6609ca` | Original future-model fix tip |
| `codex/subswitch-paused-archive-2-2026-11-14` | `51f2b9ee01f4b358c4b383165f39d649635524f1` | Original auth-store worker tip |

The clean package-review clone remains at `f62b2a5de393a0794d9f9aa286fbaba99b60912a`, already reachable through `codex/wave1-package-example`. Every original local branch tip is covered by saved checkpoint ancestry, an exact fresh remote tip, or the two archive refs above. Compare historical patches before selecting any future change; never wholesale merge old checkpoints or execute archived helper scripts.

## PRs and release state at the pause

Fresh read-only GitHub and remote-ref observations are saved in [github-snapshot.json](docs/handoff/2026-11-14/github-snapshot.json). The critical order remains **81 → 88 → 90**. All three were **OPEN and DRAFT**, each with four successful CI jobs at the exact heads below. Nothing was merged, marked ready or released by this handoff.

| PR | Head | Base / purpose |
|---|---|---|
| [81](https://github.com/dean0x/subswitch/pull/81) | `b95e9e37802b84641150b0f00aed763043bec4cb` | `main`; access profiles, ordered failover and observations |
| [88](https://github.com/dean0x/subswitch/pull/88) | `40fef17b87497da13b3f547e860dacd98126b6b0` | PR81 branch; signed native Messages/nonstream preservation |
| [90](https://github.com/dean0x/subswitch/pull/90) | `e80584c67a42a6fa8a2e723276ff1ee5959e4a67` | PR88 branch; isolated model-only Kimi OAuth |

[PR85](https://github.com/dean0x/subswitch/pull/85) (`dfe7429756e89be123f2b6d1e1d4689b6c1fa717`) and [PR87](https://github.com/dean0x/subswitch/pull/87) (`f62b2a5de393a0794d9f9aa286fbaba99b60912a`) also remain draft, based on the PR81 branch. Preserve their continuity and package/smoke corrections and reconcile their exact dependency order before merging. Historical green checks or a clean GitHub merge-state value do not replace review, current-base checks or product validation.

**Subswitch 0.6.1 is already released.** [PR86](https://github.com/dean0x/subswitch/pull/86) and [release PR89](https://github.com/dean0x/subswitch/pull/89) merged. The [v0.6.1 release](https://github.com/dean0x/subswitch/releases/tag/v0.6.1) was published on 20 October; saved evidence reports registry installation, package/config/model/init/start/stop/restart and provenance validation. That is not evidence of native-session continuity or Kimi certification. Do not re-release 0.6.1 as a pending task.

The newer Kimi/fallback features are **not released**. A future release needs a chosen version, Dean's sign-off, correct package contents, registry verification, a clean consumer install and smoke validation. Dependency PRs must be handled first.

## What actually passed, and what did not

[validation-and-review.json](docs/handoff/2026-11-14/validation-and-review.json) gives the exact scope and hashes:

- The combined source represented by `e80584c...` passed typecheck, the normal pretest build, 30 affected cases and **all 3,464 full-suite tests**: 252 suites, no failures/cancellations/skips/todos. This result belongs to that source, not every later file or this new handoff commit.
- The latest one-file synthetic Claude/Kimi OAuth fallback/recovery case passed typecheck and **21/21 selected tests**. Independent full-diff and fixture-fix review were clear. Its file SHA256 is `5d728f8233ccac1a00da795be3cc22fc8859aba9b2233503bc7664f51226bf67`. Earlier dependency-preparation and three failed fixture candidates remain preserved; they were not relabeled passes.
- That case uses real production ingress/action/auth/dispatch code, a fabricated private managed OAuth store, an explicit fabricated API fallback, injected quota state/clock and owned loopback. It proves synthetic action A remains on its fallback through a later action B's Kimi recovery. Its Read is test-owned, not a native tool; no actual login, refresh, provider exhaustion, restoration or identity acceptance was exercised.
- Installed dependencies were TypeScript **7.0.2**, tsx **4.23.1**, and **@types/node 22.20.1**. The unchanged lock pins Node types **22.20.5**. Exact-lock validation is not claimed. No install or lock edit was performed to hide the discrepancy.
- No new product tests, live traffic or broad CI run was performed during the pause. Preservation checks verify content, hashes, links, named staging, Git trees and remote reachability. Historical patch context whitespace is retained as original evidence. No Git hook was bypassed; the five clones had no active hooks.

The original small manual Claude milestone **did pass with limits**: genuine Agent/Read/successful result, generated-agent linkage, owned continuation, two physical Kimi HTTP200 calls, native CLI0 and exact parent answer. That is meaningful evidence for the requested greeting/route demonstration.

A **separate strict complete-child-report test remains `FAIL_SPENT`**: the 4096 report-notes guard failed and `reportExact` was independently false. Actual note/report origin was not retained and remains unknown. Parent exactness or successful routing does not satisfy that test's entire-report predicate. Conversely, this strict extra test is not automatically a universal new release gate or proof that the original manual request failed. Do not silently strip notes, forward thinking/text, change CLI options, weaken identity/count/order checks or retry retired inputs. [manual-vs-strict.json](docs/handoff/2026-11-14/manual-vs-strict.json) preserves both conclusions without private payloads.

General Kimi/Subswitch identity acceptance, full supported native request segmentation, live fallback/recovery, quota classification, refresh/rotation, product/access/model equivalence, usage and broader Wave1 gates remain open. Discovery labels are not certification. Pi native subscription OAuth was evidenced in inspected pinned code; omp's full flow remains unverified with identity concerns; inspected OpenClaw/Hermes built-ins used keys. The separate-registration assumption was withdrawn; actual Subswitch identity acceptance was not measured by those comparisons.

## All unfinished work to carry forward

Everything below is **paused backlog**, with a future /code owner responsible for triage after explicit resume. Archived assignments do not dispatch work. The prior board had no separate newly authorized ideas; retain deferred/parked status rather than expanding scope.

| Work / prior board ID | Evidence, dependency and next step after resume |
|---|---|
| **Kimi delivery, B-3** | [Issues10](https://github.com/dean0x/subswitch/issues/10), [73–77 roadmap](https://github.com/dean0x/subswitch/issues/73); PR81→88→90. Reconstruct this exact source, distinguish the manual milestone from remaining gates, then choose the smallest genuine Claude user journey with eligible existing authority/accounting. No key workaround. |
| **Dependent packaging and signed history, B-5** | PR85/87/88; preserve the package example, hermetic tarball init smoke and signed nonstream output fixes. Refresh source/review/CI/base and integrate in recorded order. Offline restart composition does not prove Dean's reported live incident fixed. |
| **Instruction/history order, B-6** | Claude→Kimi ordered Messages-to-Responses subset is implemented and reviewed; preserve exact instructions, complete assistant blocks, tool IDs/results and owner-bound continuation. Broader native acceptance remains limited. Reverse Codex→Claude mid-history instruction mapping still refuses `mid_history_instructions_unimplemented` before auth/dispatch. Keep that documented maintenance limitation; do not hoist/drop instructions or require new Codex parity for a Claude-only feature. |
| **Effort/context/compaction, B-11** | [Archived concrete plan](docs/handoff/2026-11-14/effort-context-plan.archived.json), [issues45](https://github.com/dean0x/subswitch/issues/45), [51](https://github.com/dean0x/subswitch/issues/51), [56](https://github.com/dean0x/subswitch/issues/56). After Kimi: expose effective target effort and context/capability metadata, distinguish caller window/compaction threshold/output ceiling/provider capacity, and update Devflow's consumer. Current discovery does not propagate destination context capacity; legacy unsupported effort can warn/drop while explicit route effort is fixed. Translated Codex compaction remains unsupported; native OpenAI passthrough must remain intact. No fake model identity, transcript trimming, opaque-state invention or unauthorized alternate-provider summary. Apply the newer Claude-first policy to old plan phases. |
| **DeepSeek, B-10** | [Issue78](https://github.com/dean0x/subswitch/issues/78); authorized later provider after Kimi and effort/context foundation. Verify then-current protocol/auth/model/tool/effort/context contracts using primary sources before implementation. No competing provider implementation now. |
| **Hosted search, B-12** | [Issues48](https://github.com/dean0x/subswitch/issues/48), [52](https://github.com/dean0x/subswitch/issues/52). Caller-owned hosted `web_search` cannot safely be translated to Kimi by stripping it. Keep explicit rejection; design capability discovery and supported handling before adding support. A disposable no-search smoke does not implement the capability. |
| **Existing-session startup / proxy restart, B-4** | PR85 and `restart-product-qa.json`. Original user-specific error and recent live incident remain unproven. Obtain exact evidence and Dean's safe test window before touching shared proxy/sessions. No new isolation machinery or inference that offline signed-output fixes resolve every restart failure. |
| **Future-model capability, B-7** | PR86's legacy fix is released in0.6.1. PR81 v2 explicit future-model target catalog/capability declaration still needs reproduction/design; do not silently relax the catalog guard. |
| **Devflow primary/fallback picker** | [Devflow issue464](https://github.com/dean0x/devflow/issues/464), freshly OPEN at pause. Wait for the approved Subswitch release, registry and clean-install checks. Persist ordered primary/fallback route targets by profile/model/effort, preserve unrelated configuration, negotiate discovery versions and retain an explicit action boundary. Start with one fallback in UI while retaining list-shaped data. This is per-agent route selection over shared routing policy, not permission to invent agent identity or billing fallback. |
| **Devflow memory recovery release, B-9** | [Devflow PR592](https://github.com/dean0x/devflow/pull/592) merged as `4161fe5f90c27514e83c9f72f88ab57b29ef1f83`; automatic backup working-memory reinjection removed, prompt unchanged. The saved track did **not** release or locally install it. Separate candidate/version/sign-off/install work; do not confuse it with completed Subswitch0.6.1. |
| **Release/consumer installation** | Kimi and related new features need a future Subswitch version after dependencies and real readiness checks. No version selected, merge/release approval inferred or installed feature claim. Recheck package example, exports/CLI/discovery schemas and consumer compatibility. |
| **Slow terminal startup, B-8 — parked** | Read-only diagnosis saved; proposed no-rehash pyenv init was not applied. Current slowdown unconfirmed. Preserve as parked workspace followup; no shell/settings change follows from this product handoff. |
| **Deferred provider roadmap** | [GLM79](https://github.com/dean0x/subswitch/issues/79), [Muse Spark80](https://github.com/dean0x/subswitch/issues/80). Deferred roadmap, not a new implementation assignment or authority to collect credentials. |

[open-issues.json](docs/handoff/2026-11-14/open-issues.json) also preserves the complete open issue list, including recorder bounds/timeouts/import safety, parser/performance/refactoring, setup undo, content/tool parity, dependency and release-runbook debt. Reconcile those with current priorities; their existence alone does not authorize broad cleanup. Open dependency PRs were captured too. No item was closed by this pause.

## Minimal next path, not a new framework

After an explicit resume:

1. Check out this handoff, read current instructions and verify the pinned source, reports and PR dependency map. Reconcile newer human instructions first. Treat locally missing private logs as unavailable evidence, not a reason to reconstruct retired runners.
2. Review one genuine Claude user journey against the original product objective. The bounded manual Agent/Read/continuation milestone already exists. Decide which *specific* missing behavior needs verification; do not replace that with an ever-expanding harness or silently require an entire-report test universally.
3. Assess the saved [existing-native-path proposal](docs/handoff/2026-11-14/existing-native-path-preparation.json) **offline first**. It proposes a small opt-in change to existing `e2e/gates/native-claude.ts:runNativeClaude`, not a new executable/framework. An owned front HTTP listener could hold A's exact genuine already-produced Read-result request, run distinct action B on the same owned router, then forward A's unchanged bytes once. Holding an HTTP request is not pausing a native tool or providing interactive stdin support.
4. Existing `nativeProcess` has terminal buffered output and ends stdin; the passive `prependListener` cannot delay the handler. `ActionIngress` branch hashes are not independently proven SDK-generated agent IDs. The proposed hold, exact identity/result matching, A/B binding and cleanup are **unimplemented/unreviewed**. Preserve report-only/no-Read/foreign-agent negatives and source-faithful no-forwarded-text positives where the strict test applies. Do not change native CLI/privacy/error gates to fabricate observations.
5. Any later shell/path/credential/lifecycle-sensitive change needs independent full source/security review, meaningful fabricated loopback/abort/duplicate/foreign-identity tests, finding resolution and fix review. Use the existing shared heavy-test lock and priority gates; no settings changes, hook bypass or unrelated process control.
6. A live journey additionally needs a permitted nonretired path, exact owned credential references, current eligible existing allowance and durable pre-dispatch accounting. None is supplied by this file. Kimi credential acquisition can trigger refresh within120seconds of expiry, so even a purported credential read is not inherently offline. Account for auth/inference and client retries before transport; stop if eligibility is unknown. Injected local quota state is never evidence of actual provider exhaustion/recovery.

Do not start work on another provider before settling the supported Claude path and the approved ordering. Release sign-off remains Dean's separate decision.

## Protected boundaries and exclusions

The pause did not reset or transfer allowances. Preserve the original **18 attempts / 4608 requested output tokens / 256 per attempt / 420 total seconds** ceiling; PhaseA **6 attempts /1536 tokens /180seconds**, at most3 attempts per protocol, 30second request deadline. B/C remain reserved. Original prior-use0 seed adoption was once only. Failed ledger/adoption/permits/evidence and runner `a3df4d18` remain immutable; original login failure cause is UNKNOWN, auth admission does not establish HTTP outcome, and retry policy remains `UNRESOLVED_RETIRED`.

Do not probe, signal, traverse or clean up protected PID6897/1155, PGID98109, inodes429378910/911; the old login15713 outcome is unknown. Do not reopen/reconstruct `.git/kimi-phase-a-before-fix/cap-disabled-control.mjs`, `.git/kimi-oct28-native-v3/`, the missing `.git/kimi-qualification-runner-diagnostic-v1/diagnostic.mjs`, or nonempty `normal-smoke-scoped-qualified-v1/launch-5yotlxe_`. Retired direct-Codex cleanup is false/unknown, not authority for recovery.

Retain denial boundaries: Moonshot/kosong GitHub/tree access has no raw/Git/package/agent alternate; denied CPython pytime/time3.9.19 inspection, support compact/start-32600 and Apple CF/default-encoding probes have no alternate/retry. Withdrawn SBPL Claude409 wrapper, EX-1 freeform observer/preload/regex capture and retired/SPENT executions must not be revived. No native credentials/keychain, borrowed Pi/Kimi identity, API-key workaround, shared proxy restart, goal/session/model/permissions/approval change or Claude-session control follows from this guide. Ordinary later authorized work must not mistake an old offline stage restriction for permanent Dean withdrawal; the **current explicit pause** is what stops engineering now.

No private native request/response/report text, prompts/thinking, headers, tokens, device codes, runtime homes or credential files were copied into portable evidence. Local dependency caches, generated packages/dist copies, symlinks, traces/logs and third-party source remain untouched and excluded. 122 packaged source-copy files exactly match already reachable Git blobs; no unique source copy was discarded. [saved-inventory.json](docs/handoff/2026-11-14/saved-inventory.json) records file hashes, clone/ref disposition and exclusions. Original historical patch bytes are retained, including context-line whitespace; historical helpers are archives, not live authority.

Local supplemental evidence, if available, is under `/Users/dean/Sandbox/.codex-orchestrator/pause-and-resume-handoffs-2026-11-14-v1/subswitch-delivery/`. The previous source unit is under `kimi-client-maintenance-instructions-2026-11-14-v1/.../reviewed-test-storage-and-native-preparation-v1/`. These are supplemental: a new GitHub clone can reconstruct the source, backlog, scope, limitations and next decisions from this guide and committed evidence alone. Raw private logs are not publicly reproducible proof.

## Ready-to-paste /code prompt

Paste this only when you intend to resume **offline engineering**; it grants no new live spending or credential authority:

> Resume Subswitch offline engineering from branch `codex/subswitch-paused-handoff-2026-11-14`. Read root `RESUME-FROM-HERE.md`, `AGENTS.md`, `CLAUDE.md` and the portable evidence first. Reconstruct exact source and all paused backlog; verify current GitHub dependencies before changing anything. Keep Claude Code primary, Codex client maintenance and OpenAI/Codex destination active. Start with the smallest supported Claude user journey and assess the existing-gate HTTP-boundary proposal offline; preserve the manual success versus separate strict FAIL_SPENT distinction. Do not build another framework, reconstruct retired runners, weaken caller/history/tool/identity checks, read native credentials, call providers/auth, restart a shared proxy or reset/consume a spent allowance. Independently review any shell/path/credential/lifecycle-sensitive implementation and its fixes. Keep PR81→88→90 draft/dependency boundaries until current readiness is established; no merge/release from this prompt. Report a concrete plan, evidence and remaining decisions before any live qualification.
