# Automate the AI co-authorship commit-stats badges

**Status: shipped** (PR #131, commit 82fabdb)

## Context

The root `README.md` header carries AI co-authorship badges (an aggregate
"AI co-authored: N of T commits" badge plus one per Claude model), built by
`bin/gen-commit-stats.mjs` — a fully idempotent, correct script that nothing
ever called automatically; it only ran when someone remembered to type
`pnpm gen:commit-stats` by hand. The script's own header, ADR-0024, and the
`syncing-docs` skill all already stated the intended trigger — run it
post-merge on `main`, never at branch time, since running it on a feature
branch would bake that branch's own commits into the count and cause README
churn against every other open branch on rebase. `bin/post-integrate-regen.mjs`
already did exactly this for three other derived docs (reference index, doc
counts, provenance) via the `post-rewrite`/`post-merge` lefthook stages, but
`gen-commit-stats.mjs` had never been added to its command list — the
documented intent and the actual wiring had simply never been connected.

## Approach / Decisions

- Added branch gating to `bin/post-integrate-regen.mjs`, mirroring the
  existing `isLockfileDirty` pattern: a new `isOnMainBranch(runGit)` export
  running `git rev-parse --abbrev-ref HEAD` and comparing to `"main"`.
- `regenerationCommands(lockfileDirty, onMain)` appends
  `["node", ["bin/gen-commit-stats.mjs"]]` after the three existing fixed
  commands only when `onMain` is true, before the conditional `pnpm install`
  — both new parameters default to their current no-op value so existing
  callers/tests are unaffected.
- `runRegeneration` threads `onMain` through to `regenerationCommands`; the
  runtime block computes `isOnMainBranch()` alongside the existing
  `isLockfileDirty()` and passes both in.
- Deliberately **not** wired as a CI/pre-push gate — the script's own header
  rejects fail-on-drift semantics here, since the count changes on every
  commit. No change to badge content, styling, marker format, or the
  standalone `gen:commit-stats` script (kept for manual/release-grooming use).
- Doc touch-ups reflecting the new automatic behavior: the script's header
  comment, the `syncing-docs` skill's wording, and CLAUDE.md's
  `post-integrate-regen.mjs` description.

## Outcome

Landed as PR #131 (commit `82fabdb`) on 2026-07-13: the `isOnMainBranch`
gating in `bin/post-integrate-regen.mjs`, extended tests in
`bin/tests/post-integrate-regen.test.ts` covering true/false/detached-HEAD
branch detection and command-list composition with both flags, and the
three doc touch-ups. After a merge or rebase completes with `HEAD` on
`main`, the commit-stats badges now regenerate automatically alongside the
other derived docs, landing in the same "N file(s) regenerated" report the
hook already printed — never auto-committed, never blocking.
