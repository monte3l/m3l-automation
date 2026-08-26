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
- Poller event map + payloads: `M3LPollerEventMap`, `M3LPollAttemptPayload`, `M3LPollWaitPayload`, `M3LPollSuccessPayload`, `M3LPollExhaustedPayload`, `M3LPollNoProgressPayload`
- Retry event map + payloads: `M3LRetryEventMap`, `M3LRetryAttemptPayload`, `M3LRetryScheduledPayload`, `M3LRetrySuccessPayload`, `M3LRetryFatalPayload`, `M3LRetryExhaustedPayload`, `M3LRetryNoProgressPayload`

The constructor option interfaces (`M3LPollerOptions`, `M3LRetryRunnerOptions`) and
the backoff-strategy contract are **deliberately not re-exported** — callers build
options with the `M3LBackoff`/`M3LPollingPolicies` factories and pass them
opaquely (`src/core/polling/index.ts`). They are named throughout this page to
describe the shape you pass, not as importable symbols. Note `check:doc-exports`
validates code → doc (every export is documented), not doc → code, so a page that
claims a non-existent export is not machine-caught.

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

### Cooperative cancellation

Both `M3LPollerOptions` and `M3LRetryRunnerOptions` accept an optional
`signal?: AbortSignal`. Passing one makes a long wait interruptible; omitting one
leaves behavior exactly as it was before the option existed.

```typescript
import { Core } from "@m3l-automation/m3l-common";

// `script.signal` aborts on the first SIGTERM/SIGINT/SIGQUIT.
const poller = new Core.M3LPoller({
  backoff: Core.M3LBackoff.exponentialJittered(500, 10_000),
  signal: script.signal,
});

// Rejects with `M3LOperationAbortedError` if the signal aborts mid-wait.
const job = await poller.poll(checkJob);
```

When the signal aborts, the wait rejects with
[`M3LOperationAbortedError`](./errors.md) (`ERR_OPERATION_ABORTED`, `origin:
"caller"`, `retryable: false`) as soon as the abort is observed. A pending
backoff delay is abandoned immediately rather than slept out, so cancellation
does not wait for the current delay to elapse.

`M3LRetryRunner` checks the signal **before** consulting its
`M3LRetryClassifier`. This is deliberate: a classifier that judged the abort
`"retriable"` would otherwise cause the runner to retry the very operation the
operator just cancelled. No classifier can observe or reclassify the abort — see
[ADR-0049](../../adr/0049-cooperative-cancellation-contract.md).

The signal is checked at attempt boundaries and while delaying. It does not
interrupt CPU-bound synchronous work inside a check function or operation.

### No-progress detection

An attempt ceiling bounds how _many_ times a loop runs, not whether it is getting
anywhere. A poll whose remote state never changes, or a paginated read handed the
same page token over and over, still burns every attempt in real remote calls
before failing. Both `M3LPollerOptions` and `M3LRetryRunnerOptions` therefore
accept an optional **progress witness** — a cheap comparable value the caller
samples once per continuing attempt — and fail fast once that value stops moving.

```typescript
readonly progress?: {
  readonly witness: () => string | number | bigint | boolean;
  readonly maxStalledAttempts: number;
};
```

`witness` must return a **primitive**. That is not an incidental restriction: an
object witness would compare unequal on every attempt (each call returns a fresh
reference), so the guard would silently never fire — precisely the failure this
option exists to catch. A caller whose real cursor is composite keys it into a
primitive itself, which also keeps the per-attempt cost `O(1)` and keeps the
library from traversing a caller-controlled mutable graph.

```typescript
import { Core } from "@m3l-automation/m3l-common";

let pageToken: string | undefined;

const poller = new Core.M3LPoller({
  backoff: Core.M3LBackoff.exponentialJittered(500, 10_000),
  maxAttempts: 60,
  progress: {
    witness: () => pageToken ?? "",
    maxStalledAttempts: 3,
  },
});
```

**Semantics.**

- The witness is sampled **once per attempt that is about to continue** — never
  on a `success` decision, never on a terminal `failure`, and never on the
  attempt that exhausts the ceiling.
- The first sample establishes a baseline. Each later sample equal to the
  previous one (compared with `Object.is`) increments a stall counter; any change
  resets it to `0`.
- When the counter reaches `maxStalledAttempts`, the call rejects with
  `M3LNoProgressError` ([`ERR_NO_PROGRESS`](./errors.md), `origin: "external"`,
  `retryable: false`), carrying `context.attempts` (1-based, the attempt that
  tripped the guard) and `context.stalledAttempts` (always equal to
  `maxStalledAttempts`).
- The rejection happens **before** the backoff delay is slept, so a stalled loop
  surfaces in seconds instead of after the full ceiling of remote calls.
