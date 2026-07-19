# eventbridge-schedules

Manage EventBridge rules (list, describe, create, update, delete, enable, disable) via M3LEventBridgeOperations.

> **This page is the script's contract** — configuration schema, steps, and
> inputs/outputs. How to _run_ it lives in the colocated
> [`scripts/eventbridge-schedules/README.md`](../../../scripts/eventbridge-schedules/README.md).

## Purpose and scope

A control-plane consumer script over Amazon EventBridge **rules** (not the
separate EventBridge Scheduler service). An `operation` config parameter
selects one of seven verbs: `list`, `describe`, `create`, `update`, `delete`,
`enable`, `disable`. `create`/`update` both call the underlying `PutRule`
(EventBridge's own upsert semantics — the two operation names exist for
operator clarity, not a different AWS call) and may optionally attach targets
in the same run via the `targets` config field, since a rule with no targets
performs no action. Mutating operations (`create`/`update`/`delete`/`enable`/
`disable`) are confirm-gated before dispatch; `list`/`describe` are never
gated.

It is out of scope for this script to manage standalone **target** lifecycle
(`PutTargets`/`RemoveTargets`/`ListTargetsByRule` as independent operations) —
`AWS.M3LEventBridgeOperations` supports all three, but this script only
exposes the `targets` create/update convenience described above; listing or
removing targets independently is deferred to a future iteration. The
EventBridge Scheduler service (a separate AWS service from EventBridge rules)
is out of scope entirely — see `aws/eventbridge`'s own scope note, which this
script inherits unchanged.

## Configuration schema

Declared in `src/config.ts` (`configParameters`); config is the script's only
input seam. Per-operation requiredness (the "Required for" column) is **not**
expressed by `M3LConfigParameter({ required: true })` beyond `operation`/
`aws.profile` themselves — the library has no cross-parameter/conditional-required
seam yet (F1b, deferred). Every other parameter is declared optional, and the
selected step guard-checks presence before any AWS call (mirroring
`dynamodb-crud`'s per-operation guard). Declaring `aws.profile` (via
`Core.AWS_PROFILE_PARAM_NAME`) is what enables the `script.aws`
dynamic-provisioning seam, populating `script.aws.clients.eventBridgeOperations`.

