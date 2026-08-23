# sqs-dead-letter-triage

Triage and remediate messages stranded in SQS dead-letter queues against codified runbook presets

> **This page is the script's contract** — configuration schema, steps, and
> inputs/outputs. How to _run_ it lives in the colocated
> [`scripts/sqs-dead-letter-triage/README.md`](../../../scripts/sqs-dead-letter-triage/README.md).

## Purpose and scope

Reaches an operator verdict for every message stranded in a dead-letter queue,
by running a codified nine-step procedure ([ADR-0046](../../adr/0046-codified-procedure-engine.md))
against a per-queue runbook preset, and — behind a graded destructive gate
([ADR-0048](../../adr/0048-target-graded-destructive-confirmation.md)) — applies
the remediation that verdict implies.

The split between code and data is [ADR-0077](../../adr/0077-dead-letter-queue-triage-procedure.md):
the spine is TypeScript, so `stepId` stays a closed literal union and cycle
detection keeps working; everything that varies per queue is preset data an
operator amends after an incident.

**This is the decision layer, not the mechanical one.**
[`sqs-etl`](./sqs-etl.md) keeps the raw dump / send / redrive / delete / purge
operations; neither script absorbs the other.

> **Landing status.** The offline spine (`validate`, `explain`, `convert`) and
> the read-only AWS path (`triage`) are implemented. The `execute` operation —
> applying the remediation a verdict implies, behind the graded destructive
> gate — is **not yet implemented** and is absent from the configuration schema
> below; it lands in the following slice (ADR-0072 reviewable-slice
> discipline). Nothing on this page describes behaviour the script does not
> currently have.

## Configuration schema

Every value is declared through the config seam; the script never reads
`process.env` directly.

| Parameter           | Type     | Default    | Required for        | Notes                                                                        |
| ------------------- | -------- | ---------- | ------------------- | ---------------------------------------------------------------------------- |
| `operation`         | `STRING` | `validate` | —                   | One of `validate`, `explain`, `convert`, `triage`.                           |
| `runbookDir`        | `STRING` | `runbooks` | —                   | Preset directory, resolved under `M3L_INPUT_DIR`.                            |
| `queue`             | `STRING` | —          | `explain`, `triage` | The queue a preset is keyed by. Selects `<queue>.json`.                      |
| `queueUrl`          | `STRING` | —          | `triage`            | The dead-letter queue's AWS URL. Deliberately separate from `queue`.         |
| `source`            | `STRING` | —          | `convert`           | Markdown runbook to convert, resolved under `M3L_INPUT_DIR`.                 |
| `output`            | `STRING` | —          | —                   | Artifact name for `convert`; defaults to `<queue>.json`.                     |
| `maxMessages`       | `INT`    | `100`      | —                   | Total messages one `triage` drain pulls across all pages (1–10,000).         |
| `visibilityTimeout` | `INT`    | `1800`     | —                   | Seconds the drained batch stays invisible (0–43,200).                        |
| `aws.profile`       | `STRING` | —          | —                   | Declared but **not** `required`; absent is legitimate for the offline three. |

`queue` and `queueUrl` are two different things and neither derives from the
other. `queue` selects the preset file, so it is filename-safe and guarded
against `/` and `..`; a queue URL contains path separators and could never be
one. `queueUrl` addresses the real AWS queue, and the SQS wrapper exposes no
`getQueueUrl` to bridge them. Supplying a `queueUrl` that does not correspond
to `queue`'s preset is an operator error the script cannot detect.

Per-operation requiredness is enforced by cross-parameter `configValidators`
in `src/config.ts`, so a missing `--queue` on `explain` fails during
configuration resolution rather than midway through a run.

`aws.profile` is declared but not `required: true`. Declaring the parameter is
what makes `M3LScript` provision the `script.aws` facade at all, and it does so
whenever the parameter is _declared_ — not only when a value is supplied
(`M3LScript.provisionAws`). An absent or empty `aws.profile` is a valid config:
the provider defers to the SDK's default credential chain rather than this seam
duplicating credential validation.

