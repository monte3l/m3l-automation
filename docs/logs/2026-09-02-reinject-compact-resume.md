# Work log — `reinject-compact-resume` (2026-09-02)

This log covers PR #873, Slice 2 of the 3-slice remediation plan produced by
an `/auditing` pass over the repo's session-continuity automations. Slice 1
(post-merge finalization, the `finishing-work` skill) merged earlier the same
day as PR #857 and was closed out separately. This slice closes Gap 1
(interruption resume): the `SessionStart` re-injection of the compaction
handoff artifact (ADR-0078) fired only on matcher `compact`, so a handoff
written before a session that was then killed (crash, OOM, Ctrl-C) sat unseen
in `tmp/` forever — Anthropic's own guidance gives `SessionEnd` no guaranteed
abnormal-termination signal, so the fix belonged on the `SessionStart` read
side, not a new write-side hook. This log records what shipped, what matched
the plan, what diverged, and the close-out of PR #873 performed by the
`finishing-work` skill.

Plan of record: `~/.claude/plans/how-the-current-automations-quiet-hoare.md`
(session plan-mode file, not yet archived under `docs/plans/`).

## Summary

Widened `.claude/hooks/reinject-compact-handoff.mjs`'s `shouldReinject()` to
accept `SessionStart` source `compact` | `resume` | `startup` (was `compact`
only) via a new exported `REINJECT_SOURCES` set, and added `isStale()` plus a
`formatHandoff()` staleness flag warning when a re-injected handoff's
`capturedAt` is more than 24h old. `.claude/settings.json`'s `SessionStart`
matcher was widened to `"compact|resume|startup"` (pipe-alternation, already
validated by `bin/check-hooks.mjs`'s `KNOWN_MATCHERS`). `starting-work`'s
Step 1 now checks for a same-branch `tmp/compact-handoff.json` when the tree
is dirty, and Step 3/4 offer a resume-or-fresh choice instead of only
defaulting to a new branch/worktree. `docs/adr/0078-session-context-management.md`
got a new dated "Update (2026-09-02)" section (per the ADR's own immutability
convention) and `docs/contributing/hooks-reference.md` was updated to match.

`bin/tests/reinject-compact-handoff.test.ts` grew from 25 to 39 tests, all
via the `test-author` spoke. `pnpm verify` passed in full (57/57 non-skipped
steps) three times across the task: before the first commit, after rebasing
onto `origin/main`, and after fixing the pre-push review's Must-fix. PR #873
merged into `main` at `2026-09-02T07:27:02Z`.

Skills used: starting-work, writing-commits, syncing-docs, creating-prs,
finishing-work, writing-work-logs.

Spoke incidents: none.

## What went as planned

- **The test-author dispatch for the guarded test file went cleanly on the
  first try.** `bin/tests/reinject-compact-handoff.test.ts` is under a
  hub-and-spoke-guarded path; the spoke's extension (corrected
  `shouldReinject` cases, a new `isStale` describe block, new `formatHandoff`
  staleness cases) landed with all 39 tests green and no re-dispatch needed.
- **The rebase onto `origin/main` (4 commits behind, including Slice 1)
  applied cleanly** — no conflicts, and `post-integrate-regen` reported
  nothing to reconcile.
- **`pnpm check:hooks` validated the widened matcher on the first run** — no
  typo in `"compact|resume|startup"`, confirming the pipe-alternation syntax
  guess (matching `PreToolUse`/`PostToolUse` matchers) was correct.
- **The `finishing-work` skill's own close-out ran cleanly a second time**,
  now against its own second real user (Slice 2's PR), reinforcing that the
  skill generalizes past the one PR (#857) it was originally built and
  proven against.

## What didn't go as planned, and why

### 1. A claude-session process restart mid-task lost two backgrounded verify/push runs

Partway through the task, the underlying session process restarted (visible
as a fresh, smaller token budget and an empty scratchpad directory) while a
`pnpm verify` run — launched via the harness's `run_in_background` bash
option — was still executing. Its log file lived under the session
scratchpad directory, which had been wiped by the restart, and its
`task-notification` on return reported `status: stopped` with no completion
record, rather than a normal pass/fail result.

**Why it happened:** `run_in_background`'s tracking (and the scratchpad
directory its output was redirected into) is scoped to the harness process
instance. A process restart mid-task drops that tracking and can wipe the
scratchpad the log was writing into, even though the underlying shell
command itself was running independently on the host.

**Fix for future:** For a long-running verification command whose result
must survive a possible session interruption, launch it detached from the
harness's own process tree (`nohup <cmd> > <log> 2>&1 & disown`) rather than
relying solely on `run_in_background`, and poll it by PID/log path rather
than by task-notification alone. This pattern was applied for the rest of
the task (`pnpm verify` post-rebase, then `git push`) and survived a second
restart later in the same task without losing either run.

### 2. The pre-push review caught a doctrine doc left stale by omission, not by edit

`docs-consistency-reviewer`'s Step 7 pre-push review found one Must-fix:
`docs/contributing/subagent-context-management.md` — a file this branch
never touched — still described the compact-handoff hook's `SessionStart`
matcher as `compact` only, in three separate places (a rollout note, the
"what survives compaction" prose, and the ADR-0078 summary paragraph).

**Why it happened:** The branch's own diff (`hooks-reference.md`, the ADR
Update section, the hook and settings files themselves) was internally
consistent, but `subagent-context-management.md` is a separate doctrine
document that also asserts the same fact and was never in the direct diff to
prompt a manual re-check. A drift check that only diffs the touched files
misses a doc that references the changed behavior without being edited.

**Fix for future:** When widening a hook's `SessionStart`/`PreCompact`
matcher (or any other cross-cutting behavior described in more than one
doc), grep the repo for the old matcher string (`grep -rn "SessionStart.*
compact\b"` or similar) as part of drafting the change, not just as a
pre-push review catch — the reviewer caught it this time, but relying on the
review pass alone means the fix lands as a second commit instead of the
first.

## Lessons learned

- **Detach long verification/push commands from the harness process when a
  restart is possible.** `nohup <cmd> > <log> 2>&1 & disown`, polled by PID
  and log path, survives a session process restart that `run_in_background`
  tracking and its scratchpad-backed log do not.
  _(promoted → .claude/skills/creating-prs/SKILL.md)_
- **A hook's matcher/behavior change can leave a doctrine doc stale by
  omission.** Grep for the old matcher/behavior string across `docs/` before
  opening the PR, not only after a review spoke catches it — the change
  itself never touched the stale doc, so nothing in the diff would surface
  it without a deliberate search.
- **`finishing-work` continues to generalize past its first proving ground.**
  Running the same skill against a second, unrelated PR's close-out (worktree
  removal, ref pruning, fast-forward, tracker/work-log prompts) worked
  identically to its first run against PR #857 — good early evidence the
  skill isn't overfit to the one PR it was built and tested against.
