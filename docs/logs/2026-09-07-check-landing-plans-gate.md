# Work log — check-landing-plans-gate (2026-09-07)

This log covers PR 2 of 3 for issue #998 (ROADMAP H5): implementing
`check:landing-plans`, the non-submodule counterpart to
`bin/check-scaffold-seam.mjs`, plus the docs/tracker backfill needed to make
the new gate pass on `main` without breaking anything already merged. Records
what shipped, a real tracker-drift bug caught mid-task, three full
`claude-pr-review` rounds and how each finding was resolved, and a
reproducible local-environment artifact whose mitigation is now confirmed.

Plan of record: `~/.claude/plans/solve-issue-998-temporal-scott.md` (the
harness's own plan-mode file, outside the repo — this task is still
mid-sequence, so it isn't archived into `docs/plans/` yet).

## Summary

- Merged as PR #1123 (squash commit `9e5504b5` on `main`), branch
  `feat/check-landing-plans`.
- **The gate:** `bin/check-landing-plans.mjs` + `bin/lib/landing-plans.mjs`
  scan every `docs/plans/YYYY-MM-DD-<slug>.md` (excluding `archive/**`,
  `README.md`, `IMPLEMENTATION.md` by construction of the filename pattern),
  asserting a `## Landing plan` heading whose section parses as a
  `| Slice | [Branch |] Scope | Status |` table with non-empty, unique Slice
  IDs. Reuses `bin/check-scaffold-seam.mjs`'s `landingPlanVerdict` so the two
  gates' error text reads alike; wired into `package.json`,
  `bin/lib/command-catalog.mjs`, `bin/lib/verify-steps.mjs`, and
  `.github/workflows/ci.yml` (CI-only, matching the sibling gate's posture).
- **The refactor:** `.claude/hooks/statusline-context-pressure.mjs` gained a
  newly-exported `extractLandingPlanTable`, the raw header/data-row substrate
  `parseLandingPlanProgress` already built internally — verified
  behavior-preserving live (identical output before/after on the real repo)
  and the existing test suite passed unmodified.
- **The backfill:** archived three plan docs confirmed fully shipped against
  real PR/commit evidence — `2026-08-21-hub-board-restructure.md` (seven PRs,
  `check:hub-views`/`check:label-drift` both green live), `2026-09-01
-orchestration-engine.md` (closed at #880), and `2026-09-02-u11-retry-resume
-cancellation.md`, the last **discovered mid-task** to be fully shipped
  (eleven PRs, #899-#976) despite `docs/ROADMAP.md`'s U11 row still reading
  `To Do`. That discovery led to fixing the same stale-ROADMAP drift for V9 —
  both rows were already `Done` in `docs/plans/IMPLEMENTATION.md`, and V9's
  own close-out commit (`431a6ecd`, already on `main` before this task
  started) claimed in its message "the close-out that flips the tracker row"
  while its diff never touched `docs/ROADMAP.md` at all. Added `## Landing
plan` tables to the three still-live plan docs (`agent-operator.md`:
  V10/V11/V13; `cli-evolution.md`: U13; `m3l-console.md`: X8a-d/X13); added a
  `docs/plans/README.md` "Live dated plans" index section (previously these
  six plans were listed nowhere, which is exactly why the drift went
  unnoticed); repaired three real markdown links the archive moves broke,
  including one inside an otherwise-frozen `docs/logs/` file (a pure
  link-path fix, not a narrative edit — `pnpm lint:md`'s MD057 rule actually
  fails on a dangling relative link even inside `docs/logs/`, so "logs are
  immutable" doesn't cover a mechanical path correction).
- Test count: `bin/tests/check-landing-plans.test.ts` grew from 0 to 32 across
  three review rounds; `bin/tests/statusline-context-pressure.test.ts` gained
  5 direct `extractLandingPlanTable` tests. Full monorepo suite (460+109+26+7
  test files, 21,204+ tests) green on every gate run.
- CI: all required checks green on the final commit (`Dependency Review`,
  `CodeQL`, `verify`, `review`) plus `should-fix-ack` and (non-required)
  `Lint (workspace)`/`Test`/`Governance gates`/skill evals.
- Skills used: `starting-work`, `syncing-docs`, `creating-prs`,
  `resolving-pr-comments`, `finishing-work`, `writing-work-logs`.
- Spoke incidents: none (0 truncations / 0 stalls / 0 resumes — every
  `test-author` dispatch this round completed cleanly on its first pass).
- Compaction events: none.

## What went as planned

- **The extraction refactor was correct on the first pass**, same as PR 1's
  parser generalization — live-verifying `parseLandingPlanProgress`'s output
  against real fixtures before and after the extraction caught zero
  regressions, and no test needed updating for the refactor itself.
- **The hub-and-spoke boundary held cleanly** across five separate
  `test-author` dispatches (initial suite, two rounds of review-driven test
  updates, one bounded-follow-up test) — every guarded-path edit went through
  a spoke, every non-guarded edit (`bin/lib/landing-plans.mjs`,
  `bin/check-landing-plans.mjs`, the hook file) was made directly.
- **Every pre-push and post-push review round converged**, not just passed:
  round 1's FAIL correctly caught two real defects (a silent-failure gate and
  an untested export) plus two real design gaps (the undocumented no-Slice-
  column escape hatch, the `--json` verdict/finding-kind conflation); round
  2's PASS-with-Should-fix caught one genuine diagnostic-quality gap; round 3
  came back completely clean. No round flagged something already fixed or
  disputed a prior finding.
- **`pnpm sync:docs` stayed a clean no-op** apart from routine ADR-provenance
  re-stamps on every run — the six-plan backfill introduced no doc-count or
  cross-reference drift beyond what was deliberately fixed.

## What didn't go as planned, and why

### 1. The plan's own "which plans need a Landing plan table" table was itself stale

The approved plan (written before this PR's implementation began) listed
`2026-09-02-u11-retry-resume-cancellation.md` as needing a table conversion
(open tracker row: "U11 `To Do`"). Re-deriving that claim against
`docs/plans/IMPLEMENTATION.md` and the real git history — required by
`CLAUDE.md`'s "re-derive any authored claim you're about to act on" rule,
which the plan itself had already flagged as a risk for a different row (V9)
— found U11 was actually fully shipped (eleven PRs merged, a close-out commit
already on `main`), just never reflected in `docs/ROADMAP.md`. The plan
changed mid-execution: this plan doc joined the archive list instead of
getting a table, and the ROADMAP fix scope grew from one row (V9) to two
(V9 + U11).

**Why it happened:** `docs/ROADMAP.md` (coarse) and
`docs/plans/IMPLEMENTATION.md` (detailed, PR-cited) are two separate trackers
with no mechanical sync between them — a close-out PR updating one can
legitimately forget the other, and nothing gates that except a human or an
agent actually re-reading both.

**Fix for future:** Before writing a plan-doc's Landing plan table (or
deciding whether to archive it) from a tracker's Status cell, cross-check
that cell against `docs/plans/IMPLEMENTATION.md`'s matching row and, if the
item has a close-out commit, `git show --stat` that commit to confirm it
actually touched `docs/ROADMAP.md` — a close-out commit's own message is not
evidence its diff did what it claims.

### 2. The V8-heap-ceiling lint OOM recurred five more times, including inside the blocking `pre-push` hook itself

PR 1's work log already recorded this as a known, reproducible artifact
(`eslint . --ignore-pattern 'packages/m3l-common/**' --concurrency=1` OOMing
at Node's default ~4.3GB V8 old-space ceiling, confirmed unrelated to real
system memory). This PR hit it five more times across three separate `git
push` attempts — twice during local `pnpm verify` runs, and three times
inside `pre-push`'s own lefthook-triggered lint lane, which blocks the push
outright rather than just failing a local check.

**Why it happened:** Same root cause as before — the _workspace_ lint lane's
type-aware program (everything outside `packages/m3l-common`, a larger
surface than the _library_ lane) sits close enough to the V8 default ceiling
that it's a coin flip on repeated invocations, independent of system RAM
(`free -h` showed 12+ GiB free every time). Blind retries succeeded roughly
half the time — expensive in wall-clock, since each retry re-runs the full
five-minute pre-push cadence.

**Fix for future:** Reach for `NODE_OPTIONS="--max-old-space-size=8192"` as a
prefix on the retry immediately, not after 2-3 blind attempts — it passed
cleanly every single time it was tried this session, including for the actual
`git push` (not just a diagnostic `pnpm lint` run). No config file changes,
nothing committed — just an env var on the one retried command.

## Lessons learned

- **A close-out commit's message is a claim, not a diff.** `431a6ecd`'s
  message said "the close-out that flips the tracker row" while its actual
  diff never touched `docs/ROADMAP.md` — caught only because writing this
  PR's backfill required reading the real tracker state, not the commit
  message. When a plan cites a commit as evidence a tracker was updated,
  verify with `git show --stat <sha> -- <tracker-file>`, not just the subject
  line.
- **Two trackers covering the same item need cross-checking, not just one.**
  `docs/ROADMAP.md` (coarse) and `docs/plans/IMPLEMENTATION.md` (detailed) can
  disagree silently — this PR found two such rows (U11, V9) in one sitting.
  Treat "IMPLEMENTATION.md says Done" as reason to check ROADMAP's matching
  row too, not as settling the question on its own.
- **`NODE_OPTIONS="--max-old-space-size=8192"` reliably fixes the local
  workspace-lint OOM — use it on the first retry, not the third.** Confirmed
  five times this session; CI's own `Lint (workspace)` check passed on every
  affected commit independently, so this was never a real finding.
  _(promoted → `[[eslint-concurrency-crashes-wsl]]` memory)_
- **A merged PR's own close-out (branch/worktree cleanup) can itself go
  unclosed.** PR #1121's work-log doc PR (#1122) auto-merged mid-session but
  its local branch/worktree residue was never swept — caught only because
  this PR's `finishing-work` pass ran `pnpm check:staleness` and found it.
  When `finishing-work` runs after a multi-PR session, check `pnpm
check:staleness`'s full output for residue from _any_ PR in the sequence,
  not just the one just merged.
- **A gate whose whole purpose is asserting a structural invariant (unique,
  non-empty Slice IDs) should fail loudly the moment that invariant's
  precondition (a `Slice` column existing at all) is absent**, rather than
  silently treating "nothing to check" as "check passed." This is the same
  silent-failure class `.claude/rules/library-src.md` already names for
  library code, applied here to a `bin/` gate's own design.
