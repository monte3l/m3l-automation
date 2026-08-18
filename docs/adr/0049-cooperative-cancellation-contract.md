# 0049. A cooperative cancellation contract for long-running operations

- **Status:** Accepted
- **Date:** 2026-08-18
- **Deciders:** Enrico Lionello (maintainer); Claude (audit synthesis)

## Context and problem statement

An audit of the library's long-running surface found that **a shutdown signal
cannot stop work that is already in flight**. The process is abandoned; the
operation it was performing continues until the runtime exits underneath it.

**Evidence from the current tree.**

- `M3LScript` registers `SIGTERM` / `SIGINT` / `SIGQUIT` handlers and runs cleanup
  on the first signal (`M3LScript.ts:415`, delegating to
  `runCleanup("signal-shutdown")`). Nothing that cleanup can reach is able to tell
  the running work to stop.
- `AbortSignal` appears in exactly one place in the library:
  `core/network/M3LHttpClient`. There are **zero** references to it anywhere under
  `packages/m3l-common/src/aws/**`, `core/polling/**`, or `core/script/**`.
- The blocking surface is large and growing: eight `waitUntil*` waiters across ECS,
  CloudFormation and EKS, a CodePipeline execution watch, and query polling in
  Athena and CloudWatch Logs Insights. **Ten `aws/*` submodules** already build on
  `M3LPoller` / `M3LRetryRunner`, and none of them can be interrupted.
- The design already concedes the problem: `runScript()` maps a **second** shutdown
  signal to a distinct exit code, which is only necessary because the first one
  does not stop anything.
- `M3LRunOutcome` already declares an `interrupted` arm — today it is reachable
  only on a best-effort basis, because nothing observes a cancellation.

The practical failure is a several-minute AWS waiter that keeps polling after the
operator has pressed Ctrl-C, while the run report is written describing a run that
has not actually stopped.

## Decision drivers

- **Honest reporting.** ADR-0035 made the run report the record of what happened;
  a report that claims a run ended while it is still polling undermines that.
- **No new runtime dependency.** `AbortController` / `AbortSignal` are platform
  globals on the Node 24 floor (ADR-0003).
- **Additive only.** Ten AWS submodules and two polling primitives are in scope;
  none may change behaviour for callers that do not opt in.
- **Never swallow an error, never mis-classify one** — the error hierarchy's
  `origin` / `retryable` classification (ADR-0035 §2.1) has to stay truthful.
- **Layering is not negotiable.** No ESLint zone may be widened to make this
  compile.

## Considered options

1. **Status quo** — rely on process death. Rejected: it leaves in-flight AWS calls
   running, produces a report describing a run that has not stopped, and makes the
   `interrupted` outcome effectively unreachable.
2. **A library-owned global cancellation registry.** Rejected: ambient global state
   is invisible at the call site, untestable without leaking between tests, and
   contradicts the dependency-injection posture the rest of the library follows.
3. **Thread an optional `AbortSignal` from the script lifecycle to the calls that
   actually block.** Chosen — it is the platform's own idiom, already used by
   `M3LHttpClient` and supported natively by the AWS SDK's per-command
   `abortSignal`.
4. **Add a full deadline-budget and heartbeat coordinator.** Rejected as premature:
   deadline budgeting is only meaningful under an unattended execution model this
   repo does not currently have. `AbortSignal` is its prerequisite regardless, so
   nothing is foreclosed.

## Decision

We chose **option 3**, with the following contract.

### Propagation path

`M3LScript` owns an `AbortController`. On the **first** shutdown signal it aborts
that controller alongside the existing `runCleanup("signal-shutdown")` call, and it
exposes the signal to the running work through a getter — mirroring the accessor
shape already used for the paths seam. From there:

- `core/polling` — `M3LPollerOptions` and `M3LRetryRunnerOptions` accept an
  optional `signal`. The runner checks it between attempts and abandons any pending
  delay immediately rather than sleeping out the backoff.
- `aws/**` — the waiter and poller option bags accept an optional `signal` and
  forward it to the AWS SDK's per-command `abortSignal`, so the in-flight request
  is cancelled rather than merely ignored.
- Absent a signal, every one of these paths behaves exactly as it does today.

### Classification contract

An aborted wait rejects with an `M3LError` carrying a dedicated abort code, with
`origin` `caller` and **`retryable: false`**.

This is load-bearing. `M3LRetryRunner` classifies failures and retries the ones it
judges retriable; if an abort were classified as retriable, cancelling a run would
cause it to retry the operation the operator just cancelled. No classifier may
reclassify the abort code, and the catalog entry records it as terminal.

### Outcome mapping

A run terminated by cancellation resolves to the existing `interrupted`
`M3LRunOutcome` rather than `failure`. Cancellation is an operator decision, not a
fault, and the report must not present it as one. The existing exit-code mapping
for a second shutdown signal is unchanged.

### Layering constraint