- `maxStalledAttempts` must be a finite integer greater than 0; anything else is
  rejected at construction with `ERR_POLLING_INVALID_OPTION`, exactly as
  `maxAttempts` is.
- The stall counter lives in the `poll()` / `run()` call frame, so concurrent
  calls on one instance track progress independently — the same isolation the
  backoff progression already has.

**The counter counts unchanged _transitions_, not samples.** A baseline sample is
not itself a stalled attempt, so tripping takes `maxStalledAttempts + 1` witness
samples. Worked example with `maxStalledAttempts: 3` and a witness pinned to
`"a"`:

| Attempt | Sample | Counter | Outcome                      |
| ------- | ------ | ------- | ---------------------------- |
| 1       | `"a"`  | 0       | baseline, continue           |
| 2       | `"a"`  | 1       | continue                     |
| 3       | `"a"`  | 2       | continue                     |
| 4       | `"a"`  | 3       | **reject** `ERR_NO_PROGRESS` |

The rejecting call therefore made 4 attempts and reports
`{ attempts: 4, stalledAttempts: 3 }`. This assumes `maxAttempts >= 5`: the
witness is never sampled on the ceiling-exhausting attempt, so with
`maxAttempts: 4` attempt 4 _is_ the ceiling and the call exhausts instead — see
"Deliberately independent of the ceiling" below.

**Deliberately independent of the ceiling.** The no-progress check runs _after_
the exhaustion check in both primitives, so a run that would have exhausted still
exhausts with its existing error (`M3LPollExhaustedError` for the poller, the
original error for the runner). The witness can only ever shorten a run that was
going to keep going; it never changes what a ceiling-bound run does at its
ceiling, and it never converts an exhaustion into a different error.

**Precedence.** A cancelled operation reports cancellation and nothing else: the
signal is re-checked immediately before a no-progress rejection, so an abort
observed on a stalled attempt rejects with `M3LOperationAbortedError`, not
`M3LNoProgressError`. In `M3LRetryRunner` a fatal classifier verdict also wins —
the guard is consulted only on an attempt that would otherwise schedule a retry.

**Absent a `progress` option, behaviour is unchanged** — no witness is called, no
counter is kept, and both primitives make exactly the calls and throw exactly the
errors they did before the option existed.

> `Object.is` is the comparison, so a witness that returns `NaN` counts as
> unchanged against a previous `NaN` (the guard fires), while `0` and `-0` count
> as _changed_ (the counter resets). Both follow from `Object.is` and are the
> intended reading of "the same value". Note the practical consequence of the
> second: a numeric witness whose arithmetic can produce `-0` (any subtraction
> reaching zero) resets the counter against a previous `0` and defeats the
> guard — prefer a string or a monotonically-derived integer for such cursors.

**The witness is caller code, and the library treats it as untrusted.** It is
read **once** per sampled attempt and its result is used only for the `Object.is`
comparison — the sampled value never reaches an error message, an error
`context`, an event payload, or a run report. Two failure modes are handled
loudly rather than silently:

- **A witness that throws** is wrapped in `M3LPollingInvalidOptionError`
  (`ERR_POLLING_INVALID_OPTION`) with the thrown value as `cause`. In `run()`
  this matters especially: the witness is sampled inside the runner's `catch`,
  so an unwrapped throw would otherwise replace the operation's real error.
- **A witness that returns a non-primitive** (reachable when the witness is
  typed `any`, since a declared return type cannot be enforced at runtime) is
  rejected with `ERR_POLLING_INVALID_OPTION` instead of being compared. An
  object sample would compare unequal on every attempt, so the guard would
  silently never fire — a safety guard that disables itself on bad input is the
  exact failure this option exists to prevent.

`witness` and `maxStalledAttempts` are both captured into private fields at
construction, so mutating the options object after the constructor returns
cannot change how a later `poll()` / `run()` behaves.

**Not the same mechanism as pagination's own repeated-cursor guard.**
`aws/dynamodb`'s `queryItems`/`scanSegment` and `aws/s3`'s `listObjects`
also throw `ERR_NO_PROGRESS` when a page cursor repeats (see
[`aws/dynamodb`](../aws/dynamodb.md)/[`aws/s3`](../aws/s3.md)), but through a
separate, non-configurable internal guard — not this `progress` option applied
internally. It has no caller-supplied witness (the page cursor itself is
compared), no `maxStalledAttempts` (it trips on the first repeat), and its
`context.attempts` counts pages fetched, not poll/retry attempts. Absent a
`progress` option, `M3LPoller`/`M3LRetryRunner` behaviour is unchanged by
either mechanism — this note only prevents reading the two as one shared
implementation.

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
(`M3LPollFailureError` / `M3LPollExhaustedError` / `M3LNoProgressError` from
`poll()`, the original error from `run()` — or, when `run()`'s no-progress guard
trips, an `M3LNoProgressError` whose `cause` is the last operation error), so a consumer that needs error detail catches it there.
Attempt numbers in payloads are **1-based** (`attempt` runs `1..maxAttempts`),
matching the `attempts` count carried in the exhaustion error context.

