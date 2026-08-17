# Work log — eks-ops pipeline migration (2026-08-17)

This log covers issue #440 — the migration of
`scripts/eks-ops/src/steps/run-eks-ops.ts` (654 lines) onto
`Core.M3LOperationPipeline`, the fourth consumer migration in the ADR-0043 wave
(after s3-objects #435, ecs-ops #436, lambda-ops #454, and cloudformation-stacks
#457). It records what shipped, what matched the plan, what required a design
decision (the dual structural-guard requirement in both `persist` and `finalize`),
and durable lessons for the remaining queued migration (codepipeline-ops).

Plan of record: `~/.claude/plans/on-issue-440-parsed-newt.md` (session-local;
not archived — routine migration, covered by this work log).

## Summary

`run-eks-ops.ts`: **654 → 668 lines (+14)**. The two-level type-predicate chain
(`dispatchOperation` / `dispatchClusterOperation` / `dispatchNodegroupOperation`),
the five `is*` narrowers (`isClusterReadOperation`, `isClusterWaitOperation`,
`isNodegroupReadOperation`, `isNodegroupWaitOperation`, `isNodegroupOperation`),
the six individual `dispatch*` leaf dispatchers, and the hand-rolled gate
(`gateOperation`) are deleted. The six per-operation-group handlers survive as 16
per-operation handler table entries; `resolveClusterInput`/`resolveNodegroupInput`
are absorbed into `prepare`; `assertFound` moves inside `dispatchReadClusters`/
`dispatchReadNodegroups`. The existing five error codes and their ordering
invariants (NOT_FOUND before persist, UPDATE_FAILED/WAIT_NOT_COMPLETE after) are
preserved. 117/117 tests green at both commit boundaries; typecheck, lint, format,
and build clean at each boundary.

Net line increase (+14) reflects the 16-entry `REQUIRED_FIELDS` record and the two
structural predicates (`isWaiterResult`/`isUpdateResult`), partially offset by
deleted dispatch boilerplate. The engine-owned ordering guarantees and compile-time
handler-completeness check are the migration's value, not the line count.

Two commits, matching the cloudformation-stacks #457 two-commit pattern:

- commit 1 — `refactor`: barrel-mock gate seam → `prompt.confirm` spy
  (test-author spoke, single pass, no re-dispatch). 117 tests green against
  the unmigrated orchestrator.
- commit 2 — `refactor`: orchestrator migrated; two-level dispatch chain deleted;
  all five error codes and `@throws`/`@example` TSDoc preserved
  (code-implementer spoke, single pass).

Code-reviewer and silent-failure-hunter found no must-fix findings. Three optional
nits noted (dead `?? ""` fallback, double reader construction, `describe` callback
not narrowed to the destructive subset) — all non-correctness, within scope guard.

Skills used: starting-work, writing-work-logs, creating-prs.

Spoke incidents: 0 truncations / 0 stalls / 0 re-dispatches.

## What went as planned

- **The two-commit pattern replicated without incident** — both spokes completed
  in a single pass; the seam translation briefing included the exact
  `confirmingPrompt` helper spec and `yes: true → prompt.confirm NOT called`
  behavioral re-framing, leaving no design decisions for the test-author mid-run.
- **REQUIRED_FIELDS absorbed all 16 operation guards in pass one** — the
  `kubernetesVersion` guard for `update-cluster-version` (previously inline in
  `dispatchWriteCluster`) moved to the table without a second review round.
- **NOT_FOUND-before-persist via handler throw** — same wrinkle as
  cloudformation-stacks #457; pre-identified in the plan, executed without
  incident. `dispatchReadClusters` and `dispatchReadNodegroups` throw
  `ERR_EKS_OPS_NOT_FOUND` when `result === undefined`; the Dispatch-phase throw
  guarantees persist never runs for a not-found describe outcome.
- **Untouched files confirmed** — `git diff --stat HEAD~2..HEAD` shows two files
  changed (`run-eks-ops.ts` + `run-eks-ops.test.ts`); `main.ts`, `config.ts`,
  `hooks.ts`, and all six leaf steps are untouched.

## What didn't go as planned, and why

### 1. `persist` also receives no `operation` — scrub required structural detection

The cloudformation-stacks log recorded the "no `operation` in `finalize`"
wrinkle (structural guard needed). eks-ops extends the problem to `persist`: the
current `persistOutput` used `operation.startsWith("wait-")` and
`operation.startsWith("update-")` to decide whether to apply `buildSafeSummaryFields`
before exporting. The pipeline's `persist` callback signature is
`(result, settings, deps)` — no `operation` argument — so the same structural
detection (`isWaiterResult`/`isUpdateResult`) replaces the string-prefix checks in
both `persist` and `finalize`.

The `isUpdateResult` predicate (`"id" in result`) was verified against all
`DispatchResult` members via `aws/eks/types.ts`: `M3LEKSUpdate` is the only union
member with an `id` field (the `M3LEKSClusterSummary` TSDoc explicitly lists `id`
among deliberately-omitted fields). The security property — persisted file never
leaks beyond the declared field set — is confirmed by the characterization test's
"scrub" block covering both the waiter and update allowlists, and by the
silent-failure-hunter audit.

**Why it happened:** ecs-ops / lambda-ops / cloudformation-stacks did not use a
security scrub in `persist` (they persisted results whole, or used persist only for
output). eks-ops is the first migration to carry both a persist scrub and
`finalize` assertions, requiring structural detection in two pipeline callbacks.
The same `isWaiterResult`/`isUpdateResult` predicates serve both, so no new
mechanism is needed — but the dual-callback requirement is new and worth recording.

### 2. `finalize` receives no `operation` — dual structural guards (waiter + update)

Unlike cloudformation-stacks (one waiter family, one structural predicate),
eks-ops's `finalize` must distinguish two terminal-failure families: waiter
(`ERR_EKS_OPS_WAIT_NOT_COMPLETE`) and update (`ERR_EKS_OPS_UPDATE_FAILED`). The
`isWaiterResult` / `isUpdateResult` pair covers this correctly. Summary/list
results fall through both guards without any assertion — correct, since the
NOT_FOUND throw in the read handlers is the only assertion that applies to those
results, and it fires in Dispatch (pre-persist), not `finalize`.

The `Cancelled` `M3LEKSUpdate.status` terminal value is unreachable at this
call site (the EKS API returns `InProgress` at submission time; the script does
not describe-poll an in-flight update), and the `@throws` contract only documents
`Failed`. The silent-failure-hunter confirmed the omission is deliberate and safe.

## Lessons learned

- **The structural-guard pattern is now confirmed for both `persist` and
  `finalize` in the same migration** — if a consumer uses a scrub in `persist`
  that was previously operation-keyed, it will need structural detection there
  too, not just in `finalize`. Document this in the plan when the operation
  name was used for the scrub decision.

- **Two independent structural predicates (`isWaiterResult` + `isUpdateResult`)
  are enough to cover a 16-operation / two-family dispatcher** — the predicates
  are defined once at the top of the file and reused in `persist`, `finalize`,
  and the `runEksOps` completion-log logic. No combinatorial explosion.

- **A net line increase does not indicate migration failure** — the 16-entry
  `REQUIRED_FIELDS` record and the structural predicates add surface, while the
  deleted two-level chain and five narrowers remove it. For a 16-operation
  dispatcher with two required-field families, the REQUIRED_FIELDS record
  (16 entries × avg 2 fields) is longer than the deleted guards, causing the
  net +14. The compile-time completeness check and engine-owned phase ordering
  remain the migration's value.

- **codepipeline-ops (590 lines, remaining "To do" row) shares the same
  structural shape** — it is likely to need the same structural-guard pattern
  if it uses a persist scrub or has a post-dispatch assertion that was
  previously operation-keyed. Pre-identify this in its plan.
