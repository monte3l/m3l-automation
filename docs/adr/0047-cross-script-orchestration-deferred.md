# 0047. Cross-script orchestration belongs to `m3l-cli`, and is deferred

- **Status:** Accepted
- **Date:** 2026-08-18
- **Deciders:** Enrico Lionello (maintainer); Claude (audit synthesis)

## Context and problem statement

[ADR-0046](./0046-codified-procedure-engine.md) adopts a codified-procedure engine
for sequencing steps **inside** one consumer script. A distinct question was raised
alongside it: sequencing **whole consumer scripts** — running several of the
fourteen `scripts/*` packages in an ordered flow, branching on what each one
concluded.

These are different problems with different homes, and conflating them would put
process orchestration inside a library whose consumers are supposed to be
independent of one another. This ADR records where that capability belongs and why
it is not being built now, so the question has a correct default instead of being
re-derived at the next audit.

**Evidence from the current tree.**

- The inter-step contract such an orchestrator would need **already exists and is
  stable**: every script exits with a registry-mapped code (`M3L_EXIT_CODES` /
  `mapErrorToExitCode`, carrying the fault-origin classification from ADR-0035),
  and writes `data/output/<startedAt>/run-report.json` — a document discriminated
  on `outcome`, carrying an allowlisted `timeline`. Branching on that is reading an
  existing contract, not inventing one.
- `packages/m3l-cli` already performs every mechanical part: it resolves the
  workspace root, discovers every `scripts/*` package with a `package.json`, caches
  that discovery, translates a script's declared `configParameters` into CLI flags,
  spawns `node dist/main.js`, forwards arguments, and records an invocation history.
- Scripts are **structurally forbidden** from knowing about each other. ADR-0029
  and `pnpm check:script-deps` require every `scripts/*/package.json` to declare
  exactly `{"@m3l-automation/m3l-common": "workspace:*"}` and no devDependencies,
  and an ESLint zone permits a script's `src/` to import only itself and the
  library.

## Decision drivers

- **Gated broadening** (ADR-0021 / ADR-0037): a capability is built against a named
  consumer call-site. No flow spanning two or more scripts has been named.
- **ADR-0029's boundary must survive.** Any design that lets one script reach into
  another's implementation is out.
- **Do not invent the step vocabulary twice.** ADR-0046's engine is being built
  now; an orchestrator designed in the same breath would either duplicate its
  vocabulary or diverge from it.
- **Process isolation is a feature** for this workload — each script resolves its
  own config, provisions its own AWS clients, and installs its own signal handlers.

## Considered options

1. **Build the orchestrator in `m3l-common`, composing scripts in-process.**
   Rejected. It cannot orchestrate scripts without either exposing composable units
   from each one — breaking their mutual isolation and cutting against ADR-0029 and
   the script zone — or re-implementing their work over the same library wrappers,
   at which point the result is a new library consumer rather than an orchestration
   of existing ones.
2. **Build it in `m3l-cli` now**, sequencing script processes and branching on exit
   code plus run-report outcome. Rejected **for now** on the intake gate only: the
   design is sound and the contract exists, but no multi-script flow has been named.
3. **Record the home and the trigger; build nothing yet.** Chosen.
4. **Say nothing.** Rejected: the question would resurface at the next audit and be
   re-derived from scratch, which is the exact failure mode ADR-0043 named.

## Decision

We chose **option 3**.

**When cross-script orchestration is built, it belongs in `packages/m3l-cli`**, not
in `@m3l-automation/m3l-common`. The CLI already owns discovery, parameter
translation, spawning and history; orchestration is sequencing on top of machinery
that exists. Because it drives scripts as processes, ADR-0029, the script ESLint
zone and `pnpm check:script-deps` all stay intact — scripts remain mutually
ignorant, and the orchestrator depends on the contract they already publish rather
than on their internals.

**It is deferred.** The revisit trigger is a **named multi-script flow**: a
concrete sequence of two or more existing scripts that a maintainer wants to run in
order with branching between them. Building ahead of that repeats the speculative
broadening ADR-0021/0037/0039/0043 have each declined.

### Trade-off accepted by this placement

An orchestrator that drives processes cannot see _inside_ a script, so ADR-0046's
early resolution can only fire at script boundaries, never at step granularity.
Data flow between steps is likewise coarse — an exit code plus whatever the script
wrote under `data/output/` — so passing a rich value from one script to a later one
would require agreeing an on-disk artifact convention that does not exist today.
Both costs are accepted: they are the price of keeping scripts independent, and
neither can be avoided by moving the orchestrator into the library.

## Consequences

- **Positive:** the placement question is settled before the code exists, so
  ADR-0046's engine can establish the step vocabulary once and an orchestrator can
  adopt it rather than compete with it; ADR-0029's boundary is protected by an
  explicit decision rather than by omission; and the recurring "should the library
  orchestrate scripts?" question now has a recorded answer of _no_.
- **Negative / trade-offs:** multi-script flows stay manual until the trigger
  fires; when it does, the on-disk artifact convention for rich inter-script data
  will have to be designed at that point rather than now.
- **Semver impact:** **none.** No code, export, or `exports`-map entry changes.

## Update 2026-08-20 — revisit trigger fired; engine activated

The revisit trigger has fired: the maintainer named the first concrete
multi-script flow — **sqs-etl → json-etl → dynamodb-crud → sqs-etl** (dump a
queue, parse and selectively extract values, query DynamoDB and compare,
selectively delete the matched messages), branching on each script's outcome.

The deferral is therefore lifted. The engine's design decision is recorded in
[ADR-0056](./0056-cross-script-orchestration-engine.md) (`m3l flow`,
spawn-first with an in-process fast path per ADR-0054), and the work is
tracked as U10 of the CLI-first evolution programme
([ADR-0053](./0053-cli-first-evolution-programme.md)). The placement this ADR
decided — `packages/m3l-cli`, never `m3l-common` — is unchanged; the Status
stays Accepted, exactly as ADR-0042's own fired-trigger update did.

## Links

- Related: [ADR-0046 (the in-script procedure engine)](./0046-codified-procedure-engine.md),
  [ADR-0029 (consumer scripts depend only on the library)](./0029-script-dependency-boundary.md),
  [ADR-0042 (the `m3l-cli` package)](./0042-script-cli-package-deferred.md),
  [ADR-0035 (exit-code registry and the run report)](./0035-failure-reporting-and-diagnostics.md),
  [ADR-0021](./0021-post-1.0-deepen-first-strategy.md) /
  [ADR-0037](./0037-deepen-first-re-read-against-consumer-pull.md) (the intake gate),
  [ADR-0043 (the record-the-deferral precedent)](./0043-step-pipeline-engine-deferred.md).
- Implementation plan: `docs/plans/2026-08-18-codified-procedure-engine.md`.
