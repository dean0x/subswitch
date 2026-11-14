# Historical continuity / release preservation checkpoint

Dean paused all Subswitch engineering on 14 November 2026. This branch preserves historical QA reports, review patches and project-owned helper source from the inactive continuity checkout. Its parent is b8549643d5af3316d0b65d608b16fafc390e0287; it is **not** the latest Kimi source and must not be merged wholesale into it.

The primary handoff is `codex/subswitch-paused-handoff-2026-11-14:RESUME-FROM-HERE.md`. Only that guide, current project instructions and a new explicit Dean resume establish future work. Historical nextAction fields, commands, authorization notes and helper scripts are evidence, not active assignments. Do not execute archived helpers or recreate retired runners.

Saved here: all original root project reports, patch/PR drafts and packaged-QA source, plus ten project-owned artifact helper source files. Excluded intact locally: generated packages/dist copies, dependency links/caches, runtime homes/private fixtures, traces/logs and third-party copies. 122 duplicated source-copy files match existing reachable Git blobs and need no second copy. The portable primary inventory records exact dispositions. No credential/runtime files are opened for this handoff.

The historical JWT-like literal in future-model-review.patch is the exact already-tracked static mocked readAuthFile test value paired with fabricated-refresh; it was not decoded or used. No native/provider/auth operation, test, install, merge or release is performed by this checkpoint.
