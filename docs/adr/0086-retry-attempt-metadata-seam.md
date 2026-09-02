# 0086. Per-attempt retry metadata leaves `core/polling` by a sibling detailed method

- **Status:** Accepted
- **Date:** 2026-09-02
- **Deciders:** repo maintainer

## Context and problem statement

Tracker row **U11 — retry/resume/cancellation surfacing**
([`IMPLEMENTATION.md`](../plans/IMPLEMENTATION.md), issue #535) asks for
"retry/outcome visibility in `history`/run-report rendering" and notes that
"a missing library seam gets its own decision (possible minor)". This ADR
settles that seam.

The gap is narrow and entirely about **discarding data the library already
computes**. `core/polling/events.ts` carries every field a renderer needs —
`attempt` and `maxAttempts` (`events.ts:28-32`), the resolved backoff
`delayMs` (`events.ts:50-53`), the classifier's raw `classification`
(`events.ts:182-193`), and the final exhausted `attempts` count
(`events.ts:252-254`). But both primary entry points throw it away:
`M3LPoller.poll<T>()` returns `Promise<T>` (`M3LPoller.ts:180`) and
`M3LRetryRunner.run<T>()` returns `Promise<T>` (`M3LRetryRunner.ts:351`). The
only way to observe any of it is to subscribe — `on()` is public while `emit`
is `protected` (`M3LEventEmitterBase.ts:75,120`) — which requires holding the
instance _before_ the call.

A run report is assembled _after_ the fact, and on the CLI's primary path by a
**different process**: `report-lookup` scans for the child's run directory and
reads `run-report.json` once the child has already exited
(`packages/m3l-cli/src/run/report-lookup.ts:1-23`). No subscription can reach
across that boundary. So the seam has two halves — how the data leaves
`core/polling`, and how it reaches a persisted artifact — and the second half
is the constrained one.

Three constraints bound the transport half:

- **`core/diagnostics/run-report.ts` is frozen at its budget baseline.** It
  measures 65,630 bytes and `bin/file-budget-baseline.json` records exactly
  65,630 — `check:file-budget` is a ratchet, so the file cannot grow one byte.
  A new report field is therefore not free; it must be paid for by extracting
  something out of that file first.
- **The CLI's read discipline is allowlisted scalars.** `report-lookup`
  "projects its `run-report.json` to an allowlisted scalar summary"
  (`report-lookup.ts:1-5`), and the envelope only ever _counts_ timeline
  entries — `timelineCount`, `timelineSourceCount`
  (`packages/m3l-cli/src/run/envelope.ts:166-169`). It never reads a
  breadcrumb payload, deliberately: the report is classified sensitive and the
  projection guards every field it admits (`report-lookup.ts:197`).
- **The in-process path writes no report at all.** `run/in-process.ts`
  invokes the command module's `execute` and maps its outcome to an exit code;
  it never touches `report-lookup` or a report file. Report-borne visibility
  is a spawn-path capability, and this ADR does not pretend otherwise.

## Decision drivers

- **No breaking change outside a major release** (CLAUDE.md, strict semver) —
  `poll()`/`run()` are primary entry points, with 17 consumer scripts
  downstream and `signal`-threading option bags across six AWS namespaces
  (`athena`, `cloudwatch-logs-insights`, `eks`, `cloudformation`, `ecs`,
  `bedrock-runtime`).
- **No wiring obligation pushed into every consumer script.** ADR-0085 held
  the same line: whatever the change is, it must not require touching all 17.
- **The CLI's allowlisted-scalar read discipline stays intact** (ADR-0063) —
  a visibility feature must not become the reason the CLI starts parsing
  payload contents out of a sensitive artifact.
- **No caller-owned mutable state** in a public options bag; this codebase is
  `readonly`-everywhere and prefers a returned value to an out-parameter.
- **ADR-0049's abort contract is not negotiable** (see _Constraint_ below).
- **The file-budget ratchet is part of the design**, not a packaging detail
  discovered at push time.

## Considered options

1. **Widen the return type** of `poll<T>()`/`run<T>()` to a result envelope
   carrying the value plus attempt metadata. One clean API, no second way to
   do the same thing — but a **breaking** change to two primary entry points,
   which CLAUDE.md forbids outside a major release. Rejected on policy.
2. **Add a sibling detailed method** — `pollDetailed`/`runDetailed` returning
   an envelope of the value plus attempt metadata, leaving `poll`/`run`
   byte-for-byte unchanged. Additive (**minor**), fully typed, no mutable
   state, no consumer-script change. Costs two ways to do one thing on two
   classes.
3. **An opt-in collector in the options bag** — the caller constructs an
   accumulator, passes it in, and reads it after the call. Also additive and
   minor, and keeps a single entry point per class. But it introduces
   caller-owned mutable state and a temporal coupling ("valid only after the
   await") that nothing else in this library's public surface has.
4. **Route it through `core/procedure`'s existing telemetry** instead, and
   skip a `core/polling` change entirely. **Disproven against live code**, and
   recorded here so it is not re-proposed:
   - `M3LRunRecoveryEntry` carries exactly `item`, `error`, `recordedAt`
     (`core/diagnostics/run-report.ts:109-119`) — it has **no `attempt`
     field**. The `attempt` field belongs to `M3LProcedureTraceEntry`
     (`core/procedure/run-types.ts:266`) and to the per-step record, neither
     of which is a poller concern.
   - `core/procedure` never constructs an `M3LPoller` or `M3LRetryRunner` —
     its `recovered`/`recoveredTotal` axis counts _absorbed step failures_
     under `continueOnFailure` (`internal/procedure/step-exec.ts:258-280`),
     which is a different concept from a retry attempt inside a wait loop.
   - The CLI's in-process path runs a command module, not an
     `M3LProcedure`, so procedure telemetry is not on the CLI's report path
     in the first place.
5. **Bridge the existing events into the breadcrumb trail.** Costs no library
   change at all: `on()` is already public, and the report already persists
   `timeline: readonly M3LBreadcrumb[]`
   (`core/diagnostics/run-report.ts:194-195,216-217`), so a script can record
   `retry:attempt` into its own trail today and the data lands in the
   artifact. Genuinely the cheapest option, and it resolves the tracker's
   "possible minor" to no version event. Rejected on two counts: it puts the
   wiring in **every** script that wants visibility (a per-script obligation
   driver 2 rules out), and it forces the CLI renderer to key off breadcrumb
   event-name strings and read payload contents — crossing the
   allowlisted-scalar boundary of driver 3 for the sake of avoiding a minor.

## Decision

We chose **option 2, a sibling detailed method**, for the library half, and a
**new scalar field on the run report** for the transport half.

Option 2 is the only additive shape that keeps the data typed, keeps it a
return value rather than caller-owned mutable state (driver 4), and requires
no change to any consumer script (driver 2). Its real cost — two ways to do
one thing — is bounded by making the detailed method the _superset_:
`poll`/`run` remain the ergonomic default and are documented as "the value
only", with `pollDetailed`/`runDetailed` as the reporting entry point.

The transport is a **scalar** (an attempt count, not a per-attempt array),
because that is what `report-lookup`'s allowlist admits without widening its
discipline (driver 3). A per-attempt array would be exactly the sensitive,
unbounded payload the projection exists to refuse — and the per-attempt
detail remains available in-process to any caller of the detailed method,
which is where it is actually useful.

Because `run-report.ts` cannot grow (constraint 1), the extraction that pays
for the new field is **its own slice, landing before the seam** — not folded
into the seam's PR. Deferring it is what previously turned a four-line comment
into a rebase.

**Constraint on every option, recorded so no future change erodes it.** An
aborted wait must keep rejecting with ADR-0049's dedicated abort code:
`M3LOperationAbortedError`, code `ERR_OPERATION_ABORTED`, classified
`origin: "caller"`, `retryable: false` (`core/errors/catalog.ts:187`,
`core/errors/M3LOperationAbortedError.ts:56`). No classifier may reclassify
it and no detailed-result shape may soften it into a retriable outcome —
otherwise cancelling a run makes `M3LRetryRunner` retry the very operation
the operator just cancelled. The abort check already precedes the classifier
by design (`M3LPoller.ts:188-190`, and the precedent `internal/procedure/guards.ts:46`
cites for the same ordering); a detailed method must preserve that order.

## Consequences

- **Positive:** attempt data becomes observable without holding the emitter
  instance, and without a per-script wiring obligation. `poll`/`run` keep
  their exact current signatures, so no consumer script, AWS client, or test
  changes. The report gains one bounded scalar rather than an unbounded
  payload, so `report-lookup`'s allowlist and ADR-0063's read discipline are
  untouched. The `run-report.ts` extraction pays down a file that has been at
  its ceiling for a while, which benefits every later change to it.
- **Negative / trade-offs:** two ways to do one thing on both `M3LPoller` and
  `M3LRetryRunner` — accepted, and mitigated by documenting the detailed
  method as the reporting-path entry point. Report-borne retry visibility is
  **spawn-path only**; the in-process path writes no report, so an in-process
  run shows no attempt count. The extraction slice is a behaviour-preserving
  refactor of a 65 KB file with no user-visible payoff of its own, which is
  an awkward PR to review but a much worse one to discover at push time.
- **Semver impact:** **minor** for `@m3l-automation/m3l-common` — two new
  methods plus their result types, surfaced through the Core namespace barrel
  (never a new `exports` subpath). No existing signature changes. The CLI is
  unpublished, so its share is no version event.

## Links

- Related: [ADR-0049](./0049-cooperative-cancellation-contract.md) (the abort contract
  this ADR constrains), [ADR-0063](./0063-cli-structured-run-results.md) (the
  allowlisted-scalar read discipline that shapes the transport),
  [ADR-0045](./0045-streaming-safe-resume-contract.md) (the
  refuse-on-fingerprint-mismatch precedent U11's `--resume` mirrors),
  [ADR-0053](./0053-cli-first-evolution-programme.md) (the wave this row belongs to),
  [ADR-0072](./0072-reviewable-slice-discipline.md) (why the extraction is its own
  slice)
- Design plan: [`2026-09-02-u11-retry-resume-cancellation.md`](../plans/2026-09-02-u11-retry-resume-cancellation.md)
- Tracker: [`IMPLEMENTATION.md`](../plans/IMPLEMENTATION.md) row **U11**;
  issue #535
