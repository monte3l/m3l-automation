# Glossary

This project runs a retrospective loop — work logs record what happened, a
periodic sweep lifts the durable parts into `.claude/rules`, agent files, and
skills. The unit that moves through that loop used to be called a "lesson,"
a word this project never actually defined: it was recognizable only by where
it was extracted from, which left its boundary against several neighboring
terms (a finding, a divergence, a gotcha, a decision, a rule) to the reader.
This page is that definition, made explicit — plus a boundary against every
term it could be confused with, including three unrelated products that
happen to share the word "insight."

Nothing here changes what qualifies for promotion. It names, precisely, what
already operates.

## Observation and insight

Two stages, in order — an observation is raw material; an insight is what an
observation becomes once it generalizes.

### Observation

A raw, run-specific noticing recorded in a work log's `## What went as
planned` or `## What didn't go as planned, and why` section
([`writing-work-logs`](../../.claude/skills/writing-work-logs/SKILL.md) Step
2). It is tied to the one session that produced it: "the test-author added
two `eslint-disable` blocks that had to be cleaned up after GREEN" is an
observation — true of this run, not yet claimed to be true of the next one.

An observation is not generalized and not, by itself, actionable beyond the
run it describes. It is not a promotion candidate. It becomes one only by
synthesis, below.

### Insight

A generalized, actionable claim about **how this project should work**,
synthesized from one or more observations and recorded under a work log's
`## Insights` section. "Never add RED-phase eslint-disable blocks for
import-resolution errors — lint warnings are acceptable in the RED state" is
an insight: it generalizes past the one run that surfaced it, into a claim
about every future run.

Every bullet under `## Insights` leads with a bolded 2–6 word keyword phrase
naming the insight, followed by one or two sentences of specific, actionable
guidance — the exact shape `writing-work-logs`' template requires, and the
shape [`promoting-work-log-insights`](../../.claude/skills/promoting-work-log-insights/SKILL.md)
scans for when clustering recurring insights across logs.

**An insight has two states:**

- **Candidate** — written down, not yet folded into a rule, agent file, or
  skill anywhere a future session actually reads unprompted. Most insights
  start and stay here; a single work log's own bullet is not itself a
  behavior change.
- **Promoted** — folded into its durable home
  ([`instruction-authoring.md`](./instruction-authoring.md) routes the
  six tiers) and stamped in its source log(s) with
  `_(promoted → <path>)_`. Promotion is what makes an insight actually
  change future behavior; an unpromoted insight is a candidate no matter how
  many logs repeat it.

**The promotion bar** (unchanged by this page — restated here for one place
to look it up) is `promoting-work-log-insights` Step 2's three filters, all
required:

1. **Recurs** across ≥2 distinct work logs, or ≥1 log and ≥1 independent
   auto-memory entry (corroboration through a second, differently-triggered
   mechanism counts at least as strongly as a second log).
2. **Not already promoted** — no existing `_(promoted → …)_` marker on it.
3. **Not already captured** in `.claude/rules`, `.claude/agents`, a skill, or
   ADR prose.

A theme that clears all three is a real gap: something the project keeps
re-learning that its durable instructions still don't mention.

## Boundary against neighboring terms

Several other terms already carry a specific meaning in this project and are
easy to confuse with an insight. None of them are renamed by this page —
this table exists so a candidate insight is routed to the right one instead
of colliding with it.

| Term              | Owned by                                                             | What it means here                                                                                               | How it differs from an insight                                                                                                                                              |
| ----------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Finding**       | [`auditing`](../../.claude/skills/auditing/SKILL.md), ADR-0097       | A defect or gap discovered by reading _live code_, carrying a severity and a verify/refute verdict.              | A finding is evidence about the present state of the codebase; an insight is a generalized claim about how to work, drawn from _logged history_, not a live-code read.      |
| **Divergence**    | `writing-work-logs`' `## What didn't go as planned, and why`         | A numbered incident: what happened, `Why it happened:`, `Fix for future:`.                                       | A divergence is an observation — one run's specific incident. It is raw material an insight may later be synthesized from, not itself promotable.                           |
| **Friction item** | `writing-work-logs` Step 4, `docs/plans/IMPLEMENTATION.md`           | A concrete _pending library change_ a log surfaced — a missing API, a deferred capability.                       | A friction item is a request for the library to change; an insight is a claim about how contributors should work. They can share a source log without being the same thing. |
| **Gotcha**        | `CLAUDE.md` § Known Gotchas, `.claude/rules/tests.md`                | A surprising, already-known trap stated as standing context, with no promotion lifecycle or evidence bar.        | A gotcha is already a settled, standing fact; an insight is a candidate still working through the recurrence bar above before it earns that standing.                       |
| **Decision**      | `docs/adr/`, `docs/decision-notes/`, ADR-0094/0095                   | A choice made before or during work, recorded as an ADR (hard to reverse) or a decision note (low blast radius). | A decision is made prospectively, to guide work not yet done; an insight is discovered retrospectively, from work already done.                                             |
| **Rule**          | `.claude/rules/*.md`                                                 | A path-scoped, enforced or advisory constraint — a destination tier, not a discovery.                            | A rule is where a promoted insight can end up living; it is a tier, not a kind of finding.                                                                                  |
| **Convention**    | `docs/contributing/style-guide.md`, the promotion bar's own filter 1 | A settled general practice — the mature end state an insight's recurrence is evidence of.                        | "Convention" describes the property (settled, general) that makes something promotable; "insight" names the unit moving through the promotion pipeline toward that state.   |

## Not this term

Three unrelated names already use the word "insight(s)" in this repository.
None of them are the project term defined above, and none are renamed by
this page:

- **CloudWatch Logs Insights** — the AWS log-query service
  (`scripts/cloudwatch-logs-insights/`, `scripts/cloudwatch-logs-analysis/`,
  `docs/reference/aws/clients.md`). An AWS product name.
- **GitHub Insights** — GitHub's built-in repository analytics tab
  (ADR-0050 § GitHub platform feature stance). A GitHub product name.
- **Claude Code's `/insights`** — the CLI's own usage-reporting command
  (ADR-0084 § Retrospective signal sources). A Claude Code product name,
  and explicitly _not_ a source this project's retrospective loop reads (it
  has no machine-readable export).

Where any of these three could be ambiguous in prose, spell out the full
product name ("CloudWatch Logs Insights", "GitHub Insights", "Claude Code's
`/insights`") rather than the bare word.

## See also

- [`writing-work-logs`](../../.claude/skills/writing-work-logs/SKILL.md) —
  writes the `## Insights` section this page defines
- [`promoting-work-log-insights`](../../.claude/skills/promoting-work-log-insights/SKILL.md) —
  the cross-log sweep that promotes candidate insights
- [Instruction authoring](./instruction-authoring.md) — the six tiers a
  promoted insight is routed to
- [`docs/research/retrospective.md`](../research/retrospective.md) — the
  sweep ledger tracking which logs have been considered
- [ADR-0099](../adr/0099-observation-and-insight-vocabulary.md) — the
  decision record for this vocabulary
