# Semantic priority vocabulary for labels, milestones, and tracker cells

**Status: shipped** — PR `feat/semantic-priority-vocabulary` (commit `9460bae`).

## Context

The user asked to assess replacing the `p0`/`p1`/`p2` letter-and-number
priority scheme (GitHub labels, milestones, and `docs/plans/IMPLEMENTATION.md`
tracker cells) with a semantic and meaningful vocabulary.

An `/auditing` fan-out over three facets — the live GitHub label/milestone
surface, the code blast radius across `bin/lib/hub-sync.mjs` and
`bin/lib/project-hub.mjs`, and the docs/tracker surface — found the scheme had
drifted into six independent naming registers for one concept (label,
milestone, tracker cell, ROADMAP heading, internal union key, and the
`extractRoadmap` result-shape key), with `governance` alone spelled three
different ways and filed under the `priority:` label prefix despite
`classifyPriorityCell` never treating it as a tier. The audit also found
`ROADMAP_ANCHORS` had been emitting a truncated, non-matching GitHub anchor
slug since it was written.

## Approach / Decisions

**Numbered-semantic hybrid, chosen over three alternatives.** `priority:0-now`
/ `1-next` / `2-later` was picked over a pure-semantic form
(`priority:now`/`next`/`later`, which sorts out of tier order in GitHub's
alphabetical label sidebar), a severity register (`critical`/`high`/`low`,
which would misdescribe roadmap sequencing as defect severity), and the
literal existing gloss (`unblock-first`/`fleet`/`gated`, where `gated`
specifically misdescribes the many `Later`-tier rows that are simply deferred,
not blocked on a real gate).

**`governance` moved out of the priority namespace entirely**, to
`type:governance`. It had never behaved as a fourth tier —
`classifyPriorityCell` (`bin/lib/project-hub.mjs`) has no governance branch; a
governance row's Priority cell is always the untiered dash placeholder. Filing
it under `priority:` was the taxonomy bug the audit surfaced, not a design
choice worth preserving.

**Deliberately bounded blast radius.** `docs/ROADMAP.md`'s `## Priority N`
section headings and the internal `Item.priority` union / `roadmap:p0:<slug>`
issue-marker keys were left unchanged — renaming either would need to migrate
148 issues' persisted markers via `Item.legacyKeys` for no reader-facing
benefit, since the confusion this fixes lives entirely on the GitHub-facing
label/milestone/cell surface, not in identifiers a reader never sees.

**Migration: rename in place, never delete-and-recreate.** `gh label edit
--name` and a milestone `PATCH` preserved all 148 existing issue-label
assignments atomically. `isManagedLabel`/`staleManagedLabels`
(`bin/lib/hub-sync.mjs`, `bin/sync-hub-issues.mjs`) gained a `type:` prefix
alongside `priority:`/`status:`, so any label that had somehow been skipped by
the in-place rename would still self-heal on the next `sync:hub --apply`.

**Two new guardrails closed gaps the audit found, not just the rename itself.**
`bin/check-hub-keys.mjs` gained `findPriorityVocabularyMismatches`, asserting
`PRIORITY_LABELS`/`MILESTONE_TITLES`/`ROADMAP_ANCHORS` stay mutually
consistent — previously a partial rename across those three tables failed only
at runtime as a silently `undefined` milestone lookup. `bin/check-label-drift.mjs`
(new `check:label-drift`, push-only in CI) compares the live repository's
labels against `bin/lib/label-defs.mjs`; `check:hub-drift` only ever inspected
an issue's own labels against its tracker row, never the label objects
themselves.

**Guarded-path test edits went through `test-author`, dispatched in parallel
across independent files.** `bin/tests/{project-hub,hub-sync,hub-sync-runners,
check-hub-keys}.test.ts` and the three new test files for `label-defs.mjs`/
`label-drift.mjs`/`check-label-drift.mjs` were each an independent spoke
dispatch. One spoke's first pass correctly flagged that the hub's briefing had
omitted a downstream rename (`classifyPriorityCell`'s cell vocabulary cascading
into `actionableItems` fixtures); it was resumed via `SendMessage` with the
missing context rather than re-dispatched fresh, and the fix landed clean on
the second pass. A `fork` dispatch aimed at the same follow-up mis-targeted the
hub's own identity (a fork forks the hub, not a named spoke) and was
self-diagnosed and stopped before writing anything, in favor of the correct
`SendMessage` resume.

## Outcome

- `docs/adr/0051-semantic-priority-vocabulary.md` — new; ADR-0032 marked
  partially superseded (its visibility-hub architecture and key-namespacing
  decisions are unaffected and remain in force)
- `bin/lib/hub-sync.mjs` — `PRIORITY_LABELS`/`MILESTONE_TITLES` renamed; new
  `TYPE_LABELS`; `ROADMAP_ANCHORS` exported and corrected to real GitHub
  anchor slugs; `isManagedLabel` gained the `type:` prefix
- `bin/lib/project-hub.mjs` — `classifyPriorityCell` recognizes
  `Now`/`Next`/`Later`; the `IMPLEMENTATION.md` gated-section heading renamed
  `(P2)` → `(Later)`
- `bin/check-hub-keys.mjs` — new `findPriorityVocabularyMismatches` gate
- `bin/lib/label-defs.mjs` (new, extracted from `bin/sync-hub-issues.mjs`) +
  `bin/lib/label-drift.mjs` + `bin/check-label-drift.mjs` (new
  `check:label-drift` gate, wired into `package.json`,
  `bin/lib/command-catalog.mjs`, `bin/lib/verify-steps.mjs`,
  `.github/workflows/ci.yml` push-only)
- `docs/contributing/filing-work.md` — new priority legend (tier meanings and
  how to choose one — previously undocumented anywhere)
- `docs/plans/IMPLEMENTATION.md` — 74 Priority cells renamed
  (`P0`→`Now`/`P1`→`Next`/`P2`→`Later`); header gloss rewritten
- 7 test files (4 edited, 3 new) — 51 net new/updated test cases, all via
  `test-author`
- Live GitHub settings applied (maintainer-local, `gh` CLI): 4 labels renamed
  in place, 3 milestones renamed, `sync:hub -- --apply` relabeled 15 open
  issues, converged to zero drift on the next dry run; `check:label-drift` and
  `check:hub-drift` both pass live
- `pnpm verify`-equivalent: full suite 181 test files / 7,250 tests (library)
  plus 45 files / 1,233 tests (`bin/`), lint, typecheck, build, format,
  markdown lint all green
