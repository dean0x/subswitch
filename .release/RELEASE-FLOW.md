# Release Flow — subswitch

Learned config — first written after the v0.1.0 release on 2026-07-24.
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

1. **Working tree clean**: `git status` — only untracked `.claudeignore` is acceptable; all other
   changes must be committed. (`.claudeignore` is irrelevant to publish.)

2. **Tag must not already exist**: confirm `git tag -l vX.Y.Z` returns nothing. Pushing a tag
   that already exists is a no-op and the CI workflow will not re-run.

3. **Version alignment**: `package.json` version must equal the tag version (e.g., `0.1.0` for
   tag `v0.1.0`). The CI workflow enforces this with a hard guard that exits 1 on mismatch —
   verify locally before pushing.

4. **Local gate** (run in order):
   ```
   npm ci
   npm run check          # typecheck + 258 tests
   ./scripts/smoke-tarball.sh
   ```
   `npm run check` = typecheck + full test suite.
   `smoke-tarball.sh` packs the package, installs the tarball into a temp directory, runs
   `subswitch --version`, then starts `subswitch serve` and polls the health endpoint.

5. **NPM_TOKEN secret**: confirm it exists in the GitHub repo before pushing the tag:
   ```
   gh secret list --repo dean0x/subswitch
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
| `npm run check` | Typecheck + 258 tests |
| `prepack` hook | Runs `npm run build` automatically |
| `prepublishOnly` hook | Runs `npm run check` |

---

## Publish

**DO NOT run `npm publish` locally.** Publishing is CI-driven:

1. Bump version in `package.json` and update `CHANGELOG.md`
2. Commit: `chore(release): vX.Y.Z`
3. Create and push an **annotated** tag:
   ```
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin vX.Y.Z
   ```
4. The tag push triggers `.github/workflows/release.yml`, which:
   - Runs the version guard (exits 1 if `package.json` version ≠ tag version)
   - Runs `npm run build` and `npm run check`
   - Runs `npm publish --provenance --access public` via `NODE_AUTH_TOKEN=${{ secrets.NPM_TOKEN }}`
   - Has `id-token: write` permission for provenance signing

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
   gh release create vX.Y.Z \
     --title "vX.Y.Z" \
     --notes "$(sed -n '/^## \[X.Y.Z\]/,/^## \[/p' CHANGELOG.md | head -n -1)"
   ```
   Extract notes from `CHANGELOG.md` — the `## [X.Y.Z]` section body.

---

## Known Future Improvements

- Migrate `release.yml` from `NPM_TOKEN` classic token to npm OIDC trusted publishing
  (planned post-v0.1.0). Once complete, remove the `NPM_TOKEN` GitHub secret.
