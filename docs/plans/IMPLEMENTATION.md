# Implementation backlog — m3l-automation

The **detailed, per-item pending-work tracker** — the actionable companion to
the coarse [`docs/ROADMAP.md`](../ROADMAP.md). One block per pending item with
its priority, status, source, and (for gated library work) the consumer
call-site that opens its ADR-0021 D4 intake gate. Fixed and living; updated as
work lands. Completed dated plans are in [`archive/`](./archive/); the done
library is in [`../implementation-status.md`](../implementation-status.md).

**Priority:** `P0` unblock-first (do before more scripts) · `P1` fleet ·
`P2` gated/deferred. **Status:** `pending` · `in-review` · `done`.

## Library friction (F-series)

Surfaced by W1 `json-etl` (landed #99) — see the work log
`docs/logs/2026-07-11-scripts-json-etl.md` §"Library friction (the F4 backlog)".
These are additive (semver-minor) library changes unless tagged otherwise; each
follows spec-first via `docs/reference/core/*.md`.

| ID     | Priority | Status                         | Title & change                                                                                                                                                                                                                                                           | Source / call-site                                                                                                    |
| ------ | -------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| **F8** | P0       | pending (task `task_ccda9320`) | Preset seam: `M3LScriptConfigLoader` wires only CLI+env and `M3LScriptOptions` has no seam to inject a loaded preset, so `M3LScriptPresetLoader` output can't drive a run. Add a `--preset` / options seam that inserts a preset provider above defaults, below CLI/env. | json-etl log F8; call-site: `scripts/json-etl` (re-enable `--preset` on land). Satisfies the D4 gate by construction. |
| **F4** | P0       | pending                        | Expose the script's `M3LPaths`: `M3LScript.paths` (private, no getter). Every script builds its own `new M3LPaths()`.                                                                                                                                                    | json-etl log F4; call-site `scripts/json-etl/src/main.ts`.                                                            |
| **F5** | P0       | pending                        | `M3LPaths.resolveInput(name)` / `resolveOutput(name)` that join a name onto the base dir **and** contain it (reject traversal).                                                                                                                                          | json-etl log F5; call-site `scripts/json-etl/src/steps/run-json-etl.ts`.                                              |
| **F1** | P0       | pending                        | Cross-parameter validation seam and/or a `required: true` flag on `M3LConfigParameter` (validators are per-parameter single-value today).                                                                                                                                | json-etl log F1; `sort⇒limit` + required-presence guards in run-json-etl.                                             |
| **F2** | P0       | pending                        | `nonEmpty` / `minLength` validators in `M3LConfigValidators` (only `range`/`regex`/`oneOf` ship).                                                                                                                                                                        | json-etl log F2.                                                                                                      |
| **F6** | P0       | pending                        | Surface the malformed-record skip count from `M3LJSONListImporter.importStream()` (only the `import:error` event exposes it today).                                                                                                                                      | json-etl log F6.                                                                                                      |
| **F7** | P2       | pending                        | Opt-in `onUnknownFormat: "throw" \| "skip"` tolerant per-record import on `M3LJSONListImporter` (a malformed whole-document JSON array aborts today; only JSONL is tolerant). **Deduped**: this is the same gap as the W0-L1 deferral.                                   | json-etl log F7 **and** `docs/logs/2026-07-10-core-json.md` §Deferred; on demand.                                     |
| **F3** | P2       | pending                        | `run(mainFn)` receives a `ctx` (correlationId only reachable via an `onBeforeRun` holder today). **Breaking** — collect as 2.0 evidence, do not act.                                                                                                                     | json-etl log F3.                                                                                                      |

## Consumer fleet (W2–W5)

Each script is one package under `scripts/<name>/`, scaffolded via
`pnpm scaffold:script`, built through the `scaffolding-scripts` →
`implementing-scripts` pipeline, landing as one PR. Full per-family detail
(config params, steps, scale requirements §1.1–1.5) is in the archived
[`2026-07-09-consumer-scripts-implementation-plan.md`](./archive/2026-07-09-consumer-scripts-implementation-plan.md)
and its [roadmap](./archive/2026-07-09-consumer-scripts-roadmap.md).

### W2 — scale-hardened (P1, pending; W0 clients present)

- **`dynamo-crud`** — `get/put/update/delete/query/scan/batch-write/batch-delete/export/import`; parallel `Scan` segments, `LastEvaluatedKey` page-loop, persisted checkpoints + `--resume`, 25-item batch chunks with `UnprocessedItems` retry, streamed JSONL, `dynamoDBDocument` (W0-L2) throughout, destructive gate. Uses the `failed.jsonl` re-drive pattern.
- **`logs-insights`** — `StartQuery`/`GetQueryResults` via `cloudWatchLogs` (W0-L2) + `M3LPollingPolicies.cloudWatchLogsQuery()`; `queryId` checkpoint; split-by-time-window for the 10k-row cap.
- **`sqs-etl`** — `dump/send/redrive/delete/purge/transform`; long-poll receive loop (10/batch), visibility-timeout budgeting, streamed JSONL, `SendMessageBatch` with `sqsBatchSend()` policy + `failed.jsonl`, purge cooldown note.

### W3 — control-plane CRUD (P1, pending; existing getters)

Thin op-dispatch (`list`/`describe`/`create`/`update`/`delete` + per-service verbs) over the shared W1/W2 skeleton, mutating ops confirm-gated: **`s3-objects`** (`s3`), **`lambda-ops`** (`lambda`), **`ecs-ops`** (`ecs`, `waitUntilStable`), **`cfn-stacks`** (`cloudFormation`, stack-event streaming), **`codepipeline-ops`** (`codePipeline`, `watch`), **`eventbridge-schedules`** (`eventBridge`; decide rules-vs-`scheduler` at spec time — see gated getter below).

### W4 — special-dependency (P1, pending; each is its own dep decision)

- **`data-query`** — one script, three engines behind `engine: athena|documentdb|postgres`: Athena (`athena` getter W0-L2 + `athenaQuery()` policy), PostgreSQL (`pg` script-local dep, cursor batches), DocumentDB (`mongodb` script-local dep). Results feed the shared extract/filter/export steps.
- **`eks-ops`** — cluster plane via `eks` getter; workload plane via `@kubernetes/client-node` (script-local), kubeconfig built in-process from `DescribeCluster` + the resolved SDK credential chain (no shell-out).
- **`apigw-client`** — calls APIs behind API Gateway via `M3LHttpClient`; auth `none|api-key|iam` (IAM signs with script-local `@smithy/signature-v4`); batch mode with `failed.jsonl`.

### W5 — promotion pass (P1, pending; needs ≥2 scripts)

Steps duplicated across ≥2 scripts graduate into the library (ADR-0021 F4 standing loop). Named candidates already: the destructive-operation gate (§1.5) and the checkpoint/resume convention (§1.2).

## Gated library modules & deferred decisions (P2)

Deliberately unscheduled until the gate opens (ADR-0021 D4/D5 intake). See
[`archive/2026-07-06-post-1.0-deepen-first-roadmap.md`](./archive/2026-07-06-post-1.0-deepen-first-roadmap.md)
and [`archive/2026-07-06-consumer-fleet-roadmap.md`](./archive/2026-07-06-consumer-fleet-roadmap.md).

| ID                                                                                   | Unblock condition                                                     |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| **D4** SSM config provider (`M3LConfigProvider` over `ssm`, no new deps)             | a 2nd script hand-rolling SSM config fetch                            |
| **D4** SES messaging transport (new optional `@aws-sdk/client-sesv2` peer, ADR-0017) | a script needing notifications                                        |
| **D4** Lambda-invoke wrapper (no new deps)                                           | a script invoking Lambdas                                             |
| **D4** Slack/webhook transport                                                       | first schedule the `M3LHttpClient` POST enhancement                   |
| `@aws-sdk/client-scheduler` + `scheduler` getter                                     | `eventbridge-schedules` needing flexible (one-off/timezone) schedules |
| **D5** platform extraction (minimal copy-and-parameterize path)                      | a second repo adopting the workflow                                   |
