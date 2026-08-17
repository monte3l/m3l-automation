# Work log — descope cloudwatch-logs-insights pipeline migration (2026-08-17)

This log records the decision to reclassify the `cloudwatch-logs-insights` pipeline
migration (tracker row "Pipeline migration — cloudwatch-logs-insights", issue #439) from
`To do` to `Rejected` in `docs/plans/IMPLEMENTATION.md`. The work consisted of a
scope-conflict analysis, a maintainer-confirmed reclassification, and a tracker/doc update
to surface the reasoning durably. No code was changed.

Plan of record: harness plan `on-issue-439-stateless-torvalds` (not checked into `docs/plans/`).

## Summary

**Files changed:** `docs/plans/IMPLEMENTATION.md` (2 rows), new work-log
`docs/logs/2026-08-17-descope-cwli-pipeline-migration.md`.

**Decision:** `scripts/cloudwatch-logs-insights/src/steps/run-cloudwatch-logs-insights.ts`
(565 lines) will **not** be migrated onto `Core.M3LOperationPipeline`. The tracker row is
reclassified `Rejected`; issue #439 closes as "not planned."

**Rationale — two independent out-of-scope counts against ADR-0043's 2026-08-16 scope
boundary:**

1. **Single-operation:** `cloudwatch-logs-insights` has no `operation` config param, no
   operation union, no dispatch table. `M3LOperationPipeline` reads `"operation"` from the
   config as a hard-fixed first step; a migration would require inventing a synthetic
   single-member union and a meaningless config param that the engine mandates but the script
   has no use for.
2. **Checkpoint/resume:** the script runs a window-loop that checkpoints each query's
   in-flight ID before polling and accumulates per-window state across restarts. ADR-0043's
   update explicitly names `dynamodb-crud` (checkpoint/resume) as out-of-scope; the same
   boundary applies here. `.claude/rules/scripts.md` likewise sanctions the two-level split
   — not the engine — for checkpoint/resume dispatchers.

**What a forced migration would look like:** synthetic single-member `operation` union,
meaningless `"operation"` config param surfaced to callers, the entire window-loop wrapped
in one handler — net-adding boilerplate while deleting no real dispatcher skeleton (no
`DISPATCH_GROUP` table, no `runGate`, no type predicates to remove). The reference migrations
(cfn −190 lines; lambda-ops −110 lines) netted real deletions because they deleted genuine
multi-op routing code.

**`dynamodb-crud` flag:** the `dynamodb-crud` migration row (#133, "To do") is multi-op
but checkpoint/resume — ADR-0043 names it out-of-scope by name on the resume count. Its row
status is left unchanged in this change (a separate scope review is needed), but a
reconciliation note is added to the parent "Step-pipeline engine" row (#127) so the
over-reach is visible.

**Skills used:** `starting-work`, `writing-work-logs`.

**Spoke incidents:** none (no code-implementer or test-author spokes dispatched — docs-only
change).

## What went as planned

- **Conflict surfaced cleanly in exploration.** Three parallel Explore agents read the script
  structure, the reference migration pattern (s3-objects/ecs-ops, lambda-ops/cfn diffs), and
  the `M3LOperationPipeline` API + ADR-0043. All three independently flagged the
  single-operation + checkpoint/resume mismatch before any editing began.
- **Primary source verification held.** The ADR and `pipeline.md` scope boundary were
  confirmed against the actual files (not just the exploration agents' prose), and the
  IMPLEMENTATION.md row content was confirmed to be byte-exact before editing.
- **Tracker gate research was precise.** A second parallel pair of Explore agents determined
  the exact six-value Status enum (`check:tracker-status`), that `Rejected` is the correct
  in-vocabulary "won't do" term, that no provenance sidecar or doc-count applies, and that
  the hub-sync closes #439 as `not planned` when its row is `Rejected` and
  `pnpm sync:hub -- --apply` is run. No guessing.
- **Identity cell left byte-identical.** The hub-sync key `impl:pipeline-migration-cloudwatch-logs-insights`
  is derived from the Item cell; preserving it exactly means the existing issue marker
  (`<!-- m3l-hub-sync:impl:pipeline-migration-cloudwatch-logs-insights -->` in #439's body)
  still matches and the close-as-`not planned` action will fire on the next `sync:hub --apply`.

## What didn't go as planned, and why

### 1. The tracker row was miscategorized — the six-row backlog over-reached ADR-0043's target

The "remaining 6 migration rows" were written as a batch when the engine shipped, applying
the same template to every remaining `run-*.ts` file above a size threshold. The template
was correct for the 4 multi-op dispatchers without checkpoint/resume, but it also caught
`cloudwatch-logs-insights` (single-op + checkpoint/resume) and `dynamodb-crud`
(multi-op + checkpoint/resume, named out-of-scope by ADR-0043 by name). The tracker row
advertised work that contradicted the ADR authorizing it.

**Why it happened:** batch-writing the six rows did not cross-check each against the ADR's
"deliberately out of scope" list (`dynamodb-crud` is named there explicitly; single-operation
scripts less so). The rows were uniform templates, so the mismatch went unnoticed until this
issue was examined.

**Fix for future:** when writing a batch of backlog rows from an ADR's scope list, explicitly
verify each item against the ADR's _out-of-scope_ list before opening an issue. A row whose
item is named out-of-scope in the same ADR is miscategorized from the start.

## Lessons learned

- **Cross-check backlog rows against the authorizing ADR's out-of-scope list.**
  A batch of migration rows written from an ADR-triggered backlog may silently include items
  the same ADR names as out-of-scope. Verify each item both ways — that it satisfies the
  scope criteria _and_ does not appear on the exclusion list — before opening the issue.

- **The six-value Status enum is the full vocabulary.** `Rejected` is the only in-vocabulary
  term for "won't do / out-of-scope" (`check:tracker-status` hard-fails on anything else).
  `Deferred` means "later, not never." Using the wrong term would fail the pre-push gate;
  knowing the enum up front prevents a wasted commit cycle.

- **Hub-sync closure flows through the body marker, not the issue number.**
  The `impl:<slug>` key derived from the Item cell is what links a tracker row to its GitHub
  issue. Editing the Item cell text changes the key and orphans the existing issue. Always
  leave the Item cell byte-identical when reclassifying a row; put the rationale in the
  Change/notes cells only. Confirmed by commit `0ef72f6` ("ID cell untouched, so its
  sync:hub item key still matches issue #210's body marker").

- **ADR scope-boundary edits are rarely needed for reclassifications.**
  ADR-0043's decision text already stated the scope boundary correctly; no ADR amendment was
  needed. The correct action was to align the tracker row with the existing ADR, not the
  reverse. Amending an ADR to justify a tracker row is the wrong order of operations.
