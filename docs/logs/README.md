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

## m3l console wave (X-series)

| Date       | Change                                                         | Log                                                                          |
| ---------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 2026-08-27 | X3 — console persistence foundation (`node:sqlite`, ADR-0069)  | [x3-console-persistence](./2026-08-27-x3-console-persistence.md)             |
| 2026-08-28 | X9 — `m3l-console-web` skeleton (Vite/React 19, ADR-0067)      | [x9-console-web-skeleton](./2026-08-28-x9-console-web-skeleton.md)           |
| 2026-08-29 | X4 — run orchestration (registry, governor, REST + SSE)        | [x4-console-run-orchestration](./2026-08-29-x4-console-run-orchestration.md) |
| 2026-08-30 | X6 — workbench sessions close-out (bindings, resume, ADR-0068) | [x6-workbench-sessions](./2026-08-30-x6-workbench-sessions.md)               |
| 2026-09-01 | X7 — human-action audit close-out (stream, index, read path)   | [x7-human-action-audit](./2026-09-01-x7-human-action-audit.md)               |
| 2026-09-01 | X7b — audit wiring, view actions & correlation threading       | [x7b-audit-wiring](./2026-09-01-x7b-audit-wiring.md)                         |
| 2026-09-02 | X7c — audit index writer & the `options.routes` boundary       | [x7c-audit-index-writer](./2026-09-02-x7c-audit-index-writer.md)             |
| 2026-09-02 | X7d — the last four human-action kinds & their routes          | [x7d-remaining-action-kinds](./2026-09-02-x7d-remaining-action-kinds.md)     |
| 2026-09-03 | X8 slice 1 — telemetry rollup store (v9, ADR-0070)             | [x8-telemetry-store](./2026-09-03-x8-telemetry-store.md)                     |
| 2026-09-03 | X8 — telemetry guard follow-ups (validation, naming tail)      | [x8-telemetry-guard-followups](./2026-09-03-x8-telemetry-guard-followups.md) |
| 2026-09-03 | X8 — slice-1 open items (test isolation, re-plan, v11 CHECK)   | [x8-open-items](./2026-09-03-x8-open-items.md)                               |

> X1 (governance docs) and X2 (`m3l-console-server` skeleton) shipped without
> logs; X3 is the first entry in this wave.

## CLI wave (U-series)

| Date       | Change                                      | Log                                                                                    |
| ---------- | ------------------------------------------- | -------------------------------------------------------------------------------------- |
| 2026-08-14 | `m3l-cli` build-out (phases 8b-8g)          | [m3l-cli-build-out](./2026-08-14-m3l-cli-build-out.md)                                 |
| 2026-08-26 | U5 — declarative operations, fleet retrofit | [u5-declarative-ops-fleet-retrofit](./2026-08-26-u5-declarative-ops-fleet-retrofit.md) |
| 2026-09-01 | U12 — `m3l completion` (bash/zsh/fish)      | [cli-shell-completion](./2026-09-01-cli-shell-completion.md)                           |
| 2026-09-02 | U10 — orchestration engine + `m3l flow`     | [u10-orchestration-engine](./2026-09-02-u10-orchestration-engine.md)                   |

> The first two rows pre-date this section; they were written but never
> indexed here. Adding them is an index fix, not an edit to shipped history —
> the logs themselves are untouched.

## Agent operator wave (V-series)

| Date       | Change                                                      | Log                                                                            |
| ---------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 2026-08-29 | V6 slice 1 — `core/agent` policy layer, verdicts (ADR-0060) | [v6-agent-policy-layer](./2026-08-29-v6-agent-policy-layer.md)                 |
| 2026-08-29 | V6 slice 2 — budgets, dry-run-first, `kind` cross-check     | [v6-agent-policy-layer-slice-2](./2026-08-29-v6-agent-policy-layer-slice-2.md) |
| 2026-09-01 | V3 — secrets to the spawn env, not argv (ADR-0085)          | [v3-secrets-delivery](./2026-09-01-v3-secrets-delivery.md)                     |

## Workflow / infra

| Date       | Change                                                    | Log                                                                                        |
| ---------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 2026-07-11 | Parallelize the pre-push verify (fix push timeouts)       | [prepush-parallelization](./2026-07-11-prepush-parallelization.md)                         |
| 2026-07-16 | `audit-fanout` dynamic workflow (ADR-0025 pilot)          | [audit-fanout-workflow](./2026-07-16-audit-fanout-workflow.md)                             |
| 2026-07-17 | ADR-0030 workflow tooling + MCP program (6 phases)        | [adr-0030-workflow-tooling-mcp](./2026-07-17-adr-0030-workflow-tooling-mcp.md)             |
| 2026-07-19 | Subagent stall/truncation guidance integration            | [subagent-stall-integration](./2026-07-19-subagent-stall-integration.md)                   |
| 2026-07-22 | Promotion audit — unpromoted/unlearned lesson sweep       | [promotion-audit](./2026-07-22-promotion-audit.md)                                         |
| 2026-08-20 | ADR-0072 reviewable-slice discipline (F23)                | [f23-reviewable-slice-discipline](./2026-08-20-f23-reviewable-slice-discipline.md)         |
| 2026-08-21 | F23 field test against PR #523 / issue #474               | [f23-field-test-b2](./2026-08-21-f23-field-test-b2.md)                                     |
| 2026-08-27 | Parallel-session OOM/livelock audit + fix (ADR-0080)      | [parallel-session-oom](./2026-08-27-parallel-session-oom.md)                               |
| 2026-08-27 | ADR-0078 session context management rollout (retroactive) | [adr-0078-session-context-management](./2026-08-27-adr-0078-session-context-management.md) |
| 2026-09-03 | Dependabot commit-subject gate fix (PR #975)              | [dependabot-commit-subject-gate](./2026-09-03-dependabot-commit-subject-gate.md)           |
