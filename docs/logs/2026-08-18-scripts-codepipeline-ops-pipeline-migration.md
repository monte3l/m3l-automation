# Work log — codepipeline-ops pipeline migration (2026-08-18)

This log covers issue #441 — the migration of
`scripts/codepipeline-ops/src/steps/run-codepipeline-ops.ts` (590 lines) onto
`Core.M3LOperationPipeline`, the fifth and final consumer migration in the
ADR-0043 (Update 2026-08-16) wave (after s3-objects #435, ecs-ops #436,
lambda-ops #454, cloudformation-stacks #457, eks-ops #461; cloudwatch-logs-insights
and dynamodb-crud were rejected as out of scope). It records what shipped, what
matched the plan, what required a design decision (the structural-guard
insufficiency that forced a different approach), and durable lessons for future
consumers of `Core.M3LOperationPipeline`.

Plan of record: `~/.claude/plans/on-issue-441-reactive-meerkat.md`
(session-local; not archived — routine migration, covered by this work log).

## Summary

`run-codepipeline-ops.ts`: **590 lines (exact post-migration line count
not reported by the implementer)**. The `MutatingOperation = Exclude<…>`
helper type, five `isXOperation` type-predicate narrowers,
`dispatchMutatingOperation`/`dispatchOperation` two-level dispatch chain,
seven per-family `dispatch*` wrappers, `readRawSettings`, `RawSettings`,
`DispatchDeps`, and `DispatchResult` are deleted. The seven per-operation
step modules survive untouched; their calls become 13 per-operation handler
table entries in the flat `M3LOperationPipeline` options. `planWriteDispatch`
survives as `prepare`; `persistOutput` survives in `persist`; `assertWatchSucceeded`
survives in `finalize` with a modified guard (see below). All five error codes
and their `@throws`/`@example` TSDoc are preserved. 68/68 dispatcher tests +
7,669 total suite green at both commit boundaries; typecheck, lint,
format:check, and build clean at each boundary.

Two commits, matching every prior wave migration's pattern:

- `581fa88` — `refactor(test)`: barrel-mock gate seam → `prompt.confirm` spy
  (test-author spoke, single pass).
- `78316d4` — `refactor`: orchestrator migrated; two-level dispatch chain
  deleted; all five error codes and TSDoc preserved
  (code-implementer spoke, single pass).

Code-reviewer found zero must-fix items (one should-fix: a pre-existing test
coverage gap on `reason`-forwarding for `disable-stage-transition`; two nits).
Silent-failure-hunter raised one "must-fix" (persist-throws skips finalize) and
one "should-fix" (dynamic import errors propagate untyped) — both verified as
**pre-existing behaviors preserved exactly by the migration, not regressions**
(confirmed by `git show HEAD~2` of the pre-migration sequential ordering
`persistOutput → assertWatchSucceeded`).

Skills used: starting-work, writing-work-logs, creating-prs.

Spoke incidents: 0 truncations / 0 stalls / 0 re-dispatches.

## What went as planned

- **The two-commit pattern replicated without incident** — both spokes completed
  in a single pass; the seam-translation briefing included the exact
  `confirmingPrompt` helper spec, the 1:1 assertion mapping, and the
  `watchExecutionMock` hoist-preservation note (static `FAILED_STATUSES` import),
  leaving no design decisions for the test-author mid-run.
- **The 13-entry `REQUIRED_FIELDS` table absorbed all per-operation guards in
  pass one** — including `"reason"` for `disable-stage-transition` (confirmed
  against `transitions.ts` line 72-77), without a second review round.
- **NOT_FOUND ordering preserved via handler-throw** — `readPipelines`,
  `readState`, and `readExecutions` all throw `ERR_CODEPIPELINE_OPS_NOT_FOUND`
  from inside their step modules (Dispatch phase), so persist and finalize never
  run on a not-found result. This was the documented prior-migration pattern and
  needed no special handling.
- **`requireTransitionType` survived as a handler-local call** — narrowing
  `string | undefined → "Inbound" | "Outbound"` inside the
  `enable/disable-stage-transition` handlers via `requireDefined` + an inclusion
  check, preserving the existing error message byte-identically.
- **Untouched files confirmed** — `git diff --stat HEAD~2..HEAD` shows exactly
  two files changed (`run-codepipeline-ops.ts` + `run-codepipeline-ops.test.ts`);
  `main.ts`, `config.ts`, `hooks.ts`, and all seven leaf steps are untouched,
  matching every prior migration.
