# Plan: A5b — bound the unbounded pagination loops

**Status: shipped** — landed as PR #664 (library) and PR #665 (fleet +
tracker close-out) on `fix/a5b-bound-pagination-loops` and
`fix/a5b-fleet-close-out`, closing issue #506. Work log:
[`docs/logs/2026-08-26-a5b-bound-pagination-loops.md`](../../logs/2026-08-26-a5b-bound-pagination-loops.md).

## Context

Second PR of the A5 two-PR chain (the A1b/A2b/A3b/A4b precedent). A5 (PR
#501) shipped an opt-in no-progress witness — `progress: { witness,
maxStalledAttempts }` — on `M3LPollerOptions`/`M3LRetryRunnerOptions`, but no
real call site passed it, so no run was actually guarded. Issue #506's own
row named two pieces of work: (a) threading `progress` into `aws/athena` and
`aws/cloudwatch-logs-insights`'s poller construction, and (b) bounding four
unconditionally unbounded `do … while (cursor !== undefined)` pagination
loops with no ceiling of any kind.

Re-deriving the row's claims against the tree (per CLAUDE.md) before
implementing found part (a) mechanically true but functionally hollow: both
named consumers poll a binary terminal status with no visibility into
intermediate poll responses, so a script-supplied witness there could only
be a constant — degrading `maxStalledAttempts` into a strictly worse
`maxAttempts` that would abort healthy long-running queries. The row also
missed two script call sites that build their own poller/runner
(`codepipeline-ops`'s `watch-execution.ts`, `dynamodb-crud`'s
`batch-write-table.ts`), both similarly unwitnessable for their own reasons
(another status wait; a throttling-sensitive retry with no reliable stall
signal).

## Approach / Decisions

- **Part (a) scoped as a documented no-op**, not implemented — the
  correction and its evidence are recorded in the tracker row and this log
  rather than threading a witness that would make two scripts worse.
- **Part (b) mechanism: an always-on, non-configurable repeated-cursor
  guard**, not an opt-in witness. A repeated pagination cursor is
  unconditionally pathological (unlike a slow-but-real poll), so an opt-in
  design would have repeated A5's own failure — a capability nothing
  actually uses.
- **Two-PR landing** (ADR-0072): PR #664 shipped the library fix — new
  `internal/aws/pagination.ts` (`createPageCursorGuard()`) wired into
  `aws/dynamodb`'s `queryItems`/`scanSegment` and `aws/s3`'s `listObjects`,
  throwing the existing `M3LNoProgressError` (`ERR_NO_PROGRESS`) on a
  consecutive cursor repeat. `packages/m3l-common` `4.3.0 → 4.3.1` (patch,
  zero new exported symbols). PR #665 closed the fleet gap —
  `scripts/eventbridge-schedules`'s hand-rolled `drainRules` loop, fixed with
  a local repeated-token check (scripts can't import `internal/`) reusing
  the library's `ERR_NO_PROGRESS` string code for cross-fleet narrowing
  consistency — plus the tracker flips this plan covers.
- **Guard placement is load-bearing in both PRs**: the check sits outside
  each loop's error-rewrapping `try`/`catch`, so a tripped guard's
  `M3LNoProgressError`/`ERR_NO_PROGRESS` propagates unwrapped rather than
  being silently re-labeled as the wrong operation-error code — verified
  directly by tests, not just by placement inspection, in both PRs.
- **Composite-cursor comparison (DynamoDB's `LastEvaluatedKey`) is
  key-order-normalized and `bigint`/`Uint8Array`-safe**, matching the
  discipline `docs/reference/core/polling.md` already prescribed for a
  caller keying a composite witness into a primitive.
- **Scope is deliberately narrow**: the guard catches only two consecutive
  identical cursor observations, not a longer alternating cycle
  (`a → b → a → …`) — a repeated cursor is the only shape that's
  unconditionally pathological; a cycle could coincidentally be legitimate
  paging state. Documented explicitly in both the public `docs/reference`
  pages and the internal module's own header comment (the latter refined
  post-merge in response to the automated PR-review bot's Should-fix).

## Outcome

- PR #664: 23 new tests (14 direct guard unit tests, 9 regression tests
  across `dynamodb.test.ts`/`s3.test.ts`), 100% coverage on all 3
  touched/new source files. 5-spoke review round plus a second pre-push
  review pass on the fix-round diff; both PASS with 2 must-fix items applied
  (stale test counts, `M3LNoProgressError`'s own TSDoc no longer accurately
  covering both throwers) and one should-fix deferred (narrowing the cursor
  value type would require widening the public `DynamoDBKey` type — out of
  scope for a patch fix). Squash-merged as `b373cb4`.
- PR #665: 3 new tests on `scripts/eventbridge-schedules`'s `list-rules`
  step; 2-spoke review, clean. Tracker rows flipped —
  `docs/plans/IMPLEMENTATION.md`'s **A5b** `To Do → Done`,
  `docs/ROADMAP.md`'s **A5** `To Do → Done` (closing pre-existing drift from
  A5's own PR #501 landing without a ROADMAP flip).
- `pnpm sync:hub` re-applied after merge to archive issue #506.

Full narrative, spoke incidents, and durable lessons:
[`docs/logs/2026-08-26-a5b-bound-pagination-loops.md`](../../logs/2026-08-26-a5b-bound-pagination-loops.md).
