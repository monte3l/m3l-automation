# `aws/rds-data` wrapper + `rds-data-sql` script (2026-08-14)

**Status: shipped** — PR 1 (`feat/aws-rds-data`, `aws/rds-data`) merged as
[#424](https://github.com/monte3l/m3l-automation/pull/424); PR 2
(`feat/rds-data-sql`, the consumer script) in this change set. Closes issue
#204.

## Context

`/auditing` was invoked against issue #204 — an investigative task asking
whether a consumer script (and related library additions) would add
significant value, or whether the issue should be rejected. ADR-0031
(Accepted) had already pre-cleared every hard design question — the RDS Data
API as the sole access route, the ADR-0026/0027 typed-wrapper class shape, a
synchronous `rdsData` getter — leaving only ADR-0027's per-consumer-need gate
open. The audit found that gate genuinely open (a Data-API-enabled Aurora
cluster was reachable) and the value real: of the fleet's 13 scripts, none
read or wrote a relational store, and nothing in the library was
transactional. The audit's plan settled a 2-PR chain (wrapper, then script),
matching the `aws/cloudformation`+`cloudformation-stacks` and
`aws/codepipeline`+`codepipeline-ops` precedent.

## Approach / Decisions

- **`M3LRDSDataValue` preserves the SDK's typed `Field` union** (a
  discriminated `null`/`string`/`long`/`double`/`boolean`/`blob` shape)
  rather than coercing to strings, the deliberate contrast with `aws/athena`'s
  `AthenaRow = Record<string,string>`.
- **`withTransaction`'s rollback-failure chaining took 5 fix rounds in PR 1**
  to converge on guarding both the read and write of a caught error's
  `.cause` in one `try`/`catch` per link, with a read-back verification —
  promoted into `.claude/rules/library-src.md` as a durable rule (see
  `docs/logs/2026-08-14-aws-rds-data.md`).
- **PR 2's contract-verification pass found 11 blocking ambiguities** before
  any test was written — paging offset progression, `load`'s column-inference
  identifier-injection gap, value-coercion direction, a missing
  `input.format` parameter, `execute`'s missing `yes`/abort-code, the
  SELECT-detection heuristic's exact normalization rules, four `migrate`
  gaps (DDL, Data-API duration limits, `CREATE INDEX CONCURRENTLY`,
  one-statement-per-file), a wrong `withTransaction`-chaining claim, a
  missing `schema`-never-forwarded note, and an unspecified non-zero-exit
  mechanism. All 11 were closed in the contract page before RED.
- **A 9th step module, `build-operation-deps.ts`, wasn't named in the
  original contract** — `resolve-settings.ts` was deliberately scoped to
  avoid file I/O, but nothing named the module that performs the deferred
  reads/parsing/port construction until GREEN reached the composition layer.
  Retrofitted into the contract page's Steps table once designed (see
  `docs/logs/2026-08-14-rds-data-sql.md`, divergence 1).
- **A 3-reviewer Phase 4 fan-out found 1 Must-fix (confirmed independently
  by two reviewers) and 8 Should-fix items**, closed across 2 further rounds
  — the last an adversarial security-reviewer confirmation pass that found a
  `__proto__`-output-record fix held for JSON/JSONL but not
  `output.format: csv` (a `M3LCSVListExporter` library-internal limitation,
  confirmed non-security via executed probes, documented rather than
  fixed in this PR since it's outside the script's own file boundary).
- **Doc-drift repair, done independent of the build**: three sites still
  carried ADR-0031's original (inverted) citation —
  `docs/reference/scripts/athena-query.md`, `docs/reference/aws/athena.md`,
  and `docs/ROADMAP.md`'s W4 row all claimed ADR-0031 "declined"/"dropped"
  the Aurora/DocumentDB wrappers, when ADR-0029 dropped `pg`/`mongodb` and
  ADR-0031 separately re-admitted Aurora. All three corrected; issue #205's
  now-false "W1–W5 closed, no further script planned" rationale reworded in
  both trackers without touching its ID/status cells.
- **Tracker status intentionally left at "In review", not "Done".** The D4
  `aws/rds-data` gate's final Deferred→Done flip needs PR 2's own merged PR
  number, which isn't known while authoring this change set — matching this
  repo's actual precedent for other 2-PR chains (confirmed via `git log -S`
  rather than assumed), where the flip lands in a later `docs:`
  reconciliation commit once both real numbers exist.

## Outcome

`aws/rds-data`: `M3LRDSDataOperations` (`executeStatement`/
`batchExecuteStatement`/`beginTransaction`/`commitTransaction`/
`rollbackTransaction`/`withTransaction`), 2 new error codes, 52 tests,
merged as #424. `rds-data-sql`: 9 `src/steps/*.ts` modules + a shared
`src/lib/identifiers.ts` helper, 4 operations (`query`/`load`/`execute`/
`migrate`), 138 tests across 10 files. Full workspace: `pnpm verify` 36/36
applicable steps (3 correctly skipped), `/syncing-docs` 13/13 clean. Neither
PR was smoke-run end-to-end against a live Data-API-enabled Aurora cluster —
flagged as an open item on both PRs, still owed. See
`docs/logs/2026-08-14-aws-rds-data.md` and
`docs/logs/2026-08-14-rds-data-sql.md` for the full narrative, including the
5-round `withTransaction` fix saga (PR 1) and the 4-round post-review fix
saga (PR 2).
