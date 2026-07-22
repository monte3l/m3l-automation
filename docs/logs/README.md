# Work logs

Per-unit work logs — the durable narrative of what shipped, what diverged, and
the lessons, written during the session that did the work. Logs are **immutable
history**: they are not edited after landing (unlike the living trackers in
[`../ROADMAP.md`](../ROADMAP.md) and
[`../plans/IMPLEMENTATION.md`](../plans/IMPLEMENTATION.md)). New logs are added
by `/writing-work-logs`; recurring lessons graduate into the rules/agents via
`/promoting-work-log-lessons`. Run that sweep after **every 5 new logs** —
`/writing-work-logs` Step 5 checks this (it counts logs newer than the latest
`promoted →` stamp and prompts the sweep at 5+), or sooner whenever a lesson in
a fresh log feels familiar from an earlier one. Logs are **pipeline-scoped** —
submodule and script implementation units get one; chore/docs/CI PRs
deliberately do not.

## Library — Core & AWS submodules (v1.0 → v1.1)

| Date       | Module             | Log                                             |
| ---------- | ------------------ | ----------------------------------------------- |
| 2026-06-29 | `core/errors`      | [errors](./2026-06-29-core-errors.md)           |
| 2026-06-29 | `core/events`      | [events](./2026-06-29-core-events.md)           |
| 2026-06-30 | `core/environment` | [environment](./2026-06-30-core-environment.md) |
| 2026-06-30 | `core/security`    | [security](./2026-06-30-core-security.md)       |
| 2026-06-30 | `core/utils`       | [utils](./2026-06-30-core-utils.md)             |
| 2026-07-01 | `core/analysis`    | [analysis](./2026-07-01-core-analysis.md)       |
| 2026-07-01 | `core/json`        | [json](./2026-07-01-core-json.md)               |
| 2026-07-02 | `core/config`      | [config](./2026-07-02-core-config.md)           |
| 2026-07-02 | `core/messaging`   | [messaging](./2026-07-02-core-messaging.md)     |
| 2026-07-02 | `core/network`     | [network](./2026-07-02-core-network.md)         |
| 2026-07-02 | `core/polling`     | [polling](./2026-07-02-core-polling.md)         |
| 2026-07-02 | `core/prompt`      | [prompt](./2026-07-02-core-prompt.md)           |
| 2026-07-02 | `core/storage`     | [storage](./2026-07-02-core-storage.md)         |
| 2026-07-02 | `core/text`        | [text](./2026-07-02-core-text.md)               |
| 2026-07-03 | `aws/models`       | [aws-models](./2026-07-03-aws-models.md)        |
| 2026-07-03 | `core/exporters`   | [exporters](./2026-07-03-core-exporters.md)     |
| 2026-07-03 | `core/files`       | [files](./2026-07-03-core-files.md)             |
| 2026-07-03 | `core/importers`   | [importers](./2026-07-03-core-importers.md)     |
| 2026-07-03 | `core/logging`     | [logging](./2026-07-03-core-logging.md)         |
| 2026-07-03 | `core/script`      | [script](./2026-07-03-core-script.md)           |

## Consumer-fleet program (ADR-0021 Phase 5 / ADR-0022)

