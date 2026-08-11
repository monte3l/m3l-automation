# CloudWatch Alarms

`M3LCloudWatchAlarmsOperations` is a typed wrapper over a raw
`CloudWatchClient`, so callers never import `@aws-sdk/client-cloudwatch`
command classes directly. Covers single-metric alarm create/update, describe,
and delete — the gap an internal capability audit of the library's AWS
surface found: `@aws-sdk/client-cloudwatch` was already a runtime dependency
and `AWSClientProvider` already exposed a raw `cloudWatch` getter, but no
consumable operation surface sat on top of it (the same shape of gap
ADR-0027 closed for `aws/eventbridge`/`aws/sqs`).

## Overview

Every AWS client getter on `AWSClientProvider` exposes a raw AWS SDK v3
client — see [AWS Clients](./clients.md). `M3LCloudWatchAlarmsOperations`
wraps the `cloudWatch` client, translating SDK request/response shapes into
plain, library-owned types so a caller never touches an
`@aws-sdk/client-cloudwatch` type.

- `M3LCloudWatchAlarmsOperations` — the wrapper class, constructed from a raw `CloudWatchClient`.
- `M3LCloudWatchAlarmsOperationError` — thrown on a request-level alarms-operation failure.
- Plain types: `M3LPutMetricAlarmInput`, `M3LCloudWatchAlarm`,
  `M3LCloudWatchDescribeAlarmsOptions`, `M3LCloudWatchDescribeAlarmsResult`,
  `M3LCloudWatchDimension`, `M3LCloudWatchStatistic`,
  `M3LCloudWatchComparisonOperator`, `M3LCloudWatchTreatMissingData`,
  `M3LCloudWatchAlarmState`.

## Scope

**In scope:** single-metric alarms only — `PutMetricAlarm`/`DescribeAlarms`/
`DeleteAlarms`, scoped to the common threshold-comparison fields (statistic,
period, evaluation periods, threshold, comparison operator, dimensions,
actions, `treatMissingData`).

**Out of scope for this iteration:**

- **Composite alarms** (`PutCompositeAlarm`, alarms built from other alarms'
  states via a rule expression) — `describeAlarms` always fixes `AlarmTypes`
  to `["MetricAlarm"]`, so a composite (or log) alarm never appears in a
  result even if the account has some.
- **Anomaly-detection alarms** (the `LessThanLowerOrGreaterThanUpperThreshold`-family
  comparison operators, `ThresholdMetricId`, `Metrics` math expressions).
  Unlike composite alarms, an anomaly-detection alarm **is** a `MetricAlarm`
  in AWS's own `AlarmType` model — it differs from a static-threshold alarm
  only by carrying `ThresholdMetricId` and one of the three
  anomaly-comparison operators — so the `AlarmTypes` filter above does
  **not** exclude it. `describeAlarms` narrows the mapped
  `comparisonOperator` to the four static-threshold operators only: an
  anomaly alarm in the result has its `comparisonOperator` field omitted
  (not populated with an out-of-union value) rather than defaulted or cast
  unchecked.
- **Alarm actions/state management beyond `PutMetricAlarm`**:
  `EnableAlarmActions`/`DisableAlarmActions`, `SetAlarmState` (manual state
  override, mainly a testing tool), `DescribeAlarmHistory`. Add the
  corresponding method when a consumer needs one (ADR-0027's
  per-consumer-need pattern).
- **Log-based alarms** (`PutLogAlarmCommand`) and **alarm mute rules** — a
  separate, newer CloudWatch capability, not modeled here.
- **Automatic pagination** — see the retry/pagination note below.

## Public API

### `M3LCloudWatchAlarmsOperations`

**Constructor** — `new M3LCloudWatchAlarmsOperations(client)`, where `client`
is a raw `CloudWatchClient` (e.g. `script.aws.clients.cloudWatch`).

| Method                     | Retried? | Returns                                      | Throws                              |
| -------------------------- | -------- | -------------------------------------------- | ----------------------------------- |
| `putMetricAlarm(input)`    | Yes      | `Promise<void>`                              | `M3LCloudWatchAlarmsOperationError` |
| `describeAlarms(options?)` | Yes      | `Promise<M3LCloudWatchDescribeAlarmsResult>` | `M3LCloudWatchAlarmsOperationError` |
| `deleteAlarms(alarmNames)` | Yes      | `Promise<void>`                              | `M3LCloudWatchAlarmsOperationError` |

**Retry:** every method wraps its SDK `.send()` call in `M3LRetryRunner`
configured by `M3LPollingPolicies.awsThrottling()` (throttling/network
classifiers, exponential-jittered backoff 200ms→5s), mirroring
`M3LEventBridgeOperations`'s uniform retry of both read and mutating calls.

**One-shot `describeAlarms`, no drain loop:** issues a single `DescribeAlarms`
request, not a draining generator. `options.nextToken`/the result's
`nextToken` round-trip AWS's own pagination token; looping until exhausted is
a caller/script decision, kept out of the library — mirrors
`M3LEventBridgeOperations.listRules`.

### `M3LCloudWatchAlarmsOperationError`

