---
name: creating-prs
description: >-
  Verify all quality gates, push the current branch, and submit a pull request
  with a Conventional Commit title and a well-structured body derived from the
  commit history. Use this whenever the user says "open a PR", "create a pull
  request", "submit this branch", "push and PR", "make a PR", "ship this for
  review", or has just finished implementing a feature or fix and wants it
  reviewed. Also invoke when the user asks to "submit my changes" or "get this
  merged" — even without the words "pull request". Requires gh CLI authentication.
---

# creating-prs

This skill enforces quality gates before touching the remote (so you never push
a broken branch to CI), then uses the commit history to generate a PR title and
body that match this repo's conventions: Conventional Commit format, scoped
summary bullets, a concrete test-plan checklist, and a semver note.

## Steps

### 1 — Preflight checks

```bash
gh auth status
```

If the command fails (not authenticated), stop and tell the user:
`gh CLI is not authenticated. Run "gh auth login" and try again.`

```bash
git branch --show-current
```

If the branch is `main`, stop:
`You are on main. Branch off main first (e.g. feat/<slug> or fix/<slug>).`

### 2 — Resync with `origin/main`

Rebase the branch onto the latest `main` **before** the quality gates, so the
gates run against the state that will actually be reviewed and merged. This is
what keeps a stale branch from opening a PR that CI or a required check would
reject.

Detect staleness first:

```bash
git fetch origin main
git rev-list --count HEAD..origin/main
```

If the count is `0`, the branch is already up to date — print
`branch is up to date with main` and skip to Step 3.

Otherwise rebase onto the fetched `main`:

```bash
git rebase origin/main
```

