# Work log — statusline-anchor-fixes (2026-09-05)

This log covers a user-reported investigation into two shipped statusline
features — #1025's slice-progress segment and #1035's per-model weekly-usage
segment — both reported as rendering unreliably. It ran through plan mode,
live root-cause verification against production endpoints and file anchors,
and two independently reviewed, independently merged fix PRs. Records what
shipped, what matched the plan, one significant scope correction made before
landing, and durable lessons.

Plan of record:
[`docs/plans/archive/2026-09-05-weekly-usage-cache-account-scoped.md`](../plans/archive/2026-09-05-weekly-usage-cache-account-scoped.md)
(PR 1) and
[`docs/plans/archive/2026-09-05-slice-progress-anchor-fix.md`](../plans/archive/2026-09-05-slice-progress-anchor-fix.md)
(PR 2).

## Summary

Two PRs, both merged via plain `gh pr merge --squash` (not auto-merge) after
their `claude-pr-review.yml` verdict landed clean:

- **PR #1050 — `fix: anchor weekly-usage cache account-wide, not per-repo`.**
  Root-caused two independent defects: (1) the cache-anchor mismatch between
  `refresh-usage-cache.mjs` (`CLAUDE_PROJECT_DIR`) and `resolveWeeklyUsage`
  (`payload.workspace.current_dir`, no upward walk) — fixed by moving the
  cache to one account-scoped path, `resolveUsageCachePath(homeDir)` →
  `~/.claude/m3l-usage-weekly.json`; (2) a live authenticated
  `GET /api/oauth/usage` call confirmed `seven_day_opus`/`seven_day_sonnet`
  are `null` on this account — there is no Sonnet/Opus split to show, only a
  Fable premium-model cap. Wired the two `seven_day_*` fields as a dormant
  integration point and amended ADR-0092 to state the finding plainly rather
  than implying a split exists. 12 files changed across two commits; `pnpm
verify` 62/62 (10 skipped) both before and after a mid-flight rebase onto
  `origin/main`.
