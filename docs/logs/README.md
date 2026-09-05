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
a fresh log feels familiar from an earlier one.

**Scope is substance, not commit type.** A unit of work gets a log when it
produced something worth re-reading later — what shipped, what diverged from
plan, the lessons. That covers submodule/script implementation units _and_
harness/governance/infra work with a real narrative (see `## Workflow /
infra` below — dependabot-gate fixes, hook hardening, rule-file trims). It
excludes mechanical changes with no narrative: dependency bumps,
formatting/lint sweeps, tracker-status flips, a bare `sync:hub` run, or the
`docs:` commit that lands a log itself. The tiebreak: would a future session
hitting the same problem want to read it?

## Maintaining this index

Every log gets exactly one row, added in the same commit that writes it
(`/writing-work-logs` Step 3) — no generator owns these tables, since a log's
section can't be derived mechanically (no frontmatter, no category field on
the file itself). A row is `| YYYY-MM-DD | <descriptor> |
[<link-text>](./<filename>.md) |`, link text is the filename with the date
prefix and `.md` stripped, and rows within a table are date-ascending.
`pnpm check:logs-index` (advisory) verifies coverage — every log linked
exactly once, no dangling links, no date-column mismatches — but it is a
backstop for the step above, not a substitute for it.

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

| Date       | Unit                                                                       | Log                                                                                    |
| ---------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 2026-07-09 | Script production pipeline (generator + gates)                             | [script-pipeline](./2026-07-09-script-pipeline.md)                                     |
| 2026-07-10 | W0-L1 — `core/json` extraction extension (`extractAll`)                    | [core-json](./2026-07-10-core-json.md)                                                 |
| 2026-07-11 | W0-L2 — `aws/clients` getters (cloudWatchLogs/dynamoDBDocument/athena)     | [aws-clients](./2026-07-11-aws-clients.md)                                             |
| 2026-07-11 | W1 — `json-etl` (first end-to-end consumer script)                         | [scripts-json-etl](./2026-07-11-scripts-json-etl.md)                                   |
| 2026-07-11 | F8 — `core/script` preset→config seam (`options.preset`, level 6)          | [core-script-preset-seam](./2026-07-11-core-script-preset-seam.md)                     |
| 2026-07-13 | W2-L — `aws/dynamodb` high-level item operations (PR #118)                 | [aws-dynamodb](./2026-07-13-aws-dynamodb.md)                                           |
| 2026-07-13 | W2-L — `aws/sqs` `M3LSQSOperations` wrapper (ADR-0026, PR #119)            | [aws-sqs](./2026-07-13-aws-sqs.md)                                                     |
| 2026-07-13 | W2 — `sqs-etl` consumer script (PR #127)                                   | [sqs-etl](./2026-07-13-sqs-etl.md)                                                     |
| 2026-07-13 | W2 — `dynamo-crud` consumer script (PR #128)                               | [dynamo-crud](./2026-07-13-dynamo-crud.md)                                             |
| 2026-07-13 | W2 — `logs-insights` consumer script (PR #129)                             | [scripts-logs-insights](./2026-07-13-scripts-logs-insights.md)                         |
| 2026-07-15 | W2 close-out — merge outcomes #120/#127–#129, `aws/logs-insights` stand-in | [fleet-reconciliation](./2026-07-15-fleet-reconciliation.md)                           |
| 2026-07-18 | W3-L — `aws/s3` typed operations wrapper (ADR-0033, PR #160)               | [aws-s3](./2026-07-18-aws-s3.md)                                                       |
| 2026-07-18 | W3-L — `aws/lambda` `M3LLambdaOperations` wrapper                          | [aws-lambda](./2026-07-18-aws-lambda.md)                                               |
| 2026-07-18 | W3-L — `aws/eventbridge` `M3LEventBridgeOperations` wrapper                | [aws-eventbridge](./2026-07-18-aws-eventbridge.md)                                     |
| 2026-07-18 | W4-L — `aws/athena` `M3LAthenaClient` wrapper (PR #162)                    | [aws-athena](./2026-07-18-aws-athena.md)                                               |
| 2026-07-18 | W3 — `s3-objects` consumer script                                          | [s3-objects](./2026-07-18-s3-objects.md)                                               |
| 2026-07-18 | W3 — `lambda-ops` consumer script                                          | [scripts-lambda-ops](./2026-07-18-scripts-lambda-ops.md)                               |
| 2026-07-18 | W3 — `eventbridge-schedules` consumer script                               | [eventbridge-schedules](./2026-07-18-eventbridge-schedules.md)                         |
| 2026-07-18 | W4 — `athena-query` consumer script                                        | [scripts-athena-query](./2026-07-18-scripts-athena-query.md)                           |
| 2026-07-23 | `core/diagnostics` submodule                                               | [core-diagnostics](./2026-07-23-core-diagnostics.md)                                   |
| 2026-07-23 | `core/script` log-level chain, ADR-0035 phase 4b                           | [core-script-log-level-chain](./2026-07-23-core-script-log-level-chain.md)             |
| 2026-07-23 | `core/script` runScript() wrapper, ADR-0035 phase 4a                       | [core-script-run-wrapper](./2026-07-23-core-script-run-wrapper.md)                     |
| 2026-07-24 | `aws/ecs` submodule                                                        | [aws-ecs](./2026-07-24-aws-ecs.md)                                                     |
| 2026-07-24 | `core/script` runScript adoption + per-run output                          | [core-script-runscript-adoption](./2026-07-24-core-script-runscript-adoption.md)       |
| 2026-07-24 | `ecs-ops` consumer script                                                  | [scripts-ecs-ops](./2026-07-24-scripts-ecs-ops.md)                                     |
| 2026-07-24 | W5 promotion pass: `Core.confirmDestructive`                               | [w5-promote-destructive-gate](./2026-07-24-w5-promote-destructive-gate.md)             |
| 2026-07-26 | `aws/cloudformation` submodule                                             | [aws-cloudformation](./2026-07-26-aws-cloudformation.md)                               |
| 2026-07-26 | W5 §1.2 checkpoint/resume promotion                                        | [w5-promote-checkpoint-store](./2026-07-26-w5-promote-checkpoint-store.md)             |
| 2026-07-27 | `aws/codepipeline` submodule                                               | [aws-codepipeline](./2026-07-27-aws-codepipeline.md)                                   |
| 2026-07-27 | `aws/eks` submodule                                                        | [aws-eks](./2026-07-27-aws-eks.md)                                                     |
| 2026-07-27 | `cloudformation-stacks` script                                             | [scripts-cloudformation-stacks](./2026-07-27-scripts-cloudformation-stacks.md)         |
| 2026-07-27 | `codepipeline-ops` consumer script                                         | [scripts-codepipeline-ops](./2026-07-27-scripts-codepipeline-ops.md)                   |
| 2026-07-28 | `core/config` + `core/files` W5 promotion, PR 1                            | [core-config-files-w5-promote](./2026-07-28-core-config-files-w5-promote.md)           |
| 2026-07-28 | `scripts/eks-ops`                                                          | [scripts-eks-ops](./2026-07-28-scripts-eks-ops.md)                                     |
| 2026-07-28 | W5 config-accessor completion pass                                         | [w5-config-accessor-completion](./2026-07-28-w5-config-accessor-completion.md)         |
| 2026-07-28 | W5 config-accessor fleet retrofit                                          | [w5-config-accessor-fleet-retrofit](./2026-07-28-w5-config-accessor-fleet-retrofit.md) |
| 2026-07-28 | W5 record-field readers promotion                                          | [w5-record-field-readers](./2026-07-28-w5-record-field-readers.md)                     |
| 2026-08-11 | `aws/clients` `AWSServiceProvider` addition                                | [aws-clients-services](./2026-08-11-aws-clients-services.md)                           |
| 2026-08-11 | `aws/sqs` redrive + `aws/athena` template compiler                         | [aws-sqs-redrive-athena-template](./2026-08-11-aws-sqs-redrive-athena-template.md)     |
| 2026-08-14 | `aws/rds-data` submodule                                                   | [aws-rds-data](./2026-08-14-aws-rds-data.md)                                           |
| 2026-08-14 | `rds-data-sql` consumer script                                             | [rds-data-sql](./2026-08-14-rds-data-sql.md)                                           |
| 2026-08-23 | W7 — `cloudwatch-logs-analysis` consumer script (issue #466)               | [w7-cloudwatch-logs-analysis](./2026-08-23-w7-cloudwatch-logs-analysis.md)             |
| 2026-08-24 | W8 — `sqs-dead-letter-triage` consumer script                              | [w8-sqs-dead-letter-triage](./2026-08-24-w8-sqs-dead-letter-triage.md)                 |

> W1 `json-etl`'s 8 library-friction items (F1–F8) are tracked in
> [`../plans/IMPLEMENTATION.md`](../plans/IMPLEMENTATION.md#library-friction-f-series).

## `core/pipeline` migration wave

| Date       | Change                                              | Log                                                                                                        |
| ---------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 2026-08-15 | exporter-resume-seam                                | [exporter-resume-seam](./2026-08-15-exporter-resume-seam.md)                                               |
| 2026-08-16 | `core/pipeline` submodule                           | [core-pipeline](./2026-08-16-core-pipeline.md)                                                             |
| 2026-08-16 | s3-objects + ecs-ops pipeline migrations            | [pipeline-migrations](./2026-08-16-pipeline-migrations.md)                                                 |
| 2026-08-17 | descope cloudwatch-logs-insights pipeline migration | [descope-cwli-pipeline-migration](./2026-08-17-descope-cwli-pipeline-migration.md)                         |
| 2026-08-17 | descope dynamodb-crud pipeline migration            | [descope-dynamodb-crud-pipeline-migration](./2026-08-17-descope-dynamodb-crud-pipeline-migration.md)       |
| 2026-08-17 | cloudformation-stacks pipeline migration            | [scripts-cloudformation-stacks](./2026-08-17-scripts-cloudformation-stacks.md)                             |
| 2026-08-17 | eks-ops pipeline migration                          | [scripts-eks-ops](./2026-08-17-scripts-eks-ops.md)                                                         |
| 2026-08-18 | F12: pipeline `operation` arg                       | [f12-pipeline-operation-arg](./2026-08-18-f12-pipeline-operation-arg.md)                                   |
| 2026-08-18 | codepipeline-ops pipeline migration                 | [scripts-codepipeline-ops-pipeline-migration](./2026-08-18-scripts-codepipeline-ops-pipeline-migration.md) |
| 2026-08-21 | `core/procedure` submodule, slice 1                 | [core-procedure](./2026-08-21-core-procedure.md)                                                           |

## m3l console wave (X-series)

| Date       | Change                                                         | Log                                                                                                      |
| ---------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 2026-08-27 | X3 — console persistence foundation (`node:sqlite`, ADR-0069)  | [x3-console-persistence](./2026-08-27-x3-console-persistence.md)                                         |
| 2026-08-28 | X9 — `m3l-console-web` skeleton (Vite/React 19, ADR-0067)      | [x9-console-web-skeleton](./2026-08-28-x9-console-web-skeleton.md)                                       |
| 2026-08-29 | X4 — run orchestration (registry, governor, REST + SSE)        | [x4-console-run-orchestration](./2026-08-29-x4-console-run-orchestration.md)                             |
| 2026-08-30 | X6 — workbench sessions close-out (bindings, resume, ADR-0068) | [x6-workbench-sessions](./2026-08-30-x6-workbench-sessions.md)                                           |
| 2026-08-30 | X10 run-launcher UI MVP                                        | [x10-run-launcher-ui](./2026-08-30-x10-run-launcher-ui.md)                                               |
| 2026-09-01 | X7 — human-action audit close-out (stream, index, read path)   | [x7-human-action-audit](./2026-09-01-x7-human-action-audit.md)                                           |
| 2026-09-01 | X7b — audit wiring, view actions & correlation threading       | [x7b-audit-wiring](./2026-09-01-x7b-audit-wiring.md)                                                     |
| 2026-09-02 | X7c — audit index writer & the `options.routes` boundary       | [x7c-audit-index-writer](./2026-09-02-x7c-audit-index-writer.md)                                         |
| 2026-09-02 | X7d — the last four human-action kinds & their routes          | [x7d-remaining-action-kinds](./2026-09-02-x7d-remaining-action-kinds.md)                                 |
| 2026-09-03 | X8 slice 1 — telemetry rollup store (v9, ADR-0070)             | [x8-telemetry-store](./2026-09-03-x8-telemetry-store.md)                                                 |
| 2026-09-03 | X8 — telemetry guard follow-ups (validation, naming tail)      | [x8-telemetry-guard-followups](./2026-09-03-x8-telemetry-guard-followups.md)                             |
| 2026-09-03 | X8 — slice-1 open items (test isolation, re-plan, v11 CHECK)   | [x8-open-items](./2026-09-03-x8-open-items.md)                                                           |
| 2026-09-03 | x11a2-session-steps-decisions                                  | [x11a2-session-steps-decisions](./2026-09-03-x11a2-session-steps-decisions.md)                           |
| 2026-09-03 | `x11b-console-session-views`                                   | [x11b-console-session-views](./2026-09-03-x11b-console-session-views.md)                                 |
| 2026-09-03 | `x11c-json-tree-viewer`                                        | [x11c-json-tree-viewer](./2026-09-03-x11c-json-tree-viewer.md)                                           |
| 2026-09-03 | x12-container-stance-and-loopback-refactor                     | [x12-container-stance-and-loopback-refactor](./2026-09-03-x12-container-stance-and-loopback-refactor.md) |
| 2026-09-03 | X12 console containerization, PR3                              | [x12-containerization-images-and-scanning](./2026-09-03-x12-containerization-images-and-scanning.md)     |
| 2026-09-04 | `x11e-sqs-drilldown-acceptance`                                | [x11e-sqs-drilldown-acceptance](./2026-09-04-x11e-sqs-drilldown-acceptance.md)                           |

> X1 (governance docs) and X2 (`m3l-console-server` skeleton) shipped without
> logs; X3 is the first entry in this wave.

## CLI wave (U-series)

| Date       | Change                                      | Log                                                                                    |
| ---------- | ------------------------------------------- | -------------------------------------------------------------------------------------- |
| 2026-08-14 | `m3l-cli` build-out (phases 8b-8g)          | [m3l-cli-build-out](./2026-08-14-m3l-cli-build-out.md)                                 |
| 2026-08-26 | U5 — declarative operations, fleet retrofit | [u5-declarative-ops-fleet-retrofit](./2026-08-26-u5-declarative-ops-fleet-retrofit.md) |
| 2026-09-01 | U12 — `m3l completion` (bash/zsh/fish)      | [cli-shell-completion](./2026-09-01-cli-shell-completion.md)                           |
| 2026-09-02 | U10 — orchestration engine + `m3l flow`     | [u10-orchestration-engine](./2026-09-02-u10-orchestration-engine.md)                   |
| 2026-09-03 | U11 retry/resume/cancellation surfacing     | [u11-retry-resume-cancellation](./2026-09-03-u11-retry-resume-cancellation.md)         |

> The first two rows pre-date this section; they were written but never
> indexed here. Adding them is an index fix, not an edit to shipped history —
> the logs themselves are untouched.

## Agent operator wave (V-series)

| Date       | Change                                                      | Log                                                                                |
| ---------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 2026-08-29 | V6 slice 1 — `core/agent` policy layer, verdicts (ADR-0060) | [v6-agent-policy-layer](./2026-08-29-v6-agent-policy-layer.md)                     |
| 2026-08-29 | V6 slice 2 — budgets, dry-run-first, `kind` cross-check     | [v6-agent-policy-layer-slice-2](./2026-08-29-v6-agent-policy-layer-slice-2.md)     |
| 2026-08-30 | `core/agent` decision log, V7                               | [v7-agent-decision-log](./2026-08-30-v7-agent-decision-log.md)                     |
| 2026-09-01 | V3 — secrets to the spawn env, not argv (ADR-0085)          | [v3-secrets-delivery](./2026-09-01-v3-secrets-delivery.md)                         |
| 2026-09-01 | V8 `agent-operator` health-checks workload                  | [v8-agent-operator-health-checks](./2026-09-01-v8-agent-operator-health-checks.md) |

## Agent-reliability wave (A-series)

| Date       | Change                                                                   | Log                                                                                                        |
| ---------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| 2026-08-18 | A1 cooperative cancellation seam                                         | [a1-cooperative-cancellation-seam](./2026-08-18-a1-cooperative-cancellation-seam.md)                       |
| 2026-08-18 | A2 target-graded destructive confirmation                                | [a2-target-graded-destructive-confirmation](./2026-08-18-a2-target-graded-destructive-confirmation.md)     |
| 2026-08-19 | A3 — degraded runs as a first-class outcome (issue #470)                 | [a3-partial-run-outcome](./2026-08-19-a3-partial-run-outcome.md)                                           |
| 2026-08-19 | `core/checkpoint` fingerprinting, item A4                                | [a4-checkpoint-fingerprint](./2026-08-19-a4-checkpoint-fingerprint.md)                                     |
| 2026-08-19 | A5 no-progress detection                                                 | [a5-no-progress-detection](./2026-08-19-a5-no-progress-detection.md)                                       |
| 2026-08-20 | A6 — per-phase pipeline trace + aggregate option validation (issue #473) | [a6-pipeline-phase-trace](./2026-08-20-a6-pipeline-phase-trace.md)                                         |
| 2026-08-25 | `a2b-fleet-destructive-confirmation-retrofit`                            | [a2b-fleet-destructive-confirmation-retrofit](./2026-08-25-a2b-fleet-destructive-confirmation-retrofit.md) |
| 2026-08-25 | A3b recovery fleet retrofit                                              | [a3b-recovery-fleet-retrofit](./2026-08-25-a3b-recovery-fleet-retrofit.md)                                 |
| 2026-08-26 | A5b bound pagination loops                                               | [a5b-bound-pagination-loops](./2026-08-26-a5b-bound-pagination-loops.md)                                   |

## Bedrock wave (`aws/bedrock-runtime`)

| Date       | Change                                   | Log                                                                            |
| ---------- | ---------------------------------------- | ------------------------------------------------------------------------------ |
| 2026-08-28 | `aws/bedrock-runtime` submodule, slice 1 | [aws-bedrock-runtime](./2026-08-28-aws-bedrock-runtime.md)                     |
| 2026-08-28 | `aws/bedrock-runtime` submodule, slice 2 | [aws-bedrock-runtime-streaming](./2026-08-28-aws-bedrock-runtime-streaming.md) |
| 2026-08-29 | `aws/bedrock-runtime` tool vocabulary    | [aws-bedrock-runtime-tools](./2026-08-29-aws-bedrock-runtime-tools.md)         |
| 2026-08-30 | `aws/bedrock-runtime` tool-use loop      | [aws-bedrock-runtime-loop](./2026-08-30-aws-bedrock-runtime-loop.md)           |

## Harness / statusline wave

| Date       | Change                                | Log                                                                                        |
| ---------- | ------------------------------------- | ------------------------------------------------------------------------------------------ |
| 2026-09-02 | audit-refuter-hardening               | [audit-refuter-hardening](./2026-09-02-audit-refuter-hardening.md)                         |
| 2026-09-02 | claude-session-trailer-removal        | [claude-session-trailer-removal](./2026-09-02-claude-session-trailer-removal.md)           |
| 2026-09-02 | `finishing-work` skill                | [finishing-work-skill](./2026-09-02-finishing-work-skill.md)                               |
| 2026-09-02 | notification-floor                    | [notification-floor](./2026-09-02-notification-floor.md)                                   |
| 2026-09-02 | `reinject-compact-resume`             | [reinject-compact-resume](./2026-09-02-reinject-compact-resume.md)                         |
| 2026-09-02 | `session-incidents-counter`           | [session-incidents-counter](./2026-09-02-session-incidents-counter.md)                     |
| 2026-09-02 | session-naming-convention             | [session-naming-convention](./2026-09-02-session-naming-convention.md)                     |
| 2026-09-02 | spoke-inflight-status                 | [spoke-inflight-status](./2026-09-02-spoke-inflight-status.md)                             |
| 2026-09-02 | statusline-widgets                    | [statusline-widgets](./2026-09-02-statusline-widgets.md)                                   |
| 2026-09-03 | permission-allowlist-expansion        | [permission-allowlist-expansion](./2026-09-03-permission-allowlist-expansion.md)           |
| 2026-09-03 | `skill-invocation-and-listing-budget` | [skill-invocation-and-listing-budget](./2026-09-03-skill-invocation-and-listing-budget.md) |
| 2026-09-03 | statusline-palette-hardening          | [statusline-palette-hardening](./2026-09-03-statusline-palette-hardening.md)               |
| 2026-09-03 | statusline-redesign                   | [statusline-redesign](./2026-09-03-statusline-redesign.md)                                 |
| 2026-09-03 | subagent-statusline                   | [subagent-statusline](./2026-09-03-subagent-statusline.md)                                 |
| 2026-09-05 | statusline-weekly-usage               | [statusline-weekly-usage](./2026-09-05-statusline-weekly-usage.md)                         |

## Workflow / infra

| Date       | Change                                                            | Log                                                                                        |
| ---------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 2026-07-11 | Parallelize the pre-push verify (fix push timeouts)               | [prepush-parallelization](./2026-07-11-prepush-parallelization.md)                         |
| 2026-07-16 | `audit-fanout` dynamic workflow (ADR-0025 pilot)                  | [audit-fanout-workflow](./2026-07-16-audit-fanout-workflow.md)                             |
| 2026-07-17 | ADR-0030 workflow tooling + MCP program (6 phases)                | [adr-0030-workflow-tooling-mcp](./2026-07-17-adr-0030-workflow-tooling-mcp.md)             |
| 2026-07-19 | Subagent stall/truncation guidance integration                    | [subagent-stall-integration](./2026-07-19-subagent-stall-integration.md)                   |
| 2026-07-22 | Promotion audit — unpromoted/unlearned lesson sweep               | [promotion-audit](./2026-07-22-promotion-audit.md)                                         |
| 2026-08-15 | ADR-0034 cognitive-complexity refactor                            | [adr-0034-complexity-refactor](./2026-08-15-adr-0034-complexity-refactor.md)               |
| 2026-08-19 | check:test-counts contention (F15)                                | [check-test-counts-contention](./2026-08-19-check-test-counts-contention.md)               |
| 2026-08-19 | sync:hub key namespace (F13)                                      | [hub-sync-key-namespace](./2026-08-19-hub-sync-key-namespace.md)                           |
| 2026-08-20 | ADR-0072 reviewable-slice discipline (F23)                        | [f23-reviewable-slice-discipline](./2026-08-20-f23-reviewable-slice-discipline.md)         |
| 2026-08-21 | F23 field test against PR #523 / issue #474                       | [f23-field-test-b2](./2026-08-21-f23-field-test-b2.md)                                     |
| 2026-08-24 | ci-arm64-runner-adoption                                          | [ci-arm64-runner-adoption](./2026-08-24-ci-arm64-runner-adoption.md)                       |
| 2026-08-27 | Parallel-session OOM/livelock audit + fix (ADR-0080)              | [parallel-session-oom](./2026-08-27-parallel-session-oom.md)                               |
| 2026-08-27 | ADR-0078 session context management rollout (retroactive)         | [adr-0078-session-context-management](./2026-08-27-adr-0078-session-context-management.md) |
| 2026-09-03 | Dependabot commit-subject gate fix (PR #975)                      | [dependabot-commit-subject-gate](./2026-09-03-dependabot-commit-subject-gate.md)           |
| 2026-09-03 | podman-containerfiles migration                                   | [podman-containerfiles-migration](./2026-09-03-podman-containerfiles-migration.md)         |
| 2026-09-03 | podman-migration-stance                                           | [podman-migration-stance-and-spike](./2026-09-03-podman-migration-stance-and-spike.md)     |
| 2026-09-03 | `worktree-new-lib-extract`                                        | [worktree-new-lib-extract](./2026-09-03-worktree-new-lib-extract.md)                       |
| 2026-09-04 | check:no-docker enforcement gate                                  | [check-no-docker](./2026-09-04-check-no-docker.md)                                         |
| 2026-09-05 | H1 — document the merge step (issue #994, PR #1031/#1032)         | [document-merge-step](./2026-09-05-document-merge-step.md)                                 |
| 2026-09-05 | H2 — post-merge staleness gate (issue #995, PR #1044)             | [post-merge-staleness-gate](./2026-09-05-post-merge-staleness-gate.md)                     |
| 2026-09-05 | context7-mcp-load-bearing                                         | [context7-mcp-load-bearing](./2026-09-05-context7-mcp-load-bearing.md)                     |
| 2026-09-05 | trim-oversized-rule-files                                         | [trim-oversized-rule-files](./2026-09-05-trim-oversized-rule-files.md)                     |
| 2026-09-05 | `work-log-scope`                                                  | [work-log-scope](./2026-09-05-work-log-scope.md)                                           |
| 2026-09-05 | Close the logs-index-drift loop (gate + backfill, PR #1046/#1049) | [logs-index-drift](./2026-09-05-logs-index-drift.md)                                       |
