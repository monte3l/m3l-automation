# Close the `docs/logs/` index drift loop

**Status: shipped** — PR #1046, PR #1049.

## Context

`docs/logs/README.md`'s six index tables had drifted from `docs/logs/`'s
actual contents — 81 of 149 non-README log files (later 83, as a few more
landed before the fix shipped) had no row in any table. This was the third
occurrence of the same drift, logged twice before without a fix:
`docs/logs/2026-07-22-promotion-audit.md` ("tables stopped at 2026-07-16
while ten…") and `docs/logs/2026-09-03-x8-open-items.md` (five same-day logs
never indexed). The root cause was that nobody owned the index row — no
skill step wrote it, no gate verified it — so it was orphaned work skipped
whenever the author didn't happen to remember it.

## Approach / Decisions

- **Two sequenced PRs, not one.** PR 1 landed the gate, the skill step, and
  the maintenance note first; PR 2 (the backfill) branched only after PR 1
  merged, so the gate's own regression coverage existed before the data it
  would eventually verify.
- **`check:logs-index` is advisory** (`warn`, exit 0 always), following
  `check:retrospective`'s precedent, and asserts four things: every log has
  exactly one row (coverage), every row's link resolves (no dangling links),
  no log is linked twice (no duplicates), and each row's date column matches
  its filename's date prefix.
- **The skill fix, not just the gate, was the point.** `/writing-work-logs`
  gained an explicit "add the row in the same commit" instruction under Step
  3 — folded into the existing step rather than inserted as a new numbered
  one, since Steps 4/5 are cited by number from three other live docs and
  renumbering them was out of scope for this change.
- **Backfill rows are mechanically derived, not hand-authored to match
  neighboring rows' richness.** Link text is the filename minus its date
  prefix and `.md`; the descriptor is each log's H1 heading with the
  `Work log — ` prefix and trailing date stripped. Four logs whose H1 didn't
  follow that shape got a hand-written descriptor instead of a mechanical
  one.
- **Table layout extended six sections, added four.** The uncovered waves —
  `core/pipeline` migration, Agent-reliability (A-series), Bedrock
  (`aws/bedrock-runtime`), and Harness/statusline — each got a new H2 section
  rather than being folded into an existing one, keeping `## Workflow /
infra` from tripling in size.
- **The retrospective tracker's stale "backlog is currently zero" prose was
  corrected, but `logs-considered=135` was deliberately left alone** — that
  header records what a sweep actually considered, and bumping it would have
  asserted a `/promoting-work-log-lessons` sweep that never ran.
- **PR 2's scope grew from 81 to 83 rows between planning and execution** —
  a few logs landed during PR 1's own review cycle. The backfill re-derived
  the missing set at execution time rather than trusting the plan's static
  count, and picked up the two extra rows into the new sections their
  content matched.

## Outcome

`bin/lib/logs-index.mjs` + `bin/check-logs-index.mjs` (new,
`pnpm check:logs-index`), `bin/tests/check-logs-index.test.ts` (24 cases),
`.claude/skills/writing-work-logs/SKILL.md` Step 3, `docs/logs/README.md`'s
new "Maintaining this index" section, and `docs/research/retrospective.md`'s
corrected prose landed in PR 1 (#1046). PR 1 also fixed a reviewer-flagged
gap before merge: the row-link regex only captured the first link on a row
citing more than one log. PR 2 (#1049) backfilled all 83 rows the gate had
flagged, verified by a deliberate rename/restore round-trip and a
`docs-consistency-reviewer` pass that found zero issues. `check:logs-index`
now reports zero findings — 152/152 logs indexed.
