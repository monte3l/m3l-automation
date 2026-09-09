# Replace "lessons" with a strictly defined "insight"

**Status: shipped** — `feat/lessons-to-insights`, three PRs (definition,
skill rename, work-log template rename).

## Context

The retrospective loop moved an undefined "lesson" through work logs into
`.claude/rules`/agents/skills, with no stated boundary against several
already-established neighboring terms this project also uses: a finding
(`auditing`'s verified defect), a divergence (a work log's numbered
incident), a friction item (a pending library change), a gotcha (a standing
known trap), a decision (an ADR or decision note), a rule (a destination
tier), and a convention (the settled end state a lesson's recurrence is
evidence of). The word was recognizable only extensionally — "a bullet under
`## Lessons learned`" — never defined.

Renaming to "insight" on its own would have collided with an existing
informal use: `writing-work-logs` already used "insight" for the raw
noticing that feeds a lesson. "Insight(s)" is also not free elsewhere in the
codebase — CloudWatch Logs Insights (361+ lines), GitHub Insights, and
Claude Code's own `/insights` command are three unrelated product senses
already in use.

## Approach / Decisions

A two-stage **observation → insight** model, chosen over a flat rename: an
**observation** is the raw, run-specific noticing (a work log's "What went
as planned"/"What didn't go as planned" sections), and an **insight** is the
generalized, actionable claim synthesized from one or more observations (the
work log's fourth section, now `## Insights`). This preserves the real
distinction that already existed rather than flattening it, and gives the
informal pre-lesson sense of "insight" a real name of its own
(`docs/contributing/glossary.md`, ADR-0099).

Two constraints shaped the blast radius:

- **`docs/logs/` is immutable history** — 181 existing work logs and 47
  archived plans keep their `## Lessons learned`/`## Lessons` headings
  unedited; `promoting-work-log-insights`' scan now recognizes all three
  heading variants permanently, since the older logs are never rewritten.
- **The promotion bar is unchanged** — the glossary states, rather than
  alters, the existing three-filter recurrence bar. This was a naming
  decision, not a policy change.

The skill `promoting-work-log-lessons` was renamed to
`promoting-work-log-insights` (`git mv`, preserving history) to keep the
term and the tool that acts on it in sync, with a `RENAMED_TARGETS` entry
added to `bin/lib/promotion-stamps.mjs` (the same mechanism the
`sync-docs` → `syncing-docs` rename used) so every existing
`_(promoted → .claude/skills/promoting-work-log-lessons/SKILL.md)_` stamp in
an immutable log keeps resolving.

Landed as three PRs (ADR-0072 reviewable-slice discipline): definition only
(glossary + ADR-0099, reviewable on its own merits), the skill rename and
its mechanical dependents (gates, catalog, tests, fixtures, provenance), and
finally the work-log template rename plus a full prose sweep of every
remaining live-prose reference. ADR bodies, decision-notes/0005, and
`docs/logs/`/`docs/plans/archive/` narration were deliberately left
untouched — they describe what was true when written, matching the
immutability convention.

## Outcome

`docs/research/retrospective.md` (a living ledger, not immutable narrative)
got a full in-place terminology sweep including its `no-durable-lesson` →
`no-durable-insight` outcome token across all 155 rows. `pnpm verify
--continue` passed 80 of 81 steps (the one failure, a `js-yaml`/`nodemailer`
dev-dependency audit finding, is pre-existing on `main` — confirmed via an
empty `pnpm-lock.yaml`/`package.json` diff against `origin/main`), including
`check:promotion-stamps` (313 stamps / 107 reverse citations all resolve),
`check:skill-frontmatter`, `check:skill-evals`, `check:retrospective`, and
the full 21,315-test suite across all four coverage configs.

Related: [`docs/contributing/glossary.md`](../../contributing/glossary.md),
[ADR-0099](../../adr/0099-observation-and-insight-vocabulary.md).
