# Adopt genuine gaps from the Claude Code Insights report

**Status: shipped** (PR #116, commit `8e2a7cb`)

## Context

An `/auditing` pass compared every recommendation in a Claude Code Insights
usage report against the live repo, using three parallel Explore agents
covering hook/git-op coverage, CLAUDE.md/rules guidance, and the skills/
agents inventory. Most of the report's recommendations turned out to be
false positives — things the repo already enforced heavily (branch/worktree
isolation, triple-layer signed commits, pre-push formatting, the audit → TDD
→ review → PR skill chain, verify-before-acting, headless Claude in CI).
Only two recommendations survived verification as real, repo-tracked gaps:
no response-length/output-size guidance anywhere in CLAUDE.md (mapping to
the report's most damaging friction — sessions lost to output-token-max
errors), and no repo-tracked note that `git rebase --continue`/`git
checkout` skip the pre-commit prettier hook (a lesson that had lived only in
private auto-memory).

## Approach / Decisions

- Doc-only change set — no `src/`, `tests/`, or `scripts/*/src` files — kept
  terse to respect CLAUDE.md's own length-discipline note.
- Added a compact `## Response Style` subsection to CLAUDE.md: keep chat
  responses concise, write long deliverables (audits, plans, ADRs, triage
  reports) to a file with only a short chat summary, and split a response
  across turns if it would still run very large.
- Reinforced the same reminder at the point of use in the skills that emit
  large inline reports: `triaging-ci`, `triaging-scan-alerts`, and
  `promoting-work-log-lessons` (skills already file-based, like `auditing`
  and `writing-work-logs`, needed no change).
- Added one Git Workflow bullet to CLAUDE.md documenting that `git rebase
--continue`/`git checkout` bypass the pre-commit prettier hook, so
  `pnpm format:check` should be run before pushing rather than relying on
  the parallel pre-push lane to catch it — promoting the lesson out of
  private memory into repo-tracked guidance, mirrored in
  `resolving-merge-conflicts/SKILL.md` at its rebase step.
- Deliberately left as-is: a consolidated `ship` skill and a `claude -p`
  headless CI-triage job — both intentional omissions given the
  hub-and-spoke design, not gaps.

## Outcome

CLAUDE.md gained the `## Response Style` subsection and the rebase/format
Git Workflow bullet; the three large-output skills and
`resolving-merge-conflicts` got matching point-of-use reminders. No
count/export/provenance sites were touched, so `gen:counts` and the doc-count
checks stayed green with no regeneration needed.
