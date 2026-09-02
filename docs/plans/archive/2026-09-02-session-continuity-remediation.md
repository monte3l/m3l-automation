# Session continuity & work close-out remediation (2026-09-01 – 2026-09-02)

**Status: shipped** (PRs #857, #873, #878)

## Context

`/auditing` swept three scenarios in the repo's development workflow: resuming
work after a sudden interruption, continuing work after manual or automatic
compaction, and the trivial finalization tail after all PRs of a work unit
merge. Five parallel Explore facets returned 40 EXISTING / 31 GAP / 15
INCONSISTENCY items; an adversarial refute pass confirmed 12, refuted 3. A
`/researching-anthropic-guidance` pass enriched the aggregated findings against
official Anthropic sources, and `/claude-code-setup:claude-automation-recommender`
turned the confirmed gaps into concrete automation recommendations.

The headline: compaction continuity was the mature leg (ADR-0078's
`PreCompact`/`SessionStart` handoff pair, already gated), interruption resume
was half-built on top of it (the same handoff, never triggered on the
resume/crash path), and post-merge finalization did not exist at all —
verified live in the checkout itself: 4 stale remote-tracking refs, 1 stale
local branch, 1 stale worktree, and 1 orphaned spoke journal, all residue from
the last four merged PRs, none of it caught by any gate.

## Approach / Decisions

`/starting-work` recommended three independently landable slices (ADR-0072),
each in its own linked worktree, landed one at a time:

- **Slice 1 — PR #857, `finishing-work` skill.** New `.claude/skills/finishing-work/SKILL.md`
  owns the post-merge tail creating-prs never covered: confirm the merge,
  return to `main` and pull, delete the merged branch (a new shared-checkout
  helper `bin/branch-cleanup.mjs` for the shared-checkout case, `pnpm
worktree:remove` for a linked worktree), prune stale remote-tracking refs,
  prompt for a tracker-row flip and `sync:hub`, prompt for a missing work log.
  `bin/check-github-features.mjs` gained a warn-severity assertion that
  `delete_branch_on_merge` is enabled — the precondition the `[gone]`-upstream
  prune heuristic silently depended on. A `claude-pr-review` bot review caught
  one real Must-fix: `deleteBranch()`'s catch block collapsed every distinct
  git failure into one fixed, misleading message while still exiting 0; fixed
  by surfacing the real `cause`.

- **Slice 2 — PR #873, resume/startup handoff re-injection.** Closed the gap
  where a `PreCompact`-written handoff (`tmp/compact-handoff.json`) sat
  unseen forever if the session was killed before the next compaction — the
  `SessionStart` re-injection in `.claude/hooks/reinject-compact-handoff.mjs`
  fired only on matcher `compact`. Widened `shouldReinject()` and the
  `settings.json` matcher to `compact|resume|startup`, added an `isStale()`
  check flagging a >24h-old handoff, and taught `starting-work` Step 1 to
  detect a same-branch handoff on a dirty tree and offer a resume-or-fresh
  choice. Pre-push review caught a doctrine doc left stale by omission
  (`docs/contributing/subagent-context-management.md` still described the
  `compact`-only matcher, though the branch never touched that file directly).

- **Slice 3 — PR #878, durable spoke-incident counter.** Closed the gap where
  two work logs recorded spoke-truncation counts as explicitly unrecoverable
  after a mid-task compaction, since they were only held in conversational
  context. `.claude/hooks/detect-spoke-truncation.mjs` now appends a durable
  `{timestamp, agentType, kind: "truncation"}` record to
  `tmp/session-incidents.jsonl` on every detected truncation; a new
  `.claude/hooks/rotate-session-incidents.mjs` clears the file at the start of
  a fresh session; `writing-work-logs` reads it for the "Spoke incidents"
  line. A `claude-pr-review` bot review caught the substantive defect of the
  whole slice: the rotation hook was originally wired to fire on every
  `SessionStart` source, including `compact`/`resume` — deleting the very
  in-flight records the feature exists to preserve. Fixed by scoping the
  matcher to `startup|clear` and adding a belt-and-suspenders `shouldRotate()`
  check inside the hook, mirroring Slice 2's `shouldReinject()` pattern.

Decisions deferred to sensible defaults rather than re-asked mid-plan: the
shared-checkout branch-delete safety matches `worktree-remove.mjs`'s existing
`git branch -d` behavior exactly; `delete_branch_on_merge`'s gate is
warn-severity, not hard-fail; the incident counter rotates at every genuinely
new session start (narrowed from the plan's original "every `SessionStart`"
wording after Slice 3's bot-caught Must-fix showed that phrase needed
`compact`/`resume` explicitly excluded).

## Outcome

All three slices merged and were closed out via the very `finishing-work`
skill Slice 1 delivered, proving it end-to-end against three distinct PRs
across the plan's own lifetime. Two durable lessons from the Slice 3 Must-fix
were promoted into `.claude/rules/harness-artifacts.md` (verify a
`SessionStart`/`PreCompact`/`PostCompact` hook's matcher against its own
purpose, not just against the known-token list) and `.gitignore` (a `.scratch/`
entry, closing a near-miss where a stray subagent journal almost landed in a
commit). Work logs:
[`2026-09-02-finishing-work-skill.md`](../../logs/2026-09-02-finishing-work-skill.md),
[`2026-09-02-reinject-compact-resume.md`](../../logs/2026-09-02-reinject-compact-resume.md),
[`2026-09-02-session-incidents-counter.md`](../../logs/2026-09-02-session-incidents-counter.md).
