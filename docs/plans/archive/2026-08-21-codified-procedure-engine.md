# Codified-procedure engine — `core/procedure` (ADR-0046, B2, issue #474)

**Status: shipped** — six sub-slices landed across PRs #580, #582, #583, #585,
#586, #587. Closes issue #474 and its landing-discipline tracker, issue #576.

## Context

`core/procedure` was attempted once as PR #523 (`feat/core-procedure-engine`)
and abandoned after five review rounds — non-convergence, not size (full
post-mortem: `docs/plans/IMPLEMENTATION.md`'s F23 row). That failure drove
F23/ADR-0072's reviewable-slice discipline (issue #571, PRs #572/#573/#574),
which this module became the first real consumer of (tracked as issue #576).

The engine gives a script author a declarative, testable alternative to
hand-written branching: a fixed step → case → conclusion contract
(`M3LProcedureBuilder`/`M3LProcedure`), condition evaluation over a
reference/value algebra, flow directives (`continue`/`stop`/`resolve`/`goTo`),
cancellation, `continueOnFailure` recovery, opt-in tracing, and an opt-in
no-progress guard — the same shape ADR-0046 specified, ported from the
intact-but-abandoned `feat/core-procedure-engine` branch (`1684192`), which
served as the reference implementation for every slice.

## Approach / Decisions

1. **Six sub-slices instead of one PR**, each independently reviewable and
   landed only after the previous one merged to `main`:
   - **Slice 1** (PR #580) — the contract page + condition-evaluation algebra
     (`evaluateProcedureCondition`, value/reference types, depth/length
     bounds). A 4-spoke review found and fixed three real defects PR #523's
     own six-spoke review had missed: an unguarded caller-data read escaping
     the documented "total, never throws" evaluator, `==`/`!=` between two
     unresolved references wrongly evaluating `true`, and a non-enumerable
     own property resolving through a path contract that requires
     enumerable-only.
   - **Slice 2a** (PR #582) — the builder + build-time validation surface
     (`createProcedureBuilder`, a reduced `M3LProcedure` with no `run()` yet).
     Fixed the R3/R4 defect class (an unvalidated step `execute`/case `action`
     reachable as a bare `TypeError`, plus the validate-then-re-read hazard a
     first fix attempt reintroduced) and, after a second review round, a
     caller-supplied `condition`/`revision` value reaching `canonicalJsonHash`
     unprojected and an unfrozen `describe()` summary. Sealed the constructor
     (private + a symbol-gated static factory) so the internal built-definition
     type stopped leaking onto the public surface.
   - **Slice 2b** (PR #583) — the exhaustive declaration/cycle/pattern edge
     battery plus an adversarial review pass, finding six further real
     defects: an unbounded-breadth condition-tree walk that OOM-crashed the
     process, a `matches` ReDoS bypass via un-grouped repeated quantified
     atoms, a fail-open unrecognized `compare` operator (in both build-time
     validation and the standalone public evaluator independently), an
     unguarded caller-array spread in `parameters()`, a prototype-chain walk
     instead of `Object.hasOwn`, and a forgeable unfrozen instance.
   - **Slice 3a** (PR #585) — the core run loop: `M3LProcedure.run()`, option
     validation, phases 1–3, flow directives, the iteration/revisit ceiling,
     cancellation, `continueOnFailure`/recovery, outcome + telemetry. Landed
     with an explicit, justified soft-target-size warning (~179,000
     reviewable bytes — the three phases and abort boundaries are mutually
     load-bearing and not further splittable) rather than silently absorbing
     it.
   - **Slice 3b** (PR #586) — opt-in tracing (`options.trace`/`options.logger`,
     `internal/procedure/trace.ts` + `trace-payload.ts`). A bot re-review
     found one genuine Must-fix (`options.trace` bypassing boundary
     validation, letting a raw `TypeError` escape) fixed in a follow-up
     commit; a near-unanimous 3-of-4 reviewer recommendation to remove the
     tracer's per-run warning cap was independently verified against the
     accepted test suite and found to be _wrong_ for this codebase (it would
     break two existing tests) — resolved by documenting the cap instead of
     changing it.
   - **Slice 3c** (PR #587) — the opt-in no-progress guard
     (`options.progress`, `ERR_PROCEDURE_NO_PROGRESS`, the 16th and final
     error code), reusing `internal/polling/progress.ts`'s `ProgressTracker`
     rather than duplicating its stall-counting logic. A bot review found one
     genuine Must-fix (`progress: null` escaping as a raw `TypeError`) fixed
     in a follow-up commit; a prior 4-spoke review round separately caught and
     fixed a real coverage gap (the guard sampling on a `continueOnFailure`+
     `loop` retry, not just a genuine advance, was newly-wired but untested)
     and two doc-accuracy bugs.

2. **Splitting 3a/3b/3c was forced by `perFile` coverage, not just file size**:
   `M3LProcedureNoProgressError` has no call site until the no-progress guard
   exists (a 3a landing would fail `errors.ts`'s function-coverage floor), and
   `trace.ts` at its full reference size left only ~3,500 B of headroom under
   the 25,000 B file-budget ceiling — split into `trace.ts` + `trace-payload.ts`
   from day one rather than retrofitting the split later, the same lesson
   slice 2b had already paid for once.

3. **Import direction stayed one-way**: `core/procedure/M3LProcedure.ts` →
   `internal/procedure/run.ts` → the rest, with instance state (steps/cases/
   fallback) crossing the seam once as a frozen runtime record built in the
   constructor, rather than the reference branch's ~50 private methods reading
   `this.#field` directly — the free-function-parameter translation every
   `internal/procedure/*.ts` module needed.

## Outcome

`core/procedure` ships its full documented surface: 44 exports, 16 registered
error codes (`ERR_PROCEDURE_*`), condition evaluation, the builder + build-time
validation, the three-phase run contract, cancellation, opt-in tracing, and the
opt-in no-progress guard — every guarantee `docs/reference/core/procedure.md`
states, implemented and reviewed across all six sub-slices. `docs/implementation-status.md`'s
`procedure` row flips to ✅; issue #474 (the module) and issue #576 (the
landing-discipline field test) both close.

F23/ADR-0072's reviewable-slice discipline is validated end to end by this
module: six PRs, six independent review rounds, zero non-convergence — the
opposite outcome from PR #523's five-round abandonment on the same source
content, with the same defect classes (unguarded boundary reads, fail-open
validation, unbounded recursion) still being found and fixed, just inside
slices small enough for a review round to actually converge.
