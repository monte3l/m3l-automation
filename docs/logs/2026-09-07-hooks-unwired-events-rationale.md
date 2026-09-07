# Work log — hooks-unwired-events-rationale (2026-09-07)

Resolves GitHub issue #999 (ROADMAP H6): `SessionEnd`/`Notification`/
`PostCompact` hook events remain unwired. The issue's complaint was not that
the events are unwired, but that they were unwired "with no repo-recorded
reason for the gap." Re-deriving that claim before acting on it found the
premise had already partly rotted since filing, so the fix is a consolidated
record, not new hook wiring.

## Summary

- Re-derived H6's underlying claim (CLAUDE.md Task Workflow step 1) instead of
  taking the three-day-old tracker row at face value, and found all three
  named events already had a defensible reason on disk — just scattered
  across a hook comment, a research tracker, and a settings key, none of
  which the doc the issue cited actually pointed at.
- New decision note `docs/decision-notes/0003-unwired-hook-events.md`
  (ADR-0095 tier) consolidates the three rationales plus a reusable
  criterion for future lifecycle sweeps: an event stays unwired here when its
  output schema can't carry what the hook needs, when its delivery isn't
  guaranteed for the failure mode it would handle, or when an existing
  first-class setting already does the job.
- `docs/contributing/hooks-reference.md`'s "documented but unused" list split
  so these three carry their reason and link the note, leaving the remaining
  23 unexplained events under the original heading (in scope per the
  maintainer's choice — just the three named by the issue).
- `docs/ROADMAP.md` H6 row flipped `To Do` → `Done`: the deliverable was the
  missing record, and that shipped. No hook was wired.
- `docs/decision-notes/README.md` index gained the new row.
- Docs-only change: no `src/`, tests, or `exports` map touched — zero semver
  impact. Branch `fix/hooks-unwired-events-rationale` in a linked worktree.

Skills used: starting-work, writing-work-logs (this log).

Spoke incidents: none.

Compaction events: none.

## What went as planned

- **Two Explore agents in parallel surfaced the full picture in one round** —
  one mapped the hook wiring/gate/doc surface, the other mapped the
  tracker/ADR/decision-note conventions. Between them and a few direct reads,
  no further exploration was needed before planning.
- **The GitHub MCP tools and `gh` gave a clean, mutually consistent history**
  — issue #999's body, the parent epic #606's sub-issue rollup, PR #1007's
  description, and the sibling H1/H2/H3/H13 commits all agreed on how a
  governance row gets closed out, with concrete precedent to follow rather
  than invent.
- **The decision-note tier (ADR-0095) fit this decision exactly** — the
  reversibility test in `docs/adr/README.md` gave an unambiguous answer
  (wiring any of these three later costs little, nothing depends on the
  non-wiring), so no time was spent deliberating ADR vs. note.
- **`check:hooks`'s blocking doc/settings diff only inspects the inventory
  table**, not the "full documented event set" prose section, so the
  `hooks-reference.md` edit carried no risk of tripping that gate — confirmed
  by reading the gate script rather than assuming.

## What didn't go as planned, and why

### 1. The issue's own premise had rotted between filing and pickup

H6 was filed 2026-09-04 during PR #1007 asserting all three events had "no
repo-recorded reason for the gap." By the time this task picked it up
(2026-09-07), an unrelated 2026-09-06 harness-refresh sweep had already
closed `PostCompact` as not-actionable (`docs/research/harness-refresh.md`),
without touching H6's row or issue #999 — the sweep had no reason to know
about either. Separately, `SessionEnd`'s reason had been sitting in a hook
comment (`reinject-compact-handoff.mjs:13-15`) since before H6 was even
filed, and `Notification`'s had been settled since PR #890, weeks earlier —
the "no repo-recorded reason" claim in `hooks-reference.md` was already
overstated the day H6 was written, not just stale by the time of this task.

**Why it happened:** A tracker row records a snapshot claim at filing time,
but nothing re-checks that claim before the row is worked. Two of the three
reasons already existed _before_ the row was filed and were simply never
cross-referenced against the doc section that made the "no reason" claim; the
third was independently resolved by unrelated work after filing.

**Fix for future:** Before wiring or documenting a fix for a tracker row,
grep for the row's subject terms across `docs/research/`, `docs/logs/`, and
inline code comments before trusting the row's own framing of the gap — the
row's premise is itself an authored claim subject to CLAUDE.md's re-derivation
rule, not a fact to build on unexamined.

## Lessons learned

- **A tracker row's stated gap can already be closed, or closed by someone
  else's unrelated work, between filing and pickup.** "No repo-recorded
  reason" is a claim about the state of the docs at filing time — always
  re-grep before treating it as still true. _(This log's finding is itself
  the concrete instance CLAUDE.md's "Re-derive any authored claim" line
  exists to prevent re-litigating.)_
- **A scattered rationale is not the same as no rationale.** When a "why
  isn't X wired" complaint surfaces, check hook file headers and PR history
  before assuming the reason has to be invented from scratch — three
  independent, already-correct reasons existed here across three different
  file types (a `.mjs` docblock, a `.md` tracker, a `settings.json` key).
- **The decision-note reversibility test resolves ADR-vs-note quickly when
  applied literally.** Ask "would we just change it and move on" rather than
  weighing the decision's importance in the abstract — a governance decision
  about which hook events to wire feels significant, but fails the test the
  moment you note nothing else depends on the non-wiring.
