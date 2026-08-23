# cloudwatch-logs-analysis

Analyze CloudWatch alarm evidence with a codified runbook procedure and produce an operator verdict

> **This page is the script's contract** — configuration schema, steps, and
> inputs/outputs. How to _run_ it lives in the colocated
> [`scripts/cloudwatch-logs-analysis/README.md`](../../../scripts/cloudwatch-logs-analysis/README.md).

## Purpose and scope

Given a CloudWatch alarm name and the time it fired, this script walks the
alarm's runbook evidence chain and reaches an operator verdict: what the error
is, whether the runbook already knows about it, the ticket and resolution it
records, and which follow-up checks are left to the human.

It is the named consumer that opens
[ADR-0046](../../adr/0046-codified-procedure-engine.md)'s intake gate for
`core/procedure`. The **analysis spine is codified in TypeScript** — one
ten-step graph, identical for every alarm — while everything that varies per
alarm is **preset data**: log groups, query text, window offsets, the severity
ladder, the correlation rule, chain depth, thresholds, escalation target, and
the known-cases table. [ADR-0076](../../adr/0076-codified-runbook-analysis-presets.md)
records that split and the `caseId: string` tradeoff it rests on.

Four operations. Only `analyze` reaches AWS; `validate`, `explain` and
`convert` run entirely offline, which is what makes `validate` a CI gate.

**Out of scope, by design.** Everything downstream of the log verdict is
emitted as report follow-ups rather than executed: key-value table lookups,
object-store artifact and checksum verification, relational read-model SQL,
metric-graph inspection, gateway/function configuration checks, chat
notification, ticket creation, spreadsheet capture. Keeping them out is what
keeps `AWS.M3LLogsInsightsClient` sufficient — this script needs no new AWS
wrapper. Alarms whose evidence is not in a log group at all (metric-only
alarms, batch invocation failures, synthetic-canary artifacts, data-lake SQL
analyses) are **declared** `unsupported` by their preset and never guessed at;
their manual steps become follow-ups.

## Configuration schema

Declared in `src/config.ts` (`configParameters`); config is the script's only
input seam. Per-operation requiredness is adjudicated by `configValidators`
at config-load time, before any step runs, and re-checked by the pipeline's
Guards phase.

| Parameter        | Type           | Default    | Validation                                   | Required for                     | Description                                                              |
| ---------------- | -------------- | ---------- | -------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------ |
| `operation`      | `STRING`       | `analyze`  | `oneOf(analyze, validate, explain, convert)` | all                              | Which operation to run                                                   |
| `aws.profile`    | `STRING`       | —          | `nonEmpty`; cross-parameter                  | `analyze`                        | Local AWS profile; declaring it is what provisions `script.aws`          |
| `alarm`          | `STRING`       | —          | `nonEmpty`; cross-parameter                  | `analyze`, `explain`             | The alarm name; also the preset's file stem                              |
| `triggeredAt`    | `STRING`       | —          | `nonEmpty`; ISO-8601 parse (cross-parameter) | `analyze`                        | When the alarm fired; the window is derived from it                      |
| `runbookDir`     | `STRING`       | `runbooks` | `nonEmpty`                                   | `analyze`, `validate`, `explain` | Preset directory, relative to `M3L_INPUT_DIR`                            |
| `source`         | `STRING`       | —          | `nonEmpty`; cross-parameter                  | `convert`                        | Runbook markdown file, relative to `M3L_INPUT_DIR`                       |
| `leadMinutes`    | `INT`          | —          | `range(0, 1440)`                             | —                                | Overrides the preset's own history-before-trigger offset                 |
| `lagMinutes`     | `INT`          | —          | `range(0, 1440)`                             | —                                | Overrides the preset's own after-trigger offset                          |
| `severityLadder` | `STRING_ARRAY` | —          | `nonEmpty`                                   | —                                | Overrides the preset's own severity rungs                                |
| `maxDepth`       | `INT`          | `4`        | `range(1, 8)`                                | `analyze`                        | Ceiling on trace hops, capping the preset's own chain length             |
| `interactive`    | `BOOL`         | `false`    | —                                            | `analyze`                        | Lets `decide-trace-depth` ask the operator instead of taking the ceiling |
| `output`         | `STRING`       | —          | `nonEmpty`                                   | —                                | Report / skeleton file name under `M3L_OUTPUT_DIR`                       |
| `format`         | `STRING`       | `json`     | `oneOf(json, text)`                          | —                                | Reserved for the report rendering; the archived artifact is always JSON  |

