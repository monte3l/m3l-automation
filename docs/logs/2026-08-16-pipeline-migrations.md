# Work log — s3-objects + ecs-ops pipeline migrations (2026-08-16)

This log covers PR2 and PR3 of the ADR-0043 gate opening (issue #334): the
first two consumer migrations onto `Core.M3LOperationPipeline`, shipped as
`refactor/s3-objects-pipeline` (PR #435, stacked on #434) and
`refactor/ecs-ops-pipeline`. It records the parity evidence the six queued
follow-up migrations are gated on, the mock-seam incompatibility the ecs-ops
suite surfaced, and the durable lessons. The engine ship itself is
`docs/logs/2026-08-16-core-pipeline.md`.

## Summary

**s3-objects** (`run-s3-objects.ts`, soft-land decline policy): 454 → 402
lines (−52). The hand-rolled skeleton — operation `oneOf`, guard loop,
gate try/catch, two dispatch switches with `exhaustive: never` arms — is
replaced by a declaratively-configured pipeline; the six `dispatch*`
functions survive as handler entries via one `adaptHandler` factory. The
103-test characterization suite ran **byte-unmodified** and green. Reviews:
`code-reviewer` approve (2 should-fixes applied: adapter factory, inference
over explicit generics); `silent-failure-hunter` PASS (decline predicate
provably identical to the old catch block).

**ecs-ops** (`run-ecs-ops.ts`, throw decline policy + prepare/persist/
finalize): 450 → 491 lines (+41). `DISPATCH_GROUP`, three type predicates
with defensive throws, the dispatch switch, and `runGate` are deleted;
`prepare` carries the write-dispatch planning (one input read, pre-gate),
`persist` the conditional export, `finalize` the wait-state assertion
(engine-guaranteed to run after persist), and presence guards moved to a
declarative `REQUIRED_FIELDS` table after review. The 134-test suite passed
with assertions untouched; 8 gate tests needed their **mock seam**
translated (see divergence 1), and 2 pinning tests were added (136 total).
Reviews: `code-reviewer` PASS (requiredFields should-fix applied);
`silent-failure-hunter` PASS (no must-fix; isWaiterResult pin added).

**Parity evidence for the six queued migrations** (lambda-ops,
cloudformation-stacks, cloudwatch-logs-insights, eks-ops, codepipeline-ops,
dynamodb-crud — tracker rows added in PR3): expect **modest or no
line-count savings** (net −11 lines across both migrations). The real value
is structural: the orchestration skeleton, guard ordering, gate semantics,
and persist-before-finalize guarantee become engine-owned and identical
across scripts, and the two-level type-predicate dispatch pattern retires.
A migration that leaves a file slightly longer but declaratively configured
is still a win; one hoping for large deletions will be disappointed.

Skills used: writing-commits, syncing-docs (PR1), writing-work-logs,
creating-prs.

Spoke incidents: 0 truncations / 0 stalls / 0 resumes across PR2+PR3 (the
ecs-ops implementer's mid-task stop was a deliberate, correct
stop-and-report on a blocker, not a truncation).

## What went as planned

- **s3-objects was the frictionless case the plan predicted** — suite
  byte-unmodified, one small review fix round, no parity findings.
- **The engine absorbed both decline policies without adaptation** — the
  discriminated `onDecline` union covered soft-land and throw exactly as
  designed; neither migration touched the library.
- **Persist-before-finalize ordering transferred** — ecs-ops's
  "wait result lands on disk before the non-stable throw" invariant is now
  engine-guaranteed instead of code-ordering-guaranteed, and the frozen
  tests pinned it through the migration.
- **The implementer stopped on the seam blocker instead of improvising** —
  exactly the dispatch instruction ("a needed test edit is a red flag:
  stop and report"), which routed the decision to the hub where it belonged.

## What didn't go as planned, and why

### 1. The ecs-ops suite's gate mock was architecture-bound and broke on migration

`run-ecs-ops.test.ts` mocked `Core.confirmDestructive` via
`vi.mock("@m3l-automation/m3l-common", ...)`. That intercepts the _barrel_
import — but `M3LOperationPipeline` invokes `confirmDestructive` through an
internal relative import, which the barrel mock cannot see. Eight gate
tests failed with a real interactive prompt and stdin timeouts. Resolved by
translating the seam to the one both architectures share: a `vi.spyOn` on a
real `M3LPrompt.confirm` (the technique the s3-objects suite already used).
Every assertion was translated 1:1, none weakened, and the new seam would
also pass against the pre-migration code — preserving the suite's validity
as a characterization net.

**Why it happened:** mocking a library function at the package barrel
encodes an assumption about _who imports it and how_; moving the call into
the library made that assumption false while the observable behavior stayed
identical.

**Fix for future:** characterization suites should mock at collaborator
seams (the injected `prompt`, the AWS client fns, `node:fs`), never at the
library barrel for functions the code under test might receive indirectly.
The six queued migrations must check for barrel-mock gate seams FIRST and
translate them before migrating (recorded in their tracker rows).

### 2. ecs-ops grew instead of shrinking

The migrated file is +41 lines over baseline even after moving presence
guards to `REQUIRED_FIELDS`. The engine deleted the dispatch machinery, but
ecs-ops needed two structural inventions — `isWaiterResult` (finalize
receives no operation, so the wait result is detected structurally) and a
fresh accessor re-read for the completion log (the outcome carries no
settings) — plus TSDoc for the new table and helpers.

**Why it happened:** ecs-ops exercises every optional engine phase
(prepare/persist/finalize), and the engine's finalize/outcome signatures
don't carry operation/settings context the wrapper needs, forcing
re-derivation.

**Fix for future:** treat line count as a non-goal in the remaining
migration rows; if a third migration also needs the finalize-context
re-derivation dance, consider an additive engine enhancement (e.g. passing
the operation to `persist`/`finalize`) as a semver-minor follow-up rather
than repeating the workaround six times.

### 3. The first ecs-ops pass under-used the engine's guard table

The initial migration kept presence guards inline in handlers (per the
plan's conservative "note as follow-up" stance); review flagged that both
paths produce byte-identical messages via `accessor.requiredFor`, so the
conservatism bought nothing and cost boilerplate. The conversion landed in
a follow-up pass with the frozen suite proving parity.

**Why it happened:** the plan over-weighted "coverage/behavior parity" risk
for guards that were already delegating to the same library call the
engine uses.

**Fix for future:** when the inline code and the engine phase call the
SAME underlying library function, move it in the first pass — the frozen
suite is the parity proof either way.

## Lessons learned

- **Mock at collaborator seams, not the library barrel** — a barrel mock of
  a function the implementation may receive indirectly is architecture-bound
  and breaks on refactors that preserve behavior; spy on the injected
  collaborator (`prompt.confirm`) instead. _(promoted →
  .claude/agents/test-author.md)_
- **Line count is the wrong migration metric** — net −11 lines across two
  migrations; the value is engine-owned ordering guarantees and deleted
  dispatch machinery. Set expectations accordingly in the six queued rows.
- **Same-underlying-call guards move in pass one** — inline
  `accessor.requiredFor` presence checks and the engine's `requiredFields`
  are the same call; deferring the move as "parity risk" just schedules a
  second pass.
- **Watch for the finalize-context re-derivation smell** — if a third
  migration needs `isWaiterResult`-style structural detection or a config
  re-read because `persist`/`finalize` lack operation/settings context,
  that's the trigger for a semver-minor engine enhancement instead of a
  third workaround.
- **A deliberate spoke stop is the system working** — the implementer
  halting on the seam blocker (instead of editing frozen tests or
  improvising a worse mapping) routed a genuine design decision to the hub;
  zero truncations this phase also confirms the smaller, bounded dispatches
  used here.