- **PR #1053 — `fix: anchor slice-progress to the workspace root, gate its
Landing plan table`.** Root-caused two more independent defects: (1) the
  same anchor-mismatch class in `resolveSliceProgress`, fixed by extracting
  `resolveWorkspaceRoot` from `resolveBranch`'s existing upward-walk logic
  (behavior-preserving — all 184 pre-existing tests passed unmodified); (2)
  the literal `--wave/--current/--total` mode #1025 shipped was never wired
  into `starting-work`/`finishing-work`, so the segment was silently never
  set for any non-submodule wave (X8, H1/H2/H3, V9 — every wave since #1025
  landed). Wired it into both skills, including a new capture step in
  `finishing-work` Step 1 (the ephemeral entry must be read before Step 3
  deletes the worktree it lives in). Also extended
  `bin/check-scaffold-seam.mjs`'s Landing-plan gate to reuse
  `parseLandingPlanProgress`, closing a gap where a heading-only check
  passed a plan the CLI itself would refuse. 6 files changed across two
  commits; `pnpm verify` 62/62 (10 skipped) both before and after rebasing
  onto PR 1's merge.

Both fixes were verified live, not just by unit test: rendered the
statusline with `workspace.current_dir` set to an arbitrary `/tmp`
subdirectory and to an unrelated linked worktree, confirming each segment
now renders where it previously silently did not.

Skills used: starting-work (×2), creating-prs (×2), syncing-docs (×2),
finishing-work, writing-commits (inline), writing-work-logs.

Spoke incidents: none (no `tmp/session-incidents.jsonl` present; 5 spokes
dispatched across the session — 2 Explore, 1 Plan, 2 test-author, 2
docs-consistency-reviewer — all converged cleanly on first dispatch, no
`SendMessage` resumes).

Compaction events: none.

## What went as planned

- **The plan-mode fan-out found both root causes before any code was
  written.** Two parallel Explore agents traced the exact anchor-mismatch
  mechanism in each widget independently, and a live authenticated API call
  (user-approved mid-plan) settled the weekly-usage data-availability
  question definitively rather than leaving it as a guess.
- **Both PRs' `pnpm verify` passed clean on the first real attempt** — no
  lint/typecheck/test fix-up round was needed on either PR's substantive
  code, only the routine post-rebase re-verification.
- **The hub/spoke split held cleanly.** Every test file added or modified
  (`bin/tests/**`, a guarded path) went through `test-author`; every
  non-test file (hooks, `bin/*.mjs`, skills, docs) was hub-written directly.
  No `guard-hub-src-writes.mjs` rejection occurred.
- **`docs-consistency-reviewer` returned CLEAN on both PRs**, including
  independently re-verifying the bedrock-runtime correction below against
  the same source files rather than trusting the hub's restated claim.
- **Both PRs rebased cleanly onto a moving `origin/main`** with no
  conflicts, in worktrees created via `pnpm worktree:new`/`EnterWorktree` —
  the ADR-0013/0014 in-session worktree flow worked exactly as documented.

## What didn't go as planned, and why

### 1. A planning-time table-column misread nearly forced unnecessary work into PR 2

The plan drafted during investigation read `docs/reference/README.md`'s
`bedrock-runtime` row (✅) against `docs/implementation-status.md`'s row and
took a `❌` there as a status disagreement, concluding `bedrock-runtime` was
in-flight and therefore in-scope for the new `check-scaffold-seam.mjs`
Landing-plan gate — which would have required converting its numbered-list
Landing plan section to a table for the gate to pass. Live-running the
extended gate against the actual repo showed it passing green with
`bedrock-runtime` untouched, which triggered a re-check: the `❌` was
`docs/implementation-status.md`'s **Planned** column, not its **Status**
column (which is ✅, matching the README). There was no disagreement, and
the conversion was correctly dropped from PR 2's scope.

**Why it happened:** A markdown table row was read by eye without counting
header columns against cell positions — an easy mistake in a table with
several single-character status-emoji columns in a row (`Planned`,
`Status`, `Tests`, `Reviewed`).

**Fix for future:** Before treating a markdown table cell as authoritative
for a planning claim, print the header row alongside the cell in question
(or run the actual gate/check the claim would justify) rather than trusting
a visual column count — this is the same "re-derive an authored claim"
discipline the Task Workflow already requires for other cases,
applied one column too late here.

### 2. `EnterWorktree` refused a second worktree switch mid-session

After PR 1's worktree was entered via `EnterWorktree`, a second `EnterWorktree`
call for PR 2's worktree was rejected: switching between worktrees mid-session
is restricted to worktrees under `.claude/worktrees/`, but this repo's
`pnpm worktree:new` convention creates sibling directories
(`../m3l-automation-<slug>`) by design (ADR-0013/0014) — the same
already-in-worktree case documented for the first switch, but this
distinction (first-entry-from-launch-dir vs. already-in-a-worktree) is easy
to miss going in.

**Why it happened:** `EnterWorktree`'s path restriction is looser on first
entry from the session's original launch directory than on a subsequent
switch while already inside another worktree — a distinction not obvious
from the tool's own error message alone.

**Fix for future:** For PR 2's actual work, all file operations used
absolute paths into the second worktree directly via `Read`/`Write`/`Edit`
and prefixed `Bash` commands, without ever calling `EnterWorktree` for it —
this worked correctly throughout and required no `ExitWorktree`. When a
session needs a second concurrent worktree mid-session, prefer this
absolute-path approach over forcing an `ExitWorktree`/`EnterWorktree` cycle,
unless the user specifically wants the session's tracked-worktree state
(e.g. for `finishing-work`'s ownership-based `ExitWorktree(remove)`) to
follow the switch. _(promoted → .claude/skills/starting-work/SKILL.md)_

### 3. `pnpm worktree:remove` kept both merged branches, requiring a manual force-delete

`finishing-work` Step 3 reported "kept branch (not merged into its base)"
for both `fix/weekly-usage-cache` and `fix/slice-progress-tracking` after
their PRs squash-merged — `git branch -d`'s ancestry check can never
recognize a squash-merged branch as merged, since the squash commit's
history diverges from the feature branch's own commits.

**Why it happened:** This is `finishing-work`'s own documented, expected
behavior for a squash merge (its Notes section calls this out explicitly),
not a defect — but it still requires a manual `git branch -D` after
confirming via `gh pr view --json state,mergedAt` that the PR genuinely
merged.

**Fix for future:** No process change needed — this is already correctly
documented. Noting it here only because it happened twice in one session
and is worth remembering as routine, not alarming.

## Lessons learned

- **A live authenticated API call settles a data-availability question no
  amount of code reading can.** The weekly-usage fix's most important
  finding — that no Sonnet/Opus split exists in the endpoint's response on
  this account — could only be confirmed by actually calling
  `/api/oauth/usage`, not by re-reading `bin/usage-cache.mjs`'s normalizer
  logic more carefully. When a plan's premise depends on an external
  system's current behavior, get the user's approval to check it live
  before designing around an assumption.
- **The same anchor-mismatch defect class can hide in two unrelated
  features shipped by two unrelated PRs.** Both #1025 and #1035 anchored
  `tmp/*.json` state against `payload.workspace.current_dir` with no
  upward walk, and both silently broke the instant a session entered a
  worktree in-session. Once one instance is found, grep sibling `tmp/`-based
  state for the same pattern rather than assuming it was a one-off.
- **A markdown-table planning claim needs the header row alongside it, not
  just the cell.** See divergence #1 — a single-character-emoji column
  misread almost added unnecessary scope to a fix PR.
- **Two independent defects in two independent features are worth two
  independent PRs, even when they share a root-cause class.** PR 1 and PR 2
  shared the anchor-mismatch mechanism and even some refactored code
  (`resolveWorkspaceRoot`, extracted for PR 2 alone, deliberately not
  bundled into PR 1's scope), but stayed independently reviewable and
  independently revertable per ADR-0072 — confirmed by both landing clean
  on the first `pnpm check:review-size` check, well under the soft target.
- **`finishing-work`'s squash-merge branch-keep behavior is expected, not a
  signal to investigate.** Confirmed via `gh pr view` first, then a plain
  `git branch -D` — exactly as the skill's own Notes section already says.
