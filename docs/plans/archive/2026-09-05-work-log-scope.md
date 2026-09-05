# Reconcile work-log scope to one criterion (issue #996, H3)

**Status: shipped** — PR #1045.

## Context

`docs/ROADMAP.md`'s H3 governance row (synced to GitHub issue #996,
user-flagged high priority) reported a two-way contradiction:
`docs/logs/README.md` declared work logs **pipeline-scoped** — "submodule and
script implementation units get one; chore/docs/CI PRs deliberately do not"
— while `finishing-work`/SKILL.md Step 6 prompted for a log after **any**
merge with no scope filter, leaving the executor to apply the README rule at
answer-time.

Re-deriving the premise before acting on it (per `CLAUDE.md`'s Task Workflow
rule) found it inverted: `finishing-work` was the accurate side, and the
README rule was the stale one. 82 of the 150 files in `docs/logs/` were added
by non-pipeline commits (78 `docs:`, 3 `chore:`, 1 `ci:`), including exactly
the governance work this backlog keeps producing —
`2026-09-05-document-merge-step.md` (H1), `2026-09-05-trim-oversized-rule-files.md`
(H13), `2026-09-04-check-no-docker.md`, `2026-09-03-dependabot-commit-subject-gate.md`.
The README's own `## Workflow / infra` table already indexed ~11 such logs
its own rule said shouldn't exist. It was also a four-way drift, not two:
`docs/contributing/skill-routing.md` said "a significant task" and
`docs/contributing/agent-operating-model.md` said "per-submodule work logs"
— neither matching the README or `finishing-work` either. None of the four
was machine-enforced; `bin/check-retrospective.mjs` only counts logs for
sweep-cadence freshness and is advisory-only.

## Approach / Decisions

- **Broadened the README to match practice, not narrowed `finishing-work` to
  match the README** — a substance test (does the unit of work produce a
  real narrative worth re-reading?) rather than a commit-type filter,
  confirmed with the user before writing since either direction was
  defensible on the issue text alone.
- **One canonical statement, three link-backs.** `docs/logs/README.md` is
  now the single source; `finishing-work` Step 6, `skill-routing.md`, and
  `agent-operating-model.md` link to it instead of restating a criterion —
  removing the drift surface itself rather than reconciling four independent
  wordings by hand. `writing-work-logs/SKILL.md` needed no rewrite (it
  already supports freeform/non-submodule slugs) but gained a one-line
  pointer so it doesn't re-decide scope either.
- **Left the stale README index (81 of 150 logs missing) and the H1/H13
  ROADMAP citations of the old wording alone** — explicitly out of scope,
  confirmed with the user: a much larger backfill, not a scope-rule fix, and
  the ROADMAP's H3 row itself only updates at tracker-flip time
  (`finishing-work` Step 5).
- Shape follows the already-landed sibling fix for the commit-timing
  contradiction between the same two files, PR #1020
  (`docs/plans/archive/2026-09-04-lifecycle-friction-remediation.md`).

## Outcome

`docs/logs/README.md`'s scope paragraph replaced; `finishing-work`/SKILL.md
Step 6 gained an explicit mechanical-merge skip and Step 9's report line
gained an `n/a (out of scope)` outcome; `skill-routing.md`'s knowledge-loop
row and `agent-operating-model.md`'s lessons-learned bullet now link to the
README instead of restating a criterion; `writing-work-logs/SKILL.md` gained
a one-line pointer. Docs/`.claude`-only, zero semver impact — no `src/`,
test, or `exports`-map change. `docs/ROADMAP.md`'s H3 row flips to `Done`
and issue #996 closes on the post-merge `pnpm sync:hub -- --apply` run
(`finishing-work` Step 5), matching this repo's standard close-out sequence.
