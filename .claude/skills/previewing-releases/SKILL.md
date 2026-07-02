---
name: previewing-releases
description: >-
  Preview what semantic-release would publish from the current main branch WITHOUT
  releasing anything — the computed next version, the release type (major/minor/patch),
  and the generated release notes. Use this whenever the user asks "what version will
  this release", "what's the next version", "preview the release", "will this be a
  breaking release", "did my commits bump the version correctly", or wants to sanity-check
  Conventional Commits before merging/pushing to main. This is read-only and safe; it
  publishes nothing.
disable-model-invocation: true
---

# previewing-releases

Releases here are automated: `semantic-release` derives the version from
Conventional Commits on `main` and owns the `version` field, the changelog, the
npm publish, and the GitHub release. That automation is great but invisible until
it runs — this skill makes it visible _before_ you push, so a mislabeled commit
(a `fix:` that should have been `feat!:`) is caught early rather than after a
wrong version ships.

## Steps

1. **Confirm the branch state.** semantic-release analyzes commits relative to
   the last release tag, so the preview is only meaningful on an up-to-date
   checkout. Run `git fetch` and confirm the current branch is `main` (or note
   to the user that the preview reflects whatever is checked out).

2. **Run the dry run.** From the repo root:

   ```bash
   npx semantic-release@latest --dry-run --no-ci
   ```

   `--dry-run` computes everything but publishes nothing; `--no-ci` lets it run
   outside the CI environment. It reads `.releaserc.json` for the configured
   plugins and branches.

3. **Read the output and summarize** for the user:
   - the **next version** and the **release type** (major / minor / patch / none),
   - the **release notes** it generated (grouped by commit type),
   - if it reports "no release will be published", explain that no
     release-triggering commits (`feat:` / `fix:` / breaking) exist since the
     last tag — `docs:`/`chore:`/`refactor:`/`test:` don't release.

4. **Map it back to intent.** If the computed bump doesn't match what the user
   expected (e.g. they changed the public `exports` map but the bump is only a
   patch), flag the mismatch and point at the offending commit message — that's
   the actionable fix (amend the commit type before merging).

## Notes

- **Tokens are optional for a preview.** A missing `GITHUB_TOKEN` / `NPM_TOKEN`
  only disables the actual publish/GitHub steps; the version + notes computation
  still works. Don't treat token warnings as failures of the preview.
- This skill is **user-invocable only** (`disable-model-invocation: true`) because
  it spawns a network-touching tool — it should run when a human asks, not
  speculatively mid-task.
