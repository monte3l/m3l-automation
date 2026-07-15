# 2026-07-15 — W2 fleet reconciliation (merge outcomes for #120, #127–#129)

Work logs are written in-session, pre-merge, and are immutable once landed —
so the W2 burst's merge outcomes were recorded nowhere, and the
`aws/logs-insights` submodule (PR #120) never received a dedicated log at
all (its session logged the consumer script instead). This log closes both
gaps, per decision D4 of the 2026-07-15 fleet-governance audit
([plan](../plans/archive/2026-07-15-fleet-governance-reconciliation.md)).
It records outcomes post-hoc; the in-session logs it complements stay
untouched.

## Merge ledger

| PR   | Unit                   | Merged (UTC)     | Merge commit | Size                  | Tests at close        | In-session log                                                 |
| ---- | ---------------------- | ---------------- | ------------ | --------------------- | --------------------- | -------------------------------------------------------------- |
| #118 | `aws/dynamodb`         | 2026-07-12 23:25 | `eea9c49`    | +2180/−50 in 24 files | 49 (100% cov)         | [aws-dynamodb](./2026-07-13-aws-dynamodb.md)                   |
| #119 | `aws/sqs`              | 2026-07-13 00:22 | `e6bdddf`    | +2066/−29 in 30 files | 28                    | [aws-sqs](./2026-07-13-aws-sqs.md)                             |
| #120 | `aws/logs-insights`    | 2026-07-13 07:28 | `6a50877`    | +1334/−80 in 22 files | 19 (100% per-file)    | **none** — §below stands in                                    |
| #127 | `sqs-etl`              | 2026-07-13 10:20 | `4f5f590`    | +5026/−3 in 35 files  | 102 (91 at log close) | [sqs-etl](./2026-07-13-sqs-etl.md)                             |
| #128 | `dynamo-crud`          | 2026-07-13 11:22 | `9aacd02`    | +4433/−8 in 26 files  | 83                    | [dynamo-crud](./2026-07-13-dynamo-crud.md)                     |
| #129 | `logs-insights` script | 2026-07-13 13:53 | `07e1772`    | +2821/−16 in 28 files | 66                    | [scripts-logs-insights](./2026-07-13-scripts-logs-insights.md) |

## `aws/logs-insights` (#120) — stand-in record

The first operation-level AWS wrapper under ADR-0027 (the ADR is the plan —
no archived plan exists, by design). 9 exports: `M3LLogsInsightsClient`
wrapping `StartQuery`/`GetQueryResults` over `M3LPoller` +
`M3LPollingPolicies.cloudWatchLogsQuery()`, with the
`startQuery()`/`awaitResults()` decomposition that lets a consumer
checkpoint an in-flight `queryId` before polling; two typed errors
(`M3LLogsInsightsStartQueryError`, `M3LLogsInsightsQueryFailedError`) and
five plain types. 19 tests, 100% per-file coverage. 5-spoke review applied
1 must-fix on a two-reviewer convergent finding: both SDK-send failure paths
now wrap as typed errors with `cause`, and `GetQueryResults` gained the
same `awsThrottling()` retry `StartQuery` already had. No new runtime deps
(`@aws-sdk/client-cloudwatch-logs` was already a hard library dependency).
Moved the count-enforced ledger 24→25 (AWS 5→6).

## Review-driven fix rounds (recorded post-hoc)

- **#128 `dynamo-crud`** — 3-reviewer fan-out (code, security,
  silent-failure) found and fixed **1 critical + 2 must-fix + 4 should-fix**
  across two fix rounds; an adversarial security refute pass confirmed
  clean. (Now also recorded in the `IMPLEMENTATION.md` W2 row.)
- **#129 `logs-insights` script** — same fan-out found and fixed
  **1 must-fix + 6 should-fix** across two rounds.
- **#127 `sqs-etl`** — the in-session log records five divergences and the
  91→102 test growth; no fix-round tally was recorded in any tracker for
  this PR — exactly the closure gap this log exists to end (see Lessons).
- **#118/#119** — outcomes live in their dedicated logs (notably: #118's
  `UnprocessedItems` malformed-entry masking must-fixes; #119's orphaned
  `Failed[].Id` now-throws must-fix).

## Archived-plan divergences (recorded here; archives stay immutable)

- The archived
  [2026-07-09 implementation plan](../plans/archive/2026-07-09-consumer-scripts-implementation-plan.md)
  §5.1 sited DynamoDB support at `core/dynamodb`; it shipped as
  `aws/dynamodb` (the ADR-0027 boundary placed all SDK-touching wrappers
  under `aws/`).
- Its §5.2 named `logs-insights` step modules `startQuery.ts` /
  `awaitResults.ts` / `normalizeRows.ts`; the shipped decomposition is
  `resolve-settings` / `time-range` / `checkpoint` / `export-results` /
  `run-logs-insights` — the startQuery/awaitResults split migrated _into
  the library_ as `M3LLogsInsightsClient` methods.
- Its W4 designs assumed script-local dependencies (`pg`, `mongodb`,
  `@kubernetes/client-node`, `@smithy/signature-v4`) — superseded by
  ADR-0029; the living tracker rows were redesigned accordingly.

## Audit verdict (2026-07-15)

All 11 `check:*` drift detectors passed; every finding lived outside their
coverage: two unwritten policies (now ADR-0028/ADR-0029), untracked count
literals that rotted (CLAUDE.md's AWS barrel said 4, actual 6; ROADMAP's
header said 24/24, actual 25/25 — follow-up T4), this merge-outcome closure
gap, and the stale `docs/logs/README.md` index (fixed in the same PR).

## Lessons learned

- **A passing check suite proves only what it covers.** Every drift item
  was an untracked literal or an unwritten convention; the fix is pushing
  them into machinery (ROADMAP follow-ups T4–T6), not auditing harder.
- **Merge outcomes need a durable home.** Logs close pre-merge by design;
  the tracker row is the right place for the fix-round tally — record it
  when flipping the row's status (the `Maintenance` step), as the W2 rows
  now demonstrate.
- **Write the policy ADR when the first unit ships, not after three.** Both
  governance gaps were visible at `json-etl` time; by W2 the drift had
  already reached names on disk and a ratified-in-passing dependency
  exception.
