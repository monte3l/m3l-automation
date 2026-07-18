# EventBridge Operations

`M3LEventBridgeOperations` is a typed wrapper over a raw `EventBridgeClient`,
so callers never import `@aws-sdk/client-eventbridge` command classes
directly. Built for `scripts/eventbridge-schedules`'s need to avoid a direct
SDK import (ADR-0027/ADR-0029's per-consumer-need wrapper pattern — the same
gap `aws/sqs` and `aws/cloudwatch-logs-insights` closed for their consumers).

## Overview

Every AWS client getter on `AWSClientProvider` exposes a raw AWS SDK v3
client — see [AWS Clients](./clients.md). `M3LEventBridgeOperations` wraps
one of those raw clients (`eventBridge`), translating SDK request/response
shapes into plain, library-owned types so a caller never touches an
`@aws-sdk/client-eventbridge` type.

- `M3LEventBridgeOperations` — the wrapper class, constructed from a raw `EventBridgeClient`.
- `M3LEventBridgeOperationError` — thrown on a request-level EventBridge failure.
- Plain types: `M3LEventBridgeRule`, `M3LEventBridgeRuleDetail`,
  `M3LEventBridgeRuleState`, `M3LEventBridgeTarget`,
  `M3LEventBridgeEventBusOptions`, `M3LEventBridgeListRulesOptions`,
  `M3LEventBridgeListRulesResult`, `M3LEventBridgePutRuleInput`,
  `M3LEventBridgePutRuleResult`, `M3LEventBridgeDeleteRuleOptions`,
  `M3LEventBridgeListTargetsOptions`, `M3LEventBridgeListTargetsResult`,
  `M3LEventBridgePutTargetsFailure`, `M3LEventBridgePutTargetsResult`,
  `M3LEventBridgeRemoveTargetsOptions`, `M3LEventBridgeRemoveTargetsFailure`,
  `M3LEventBridgeRemoveTargetsResult`.

## Scope

**In scope:** EventBridge **rules** — the `PutRule`/`ListRules`/`DescribeRule`/
`DeleteRule`/`EnableRule`/`DisableRule` family plus target wiring
(`PutTargets`/`ListTargetsByRule`/`RemoveTargets`), with targets scoped to
their common fields (`id`/`arn`/`roleArn`/`input`/`inputPath`).

**Out of scope for this iteration:**

- The separate **EventBridge Scheduler** service (`@aws-sdk/client-scheduler`)
  — flexible one-off/timezone schedules. Tracked in `docs/ROADMAP.md` as its
  own gated item; not part of this wrapper.