The `aws/**` island zone already admits `core/polling`, so this requires **no zone
widening**; `bin/check-eslint-zones.mjs` checks the island's permitted set exactly.
If any part of the implementation appears to require widening a zone, that is a
signal the design is wrong, not that the zone is — `pnpm check:zones` is the gate.

### Deliberately out of scope

- **Deadline budgets and heartbeats** — see option 4; gated on an unattended
  execution model.
- **Cancelling non-blocking work.** The signal is checked at operation and step
  boundaries; it does not interrupt CPU-bound synchronous code.
- **Guaranteed remote-side cancellation.** Aborting a request stops the client
  waiting; it does not undo work the AWS service has already begun.

## Consequences

- **Positive:** Ctrl-C and `SIGTERM` become cooperative — in-flight waits stop, the
  existing `interrupted` outcome becomes genuinely reachable, and the run report
  tells the truth about how a run ended; a container or CI runner reclaiming a
  process gets a clean stop instead of a truncated one; and the prerequisite for
  any future deadline budgeting is in place.
- **Negative / trade-offs:** the benefit is opt-in per call site, so it arrives
  progressively as the AWS wrappers and scripts thread the signal through; and a
  new terminal error code enters the catalog, which every classifier must leave
  alone.
- **Semver impact:** **additive minor.** Optional fields on existing options
  interfaces, one new accessor, one new error code; the `exports` map is untouched.

## Update (2026-08-18) — two corrections found while implementing

Implementing this ADR disproved two of its factual claims about the tree. Both
are recorded here rather than edited away, so the decision record shows what was
believed at the time and what turned out to be true.

**1. There is no CodePipeline waiter to thread a signal through.** The Decision's
propagation path names "`M3LCodePipelineOperations`' execution watch" as an
`aws/**` call site. No such method exists: `aws/codepipeline/client.ts:7`
states outright that CodePipeline ships no package-level waiter, and the whole
directory contains zero `M3LPoller`/`M3LRetryRunner` references. The execution
watch is a **consumer-script** composition at
`scripts/codepipeline-ops/src/steps/watch-execution.ts:120`. It inherits the
capability for free once `M3LPollerOptions.signal` exists, because it already
passes a caller-supplied options bag — but it is not wired by the library
change. The `aws/**` surface is therefore **8 waiters + 2 query polls**, not
"8 waiters + a CodePipeline watch + 2 query polls".

**2. An aborted wait had nowhere to reject from without a decision.** The
Classification contract says an aborted wait "rejects with an `M3LError`". All
three waiter families instead **resolved** `{ state: "ABORTED", reason }` as
data, with a documented rationale (a caller wants to distinguish "still not
ready" from "the SDK call failed"). The conflict was invisible because nothing
in `aws/**` passed an `abortSignal`, making `"ABORTED"` unreachable —
`docs/reference/aws/cloudformation.md` had even recorded the arm as "unreachable
in this v1 … for forward-compatibility". Resolved in favour of rejecting, since
resolving would mean `runScript` never observes the abort and the `interrupted`
outcome stays unreachable, defeating the Outcome mapping section above. The
`"ABORTED"` member is retained in all three exported unions, reachable only when
an `AbortError` arrives with no _aborted_ caller signal — a signal that was
supplied but has not fired still takes the resolving path. Removing it would be a
breaking change and is deferred to the next major.

**A consequence for sequencing.** Because no consumer call site is wired, A1
lands as a library PR plus a follow-up fleet retrofit, following the two-PR
chain the implementation plan already prescribes for A2/A4/A5. The ADR's
end-to-end verification ("`SIGINT` during a waiter yields `interrupted` in
`run-report.json`") is met by a library-level integration test rather than by a
retrofitted script.

**A latent leak this made reachable.** `aws/ecs` and `aws/cloudformation` built
their waiter `reason` from the raw SDK error message. `@smithy/core`'s
`checkExceptions` constructs that message by serializing the entire waiter
result, so it can embed the last observed response — including caller-supplied
CloudFormation parameter and output values. `aws/eks` had already been hardened
against exactly this; the other two had not, and their `ABORTED` arm was
unreachable only until a signal was threaded. Both arms were sanitized in the
same change set. The abort error accepts no `cause` parameter at all, so the SDK
payload cannot enter the error chain by any route.

## Links

- Related: [ADR-0035 (fault-origin classification, exit codes, the run report and
  its `interrupted` outcome)](./0035-failure-reporting-and-diagnostics.md),
  [ADR-0003 (the Node runtime floor providing `AbortController`)](./0003-node-24-floor.md),
  [ADR-0009 (the dependency-direction guard this must not widen)](./0009-dependency-direction-guard.md),
  [ADR-0046 (the procedure engine whose context carries this signal)](./0046-codified-procedure-engine.md).
- Capability reference: [`core/polling`](../reference/core/polling.md),
  [`core/script`](../reference/core/script.md),
  [`core/diagnostics`](../reference/core/diagnostics.md).
- Implementation plan: `docs/plans/2026-08-18-codified-procedure-engine.md`.
