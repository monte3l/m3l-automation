# Consumer-scripts roadmap — the named fleet

- **Date:** 2026-07-09 · **Starts:** now (pipeline shipped — ADR-0022
  Accepted, generator + gates merged via PRs #90/#91)
- **Authority:** [ADR-0021](../adr/0021-post-1.0-deepen-first-strategy.md)
  Phase 5 and [ADR-0022](../../adr/0022-reintroduce-scripts-workspace.md).
  This document is the **Phase F0 decision record** of
  `docs/plans/2026-07-06-consumer-fleet-roadmap.md` — it names the fleet and
  fixes its conventions. Technical detail lives in
  `docs/plans/2026-07-09-consumer-scripts-implementation-plan.md`.
- **Purpose:** plan the full consumer-script fleet (13 task families), the
  minimal library additions it needs, and the sequencing that converts the
  22/22-complete library from speculation to observed usage.

## Audit baseline (2026-07-09)

- Library: all 22 submodules implemented, tested, reviewed
  (`docs/implementation-status.md`).
- Script pipeline: fully operational — `pnpm scaffold:script`,
  `templates/script/`, `check:script-scaffold`, `scaffolding-scripts` →
  `implementing-scripts` skills, ESLint zones, knip anti-hollow gate.
- `scripts/` is **empty**: every family below is greenfield; the first
  script is the library's first end-to-end consumer.
- Verified capability gaps (all re-checked against `HEAD`):
  1. **No CloudWatch Logs client** — `@aws-sdk/client-cloudwatch-logs` is
     absent; the `cloudWatch` getter is the metrics client. Yet
     `M3LPollingPolicies.cloudWatchLogsQuery()` already ships.
  2. **No Athena client** — same pattern: `M3LPollingPolicies.athenaQuery()`
     exists, `@aws-sdk/client-athena` does not.
  3. **No DynamoDB document marshalling** — `@aws-sdk/lib-dynamodb` absent;
     consumers face raw `AttributeValue` shapes.
  4. **`core/json` extraction is single-value + object-key-only** — no array
     indexing, no wildcards, no multi-value extraction
     (`src/core/json/fieldPath.ts`).

## Settled conventions (maintainer-confirmed)

1. **Hybrid gap strategy** — structural pieces (SDK clients, `core/json`
   extraction) land in the library; task orchestration lives in script
   `steps/`; a step repeated across ≥ 2 scripts is promoted into the
   library (the ADR-0021 D4 intake gate, satisfied by construction: every
   library addition below has a named consumer call-site).
2. **One script package per task family** (`scripts/<name>/`), operations
   selected via config/preset — never one giant toolkit, never per-job
   micro-scripts.
3. **Job definitions = `M3LScript` presets + CLI overrides.** Named YAML
   presets (with `extends` inheritance) are the "pre-configured ordered
   formats"; CLI parameters override per run.
4. **Non-interactive by default; destructive operations confirm-gated**
   via `core/prompt`, bypassable with `--yes`/config for unattended runs.
5. **Streaming-first at scale** — steps exchange `AsyncIterable` record
   streams; JSONL is the canonical interchange format for large dumps; no
   step may accumulate an unbounded record set (see the implementation
   plan's scale architecture).
6. **Dependency posture** — `@aws-sdk/*` additions follow the ADR-0017
   AWS exception (hard, exact-pinned, library-level). Non-AWS data-plane
   drivers (`pg`, `mongodb`, `@kubernetes/client-node`, SigV4 signing)
   never enter the library: they are dependencies of the one script
   package that needs them.

## Task families and client coverage

| #   | Family                                       | Script                  | AWS surface                  | Library gap to close first                              |
| --- | -------------------------------------------- | ----------------------- | ---------------------------- | ------------------------------------------------------- |
| 1   | JSON/NDJSON file ETL                         | `json-etl`              | none                         | `core/json` extraction (L1)                             |
| 2   | DynamoDB CRUD (millions of records)          | `dynamo-crud`           | `dynamoDB` getter ✓          | `dynamoDBDocument` getter (L2)                          |
| 3   | CloudWatch Logs Insights                     | `logs-insights`         | **missing client**           | `cloudWatchLogs` getter + dep (L2)                      |
| 4   | SQS dump ETL/CRUD (10⁴+ messages)            | `sqs-etl`               | `sqs` getter ✓               | none                                                    |
| 5   | ECS tasks/services CRUD                      | `ecs-ops`               | `ecs` getter ✓               | none                                                    |
| 6   | EKS clusters + workloads CRUD                | `eks-ops`               | `eks` getter ✓ (clusters)    | none (k8s data plane: script-local dep)                 |
| 7   | S3 object CRUD                               | `s3-objects`            | `s3` getter ✓                | none                                                    |
| 8   | Lambda CRUD + invoke                         | `lambda-ops`            | `lambda` getter ✓            | none                                                    |
| 9   | EventBridge schedules CRUD                   | `eventbridge-schedules` | `eventBridge` getter ✓       | none¹                                                   |
| 10  | CloudFormation stacks CRUD                   | `cfn-stacks`            | `cloudFormation` getter ✓    | none                                                    |
| 11  | CodePipeline CRUD + trigger                  | `codepipeline-ops`      | `codePipeline` getter ✓      | none                                                    |
| 12  | Athena / DocumentDB / RDS-PostgreSQL queries | `data-query`            | **missing Athena client**    | `athena` getter + dep (L2); `pg`/`mongodb` script-local |
| 13  | Invoke APIs exposed via API Gateway          | `apigw-client`          | `apiGateway` getter ✓ (mgmt) | none (SigV4 signing: script-local dep)                  |

¹ EventBridge **Scheduler** (`@aws-sdk/client-scheduler`) is a different
service from EventBridge rules. If flexible schedules (one-off, timezone)
are required, the getter + dep is added to L2; classic cron/rate rules work
through the existing `eventBridge` getter. Decide at `eventbridge-schedules`
spec time.

## Waves

```text
W0  Library additions (two PRs, parallelizable, semver-minor)
 ├── L1  core/json: array-index + wildcard paths, extractAll()
 └── L2  aws/clients: cloudWatchLogs + dynamoDBDocument + athena getters
W1  json-etl                      ← the ETL backbone; first real consumer
W2  dynamo-crud · logs-insights · sqs-etl        (scale-hardened, needs W0)
W3  Control-plane CRUD fleet (existing getters, shared skeleton from W1/W2):
      s3-objects · lambda-ops · ecs-ops · cfn-stacks ·
      codepipeline-ops · eventbridge-schedules
W4  Data-plane / special-dependency scripts:
      data-query (Athena + pg + mongodb) · eks-ops (k8s workloads) ·
      apigw-client (SigV4)
W5  Promotion pass: steps duplicated across ≥ 2 scripts graduate into the
    library (ADR-0021 F4 standing loop) — scoped from observed
    duplication, not prediction
```

Sequencing rationale: W1 is dep-free and exercises the whole greenfield
pipeline at the lowest risk; its `extract/filter/export` steps become the
pattern every later script copies. W2 proves the scale architecture on the
three families that need it most. W3 is nine-tenths mechanical once the
skeleton exists — each script is a thin op-dispatch over an existing
client. W4 is last because each script carries a dependency decision
(script-local drivers) that deserves its own PR review.

Every workstream: `/starting-work` first → `feat/<slug>` off `main` → PR →
full gate suite. Library WSs run `implementing-submodules`; script WSs run
`scaffolding-scripts` → `implementing-scripts`. One PR per script.

## Scale requirements (binding for W2+, detailed in the implementation plan)

- **Millions of DynamoDB records:** parallel `Scan` segments, page-loop on
  `LastEvaluatedKey`, persisted checkpoints with `--resume`, 25-item
  batch-write chunks with `UnprocessedItems` retry
  (`M3LRetryRunner` + throttling classifier), streamed JSONL output —
  bounded memory at any table size.
- **Tens of thousands of SQS messages:** long-poll receive loop in
  10-message batches with visibility-timeout budgeting, streamed JSONL
  dump, batch send/redrive in 10-message chunks with per-entry failure
  capture to a re-drivable `failed.jsonl`.
- **Universal:** importer/exporter streaming APIs
  (`importStream()`/`exportStream()`) end-to-end; progress logging with
  correlation IDs every N records; `sort` is the only buffering operation
  and requires an explicit `limit`.

## Exit criteria

- W0 merged: the two polling-policy/client inconsistencies are resolved;
  `core/json` serves multi-value extraction from variable structures.
- W1 merged and smoke-run: fixture NDJSON in → ordered CSV/JSON out via
  `pnpm --filter @m3l-automation/json-etl start`.
- W2 merged: a ≥ 10⁶-record table scan and a ≥ 10⁴-message queue dump
  complete within bounded memory, with checkpoints proven by a
  kill-and-resume test.
- W3/W4 merged: all 13 families runnable from presets; every destructive
  op confirm-gated; the consumer-scripts catalog
  (`docs/reference/README.md`) lists all 13 contract pages.
- W5 operating: first promotion candidates identified from real
  duplication; work logs carry the "library friction" section feeding the
  ADR-0021 backlog loop.
