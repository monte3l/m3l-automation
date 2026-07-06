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
- Poller event map + payloads: `M3LPollerEventMap`, `M3LPollAttemptPayload`, `M3LPollWaitPayload`, `M3LPollSuccessPayload`, `M3LPollExhaustedPayload`
- Retry event map + payloads: `M3LRetryEventMap`, `M3LRetryAttemptPayload`, `M3LRetryScheduledPayload`, `M3LRetrySuccessPayload`, `M3LRetryFatalPayload`, `M3LRetryExhaustedPayload`

Both `M3LPoller` and `M3LRetryRunner` extend `M3LEventEmitterBase`, so they inherit the public `on` / `off` subscription methods (see [Events](#events)).

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

## Events

`M3LPoller` and `M3LRetryRunner` both extend `M3LEventEmitterBase`, so a consumer
can subscribe to typed, **opt-in** telemetry without changing behavior. Emission
is observability only — it never influences whether a poll or retry succeeds,
and a subscriber is entirely optional (an instance with no handlers emits into
the void at negligible cost). Subscribe with the inherited `on(event, handler)`
and unsubscribe with `off(event, handler)`; see [`events`](./events.md) for the
emitter contract.

**Telemetry never alters outcomes.** Handler errors are isolated exactly as the
[`events`](./events.md) spec guarantees: one throwing handler does not stop the
others, is surfaced as a best-effort `process.stderr` diagnostic (never routed
through the library's log handlers, never re-thrown), and — critically — never
changes the value a `poll()`/`run()` call returns or the error it throws.

**Payloads are redaction-safe by construction.** Every payload carries only
attempt counts, delays (ms), and — for retry — the classifier's decision. **No
payload carries the raw error object or its message**, which could embed
caller-supplied data; the raw error still travels the throw path
(`M3LPollFailureError` / `M3LPollExhaustedError` from `poll()`, the original
error from `run()`), so a consumer that needs error detail catches it there.
Attempt numbers in payloads are **1-based** (`attempt` runs `1..maxAttempts`),
matching the `attempts` count carried in the exhaustion error context.

### `M3LPoller` events (`M3LPollerEventMap`)

| Event            | Emitted when                                                        | Payload                   |
| ---------------- | ------------------------------------------------------------------- | ------------------------- |
| `poll:attempt`   | Before each `check()` call                                          | `M3LPollAttemptPayload`   |
| `poll:wait`      | After a `continue` decision, before sleeping the next backoff delay | `M3LPollWaitPayload`      |
| `poll:success`   | The `check()` returns a `success` decision                          | `M3LPollSuccessPayload`   |
| `poll:exhausted` | All `maxAttempts` are used without a `success`                      | `M3LPollExhaustedPayload` |

```typescript
interface M3LPollAttemptPayload {
  readonly attempt: number; // 1-based
  readonly maxAttempts: number;
}
interface M3LPollWaitPayload {
  readonly attempt: number; // the attempt that just returned `continue`
  readonly delayMs: number; // backoff delay about to be slept
}
interface M3LPollSuccessPayload {
  readonly attempt: number; // the attempt that succeeded
}
interface M3LPollExhaustedPayload {
  readonly attempts: number; // total attempts made (= maxAttempts)
}
```

> A `failure` decision (which throws `M3LPollFailureError`) has **no** dedicated
> event — it surfaces through the thrown error, keeping the event surface to the
> poll/wait/success/exhausted lifecycle.
>
> On an exhausting poll the **final** attempt still emits `poll:wait` (with
> `attempt` = `maxAttempts`) immediately before `poll:exhausted`: the poller
> sleeps one last backoff after the last `continue` before giving up, and the
> event reports that sleep faithfully. Consumers should treat a `poll:wait` as
> "a backoff is being slept," not "another attempt is guaranteed to follow."

### `M3LRetryRunner` events (`M3LRetryEventMap`)

| Event             | Emitted when                                                           | Payload                    |
| ----------------- | ---------------------------------------------------------------------- | -------------------------- |
| `retry:attempt`   | Before each operation invocation                                       | `M3LRetryAttemptPayload`   |
| `retry:scheduled` | A retriable error schedules a delay before the next attempt            | `M3LRetryScheduledPayload` |
| `retry:success`   | The operation resolves (mirrors the poller's `poll:success`)           | `M3LRetrySuccessPayload`   |
| `retry:fatal`     | A fatal classification stops the runner (the original error is thrown) | `M3LRetryFatalPayload`     |
| `retry:exhausted` | A retriable error on the final attempt exhausts the retry budget       | `M3LRetryExhaustedPayload` |

```typescript
interface M3LRetryAttemptPayload {
  readonly attempt: number; // 1-based
  readonly maxAttempts: number;
}
interface M3LRetryScheduledPayload {
  readonly attempt: number; // the attempt that just failed
  readonly delayMs: number; // delay before the next attempt (server-driven advice.delayMs, else backoff)
  readonly classification: "retriable" | "unknown"; // raw advice on the scheduling path (see below)
}
interface M3LRetrySuccessPayload {
  readonly attempt: number; // the attempt that succeeded
}
interface M3LRetryFatalPayload {
  readonly attempt: number; // the attempt that failed fatally
  readonly classification: "fatal" | "unknown"; // raw advice on the fatal path (see below)
}
interface M3LRetryExhaustedPayload {
  readonly attempts: number; // total attempts made (= maxAttempts)
}
```

`classification` is the classifier's **raw** advice (a subset of
`M3LRetryDecision`), not the resolved action: a value of `"unknown"` means the
classifier deferred and the runner applied the configured `unknownDecision` to
reach the actual retry-or-stop choice. Each payload narrows to only the values
its path can reach — `retry:scheduled` carries `"retriable"` or `"unknown"`
(never `"fatal"`, which would have thrown), and `retry:fatal` carries `"fatal"`
or `"unknown"` (never `"retriable"`). `retry:success` fires when `run()`
resolves — the symmetric happy-path terminal to `poll:success`, so a consumer
can see from the event stream alone which attempt finally succeeded.

### Subscribing

```typescript
import { Core } from "@m3l-automation/m3l-common";

const runner = new Core.M3LRetryRunner({
  classifier: Core.awsThrottlingClassifier,
  backoff: Core.M3LBackoff.exponentialJittered(200, 5_000),
  unknownDecision: "fatal",
});

runner.on("retry:scheduled", ({ attempt, delayMs, classification }) => {
  console.debug(`retry ${attempt} in ${delayMs}ms (${classification})`);
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
