# CloudWatch Metrics

`M3LCloudWatchMetricsOperations` is a typed wrapper over a raw
`CloudWatchClient`, so callers never import `@aws-sdk/client-cloudwatch`
command classes directly. Covers custom-metric publishing and statistics
retrieval — the sibling gap to [CloudWatch Alarms](./cloudwatch-alarms.md),
both closing the same capability-audit finding over the same `cloudWatch`
client.

## Overview

Every AWS client getter on `AWSClientProvider` exposes a raw AWS SDK v3
client — see [AWS Clients](./clients.md). `M3LCloudWatchMetricsOperations`
wraps the `cloudWatch` client, translating SDK request/response shapes into
plain, library-owned types so a caller never touches an
`@aws-sdk/client-cloudwatch` type.

- `M3LCloudWatchMetricsOperations` — the wrapper class, constructed from a raw `CloudWatchClient`.
- `M3LCloudWatchMetricsOperationError` — thrown on a request-level metrics-operation failure.
- Plain types: `M3LPutMetricDataInput`, `M3LCloudWatchMetricDatum`,
  `M3LCloudWatchStatisticSet`, `M3LGetMetricStatisticsInput`,
  `M3LGetMetricStatisticsResult`, `M3LCloudWatchDatapoint`,
  `M3LCloudWatchStandardUnit`, `M3LCloudWatchMetricStatistic`.

## Scope

**In scope:** `PutMetricData` (custom-metric publishing, single values or
pre-aggregated statistic sets) and `GetMetricStatistics` (the classic
single-metric statistics query — not the newer, batched/math-expression
`GetMetricData`).

**Out of scope for this iteration:**

- **`GetMetricData`** — the newer, batched multi-metric/math-expression query
  API. `GetMetricStatistics` covers the common single-metric case this
  wrapper targets; add a `GetMetricData`-backed method when a consumer needs
  cross-metric math or batched multi-metric queries in one call.
- **`ListMetrics`** (metric discovery/browsing) and **metric streams**
  (`PutMetricStream`/`GetMetricStream`/`ListMetricStreams`/
  `StartMetricStreams`/`StopMetricStreams`) — a separate, higher-throughput
  streaming capability, not modeled here.
- **`GetMetricWidgetImage`** (dashboard image rendering) — presentation, not
  operational data.
- **`EntityMetricData`/`StrictEntityValidation`** on `PutMetricData` — the
  newer entity-association fields; `M3LPutMetricDataInput` covers plain
  `MetricData` only.

## Public API

### `M3LCloudWatchMetricsOperations`

**Constructor** — `new M3LCloudWatchMetricsOperations(client)`, where
`client` is a raw `CloudWatchClient` (e.g. `script.aws.clients.cloudWatch`).

| Method                       | Retried? | Returns                                 | Throws                               |
| ---------------------------- | -------- | --------------------------------------- | ------------------------------------ |
| `putMetricData(input)`       | Yes      | `Promise<void>`                         | `M3LCloudWatchMetricsOperationError` |
| `getMetricStatistics(input)` | Yes      | `Promise<M3LGetMetricStatisticsResult>` | `M3LCloudWatchMetricsOperationError` |

**Retry:** every method wraps its SDK `.send()` call in `M3LRetryRunner`
configured by `M3LPollingPolicies.awsThrottling()` (throttling/network
classifiers, exponential-jittered backoff 200ms→5s), mirroring
`M3LCloudWatchAlarmsOperations`.

