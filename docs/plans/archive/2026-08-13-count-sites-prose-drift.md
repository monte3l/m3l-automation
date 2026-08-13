# Extend count-sites.mjs to the hand-written submodule-name lists

**Status: shipped** — commit `e62b731` on `fix/count-sites-prose-drift`.

## Context

Issue #343 asked to extend `bin/lib/count-sites.mjs` — the shared site
inventory behind `gen:counts`/`check:doc-counts`/`check:impl-counts` — to the
hand-written AWS/Core submodule-count prose sites a 2026-07-28 audit had
explicitly deferred. That deferral's own drift recurred and was hand-fixed a
second time on 2026-08-13 (`2026-08-13-hub-tracking-reconciliation.md`,
decision 4), which filed #343 and, in the same pass, closed the _numeric_
half of the gap (PR #399 added the `implementation-status.md` barrels-table
and `docs/plans/README.md`/`agent-operating-model.md` ledger sites). What
remained open was the harder half: the hand-written submodule **name**
enumerations, which rot independently of an already-correct number sitting
right next to them. An audit at the start of this session found all of them
stale: the three README "Implemented submodules: …" lists (36/24/36 names
against the true 39), both badges' `alt="modules: 25/25"` text (against a
correct `39%2F39` href in the same `<img>` tag), and `docs/README.md`'s
"all 22 submodules now shipped" historical pointer.

## Approach / Decisions

1. **Generate the three README name lists, don't just re-check them by
   hand.** `deriveCounts()` gained `listCoreNames`/`listAwsNames` (additive —
   every existing `countCore`/`countAws` test fixture kept working unchanged)
   and three derived fields: `coreNames`, `awsNames`,
   `qualifiedImplementedNames` (implemented names with AWS entries prefixed
   `aws/`, matching the READMEs' own convention). The marker/splice mechanism
   that previously only covered `docs/implementation-status.md`'s
   implemented-list sentence generalized into `GENERATED_LIST_SITES`, now 4
   entries; `gen-doc-counts.mjs`/`check-impl-counts.mjs` loop the array
   instead of special-casing one file.
2. **Barrel TSDoc lists: assert, never generate.** The two hand-written name
   enumerations in `packages/m3l-common/src/{core,aws}/index.ts` are correct
   today but were unguarded. Generating into them was rejected: that tree is
   guarded (`packages/*/src`), and the AWS list is deliberately
   dependency-ordered rather than alphabetical — a generator would fight that
   ordering choice. `LIST_ASSERTION_SITES` (check-only, `check-doc-counts.mjs`)
   compares the backtick-quoted names against `coreNames`/`awsNames` as a set,
   reporting missing/extra names by name.
3. **Badge alt text and two numeric literals nobody had noticed.** Added the
   numerator/denominator regex-site pair for both READMEs'
   `alt="modules: N/M"` text (previously untracked even though the badge's
   own `href` was already guarded).
4. **ADR-0032's "26/26 submodules" is history, not a live count — don't
   auto-track it.** It sits in a Context section alongside three sibling
   point-in-time counts (work-log count, archived-plan count, ADR count) as
   of the 2026-07-18 decision date; silently rewriting only the submodule
   number would falsify the record and desync it from its own neighbors.
   Reframed explicitly instead: "(26/26 submodules at the time of this
   decision; see the file itself for the current count)". `docs/README.md`'s
   "all 22 submodules now shipped" pointer got the same treatment — the "22"
   is the _original bootstrap plan's_ scope, not a live total, so it was
   reworded to say so explicitly rather than bumped to 39 and added to
   `TOTAL_COUNT_SITES` (which would have re-drifted it from that plan's true
   historical scope on every future submodule).
5. **Verify the generator against the formatter, not just against itself.**
   The three README sites live inside a markdown blockquote; a first pass
   found the generated block's END marker silently dropping its `> ` prefix,
   terminating the blockquote one line early. Fixed with a
   blockquote-specific `buildQuotedBlock` helper. Confirmed empirically (not
   assumed) that the resulting shape is prettier's own steady state —
   `prettier --write` reports "unchanged" against `gen:counts`'s output — so
   the generator and the formatter never fight each other on a future commit.

## Outcome

One commit: `bin/lib/count-sites.mjs` (name-list machinery, 5 new regex
sites), `bin/gen-doc-counts.mjs`/`bin/check-impl-counts.mjs`
(`GENERATED_LIST_SITES` loop), `bin/check-doc-counts.mjs`
(`LIST_ASSERTION_SITES` loop), the three READMEs (marker placement + content
regenerated to the true 39-name list), `docs/adr/0032-…md` (historical
reframing), `.claude/skills/syncing-docs/SKILL.md` (doc reconciliation), and
77 tests in `bin/tests/gen-doc-counts.test.ts` (up from 45, via a
`test-author` spoke). `docs/plans/IMPLEMENTATION.md`'s row flipped to Done.

Verified end-to-end: `gen:counts` is idempotent and its output matches
prettier's steady state exactly; both checkers pass clean; hand-breaking a
generated list or a barrel TSDoc list is caught with a located, actionable
error; full suite (181 files, 6774 tests), typecheck, build, and `pnpm verify`
(36/36 applicable steps) all pass. `pnpm sync:hub` dry-run confirms the
`IMPLEMENTATION.md` row flip resolves to closing issue #343 — `-- --apply`
left for the maintainer, since it mutates shared GitHub state. No
`packages/*/src` or `exports`-map change; zero semver impact.
