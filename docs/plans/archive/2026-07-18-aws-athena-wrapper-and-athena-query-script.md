# `aws/athena` wrapper + `athena-query` script (2026-07-18)

**Status: shipped** — PR 1 (`feat/aws-athena`, #162) and PR 2 (`feat/athena-query`)

## Context

`/starting-work` was invoked against `docs/ROADMAP.md` + `docs/plans/IMPLEMENTATION.md`
targeting `athena-query`, the last-but-one W4 consumer script. Exploration
found the trackers' phrasing — "Athena via existing getter + `athenaQuery()`
policy" — predated the ADR-0029 script-dependency-boundary hardening: the
`athena` getter on `AWSClientProvider` returns a **raw `AthenaClient`**, and
scripts are banned from importing `@aws-sdk/*` directly (T6, ESLint-enforced).
`athena-query` had nothing library-side to call. This reshaped scope into a
2-PR chain — a new `aws/athena` operations wrapper first, then the script —
mirroring the precedent `api-gateway-client` set with its `aws/signing`
prerequisite (see the row above).

## Approach / Decisions

- **PR 1 — `aws/athena` library submodule:** built in a new linked worktree
  (`m3l-automation-aws-athena`, branch `feat/aws-athena`) via the full
  `scaffolding-submodules` → `implementing-submodules` pipeline. `M3LAthenaClient`
  mirrors the finished `aws/cloudwatch-logs-insights` wrapper's async
  start/await decomposition (`startQuery`/`awaitResults`/`runQuery`), so a
  future resumable script can checkpoint an in-flight `QueryExecutionId`
  before polling. Every SDK send (`StartQueryExecution`/`GetQueryExecution`/
  `GetQueryResults`) is retried under `M3LRetryRunner`+`awsThrottling()`;
  `awaitResults` polls via `M3LPoller`+`athenaQuery()`.
- **Athena-specific row-normalization contract:** `GetQueryResults` returns
  the column header as the first row of the **first page only** (SELECT/DML
  queries); the implementation keys every row by
  `ResultSetMetadata.ColumnInfo[].name` — never the header row's text — skips
  exactly the first page's first row, and accumulates rows across every
  `NextToken` page. This was the highest-risk logic in the module and is
  fully specified in `docs/reference/aws/athena.md`'s "Row normalization
  contract" section.
- **5-spoke review** (`code-reviewer`, `spec-conformance-reviewer`,
  `security-reviewer`, `type-design-analyzer`, `silent-failure-hunter`) ran
  in parallel. Three review spokes stalled past an hour with no output — well
  outside the ~8–10 min the other two took on the same diff — and were killed
  and redispatched with tightly bounded scopes (explicit file lists, no
  open-ended exploration); all three converged within ~90 seconds on retry.
  `code-reviewer` and `silent-failure-hunter` independently converged on the
  same should-fix: a `GetQueryResults` page carrying data rows but missing/
  empty `ColumnInfo` silently normalized to `{}` rows instead of surfacing an
  error. Fixed by extracting `#normalizePage`, which now throws
  `M3LAthenaQueryFailedError` (`status: "UNKNOWN"`, no `cause`) on that shape.
  Security, type-design, and conformance passes were all clean, no must-fix.
- **Rebase conflict:** `aws/s3` (PR #160) landed on `origin/main` mid-session,
  independently adding its own new AWS submodule to the same shared files
  (`src/aws/index.ts`, doc-count prose, the `implementation-status.md` AWS
  table). Every conflict was a pure independent-addition union (both rows/
  export-lines needed to survive, not "pick a side"), but one touched
  `src/**` — resolved only after explicit user authorization, per
  `resolving-merge-conflicts`'s unconditional hand-back rule for logic-path
  conflicts. `docs/reference/core/errors.provenance.json` also conflicted
  (both `aws/s3` and `aws/athena` independently modified `M3LError.ts` to
  register their own error codes) — a same-module provenance conflict,
  resolved by picking either stale blob and letting `check-doc-provenance.mjs
--update` re-stamp to the merged content afterward.
- 20 tests (expanded from 6 RED seeds); `client.ts` 100% stmts/functions/
  lines, 88.88% branches. Full workspace suite post-rebase: 3416 tests,
  build/typecheck/lint/format all green.
- **PR 2 — `scripts/athena-query`:** deliberately deferred to a later
  session, per plan; picked up once `aws/athena` had merged to `main` (#162).
  Built in a new linked worktree (`m3l-automation-athena-query`, branch
  `feat/athena-query`) via `scaffolding-scripts` → `implementing-scripts`.
  Mirrors `cloudwatch-logs-insights`'s start/checkpoint/await/export pattern,
  simplified for a single non-windowed query: `startQuery()` checkpoints the
  in-flight `queryExecutionId` before `awaitResults()` polls to completion, so
  `--resume true` can reattach instead of re-issuing the query on a terminal
  failure or interruption. `code-reviewer`, `security-reviewer`, and
  `silent-failure-hunter` all came back clean; the one should-fix (extract
  settings-narrowing into its own `resolve-settings.ts` step, for parity with
  the sibling script's testability) was applied. Also fixed a stale
  `script.aws.athena` → `script.aws.clients.athena` reference left in
  `docs/reference/aws/athena.md` from PR 1.

## Outcome

`aws/athena` (`M3LAthenaClient` + 9 supporting types/errors) shipped on
`feat/aws-athena` (#162), unblocking `athena-query`. `scripts/athena-query`
then shipped on `feat/athena-query`, closing out the W4 tracker item. See
`docs/logs/2026-07-18-aws-athena.md` (PR 1) and the athena-query work log
(PR 2) for the full narratives.
