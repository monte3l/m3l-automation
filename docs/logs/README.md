# Work logs

Per-unit work logs — the durable narrative of what shipped, what diverged, and
the lessons, written during the session that did the work. Logs are **immutable
history**: they are not edited after landing (unlike the living trackers in
[`../ROADMAP.md`](../ROADMAP.md) and
[`../plans/IMPLEMENTATION.md`](../plans/IMPLEMENTATION.md)). New logs are added
by `/writing-work-logs`; recurring lessons graduate into the rules/agents via
`/promoting-work-log-lessons`.

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

| Date       | Unit                                                                   | Log                                                  |
| ---------- | ---------------------------------------------------------------------- | ---------------------------------------------------- |
| 2026-07-09 | Script production pipeline (generator + gates)                         | [script-pipeline](./2026-07-09-script-pipeline.md)   |
| 2026-07-10 | W0-L1 — `core/json` extraction extension (`extractAll`)                | [core-json](./2026-07-10-core-json.md)               |
| 2026-07-11 | W0-L2 — `aws/clients` getters (cloudWatchLogs/dynamoDBDocument/athena) | [aws-clients](./2026-07-11-aws-clients.md)           |
| 2026-07-11 | W1 — `json-etl` (first end-to-end consumer script)                     | [scripts-json-etl](./2026-07-11-scripts-json-etl.md) |

> W1 `json-etl`'s 8 library-friction items (F1–F8) are tracked in
> [`../plans/IMPLEMENTATION.md`](../plans/IMPLEMENTATION.md#library-friction-f-series).

## Workflow / infra

| Date       | Change                                              | Log                                                                |
| ---------- | --------------------------------------------------- | ------------------------------------------------------------------ |
| 2026-07-11 | Parallelize the pre-push verify (fix push timeouts) | [prepush-parallelization](./2026-07-11-prepush-parallelization.md) |
