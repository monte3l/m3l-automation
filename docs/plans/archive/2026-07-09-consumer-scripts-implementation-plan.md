# Plan: consumer-script fleet — technical implementation

- **Date:** 2026-07-09 · **Baseline:** `main` after PR #94
- **Implements:** `docs/plans/2026-07-09-consumer-scripts-roadmap.md`
  (the Phase F0 decision record of the consumer-fleet roadmap;
  [ADR-0021](../../adr/0021-post-1.0-deepen-first-strategy.md) Phase 5,
  [ADR-0022](../../adr/0022-reintroduce-scripts-workspace.md)).
- **Ground truth:** every "exists today" claim below was verified against
  `HEAD` during the 2026-07-09 audit (three parallel read-only agents plus
  hub spot-checks of `packages/m3l-common/package.json`,
  `src/aws/clients/provider.ts`, `src/core/json/fieldPath.ts`,
  `src/core/polling/M3LPollingPolicies.ts`).

## Contents

1. [Cross-cutting architecture](#1-cross-cutting-architecture)
2. [W0-L1 — `core/json` extraction extension](#2-w0-l1--corejson-extraction-extension)
3. [W0-L2 — `aws/clients` additions](#3-w0-l2--awsclients-additions)
4. [W1 — `json-etl`](#4-w1--json-etl)
5. [W2 — scale-hardened AWS scripts](#5-w2--scale-hardened-aws-scripts)
6. [W3 — control-plane CRUD fleet](#6-w3--control-plane-crud-fleet)
7. [W4 — special-dependency scripts](#7-w4--special-dependency-scripts)
8. [Verification checklists](#8-verification-checklists)

## 1. Cross-cutting architecture

These conventions bind every script in the fleet. They exist so that W5
promotion is a mechanical extraction, not a rewrite.

### 1.1 Streaming step contract (scale-critical)

Steps that touch record sets exchange **`AsyncIterable<TRecord>`**, never
materialized arrays:

- **Sources** wrap `Core.M3LJSONListImporter.importStream()` (files) or a
  paginated AWS read loop (Dynamo `Scan`/`Query`, SQS `ReceiveMessage`,
  Logs `GetQueryResults`) as an async generator.
- **Transforms** (`extract`, `filter`, `map`) are async generators that
  consume one record and yield zero or more — O(1) memory.
- **Sinks** wrap the exporters' streaming API (`exportStream()` →
  `append()`/`close()`), writing JSONL/CSV incrementally.
- **The only buffering steps are `sort` and `dedupe`**, and both require an
  explicit `limit` config value (validated via
  `Core.M3LConfigValidators.range`) — a preset that asks to sort an
  unbounded stream fails config validation, not the run.
- JSONL is the canonical interchange format for anything that can exceed
  ~10⁵ records; CSV/HTML/pretty-JSON are rendering formats applied after
  filtering/limiting.

Every step module is **injection-friendly** (deps passed as a single
options object; no module-level state) so a step proven in two scripts can
be promoted to the library verbatim (W5).

### 1.2 Checkpoint / resume convention

Long AWS reads persist progress so a killed run resumes instead of
restarting:

- Checkpoint file: `<output-dir>/<run-name>.checkpoint.json`, written
  atomically (write-temp-then-rename via `core/files` guards) every
  `checkpointEveryPages` pages (default 25).
- Contents are source-specific cursors: Dynamo `LastEvaluatedKey` (one per
  scan segment), Logs Insights `queryId`, S3 `ContinuationToken`.
- `--resume` (BOOL config param) loads the checkpoint and continues; the
  paired output file is opened in append mode. Absent checkpoint +
  `--resume` is a typed config error, not a silent fresh start.
- On successful completion the checkpoint file is deleted (stage-9 run
  archival then captures outputs as usual).

### 1.3 Retry, throttle, progress

- All AWS calls that can throttle run through `Core.M3LRetryRunner` with
  the shipped policies (`M3LPollingPolicies.sqsBatchSend()` pattern:
  throttling + network classifiers, exponential backoff). Poll-style waits
  use `Core.M3LPoller` with the matching policy
  (`cloudWatchLogsQuery()`, `athenaQuery()`).
- Optional client-side rate cap: `maxPagesPerSecond` (FLOAT, default
  unlimited) inserts an inter-page delay — the cheap, dependency-free way
  to keep a full-table scan from eating provisioned RCUs.
- Progress: one log line per `progressEveryRecords` (default 10 000)
  records — count, elapsed, source cursor — through `ctx`-correlated
  `Core.M3LLogger`; never per-record logging at scale.

### 1.4 Config, presets, CLI

- Each script declares `M3LConfigParameter`s in `src/config.ts` with
  validators; **named job presets** live as YAML under the script's config
  dir (`M3L_CONFIG_DIR` per-script isolation, ADR-0022 convention) and use
  `M3LScript` preset inheritance (`extends`) — a base preset holds the
  ordered output format, children override source/filters.
- CLI parameters override preset values per run
  (`--preset <name> --limit 100`).
- Secrets only via `.env` or config `secretNames` (redaction-safe);
  DB endpoints/credentials for W4 additionally supported through SSM
  Parameter Store reads (`script.aws.clients.ssm`) at the script's choice.

### 1.5 Destructive-operation gate

A shared step shape (first written in `dynamo-crud`, promoted in W5 if it
repeats — it will):

- Operations tagged destructive (delete/update/purge/redrive-with-delete/
  stack-delete/…) print a summary (target, operation, estimated blast
  radius) and require `core/prompt` confirmation.
- `--yes` (BOOL, also settable in a preset for blessed unattended jobs)
  bypasses the prompt; the bypass is logged.
- AWS access exclusively via the `aws.profile` config parameter
  (`Core.AWS_PROFILE_PARAM_NAME`) → `script.aws` seam. No script ever
  constructs its own credential chain.

### 1.6 Template improvement (pre-W1, one small `chore:` PR)

The emitted starter step under-demonstrates the seams the conventions
require: update `templates/script/` so `main.ts` passes config into the
step (`script.run((ctx) => runX({ logger: script.logger, config, ctx }))`)
and the starter step signature shows the injected-options pattern of §1.1.
Generator and checker share `bin/lib/script-scaffold.mjs`, so update the
manifest once; `check:script-scaffold` stays green by construction.

## 2. W0-L1 — `core/json` extraction extension

Branch `feat/json-extraction-paths` · semver-minor · consumer call-site:
`json-etl` (and every W2+ script's `extract` step).

Spec-first: update `docs/reference/core/json.md`, then the
`implementing-submodules` loop (spec-conformance → `test-author` RED →
`code-implementer` GREEN → `code-reviewer` + `type-design-analyzer`).

1. **Array-index segments** — in `navigateFieldPath`
   (`src/core/json/fieldPath.ts`): a numeric segment resolves as an array
   index when the current value is an array (today documented to return
   `undefined` — widening an explicit dead end, not breaking). Object-key
   behavior and the `isDangerousKey` prototype-pollution guard are
   unchanged.
2. **Wildcard segments** — `*` fans out over array elements and object
   values; paths stay schema-tolerant (`undefined`/skip on shape
   mismatch, never throw).
3. **Multi-value API** — `extractAll(record, path): readonly unknown[]`
   plus the `M3LJSONFieldExtractor` counterpart. Plain path → 0-or-1
   element; wildcard path → all matches in document order. The existing
   single-value `extract()` is untouched.
4. **Tolerant import mode (decide at spec time)** — opt-in
   `onUnknownFormat: "throw" | "skip"` on `M3LJSONListImporter`, so
   irregular files degrade per-record instead of the current hard
   `ERR_IMPORT_SOURCE`. If deferred, record the deferral in the spec page.

Close-out: scoped provenance restamp (json sidecar only — parallel-PR
lesson), symbol-count updates via `/syncing-docs`, minor version bump
(shared with L2 if same release window).

## 3. W0-L2 — `aws/clients` additions

Branch `feat/aws-clients-logs-docdb-athena` · semver-minor · consumer
call-sites: `logs-insights`, `dynamo-crud`, `data-query`.

All three follow the existing 14-getter pattern in
`src/aws/clients/provider.ts` (static import, lazily-cached synchronous
getter, hard exact-pinned dependency per the ADR-0017 AWS exception):

| Getter             | Package (pin to the `3.1079.0` line)                                   | Unblocks                                                                                           |
| ------------------ | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `cloudWatchLogs`   | `@aws-sdk/client-cloudwatch-logs`                                      | Logs Insights (`StartQuery`/`GetQueryResults`) — pairs the orphaned `cloudWatchLogsQuery()` policy |
| `dynamoDBDocument` | `@aws-sdk/lib-dynamodb` (`DynamoDBDocumentClient.from(this.dynamoDB)`) | plain-object Dynamo CRUD, no hand-marshalling                                                      |
| `athena`           | `@aws-sdk/client-athena`                                               | `data-query` — pairs the orphaned `athenaQuery()` policy                                           |

Also: extend `close()` best-effort destroy aggregation and the
getter-caching tests (`tests/clients.test.ts`) to cover all three; update
`docs/reference/aws/clients.md` spec first; `check:deps` (exact-pin
policy) and `check:api` snapshot updated intentionally.

Deferred decision (`eventbridge-schedules` spec time): if flexible
schedules are required, add `@aws-sdk/client-scheduler` + `scheduler`
getter in a follow-up minor — same pattern, one-line-per-layer.

## 4. W1 — `json-etl`

Branch `feat/script-json-etl` · `pnpm scaffold:script json-etl` →
`implementing-scripts`. Contract page
`docs/reference/scripts/json-etl.md` written first. This script defines
the step pattern everything else copies.

**Config parameters** (`src/config.ts`): `input` (STRING, path under the
input dir), `fields` (LIST of `name=path` extraction specs — list order
**is** the output column order), `filters` (LIST of `path op value` rules;
ops: `eq ne contains regex gt lt exists`; numerics via
`Core.parseLocaleNumber`), `format` (`json|jsonl|csv|html`), `output`
(STRING), `limit` (INT, required when `sort` is set), `sort`
(`name:asc|desc`, optional).

**Steps** (`src/steps/`, each an async generator per §1.1):

- `import-records.ts` — wraps `importStream()`; JSONL per-line tolerance
  gives the "non-standardized input" resilience for free.
- `extract-fields.ts` — maps field specs through L1
  `extractAll`/extractor into ordered flat records; multi-match paths
  join or fan out per a `multiValue: "join"|"explode"` config knob.
- `filter-records.ts` — predicate evaluation over raw or extracted paths.
- `export-results.ts` — dispatch to `M3LJSONListExporter` /
  `M3LCSVListExporter` (column ordering + conflict strategy) /
  `M3LHTMLListExporter` (template + column selection); streaming append.
- `run-json-etl.ts` — composes the pipeline; the only place that knows
  the order.

**Presets:** ship two real examples (a "report" preset with ordered CSV
columns; a child preset `extends`-ing it with a different filter) — they
double as living documentation of §1.4.

**Tests:** scaffold's config smoke test + per-step unit tests over
fixtures, including a malformed-lines NDJSON fixture and a
wildcard-extraction fixture. `security-reviewer` (always for scripts) +
`silent-failure-hunter` (tolerant-parse paths must count+report skips,
never silently swallow — skipped-line count surfaces in the run summary).

**Acceptance:** `pnpm --filter @m3l-automation/json-etl start` over a
fixture NDJSON in the input dir produces the ordered output file; knip,
`check:script-scaffold`, `gen:index` green. Write the work log with the
"library friction" section (F4 loop starts here).

## 5. W2 — scale-hardened AWS scripts

Three scripts, one PR each, all consuming the W1 step pattern and §1.1–1.5
conventions. AWS access via `script.aws.clients.*` only.

### 5.1 `dynamo-crud` — branch `feat/script-dynamo-crud`

Operations (config `operation`): `get | put | update | delete | query |
scan | batch-write | batch-delete | export | import`.

- **Read at scale** (`scan`/`export`, millions of records):
  `totalSegments` (INT, default 1) parallel scan workers, each an async
  generator page-looping on `LastEvaluatedKey`; per-segment checkpoints
  (§1.2); records stream straight to the JSONL sink — memory is O(page ×
  segments), never O(table). `maxPagesPerSecond` throttle for provisioned
  tables. `query` supports index selection + key conditions from preset.
- **Write at scale** (`batch-write`/`batch-delete`/`import`): source is a
  JSONL/JSON file via `import-records`; 25-item `BatchWrite` chunks;
  `UnprocessedItems` re-queued through `M3LRetryRunner` with the
  throttling classifier; `maxInFlightBatches` (INT, default 4) bounds
  concurrency; failed-after-retry items append to
  `<output>/failed.jsonl` for re-drive — the run reports written /
  retried / failed counts and exits non-zero on failures.
- **Item ergonomics:** `dynamoDBDocument` (L2) everywhere — plain JS
  objects in, out, and in dump files.
- **Destructive gate:** `delete`, `update`, `batch-delete`, and `import`
  into a non-empty table print target table + item estimate
  (`DescribeTable`) and confirm per §1.5.
- **ETL composition:** `export` output is Task-1 JSONL — filtering /
  extraction / re-formatting is `json-etl`'s job, not duplicated here
  beyond passing `fields`/`filters` straight to the shared steps.

### 5.2 `logs-insights` — branch `feat/script-logs-insights`

- Config: `logGroups` (LIST), `query` (STRING; presets are the saved-query
  library), `start`/`end` (relative `15m|1h|7d` or ISO), `limit`,
  `format`, `output`.
- Steps: `start-query.ts` (`StartQueryCommand` via L2 `cloudWatchLogs`) →
  `await-results.ts` (`M3LPoller` + `cloudWatchLogsQuery()` policy;
  `Failed`/`Cancelled`/timeout surface as typed errors carrying the
  `queryId` — never swallowed; the `queryId` is checkpointed so `--resume`
  re-polls instead of re-querying) → `normalize-rows.ts`
  (`ResultField[][]` → `Record<string, string>[]`) → shared
  extract/filter/export steps.
- Insights caps results at 10 000 rows per query: the contract page
  documents the split-by-time-window pattern (preset provides
  `windowMinutes`; the script fans sequential windows and streams each
  result set to the sink) for larger analyses.

### 5.3 `sqs-etl` — branch `feat/script-sqs-etl`

Operations: `dump | send | redrive | delete | purge | transform`.

- **`dump` (10⁴+ messages):** long-poll `ReceiveMessage` loop
  (10/batch, `WaitTimeSeconds` 20), streaming JSONL append of body +
  attributes + receipt metadata. Visibility budgeting: `visibilityTimeout`
  (INT) must exceed the estimated dump duration
  (`maxMessages / ~rate`) — the config validator enforces a floor and the
  contract page documents that a non-deleting dump of an actively-consumed
  queue is a snapshot, not a transaction. `deleteAfterDump` (BOOL,
  destructive → §1.5) turns the dump into a drain, deleting in 10-message
  batches only after the page has been durably appended.
- **`send`/`redrive`:** source JSONL via `import-records`;
  `SendMessageBatch` in 10-message chunks through `M3LRetryRunner` +
  `sqsBatchSend()` policy; per-entry failures append to `failed.jsonl`
  (same re-drive contract as `dynamo-crud`); FIFO support via
  `messageGroupId`/dedup-id fields when present in the dump.
- **`transform`:** runs the shared extract/filter/export steps over
  message bodies (JSON-parse wrapper step with per-message tolerance,
  skip-count surfaced) — queue-dump ETL without touching the queue.
- **`purge`:** confirm-gated; the contract page notes the AWS 60-second
  purge cooldown.

## 6. W3 — control-plane CRUD fleet

Six scripts over existing getters. Each is a thin op-dispatch: a
`<verb>-<resource>` step per operation, list-ops streaming through the
shared export steps, mutating ops confirm-gated. Shared shape (copied from
W2, promoted in W5): `list` (paginated generator → export), `describe`
(single resource → pretty JSON/table), `create/update/delete` (input from
preset or JSON file, destructive gate), plus per-service verbs:

| Script (branch `feat/script-<name>`) | Client                                                  | Ops beyond list/describe/CRUD                                                                                                    | Scale/notes                                                                                                                                                              |
| ------------------------------------ | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `s3-objects`                         | `s3`                                                    | `get`/`put`/`copy`/`rm` on objects; prefix listing                                                                               | `ListObjectsV2` `ContinuationToken` pagination + checkpoint; bulk `rm` by prefix is the highest-blast-radius op in the fleet — summary shows object count before confirm |
| `lambda-ops`                         | `lambda`                                                | `invoke` (sync/async, payload from file, response to output dir); `update-code`/`update-config`; alias/version ops               | invoke result + logs tail decoded to output                                                                                                                              |
| `ecs-ops`                            | `ecs`                                                   | `run-task`, `stop-task`, `update-service` (desired count, force-new-deployment), `scale`                                         | `waitUntilStable` via `M3LPoller` after mutations                                                                                                                        |
| `cfn-stacks`                         | `cloudFormation`                                        | `deploy` (create-or-update from template file + params preset), `delete`, `drift-detect`, `outputs`                              | stack-event streaming during deploy via poll loop; `delete` confirm shows resource count                                                                                 |
| `codepipeline-ops`                   | `codePipeline`                                          | `trigger` (`StartPipelineExecution`), `get-state`, `enable/disable-stage-transition`, `watch` (poll execution to terminal state) | `watch` uses `M3LPoller` with a per-script policy                                                                                                                        |
| `eventbridge-schedules`              | `eventBridge` (+ optional `scheduler`, see L2 deferred) | rule/schedule create/update/delete, enable/disable, list-targets                                                                 | decide rules-vs-Scheduler at spec time; delete/disable confirm-gated                                                                                                     |

Each still gets its own contract page, presets, config smoke test, and
per-step tests — "mechanical" describes the architecture, not the review
bar.

## 7. W4 — special-dependency scripts

Each carries a dependency decision reviewed in its own PR. The deps are
**script-package-local** (`scripts/<name>/package.json`), never library
deps — the library's minimal-runtime-deps rule is untouched, and knip's
per-workspace config keeps them honest.

### 7.1 `data-query` — branch `feat/script-data-query`

One script, three engines behind an `engine: athena | documentdb |
postgres` config param (the family was specified as one task family; the
engines share the query → stream-rows → export shape):

- **Athena:** L2 `athena` getter; `StartQueryExecution` →
  `M3LPoller` + `athenaQuery()` policy → paginated `GetQueryResults`
  streaming to the sink; workgroup + output-location from preset;
  checkpointable via `QueryExecutionId`.
- **PostgreSQL (RDS):** `pg` dep; connection from `.env`/SSM
  (§1.4); query streaming via `pg-query-stream`-style cursor batches
  (`cursorBatchSize` INT) so million-row results stay bounded; DML/DDL ops
  destructive-gated (`update`/`delete`/`truncate` require §1.5 confirm).
- **DocumentDB:** `mongodb` driver dep (DocumentDB is Mongo-compatible;
  TLS + replica-set options documented in the contract page); find/aggregate
  cursors stream naturally; write ops destructive-gated.
- Results from all three engines feed the shared extract/filter/export
  steps — one output contract regardless of engine.

### 7.2 `eks-ops` — branch `feat/script-eks-ops`

- **Cluster plane** (no new dep): L2-independent — `eks` getter covers
  cluster/nodegroup/addon list/describe/create/update/delete
  (create/delete confirm-gated with cost warning).
- **Workload plane** (`@kubernetes/client-node` script-local dep): pods /
  deployments / services / configmaps CRUD + `logs` + `scale` + `rollout
restart`. Auth: build the kubeconfig in-process from
  `DescribeCluster` (endpoint + CA) and a token from the same SDK
  credential chain the provider already resolved — no shell-out to
  `aws`/`kubectl`, no ambient kubeconfig mutation. Namespace-scoped by
  config; `delete`/`scale-to-zero` confirm-gated.

### 7.3 `apigw-client` — branch `feat/script-apigw-client`

Calls APIs **exposed through** API Gateway (the management plane already
has the `apiGateway` getter if list/describe of APIs is wanted as a
side-op):

- `Core.M3LHttpClient` (undici) is the transport; request specs (method,
  path, headers, body template, expected status) live in presets — the
  "pre-configured" request library.
- Auth modes (config `auth`): `none | api-key | iam`. `iam` signs
  requests with SigV4 via the script-local `@smithy/signature-v4` +
  the credentials already resolved by `script.aws` — the one place in the
  fleet that touches raw credentials, so `security-reviewer` scope is
  called out in the contract page; keys/tokens via `secretNames`
  redaction.
- Batch mode: a JSONL input of request parameter records fans through the
  preset template with bounded concurrency (`maxInFlight`), responses
  streaming to the sink — API-driven ETL for tens of thousands of calls,
  with per-request failures to `failed.jsonl`.

## 8. Verification checklists

Per library WS (L1, L2):

- [ ] `/starting-work` → `feat/<slug>`; spec page updated before code
- [ ] `pnpm typecheck && pnpm lint && pnpm test:coverage && pnpm build`
- [ ] `check:exports`, `check:api` snapshot updated intentionally,
      `check:deps`
- [ ] `/syncing-docs` — scoped provenance restamp, counts, index
- [ ] Minor version bump; PR gates + `claude-pr-review` PASS

Per script WS (every script, W1–W4):

- [ ] `/starting-work` → `feat/script-<name>`; contract page
      `docs/reference/scripts/<name>.md` written first
- [ ] Scaffold via `pnpm scaffold:script <name>`; config smoke test kept
- [ ] Steps follow §1.1 (streaming, injection-friendly); long reads
      checkpoint per §1.2; destructive ops gated per §1.5
- [ ] `pnpm typecheck && pnpm lint && pnpm test && pnpm build`,
      `check:script-scaffold`, `knip`, `gen:index`/`check:index`
- [ ] Smoke run via `pnpm --filter @m3l-automation/<name> start` (AWS
      scripts: mocked-client step tests are the merge bar; a live run
      against a real profile is recorded in the work log when performed)
- [ ] Work log with "library friction" section (`/writing-work-logs`) —
      feeds the W5/F4 promotion loop

Scale acceptance (W2, explicitly):

- [ ] `dynamo-crud export` over a ≥ 10⁶-record table: bounded memory
      (O(page × segments)), checkpoint proven by kill-and-`--resume`
- [ ] `sqs-etl dump` over a ≥ 10⁴-message queue: bounded memory, batch
      accounting exact (received = dumped + skipped), `failed.jsonl`
      re-drivable
