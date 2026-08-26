# rds-data-sql

Run parameterized SQL — paged queries, bulk loads, single statements, and
transactional migrations — against an Aurora PostgreSQL cluster via the RDS
Data API, using the library's [`aws/rds-data`](../aws/rds-data.md) wrapper.

> **This page is the script's contract** — configuration schema, steps, and
> inputs/outputs. How to _run_ it lives in the colocated
> [`scripts/rds-data-sql/README.md`](../../../scripts/rds-data-sql/README.md).

## Purpose and scope

`rds-data-sql` is the fleet's first relational-store sink and its first
transactional consumer. Of the 13 scripts that preceded it, none reads or
writes a relational database — `json-etl`, `athena-query`,
`cloudwatch-logs-insights`, and `sqs-etl` only ever _produce_ files. This
script fills that gap via four operations, dispatched by the `operation`
config parameter:

- **`query`** — run a caller-supplied `SELECT`, optionally paged, streaming
  results to a file.
- **`load`** — bulk-insert a JSONL/CSV file into a table, chunked and
  transactional per chunk.
- **`execute`** — run a single statement (DML or DDL), reporting rows
  affected; anything not a plain `SELECT` is gated behind a destructive-op
  confirmation.
- **`migrate`** — apply an ordered set of `.sql` files inside one
  transaction, recording applied versions in a migrations table.

The script never constructs an AWS SDK command or imports
`@aws-sdk/client-rds-data` itself; `aws/rds-data`'s `M3LRDSDataOperations` is
the sole abstraction boundary, reached via `script.aws.services.rdsDataOperations`.

