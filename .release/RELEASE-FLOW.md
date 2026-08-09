# Release Flow — subswitch

Learned config — first written after the v0.1.0 release on 2026-07-24;
last verified against `release.yml` on 2026-08-09 (v0.2.0).
Released to date: `git tag -l 'v*'` (authoritative: `npm view subswitch versions`).
Release model: tag-push → CI publish with provenance.

---

## Packages

- **Name**: `subswitch`
- **Registry**: npm (public)
- **Monorepo**: No — single package
- **Version source**: `package.json`
- **Distributed files**: `dist/`, `subswitch.config.example.json` (via `files` field)
- **Binary**: `subswitch` → `dist/cli.js`
- **Engine requirement**: `node >=22`

---

## Pre-release Checks

Run these in order before pushing the release tag:

1. **Working tree clean**: `git status` — the working tree must be fully clean; all changes must
   be committed.

2. **Tag must not already exist**: confirm `git tag -l vX.Y.Z` returns nothing. Pushing a tag
   that already exists is a no-op and the CI workflow will not re-run.

3. **Version alignment**: all three version fields must agree. The CI workflow enforces this with
   hard guards that exit 1 on mismatch — verify locally before pushing:
   ```
   node -p "[require('./package.json').version, require('./package-lock.json').version, require('./package-lock.json').packages[''].version].join(' ')"
   ```
   All three values must equal the tag version (e.g., `X.Y.Z` for tag `vX.Y.Z`). If the lockfile
   fields lag, fix with: `npm install --package-lock-only`

4. **Lockfile guard**: `package-lock.json` must be in sync with `package.json`. The CI workflow
   checks both `version` and `packages[""].version` in the lockfile — both must match. The
   one-liner above covers all three fields at once.

5. **Local gate** (run in order):
   ```
   npm ci
   npm run check          # typecheck + full test suite
   ./scripts/smoke-tarball.sh
   ```
   `npm run check` = typecheck + full test suite.
   `smoke-tarball.sh` packs the package, installs the tarball into a temp directory, runs
   `subswitch --version`, then starts `subswitch serve` and polls the health endpoint.

6. **NPM_TOKEN secret**: confirm it exists in the GitHub repo before pushing the tag:
   ```
   gh secret list
   ```

---

## Changelog

- Format: [Keep a Changelog](https://keepachangelog.com/) with dated headers: `## [X.Y.Z] - YYYY-MM-DD`
- No `Unreleased` section is kept between releases — the versioned entry is written directly
- GitHub Release notes are extracted verbatim from the matching `## [X.Y.Z]` section body in `CHANGELOG.md`

---

## Build & Test

| Command | What it does |
|---------|--------------|
| `npm run build` | `tsc -p tsconfig.build.json` |
| `npm run check` | Typecheck + full test suite |
| `prepack` hook | `npm run build` — fires on `npm pack` AND `npm publish` |
| `prepublishOnly` hook | `npm run check` — fires on `npm publish` only, BEFORE `prepack` |

**On hook duplication (do not optimize away):** per release run, `npm run check` executes
twice (explicit CI step + `prepublishOnly`) and `npm run build` three times (explicit CI step
+ `prepack` via smoke-tarball's `npm pack` + `prepack` via `npm publish`). This duplication
is deliberate: `prepublishOnly` is the only gate that also fires on a local `npm publish`
where no workflow step exists, and it uniquely covers the runtime tests plus typechecking of
`test/**/*.ts` (which `tsconfig.build.json` excludes). Cost is approximately 13 s of a ~44 s
CI job. Do not remove `prepublishOnly`.

---

## Publish

**DO NOT run `npm publish` locally.** Publishing is CI-driven:

1. Bump version in `package.json`, sync `package-lock.json` (run `npm install --package-lock-only`
   to update the top-level `version` and `packages[""].version` in the lockfile), and update
   `CHANGELOG.md`
2. Commit: `chore(release): vX.Y.Z`
3. Create and push an **annotated** tag:
   ```
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin vX.Y.Z
   ```
4. The tag push triggers `.github/workflows/release.yml`. The authoritative step list lives in
   that file; consult it for the exact sequence. The invariants that matter:
   - A **tag guard** hard-fails (exit 1) if the tag version does not match `package.json`
   - A **lockfile guard** hard-fails if `package-lock.json` fields lag `package.json`
   - **Provenance signing** is on via `id-token: write` — published artifacts carry npm attestations
   - The Publish step runs `npm publish --provenance --access public`, which fires both
     `prepublishOnly` (`npm run check`) and `prepack` (`npm run build`) hooks before publishing

---

## Post-release

After the tag is pushed, in order:

1. **Monitor the Actions run** to green:
   ```
   gh run watch
   ```

2. **Verify on npm**:
   ```
   npm view subswitch@X.Y.Z version
   ```
   Also check provenance/attestations in the npm package page.

3. **Cold-install verify**:
   ```
   npx -y subswitch@X.Y.Z --version
   ```

4. **Create the GitHub Release** (this does NOT re-trigger the workflow because the tag already exists):
   ```
   VERSION="$(node -p "require('./package.json').version")"
   gh release create "v${VERSION}" \
     --verify-tag \
     --title "v${VERSION}" \
     --notes "$(awk -v v="## [${VERSION}]" 'index($0,v)==1{f=1;next} f&&/^## \[/{exit} f' CHANGELOG.md)"
   ```
   The `awk` command extracts the section body for `## [X.Y.Z]` — stopping at the next
   `## [` header (or EOF for the oldest entry) without dropping the final line.

---

## Known Future Improvements

- Migrate `release.yml` from the `NPM_TOKEN` classic token to npm OIDC trusted publishing.
  Status: not started as of v0.2.0. On completion: delete the `NPM_TOKEN` GitHub secret and
  drop the `NODE_AUTH_TOKEN` env block from the Publish step.
