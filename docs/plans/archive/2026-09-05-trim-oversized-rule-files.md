# Trim the four oversized `.claude/rules/*.md` files (H13, issue #1022)

**Status: shipped** — PRs #1026, #1033, #1036, #1040.

## Context

`check:context-budget` caps an unbaselined `.claude/rules/*.md` file at
`RULE_CEILING_BYTES = 10,000` — these files load into context automatically
whenever a matching file is edited, so their size is a real per-turn tax.
Four files sat far above it, frozen in `bin/context-budget-baseline.json` at
exactly their then-current sizes: `library-src.md` (31,479 B), `tests.md`
(24,851 B), `scripts.md` (19,334 B), and `subagent-dispatch.md` (16,845 B).
Zero headroom meant any future lesson promotion would fail the gate.

H13 was deliberately deferred out of PR5 of the 2026-09-04
lifecycle-remediation plan so the trim could get its own reviewable pass
(ADR-0072) rather than being folded into that plan's CLAUDE.md trim. The
bloat had a consistent shape: a sound imperative bullet with an incident
narrative appended (token counts, PR numbers, log filenames), plus a layer
of bullets that merely restated `docs/contributing/style-guide.md` or an
Accepted ADR — while each file's own preamble already conceded the canonical
text lives elsewhere ("this file is the terse checklist").

## Approach / Decisions

- **No fixed percentage target.** Trim each file to what its content
  honestly supports; re-baseline at whatever results — landing above
  10,000 B and re-baselining lower is an acceptable outcome, not a failure.
- **Hybrid disposition per bullet:** delete restatements of canonical text;
  relocate genuinely unique reasoning into the canonical doc when it has no
  other home; otherwise collapse to a terse imperative plus a pointer.
- **One PR per rule file**, ascending by size:
  `subagent-dispatch.md` → `scripts.md` → `tests.md` → `library-src.md`.
- **Never edit an Accepted ADR.** A bullet restating ADR-0017/0028/0029/0054/
  0072 collapses to imperative + ADR reference instead.
- A bullet's `docs/logs/*.md` citation is retained whenever the log is the
  only remaining home for its detail.

## Outcome

| PR    | File                   | Before → after                                                                                       | Sink                                                        |
| ----- | ---------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| #1026 | `subagent-dispatch.md` | 16,845 B → under ceiling (dropped from baseline)                                                     | `docs/contributing/subagent-context-management.md`          |
| #1033 | `scripts.md`           | 19,334 B → under ceiling (dropped from baseline)                                                     | `docs/contributing/style-guide.md` + ADR-0028/0029/0054     |
| #1036 | `tests.md`             | 24,851 B → 9,981 B (dropped from baseline)                                                           | `docs/contributing/style-guide.md` § Part 2                 |
| #1040 | `library-src.md`       | 31,479 B → 17,158 B (re-baselined lower — most unique content, least duplication of any of the four) | `docs/contributing/style-guide.md` § Part 1 + ADR-0017/0072 |

Each PR was verified content-preserving, not just size-reducing: every
deleted narrative is either present in its canonical sink or still reachable
via a retained `docs/logs/*.md` citation, confirmed by a `docs-consistency-reviewer`
dispatch scoped to that PR's two changed files before opening it. `pnpm verify`
passed cleanly on all four; no test, `src/`, or `exports`-map changes — zero
semver impact throughout.

`docs/ROADMAP.md`'s H13 row flips to `Done`; `pnpm sync:hub -- --apply` closes
issue #1022.
