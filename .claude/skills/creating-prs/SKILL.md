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

### 2 — Quality gates

Run the full verification pipeline. Fail fast: stop on the first failure and
tell the user which gate failed. Do **not** push a branch that fails any gate.

```bash
pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm build
```

### 3 — Pre-push review

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
fix it and loop back through Steps 2–3 before pushing. Do not push with
outstanding Must-fix findings.

### 4 — Push the branch

```bash
git push -u origin HEAD
```

### 5 — Gather commits since main

```bash
git log main...HEAD --oneline
```

### 6 — Generate the PR title

Pick the most impactful commit (breaking > feat > fix > refactor/docs/chore).
Format as a Conventional Commit, 70 chars max. The title alone must make the
purpose of the branch clear to a reviewer skimming a PR list.

### 7 — Generate the PR body

Write a body that matches the quality and specificity of the examples below.
The bullets in **Summary** should name actual symbols, files, or behaviours —
not vague paraphrases of the commit message. The **Test plan** checklist should
reflect the _actual files changed_, not a generic template. The **Notes** line
must state the commit type, the resulting semver bump (or "no release"), and
any migration instructions for breaking changes.

### 8 — Submit the PR

```bash
gh pr create --title "..." --body "$(cat <<'EOF'
...
EOF
)"
```

Pass `--draft` if the branch name starts with `wip/` or if the user explicitly
asked for a draft PR.

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