- Per-service target parameter blocks: Kinesis, ECS, Batch, SQS-FIFO,
  HTTP/API-destination, Redshift Data API, SageMaker pipeline, dead-letter
  config, retry policy, AppSync, input transformer, run-command. Add the
  corresponding field to `M3LEventBridgeTarget` when a consumer needs one
  (ADR-0027's per-consumer-need pattern) — not silently dropped, just
  deferred.
- Event bus management (`CreateEventBus`/`DeleteEventBus`/`ListEventBuses`),
  archives, replays, and API destinations/connections.

## Public API

### `M3LEventBridgeOperations`

**Constructor** — `new M3LEventBridgeOperations(client)`, where `client` is a
raw `EventBridgeClient` (e.g. `script.aws.clients.eventBridge`, or the cached
`script.aws.clients.eventBridgeOperations` convenience getter which
constructs one for you, sharing the underlying `eventBridge` client's
lifecycle).

| Method                                         | Retried? | Returns                                      | Throws                         |
| ---------------------------------------------- | -------- | -------------------------------------------- | ------------------------------ |
| `listRules(options?)`                          | Yes      | `Promise<M3LEventBridgeListRulesResult>`     | `M3LEventBridgeOperationError` |
| `describeRule(name, options?)`                 | Yes      | `Promise<M3LEventBridgeRuleDetail>`          | `M3LEventBridgeOperationError` |
| `putRule(input)`                               | Yes      | `Promise<M3LEventBridgePutRuleResult>`       | `M3LEventBridgeOperationError` |
| `deleteRule(name, options?)`                   | Yes      | `Promise<void>`                              | `M3LEventBridgeOperationError` |
| `enableRule(name, options?)`                   | Yes      | `Promise<void>`                              | `M3LEventBridgeOperationError` |
| `disableRule(name, options?)`                  | Yes      | `Promise<void>`                              | `M3LEventBridgeOperationError` |
| `listTargetsByRule(ruleName, options?)`        | Yes      | `Promise<M3LEventBridgeListTargetsResult>`   | `M3LEventBridgeOperationError` |
| `putTargets(ruleName, targets, options?)`      | Yes      | `Promise<M3LEventBridgePutTargetsResult>`    | `M3LEventBridgeOperationError` |
| `removeTargets(ruleName, targetIds, options?)` | Yes      | `Promise<M3LEventBridgeRemoveTargetsResult>` | `M3LEventBridgeOperationError` |

**Retry:** every method wraps its SDK `.send()` call in `M3LRetryRunner`
configured by `M3LPollingPolicies.awsThrottling()` (throttling/network
classifiers, exponential-jittered backoff 200ms→5s), mirroring
`M3LLogsInsightsClient`'s uniform retry of both read and mutating calls. A
per-entry failure inside a _successful_ `putTargets`/`removeTargets`
response is never retried — it is returned via the result's `failed` list,
joined back to the caller's original input entry.

**Batch limits:** `putTargets`/`removeTargets` accept at most 10 entries per
call (the EventBridge API cap) with unique `id`s; a violation throws
`M3LEventBridgeOperationError` before any AWS call is made.

**One-shot `listRules`/`listTargetsByRule`, no drain loop:** each exposes a
single request, not a draining generator. Looping on `nextToken` until
exhausted is a caller/script decision, kept out of the library so it stays a
reusable primitive rather than encoding one consumer's pagination policy —
mirrors `M3LSQSOperations.receive`.

### `M3LEventBridgeOperationError`

Subclass of `M3LError` with `code: "ERR_EVENTBRIDGE_OPERATION"`. Thrown when
a request-level EventBridge operation fails: a whole request rejects after
retries, or a pre-flight guard (batch size, duplicate target ids) fails
before any AWS call. The originating SDK error is chained via `cause`.
Per-entry `putTargets`/`removeTargets` failures are **not** represented by
this error — see the respective result's `failed` list.

### Plain types

- **`M3LEventBridgeRule`** — `{ name, arn, eventPattern?, scheduleExpression?,
state?, description?, roleArn?, managedBy?, eventBusName? }`. `name`/`arn`
  default to `""` if the SDK response omits them.
- **`M3LEventBridgeRuleDetail`** — `M3LEventBridgeRule` + `createdBy?`
  (the `describeRule` result).
- **`M3LEventBridgeRuleState`** — `"DISABLED" | "ENABLED" |
"ENABLED_WITH_ALL_CLOUDTRAIL_MANAGEMENT_EVENTS"`.
- **`M3LEventBridgeTarget`** — `{ id, arn, roleArn?, input?, inputPath? }`.
  `id` must be unique within a `putTargets`/`removeTargets` batch.
- **`M3LEventBridgePutRuleInput`** — `{ name, eventPattern?,
scheduleExpression?, state?, description?, roleArn?, eventBusName? }`.
  Provide exactly one of `eventPattern`/`scheduleExpression` — EventBridge
  itself enforces this; the wrapper does not pre-validate it.
- **`M3LEventBridgePutRuleResult`** — `{ ruleArn }`; defaults to `""` if the
  SDK response omits it.
- **`M3LEventBridgePutTargetsFailure`** / **`M3LEventBridgeRemoveTargetsFailure`**
  — `{ target: M3LEventBridgeTarget, code, message? }` /
  `{ targetId, code, message? }`; the original input entry, so a failure can
  be logged or re-driven with no id bookkeeping of its own.
- **`M3LEventBridgePutTargetsResult`** / **`M3LEventBridgeRemoveTargetsResult`**
  — `{ successful, failed }`. Every input entry lands in exactly one of the
  two.

## Usage

### From within a script

```typescript
// script.aws.clients.eventBridgeOperations is the cached convenience getter
const eventBridgeOperations = script.aws.clients.eventBridgeOperations;

const { rules } = await eventBridgeOperations.listRules({
  namePrefix: "nightly-",
});

const { ruleArn } = await eventBridgeOperations.putRule({
  name: "nightly-report",
  scheduleExpression: "rate(1 day)",
});

const result = await eventBridgeOperations.putTargets("nightly-report", [
  { id: "0", arn: "arn:aws:lambda:eu-south-1:123456789012:function:report" },
]);
// result.failed[].target is the original M3LEventBridgeTarget, ready to write
// straight to a failed.jsonl file with no extra bookkeeping.
```

### Standalone construction

```typescript
import { AWS } from "@m3l-automation/m3l-common";

const provider = new AWS.AWSClientProvider({
  profile: AWS.parseAWSProfile("my-profile"),
});
const eventBridgeOperations = new AWS.M3LEventBridgeOperations(
  provider.eventBridge,
);
```

## Notes and behavior

- No `@aws-sdk/client-eventbridge` type ever appears in this module's public
  surface — every request/response shape is translated to a plain type in
  `aws/eventbridge/types.ts` at the boundary.
- `M3LEventBridgeOperations` holds no destroyable resource of its own; when
  accessed via `AWSClientProvider.eventBridgeOperations`, it shares the
  underlying `eventBridge` client's connection lifecycle and is cleared (not
  independently destroyed) by `provider.close()`.
- `core/polling` is used here under the same Zone A exception ADR-0026
  recorded for `aws/sqs` (`aws/**` may otherwise import only
  `core/errors`/`core/prompt`); this module does not widen that exception
  further, it just uses the edge already opened.

## See also

- [AWS Clients](./clients.md) — the raw `eventBridge` client getter and
  `AWSClientProvider`/`AWSProvider` this module builds on.
- [SQS Operations](./sqs.md) — the sibling wrapper this module's shape mirrors,
  and [ADR-0026](../../adr/0026-sqs-operations-wrapper.md) for the pattern's
  origin.
- [ADR-0027](../../adr/0027-aws-sdk-boundary-typed-wrappers.md) — the
  typed-wrapper-per-consumer-need decision this module implements.
- [Polling](../core/polling.md) — `M3LRetryRunner` / `M3LPollingPolicies` /
  the classifiers this module composes internally.
- `docs/ROADMAP.md` W3 — `scripts/eventbridge-schedules`, this module's
  consumer.
