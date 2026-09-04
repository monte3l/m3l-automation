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

## Update (2026-09-01) — the promotion trigger fired; the type home moved

This ADR's decision recorded the convention types as console-local, with
"promotion to `m3l-common` … triggered by U10 starting". U10 started, so the
gate opened and the types moved.

The promotion is not optional. `packages/m3l-cli` depends on `m3l-common`
plus the sixteen consumer scripts and **cannot** import
`m3l-console-server`, so ADR-0056's flow engine can only consume this
convention — which its own 2026-08-20 Update commits it to doing — after the
types leave the console. This is the "additive minor at that moment" this ADR
flagged in advance, and it also discharges ADR-0056's standing condition that
"any library seam it turns out to need gets its own recorded decision".

**What moved.** `parseStepReference`, `formatStepReference`,
`resolveStepReference` and the `M3LStepReference` type from
`sessions/reference.ts`, plus `M3LBindingExpectedType`,
`validateBindingValue` and the binding type from `sessions/binding.ts`, into
a new `core/orchestration` Core submodule surfaced through the Core namespace
barrel (never a new `exports` subpath). The grammar is unchanged:
`step-<ordinal>.output(.<ident> | [<index>] | ["<quoted>"])*`, 1-based
ordinal, 0-based indices, trailing garbage rejected.

`sessions/launch-parameters.ts` is untouched. `M3LSessionBinding` is renamed
`M3LStepBinding` in the library — "session" is a console concept with no
meaning to a flow — and the console keeps its original name as a local alias,
so the console's own API is unchanged.

**The one place this is not a pure move.** The moved functions threw
`M3LConsoleError` with code `ERR_CONSOLE_SESSION_REFERENCE_INVALID`, and a
console-specific error class cannot live in `m3l-common`. The promoted
functions therefore throw a library-owned `M3LError` subclass with a
library-owned code, and `sessions/reference.ts` and `sessions/binding.ts`
remain in place as thin adapters that re-export the promoted types and
catch-and-rewrap the promoted error as `M3LConsoleError` with the existing
code.

Adapters rather than deletion, deliberately: the console's HTTP envelope
classifies `ERR_CONSOLE_SESSION_REFERENCE_INVALID` as a 400/caller/
non-retryable fault, so letting a raw library error escape would silently
reclassify those responses to 500. The adapters preserve that mapping and
leave both console test suites unchanged — which also keeps those suites
covering the adapters' own throw paths.

**Semver impact:** additive minor on `@m3l-automation/m3l-common` — a new
Core submodule and a new error code, no removals and no signature changes.
No change to `m3l-console-server`'s public API.

Nothing else in this ADR changes. The convention, the grammar, the caps, and
X6's shipped surface all stand as decided; only the types' home moved.

## Update (2026-09-04) — X11 shipped; the `parameterName`-not-persisted limit is retracted

X11 (the drill-down UI this ADR's canonical scenario describes) is done,
across six PRs — X11a #937, X11a2 #946, X11b #958, X11c #973, X11d #980,
X11e #987; `docs/plans/IMPLEMENTATION.md`'s X11 row has the full breakdown.
The scenario this ADR opened with — select a value out of a step's output,
bind it, let it pre-fill the next step's launch, answer a decision — is
real, proved end-to-end under Playwright by X11e's acceptance spec.

**The one limit this ADR left open is now closed.** `docs/reference/console.md`
previously documented, in three places, that a persisted binding record had
no `parameterName` — the server accepted it as a required input field and
then silently dropped it, so a reloaded or resumed session could read its
bindings back but never learn which launch parameter each one fed. X11a
(#937) fixed this: migration v10 adds `console_session_bindings.parameter_name`
(nullable, for v4-era rows), and both binding-creation paths persist it. The
three "not persisted" notes in `docs/reference/console.md` were retracted in
the same PR. A binding is now genuinely a first-class, resumable session
record, per this ADR's own "Sessions are resumable" requirement — the gap
was real, not cosmetic: without it, the pre-fill loop degraded to nothing
after every reload.

**One design decision X11e made, not anticipated here.** `POST
/api/v1/sessions/:id/steps` takes only `operation`/`bindings[]`/`confirmed`/
`dryRun` — no free-form parameter values. Every session-step launch
parameter must trace back through a binding to a prior step's recorded
output; there is no way to type in a literal value for a session step. This
wasn't an explicit constraint in this ADR's Decision section, but it falls
directly out of "the system records" (Decision drivers, "Exploration
first") — a session step's provenance chain would have a hole in it the
moment a parameter's value could come from nowhere traceable. X11e's UI
(`SessionStepLauncher.tsx`) reuses `ParameterForm` for display/pre-fill only
and builds the actual launch request from binding records, never from the
form's own submitted values.
