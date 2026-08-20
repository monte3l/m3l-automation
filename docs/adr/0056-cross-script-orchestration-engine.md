# 0056. Cross-script orchestration engine in `m3l-cli` (`m3l flow`)

- **Status:** Accepted
- **Date:** 2026-08-20
- **Deciders:** Enrico Lionello (maintainer); Claude (design synthesis)

## Context and problem statement

[ADR-0047](./0047-cross-script-orchestration-deferred.md) placed cross-script
orchestration in `packages/m3l-cli` and deferred it behind a single revisit
trigger: **a named multi-script flow** — a concrete sequence of two or more
existing scripts to run in order with branching between them.

That trigger has now fired. The maintainer named the first real flow
(2026-08-20):

1. **`sqs-etl`** — dump a queue's messages;
2. **`json-etl`** — parse the dump and selectively extract values;
3. **`dynamodb-crud`** — query DynamoDB and compare against the extracted
   values;
4. **`sqs-etl`** (again) — selectively delete the matched messages from the
   queue.

Each step branches on the previous script's outcome (empty dump → stop; no
matches → stop without deleting; partial failures → operator decision). This
is exactly the shape ADR-0047 anticipated: sequencing whole scripts,
branching on what each concluded, over the contract they already publish.

## Decision drivers

- **ADR-0047's placement stands:** the CLI already owns discovery, parameter
  translation, spawning, and history; orchestration is sequencing on top of
  machinery that exists, and driving scripts as processes keeps ADR-0029
  intact.
- **The inter-step contract already exists:** registry-mapped exit codes
  (ADR-0035) plus `data/output/<startedAt>/run-report.json` with its
  discriminated `outcome` and allowlisted `timeline`.
- **Do not couple to unshipped work:** `core/procedure` (ADR-0046, B2) is
  not yet implemented; the orchestrator must not wait on it, and the two
  vocabularies stay distinct (steps inside a script vs whole scripts).
- **Reserved names are governance:** a new static command must join the
  reserved set everywhere it is enforced.

## Considered options

1. **Leave deferred.** Rejected: the trigger ADR-0047 defined has fired; a
   named flow with a real operator need exists.
2. **Build the engine over the spawn path only** — sequence child processes,
   branch on exit code + run report. Viable immediately; rich inter-script
   data remains coarse (on-disk artifacts).
3. **Build it over ADR-0054's in-process seam only.** Rejected as the
   _initial_ form: it would gate the flow behind fleet `commandModule`
   adoption (U6/U7) and lose process isolation where it is wanted.
4. **Spawn-first engine with an in-process fast path where a script offers
   one.** Chosen — option 2 now, upgraded per-step as ADR-0054 adoption
   lands.

## Decision

We chose **option 4**.

- **Command:** `m3l flow` — the reserved static-command set grows from nine
  to eleven: `list, inspect, run, doctor, presets, history, new, help,
wizard` + **`flow`** + **`completion`** (the latter reserved here for U12;
  both must land in `bin/lib/script-scaffold.mjs`'s reserved-name list, the
  `check:script-scaffold` gate, and `doctor`'s collision audit in the same
  change that ships each command).
- **Engine home:** `packages/m3l-cli` (per ADR-0047). It sequences the
  fleet's scripts; branching conditions read each step's exit code and its
  `run-report.json` `outcome`. A step whose script exposes a `commandModule`
  (ADR-0054) may run in-process; every other step spawns exactly as
  `m3l run` does today.
- **Definition format, resume semantics, and branching algebra** are
  implementation-phase design (U10), recorded in a dated
  `docs/plans/` design doc when that phase starts — this ADR fixes the
  placement, the command name, the contract surfaces (exit codes +
  run-report), and the acceptance flow, not the file format.
- **Exit codes:** the engine reuses the ADR-0035 registry conventions. If
  flow-level outcomes prove to need their own codes, that is a dated
  ADR-0035 Update at U10 time — no registry change is made by this ADR.
- **Acceptance:** the engine ships against the named sqs-etl → json-etl →
  dynamodb-crud → sqs-etl flow as its first working definition (the B3
  named-consumer precedent from ADR-0046).

**Accepted trade-off carried forward from ADR-0047:** a process-driving
orchestrator cannot see inside a spawned script — early resolution fires at
script boundaries, and rich inter-script data needs an on-disk artifact
convention, to be designed at U10 alongside the definition format. The
in-process fast path narrows this per adopting script but does not change
the baseline contract.

## Consequences

- **Positive:** the first real multi-script flow gets a home; ADR-0047's
  deferral resolves exactly along its recorded design instead of being
  re-derived; the engine is buildable immediately (spawn path) and improves
  automatically as ADR-0054 adoption spreads.
- **Negative / trade-offs:** flow definitions become a new user-facing
  surface to document and gate; branching on coarse contracts limits early
  resolution granularity until in-process adoption lands.
- **Semver impact:** none from this ADR (docs only). The engine itself is
  CLI-internal (no `m3l-common` export change); any library seam it turns
  out to need gets its own recorded decision.

## Links

- Fires the trigger of: [ADR-0047](./0047-cross-script-orchestration-deferred.md)
  (its 2026-08-20 Update block records the firing).
- Programme: [ADR-0053](./0053-cli-first-evolution-programme.md). Execution
  seam: [ADR-0054](./0054-command-module-contract-and-hybrid-execution.md).
- Related: [ADR-0035 (exit codes + run report)](./0035-failure-reporting-and-diagnostics.md),
  [ADR-0029 (scripts stay mutually ignorant)](./0029-script-dependency-boundary.md),
  [ADR-0046 (the distinct in-script engine)](./0046-codified-procedure-engine.md).
