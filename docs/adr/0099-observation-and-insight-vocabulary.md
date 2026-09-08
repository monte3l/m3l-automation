# 0099. Observation/insight vocabulary replaces the undefined "lesson"

- **Status:** Accepted
- **Date:** 2026-09-08
- **Deciders:** Enrico Lionello (maintainer); Claude (audit + implementation)

## Context and problem statement

This project runs a retrospective loop: `writing-work-logs` records a work
log's `## Lessons learned` section, and `promoting-work-log-lessons` sweeps
the `docs/logs/` corpus periodically to lift recurring lessons into
`.claude/rules`, agent files, or skills.

The word "lesson" that names the unit moving through this loop was never
actually defined. It was recognizable only extensionally — by where it was
extracted from ("a bullet under `## Lessons learned`, or a `Fix for future:`
line") — with no stated boundary against several already-established
neighboring terms this project also uses: a **finding** (`auditing`'s
verified defect, with a severity and a verdict), a **divergence**
(`writing-work-logs`' numbered incident), a **friction item** (a pending
library change), a **gotcha** (`CLAUDE.md`'s standing known trap), a
**decision** (an ADR or decision note), a **rule** (a destination tier), and
a **convention** (the settled end state a lesson's recurrence is evidence
of). A contributor or an agent reading any one of these terms had to infer
its edges from usage, not from a definition.

Separately, `writing-work-logs` already used the word "insight" informally,
for the raw noticing that feeds a lesson ("non-obvious insights from the
_What went as planned_ section") — a second, undefined sense of a word this
project was about to adopt as its primary term. And "insight(s)" is not free
in this codebase at all: **CloudWatch Logs Insights** (the AWS log-query
service, `scripts/cloudwatch-logs-insights/`, `scripts/cloudwatch-logs-
analysis/`) appears in 361+ doc/source lines, **GitHub Insights** (the
platform's built-in analytics tab, ADR-0050) is named in prose, and Claude
Code's own **`/insights`** usage-reporting command is a named, deliberately
unused evidence source (ADR-0084). Renaming "lesson" to "insight" without
resolving these collisions would trade one ambiguity for four.

## Decision drivers

- The renamed term must be **defined**, not merely relabeled — the actual
  goal is removing ambiguity, not just changing a string.
- The definition must not collide with the four other senses of "insight(s)"
  already live in this repository (informal pre-lesson use, and three
  product names).
- The promotion bar the loop already enforces
  (`promoting-work-log-lessons` Step 2's three filters) must not change as a
  side effect of a vocabulary decision — this is a naming decision, not a
  policy change.
- `docs/logs/*.md` is immutable history
  (`bin/lib/promotion-stamps.mjs`'s own header comment, `docs/logs/
README.md`) — a rename cannot rewrite the 181 work logs and 47 archived
  plans that already say "lesson."
- Minimize blast radius consistent with actually closing the ambiguity: the
  skill that acts on the concept, its slash command, and every gate/catalog/
  test that names it by string all need to move together, or the term and
  the tool diverge.

## Considered options

1. **Flat rename** — "lesson" becomes "insight" everywhere, one term, no new
   distinction. Simplest, but it does nothing about the informal
   pre-lesson sense of "insight" already in `writing-work-logs` — it would
   collide the very term being introduced with the thing it replaces.
2. **Two-stage: observation → insight** — introduce "observation" for the
   raw, run-specific noticing (taking over the role "insight" played
   informally), and reserve "insight" for the generalized, promotable claim
   synthesized from one or more observations. Preserves the real distinction
   that already exists between a log's narrative sections and its
   lessons-learned section, states it explicitly, and gives the informal
   sense of "insight" a real name instead of erasing it.
3. **Pick an unclaimed term** ("takeaway" — zero hits repo-wide; "learning" —
   3 incidental uses) instead of "insight." Avoids every product-name
   collision outright, but does not satisfy the actual request, which named
   "insight" specifically.

## Decision

We chose **option 2, the two-stage observation/insight model**, plus an
explicit glossary page fencing "insight" off from its four existing senses.

- **Observation** — a raw, run-specific noticing, recorded in a work log's
  `## What went as planned` or `## What didn't go as planned, and why`
  section. Tied to one session; not generalized, not itself promotable.
- **Insight** — a generalized, actionable claim about how the project should
  work, synthesized from one or more observations, recorded under a work
  log's `## Insights` section. Carries two states: **candidate** (written
  down, not yet folded into a durable rule/agent/skill) and **promoted**
  (folded in, stamped `_(promoted → <path>)_` in its source log). Promotion
  is a state of an insight, not a precondition for being one — this is what
  lets a work log's own section be named `## Insights` without contradiction.

**The promotion bar is unchanged.** `docs/contributing/glossary.md` states,
rather than alters, `promoting-work-log-insights` Step 2's existing three
filters (recurs across ≥2 logs, or ≥1 log + ≥1 memory; not already promoted;
not already captured). This ADR is a naming decision.

**A boundary table fences "insight" against the seven neighboring terms**
(finding, divergence, friction item, gotcha, decision, rule, convention),
and an explicit "not this term" section names the three product senses of
"insight(s)" (CloudWatch Logs Insights, GitHub Insights, Claude Code's
`/insights`) that stay unrenamed and unclaimed by the new definition.

**`docs/logs/` stays immutable.** The 181 existing work logs and 47 archived
plans keep their `## Lessons learned` / `## Lessons` headings unedited.
`docs/logs/README.md` gains a note that pre-cutover logs use the old
heading, post-cutover logs use `## Insights`, and the two name the same
unit. `promoting-work-log-insights`' Step 1 scan recognizes all observed
heading variants (`## Lessons learned`, `## Lessons`, `## Insights`)
permanently, since the older logs are never rewritten — a sweep matching
only the new heading would silently skip the 175 logs that predate it.

**The skill and its slash command are renamed to match**:
`.claude/skills/promoting-work-log-lessons/` →
`.claude/skills/promoting-work-log-insights/` (`git mv`, preserving history),
with a `RENAMED_TARGETS` entry added to `bin/lib/promotion-stamps.mjs` so
every existing `_(promoted → .claude/skills/promoting-work-log-lessons/
SKILL.md)_` stamp in an immutable log keeps resolving — the identical
mechanism already used for the `sync-docs` → `syncing-docs` skill rename.
Every gate, catalog entry, test, and fixture that names the old skill string
moves with it.

**Land as three PRs** (ADR-0072 reviewable-slice discipline): (1) this ADR
plus the glossary, reviewable as a definition before anything moves; (2) the
skill rename and its mechanical dependents (`RENAMED_TARGETS`, gates,
catalog, tests, fixtures, provenance); (3) the work-log template rename,
dual-heading scan support, and the remaining prose sweep.

## Consequences

- **Positive:** "insight" now has one stated, strict definition in this
  project, with an explicit fence against its four other senses; the
  observation/insight split gives the pre-lesson noticing a real name
  instead of leaving it undefined; the promotion bar and mechanics are
  unchanged, so no behavior regresses; the skill/command/term stay in sync.
- **Negative / trade-offs:** the work-log corpus is now permanently mixed —
  `## Lessons learned` in 168 logs, `## Lessons` in 7, `## Insights` going
  forward — which the sweep skill must keep recognizing indefinitely rather
  than matching one heading; introducing "observation" as a second new term
  alongside "insight" is more vocabulary than a flat rename, accepted
  because it names a distinction (raw noticing vs. generalized claim) that
  already existed informally and was worth stating rather than flattening.
- **Semver impact:** none — this is internal tooling (`.claude/`, `bin/**`)
  and process documentation; it does not touch `packages/m3l-common`'s
  `exports` map.

## Links

- Related: [`docs/contributing/glossary.md`](../contributing/glossary.md)
  (the definition this ADR records); ADR-0084 (retrospective signal
  sources, defines the three evidence arms the promotion bar draws on);
  ADR-0072 (reviewable-slice discipline, the PR-sequence rationale);
  ADR-0051 (semantic priority vocabulary — precedent for a vocabulary
  decision landing as a full ADR); `bin/lib/promotion-stamps.mjs`
  (`RENAMED_TARGETS`, the `sync-docs` → `syncing-docs` precedent this
  rename follows)