| Date       | Unit                                                                       | Log                                                                |
| ---------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 2026-07-09 | Script production pipeline (generator + gates)                             | [script-pipeline](./2026-07-09-script-pipeline.md)                 |
| 2026-07-10 | W0-L1 — `core/json` extraction extension (`extractAll`)                    | [core-json](./2026-07-10-core-json.md)                             |
| 2026-07-11 | W0-L2 — `aws/clients` getters (cloudWatchLogs/dynamoDBDocument/athena)     | [aws-clients](./2026-07-11-aws-clients.md)                         |
| 2026-07-11 | W1 — `json-etl` (first end-to-end consumer script)                         | [scripts-json-etl](./2026-07-11-scripts-json-etl.md)               |
| 2026-07-11 | F8 — `core/script` preset→config seam (`options.preset`, level 6)          | [core-script-preset-seam](./2026-07-11-core-script-preset-seam.md) |
| 2026-07-13 | W2-L — `aws/dynamodb` high-level item operations (PR #118)                 | [aws-dynamodb](./2026-07-13-aws-dynamodb.md)                       |
| 2026-07-13 | W2-L — `aws/sqs` `M3LSQSOperations` wrapper (ADR-0026, PR #119)            | [aws-sqs](./2026-07-13-aws-sqs.md)                                 |
| 2026-07-13 | W2 — `sqs-etl` consumer script (PR #127)                                   | [sqs-etl](./2026-07-13-sqs-etl.md)                                 |
| 2026-07-13 | W2 — `dynamo-crud` consumer script (PR #128)                               | [dynamo-crud](./2026-07-13-dynamo-crud.md)                         |
| 2026-07-13 | W2 — `logs-insights` consumer script (PR #129)                             | [scripts-logs-insights](./2026-07-13-scripts-logs-insights.md)     |
| 2026-07-15 | W2 close-out — merge outcomes #120/#127–#129, `aws/logs-insights` stand-in | [fleet-reconciliation](./2026-07-15-fleet-reconciliation.md)       |
| 2026-07-18 | W3-L — `aws/s3` typed operations wrapper (ADR-0033, PR #160)               | [aws-s3](./2026-07-18-aws-s3.md)                                   |
| 2026-07-18 | W3-L — `aws/lambda` `M3LLambdaOperations` wrapper                          | [aws-lambda](./2026-07-18-aws-lambda.md)                           |
| 2026-07-18 | W3-L — `aws/eventbridge` `M3LEventBridgeOperations` wrapper                | [aws-eventbridge](./2026-07-18-aws-eventbridge.md)                 |
| 2026-07-18 | W4-L — `aws/athena` `M3LAthenaClient` wrapper (PR #162)                    | [aws-athena](./2026-07-18-aws-athena.md)                           |
| 2026-07-18 | W3 — `s3-objects` consumer script                                          | [s3-objects](./2026-07-18-s3-objects.md)                           |
| 2026-07-18 | W3 — `lambda-ops` consumer script                                          | [scripts-lambda-ops](./2026-07-18-scripts-lambda-ops.md)           |
| 2026-07-18 | W3 — `eventbridge-schedules` consumer script                               | [eventbridge-schedules](./2026-07-18-eventbridge-schedules.md)     |
| 2026-07-18 | W4 — `athena-query` consumer script                                        | [scripts-athena-query](./2026-07-18-scripts-athena-query.md)       |

> W1 `json-etl`'s 8 library-friction items (F1–F8) are tracked in
> [`../plans/IMPLEMENTATION.md`](../plans/IMPLEMENTATION.md#library-friction-f-series).

## Workflow / infra

| Date       | Change                                              | Log                                                                            |
| ---------- | --------------------------------------------------- | ------------------------------------------------------------------------------ |
| 2026-07-11 | Parallelize the pre-push verify (fix push timeouts) | [prepush-parallelization](./2026-07-11-prepush-parallelization.md)             |
| 2026-07-16 | `audit-fanout` dynamic workflow (ADR-0025 pilot)    | [audit-fanout-workflow](./2026-07-16-audit-fanout-workflow.md)                 |
| 2026-07-17 | ADR-0030 workflow tooling + MCP program (6 phases)  | [adr-0030-workflow-tooling-mcp](./2026-07-17-adr-0030-workflow-tooling-mcp.md) |
| 2026-07-19 | Subagent stall/truncation guidance integration      | [subagent-stall-integration](./2026-07-19-subagent-stall-integration.md)       |
| 2026-07-22 | Promotion audit — unpromoted/unlearned lesson sweep | [promotion-audit](./2026-07-22-promotion-audit.md)                             |
