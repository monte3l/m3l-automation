# Work log — `parallel-checks` (2026-09-11)

P3.8 of the adaptive-host-budgeting wave (Stage 3, Phase 2 tuning candidate
8, and the wave's last row): "parallelise the 29-gate `checks` chain". Like
P3.7, the row carried no committed rationale for why parallelizing this
specific chain would help — so this task re-derived the premise first,
per this repo's standing instruction to re-verify an authored claim before
acting on it, rather than building a parallel-execution mechanism against an
unexamined assumption.

Plan of record: [`docs/plans/2026-09-08-adaptive-host-budgeting.md`](../plans/2026-09-08-adaptive-host-budgeting.md)

## Summary

- **Research** (`Explore` spoke): confirmed the `checks` lane is a fully
  serial `&&` chain of 29 (`bin/bench-gates.mjs`'s copy) or 30
  (`lefthook.yml`'s live source, which also runs `check:test-fs-isolation`)
  gates, most sub-second individually (`check:agents` the slowest at
  ~7s historically), with no inter-gate dependencies found — naive
  parallelization would be structurally safe.
- **The decisive question, re-derived rather than assumed**: is `checks`
  actually on the critical path of anything? Pre-push already runs `checks`
  in parallel alongside `format`/`lint`/`typecheck`/`test`/`build-exports`
  (`lefthook.yml`'s `parallel: true`), and CI's `gates` job runs in parallel
  alongside `lint-workspace`/`test`/`build` (all `needs: changes`, `ci.yml`).
  Parallelizing a lane's _internals_ only helps if that lane is the slowest
  one in the group.
- **Measurement**: `node bin/bench-gates.mjs --lane=checks --lane=lint:workspace --json`
  — `checks` measured **79.06s** wall-clock; `lint:workspace` measured
  **152.51s** — nearly double. P3.7's own measurement already put
  `test:unit` at 489.29s. `checks` is the fastest of the three, by a wide
  margin, in the current parallel pre-push.
- **CI corroboration**: `ci.yml`'s `gates` job carries its own committed
  comment (lines 365–372) stating its ~24 governance steps cost "~20s
  combined" on CI hardware, and explicitly frames that cost as an accepted
  tradeoff ("strictly better trade than re-auditing this list every time a
  check's inputs change") rather than a problem to solve. `gates` runs
  parallel to `lint-workspace`/`test`/`build`, none of which finish in 20s.
- **Decision**: parallelizing the `checks` chain's internals would reduce
  its own wall-clock (locally, plausibly from ~79s down to something smaller
  — `cpuEfficiency: 0.41` suggests most of that time is single-core-bound
  serial subprocess spin-up, not genuine CPU-bound work) but would not
  change the overall pre-push or CI wall-clock in either environment, since
  `checks`/`gates` already finishes well before the slower parallel lanes
  do. Implementing it would add real complexity (concurrent-write races
  between check scripts, harder failure attribution) for zero measured
  wall-clock benefit — negative expected value, the same shape as P3.7.
- **Wave close-out**: P3.8 was the wave's last open row. `docs/plans/README.md`
  documents that a finished plan doc "belongs in `archive/` instead of
  carrying a stale table" — but its own Archive table already carries a
  precedent for the opposite when the physical move would break something
  (the "Skill-eval routing debt" row, kept in place because 4 immutable
  work logs link to it at its original relative path). This wave's own
  logs turned out to hold the identical pattern, at greater scale: all 10
  of the wave's prior work logs (P0 through P3.7) cite the plan doc via a
  `Plan of record:` markdown link to
  `../plans/2026-09-08-adaptive-host-budgeting.md`, all frozen historical
  records. An initial attempt to `git mv` the file into
  `archive/` (confirmed with the user first, given the ~20-file blast
  radius) was reverted on discovering this precedent mid-implementation —
  the file stays at its original path, flipped to `Status: shipped`, and
  is cross-listed in `docs/plans/README.md`'s Archive table (delisted from
  "Live dated plans") with the same kept-in-place rationale. No link
  updates or ADR provenance regeneration were needed as a result.
- `pnpm verify`: run clean on the docs-only push (no `src/`/`tests/`
  changes in scope).
- No PR to review beyond this log-landing PR itself — there is no code
  diff.

**Skills used:** starting-work, writing-work-logs, creating-prs,
finishing-work.

**Spoke incidents:** none. One `Explore` spoke dispatched for research
(gate list, execution mechanism, CI job graph) — read-only, no incidents.

**Compaction events:** none during this task.

## What went as planned

- **The same "measure before implementing" discipline P3.7 established
  caught a second stale premise in the same wave**, this time by asking a
  different question than P3.7's (not "is there I/O pressure to relieve"
  but "is this lane even the bottleneck"). Both questions share a shape:
  a Phase-2 candidate row assumed a specific mechanism would help without
  the wave ever measuring whether the thing it targets is actually
  constraining anything.
- **Comparing `checks` against a lane already known to be slower
  (`lint:workspace`) answered the question in one measurement**, without
  needing to build and then benchmark a parallelized prototype. The CI
  job-graph read (both `gates` and `checks` run `needs: changes`, parallel
  to the slower jobs) independently corroborated the same conclusion in a
  second environment, raising confidence beyond a single local measurement.

## What didn't go as planned, and why

### 1. The initial archive-with-rename plan was reverted mid-implementation

Closing the last row of a wave's landing-plan table doesn't just flip one
status cell — `docs/plans/README.md`'s stated convention is to move the
whole plan doc into `archive/`. The user confirmed doing exactly that
(`AskUserQuestion`, given the ~20-file blast radius), and the `git mv` and
one live-link fix (`docs/contributing/host-resources.md`) were carried out.
Only then, while auditing the wave's own work logs for stale references,
did a second, more specific precedent surface: `docs/plans/README.md`'s own
Archive table already documents an exception to its stated convention — a
prior plan kept in place, not moved, because immutable work logs held live
markdown links to its original path. This wave's logs turned out to match
that exact shape, at greater scale (10 links, not 4). The `git mv` was
reverted in favor of the kept-in-place pattern once this was found.

**Why it happened:** the initial confirmation with the user weighed the
_generic_ documented convention (move finished plans to `archive/`) against
its blast radius, without first checking whether this repo's own README
already recorded a specific exception for exactly this situation — the
precedent was one table below the convention text that was quoted, in the
same file already open.

**Fix for future:** when a doc states a general convention, read that doc's
own worked examples/exceptions before acting on the convention in the
abstract — a README documenting "normally X, but here's a case where we did
Y instead" is itself the re-derivable authored claim to check, not just the
stated rule at the top.

## Insights

- **A wave's last slice needs a different close-out shape than every slice
  before it**, not because the measurement/decision work differs, but
  because closing the final row changes the document's own lifecycle state
  (live → archived) per `docs/plans/README.md`'s convention — worth checking
  for explicitly (is this the last non-terminal row?) rather than assuming
  every slice close-out is shaped like the ones before it.
- **"Is this lane the bottleneck" is a distinct, equally cheap
  pre-implementation question from P3.7's "is this resource under
  pressure"** — both are answerable from `bench-gates.mjs` output without
  writing the mechanism first, and both closed a Phase-2 candidate as a
  negative result. Together they suggest Phase-2 tuning candidate rows
  authored without a committed benchmark-backed rationale should be treated
  as needing measurement first by default, not as an exception P3.7
  happened to hit once.
- **The "keep a finished plan in place if immutable logs link to it"
  exception in `docs/plans/README.md`'s Archive table is now confirmed
  twice** (the skill-eval-routing-debt row, and this wave), which is enough
  of a pattern that it's worth treating as the default check going forward
  whenever a wave's last row closes — read a general convention's own
  documented exceptions before applying the convention, not just the rule
  stated at the top of its section.

No insight from this task needed promotion into a `.claude/rules/*.md` file
or agent instructions — the findings are specific to this task's own
measurement and this wave's own close-out, not a recurring process gap
beyond what P3.7's log already captured.