`leadMinutes`, `lagMinutes` and `severityLadder` deliberately carry **no
default**: absent means "the preset decides". A default here would silently
overwrite every alarm's authored window with a fleet-wide guess.

## Steps

One row per `src/steps/` module; each takes injected dependencies and is
unit-testable without the lifecycle.

| Step                           | Responsibility                                                                                           |
| ------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `run-cloudwatch-logs-analysis` | The `Core.M3LOperationPipeline` dispatcher: settings, per-operation guards, dispatch, report persistence |
| `preset`                       | The preset schema, the procedure shape, the verdict vocabulary, and the evidence collector               |
| `load-runbook`                 | The trust boundary: parses and validates one preset; lists a preset directory                            |
| `build-procedure`              | Compiles one preset into a validated `Core.M3LProcedure`                                                 |
| `gather-logs`                  | Adapts `AWS.M3LLogsInsightsClient` to the narrow gatherer seam the `gather` steps run through            |
| `correlation`                  | Pattern extraction: the correlation key, the error signature, the observed authorizer latency            |
| `analyze-alarm`                | The incident-time path: load, compile, run, report                                                       |
| `report`                       | Verdict, evidence, rejected cases and follow-ups — as an artifact and as console prose                   |
| `validate-runbooks`            | Builds every preset offline and reports every problem at once                                            |
| `explain-runbook`              | Prints one preset's compiled step graph, cases and digest                                                |
| `convert-runbook`              | Turns one runbook markdown file into a preset skeleton, with `todos` for what it could not extract       |
| `write-artifact`               | Writes one JSON artifact under `M3L_OUTPUT_DIR`, creating the destination directory first                |

### The compiled step graph

Codified — identical for every preset. A stage the preset does not declare
still executes and returns `{ flow: "continue" }` with the note
`skipped: stage not declared`, so a skipped stage stays visible in the
telemetry.

| Step                      | Kind        | Flow                                                                                             |
| ------------------------- | ----------- | ------------------------------------------------------------------------------------------------ |
| `resolve-window`          | `transform` | Derives `[start, end)` from `triggeredAt` ± the preset offsets; `stop` for an out-of-scope alarm |
| `widen-severity`          | `control`   | Selects the ladder rung; execution _n_ selects rung _n − 1_                                      |
| `gather-entry`            | `gather`    | The preset's entry query at the selected rung                                                    |
| `check-entry-evidence`    | `check`     | Rows ⇒ `continue`; none + rung left ⇒ `{ goTo: "widen-severity" }`; none + exhausted ⇒ `stop`    |
| `gather-authorizer`       | `gather`    | Runs only when declared **and** the observed latency exceeds the preset's threshold              |
| `extract-correlation`     | `transform` | No key, or a key that is not query-safe ⇒ `stop`                                                 |
| `decide-trace-depth`      | `decide`    | `Core.M3LPrompt` when `interactive`; the configured ceiling otherwise                            |
| `gather-trace-level`      | `gather`    | `jumpsTo: ["gather-trace-level"]`, capped by the decided depth                                   |
| `extract-error-signature` | `transform` | Derives the value the known cases match on, deepest hop first                                    |
| `match-known-cases`       | `check`     | `flow: "resolve"` — evaluates every case now                                                     |

Cases are one per preset known-case row, plus three codified terminal cases at
reserved priorities: `unsupported` (3), `no-correlation-id` (2), `no-evidence`
(1). The mandatory fallback is `unrecognised`, which escalates to the preset's
owning team carrying the engine's `investigated` list.