Two consequences worth being precise about. `validate`, `explain` and `convert`
stay runnable with no credentials at all — provisioning a facade is not the
same as using it — which is what keeps `validate` viable as a CI gate. And
`triage` does **not** pre-flight your credentials: with none configured, it
fails at the first SQS call with `ERR_SQS_OPERATION` naming
`GetQueueAttributes`, not with a tidy "set `aws.profile`" message. The
handler's own `ERR_DLQ_TRIAGE_CONFIG` guard covers only the case where the
facade genuinely failed to provision.

## Steps

| Step                   | Kind        | Flow                                                                                              |
| ---------------------- | ----------- | ------------------------------------------------------------------------------------------------- |
| `resolve-mode`         | `control`   | `handling !== "runbook"` ⇒ `stop` into the matching codified terminal case                        |
| `parse-envelope`       | `transform` | Applies the preset's envelope rule; unparseable ⇒ `stop`                                          |
| `route-event`          | `decide`    | Reads the discriminator and selects an arm; no match and no default arm ⇒ `stop`                  |
| `extract-key`          | `transform` | Path plus optional strip-prefix / add-suffix / capture; missing or unsafe ⇒ `stop`                |
| `widen-lookup`         | `control`   | Selects lookup tier _n_; execution _n_ selects the next fallback tier                             |
| `lookup-entity`        | `gather`    | Reads the correlated entity through the narrow lookup seam                                        |
| `check-entity-present` | `check`     | Found ⇒ `continue`; absent with a tier left ⇒ `{ goTo: "widen-lookup" }`; exhausted ⇒ `onMissing` |
| `derive-state`         | `transform` | Projects `fromState`, `nextState`, `eventType` and a normalised `progression` into `values`       |
| `match-known-cases`    | `check`     | `flow: "resolve"`                                                                                 |

The procedure is built once per preset and **run once per message**; a
queue-level run aggregates the per-message conclusions.

### The compiled step graph

`widen-lookup` sits **before** `lookup-entity`, and the `loop` lives on
`check-entity-present`, the step that follows the gather. This reproduces
ADR-0076's corrected ordering deliberately: with the loop on the check step,
`"continue"` falls through to the success path instead of re-widening, and the
back edge originates from a step carrying `loop`, which keeps it out of
build-time cycle detection.

A stage the preset does not declare is not omitted from the graph — its step
runs and returns `{ flow: "continue" }` with the note
`"skipped: stage not declared"`, so a skipped stage stays visible in the trace.

`revision` folds the preset's own canonical hash into the build, so two runs
are comparable only when the preset they ran from is byte-identical.

### Verdict vocabulary

**Authorable on a case row:** `remove`, `reinsert`, `hold`, `escalate`,
`known-no-action`.

**Reserved for the codified terminal cases:** `not-runbook-managed`,
`unparseable`, `unrouted`, `no-key`, `entity-not-found`, and `unrecognised`
(the mandatory fallback).

Authoring a reserved verdict is rejected at the trust boundary. The point is
narrow and load-bearing: it stops a row that only matches _when the entity was
found_ from claiming `entity-not-found`.

Verdicts map to actions — `remove` → delete, `reinsert` → send to source then
delete, everything else → leave in place — but **no action is executed by this
slice**; only `validate`, `explain` and `convert` are implemented.

## Preset schema

One preset per queue, resolved as `<runbookDir>/<queue>.json`.

| Field          | Type       | Notes                                                                   |
| -------------- | ---------- | ----------------------------------------------------------------------- |
| `queue`        | `string`   | The dead-letter queue this preset governs.                              |
| `title`        | `string`   | Human-readable label for reports.                                       |
| `handling`     | enum       | `runbook` \| `redrive` \| `script` \| `ad-hoc` \| `under-analysis`.     |
| `prohibitions` | `string[]` | Overrides that downgrade a verdict to a follow-up. Always win.          |
| `fifo`         | `boolean`  | Whether the queue is FIFO; drives ordered, single-entry sends.          |
| `orderBy`      | `string?`  | Envelope path the FIFO path sorts on.                                   |
| `sourceQueue`  | `string?`  | Where a `reinsert` verdict sends. Cross-checked against the live queue. |
| `envelope`     | object     | How to reach the message payload.                                       |
| `routeOn`      | `string`   | Envelope path holding the event-type discriminator.                     |
| `arms`         | `Arm[]`    | One per event type; an arm with no `match` is the default arm.          |
| `escalateTo`   | `string`   | The owning team.                                                        |
| `followUps`    | `string[]` | Steps the script deliberately does not automate.                        |
| `todos`        | `string[]` | Conversion gaps. **A non-empty `todos` fails `validate`.**              |

