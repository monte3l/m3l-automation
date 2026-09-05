# Slice-progress anchored to the workspace root, its Landing plan table gated

**Status: shipped** — PR 2 `fix/slice-progress-tracking` (this PR), the
second of a 2-PR follow-up fix. PR 1
([weekly-usage cache moved account-scoped](2026-09-05-weekly-usage-cache-account-scoped.md))
fixed the unrelated weekly-usage widget's own anchor defect; the two are
independent defects in independent shipped features, landed as separate,
independently reviewable PRs rather than one combined change.

## Context

The user reported that what shipped with #1025 (slice-progress) and #1035
(weekly usage) "doesn't get reliably shown," singling out the slice-progress
segment as never appearing at all. Investigation found it never renders
because `tmp/slice-progress.json` is never written for the vast majority of
this repo's actual work: `starting-work` Step 5 only documented derived mode
(`--page <reference page>`), and every non-submodule multi-PR wave since
#1025 shipped (X8, H1/H2/H3, V9) has no reference page — so the step was
silently skipped every time, and the literal `--wave/--current/--total`
mode #1025 built for exactly that case went unwired in any skill.

A second, independent defect surfaced once a `slice:set` call actually
happened: `resolveSliceProgress` resolved `tmp/slice-progress.json` (and, in
derived mode, the reference page) against `payload.workspace.current_dir`
verbatim, with no upward walk — the same anchor-mismatch class as PR 1's
weekly-usage bug, but total here: the segment silently fails to render the
moment a session `cd`s into a subdirectory or enters a worktree in-session
(`EnterWorktree`, ADR-0013/0014), even immediately after `slice:set`.

## Approach / Decisions

- **Extract, don't duplicate, the upward walk.** `resolveBranch` already
  solved "find the directory holding `.git`" correctly (handling both a
  plain `.git` directory and a linked-worktree/submodule pointer file).
  Extracted that walk into a new exported `resolveWorkspaceRoot`, refactored
  `resolveBranch` to call it (behavior-preserving — all 184 pre-existing
  tests passed unchanged), and had `resolveSliceProgress` resolve both
  `tmp/slice-progress.json` and a derived-mode `entry.page` against the
  walked root, falling back to raw `startDir` when no `.git` is found
  (preserving existing stub-based test behavior). Verified live: the
  segment now renders correctly from a subdirectory several levels deep,
  where it previously did not.
- **Wire the literal mode that already existed, rather than inventing a new
  one.** `starting-work`'s "Next-slice signal" bullet gained an explicit
  non-submodule branch using the PR-sequence Step 3 already recommends.
  `finishing-work` Step 8 gained the matching continuation half — captured
  in Step 1, before Step 3 deletes the worktree the ephemeral entry lives
  in, since literal mode deliberately keeps no durable record (ADR-0072's
  2026-09-04 amendment). The Notes bullet that previously disclaimed any
  non-submodule mechanism was rewritten to point at this one, with an
  honest note about its one accepted gap: a session that skips the Step 1
  capture has no way to recover the state afterward.
- **Make the gate agree with the CLI it's supposed to back up.**
  `bin/check-scaffold-seam.mjs`'s Landing-plan check verified only that a
  `## Landing plan` heading exists, not that its section parses as a usable
  table — so a numbered-list or prose plan passed the gate while
  `pnpm slice:set --page` would refuse it outright. `landingPlanVerdict` now
  reuses the exact `parseLandingPlanProgress` parser both the CLI and the
  statusline already depend on, adding an `"unparseable-table"` verdict.
- **Correction to the originating plan, verified rather than assumed.** The
  plan drafted at investigation time took `docs/reference/README.md`'s
  `bedrock-runtime` row (✅) against `docs/implementation-status.md`'s (❌)
  as a status disagreement worth flagging, and treated `bedrock-runtime` as
  in-scope for the extended gate — requiring its numbered-list Landing plan
  to be converted to a table for this PR to land green. Re-verified against
  the live table columns rather than trusted: the ❌ is
  `docs/implementation-status.md`'s **Planned** column, not its **Status**
  column (which is ✅, matching the README) — `bedrock-runtime` is fully
  reviewed and out of the gate's in-flight scope. There is no disagreement,
  and converting its Landing plan is not required by this PR; it was left
  as-is rather than done speculatively.

## Outcome

New/updated test coverage: a `resolveWorkspaceRoot` describe block (5
cases), a `resolveSliceProgress` regression test proving the anchor fix from
a deep subdirectory in both derived and literal mode, and a graceful-fallback
test confirming pre-refactor behavior is preserved when no `.git` is found;
`landingPlanVerdict`'s two previously-"ok" tests were corrected to use real
parseable-table fixtures (they had been passing against bullet-list bodies
that were never actually tables), plus four new cases for the
`"unparseable-table"` verdict. No `src/`, test-fixture, or exports-map
changes to the published package; zero semver impact. `pnpm verify`: 62
steps passed, 10 skipped (both before and after rebasing onto PR 1's merge).
