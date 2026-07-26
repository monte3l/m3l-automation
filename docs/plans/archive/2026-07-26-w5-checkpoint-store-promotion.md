# W5 §1.2 — checkpoint/resume promotion (2026-07-26)

**Status: shipped** — PR 1 (`feat/core-checkpoint`, #230) and PR 2
(`refactor/checkpoint-fleet-retrofit`, #231)

## Context

`/starting-work` was invoked against `docs/ROADMAP.md` + `docs/plans/IMPLEMENTATION.md`,
targeting the W5 promotion-pass item named as the next candidate after
`Core.confirmDestructive` (#226): "Checkpoint/resume convention (§1.2)".
Exploration found `scripts/athena-query/src/steps/checkpoint.ts` and
`scripts/cloudwatch-logs-insights/src/steps/checkpoint.ts` were near-verbatim
duplicates (differing only in payload shape, type-guard body, and error-code
string), and `scripts/dynamodb-crud/src/steps/scan-table.ts` had a third,
structurally different private variant. Two findings reshaped the scope beyond
simple de-duplication: none of the three wrote atomically despite the archived
2026-07-09 consumer-scripts plan's §1.2 mandating write-temp-then-rename, and
only `dynamodb-crud` correctly threw a typed error when `--resume` found no
checkpoint — `athena-query`/`cloudwatch-logs-insights` silently started fresh.

## Approach / Decisions

- **A new library submodule, not a promoted function.** Because the three
  implementations disagreed with each other and with the ratified §1.2 spec,
  there was no single "current behavior" to preserve mechanically — §1.2,
  ratified before any of the three was written, was treated as the
  tie-breaker. `Core.M3LCheckpointStore<TCheckpoint>` (`core/checkpoint`)
  ships a required `validate` predicate (closing the "trust whatever's on
  disk" gap `dynamodb-crud`'s unchecked `JSON.parse(raw) as ScanCheckpoint`
  cast exemplified), a caller-selected `missing` policy
  (`{kind:"empty"} | {kind:"error"}`), and unconditional atomicity via a new
  internal `internal/files/atomicWrite.ts` — no write-temp-then-rename
  primitive existed anywhere in the library before this.
- **2-PR chain with a `pnpm check:dup` collapse gate between them**, mirroring
  the `confirmDestructive` promotion's shape: PR 1 shipped the library
  submodule alone (contract review → RED → GREEN → 4-spoke review → doc sync);
  PR 2 retrofitted the three scripts onto it. The collapse gate (if jscpd
  duplication rose between PR 1's new file and the still-present script
  duplicates, the two PRs would merge into one) never triggered — the
  percentage went down at every measurement point.
- **The one embedded behavior change shipped in its own `fix:` commit**,
  separate from the mechanical `refactor:` swap, so both commit types stayed
  honest: `athena-query`/`cloudwatch-logs-insights` gained the
  `--resume`-with-no-checkpoint typed error (`ERR_CHECKPOINT_MISSING`)
  `dynamodb-crud` already had.
- **4-spoke review ran on both PRs** (`code-reviewer`, `spec-conformance-reviewer`,
  `type-design-analyzer`, `silent-failure-hunter`) — zero must-fix findings on
  either PR's code. PR 1's only must-fix findings were doc-bookkeeping (stale
  provenance sidecar, stale reference index), fixed via `/syncing-docs`. PR 2's
  fix round applied two independent reviewers' convergent finding — `cloudwatch-logs-insights`
  constructing `Core.M3LCheckpointStore` twice (once in the orchestrator, once
  in the delete-on-success hook) with hand-duplicated arguments — by extracting
  a shared `steps/checkpoint.ts` + `buildCheckpointStore` factory.

## Outcome

`core/checkpoint` (6 exports, 23 tests, 100% coverage on all 3 new files) is
live and adopted by all three fleet scripts. jscpd went 3.56%/85 clones
(pre-PR-1 baseline) → 3.54%/86 (post-PR-1) → 3.32%/82 (post-PR-2) — down at
every step despite one deliberate new clone (a `M3LCheckpointError`/
`M3LFtsIndexError` constructor mirror). Several pre-existing/moved-verbatim
should-fix findings (weak `LogsInsightsCheckpoint` validation, `ScanCheckpoint`'s
shallow-readonly mutation hazard, a stale `ERR_DYNAMO_CRUD_CHECKPOINT` code
name) were deliberately deferred as new `docs/plans/IMPLEMENTATION.md` P2 rows
rather than expanding either PR's scope. Full narrative, spoke incidents, and
durable lessons: `docs/logs/2026-07-26-w5-promote-checkpoint-store.md`.
