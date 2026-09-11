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

## Update (2026-09-11) — a force-kill backstop under the cooperative contract

This ADR's §"Deliberately out of scope" lists **"Cancelling non-blocking
work"**: the signal is checked at operation and step boundaries and does not
interrupt work that never looks at it. That framing stays correct for
in-process callers, but it left one composition where the signal is not merely
unchecked — it is unreachable, and a caller who did everything this ADR asks
still could not stop the work.

**The composition.** `scripts/agent-operator` spawns the `m3l` CLI, and
`m3l flow run` spawns each flow step as its own grandchild
(`packages/m3l-cli/src/run/spawn.ts`). Only the first hop was cooperative.
`scripts/agent-operator/src/lib/cli-process.ts`'s `killWithEscalation`
signalled the direct child, and `packages/m3l-cli/src/run/cancellation.ts`'s
survival scope answers a first signal by aborting an `AbortSignal` and
deliberately staying alive to finish teardown. The follow-up `SIGKILL` five
seconds later did kill `m3l` — but a `SIGKILL` addressed to one pid does not
propagate, so the step process kept running. An expired `flowTimeoutMs`
therefore rejected the caller while an AWS-mutating step ran to completion
unobserved, with no envelope and — by `lib/cli-surface.ts`'s deliberate
omission of `--resume` — no recovery path back.

**The decision.** The maintainer's call is a **force-kill backstop on that one
spawn path**, not a widening of the cooperative contract. `cli-process.ts` now
carries a `CliTeardownScope` of `"child"` (the default, today's behaviour
byte-for-byte) or `"group"`. `"group"` spawns `detached`, so the child becomes
its own process-group leader, and both the `SIGTERM` and the escalated
`SIGKILL` are addressed to the negated pid, reaching every member of the group
— `m3l` and the step it spawned. The scope is opted into per method by
`lib/cli-surface.ts`'s `CliInvocationSpec`, where it is a **required** field
with seven construction sites; `runFlowRun`'s is the only `"group"`. The other
six methods keep child-only signalling, because none of them spawns a
grandchild.

Three qualifications the maintainer accepted explicitly:

1. **The run stays INDETERMINATE.** Teardown bounds the blast radius; it does
   not undo a partial mutation or produce an envelope.
   `scripts/agent-operator/src/steps/build-flow-tools.ts` keeps recording the
   run indeterminate and escalating — that classification was already the
   truth and remains it. What changes is only that an operator reconciling by
   hand is now reconciling a _stopped_ flow.

2. **The Ctrl-C path this ADR maps to exit 5 gets MORE deterministic, not
   less** — the opposite of what "detached breaks Ctrl-C" suggests. Today
   agent-operator and `m3l` share the terminal's foreground process group, so
   one `SIGINT` races two settle paths inside `runCliProcess`: the `"aborted"`
   disposition (which `lib/cli-surface.ts` re-raises as
   `Core.M3LOperationAbortedError`, exit 5 per ADR-0035's table) against the
   child's own `"close"` from that same signal, which settles `"signalled"` —
   a spawn error, never exit 5. Spawned `detached`, the flow tree receives
   nothing from the tty, so the abort listener wins unconditionally.

3. **One narrow regression, unfixable.** A hard `SIGKILL` of agent-operator
   itself now leaves a detached group nobody reaps, where the shared group
   previously meant a Ctrl-C reached the whole tree. `cli-process.ts`'s
   `trackDetachedGroup` installs a best-effort `process.on("exit")` reaper
   that covers every softer exit path — including a double-Ctrl-C, because the
   second signal in
   `packages/m3l-common/src/internal/script/signalHandlers.ts` is a JS
   `process.exit()`, which still runs `"exit"` listeners — but nothing can
   cover a `SIGKILL` of the reaper's own process. Recovery there is
   `kill -- -<pgid>`. Group teardown is also **POSIX-only**: no
   `process.platform` branch was added (this tree has none in any `src`), and
   on Windows the negative-pid call fails into the errno diagnostic, leaving
   Windows with exactly today's child-only semantics.

**What the cooperative half still owes.** `m3l` does not thread its own
cancellation-scope signal into `packages/m3l-cli/src/flow/step.ts`, and
`M3LCliFlowStepOptions` declares no per-step timeout, so on the group
`SIGTERM` an in-process step does not wind down cooperatively — only the
`SIGKILL` stops it. That is a quality gap, not a correctness one, and it is
tracked as its own row rather than folded in here: the kernel delivers a group
signal without passing through `m3l`'s code, so no `packages/m3l-cli` change
was needed for this backstop to work. Two things that _would_ silently un-fix
it, worth naming: adding `detached` to `m3l`'s own step spawn, or introducing
a new process group anywhere under `m3l flow run` — either removes the step
from the group this backstop addresses.

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