**The thrown error does not carry attempt history — the events do.** On
exhaustion `M3LRetryRunner.run()` re-throws the _last_ error **unchanged**, for
every terminal path (fatal, unknown-resolved-fatal, exhausted): inspecting the
thrown error alone cannot distinguish "failed once, fatally" from "retried to
exhaustion". The distinction — and the full attempt history (counts, delays,
classifications) — is observable only through the event stream
(`retry:fatal` vs `retry:exhausted`). To retain it past the throw, subscribe a
collector: the [`M3LBreadcrumbTrail`](./diagnostics.md#m3lbreadcrumbtrail)
(ADR-0035) attaches to these exact events and carries the history into run
reports and `onError` context without changing any thrown shape. Similarly,
`M3LPollExhaustedError` carries `context.attempts` but `M3LPollFailureError`
today carries no context; ADR-0035 adds an optional, additive `context`
parameter to `M3LPollFailureError` so a terminal `failure` decision can carry
the attempt it occurred on.

### `M3LPoller` events (`M3LPollerEventMap`)

| Event              | Emitted when                                                                                                                                       | Payload                    |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `poll:attempt`     | Before each `check()` call                                                                                                                         | `M3LPollAttemptPayload`    |
| `poll:wait`        | After a non-final `continue` decision, before sleeping the backoff delay — unless the no-progress guard trips first, which throws before this emit | `M3LPollWaitPayload`       |
| `poll:success`     | The `check()` returns a `success` decision                                                                                                         | `M3LPollSuccessPayload`    |
| `poll:exhausted`   | All `maxAttempts` are used without a `success`                                                                                                     | `M3LPollExhaustedPayload`  |
| `poll:no-progress` | The progress witness stayed unchanged for `maxStalledAttempts` consecutive attempts                                                                | `M3LPollNoProgressPayload` |

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
interface M3LPollNoProgressPayload {
  readonly attempt: number; // 1-based, the stalled attempt that tripped the guard
  readonly stalledAttempts: number; // consecutive unchanged observations (= maxStalledAttempts)
}
```

> A `failure` decision (which throws `M3LPollFailureError`) has **no** dedicated
> event — it surfaces through the thrown error, keeping the event surface to the
> poll/wait/success/exhausted lifecycle.
>
> `poll:wait` fires only when another attempt will actually follow: on an
> exhausting poll the **final** `continue` does **not** sleep a backoff, so no
> `poll:wait` precedes `poll:exhausted`. The poller gives up immediately rather
> than wasting one last backoff interval before throwing `M3LPollExhaustedError`.
> So every `poll:wait` is reliably followed by another `poll:attempt`.

### `M3LRetryRunner` events (`M3LRetryEventMap`)

| Event               | Emitted when                                                                        | Payload                     |
| ------------------- | ----------------------------------------------------------------------------------- | --------------------------- |
| `retry:attempt`     | Before each operation invocation                                                    | `M3LRetryAttemptPayload`    |
| `retry:scheduled`   | A retriable error schedules a delay before the next attempt                         | `M3LRetryScheduledPayload`  |
| `retry:success`     | The operation resolves (mirrors the poller's `poll:success`)                        | `M3LRetrySuccessPayload`    |
| `retry:fatal`       | A fatal classification stops the runner (the original error is thrown)              | `M3LRetryFatalPayload`      |
| `retry:exhausted`   | A retriable error on the final attempt exhausts the retry budget                    | `M3LRetryExhaustedPayload`  |
| `retry:no-progress` | The progress witness stayed unchanged for `maxStalledAttempts` consecutive attempts | `M3LRetryNoProgressPayload` |

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
interface M3LRetryNoProgressPayload {
  readonly attempt: number; // 1-based, the stalled attempt that tripped the guard
  readonly stalledAttempts: number; // consecutive unchanged observations (= maxStalledAttempts)
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
- `httpRetryAfterClassifier` — maps `408`/`429`/transient 5xx (500/502/503/504) to `'retriable'`, recognisable non-retriable 4xx (400/401/403/404) to `'fatal'`, and respects `retryAfterMs` for server-driven delays.

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
- An `AbortSignal` passed as `signal` is checked at attempt boundaries and during backoff delays; an abort rejects with `M3LOperationAbortedError` and is never routed through the classifier.

## See also

- [network](./network.md)
- [errors](./errors.md)
- [diagnostics](./diagnostics.md) — breadcrumb trail over these events
- [utils](./utils.md)
- [Capability index](../../guides/capability-index.md)
- [Architecture overview](../../m3l-common-architecture.md)