Subclass of `M3LError` with `code: "ERR_CLOUDWATCH_ALARMS_OPERATION"`. Thrown
when the underlying `PutMetricAlarm`/`DescribeAlarms`/`DeleteAlarms` call
rejects after retries. The originating SDK error is chained via `cause`.

### Plain types

- **`M3LPutMetricAlarmInput`** — `{ alarmName, metricName, namespace,
statistic, period, evaluationPeriods, threshold, comparisonOperator,
dimensions?, alarmDescription?, actionsEnabled?, alarmActions?, okActions?,
insufficientDataActions?, datapointsToAlarm?, treatMissingData? }`. Every
  camelCase field maps 1:1 onto its AWS PascalCase equivalent.
- **`M3LCloudWatchAlarm`** — `{ alarmName, alarmArn, stateValue,
alarmDescription?, stateReason?, metricName?, namespace?, statistic?,
dimensions?, period?, evaluationPeriods?, threshold?, comparisonOperator? }`
  — the `describeAlarms` result shape. `alarmName`/`alarmArn` default to
  `""` and `stateValue` defaults to `"INSUFFICIENT_DATA"` if the SDK response
  omits them (a real CloudWatch response always populates all three); every
  other field is omitted rather than defaulted when the SDK leaves it
  `undefined`.
- **`M3LCloudWatchDescribeAlarmsOptions`** — `{ alarmNames?,
alarmNamePrefix?, stateValue?, nextToken?, maxRecords? }`.
- **`M3LCloudWatchDescribeAlarmsResult`** — `{ alarms, nextToken? }` — one
  page; `nextToken` present only when another page is available.
- **`M3LCloudWatchDimension`** — `{ name, value }`, a metric dimension. Also
  re-exported (from this module) for `aws/cloudwatch-metrics`'s use — the two
  submodules' `types.ts` files each declare a structurally-identical copy
  (every submodule's types are self-contained, no cross-submodule imports),
  but only this module's copy is re-exported through the public
  `@m3l-automation/m3l-common/aws` barrel to avoid an ambiguous duplicate
  export.
- **`M3LCloudWatchStatistic`** — `"SampleCount" | "Average" | "Sum" | "Minimum" | "Maximum"`.
- **`M3LCloudWatchComparisonOperator`** — `"GreaterThanOrEqualToThreshold" | "GreaterThanThreshold" | "LessThanThreshold" | "LessThanOrEqualToThreshold"` — the four static-threshold operators; the anomaly-detection-only operators are out of scope (see above).
- **`M3LCloudWatchTreatMissingData`** — `"breaching" | "notBreaching" | "ignore" | "missing"`.
- **`M3LCloudWatchAlarmState`** — `"OK" | "ALARM" | "INSUFFICIENT_DATA"`.

## Usage

### From within a script

```typescript
const cloudWatchAlarmsOperations = new AWS.M3LCloudWatchAlarmsOperations(
  script.aws.clients.cloudWatch,
);

await cloudWatchAlarmsOperations.putMetricAlarm({
  alarmName: "nightly-job-errors",
  metricName: "Errors",
  namespace: "custom/nightly-job",
  statistic: "Sum",
  period: 300,
  evaluationPeriods: 1,
  threshold: 0,
  comparisonOperator: "GreaterThanThreshold",
  alarmActions: ["arn:aws:sns:eu-south-1:123456789012:ops-alerts"],
});

const { alarms } = await cloudWatchAlarmsOperations.describeAlarms({
  alarmNamePrefix: "nightly-",
});
```

### Standalone construction

```typescript
import { AWS } from "@m3l-automation/m3l-common";

const provider = new AWS.AWSClientProvider({
  profile: AWS.parseAWSProfile("my-profile"),
});
const cloudWatchAlarmsOperations = new AWS.M3LCloudWatchAlarmsOperations(
  provider.cloudWatch,
);
```

## Notes and behavior

- No `@aws-sdk/client-cloudwatch` type ever appears in this module's public
  surface — every request/response shape is translated to a plain type in
  `aws/cloudwatch-alarms/types.ts` at the boundary.
- `M3LCloudWatchAlarmsOperations` holds no destroyable resource of its own;
  when constructed from `AWSClientProvider.cloudWatch`, it shares the
  underlying client's connection lifecycle and is cleared (not independently
  destroyed) by `provider.close()`.
- `core/polling` is used here under the same Zone A exception ADR-0026
  recorded for `aws/sqs` (`aws/**` may otherwise import only
  `core/errors`/`core/prompt`); this module does not widen that exception
  further, it just uses the edge already opened.

## See also

- [AWS Clients](./clients.md) — the raw `cloudWatch` client getter and
  `AWSClientProvider`/`AWSProvider` this module builds on.
- [CloudWatch Metrics](./cloudwatch-metrics.md) — the sibling wrapper over
  the same `cloudWatch` client, for custom-metric publishing and statistics
  retrieval; shares this module's `M3LCloudWatchDimension` type.
- [EventBridge Operations](./eventbridge.md) — the sibling wrapper this
  module's shape mirrors, and [ADR-0027](../../adr/0027-aws-sdk-boundary-typed-wrappers.md)
  for the typed-wrapper-per-consumer-need decision this module implements.
- [Polling](../core/polling.md) — `M3LRetryRunner` / `M3LPollingPolicies` /
  the classifiers this module composes internally.
