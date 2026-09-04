# Document the merge step for a human-authored PR (issue #994, H1)

**Status: shipped** — PR #1031.

## Context

`docs/ROADMAP.md`'s H1 governance row (synced to GitHub issue #994,
user-flagged high priority) recorded a real seam in the PR lifecycle:
`creating-prs`/SKILL.md ended at Step 14, "Confirm mergeability" — a
`gh pr view` check — and never ran `gh pr merge`. `finishing-work`/SKILL.md
Step 1 only knew what to do once a PR already showed `state: "MERGED"`, and
dead-ended on `OPEN` with "nothing else in this skill is safe to run." The
only skill with real merge automation, `reviewing-dependabot-prs`, is
explicitly scoped away from human PRs. So the arm/merge decision for a
human-authored PR lived only in conversation, with no documented default —
even though `creating-prs` Step 7 already presumed an answer ("when the PR
will carry GitHub auto-merge…") without ever supplying one.

That silence had a cost the repo's own work logs had already priced: three
U10 PRs auto-merged before their review verdict landed, twice while a spoke
was still fixing the same PR
(`docs/logs/2026-09-02-u10-orchestration-engine.md`), and #951's reviewed
commit was orphaned outright when a follow-up push raced an armed auto-merge
(`docs/logs/2026-09-03-u11-retry-resume-cancellation.md`). That log drew the
lesson — leave auto-merge unarmed on any PR expecting a review round — but it
had never been promoted out of a log into an executable skill step.

## Approach / Decisions

- **Extended `creating-prs`, not a new skill.** The skill-listing budget
  (`check:context-budget`) had only 261 chars of headroom against its
  8,000-char hard ceiling, well under the ~350-char mean skill description —
  a new prose-invocable skill would have failed the gate outright. A new
  terminal `### 15 — Decide the merge path` costs zero listing budget.
- **Default: wait for the review verdict, then plain `gh pr merge --squash`.**
  Arming `gh pr merge --auto --squash` is the opt-in exception, for a PR
  expected to take the `docs-consistency-reviewer` path (no review round to
  race). This directly encodes the U10/U11 lesson as the documented default
  rather than leaving it to session-by-session judgment.
- **Two hard guardrails, both traced to a live setting rather than assumed:**
  never `--admin` (`enforce_admins: true` on both `main` protection layers —
  confirmed via `gh api`), and never press GitHub's "Update branch" button
  (confirmed `strict_required_status_checks_policy: false` on both layers,
  which also meant `docs/contributing/branch-protection.md` had drifted —
  corrected in the same PR since the guardrail depends on it). The button
  rewrites commits via GitHub's web-flow signing key, unverifiable against
  the local keyring on a later rebase.
- **`finishing-work`'s OPEN dead-end now points at the new step** instead of
  stopping bare — the PR isn't merged because the merge decision hadn't had a
  documented home, and now it does.
- **Regression coverage via two new eval cases**, not just prose: one pins
  the default (`src/**` change, no verdict yet → plain squash, never
  `--auto`, never `--admin`), the other pins the opt-in (docs-only PR →
  `--auto --squash` is acceptable, tradeoff stated).

## Outcome

`creating-prs`/SKILL.md gained Step 15 and an updated frontmatter
description; `finishing-work`/SKILL.md's opening paragraph and Step 1 OPEN
branch now reference it; `docs/contributing/branch-protection.md` and
`docs/contributing/skills-catalog.md`/`skill-routing.md` were corrected and
extended to match; `.claude/skills/creating-prs/evals/evals.json` grew from 4
to 6 cases. `docs/ROADMAP.md`'s H1 row flipped to `Done`; issue #994 closes
on the post-merge `pnpm sync:hub -- --apply` run (`finishing-work` Step 5),
not on merge alone.
