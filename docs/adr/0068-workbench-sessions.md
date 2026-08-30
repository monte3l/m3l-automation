# 0068. Workbench sessions and the addressable-artifact convention

- **Status:** Accepted
- **Date:** 2026-08-20
- **Deciders:** Enrico Lionello (maintainer); Claude (design synthesis)

## Context and problem statement

The console's defining interaction is exploratory drill-down — the
canonical scenario: list SQS queues, dump one, view the dump as pretty
JSON, **select specific field values**, use them as keys for DynamoDB
queries, see the results, and decide how to proceed. The audit confirmed
nothing supports this shape: no session state across steps, no
addressable intermediate results a UI can reference, no binding from a
prior step's output to the next step's parameters — and the inter-step
"on-disk artifact convention" was explicitly deferred by
[ADR-0047](./0047-cross-script-orchestration-deferred.md)/[ADR-0056](./0056-cross-script-orchestration-engine.md)
to U10's design phase and never designed.

The two existing engines don't fit: ADR-0056 flows are **predefined**
sequences (the user must know the steps before running), and ADR-0046
procedures are per-script, operator-choice-within-a-procedure (and
unimplemented, B2). Exploration is the opposite shape — the next step is
decided after seeing results.

## Decision drivers

- **Exploration first**: the user drives; the system records.
- **Addressability**: a UI selection must become a durable, typed
  reference, not a copy-paste.
- **One convention, two consumers**: whatever encodes "step output →
  next step's parameter" here is exactly what U10's flow engine needs
  for inter-script data — design once.
- **Every step is audited** (ADR-0070) and policy-checked (ADR-0060 via
  ADR-0065's integration).

## Considered options

1. **Extend `m3l flow` with pause/ask-user steps.** Rejected: forces
   defining a flow before exploring — inverts the discover-as-you-go
   nature; flows remain the right home for _repeatable_ sequences.
2. **Build on `core/procedure` decide-steps.** Rejected: per-script
   scope, unimplemented (B2), and its decide vocabulary is choice within
   a procedure, not free exploration across scripts.
3. **A new first-class workbench-session concept.** Chosen.

## Decision

We chose **option 3**. `m3l-console-server`'s `sessions` module owns:

- **The session**: an ordered record of executed operations. Each step
  stores the operation identity, its bound parameters, its outcome, and
  its **addressable result** — metadata and indexes in the ADR-0069
  store, bulk payloads (a queue dump) as artifact files referenced by
  the store. Sessions are resumable (reopen where you left off), listed
  and queryable, and subject to a retention policy (ADR-0070's regime).
- **Addressable step results**: a stable reference syntax addressing a
  step's output down to a JSON path — the shape of
  `step-3.output.messages[7].userId` (exact grammar fixed at
  implementation, X6). References are session-scoped and durable across
  resume.
- **Typed data bindings**: selecting a value in the UI creates a
  binding — reference + expected type — that the next operation's
  parameter form consumes. Bindings are first-class session records
  (they appear in the audit trail as what-was-selected, recorded **by
  reference**, per ADR-0070's exposure model), and multi-select produces
  parameter arrays (e.g. several ids → a batch query).
- **Decision points**: a session step may end by asking the operator how
  to proceed (free continuation, or choosing among offered next
  operations); the ask and the answer are both session records.
- **Session → flow export**: a session whose step sequence has proven
  repeatable exports into an ADR-0056 flow definition — steps become
  flow steps; bindings become the flow's inter-step data references.
  **The binding/artifact convention defined here IS the convention U10
  consumes** — the deliberately reversed dependency: X6 designs it, U10
  reads it (recorded in ADR-0056's dated Update and U10's tracker row).
  Convention types live console-local at X6; **promotion to
  `m3l-common` is triggered by U10 starting** (an additive minor at that
  moment, flagged now).

## Consequences

- **Positive:** the drill-down scenario becomes a first-class, resumable,
  fully audited object rather than an operator's mental state; the
  U10-blocking artifact convention gets designed with a real consumer
  driving it; repeated explorations graduate into flows instead of being
  re-clicked forever.
- **Negative / trade-offs:** a genuinely new concept with real design
  surface (reference grammar, binding typing against declared parameter
  types, retention, concurrent-session limits); artifact storage for
  large dumps needs size discipline (caps + retention, fixed at X6);
  until U4/U8 ship, binding target types lean on the coarser
  introspection surface.
- **Semver impact:** none from this ADR (docs only). X6 is console-server
  work; the flagged type promotion at U10-start is an `m3l-common`
  additive minor decided then.

## Links

- Programme: [ADR-0064](./0064-m3l-console-programme.md). Store:
  [ADR-0069](./0069-console-embedded-persistence.md). Audit/exposure:
  [ADR-0070](./0070-console-audit-and-observability.md). UI: X11 under
  [ADR-0067](./0067-console-frontend-stack.md).
- Convention consumer: [ADR-0056](./0056-cross-script-orchestration-engine.md)
  (its 2026-08-20 Update records that U10 consumes this design);
  distinct from [ADR-0046](./0046-codified-procedure-engine.md)
  (per-script procedures, B2).

## Update (2026-08-30) — X6 fixed the deferred decisions

X6 shipped across five PRs (#737, #738, #740, #743, #746) and resolved every
decision this ADR left to implementation:

- **Reference grammar fixed:** `step-<ordinal>.output(.<ident> | [<index>] |
["<quoted>"])*` — a 1-based step ordinal, then dotted-identifier,
  bracket-quoted, or numeric-index path segments, each walked against the
  step's recorded output. `docs/reference/console.md`'s Reference grammar
  section has worked examples.
- **Caps fixed:** an artifact-inline threshold (64 KiB default), a
  per-artifact cap (32 MiB), a session-total running cap (256 MiB), and an
  open-session cap (32) — all four under `m3l.console.sessions.*`,
  configurable, validated at boot.
- **Console-local type home confirmed** — the binding/artifact convention
  types (`sessions/launch-parameters.ts`, `sessions/binding.ts`,
  `sessions/reference.ts`) stay `packages/m3l-console-server`-local, per this
  ADR's own decision; `m3l-common` promotion remains gated on U10 starting.
- **The deferred age-based sweep**: no retention sweep shipped with X6 — it
  is ADR-0070's regime, tracked under X8. A session's artifacts live until
  the process's data directory is cleared by hand.

Two contracts this ADR stated needed a follow-up round after the first four
slices (#737/#738/#740/#743) landed, closed by #746:

- **"Bindings are first-class session records ... appear in the audit
  trail"** — `addStep` now persists each resolved binding immediately after
  its own resolution succeeds, and `GET /api/v1/sessions/:id/bindings`
  exposes the trail. Known gap: a persisted binding record carries no
  step-linkage column, so a launch failure followed by a client retry with
  identical bindings persists duplicate (not lost or corrupted) audit rows —
  closing this needs a store migration, tracked as a future refinement
  rather than blocking X6.
- **"Sessions are resumable"** — `POST /api/v1/sessions/:id/reopen` exposes
  the service's `reopenSession` (which existed since the first `addStep`
  slice but had no REST route) over the API, gated by the same open-session
  cap `createSession` enforces on the count-increasing case only.

A step's addressable output remains outcome-only (`{ outcome, exitCode }`)
— the canonical "select a field out of a real output dump" walk is provable
today only by seeding a step's artifact directly (as X6's own acceptance
integration test does), not yet through a real script's `run.ended` payload.
This does not block X6 or X11; it is recorded in `docs/reference/console.md`'s
Known limits.
