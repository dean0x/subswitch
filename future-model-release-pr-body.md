## What

Prepare v0.6.1 for the merged future Codex model override fix (#86). Align package, both lockfile versions, runtime version, and dated changelog. The release delta against current main remains the same four files.

Current candidate: `b8549643d5af3316d0b65d608b16fafc390e0287`, based on main `349fee7f808e2fa38b52af26e131fc044128e17f`. A normal branch merge includes reviewed #71's three development-only `@types/node` lock fields. The release patch's hunks are identical to the independently approved `3ed93e8` patch; only the lockfile diff's blob index changed.

## Why

Configured overrides now work consistently through aliases, qualified aliases, and declared full model IDs. Doctor warns about unregistered configured targets without failing solely for them. The changelog keeps upstream availability and capability limits explicit.

## Related issues

- #86 and #71 (merged).
- Excludes the unmerged routing/continuity stack (#81, #85, #87). The exact original startup error and native session incident remain unproven by this candidate.

## Validation

- Original `3ed93e8` release delta has independent source approval with no findings; its full local `npm run check` passed typecheck and 973 tests, no failures or skips.
- Current composition: fresh locked `npm ci`, typecheck, six version tests, clean production `npm pack`, actual tarball install, installed version/help/config/alias checks, and both repository startup/health smoke checks pass. Shared nonblocking test locks were used where needed.
- All five version locations agree on `0.6.1`. Public manifest/dependencies and runtime source are unchanged by #71.
- Fresh tarball is byte-for-byte identical to the approved original candidate: 60 files, no inventory or content changes. SHA-256: `ce2e0b261eb94856c55a38c24593f35a8c86b846d483d530aa6d6f27a59ad082`.
- Runtime checks use owned config/auth/state/endpoints and guarded children; zero provider requests or guard blocks. No actual native clients, credentials, or inference were used.
- `git diff --check` passes. Original artifacts/report and pre-update build outputs are preserved.
- Current-head full-suite CI remains a required gate. No unchanged local full-suite repeat was run for the development-only base update.

## Checklist

- [x] Current typecheck passes
- [x] Six current version tests pass; original full local gate has 973 passing tests
- [ ] Current-head full CI complete and verified by coordinator
- [x] Installed tarball and both startup checks pass
- [x] Changelog and all version literals align

Draft preparation only. The original approval applies to the unchanged release delta; coordinator must verify the current composition and CI before merge. Dean's sign-off remains required before any tag, publish, or release. No PR merge, tag, registry publish, or GitHub release was performed.
