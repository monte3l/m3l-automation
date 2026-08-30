# 0082. Self-polling cadence for harness-vs-Anthropic freshness

- **Status:** Accepted
- **Date:** 2026-08-30
- **Deciders:** repo maintainer

## Context and problem statement

The local Claude Code harness — agent frontmatter, skills, hooks, rules,
workflows, and `CLAUDE.md` — hardcodes a lot of Anthropic-owned surface: model
IDs, hook event names, `settings.json` schema keys, tool-grant semantics. None
of the repo's `check:*` gates compare any of it to what Anthropic currently
recommends; each is a closed loop that checks the repo's own prior decisions
against itself (`check:agents` against the repo's own `MODEL-MATRIX` block,
`check:hooks` against the repo's own hardcoded event list). Nothing asks
whether those prior decisions are still current.

This repo has already tried the "reminder" instrument once and retired it:
ADR-0030's 2026-08-14 amendment found that Issue #344, carried forward solely
to re-check whether the GitHub MCP toolset had changed enough to revisit that
ADR's gh-CLI-vs-MCP decision, existed only as a periodic re-check reminder
that "nothing in the repo polled" — and retired it rather than keep it. The
mechanism, not just that specific trigger, is the lesson: a reminder nobody
reads is not a cadence. `CLAUDE.md` mandates a ~6-month review of itself
alone; no equivalent exists for the far larger, more Anthropic-coupled
surface this ADR addresses.

## Decision drivers

- A cadence mechanism must be self-polling — a prose reminder with no gate
  behind it has already failed once in this repo (ADR-0030).
- Harness edits (model pins, hook wiring, `settings.json`) are consequential
  enough to stay human-approved, not auto-applied by a sweep.
- The repo's `check:*` gates are cheap, offline, and run on every `pre-push`;
  a new gate should fit that shape rather than requiring network access at
  gate time.

## Considered options

1. **A staleness-stamp file plus a non-blocking `check:*` gate.** A living
   tracker (`docs/research/harness-refresh.md`) records a `last-verified`
   date in a machine-readable header; a new gate warns once it's past a
   threshold, naming the remedy skill.
2. **A checklist item in a sibling skill**, following the
   `promoting-work-log-lessons` precedent (a cadence prompt inside
   `/writing-work-logs` Step 5). Cheapest, but the repo's own
   `skills-catalog.md` already flags that pattern as "still checklist-driven,
   re-audit whether it actually fires."
3. **A scheduled GitHub Actions cron** that runs the sweep headlessly and
   opens an issue on drift. Fully automated, but needs CI-side web access and
   a headless invocation path skills don't have today (skills are hub-only,
   interactive-session constructs).
4. **A content-hash/etag registry per source URL**, flagging any byte-level
   change. Most precise, but noisy — nav/footer edits on a docs page fire
   false positives on every run, and it's new infrastructure this repo has no
   precedent for.

## Decision

We chose **option 1** — the tracker plus a non-blocking `check:*` gate — for
`refreshing-anthropic-guidance`. It is self-polling in the way ADR-0030's
retired reminder was not (a `pre-push` gate actually reads the stamp), reuses this
repo's `bin/lib/report.mjs` reporter convention with no new infrastructure,
and keeps the sweep itself and any harness edits it recommends behind a
human-approved plan (`EnterPlanMode`), matching how `auditing` already
operates. Option 2 was rejected for repeating a pattern the repo's own audit
already flagged as insufficiently proven. Option 3 was rejected as
premature — no skill in this repo runs headlessly today, and adding that path
is a larger change than this decision warrants. Option 4 was rejected as
solving a more precise problem than the one that exists; the per-claim
UNCHANGED/CHANGED/GONE diff the sweep itself produces is a coarser but
adequate signal without the false-positive noise.

## Consequences

- **Positive:** the cadence survives without a human remembering to invoke it
  — `check:harness-freshness` surfaces staleness on every `pre-push` once the
  threshold is crossed. The tracker gives every future sweep a diff baseline
  instead of a full rediscovery.
- **Negative / trade-offs:** the gate is advisory (warns, never blocks) — a
  maintainer can ignore the warning indefinitely, the same way `check:context-budget`'s
  description-length warning can be ignored. The 90-day threshold is a
  judgment call, not derived from any external signal, and may need
  retuning.
- **Semver impact:** none — internal tooling/harness change only, no public
  package export touched.

## Links

- Supersedes / superseded by: none
- Related: ADR-0030's 2026-08-14 amendment (retired a periodic re-check
  reminder for an unrelated trigger, but establishes the "reminder nobody
  polls is not a cadence" precedent this ADR applies to harness freshness),
  `docs/research/harness-refresh.md`,
  `.claude/skills/refreshing-anthropic-guidance/SKILL.md`,
  `bin/check-harness-freshness.mjs`
