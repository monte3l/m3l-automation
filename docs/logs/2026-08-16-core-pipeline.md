# Work log — `core/pipeline` submodule (2026-08-16)

This log covers PR1 of the ADR-0043 gate opening (issue #334): shipping the
step-pipeline engine as the `core/pipeline` submodule through the full
scaffold → spec → RED → GREEN → 4-spoke review pipeline. It records what
shipped, what matched the plan, what diverged, and the durable lessons. The
gate-opening decision itself is recorded in ADR-0043's Update (2026-08-16);
the migrations of `s3-objects` + `ecs-ops` follow as PR2/PR3.

## Summary

Shipped `core/pipeline`: 8 public exports (`M3LOperationPipeline` + 7
option/contract/outcome types) surfaced through the `./core` barrel — a
declarative engine for the multi-op dispatcher skeleton (operation
resolution, settings resolution, array-order required-field guards,
destructive gate via `Core.confirmDestructive` with a discriminated decline
policy, exhaustive handler dispatch, persist-before-finalize ordering).
72 module tests (58 behavioral + 14 type-level incl. two `@ts-expect-error`
soundness guards); package suite 4471 green; 100% coverage on all four V8
metrics for all 3 implementation files; `typecheck`/`lint`/`build`/
`sync:docs` (13/13 steps) clean. Dep-free; only-internal
`ERR_PIPELINE_INVALID_OPTION` registered + classified.

Review spokes: `code-reviewer` pass (0 must-fix, 2 nits);
`spec-conformance-reviewer` conformant (0 must-fix; test/doc should-fixes,
all applied); `type-design-analyzer` 1 must-fix (conditional `prepare` —
required whenever `TContext` ≠ `undefined`) + 2 should-fixes (non-empty
tuple `operations`, `TSettings extends object`), all landed;
`silent-failure-hunter` 0 must-fix (3 test-gap should-fixes, all covered).
A dedicated spec-conformance **producer** pass before RED compiled probe
fixtures in-memory and PROVED five-generic inference from a single options
literal, retiring the curried-builder fallback before a line of test code
existed.

Skills used: starting-work, scaffolding-submodules, writing-commits,
syncing-docs, writing-work-logs.

Spoke incidents: 4 truncations / 0 stalls / 3 resumes (RED test-author
truncated twice → two `SendMessage` resumes; fixture-refactor test-author
truncated once → one resume; GREEN implementer truncated at the report stage
with work complete → hub ran the verification battery itself instead of
resuming).

## What went as planned

- **Docs-first gate opening matched precedent** — ADR-0043 Update + tracker
  flips followed the 874096c/41e54aa pattern exactly; `check:tracker-status`
  and `check:tracker-coverage` green on first try.
- **Contract-producer pass earned its slot** — compiling s3-objects-shaped
  probe fixtures at contract time settled the one open design risk
  (inference vs curried builder) with a proof, not an opinion, and surfaced
  the `TDeps`-infers-only-from-callback-positions caveat that the test
  fixtures then encoded (T11).
- **RED failed for the right reason** — 48/62 assertion-level failures
  against the scaffold's rejected-Promise placeholder; zero crashes or
  import errors (the Promise.reject-not-throw scaffold rule from the
  aws/ecs log held).
- **GREEN was clean on first pass** — 62/62 with 100% per-file coverage, no
  re-dispatch; the errors source-scan guard accepted the new code without a
  fix-up round.
- **No runtime must-fix from any reviewer** — the only must-fix was
  type-level soundness; the engine's catch-specificity and
  propagate-unmodified contract survived a dedicated adversarial audit.
- **`sync:docs` composite 13/13** — the hand-authored provenance sidecar
  (with all 8 symbols in `sources[]`, per the step-7 trap note) indexed
  8 new symbols on the first run.

## What didn't go as planned, and why

### 1. The type-design must-fix bounced off frozen-suite fixture style

The conditional-`prepare` fix (and the non-empty-tuple should-fix) compiled
clean in isolation but broke ~30 test call sites, so the implementer
correctly reverted rather than edit frozen tests. Landing them took a
three-step coordinated dance: a test-author pass to make fixtures
forward-compatible (derive `TestOp` from an `as const` tuple; stop pinning a
non-`undefined` `TContext` at sites that never exercise `prepare`; add
`as unknown as` escape hatches at the three uncast invalid-options sites),
then a src re-apply, then guard tests (T13/T14).

**Why it happened:** the RED fixtures pinned all five generics explicitly as
a convenience and declared `TEST_OPS` as a widened `readonly TestOp[]` —
encoding exactly the representable-but-invalid states the type fixes were
designed to outlaw.

**Fix for future:** test fixtures must not pin generic parameters they don't
exercise, and operation-list fixtures should be `as const` tuples with the
union derived from them — the fixture style should model the intended
consumer style, not fight it.

### 2. Four writer-spoke mid-turn truncations in one run

The RED test-author truncated twice, the fixture test-author once, and the
GREEN implementer once at the report stage — each final message a progress
note, not a report. Three `SendMessage` resumes recovered the test passes;
for the implementer the hub ran the verification battery itself since the
work was already complete.

**Why it happened:** the known recurring divergence
(`docs/contributing/subagent-context-management.md`) — long single-file test
suites (~2,200 lines authored in one pass) are the worst case.

**Fix for future:** for suites expected to exceed ~40 tests, the dispatch
prompt should pre-split the work into two checkpointed batches, and when a
spoke truncates at the report stage with artifacts already written, verify
from the hub rather than paying a resume.

### 3. ADR-0043's census was stale at gate-opening time

The ADR recorded 13 dispatchers / 4,867 lines; exploration found 18 files /
~6,992 lines (8 genuinely multi-op). Not a blocker — the Update records the
corrected census — but the plan's scope framing had to be adjusted mid-plan.

**Why it happened:** the fleet kept growing after the ADR froze its numbers,
and nothing re-derives them.

**Fix for future:** when opening any deferred gate, re-derive the gating
ADR's quantitative evidence first and record the corrected numbers in the
Update — treat ADR metrics as snapshots, never as current state.

## Lessons learned

- **Prove type-level design questions at contract time** — the
  spec-conformance producer pass compiling probe fixtures killed the
  inference-vs-builder question with zero diagnostics before RED; a design
  fallback "to decide during implementation" is a decision you can force
  earlier with a 10-minute compile probe.
- **Fixtures must not pin unexercised generics** — explicit five-type-arg
  instantiation as a fixture convenience blocked two soundness fixes; derive
  unions from `as const` tuples and let inference do the rest.
  _(promoted → .claude/agents/test-author.md)_
- **Verify from the hub after a report-stage truncation** — when a spoke
  truncates with its artifacts already written and only the report missing,
  re-running the verification battery from the hub is cheaper and faster
  than a resume; reserve resumes for truncations with work genuinely
  unfinished.
- **Re-derive a gating ADR's evidence before opening its gate** — ADR
  metrics are snapshots; the Update that opens a gate should carry the
  corrected census so the next reader isn't planning against stale numbers.
- **Soft-land vs throw as a discriminated policy union** — modeling the two
  existing decline behaviors as first-class `{kind}` variants (plus a
  status-carrying outcome) let both target scripts keep byte-identical
  behavior without the engine guessing; when an abstraction must absorb two
  divergent behaviors, reify the divergence as data instead of picking a
  winner.