- **The pre-existing behavior audit resolved two "must-fix" flags without a patch
  commit** — verifying that the silent-failure-hunter's two findings were
  present in the pre-migration code (`git show HEAD~2` confirmed the same
  `persistOutput → assertWatchSucceeded` sequential ordering) let both be closed
  as "preserved, not introduced" without expanding scope.

## What didn't go as planned, and why

### 1. Structural finalize guard was insufficient — operation embedded in settings instead

Every prior wave migration (ecs-ops, lambda-ops, cloudformation-stacks, eks-ops)
resolved the "finalize receives no operation" problem (F12, filed as a P3 library
enhancement) by using a structural type predicate — `"state" in result`,
`isWaiterResult(result)`, `isUpdateResult(result)` — to distinguish which results
need a post-dispatch assertion. For codepipeline-ops this approach fails:
`describe-execution` and `watch-execution` both return the identical
`AWS.M3LCodePipelineExecution` type. A structural guard (`"status" in result`)
would fire `assertWatchSucceeded` — and throw `ERR_CODEPIPELINE_OPS_WATCH_FAILED`
— for any `describe-execution` of a `Failed`/`Stopped`/`Cancelled` execution, a
behavior change the test suite would detect but any result missing from the
characterization net would silently miss.

**Resolution:** `resolveSettings` (which already receives `operation` from the
engine) stores it into `RunSettings.operation`. `finalize` branches on
`settings.operation === "watch-execution"`. This is byte-identical to the
pre-migration `assertWatchSucceeded(operation, result, correlationId)` check,
requires no library change, and is fully self-contained in the script.
`RunSettings.operation` is a non-`undefined` field (not a `M3LGuardableKey`
key), so it cannot appear in `REQUIRED_FIELDS` rows — it carries the engine's
already-resolved operation, not a config read.

**Why it happened:** This is the first migration where a `finalize` assertion was
operation-keyed to an operation that shares its return type with another
operation. The prior four migrations all had operations that return structurally
distinct types (waiter results carry `.state`, update results carry `.id`), so
the structural guard pattern worked. codepipeline-ops is the boundary case where
two operations (`describe-execution` and `watch-execution`) return the same
wrapper type.

**Fix for future:** Before choosing a structural predicate for `finalize`, check
whether any other operation in the script returns a result with the same
structural shape. If yes, fall back to embedding `operation` in the settings
struct — `resolveSettings` already receives it, and storing it in a non-optional
settings field is the cleanest discriminant.

## Lessons learned

- **Structural finalize guard has a boundary condition** — if two operations in
  the same pipeline return the same structural type, a `"fieldName" in result`
  guard in `finalize` cannot distinguish them. The fallback is to embed
  `operation` in the resolved settings struct: `resolveSettings` already receives
  `operation` from the engine, and storing it in a non-optional field adds no
  overhead and requires no library change. This is codepipeline-ops's precedent
  for any future consumer with the same shape.

- **Verify pre-existing behavior before filing a regression fix** — when a
  reviewer flags a path as a "must-fix," confirm it was also present in the
  pre-migration file before patching. `git show HEAD~2:path/to/file | grep _(promoted → CLAUDE.md)_
relevent_pattern` takes 10 seconds and can prevent a scope-expanding patch
  commit for a behavior that was already there. The sequential
  `persistOutput → assertWatchSucceeded` ordering was visible at a glance in the
  pre-migration code; the migration preserved it correctly into `persist` →
  `finalize`.

- **The settings-carried operation is not re-reading the config** — storing
  `operation` in `RunSettings` by passing the engine's second argument to
  `resolveSettings` is explicitly permitted by the engine contract. The
  prohibition is on re-reading `"operation"` via `accessor.oneOf(...)` inside
  `resolveSettings` (the engine already did that in phase 2). These are distinct:
  one is passing a value already resolved by the engine; the other is re-doing
  the engine's own phase.

- **Five-migration wave closes with zero regression regressions** — every
  `refactor:` migration in the wave (s3-objects, ecs-ops, lambda-ops,
  cloudformation-stacks, eks-ops, codepipeline-ops) passed its characterization
  net at both commit boundaries and had no behavioral regression found by the
  post-commit review fan-out. The two-commit (seam first, orchestrator second)
  pattern is confirmed stable across 13 total operations / 7 dispatch families.
