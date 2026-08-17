# Work log — cloudformation-stacks pipeline migration (2026-08-17)

This log covers issue #438 — the migration of
`scripts/cloudformation-stacks/src/steps/run-cloudformation-stacks.ts` (578
lines) onto `Core.M3LOperationPipeline`, the third consumer migration in the
ADR-0043 wave (after s3-objects #435, ecs-ops #436, and lambda-ops #454). It
records what shipped, what matched the plan, what required a design decision
(the NOT_FOUND ordering wrinkle), and durable lessons for the remaining
queued migrations (cloudwatch-logs-insights, eks-ops, codepipeline-ops).

Plan of record: [`docs/plans/on-issue-438-peaceful-sunset.md`](../plans/on-issue-438-peaceful-sunset.md)

## Summary

`run-cloudformation-stacks.ts`: **578 → 388 lines (−190)**. The hand-rolled
`DISPATCH_GROUP` routing table, three `isXOperation` type-predicate narrowers
with defensive throws, the `dispatchOperation` dispatch switch, and `runGate`
are deleted. The four dispatch families survive as nine per-operation handler
entries; `planWriteDispatch` / `planCreateOrUpdate` / `resolveTemplateText`
survive as the `prepare` phase. The existing `NOT_FOUND` and `WAIT_NOT_COMPLETE`
assertions are preserved with their documented orderings (see divergence 1
below). 46/46 tests in file, **7 669** total suite green at both commit
boundaries; typecheck, lint, format, and build clean at each boundary.

Two commits, matching the lambda-ops #454 two-commit pattern:

- `c10b367` — `refactor(test)`: barrel-mock gate seam → `prompt.confirm` spy
  (test-author spoke, single pass, no re-dispatch).
- `e9de170` — `refactor`: orchestrator migrated; DISPATCH_GROUP skeleton
  deleted; all five error codes and the `@throws`/`@example` TSDoc preserved
  (code-implementer spoke, single pass).

Code-reviewer and silent-failure-hunter reviews launched post-commit (results
pending PR gate).

Skills used: starting-work, writing-work-logs, creating-prs (pending).

Spoke incidents: 0 truncations / 0 stalls / 0 resumes.

## What went as planned

- **The two-commit pattern replicated without incident** — briefing the
  test-author on the exact seam translation (barrel-mock → spy) upfront let
  it complete in a single pass; the implementer was then handed the green
  characterization net and completed its pass in a single shot too.
- **Seam translation was clean and did not require re-dispatch** — unlike the
  ecs-ops migration (divergence 1 of the prior log), the seam problem was
  pre-identified in the plan; the test-author received an exact spec for
  the `confirmingPrompt` helper and the 1:1 assertion mapping, so the
  barrel-mock issue could not recur as a surprise mid-run blocker.
- **190-line net reduction confirmed the migration value** — cloudformation-stacks
  (9 operations, 4 families) saw a meaningful reduction because the DISPATCH_GROUP
  table, three type predicates with internal defensive throws, and the dispatch
  switch were all deleted — more boilerplate than the ecs-ops baseline.
- **`REQUIRED_FIELDS` replaced scattered inline guards in pass one** — the
  lesson from the ecs-ops review ("same-underlying-call guards move in pass one")
  was applied: the 9-operation `REQUIRED_FIELDS` record replaced every
  `accessor.requiredFor` call across all four dispatcher families without
  a second review round.
- **Untouched files confirmed** — `git diff --stat HEAD~2..HEAD` shows exactly
  two files changed; `main.ts`, `config.ts`, `hooks.ts`, and all four leaf
  steps are untouched, matching the pattern of every prior migration.

## What didn't go as planned, and why

### 1. NOT_FOUND ordering required moving the assert INTO the handler

The engine's ten-phase run order is: Accessor → Operation → Settings → Guards →
Prepare → Gate → **Dispatch → Persist → Finalize → Outcome**. The existing code
asserted `describe-stack NOT_FOUND` _before_ persist (the spec documents this
ordering explicitly). No engine phase sits between Dispatch and Persist for a
pre-persist assertion. `assertDescribeStackFound` could not be placed in
`finalize` (that runs _after_ persist), so it was moved **into**
`dispatchReadStacks` — thrown during the Dispatch phase when
`operation === "describe-stack" && result === undefined`. The frozen test
asserts that when NOT_FOUND fires, no persist call occurs, so the ordering
invariant is preserved.

**Why it happened:** the prior wave migrations (s3-objects, ecs-ops, lambda-ops)
had no pre-persist throw pattern; cloudformation-stacks is the first consumer
that needed it. The plan identified this wrinkle ahead of time ("one wrinkle"
section), so it was not a surprise — but it is worth recording explicitly as
the precedent for any future consumer with the same shape.

**Fix for future:** when a consumer script asserts a NOT_FOUND / empty-result
condition _before_ persist, move the assertion into the relevant handler
(Dispatch phase) rather than `finalize`. Document the ordering invariant in
the handler's comment so future maintainers don't move it to `finalize`.

### 2. `finalize` receives no `operation` — structural guard required (again)

As in ecs-ops, `finalize` does not receive the current operation. The
`assertWaitComplete` function used `isWaitOperation(operation)` to detect wait
results; `finalize` cannot, so a structural `isWaiterResult` guard
(`"state" in result`) is needed to identify `AWS.M3LCloudFormationWaiterResult`.
The implementer verified that no other member of `DispatchResult` carries a
`state` field (CloudFormation `Stack` uses `stackStatus`). The error message
uses `"wait operation"` in place of the operation name; the frozen tests assert
only on the code (`ERR_CLOUDFORMATION_STACKS_WAIT_NOT_COMPLETE`) and the
persist-before-throw ordering, not the message text.

**Why it happened:** the engine's `finalize` signature is `(result, settings,
deps)` — no `operation` argument. This is the same limitation ecs-ops
encountered, and the s3-objects + ecs-ops + lambda-ops + cloudformation-stacks
pattern now confirms it recurs on every consumer with a post-dispatch structural
assertion. This is the third migration to need the workaround; the prior log's
lesson ("if a third migration needs it, that's the trigger for a semver-minor
engine enhancement") fires here.

**Fix for future:** open a backlog item to pass `operation` to `persist` /
`finalize` as a semver-minor engine enhancement (additive). Until then, document
the structural guard pattern so the next migration author can copy it without
re-inventing it.

## Lessons learned

- **Pre-identifying migration wrinkles in the plan eliminates spoke blockers** —
  specifying the NOT_FOUND-into-handler decision and the `confirmingPrompt` seam
  translation before the spokes launched meant both passed in a single shot;
  neither had to stop and report a design decision mid-run. The plan's concision
  on "exactly what to change" was the key.

- **The two-commit pattern (seam first, orchestrator second) is validated as
  the right shape** — the seam commit is independently green, giving the
  orchestrator commit a solid frozen characterization net at its entry point.
  Shipping them as a single commit would lose this invariant.

- **`finalize` structural guard is now a wave pattern, not a one-off** — three
  of four complete migrations (ecs-ops, lambda-ops, cloudformation-stacks) needed
  a structural type predicate in `finalize` because the engine passes no
  `operation`. Log the backlog item; don't apply the workaround silently a fourth
  time. _(promoted → docs/plans/IMPLEMENTATION.md)_

- **NOT_FOUND-before-persist belongs in the Dispatch handler** — any consumer
  with a "must assert empty result BEFORE persist" contract should throw that
  assertion inside the relevant handler function (Dispatch phase), not in
  `finalize` (post-persist). This is now the documented precedent for
  cloudformation-stacks.

- **190 lines deleted confirms the per-op handler table scales** — a 9-operation
  / 4-family dispatcher with a DISPATCH_GROUP routing table and per-family
  predicates holds ~190 lines of boilerplate the engine replaces with a flat
  exhaustive record. The benefit grows with operation count.