Each **arm** carries `match`, `label`, a `key` rule, `lookup` tiers with an
`onMissing` policy, a `state` field map, and its own `cases[]`.

Each **case** carries `id`, `description`, `prose`, a unique `priority` above
the reserved ceiling, the optional predicates `fromState` / `nextState` /
`eventType` / `signature` / `requiredProgression`, then `verdict` and the
optional `ticket`, `resolution`, `escalateTo`, `followUps`.

**All declared predicates must hold** for a case to match, and priority breaks
ties — so a narrow row beats a broad one regardless of authoring order.

Every regex is compiled and length-bounded at load, so a bad pattern is a
preset problem rather than a `SyntaxError` from inside a step. Patterns are
additionally routed through the procedure engine's own pattern-safety check,
which rejects any **quantified group** — a `)` immediately followed by `*`,
`+`, `?` or `{`. That covers catastrophic-backtracking shapes such as
`^(x+x+)+y$`, and it is deliberately conservative: a harmless `(?:pre-)?` is
rejected too. The same rule applies to `case.signature` and `key.capture`
alike, so one constraint holds everywhere. Write `(?:pre-)` rather than
`(?:pre-)?`, or split the row into two cases. The extracted
key is allow-listed before use; no value is interpolated into a query string
anywhere, because the lookup is a typed key.

## Error codes

| Code                       | Raised when                                                       |
| -------------------------- | ----------------------------------------------------------------- |
| `ERR_DLQ_TRIAGE_CONFIG`    | A configuration value is missing or invalid for the operation.    |
| `ERR_DLQ_TRIAGE_PRESET`    | A preset fails the trust boundary (shape, regex, reserved value). |
| `ERR_DLQ_TRIAGE_VALIDATE`  | `validate` found problems across one or more presets.             |
| `ERR_DLQ_TRIAGE_PROCEDURE` | The compiled procedure was asked for a stage the preset omits.    |
| `ERR_DLQ_TRIAGE_DRAIN`     | The queue could not be drained or its attributes not read.        |
| `ERR_DLQ_TRIAGE_LOOKUP`    | An entity lookup rejected; the underlying error is the `cause`.   |
| `ERR_DLQ_TRIAGE_RUN`       | `triage` could not reach a verdict for the queue as a whole.      |
| `ERR_OPERATION_ABORTED`    | A cancellation signal fired; raised by the library, not remapped. |

## Inputs and outputs

**Inputs** — preset JSON under `M3L_INPUT_DIR/<runbookDir>/`, and for
`convert`, a markdown runbook under `M3L_INPUT_DIR`.

**Outputs** — `convert` writes a preset skeleton to `M3L_OUTPUT_DIR`;
`validate` and `explain` produce logger output only. `triage` writes two
artifacts under `M3L_OUTPUT_DIR/<queue>/`:

| Artifact                  | Contents                                                                        |
| ------------------------- | ------------------------------------------------------------------------------- |
| `drain-<timestamp>.json`  | The full drained batch — **raw bodies verbatim**, message ids, receipt handles. |
| `triage-<timestamp>.json` | One row per message: verdict, case id, follow-ups, and a bounded body excerpt.  |

The two differ deliberately. The drain artifact is the archive-before-destroy
evidence, so truncating it would defeat its only purpose — a shortened body
cannot reconstruct a deleted message. The report is the artifact a human reads
and a later run diffs, so it carries only the first 256 characters of each body
plus the true untruncated length. Neither the excerpt nor the raw body is ever
written to a log line.

Presets are operator-owned and live outside this repository. Only invented
examples and fixtures are committed here.

## See also

- [ADR-0077](../../adr/0077-dead-letter-queue-triage-procedure.md) — the design this implements
- [ADR-0046](../../adr/0046-codified-procedure-engine.md) — the procedure engine
- [ADR-0076](../../adr/0076-codified-runbook-analysis-presets.md) — the code/data split precedent
- [`core/procedure`](../core/procedure.md) — the engine's API
- [`aws/sqs`](../aws/sqs.md) — the typed SQS wrapper `triage` drains through
- [`cloudwatch-logs-analysis`](./cloudwatch-logs-analysis.md) — the sibling codified-runbook consumer