**In scope:** single-cluster, single-database SQL execution against a
Data-API-enabled Aurora PostgreSQL cluster, including paged reads,
transactional bulk load, ad hoc DML/DDL, and ordered transactional
migrations. **Out of scope:** schema/cluster provisioning
([`cloudformation-stacks`](./cloudformation-stacks.md)'s concern),
non-Aurora or non-Data-API databases (ADR-0031's rejected `pg`-driver route),
and record-shape transformation beyond the output-format coercion described
below — reformatting a `load`'s input or a `query`'s output is `json-etl`'s
job, not duplicated here.

## Configuration schema

Declared in `src/config.ts` (`configParameters`); config is the script's only
input seam (never `process.env`). Resolution order is CLI > JSON > YAML >
env/.env > preset > default.

| Parameter          | Type           | Default             | Validation                                                                                                                                                       | Description                                                                                                                                                                                                                                                                                                                                                                |
| ------------------ | -------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `aws.profile`      | `STRING`       | _(req.)_            | non-empty                                                                                                                                                        | AWS named profile; declaring this parameter triggers the `script.aws` provisioning seam (`AWS_PROFILE_PARAM_NAME`).                                                                                                                                                                                                                                                        |
| `aws.region`       | `STRING`       | _(unset)_           | non-empty when set                                                                                                                                               | Optional AWS region override, consulted once provisioning is underway (`AWS_REGION_PARAM_NAME`); never independently gates provisioning.                                                                                                                                                                                                                                   |
| `operation`        | `STRING`       | _(req.)_            | `operations: RDS_DATA_SQL_OPERATION_DECLARATIONS` — the 4 declared operations (ADR-0055); membership is derived from the declaration, not a hand-written `oneOf` | Which of the four operations this run performs.                                                                                                                                                                                                                                                                                                                            |
| `cluster.arn`      | `STRING`       | _(req.)_            | non-empty                                                                                                                                                        | Aurora cluster/instance ARN, passed as `resourceArn` to every `aws/rds-data` call.                                                                                                                                                                                                                                                                                         |
| `secret.arn`       | `STRING`       | _(req.)_            | non-empty                                                                                                                                                        | Secrets Manager ARN holding the database credentials, passed as `secretArn`; preflight-validated via `secretsManager.describeSecret` before any statement runs.                                                                                                                                                                                                            |
| `database`         | `STRING`       | _(req.)_            | non-empty                                                                                                                                                        | Target database name.                                                                                                                                                                                                                                                                                                                                                      |
| `schema`           | `STRING`       | _(unset)_           | non-empty when set, identifier pattern                                                                                                                           | Optional schema qualifier; when set, `load`/`migrate`/`execute` reference `<schema>.<table>`/`<schema>.<migrations.table>` by interpolating the qualified, quoted identifier into generated SQL. Also forwarded as the Data API request's own `schema` field on every call — a documented no-op AWS ignores (see Notes).                                                   |
| `sql`              | `STRING`       | _(unset)_           | non-empty when set                                                                                                                                               | Inline SQL statement for `query`/`execute`. Mutually exclusive with `sql.file`; exactly one is required for `query` and `execute`.                                                                                                                                                                                                                                         |
| `sql.file`         | `STRING`       | _(unset)_           | non-empty when set                                                                                                                                               | Path (resolved under `M3L_INPUT_DIR`) to a `.sql` file holding the statement for `query`/`execute`. Mutually exclusive with `sql`.                                                                                                                                                                                                                                         |
| `parameters.file`  | `STRING`       | _(unset)_           | non-empty when set                                                                                                                                               | Optional path (resolved under `M3L_INPUT_DIR`) to a JSON file of named `M3LRDSDataParameter`s bound to `sql`/`sql.file` for `query`/`execute`. For `query` with `page.size > 0`, must not declare a parameter named `limit` or `offset` — reserved by the paging wrapper (`ERR_RDS_DATA_SQL_RESERVED_PARAMETER`); unpaged `query` and `execute` place no such restriction. |
| `input.file`       | `STRING`       | _(unset)_           | non-empty when set                                                                                                                                               | Source file for `load`, resolved under `M3L_INPUT_DIR`; required for `load`.                                                                                                                                                                                                                                                                                               |
| `input.format`     | `STRING`       | `jsonl`             | `oneOf(jsonl, csv)`                                                                                                                                              | `load`'s importer selector — chooses `M3LJSONListImporter` or `M3LCSVListImporter`; no extension sniffing.                                                                                                                                                                                                                                                                 |
| `table`            | `STRING`       | _(unset)_           | non-empty when set, identifier pattern                                                                                                                           | Target table for `load`; required for `load`.                                                                                                                                                                                                                                                                                                                              |
| `columns`          | `STRING_ARRAY` | _(unset)_           | identifier pattern per entry when set                                                                                                                            | Optional explicit `INSERT` column list for `load`. When unset, inferred from the first imported record's keys, each validated against the same identifier pattern; a later record whose key set differs from the resolved column list is rejected to `failed.jsonl` rather than silently binding against the wrong columns.                                                |
| `batch.size`       | `INT`          | `100`               | `range(1, 10_000)`                                                                                                                                               | Row-chunk size for `load`'s `batchExecuteStatement` calls.                                                                                                                                                                                                                                                                                                                 |
| `page.size`        | `INT`          | `1_000`             | `range(0, 10_000)`                                                                                                                                               | Row page size for `query`. `0` issues the caller's statement unpaged. `ERR_RDS_DATA_RESULT_TOO_LARGE` can surface at any `page.size` (including `0`) if a page's encoded result exceeds the Data API's 1 MiB cap.                                                                                                                                                          |
| `output.file`      | `STRING`       | _(unset)_           | non-empty when set                                                                                                                                               | Destination file for `query` results, resolved under `M3L_OUTPUT_DIR`; required for `query`.                                                                                                                                                                                                                                                                               |
| `output.format`    | `STRING`       | `json`              | `oneOf(json, jsonl, csv)`                                                                                                                                        | `query`'s output encoding.                                                                                                                                                                                                                                                                                                                                                 |
| `migrations.dir`   | `STRING`       | _(unset)_           | non-empty when set                                                                                                                                               | Directory (resolved under `M3L_INPUT_DIR`) of `.sql` files applied in lexicographic filename order; required for `migrate`. Each file must hold exactly one statement.                                                                                                                                                                                                     |
| `migrations.table` | `STRING`       | `schema_migrations` | non-empty, identifier pattern                                                                                                                                    | Table tracking applied migration filenames for `migrate`; created if absent.                                                                                                                                                                                                                                                                                               |
| `yes`              | `BOOL`         | `false`             | —                                                                                                                                                                | Bypasses the plain interactive destructive-op confirmation for `execute` (the `s3-objects`/CI-automation precedent) — non-interactive runs must set this explicitly. Never bypasses a sensitive target alone.                                                                                                                                                              |
| `yesSensitive`     | `BOOL`         | `false`             | —                                                                                                                                                                | With `yes`, also bypasses `execute`'s confirmation for a sensitive target (an AWS profile whose name contains `prod`). Ignored unless the target is sensitive.                                                                                                                                                                                                             |

`aws.profile`, `operation`, `cluster.arn`, `secret.arn`, and `database` are
declared `required: true`, so presence is enforced by the library at
**config-load time**. The remaining per-operation requirements are
**cross-parameter** constraints a single parameter's `validate:` callback
cannot express, so (following the `json-etl` precedent, not `dynamodb-crud`'s
run-start guards) they are declared as an **ordered, fail-fast** list of
`Core.M3LConfigSchemaValidator`s in `configValidators`, exported alongside
`configParameters` — `M3LConfigSchema.validate` runs them in declaration
order and throws on the first failure's exact string, coded
`ERR_CONFIG_VALIDATION`:

1. `"'query'/'execute' require exactly one of 'sql' or 'sql.file' to be set"`
   — fires when `operation` is `query`/`execute` and `sql`/`sql.file` are
   both set or both unset. A `sql`/`sql.file` value supplied for `load`/
   `migrate` is silently ignored, not an error.
2. `"'load' requires 'table' and 'input.file' to be set"` — fires when
   `operation` is `load` and either is unset.
3. `"'migrate' requires 'migrations.dir' to be set"` — fires when `operation`
   is `migrate` and it is unset.

`query`'s `output.file` requirement is a fourth per-operation constraint, but
is enforced one layer later than the three above: `build-operation-deps`
throws `Core.M3LError` coded `ERR_RDS_DATA_SQL_INPUT_FILE` (not
`ERR_CONFIG_VALIDATION`) if `operation` is `query` and `output.file` is
unset, since that step (not `configValidators`) is what actually needs the
value.

The **identifier pattern** referenced above (`schema`, `table`, `columns`,
`migrations.table`) is `^[A-Za-z_][A-Za-z0-9_]{0,62}$`. It is enforced at two
points, neither of which is a declared `config.ts` `validate:` callback
(the stock validator set has no per-array-entry check): `resolve-settings`
re-validates every set value at run start (`ERR_RDS_DATA_SQL_SETTINGS`), and
`run-load` additionally validates a `columns` list _inferred_ from the first
imported record's keys, which `resolve-settings` never sees
(`ERR_RDS_DATA_SQL_INVALID_COLUMN`). Every identifier is additionally
double-quoted (with embedded `"` doubled) when interpolated into generated
SQL, since PostgreSQL identifiers cannot be bound as statement parameters the
way values can.

## Steps

One row per `src/steps/` module; each takes injected dependencies (config
values, `script.aws.services.rdsDataOperations`, `script.aws.services.secretsManager`,
logger, paths) as a single options object and is unit-testable without the
`M3LScript` lifecycle.

| Step                   | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resolve-settings`     | Narrows the resolved `M3LConfig` into a typed `RdsDataSqlSettings` interface via `Core.M3LConfigAccessor`, throwing `Core.M3LError` coded `ERR_RDS_DATA_SQL_SETTINGS` if a declared value resolves to an unexpected type or an identifier (`schema`/`table`/`columns`/`migrations.table`) fails the identifier pattern. Resolves `sql.file`/`migrations.dir` as plain path strings only — reading their file contents is `build-operation-deps`'s job.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `preflight-secret`     | One `secretsManager.describeSecret(secret.arn)` call before any operation runs, turning a typo'd or wrong-account secret ARN into `Core.M3LError` coded `ERR_RDS_DATA_SQL_SECRET_PREFLIGHT` instead of an opaque Data API `BadRequestException` surfacing mid-statement.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `build-operation-deps` | Composes the single per-operation dependency bag `run-rds-data-sql` dispatches into, based on `settings.operation`: resolves `sql`/`sql.file` and parses `parameters.file`'s JSON into `M3LRDSDataParameter[]` (for `query`/`execute`), constructs the `M3LCheckpointStore`-backed checkpoint and streaming-writer ports and selects the output exporter by `output.format` (for `query`), selects the importer by `input.format` and the rejection writer (for `load`), and lists/reads `migrations.dir`'s `.sql` files (for `migrate`). Also schema-qualifies and double-quotes `table`/`migrations.table` per the identifier rule above. Throws `Core.M3LError` coded `ERR_RDS_DATA_SQL_INPUT_FILE` on any file-read/parse failure.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `run-rds-data-sql`     | Composes the pipeline — the only module that knows operation dispatch order: preflight → dispatch on `operation` (exhaustive `switch` with a `const exhaustive: never` tail) → the matching read/write step → emit a run summary through the `ctx`-correlated logger. `load` no longer maps a nonzero `failed` count onto a thrown error — every rejected row is reported via `run-load`'s `reportRecovery` seam instead, so `Core.runScript` resolves the run with a `"partial"` outcome (exit code `6`) rather than an error-classified exit; `query`/`execute`/`migrate` failures still propagate their own thrown error unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `run-query`            | Wraps the caller's statement (its trailing `;`/whitespace stripped) as `SELECT * FROM (<sql>) AS m3l_page LIMIT :limit OFFSET :offset` when `page.size > 0`, streaming each page's coerced rows through a writer port injected by `build-operation-deps` (which owns exporter construction and `output.format` selection). `offset` starts at the checkpoint's saved value (or `0`), advances by `page.size` each iteration via `Core.M3LCheckpointStore`, and the loop ends the first time a page returns fewer than `page.size` rows. `page.size = 0` issues the caller's statement unpaged, once. On resume, every row from a prior interrupted run is re-appended to the (freshly-opened, truncating) writer before any new page runs — see Notes for how.                                                                                                                                                                                                                                                                                                                                                                                                            |
| `run-load`             | Imports `input.file` via `Core.M3LListImporter.importStream()` (selected by `input.format`), resolves the column list (`columns`, or the first record's keys) and validates every column name against the identifier pattern, coerces each record's values to `M3LRDSDataValue` (`null→null`, `boolean→boolean`, `string→string`, a safe integer → `long`, any other finite number → `double`; a non-finite number, `undefined`, array, or nested object is rejected to `failed.jsonl` rather than coerced), rejects any record whose key set differs from the resolved columns, chunks the rest to `batch.size`, inserts each chunk via `batchExecuteStatement` inside one `withTransaction` scope per chunk, and checkpoints by chunk index plus a running count of records read from the stream so far (`recordsProcessed`, both accepted and rejected). On resume, every rejected record from a prior interrupted run is re-appended to `failed.jsonl` first; then the stream is re-read from the start, but every record up to the checkpoint's `recordsProcessed` count is skipped entirely (neither re-classified nor re-rejected) rather than re-run — see Notes. |
| `run-execute`          | Runs `sql`/`sql.file` once (bound to `parameters.file`, if set), reporting rows affected. The statement is normalized (leading whitespace stripped, then leading `--…`/`/*…*/` comments stripped, repeated until neither remains) and its first keyword token compared case-insensitively; anything other than `SELECT` is gated behind `Core.confirmDestructive` (`yes`/`yesSensitive`, `code: "ERR_RDS_DATA_SQL_ABORTED"`) — `yes` alone bypasses the plain confirmation, but a sensitive target (an AWS profile whose name contains `prod`) escalates to a typed-echo prompt that only `yes` together with `yesSensitive` bypasses. This check is a **convenience gate, not a security control** — a side-effecting function called from inside a `SELECT` is not detected.                                                                                                                                                                                                                                                                                                                                                                                            |
| `run-migrate`          | Receives `migrations.dir`'s already-read `{filename, sql}` pairs from `build-operation-deps` (which lists and reads the directory), sorts them lexicographically by filename, ensures `migrations.table` exists (`CREATE TABLE IF NOT EXISTS <qualified> (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`), filters out filenames already recorded in `migrations.table`, and applies the remainder — each file exactly one statement — inside **one** `withTransaction` scope that also creates the tracking table and records each applied filename. A failure rolls back every file in that run; if the rollback itself also fails, both errors stay reachable via `.cause` chaining (see Notes) — otherwise `fn`'s own error propagates unchanged. `CREATE INDEX CONCURRENTLY` cannot run inside this transaction (a PostgreSQL restriction, not this script's); split it into its own migration file run as `execute` instead.                                                                                                                                                                                                            |
| `export-results`       | Coerces `M3LRDSDataValue` to its output representation at this boundary only (`null`/`string`/`long`/`double`/`boolean` pass through; `blob` becomes base64), with an exhaustive `switch` on `output.format`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

## Inputs and outputs

- **Reads:** `sql.file`/`parameters.file`/`migrations.dir` (`query`/`execute`/`migrate`)
  and `input.file` (`load`), all resolved under `M3L_INPUT_DIR`.
- **Writes:** `output.file` for `query`, streamed in the format named by
  `output.format`, resolved under `M3L_OUTPUT_DIR`. `load` writes
  `<output-dir>/failed.jsonl` for any row rejected before insertion or any
  chunk whose transaction rolls back. `query`/`load` write a
  `<output-dir>/<operation>.checkpoint.json` (deleted on successful
  completion) for resumable runs.
- **Reports:** a run summary — rows read/written/affected/failed, and for
  `migrate`, the list of applied filenames — so a partial `load` failure is
  never silent: each rejected row is reported via `M3LScript.reportRecovery()`
  as `run-load` classifies or fails to insert it (see `run-rds-data-sql` above
  for the resulting `"partial"` run outcome).

## Notes and behavior

- **`query`/`load`'s checkpoints accumulate the run's already-written
  records, not just a resume position.** `writer.append`/`failedWriter.append`
  open a truncating writer on every run, so a checkpoint holding only an
  `offset`/`chunkIndex` would let a resumed run recreate its output empty and
  silently lose everything a prior interrupted run already wrote — a real bug
  this design closes. `RunQueryCheckpoint.rows`/`RunLoadCheckpoint.failedRecords`
  carry every record written/rejected so far; on resume, all of them are
  re-appended to the freshly-opened writer before any new work runs. This
  mirrors `cloudwatch-logs-insights`'s established `LogsInsightsCheckpoint.rows`
  pattern. **Known tradeoff, tracked as F11**
- **Bound to what the offset means — and, unlike the other three scripts
  fingerprinting a checkpoint, this one has no `resume` config flag to gate
  it.** `query`/`load` each construct their `M3LCheckpointStore` with a
  `definition` (`resourceArn`, `database`, `schema`, and — for `query` — the
  _resolved_ `sql`/`parameters` (not the `sql.file`/`parameters.file`
  selectors, since a file's on-disk contents can change under a fixed path),
  `output.file`, `output.format`, and a derived `paged` boolean (`page.size >
0`; the raw page size itself is excluded — an absolute `OFFSET` resumes
  correctly under any page size) — or, for `load`, `table`, `columns`,
  `input.file`, `input.format`, and `batch.size` (meaning-bearing here, since
  `chunkIndex` counts chunks of that size). `secretArn` is deliberately
  excluded — a rotatable credential locator, not part of the query's
  identity (see [`core/checkpoint`](../core/checkpoint.md)'s note that a
  definition is committed to by its hash and must never carry a credential).
  Because `query`/`load` read their checkpoint on **every** run (there is no
  `resume` gate — see the `<output-dir>/<operation>.checkpoint.json` note
  above), a leftover checkpoint from a differently-configured prior run now
  fails loud with `Core.M3LCheckpointError` / `ERR_CHECKPOINT_FINGERPRINT_MISMATCH`
  instead of silently resuming into the wrong query, table, or file. There is
  no config flag to bypass this — the operator's only escape hatch is
  deleting the stale `<output-dir>/<operation>.checkpoint.json` by hand.
  (`docs/plans/IMPLEMENTATION.md`): the checkpoint (and an in-memory
  accumulator) holds the full result set for the duration of a run, which
  scales with export size rather than staying bounded — accepted for now,
  not something this script currently avoids.
- **`load`'s resume also skips already-processed input records by count, not
  just already-flushed chunks.** `query` re-fetches from a saved `OFFSET`, so
  a resumed run never re-reads a row it already streamed. `load` instead
  re-reads `input.file` from the start every time, and rejection happens
  during per-record classification — _before_ a batch is even complete
  enough to flush as a chunk — so skipping only already-flushed chunks
  (`chunkIndex`) is not enough: a record that failed classification in a
  prior run would otherwise be re-classified (and re-rejected, duplicating
  its `failed.jsonl` entry and inflating the failure count) on every resume.
  `RunLoadCheckpoint.recordsProcessed` tracks the total records read from the
  stream so far (accepted or rejected); on resume, every record up to that
  count is skipped entirely — neither re-accepted nor re-rejected — before
  normal classification resumes. Because those skipped records never reach
  classification, the first chunk formed after a resume is numbered starting
  from `chunkIndex + 1` (the checkpoint's last flushed chunk, plus one), not
  from `0` — a resumed run's chunk numbering continues where the prior run
  left off rather than restarting, keeping it correctly distinct from
  already-flushed chunks.
- **`query`'s paging requires `ORDER BY` inside the caller's statement.**
  `LIMIT`/`OFFSET` alone do not guarantee stable row ordering across pages;
  the wrapping subquery does not add one. `OFFSET` paging over a
  concurrently-mutating table can still skip or repeat rows between pages —
  this is a Data API/PostgreSQL limitation, not something this script
  corrects.
- **`load` and `migrate` are the library's first consumers of
  `withTransaction`'s rollback-failure chaining** (see
  [`aws/rds-data`](../aws/rds-data.md)): when `fn` throws and the subsequent
  rollback **also** fails, both errors stay reachable via the thrown error's
  `.cause` chain rather than one silently replacing the other; when the
  rollback succeeds, `fn`'s own error propagates unchanged.
- **`migrate` runs one transaction per invocation, not per file.** A Data
  API statement is cancelled at roughly 45 seconds and a transaction with no
  activity for 3 minutes is auto-rolled-back — a very large migration batch
  or a single long-running statement can hit either limit; split it across
  runs if so.
- **`schema`, when set, is forwarded as the Data API request's own `schema`
  field on every call — a documented no-op.** AWS does not support that
  field; it is silently ignored. The actual schema qualification happens by
  interpolating the quoted `<schema>.<table>`/`<schema>.<migrations.table>`
  identifier into generated SQL (`build-operation-deps`), not through the
  request field.
- **`query`'s `output.format: csv` loses the value of a result column
  literally named `__proto__`** (and only `__proto__` — a column named
  `constructor` or `prototype` is unaffected, since those are normal own/data
  properties on a plain object, not accessor setters). JSON/JSONL output
  is unaffected. The library's `M3LCSVListExporter` re-materializes each row
  into a plain object internally, so that one column's assignment hits the
  object's prototype setter instead of creating an own property — a known
  CSV-path limitation, not something this script controls. Not a security
  issue (a
  result value is always a primitive, so nothing can be re-parented), only a
  data-loss edge case for a pathologically-named column.

## See also

- [`aws/rds-data`](../aws/rds-data.md) — `M3LRDSDataOperations`
  (`executeStatement`/`batchExecuteStatement`/`beginTransaction`/
  `commitTransaction`/`rollbackTransaction`/`withTransaction`) and the
  `M3LRDSDataValue` discriminated union used throughout.
- [`aws/secrets-manager`](../aws/secrets-manager.md) — `describeSecret`, used
  by the preflight step.
- [`core/checkpoint`](../core/checkpoint.md) — `M3LCheckpointStore`, used by
  `run-query`/`run-load` for resumable runs.
- [`core/importers`](../core/importers.md) — `M3LListImporter`, used by
  `run-load`.
- [`core/prompt`](../core/prompt.md) — `Core.confirmDestructive`, used by
  `run-execute`.
- [`core/script`](../core/script.md) — the `M3LScript` lifecycle the script
  runs on.
- [ADR-0031](../../adr/0031-relational-and-document-data-engine-access.md) —
  the ADR pre-clearing the `aws/rds-data` wrapper and this script's
  per-consumer gate.
- [ADR-0022](../../adr/0022-reintroduce-scripts-workspace.md) — fleet
  conventions.