- **On conflict:** capture the conflicted files, abort, and **hand back** —
  never auto-resolve:

  ```bash
  git diff --name-only --diff-filter=U   # capture the conflicted paths first
  git rebase --abort
  ```

  Tell the user which files conflict, that they must resolve the rebase
  manually (`git rebase origin/main`, fix, `git rebase --continue`), then re-run
  this skill. Stop here.

  **Exception — derived-artifact conflicts resolve by regeneration, not
  hand-merge.** On a long-running branch, parallel submodules landing on `main`
  routinely conflict on _generated or metadata_ files: `pnpm-lock.yaml`, the
  `dependencies` block in `package.json`, the `N of 22` count prose (READMEs +
  `implementation-status.md`), and the reference index
  (`catalog.json`/`symbol-map.json`). These are safe for the hub to resolve
  because none is hand-authored logic: take `main`'s version, then regenerate —
  union the `dependencies` and re-run `pnpm install` for the lockfile; take
  `main`'s doc-count files, flip your module's status row to ✅, and let
  `pnpm gen:index` + `pnpm check:impl-counts` derive the authoritative count;
  re-stamp your module's provenance to the _live_ (post-rebase) feature commit,
  since the pre-rebase ref is gone. Land the reconciliation as a separate
  `docs:` commit (the repo's "reconcile counts and index after rebasing onto
  main" pattern). Still hand back on any conflict in real `src/`/test logic.

- **Signing:** pushes are signature-gated, so rebased commits must stay signed.
  If the user's `commit.gpgsign` is unset, use the same recovery pattern
  `verify-signed-range` documents:

  ```bash
  git rebase --exec 'git commit --amend --no-edit -S' origin/main
  ```

### 3 — Quality gates

Run the full verification pipeline. Fail fast: stop on the first failure and
tell the user which gate failed. Do **not** push a branch that fails any gate.

```bash
pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm build
```

### 4 — Pre-push review

Check which files changed since main:

```bash
git diff main...HEAD --name-only
```

If the diff is empty, skip this step.

If the diff contains **any `src/**` changes** (files under `packages/*/src/` or
`scripts/*/src/`), fan out in **one message** the following review spokes in
parallel — this mirrors the Phase 4 fan-out in `implementing-submodules` so the
two pipelines stay consistent:

- **Always:** `code-reviewer` + `spec-conformance-reviewer` (conformance mode)
- **If public types changed** (`src/core/index.ts` or `src/aws/index.ts` in
  the diff): also `type-design-analyzer`
- **If error-handling or async paths changed:** also `silent-failure-hunter`
- **If `aws/`, secrets, credentials, or logging paths changed:** also
  `security-reviewer`

If the diff contains **only docs/automation changes** (no `src/**` files),
dispatch `docs-consistency-reviewer` instead.

After collecting spoke results: if any spoke reports a **Must-fix** finding,
fix it and loop back through Steps 3–4 before pushing. Do not push with
outstanding Must-fix findings.

### 5 — Pre-existing code-scanning check

CodeQL runs via GitHub "default setup" and its `Analyze (...)` check-runs are
required to merge (see `docs/contributing/branch-protection.md`). Before
pushing, surface any **open error-severity CodeQL alert that already touches a
file this branch changes** — so you learn about a blocker now, not after the PR
is open.

```bash
gh api repos/{owner}/{repo}/code-scanning/alerts \
  -f state=open -f tool_name=CodeQL \
  --jq '.[] | select(.rule.severity=="error")
        | "\(.rule.id) \(.most_recent_instance.location.path)"'
```

Cross-reference the paths against the changed set from Step 4
(`git diff main...HEAD --name-only`). If any alert path matches, list the
matches and tell the user to triage them with the `triaging-scan-alerts` skill
before merge. This is informational — alerts for **newly pushed** code only
appear after the post-push scan, so `triaging-scan-alerts` is the follow-up once
the PR is open.

### 6 — Push the branch

```bash
git push -u origin HEAD
```

If the push is rejected as non-fast-forward (the branch was rebased in Step 2
after a previous push), re-push with lease protection — this is safe on **your
own feature branch** but never on a shared branch (per CLAUDE.md, "never
`git push --force` to a shared branch"):

```bash
git push --force-with-lease
```

### 7 — Gather commits since main

```bash
git log main...HEAD --oneline
```

### 8 — Generate the PR title

Pick the most impactful commit (breaking > feat > fix > refactor/docs/chore).
Format as a Conventional Commit, 70 chars max. The title alone must make the
purpose of the branch clear to a reviewer skimming a PR list.

### 9 — Generate the PR body

Write a body that matches the quality and specificity of the examples below.
The bullets in **Summary** should name actual symbols, files, or behaviours —
not vague paraphrases of the commit message. The **Test plan** checklist should
reflect the _actual files changed_, not a generic template. The **Notes** line
must state the commit type, the resulting semver bump (or "no release"), and
any migration instructions for breaking changes.

### 10 — Submit the PR

```bash
gh pr create --title "..." --body "$(cat <<'EOF'
...
EOF
)"
```

Pass `--draft` if the branch name starts with `wip/` or if the user explicitly
asked for a draft PR.

### 11 — Confirm mergeability

After the PR exists, ask GitHub whether it merges cleanly:

```bash
gh pr view --json mergeable,mergeStateStatus
```

A clean Step 2 rebase should make this `MERGEABLE`. If `mergeable` is
`CONFLICTING`, tell the user the branch conflicts with the base and hand back so
they can rebase — do not attempt to resolve it here.

---

## PR body examples

These four examples are the quality bar. Generate bodies at this level of
specificity — never vaguer.

### Example 1 — new feature, minor bump

**Title:** `feat: add retry submodule with exponential back-off`

```markdown
## Summary

- Adds `Core.retry(fn, options)` with configurable max attempts, base delay,
  and jitter via the new `RetryOptions` type
- Exposes `RetryError` (extends `LibError`) surfacing the final cause and
  attempt count

## Test plan

- [ ] `pnpm typecheck && pnpm test` pass
- [ ] `RetryError` chain verified: `error.cause` holds the last thrown error
- [ ] Happy-path test: fn succeeds on attempt 3
- [ ] `expectTypeOf` confirms `RetryOptions` fields are all optional

## Notes

`feat:` commit → minor bump (0.x.0). No breaking changes to existing exports.
```

### Example 2 — bug fix, patch bump

**Title:** `fix: resolve .js extension missing on re-export in core barrel`

```markdown
## Summary

- `src/core/index.ts` was re-exporting `./retry` without the `.js` suffix,
  causing runtime resolution failure on Node 24

## Test plan

- [ ] `pnpm build && node --input-type=module` smoke-test passes
- [ ] `pnpm check:exports` (publint + attw) reports no errors

## Notes

`fix:` commit → patch bump. Regression introduced in the barrel scaffolding.
```

### Example 3 — internal refactor, no release

**Title:** `refactor: extract shared delay logic into internal/timing.ts`

```markdown
## Summary

- Moves `sleepMs` helper out of `polling.ts` and `retry.ts` into
  `internal/timing.ts` — used by both, owned by neither
- No public API changes; `internal/` is private

## Test plan

- [ ] `pnpm typecheck && pnpm test` pass (no import path regressions)
- [ ] `pnpm knip` reports no unused exports

## Notes

`refactor:` commit → no release. `internal/` may change freely per ADR-004.
```

### Example 4 — breaking change, major bump

**Title:** `feat!: rename M3LPaths.outputDir to M3LPaths.archiveDir`

```markdown
## Summary

- `outputDir` renamed to `archiveDir` across `M3LPaths` and all internal
  call-sites for clarity (output/ holds run archives, not raw output)
- Migration: replace `paths.outputDir` with `paths.archiveDir`

## Test plan

- [ ] `pnpm typecheck` catches any consumer call-site using the old name
- [ ] `expectTypeOf` confirms `M3LPaths` no longer exposes `outputDir`
- [ ] `pnpm check:exports` passes

## Notes

`feat!:` commit → major bump. BREAKING CHANGE footer included in commit message.
Consumers must update after upgrading.
```