| Parameter            | Type     | Default | Validation                                                                             | Required for                                             | Description                                                                                                                                                                            |
| -------------------- | -------- | ------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `aws.profile`        | `STRING` | —       | `required: true`, `nonEmpty`                                                           | all                                                      | AWS SSO/credential profile name; declaring it (via `Core.AWS_PROFILE_PARAM_NAME`) triggers `M3LScript`'s AWS-provisioning stage, populating `script.aws.clients.eventBridgeOperations` |
| `operation`          | `STRING` | —       | `required: true`, `oneOf(list, describe, create, update, delete, enable, disable)`     | all                                                      | Selects the verb; dispatched by `run-eventbridge-schedules.ts`                                                                                                                         |
| `ruleName`           | `STRING` | —       | `nonEmpty` (guard-checked)                                                             | `describe`/`create`/`update`/`delete`/`enable`/`disable` | The rule to operate on; unused for `list` (use `namePrefix` to filter there instead)                                                                                                   |
| `namePrefix`         | `STRING` | —       | `nonEmpty`                                                                             | `list` (optional)                                        | Only rules whose name starts with this prefix are returned                                                                                                                             |
| `eventBusName`       | `STRING` | —       | `nonEmpty`                                                                             | all (optional)                                           | Targets a non-default event bus; defaults to the account's default event bus when unset                                                                                                |
| `eventPattern`       | `STRING` | —       | `nonEmpty` (guard-checked; mutually exclusive with `scheduleExpression`)               | `create`/`update` (one of two required)                  | JSON event-pattern rule definition, passed verbatim to `PutRule`                                                                                                                       |
| `scheduleExpression` | `STRING` | —       | `nonEmpty` (guard-checked; mutually exclusive with `eventPattern`)                     | `create`/`update` (one of two required)                  | `cron(...)` / `rate(...)` schedule expression                                                                                                                                          |
| `state`              | `STRING` | —       | `oneOf(ENABLED, DISABLED, ENABLED_WITH_ALL_CLOUDTRAIL_MANAGEMENT_EVENTS)`              | `create`/`update` (optional)                             | The rule's initial/updated state; EventBridge defaults to `ENABLED` on create when omitted                                                                                             |
| `description`        | `STRING` | —       | —                                                                                      | `create`/`update` (optional)                             | Human-readable rule description                                                                                                                                                        |
| `roleArn`            | `STRING` | —       | `nonEmpty`                                                                             | `create`/`update` (optional)                             | ARN of the IAM role used for target invocation                                                                                                                                         |
| `targets`            | `STRING` | —       | `nonEmpty`; must decode to a JSON array of `{ id, arn, roleArn?, input?, inputPath? }` | `create`/`update` (optional)                             | When set, `PutTargets` is called immediately after a successful `PutRule` to attach these targets to the rule                                                                          |
| `force`              | `BOOL`   | `false` | —                                                                                      | `delete` (optional)                                      | Required `true` to delete a managed rule (one created on the caller's behalf by an AWS service); ignored for non-managed rules                                                         |
| `output`             | `STRING` | —       | `nonEmpty`                                                                             | `list`/`describe` (optional)                             | Sink for the rule listing / rule detail (resolved via `M3LPaths.resolveOutput`); omitted means the result is only logged, not persisted                                                |
| `yes`                | `BOOL`   | `false` | —                                                                                      | any mutating operation (optional)                        | Bypasses the destructive-operation confirmation prompt for unattended runs; the bypass is logged as a warning                                                                          |

## Steps

One row per `src/steps/` module; each step takes injected dependencies and is
unit-testable without the lifecycle. `run-eventbridge-schedules.ts` dispatches
on the resolved `operation`; `create`/`update` share an internal `put-rule`
helper since both drive the same underlying `PutRule` call.

| Step                           | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run-eventbridge-schedules`    | Composition/dispatcher: reads the `oneOf`-validated `operation`, runs `destructive-gate` first for a mutating operation (`create`/`update`/`delete`/`enable`/`disable`), then **dynamic-imports** the matching step — `list-rules.js`, `describe-rule.js`, `create-rule.js`, `update-rule.js`, `delete-rule.js`, `enable-rule.js`, or `disable-rule.js` — forwarding the deps object unchanged; a defensive `default` throws `ERR_EVENTBRIDGE_SCHEDULES_CONFIG`. Dynamic import (not a top-level static import) so `steps/*.test.ts` can `vi.mock` each step before dispatch resolves it |
| `destructive-gate`             | Shared confirmation step (mirrors `api-gateway-client`'s): prints the operation + rule name, prompts via `script.prompt.confirm(description)`, and throws `ERR_EVENTBRIDGE_SCHEDULES_ABORTED` when declined; bypassed by `yes` (bypass logged as a warning so an unattended run still leaves an audit trail)                                                                                                                                                                                                                                                                             |
| `list-rules`                   | Guard-optional `namePrefix`/`eventBusName`; drains every `listRules` page (looping `nextToken` — the wrapper issues one page per call by design) into a single array; writes the accumulated rules to `output` via `Core.M3LJSONListExporter` (whole-array `.export()`, JSON format) when configured, else logs the count                                                                                                                                                                                                                                                                |
| `describe-rule`                | Guard-required `ruleName`; calls `describeRule(ruleName, { eventBusName? })`; writes the detail to `output` as one JSON document when configured, else logs it                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `create-rule` / `update-rule`  | Guard-required `ruleName` and exactly one of `eventPattern`/`scheduleExpression` (mirroring the wrapper's own discriminated-union input); both delegate to a shared internal `putRuleStep` helper that calls `putRule({...})`, then — when `targets` is configured — parses it as JSON and calls `putTargets(ruleName, targets, {...})`, logging any per-entry `failed[]` (never throwing — matches the wrapper's own never-throws-per-entry-failure contract for that call)                                                                                                             |
| `delete-rule`                  | Guard-required `ruleName`; calls `deleteRule(ruleName, { eventBusName?, force? })`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `enable-rule` / `disable-rule` | Guard-required `ruleName`; call `enableRule`/`disableRule` `(ruleName, { eventBusName? })`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

All EventBridge access goes through the injected
`AWS.M3LEventBridgeOperations` (`script.aws.clients.eventBridgeOperations`,
see [`aws/eventbridge`](../aws/eventbridge.md)) — this script never imports
`@aws-sdk/*` directly (ADR-0029).

Script-local error codes are plain `M3LError.code` strings (the field is an
open `string`, not a closed union — exactly like `api-gateway-client`'s
`ERR_API_GATEWAY_CLIENT_*`), all prefixed `ERR_EVENTBRIDGE_SCHEDULES_`:

- `ERR_EVENTBRIDGE_SCHEDULES_CONFIG` — a guard-checked config requirement was
  unmet (missing `ruleName`, missing/both-set `eventPattern`/
  `scheduleExpression`, malformed `targets` JSON, or an unrecognized
  `operation`).
- `ERR_EVENTBRIDGE_SCHEDULES_ABORTED` — the destructive-gate confirmation was
  declined.
- `ERR_EVENTBRIDGE_SCHEDULES_NO_CORRELATION_ID` — thrown by
  `getCorrelationId()` when read before `onBeforeRun` has captured it (mirrors
  `dynamodb-crud`'s hook guard).

## Inputs and outputs

No `M3L_INPUT_DIR` usage — every operation's parameters (including the
`targets` attach list) come from config, not a bulk input file; this is a
control-plane script, not a bulk data pipeline. `list` writes the accumulated
rule listing to the configured `output` under `M3L_OUTPUT_DIR` as a single
JSON array (when set); `describe` writes the rule detail as a single JSON
document (when set). `create`/`update`/`delete`/`enable`/`disable` write
nothing — their result is logged, not persisted (there is no bulk
success/failure ledger to reconcile, unlike a batch/ETL script).

## Out of scope for this iteration

- **Standalone target management** (`list-targets`/`put-targets`/
  `remove-targets` as independent operations) — only the `create`/`update`
  `targets` attach convenience is exposed; the wrapper's full target surface
  is available to a future iteration that needs it.
- **EventBridge Scheduler** — a separate AWS service from EventBridge rules;
  `aws/eventbridge` itself is scoped to rules only (see its own doc page).
- **Per-service target parameter blocks** (Kinesis, ECS, Batch, SQS DLQ,
  retry policy, AppSync, input transformer, run-command, etc.) — mirrors
  `aws/eventbridge`'s own deliberate scope limit; `targets` here only carries
  `id`/`arn`/`roleArn`/`input`/`inputPath`.
- **Cross-account/cross-region rule management** — one profile, one region,
  per run.
- **Rule/target diffing or drift detection** — `create`/`update` always
  issue a `PutRule` (EventBridge's own idempotent upsert); this script does
  not compare against the existing rule state first.

## See also

- [`aws/eventbridge`](../aws/eventbridge.md) — `M3LEventBridgeOperations`, the sole AWS access seam this script uses
- [`core/script`](../core/script.md) — the `M3LScript` lifecycle the script runs on
- [ADR-0022](../../adr/0022-reintroduce-scripts-workspace.md) — fleet conventions
- [ADR-0027](../../adr/0027-aws-sdk-boundary-typed-wrappers.md) — the typed-wrapper-per-consumer-need pattern `aws/eventbridge` follows
- [ADR-0029](../../adr/0029-script-dependency-boundary.md) — why this script cannot import `@aws-sdk/*` directly
