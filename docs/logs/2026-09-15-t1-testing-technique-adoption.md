# Work log — T1, testing-technique adoption (ADR-0104) (2026-09-15)

**Plan of record:**
[`docs/plans/2026-09-15-testing-technique-adoption.md`](../plans/2026-09-15-testing-technique-adoption.md)
**Decision of record:**
[ADR-0104](../adr/0104-testing-technique-adoption.md)
**Shipped:** PR #1270 (merge commit `1269f942`), slice T1 of 11.

## Summary

T1 is the docs-only first slice of an 11-slice wave adopting mutation testing
(Stryker) and property-based testing (fast-check), plus a determinism-hardening
sweep of the existing Vitest setup. It records ten decisions, two declines
(jazzer.js, Toxiproxy), two refuted "gaps", and the boundary that makes the
whole wave admissible: ADR-0015's standing "each new gate must cover something
not already covered" bar governs SAST **platforms**, and has never been applied
to test-generation techniques.

The substantive finding driving the wave is that `.claude/rules/tests.md:20-36`
_mandates_ mutation testing and encodes its theory correctly — equivalent
mutants, mutations that never applied, guards going vacuous later — while
automating, recording and enforcing none of it. A test can ship with zero
mutation evidence and pass every gate.

The decisive argument turned out to be a harness one rather than a
test-quality one, and it is worth restating because it is what made the
decision easy: manual mutation testing edits real source files, spokes run
concurrently off a shared git stack, and `tests.md:27-29` already concedes
scripted mutation is unreliable. A spoke truncating mid-mutation leaves the
guard deleted or **inverted** under a correct-sounding comment. Stryker mutates
a sandbox copy, so that failure class disappears by construction — which is why
`--inPlace` is recorded as a hard prohibition rather than a preference.

## What went as planned

- The ADR gate chain behaved exactly as documented: `check:adr-index`
  (reciprocity, closed verb set), `check:adr-claims`, `check:adr-provenance`,
  `check:adr-worthiness`, `check:landing-plans`, `lint:md`, `format:check`.
- `re-affirmed-by` on ADR-0015 and ADR-0034 needed no reciprocal entry, per
  `RECIPROCAL_VERB` in `bin/lib/adr-index.mjs` deliberately omitting it. The
  corpus convention (the _older_ ADR carries the verb, as in ADR-0012's
  `re-affirmed-by: 0023`) held.
- ADR-0034's stale `corepack` prerequisite was swept as an in-file Update with
  the decision untouched — the same treatment ADR-0015's own 2026-08-13 Update
  applied to its surviving stale claims.
- The `review` check passed in 9 seconds on a markdown-only diff, and
  `check:review-size` measured the diff at 0 reviewable chars. Both are the
  documented markdown blind spot, and the reviewer spoke was run by hand
  because of it. That was the right call — see below.

## What didn't go as planned, and why

### 1. `lint:library`'s heap exemption expired, and nothing noticed

`pnpm verify --continue` exited 1 on a docs-only branch. The sole failure was
`pnpm lint:library`: `FATAL ERROR: Ineffective mark-compacts near heap limit`,
exit 134, at Node's ~2 GB default. Re-run with
`NODE_OPTIONS=--max-old-space-size=6144`, it passes clean.

The cause is not a forgotten flag. PR #1134 (2026-09-08,
[earlyoom-process-matching](./2026-09-08-earlyoom-process-matching.md)) added
`--max-old-space-size=8192` to `lint:workspace` **only**, and that log records
the reason explicitly: "`lint:library` does not cross the ceiling." That was a
measured claim, and it was true when written. Seven days later it is false.
`packages/m3l-common` grew past the default heap in the interval, and because
`lint` is `lint:library && lint:workspace`, the _unprotected_ script is now the
one that runs first and dies.

Two things kept this invisible:

- **CI cannot see it on a docs PR.** `Lint (library)` path-skips and `verify`
  passes in ~3 s, so PR #1270 went fully green while local `verify` exited 1.
- **The background-task notification reported exit code 0** while the real exit
  was 1. Only the `REAL_EXIT=$?` line written into the log caught it.

Left unfixed deliberately — out of T1's docs-only scope, and it touches
`check:verify-parity`/`check:cadence`. Filed as the recommended precursor to
T2, which changes all four Vitest configs and will re-run `verify` repeatedly.

### 2. A reviewer caught a miscount I had already published

I recorded `.claude/rules/tests.md` as carrying 41 rule bullets, and used that
number to argue the source plan's "38" was a wrong denominator — then wrote
that argument into both the ADR and the plan doc.

The `docs-consistency-reviewer` spoke disputed it and was right. `grep -cE
'^[[:space:]]*- '` returns 41 because it also counts the two YAML frontmatter
`paths:` entries at `tests.md:3-4`. The file has 39 top-level bullets, one of
which (lines 13-15) is a cross-reference pointer rather than a rule — so **38
rules, exactly as the plan said.**

