# Work log — descope dynamodb-crud pipeline migration (2026-08-17)

This log records the decision to reclassify the `dynamodb-crud` pipeline migration
(tracker row "Pipeline migration — dynamodb-crud", issue #442) from `To do` to
`Rejected` in `docs/plans/IMPLEMENTATION.md`. `dynamodb-crud` is the only consumer
script named explicitly by slug in ADR-0043's scope boundary — a stronger exclusion
than cloudwatch-logs-insights (issue #439, handled in PR #459 on the same date).

Plan of record: harness plan `on-issue-439-stateless-torvalds` (covers both issues #439
and #442 — same scope-conflict pattern; not checked into `docs/plans/`).

## Summary

**Files changed:** `docs/plans/IMPLEMENTATION.md` (row 133), new work-log
`docs/logs/2026-08-17-descope-dynamodb-crud-pipeline-migration.md`.

**Decision:** `scripts/dynamodb-crud/src/steps/run-*.ts` (761 lines) will **not** be
migrated onto `Core.M3LOperationPipeline`. The tracker row is reclassified `Rejected`;
issue #442 closes as "not planned."

**Rationale — named out-of-scope by slug in ADR-0043:**

ADR-0043's 2026-08-16 update lists "Deliberately out of scope: checkpoint/resume
(`dynamodb-crud`), …" — `dynamodb-crud` is the only consumer script called out by
its slug in the scope boundary, not merely by category. This is a stronger exclusion
than the category-level "single-operation scripts" and "checkpoint/resume" criteria
that removed cloudwatch-logs-insights.

**What makes `dynamodb-crud` structurally different from the migrated scripts:**
`dynamodb-crud` is a multi-operation dispatcher (it has an operation union, a
`REQUIRED_FIELDS` table, and a destructive gate — all the things the engine targets).
The reason it cannot migrate is not the dispatcher skeleton but what wraps around it:
per-operation DynamoDB-backed checkpoint/resume state management
(`M3LCheckpointStore`). The engine absorbs the dispatcher skeleton; it has no phase
for checkpoint/resume orchestration. Migrating `dynamodb-crud` would preserve every
handler and error code but leave the checkpoint/resume layer as a hand-rolled wrapper
around the engine — adding an indirection layer without removing the structural
complexity that motivates the script's length.

By contrast, every migrated script (s3-objects, ecs-ops, lambda-ops,
cloudformation-stacks) had a self-contained dispatcher skeleton with no cross-operation
state. Their migrations net-deleted 100–190 lines of dispatcher boilerplate. A
`dynamodb-crud` migration would net-zero or add lines, and the ADR knew this when it
wrote the slug-level exclusion.

**Precedent chain:** issue #439 (cloudwatch-logs-insights, same date), `41e54aa` (D4
DocumentDB, 2026-08-13), `0ef72f6` (ADR-0016 Bash-write revisit trigger, 2026-08-17),
all using `Rejected` as the in-vocabulary "won't do" term. PR #459 already added a
reconciliation note to the parent row ("Step-pipeline engine", row 127) flagging the
`dynamodb-crud` slug-level exclusion as requiring separate scope review — this PR
closes that open item.

**Skills used:** `starting-work`, `writing-work-logs`.

**Spoke incidents:** none.

## What went as planned

- **Slug-level exclusion is unambiguous.** ADR-0043 names `dynamodb-crud` by slug, so
  no pattern-matching against the "8 multi-op dispatchers" target was required — the
  ADR explicitly removed it before this issue was opened.
- **Pattern recognition from adjacent work.** The cloudwatch-logs-insights analysis
  (same session, PR #459) established the procedure and Status-vocabulary research,
  making this reclassification a direct application of the same pattern without
  re-deriving it.
- **No row-127 conflict.** PR #459 already added the dynamodb-crud flag note to the
  parent row. Leaving row 127 untouched on this branch avoids a merge conflict
  entirely.

## What didn't go as planned, and why

### 1. The `dynamodb-crud` issue was filed from the same over-broad backlog template as `cloudwatch-logs-insights`

Both issues (#439 and #442) were opened as part of the batch "six migration rows"
without checking each item against ADR-0043's out-of-scope list. The two that were
out-of-scope from the start — cwli (single-op + checkpoint/resume) and dynamodb-crud
(slug-named checkpoint/resume) — are now both reclassified in the same session.

**Why it happened:** batch row creation from a partial reading of the ADR ("8
multi-op dispatchers") without cross-checking the exclusion list ("checkpoint/resume
(`dynamodb-crud`)") in the same section.

**Fix for future:** already recorded in the cwli work-log lesson and the parent row's
reconciliation note: when writing a batch of backlog rows from an ADR, verify each
item against the ADR's out-of-scope list explicitly, not just the scope criteria.

## Lessons learned

- **Slug-level exclusions in ADRs are absolute.** When an ADR names a specific
  component by its slug in the "out of scope" list, no amount of analysis of the
  component's actual shape can override it — the maintainer already performed that
  analysis when writing the slug. Act on the exclusion directly; do not re-derive it. _(promoted → CLAUDE.md)_

- **Batching related reclassifications in the same session is efficient.** Finding the
  cwli conflict (PR #459) immediately surfaced the dynamodb-crud conflict in the same
  session. Handling both the same day keeps the tracker accurate and closes both
  issues without additional context-loading overhead.

- **Leave already-reconciled parent rows untouched.** When PR #459 already added the
  dynamodb-crud flag to row 127, touching that row again on a concurrent branch would
  create a merge conflict. Reading the diff of in-flight PRs before editing shared
  rows prevents unnecessary conflicts.