### Verdict vocabulary

`known-no-action`, `known-open-issue`, `known-closed-issue`,
`transient-downstream`, `no-correlation-id`, `no-evidence`, `unsupported`,
`unrecognised`.

A preset's own case rows may declare only the first four and `unrecognised`;
the other three are reserved for the codified terminal cases and are rejected
in `cases[].verdict` at the trust boundary.

## Preset schema

One JSON file per alarm, named `<alarm>.json`, inside `runbookDir`. Validated
field by field by `load-runbook.ts` — a malformed preset fails at load with a
message naming the offending field.

| Field                 | Type                                                 | Required             | Description                                                                             |
| --------------------- | ---------------------------------------------------- | -------------------- | --------------------------------------------------------------------------------------- |
| `alarm`               | `string`                                             | yes                  | The alarm name; matches the file stem                                                   |
| `title`               | `string`                                             | yes                  | One-line operator-facing title                                                          |
| `escalateTo`          | `string`                                             | yes                  | The team an unrecognised error escalates to                                             |
| `unsupported`         | `{ reason, manualSteps }`                            | —                    | Declares the alarm out of scope; its manual steps become follow-ups                     |
| `entry`               | query stage                                          | unless `unsupported` | `{ logGroups, query, limit? }` over the alarm's own log groups                          |
| `correlation`         | `{ field, pattern, label }`                          | unless `unsupported` | How the correlation key is pulled out; `pattern`'s first capture group is the key       |
| `signature`           | `{ field, pattern?, levelField?, serviceField? }`    | unless `unsupported` | How the matched-on error signature is derived                                           |
| `severityLadder`      | `string[]`                                           | —                    | The rungs retried, in order, when the entry query finds nothing                         |
| `severityPlaceholder` | `string`                                             | —                    | The token in `entry.query` each rung is substituted into; absent makes the ladder inert |
| `window`              | `{ leadMinutes, lagMinutes }`                        | —                    | Offsets around the trigger time; defaults to `5`/`15`                                   |
| `authorizer`          | query stage + `{ latencyField, latencyThresholdMs }` | —                    | The optional authorizer hop                                                             |
| `trace`               | query stage + `{ label, rekeyPattern? }` array       | —                    | The optional trace chain, innermost hop last                                            |
| `cases`               | case row array                                       | —                    | The known-cases table; may be empty (the fallback always exists)                        |
| `followUps`           | `string[]`                                           | —                    | Follow-up checks that apply to every verdict for this alarm                             |
| `todos`               | `string[]`                                           | —                    | Unresolved `convert` markers; a non-empty list **fails** `validate`                     |

A **query stage** is `{ logGroups: string[], query: string, limit?: number }`.
A trace hop's `query` may carry the token `{{key}}`, which is replaced by the
current correlation key; the entry query may carry `severityPlaceholder`,
which is replaced by the selected ladder rung.

**Both substituted values are allow-listed, never escaped.** A correlation key
or a severity rung must match `/^[\w.:/@#=+-]{1,256}$/` — enough for severity
levels, UUIDs, trace ids, request ids and ARNs, and not enough to break out of
a quoted literal. A rung is checked at whichever boundary it arrived through
(the preset trust boundary, or `applyRunOverrides` for the `severityLadder`
config override); a key that fails the check stops the analysis with the
`no-correlation-id` verdict rather than running an altered query.

A **case row** is
`{ id, description, prose, priority, pattern, level?, service?, verdict, ticket?, resolution?, escalateTo?, followUps? }`.
`priority` must be a unique integer **above 9** — `1`–`9` are reserved for the
codified terminal cases — and higher wins, so a narrow row beats a broad one
regardless of authoring order.

### `convert`'s override fence

`convert` reads what it can out of a runbook's markdown — the H1 title, the
first Logs Insights query fence, log-group-shaped inline code spans, and the
first markdown table as known-case rows — and records everything else as a
`todo`. What prose cannot express (the correlation rule above all) may instead
be declared in an `m3l-preset` JSON fence inside the runbook, whose fields are
merged over the extracted skeleton. A runbook carrying one converts to a
preset that passes `validate` unattended.