The correction mattered twice over: the count was wrong, and the _argument
built on it_ was wrong. The "do not inherit the classification" warning still
stands, but now rests on its real evidence — a spot-check of the proposed
38-way split found one confirmed misclassification (the "justify intentional
`eslint-disable`" bullet is advisory; `reportUnusedDisableDirectives` flags
_unused_ directives and `guard-eslint-disable-red.mjs` only _parses_ `--
reason`, so nothing requires a rationale).

### 3. The reviewer spoke truncated at its 40-turn limit

Dispatched with 7 files and 5 numbered checklists; it hit the limit mid-tool-call
having produced no report. One `SendMessage` resume asking for
VERIFIED / FINDINGS / **NOT CHECKED** recovered a usable report, and the
explicit NOT CHECKED section is what made the gaps actionable instead of
silently absent. I verified the substantive leftovers myself afterward.

### 4. `check:adr-worthiness` passed vacuously on first run

It reported "No new ADRs on this branch to evaluate" — it diffs
`origin/main...HEAD --diff-filter=A`, so an uncommitted ADR file is invisible
to it. Re-run after committing, it evaluated the file properly.

### 5. Two of the plan's counts were wrong — and so was one of my corrections

Re-derivation before authoring found 654 test files (not the plan's 657), 26
logs mentioning `mutation-test` (not 30), and 29 mentioning `vacuous` (not 28).
Those three stand.

**My fourth "correction" was itself wrong.** I recorded 220 work logs against
the plan's 219, from `ls docs/logs/*.md | wc -l` — which counts
`docs/logs/README.md` as a log. The corpus held **219**; the plan was right. It
surfaced only because `check:logs-index` reported "220 log file(s)" _after_ this
log was added, one more than my supposed pre-existing total — an arithmetic
tell, not a check designed to catch it. The `mutation-test`/`vacuous`/"stayed
green" counts are unaffected: `README.md` contains none of those strings, so
those greps only ever matched real logs.

This is the second instance of the same mistake in one slice — counting a
container as a member of the set it describes (frontmatter `paths:` entries as
rule bullets; `README.md` as a log). The ADR and plan doc were corrected from
220 to 219 in the T1 close-out PR rather than left standing.

More substantively, the plan framed ADR-0034's `corepack` line as a
prerequisite dropped later. It never existed: ADR-0001's 2026-08-31 Update says
Corepack "is not installed on the maintainer's machine at all," so ADR-0001's
original decision-4 wording was wrong when written on 2026-06-27 and ADR-0034
copied it on 2026-07-19. A third site,
`docs/adr/0003-node-24-floor.md:104-105`, _quotes_ that original text and flags
it as amended — correct historical record, deliberately left alone.

## Insights

- **A measured exemption is a dated claim, and it expires.** "`lint:library`
  does not cross the ceiling" was true on 2026-09-08 and false on 2026-09-15
  with no code change to the script. An exemption justified by a measurement
  needs either the measurement's date attached or a gate that re-measures —
  otherwise it silently becomes a defect. The same rot applies to the `8192`
  constant that replaced it, which PR #1134's own log already flagged as "a
  fixed constant of the same class this task exists to remove."
- **A path-skipped CI job cannot corroborate a local gate failure — and looks
  like agreement.** A docs-only PR skips `Lint (library)` and passes `verify`
  in 3 s, so green CI is not evidence the local failure was spurious. When
  local and CI disagree, check whether CI _ran_ the step before trusting it.
- **Never count a container as a member of the set it describes.** Both
  miscounts in this slice were the same shape: `grep -cE '^[[:space:]]*- '` on
  a rule file counted its YAML frontmatter `paths:` list entries as rule
  bullets, and `ls docs/logs/*.md | wc -l` counted `docs/logs/README.md` — the
  index _of_ the logs — as a log. An index, a frontmatter block, a template, a
  barrel: each lives inside the directory or file it describes and matches the
  naive glob. Anchor the pattern (`^- `, not `^\s*- `) and exclude the known
  container by name, then sanity-check the total against an independent counter
  before publishing it.
- **Verifying a count is not the same as verifying the argument built on it.**
  I re-derived the plan's numbers, found two that disagreed, and then reasoned
  from my own wrong number to a wrong conclusion about the plan's
  trustworthiness — twice, on the bullet count and the log count. The
  re-derivation habit protects against inherited error but not against fresh
  error; a claim that _overturns_ a prior claim deserves a second check
  precisely because it feels like diligence. Both times the original was right.
- **Ask a truncating spoke for `NOT CHECKED`, not just findings.** A resumed
  spoke will happily report what it verified and stay silent on what it never
  reached, and silence reads as "clean." Requiring an explicit unchecked list
  converts a truncated review from misleading into merely partial.
- **A docs-only PR gets no automated review at all.** `review` passes in
  seconds and `check:review-size` reports 0 chars. For an ADR — which is
  load-bearing precisely because later work cites it — the reviewer spoke has
  to be dispatched by hand, and it earned its keep here on the first try.
