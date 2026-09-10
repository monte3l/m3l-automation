# Work log — verify-jobs (2026-09-10)

This log covers P3.4 of the adaptive-host-budgeting wave: `--jobs N`
concurrency for `bin/verify-all.mjs` (the `pnpm verify` local aggregate
runner), which previously ran every `VERIFY_STEPS` entry as one strictly
sequential loop. It records the dependency-safety design, the live
measurements taken to validate it, a mid-implementation correctness fix
found via live smoke-testing (not review), and the real before/after
wall-clock numbers.

Plan of record: [`docs/plans/2026-09-08-adaptive-host-budgeting.md`](../plans/2026-09-08-adaptive-host-budgeting.md)

## Summary

`bin/verify-all.mjs` groups `VERIFY_STEPS` into "lanes" by which
`.github/workflows/ci.yml` job names each step (`groupStepsIntoLanes`, new
export in `bin/lib/verify-steps.mjs`, built on the already-tested
`parseCiJobStepNames`). This needed no new hand-authored dependency
metadata: every ci.yml lane job's only `needs:` is the shared `changes` job
— none depends on another lane job — so ci.yml already runs every lane job
concurrently today, which means two steps living in different ci.yml jobs
are already proven safe to run at the same time. Steps in the SAME job keep
that job's own ci.yml step order (not `VERIFY_STEPS`' incidental array
order), preserving whatever intra-job sequencing its author relied on —
e.g. `gates` builds `packages/m3l-cli` before running the scaffold checkers
that read its `dist/`.

Two design decisions were confirmed with the user via `AskUserQuestion`
before implementing (both "(Recommended)" options accepted):

1. Output mode — buffer each lane's output and print it as one block when
   the lane finishes (turbo-style grouped output), not live-interleaved
   with a `[lane]` prefix.
2. Fail-fast mode — on a failure, stop scheduling NEW lanes but let every
   already-running lane finish on its own (nothing killed mid-flight); a
   step failure still stops the REST of its own lane, matching the
   pre-existing single-lane fail-fast granularity.

Default `--jobs` is `deriveBudget(detectHostProfile()).concurrentLaneWorkers`
(`bin/lib/host-profile.mjs`) — the same host-derived default
`pnpm build`/`pnpm typecheck` already use via `bin/print-concurrency.mjs`.
`--jobs=1` reproduces the previous fully-sequential behaviour exactly.