**Batch limit:** `putMetricData` accepts between 1 and 1000 entries in
`metricData` (the `PutMetricData` API's own per-call cap, mirroring
`aws/s3`'s `deleteObjects` 1000-key-cap precedent); a violation throws
`M3LCloudWatchMetricsOperationError` (no `cause`) before any AWS call is
made.

### `M3LCloudWatchMetricsOperationError`

Subclass of `M3LError` with `code: "ERR_CLOUDWATCH_METRICS_OPERATION"`.
Thrown when `metricData` fails the pre-flight batch-size guard (no `cause`,
no AWS call made), or when the underlying `PutMetricData`/`GetMetricStatistics`
call rejects after retries (`cause` chains the originating SDK error).

### Plain types

- **`M3LPutMetricDataInput`** — `{ namespace, metricData }`.
- **`M3LCloudWatchMetricDatum`** — `{ metricName, value?, dimensions?,
timestamp?, unit?, statisticValues? }` — one datapoint to publish. Either
  `value` (a single measurement) or `statisticValues` (a pre-aggregated
  summary) is typically supplied, not both — this is not enforced at the
  type level, matching the underlying `MetricDatum` SDK shape.
- **`M3LCloudWatchStatisticSet`** — `{ sampleCount, sum, minimum, maximum }`
  — a pre-aggregated statistic summary for `statisticValues`.
- **`M3LGetMetricStatisticsInput`** — `{ namespace, metricName, startTime,
endTime, period, statistics, dimensions?, unit? }`.
- **`M3LGetMetricStatisticsResult`** — `{ label?, datapoints }`.
- **`M3LCloudWatchDatapoint`** — `{ timestamp?, sampleCount?, average?,
sum?, minimum?, maximum?, unit? }` — every field omitted (not defaulted)
  when the SDK response leaves it `undefined`.
- **`M3LCloudWatchStandardUnit`** — the full AWS `StandardUnit` enum as a
  string-literal union (`"Seconds"`, `"Bytes"`, `"Count"`, `"Percent"`,
  `"None"`, and their `/Second` rate variants, etc.).
- **`M3LCloudWatchMetricStatistic`** — `"SampleCount" | "Average" | "Sum" |
"Minimum" | "Maximum"` — the statistic types `getMetricStatistics.statistics`
  accepts. Structurally identical to
  [CloudWatch Alarms](./cloudwatch-alarms.md)'s `M3LCloudWatchStatistic` but
  declared separately (this submodule's `types.ts` has zero imports from
  `cloudwatch-alarms`, matching every other submodule's self-contained-types
  convention in this library).

**`M3LCloudWatchDimension`** (used by `dimensions` above) is declared in this
submodule's own `types.ts` but **not** re-exported through the public
`@m3l-automation/m3l-common/aws` barrel from here — it is re-exported once,
from [CloudWatch Alarms](./cloudwatch-alarms.md), to avoid an ambiguous
duplicate export. The two submodules' copies are structurally identical
(`{ name, value }`); import it from either module's TypeScript perspective,
it resolves to the same public symbol.

## Usage

### From within a script

```typescript
const cloudWatchMetricsOperations = new AWS.M3LCloudWatchMetricsOperations(
  script.aws.clients.cloudWatch,
);

await cloudWatchMetricsOperations.putMetricData({
  namespace: "custom/nightly-job",
  metricData: [
    { metricName: "RecordsProcessed", value: 4213 },
    { metricName: "Errors", value: 0 },
  ],
});

const { datapoints } = await cloudWatchMetricsOperations.getMetricStatistics({
  namespace: "custom/nightly-job",
  metricName: "RecordsProcessed",
  startTime: new Date(Date.now() - 24 * 60 * 60 * 1000),
  endTime: new Date(),
  period: 3600,
  statistics: ["Sum"],
});
```

### Standalone construction

```typescript
import { AWS } from "@m3l-automation/m3l-common";

const provider = new AWS.AWSClientProvider({
  profile: AWS.parseAWSProfile("my-profile"),
});
const cloudWatchMetricsOperations = new AWS.M3LCloudWatchMetricsOperations(
  provider.cloudWatch,
);
```

## Notes and behavior

- No `@aws-sdk/client-cloudwatch` type ever appears in this module's public
  surface — every request/response shape is translated to a plain type in
  `aws/cloudwatch-metrics/types.ts` at the boundary.
- `M3LCloudWatchMetricsOperations` holds no destroyable resource of its own;
  when constructed from `AWSClientProvider.cloudWatch`, it shares the
  underlying client's connection lifecycle and is cleared (not independently
  destroyed) by `provider.close()`.
- `core/polling` is used here under the same Zone A exception ADR-0026
  recorded for `aws/sqs` (`aws/**` may otherwise import only
  `core/errors`/`core/prompt`); this module does not widen that exception
  further, it just uses the edge already opened.

## See also

- [AWS Clients](./clients.md) — the raw `cloudWatch` client getter and
  `AWSClientProvider`/`AWSProvider` this module builds on; also reachable as
  `AWSServiceProvider.cloudWatchMetrics` (`script.aws.services.cloudWatchMetrics`).
- [CloudWatch Alarms](./cloudwatch-alarms.md) — the sibling wrapper over the
  same `cloudWatch` client, and the module that re-exports the shared
  `M3LCloudWatchDimension` type.
- [ADR-0027](../../adr/0027-aws-sdk-boundary-typed-wrappers.md) — the
  typed-wrapper-per-consumer-need decision this module implements.
- [Polling](../core/polling.md) — `M3LRetryRunner` / `M3LPollingPolicies` /
  the classifiers this module composes internally.
