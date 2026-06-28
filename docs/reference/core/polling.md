# Core: `polling`

Two orthogonal primitives for resilient automation — `M3LPoller` for waiting on external state, and `M3LRetryRunner` for re-executing a failing operation — plus composable error classifiers, backoff strategies, and pre-baked policies.

## Overview

The `polling` module separates two concerns that are often conflated. `M3LPoller` repeatedly checks external state until it reaches a terminal condition (for example, waiting for an async job to finish). `M3LRetryRunner` re-runs the same operation until it succeeds or retries are exhausted, deciding what to do with each thrown error through a `M3LRetryClassifier`. Both keep their backoff and attempt state per call, so concurrent calls on a shared instance are isolated. `M3LBackoff` supplies the delay strategies, and `M3LPollingPolicies` bundles tuned parameters for common AWS and HTTP use cases.

## Public API

Exported from `@m3l-automation/m3l-common/core` (and the `Core` namespace):

- Primitives: `M3LPoller`, `M3LRetryRunner`, `M3LBackoff`, `M3LPollingPolicies`
- Poller types: `M3LPollCheckFn`, `M3LPollDecision`
- Retry types: `M3LRetryClassifier`, `M3LRetryDecision`, `M3LRetryAdvice`
- Classifier composition: `combineClassifiers`
- Built-in classifiers: `awsThrottlingClassifier`, `awsNetworkClassifier`, `httpRetryAfterClassifier`

## `M3LPoller` vs. `M3LRetryRunner`

These are two separate, orthogonal primitives:

|                 | `M3LPoller`                                                                   | `M3LRetryRunner`                                          |
| --------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------- |
| **Purpose**     | Poll external state until a terminal condition                                | Re-execute the same operation until success or exhaustion |
| **Check / op**  | A `M3LPollCheckFn` returning `{ type: 'success' \| 'failure' \| 'continue' }` | An operation that throws on failure                       |
| **Decision**    | The check function's `M3LPollDecision`                                        | A `M3LRetryClassifier` decides retriable vs. fatal        |
| **Typical use** | Waiting for an async job to complete                                          | Retrying transient network/throttling errors              |

They compose naturally: an Athena query submission can use `M3LRetryRunner` for the submit call and `M3LPoller` to wait for the query to reach a terminal state.

### Per-call backoff isolation

`M3LPoller.poll<T>(check)` stores its backoff and attempt state inside the `poll()` call frame, not on the instance. The same holds for `M3LRetryRunner.run()`. Two concurrent callers sharing one instance therefore do not interfere with each other's backoff progression.

### Polling external state

```typescript
import { Core } from "@m3l-automation/m3l-common";

const poller = new Core.M3LPoller({
  backoff: Core.M3LBackoff.exponentialJittered(500, 10_000),
});

const result = await poller.poll(async () => {
  const job = await getJobStatus(jobId);
  if (job.state === "SUCCEEDED") return { type: "success", value: job };
  if (job.state === "FAILED") return { type: "failure" };
  return { type: "continue" };
});
```

The check function returns a `M3LPollDecision`: `success` (with the resolved value), `failure` (terminal failure), or `continue` (poll again after the next backoff delay).

### Retrying a failing operation

```typescript
import { Core } from "@m3l-automation/m3l-common";

const runner = new Core.M3LRetryRunner({
  classifier: Core.awsThrottlingClassifier,
  backoff: Core.M3LBackoff.exponentialJittered(200, 5_000),
  unknownDecision: "fatal",
});

const data = await runner.run(async () => callThrottledApi());
```

## Classifiers

A `M3LRetryClassifier` is a pure function that inspects a thrown error and returns a `M3LRetryDecision`:

- `'retriable'` — retry after backoff.
- `'fatal'` — stop and propagate the error.
- `'unknown'` — this classifier has no opinion.

How `'unknown'` is resolved is controlled by the `unknownDecision` option on `M3LRetryRunner`, which defaults to `'fatal'`. A classifier may also return a `M3LRetryAdvice` carrying a `delayMs` override, letting the server drive the back-off (for example honoring a `Retry-After` header).

### Composing classifiers

`combineClassifiers()` merges several classifiers into one. They are consulted in order and the first non-`'unknown'` decision wins. Because each built-in classifier returns `'unknown'` for everything outside its narrow concern, they combine without overlap:

```typescript
import { Core } from "@m3l-automation/m3l-common";

const classifier = Core.combineClassifiers(
  Core.awsThrottlingClassifier,
  Core.awsNetworkClassifier,
  Core.httpRetryAfterClassifier,
);

const runner = new Core.M3LRetryRunner({ classifier });
```

### Built-in classifiers

- `awsThrottlingClassifier` — detects AWS throttling/rate-limit error names plus transient 5xx codes.
- `awsNetworkClassifier` — detects network-level transient errors.
- `httpRetryAfterClassifier` — maps HTTP status codes to retry decisions and respects `retryAfterMs` for server-driven delays.

## Backoff strategies

`M3LBackoff` provides the delay schedules consumed by both primitives:

- `M3LBackoff.exponential(startMs, capMs)` — exponential growth capped at `capMs`.
- `M3LBackoff.exponentialJittered(startMs, capMs)` — exponential with decorrelated jitter (preferred under contention, since it spreads retries).
- `M3LBackoff.constant(delayMs)` — a fixed delay between attempts.

## Pre-baked policies

`M3LPollingPolicies` bundles polling/retry parameters tuned for concrete use cases, so callers do not hand-tune backoff for common scenarios:

- `athenaQuery()`
- `cloudWatchLogsQuery()`
- `awsThrottling()`
- `httpDownload()`
- `sqsBatchSend()`

```typescript
import { Core } from "@m3l-automation/m3l-common";

const runner = new Core.M3LRetryRunner(Core.M3LPollingPolicies.awsThrottling());
```

## Notes and behavior

- Choose `M3LPoller` when you are checking a value that changes externally; choose `M3LRetryRunner` when the same call may fail transiently and should be re-attempted.
- A `delayMs` override from a classifier (via `M3LRetryAdvice`) takes precedence over the configured backoff for that attempt.
- Prefer `exponentialJittered` over `exponential` when many clients may retry simultaneously.

## See also

- [network](./network.md)
- [errors](./errors.md)
- [utils](./utils.md)
- [Capability index](../../guides/capability-index.md)
- [Architecture overview](../../m3l-common-architecture.md)