## Error codes

| Code                                  | Meaning                                                                                  |
| ------------------------------------- | ---------------------------------------------------------------------------------------- |
| `ERR_LOGS_ANALYSIS_CONFIG`            | An operation's required config value is missing, or `operation` is off-union             |
| `ERR_LOGS_ANALYSIS_PRESET`            | A preset is unreadable, is not JSON, or fails the trust boundary                         |
| `ERR_LOGS_ANALYSIS_PROCEDURE`         | A compiled step reached a preset stage that is not there, or an unparsable `triggeredAt` |
| `ERR_LOGS_ANALYSIS_EXTRACTION`        | A pattern that reached the extraction helpers does not compile                           |
| `ERR_LOGS_ANALYSIS_GATHER`            | A stage declared no log groups, too many, or an empty window                             |
| `ERR_LOGS_ANALYSIS_VALIDATION`        | `validate` found at least one problem across the preset directory                        |
| `ERR_LOGS_ANALYSIS_CONVERT`           | The `m3l-preset` override fence is not a JSON object                                     |
| `ERR_LOGS_ANALYSIS_RUN`               | The procedure failed before reaching a verdict; thrown after the report is logged        |
| `ERR_LOGS_ANALYSIS_NO_CORRELATION_ID` | `getCorrelationId()` was called before `onBeforeRun` — a wiring bug                      |

Build-time preset problems surface under the engine's own
`ERR_PROCEDURE_*` codes, carried in `context.problems` as
`Core.M3LProcedureValidationProblem`s and reported one row each by `validate`.

## Inputs and outputs

**Reads** (`M3L_INPUT_DIR`): preset JSON files under `runbookDir` (`analyze`,
`validate`, `explain`), and the runbook markdown named by `source`
(`convert`). Both are resolved through `M3LPaths` and cannot escape the input
directory, so an out-of-repo preset store is reached by pointing
`M3L_INPUT_DIR` at it rather than by passing an absolute path.

**Writes** (`M3L_OUTPUT_DIR`): for `analyze`, one JSON `AnalysisReport` named
`output` or, absent that, `<alarm>-<correlationId>.json`; for `convert`, the
preset skeleton named `output` or `<source-stem>.json`. `validate` and
`explain` write nothing.

The report carries the verdict and its prose, the ticket and resolution, the
evidence stages with their true row counts (rows themselves capped at 50 per
stage), the cases the engine checked with their satisfied/rejected verdicts,
the follow-ups, both digests, and the per-step telemetry. **It contains
gathered log rows** and should be handled like the logs it came from; the
console summary carries counts, case ids and runbook prose only.

**Resume and failure semantics.** There is no checkpoint: an analysis is short,
read-only, and cheap to re-run — and a re-run against the same preset and the
same `triggeredAt` produces the same `digest`/`parametersDigest` pair, which is
how two runs are known to be comparable. A run cancelled via `script.signal`
(ADR-0049) surfaces as an `aborted` outcome whose report states that no verdict
was reached; a step failure surfaces as `failed`, and the report — carrying
whatever evidence was gathered before the failure — is logged **before**
`ERR_LOGS_ANALYSIS_RUN` is thrown.

## See also

- [`aws/cloudwatch-logs-insights`](../aws/cloudwatch-logs-insights.md) — the typed query wrapper this script's only AWS seam
- [`core/procedure`](../core/procedure.md) — the codified-procedure engine
- [`core/pipeline`](../core/pipeline.md) — the operation dispatcher
- [ADR-0076](../../adr/0076-codified-runbook-analysis-presets.md) — the codified-spine / preset-driven-cases split
- [ADR-0046](../../adr/0046-codified-procedure-engine.md) — the engine, and the named-consumer condition this script discharges
- [`core/script`](../core/script.md) — the `M3LScript` lifecycle the script runs on
- [ADR-0022](../../adr/0022-reintroduce-scripts-workspace.md) — fleet conventions