**Files changed** (6): `bin/verify-all.mjs` (rewritten: sequential loop →
dependency-aware concurrent lanes, plus `selectReadyLaneIndex` extracted as
a testable pure export; everything wrapped in `main()` behind a
`process.argv[1] === fileURLToPath(import.meta.url)` guard so importing
`parseJobsArg`/`selectReadyLaneIndex` for tests never triggers a real run),
`bin/lib/verify-steps.mjs` (new `groupStepsIntoLanes` export with two
merged dependency sources — the `ciStepName`-collision mechanism from
divergence #2 and the hand-authored `dependsOnStepIds` field from
divergence #3 — plus `assertLaneGraphAcyclic`), `bin/tests/check-verify-parity.test.ts`
and `bin/tests/verify-all.test.ts` (four `test-author` dispatches across
both files, final count 60 tests), `bin/lib/command-catalog.mjs` (`verify`
script description updated to mention `--jobs`), `docs/adr/provenance.json`
(auto-regenerated re-stamp).

**Live measurements** (this host, ~4 effective cores): sequential baseline
(`--jobs=1 --continue`) **21m33s** wall-clock; the live host-derived
default (`--jobs` unset, `--continue`) **21m14s** — indistinguishable from
sequential, because `bin/print-concurrency.mjs` printed `1` at the time
(two concurrent Claude sessions were active, correctly halving the
already-small per-session core budget down to 1 — the adaptive system
self-limiting exactly as designed, not a defect); explicit `--jobs=4
--continue` **12m59s**, a ~40% reduction, with CPU utilization rising from
~113% to ~175% (`time`'s `%cpu` figure), confirming genuine concurrent lane
execution rather than a no-op. `check:dup` (jscpd) flagged a pre-existing
clone between `bin/check-control-chars.mjs`/`bin/check-no-docker.mjs` on
the sequential run and passed on both concurrent runs — confirmed via
`git diff origin/main...HEAD` (empty for every file jscpd named) that this
is a pre-existing, apparently host-load-sensitive finding entirely outside
this branch's blast radius, not a regression.

**Gates**: full quality-gate sequence (`lint`, `typecheck`,
`turbo run build --filter=m3l-cli`, `test:coverage`, `build`, `knip`,
`check:command-catalog`) green, re-run after each of two bot-review-driven
fix rounds. `pnpm sync:docs` clean (15/15 steps, provenance re-stamp only)
each time.

Skills used: starting-work, creating-prs, resolving-pr-comments,
syncing-docs, writing-work-logs.
Spoke incidents: none.
Compaction events: none.

## What went as planned

- **Both `AskUserQuestion` design decisions resolved to their recommended
  option** with no back-and-forth.
- **The lane-derivation design reused entirely existing, already-tested
  parsing machinery** (`parseCiJobStepNames`) rather than inventing new
  dependency metadata — confirmed live before writing any test that every
  ci.yml lane job's only `needs:` is the shared `changes` job, which is the
  actual safety argument the whole design rests on.
- **The first `test-author` dispatch (`groupStepsIntoLanes`) returned
  clean, mutation-verified results** with zero follow-up: 5 new tests, the
  dedup-safeguard mutation (removing the `covered.has(step.id)` check)
  confirmed the guard test fails without it.
- **The full quality-gate sequence and `pnpm sync:docs` were both clean on
  the first pass** after the mid-implementation fix below landed.

## What didn't go as planned, and why

### 1. A live smoke test, not review, caught two real defects before any test was written around them

Running `groupStepsIntoLanes` against the live `.github/workflows/ci.yml`
(per `.claude/rules/harness-artifacts.md`'s "run a new gate live against
this repo before writing its test suite" guidance) immediately surfaced
that `"Cache turbo"` — a skip-only `VERIFY_STEPS` entry with no `cmd` — is
declared as a step name in both the `build` and `test` ci.yml jobs, so the
first version of `groupStepsIntoLanes` placed the same step object into two
lanes. Harmless today (the step never actually runs, since it has no
`cmd`), but a latent correctness bug: any future step whose `ciStepName`
is legitimately declared in two jobs, if it ever gained a real `cmd`, would
be scheduled — and executed — twice, concurrently. Added a `covered` id-set
dedup guard (first ci.yml-declared job wins) before dispatching any test,
then had `test-author` write the regression test against the fixed
behavior directly.

Separately, dispatching `test-author` for `parseJobsArg` surfaced that
`bin/verify-all.mjs` had no `main()` guard at all — the original
implementation ran every top-level statement (spawning `git merge-base`,
reading `ci.yml`, and ultimately `await`-ing the full concurrent verify
run) unconditionally on module load. Importing `parseJobsArg` alone for a
unit test would have triggered a live several-minute verify run as an
import side effect. The dispatched agent correctly declined to work around
this (per its instructions) and flagged it back instead of writing a
fragile mock-based test. Fixed by moving all effectful top-level code into
`async function main()`, invoked only behind
`process.argv[1] === fileURLToPath(import.meta.url)` — the same pattern
`bin/bench-gates.mjs` already uses for exactly this reason. Verified live
(`node -e 'import(...).then(m => m.parseJobsArg(...))'` produces no output
beyond the return value) before re-dispatching the test.

**Why it happened:** both defects are shapes a synthetic-fixture-only test
suite, written before any live check, would not have caught — the
duplicate-declared-step-name shape only exists in the real ci.yml (not
something you'd think to construct as a fixture until you'd seen it), and
the missing main-guard is invisible from reading `parseJobsArg`'s own body
in isolation; it only surfaces when something tries to import it.

**Fix for future:** for any `bin/**` script gaining a newly-exported pure
function specifically for testability, verify the file has (or add) a
`process.argv[1] === fileURLToPath(import.meta.url)`-guarded `main()`
_before_ dispatching `test-author` for that function, not after a blocked
report comes back — check the file's own top-level structure first, the
same live-check-before-test-suite discipline `groupStepsIntoLanes` already
needed for its own defect.

### 2. A dispatched code-reviewer caught a real concurrency correctness bug the design's own safety argument had a blind spot for

The dedup safeguard from divergence #1 (a `ciStepName` declared in two
ci.yml jobs gets placed in only the first job's lane) has a second-order
consequence the initial design missed entirely: `ci.yml`'s `test` job
deliberately re-runs the `"Build"` step (`pnpm build`) — its own comment
explains why, verbatim: it runs on its own separate CI runner with no
shared `dist/`, so `test:coverage` needs its own fresh build. Locally,
`groupStepsIntoLanes` stripped that duplicate `"Build"` step from the
`test` lane entirely (the `build` job, declared earlier in ci.yml, claims
it), leaving the `test` lane containing only `test-coverage` with nothing
ensuring `packages/m3l-common`'s `dist/` was actually built and current
before it ran. With `--jobs > 1` — the demonstrated, intended common case —
the `test` lane could start `pnpm test:coverage` concurrently with, or
before, the `build` lane's own `pnpm build` finished, against a stale or
missing `dist/`. An earlier live `--jobs=4` run (see the measurements
above) happened to pass cleanly — pure scheduling luck, not correctness,
since nothing in the code actually ordered the two lanes.

Verified the claim directly against the live `.github/workflows/ci.yml`
(confirmed `"Build"` is declared at both line 245 in `build` and line 300
in `test`) before accepting it, then fixed `groupStepsIntoLanes` to return
a `dependsOn: string[]` per lane: whenever a step with a real `cmd` (not a
`skipReason`-only step like `"Cache turbo"`, which never actually runs) is
claimed by an earlier job and a later job also names it, the later job's
lane records the earlier job's name as a dependency. `bin/verify-all.mjs`'s
scheduler was extended with a small event-driven wait (a waiter-list, not
polling) so a worker skips a lane whose dependencies aren't all completed
yet and tries again once any lane finishes — acyclic by construction, since
a dependency can only point to an earlier-declared (and therefore
earlier-queued) job. Re-verified live with another `--jobs=4 --continue`
run after the fix (see measurements above) to confirm the `test` lane
correctly waited rather than trusting the unit tests alone for a
scheduling-order claim.

**Why it happened:** the original design's safety argument ("ci.yml already
runs every job concurrently, so cross-job concurrency is safe") is true for
CI's own multi-runner execution, but silently assumed the local single-
shared-checkout case inherits the same safety — it does for read-only
checks, but not for a step whose entire reason for existing twice in ci.yml
is "each runner needs its own copy because there's no shared filesystem."
That premise flips exactly backwards locally: the one shared filesystem is
what makes the duplicate both unnecessary (waste, if run twice) AND
dangerous to simply drop (if the one copy that remains isn't ordered
relative to what depends on it).

**Fix for future:** when deduplicating any CI-declared repetition for local
reuse, ask not just "is it safe to run once instead of twice" but "why did
each caller need their own copy" — a repetition motivated by resource
isolation (a separate runner, a separate container) usually still needs an
explicit ordering guarantee once collapsed onto one shared resource, even
though the naive "just don't run it twice" fix looks complete and passes a
lucky live smoke test.

### 3. A second bot-review round found the SAME hazard class hiding behind a different step name — twice was not enough to close it

After pushing divergence #2's fix, `claude-pr-review`'s FAIL verdict on
PR #1167 caught a third instance of the identical hazard: `build-cli-for-gates`
(`gates` lane, `pnpm turbo run build --filter=@m3l-automation/m3l-cli`) and
`build` (`build` lane, `pnpm build`, a workspace-wide turbo run that also
covers `m3l-cli`) write the same local output — but with genuinely
_different_ `ciStepName`s, so the `ciStepName`-collision `dependsOn`
mechanism from divergence #2 could never see it; the `gates` lane, which
carries the bulk of `pnpm verify`'s ~56 fast checks including several
scaffold checkers that read `packages/m3l-cli/dist`, had been racing the
`build` lane this whole time. A third case (`build-m3l-common-for-e2e`,
`--full`-only) shares the same shape.

Verified both against `bin/lib/verify-steps.mjs` and `package.json` before
accepting the claim. Fixed with a second, complementary dependency source:
a new hand-authored `dependsOnStepIds` field on the two affected
`VERIFY_STEPS` entries (pointing at `"build"`), resolved by
`groupStepsIntoLanes` in a second pass once every step's owning lane is
known. Because this source is hand-authored rather than mechanically
derived from ci.yml text, it carries no automatic acyclicity guarantee the
way the `ciStepName`-collision source does — added `assertLaneGraphAcyclic`
(depth-first cycle check) so a future mistaken `dependsOnStepIds` pair
throws a clear, named error at lane-construction time instead of silently
deadlocking every worker in `bin/verify-all.mjs`'s scheduler. Re-verified
live at `--jobs=4` a second time, this time capturing the full lane-start/
lane-end log and confirming `gates` now starts only after `build`
completes.

Also addressed this round's Should-fix/Nit findings where they resolved as
targeted fixes: extracted the scheduler's lane-readiness check into a pure,
now-unit-tested `selectReadyLaneIndex` export (the riskiest previously-
untested logic); gave a step abandoned by fail-fast its own `"not-run"`
status/icon instead of silently reusing the deliberate-skip one; tightened
`--jobs`'s number parsing to reject exponent/hex forms (`1e3`, `0x8`). Left
two items deliberately unaddressed: the `stdio: "inherit"` → buffered-pipes
UX regression is a prior, user-confirmed design decision (the "Output mode"
`AskUserQuestion` at the top of this log), not an oversight; and the nit
suggesting `groupStepsIntoLanes` be called with only the runnable steps
(instead of the full `VERIFY_STEPS`, filtered afterward) was rejected after
checking the actual consequence — it would silently break `dependsOn`/
`dependsOnStepIds` resolution the moment a depended-on step ever gained a
`skipReason`, trading a real correctness guarantee for a microseconds-scale
perf gain on a list of well under 100 items.

**Why it happened:** divergence #2's fix closed the exact mechanism that
produced it (a `ciStepName` collision) rather than the general hazard class
(two independently-invoked local build commands writing overlapping
output). A fix scoped to the reported symptom, not the underlying pattern,
leaves every other instance of that pattern undiscovered until something
else — here, a second review pass on the same PR — goes looking for it
specifically.

**Fix for future:** after fixing a reported instance of a hazard class,
explicitly search for OTHER instances of the same class before considering
the fix complete — here, that would have meant grep-ing `VERIFY_STEPS` for
every other `turbo run build --filter=...`/`pnpm --filter ... build`-shaped
`cmd` and checking each against `build`'s own coverage, rather than
stopping once the one reported case was fixed.

## Insights

- **Reuse an existing, already-tested parser as the safety argument for a
  new scheduling decision, rather than inventing new dependency
  metadata.** `groupStepsIntoLanes` needed no new "which steps depend on
  which" field precisely because `parseCiJobStepNames` + the observation
  that every ci.yml lane job's `needs:` is identical (the shared `changes`
  job) already encodes the real, CI-proven-safe concurrency boundary. A
  design that can point at an existing mechanically-derived fact instead of
  a hand-authored one is both less code and harder to let drift.
- **A duplicate-declared-name shape in real infrastructure config
  (ci.yml declaring the same step name in two jobs) is exactly the kind of
  edge case that only shows up from a live read, never from imagining
  fixtures.** _(promoted → .claude/rules/harness-artifacts.md)_
- **Before dispatching `test-author` for a newly-exported pure function
  from a `bin/*.mjs` script, confirm the script already has (or add) a
  `main()` import guard** — a script whose top-level body has side effects
  makes importing ANY of its exports for testing trigger those side
  effects, and for a script that eventually launches child processes, that
  side effect can be a multi-minute live run instead of a fast, obvious
  crash.
- **The adaptive host-budget default correctly self-limiting to 1
  concurrent lane, under real session contention, is not a defect to work
  around for a demo** — it is the wave's whole design goal working exactly
  as intended. Demonstrating the mechanism's actual speedup ceiling
  required an explicit `--jobs=4` override rather than trusting the live
  default number, and both facts (the correct self-limiting default, and
  the real ~40% win available when uncontended) belong in the same
  measurement writeup, not just the flattering one.
- **A CI-declared repetition of the same step across two jobs is not
  automatically safe to collapse to one — ask why each job needed its own
  copy before deduplicating for a shared-filesystem local runner.** A
  resource-isolation-motivated duplicate ("this runner has no shared
  `dist/`, so build it here too") becomes a missing ordering guarantee once
  merged onto one shared checkout, not a harmless removal. A live smoke
  test passing once is not proof the removal was safe — it can just mean
  the scheduler got lucky this run.
- **Fixing the reported instance of a hazard class is not the same as
  fixing the hazard class.** Divergence #2's `dependsOn` fix closed the
  exact `ciStepName`-collision mechanism that produced the one bug the
  first review round reported; it took a SECOND review round to find the
  same underlying hazard (two local commands writing the same build
  output) reached through a different, differently-named step. After any
  fix scoped to a reported symptom, explicitly search for sibling
  instances of the same pattern before calling it done — grep the
  surrounding data structure for the same shape, don't just close the one
  ticket.
