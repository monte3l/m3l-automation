# Work log — post-merge-staleness-gate (2026-09-05)

This log covers solving issue #995 (H2, user-flagged high priority): a gate
detecting post-merge local residue that `finishing-work`'s manual,
never-hook-triggered invocation leaves unswept.

## Summary

- Added `pnpm check:staleness` (`bin/check-staleness.mjs` +
  `bin/lib/staleness-scan.mjs`): warns (non-blocking, always exits 0) on a
  stale worktree, a stale local branch attached to no worktree, a stale
  remote-tracking ref, or an orphaned `tmp/` file past a 7-day threshold not
  on a live-state allowlist.
- Reused `bin/lib/worktree-prune.mjs`'s `mergedBranches`/`goneUpstreamBranches`/
  `classifyWorktrees` rather than re-deriving the merged/`[gone]` signals, and
  added the one residue class worktree-scoped pruning structurally cannot
  see — a stale branch never attached to any worktree.
- Wired into the `post-merge`/`post-rewrite` lefthook lanes (the actual "just
  merged/rebased" moment) and the pre-push `checks:` chain; CLAUDE.md's
  cadence table, `ci.yml`, `bin/lib/verify-steps.mjs`, and
  `bin/lib/command-catalog.mjs` updated to match — `check:cadence`,
  `check:verify-parity`, and `check:command-catalog` all confirm the wiring.
- `finishing-work` Step 4 now runs `pnpm check:staleness` alongside
  `git fetch --prune`; Step 7 delegates to it entirely, replacing a
  `find tmp -iname '*journal*.md'` glob that provably missed
  non-`*journal*`-named orphans (this checkout's own
  `tmp/test-author-script-scaffold.md` is exactly such a miss).
- 22 new tests in `bin/tests/check-staleness.test.ts` (dispatched to
  `test-author`, since `bin/tests/**` is hub-write-protected).
- `docs/ROADMAP.md`'s H2 row flipped to `Done`.
- Shipped as PR #1044 (`feat/post-merge-staleness-gate`).

Skills used: none invoked by name this session (issue arrived directly);
`starting-work`'s worktree convention and `creating-prs`'s PR-body/merge-path
guidance were followed by reading the skills directly rather than invoking
them as slash commands.

Spoke incidents: none. The `test-author` dispatch (22 tests) completed
cleanly on the first pass — no truncation, no resume needed.

Compaction events: none.

## What went as planned

- The plan-time decision to reuse `bin/lib/worktree-prune.mjs`'s exports
  rather than re-deriving merged/`[gone]` detection held exactly as designed;
  `staleBranches` composes cleanly on top of `mergedBranches`/
  `goneUpstreamBranches` with no duplication.
- The live audit claim behind #995 ("failure mode is silence, not wrong
  automatic action") reproduced verbatim in this checkout at plan time: 3
  worktrees on `[gone]`-upstream branches, one local branch attached to no
  worktree, and two `tmp/` files (one from a retired hook, one a genuine
  orphaned spoke-scaffold file) — none caught by any existing gate, exactly
  as the ROADMAP row described.
- Every wiring-policing gate this change touches (`check:cadence`,
  `check:verify-parity`, `check:command-catalog`, `check:context-budget`,
  `check:hooks`, `check:skill-frontmatter`, `check:skill-evals`) passed on
  the first attempt after wiring — no drift needed a second pass.
- `pnpm verify` passed clean on the first full run: 60 steps passed, 10
  skipped (push-only/e2e), 0 failed — including the new `check:staleness`
  step exercising itself against this checkout's own real residue.

## What didn't go as planned, and why

### The plan under-specified where stale-worktree detection lived

The approved plan named `classifyWorktrees` as a reused signal but the first
implementation pass wired only `staleBranches` (the class worktree-scoped
pruning _cannot_ see) into `bin/check-staleness.mjs`, omitting the direct
worktree-classification call itself. A manual smoke test against this
checkout's own three `[gone]`-upstream worktrees caught it immediately (zero
findings when three were expected) before any test was written — fixed by
wiring `classifyWorktrees` alongside `staleBranches` in
`runStalenessCheck`, sharing the same `records`/`mergedSet`/`goneSet` state
between both checks.

### `knip` flagged an unused export after export-before-precedent-check

`bin/lib/staleness-scan.mjs` initially exported `defaultRunGit` (mirroring
the identically-named function in `bin/lib/worktree-prune.mjs`) without
checking that the sibling file keeps it **unexported**, using it only as an
inline default-parameter value. `pendingRemotePrunes` took `runGit` as a
required parameter, so the exported constant had no caller — `pnpm knip`
caught it as a dead export. Fixed by matching the sibling's actual
convention: un-export `defaultRunGit` and give `pendingRemotePrunes` a
default of `runGit = defaultRunGit`, same shape as
`mergedBranches`/`goneUpstreamBranches`/`isMergedDetached`/`fetchPrune`.

## Lessons learned

- **Reusing a sibling module's helper by name is not the same as reusing its
  export shape.** `worktree-prune.mjs` deliberately keeps `defaultRunGit`
  module-private, exposing it only as a default-parameter value on every
  function that needs it — copying the function without copying that
  encapsulation choice produces a genuinely dead export `knip` will catch,
  but only after the fact. Check whether a sibling's same-named helper is
  exported or module-private _before_ writing the new file, not after `knip`
  flags it.
- **Smoke-test a `check:*` gate against the repo's own live state before
  writing its tests, not after.** Running `node bin/check-staleness.mjs`
  against this checkout's three real `[gone]`-upstream worktrees surfaced a
  real coverage gap (worktree classification silently unwired) in seconds —
  faster and more convincing than any unit test would have been, because the
  expected finding count was already known from the issue's own audit
  numbers. _(promoted → .claude/rules/harness-artifacts.md)_
