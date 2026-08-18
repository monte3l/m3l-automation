# 0046. Adopt a codified-procedure engine (`core/procedure`)

- **Status:** Accepted
- **Date:** 2026-08-18
- **Deciders:** Enrico Lionello (maintainer); Claude (audit synthesis)

## Context and problem statement

A capability audit of the library surface found that nothing in
`@m3l-automation/m3l-common` lets a consumer script express a **multi-step
procedure whose control flow and conclusions are data rather than hand-written
imperative code**. A script that gathers evidence across several queries, decides
what to do next from what it found, and terminates with a named conclusion has to
write all of that as bespoke branching inside its `steps/` modules — where the
conclusion is not inspectable, not testable in isolation, and not reportable.

The maintainer has named a consumer for such an engine: a new CloudWatch
log-analysis script, which must run a sequence of Logs Insights queries, extract
fields, evaluate conditions over what it gathered, and terminate by matching the
evidence against a prioritised list of named cases — each carrying the prose an
operator reads.

**Evidence from the current tree.**

- `core/pipeline`'s `M3LOperationPipeline` covers a **different shape**. It runs a
  fixed ten-phase order (accessor → operation → settings → guards → prepare →
  gate → dispatch → persist → finalize → outcome) with exactly one handler per
  operation, and its `M3LOperationPipelineOutcome` is
  `{ operation, status, result }` — no step record, no timing, nothing
  serialisable (`docs/reference/core/pipeline.md`).
- There is no step identity, no engine-owned flow control, and no accumulating
  execution context anywhere in the library. A script's `steps/` modules are plain
  functions with no shared interface and no result envelope.
- The only declarative classification that exists is `core/analysis`'s
  `M3LThresholdEvaluator`, which evaluates declared threshold rules against
  **numeric** values. There is no general condition algebra and no notion of a
  prioritised case list.
- `validatePipelineOptions` (`packages/m3l-common/src/internal/pipeline/validate.ts`)
  throws on the **first** problem it finds, under a single
  `ERR_PIPELINE_INVALID_OPTION` code — adequate for a two-rule check, insufficient
  for validating a step graph.

## Decision drivers

- **Gated broadening** (ADR-0021, carried forward by ADR-0037, applied by
  ADR-0039/0042/0043): a new cross-cutting abstraction is built against a **named
  consumer call-site**, never extracted speculatively. That gate is now met.
- **Minimal runtime dependencies** — the engine must add none.
- **The three-entry `exports` map is frozen** (ADR-0004); new capability surfaces
  through the `core` namespace barrel.
- **Determinism.** ADR-0039 keeps model inference out of the library; a procedure
  must produce the same conclusion from the same evidence.
- **Make illegal states unrepresentable** — the strict-TypeScript posture that
  makes `M3LOperationPipeline`'s exhaustive handler table safe should extend to
  step graphs and case lists.
- **Failures must be legible after the fact**, not only while a terminal is
  attached.

## Considered options

1. **Extend `M3LOperationPipeline`.** Rejected: its ten-phase order is fixed and
   its handler table is keyed by operation, not sequenced. Adding step identity,
   flow control and an accumulating context would not extend that design, it would
   replace it — while destabilising the eight multi-operation scripts already
   dispatching through it.
2. **A new `core/procedure` submodule, coexisting with `core/pipeline`.** Chosen.
3. **Express procedures as data files (YAML/JSON) validated at load.** Rejected —
   see _Definition medium_ below.
4. **Do nothing; let the log-analysis script hand-write its branching.** Rejected:
   it reproduces exactly the condition this ADR exists to remove, and the named
   consumer would carry the conclusion logic in untestable imperative form.

## Decision

We chose **option 2**. `@m3l-automation/m3l-common` grows a new Core submodule,
`core/procedure`, exporting a codified-procedure engine. `M3LOperationPipeline` is
**not** replaced, deprecated, or migrated; the two engines address different shapes
and coexist.

### Domain model

- **Step** — an atomic unit with an `id`, a `label`, a `kind`, an `execute` that
  receives the context and returns a result envelope, and an optional
  `describeTrace`. `describeTrace` is called **before** `execute`, so what reaches
  the trace is the _resolved_ value the step actually used — the final query, the
  evaluated window — not the declaration it came from. Its return type is pinned
  to allowlisted scalars (see _Safety properties_).
- **Step kinds** — `gather`, `transform`, `check`, `decide`, `control`.
- **Context** — immutable and copy-on-write: a step returns a _new_ context rather
  than mutating a shared one. It carries step results keyed by id, extracted
  values, the injected dependency bag, recovered errors, and a cancellation
  signal.
- **Flow control** — a step returns `continue`, `stop`, `resolve`, or `{ goTo }`.
  The engine, not the step, interprets it.
- **Early resolution** — `resolve` means _"there may be enough evidence now;
  check"_. The engine evaluates every known case immediately: on a match the run
  terminates early and the remaining (typically expensive) steps never execute; on
  no match the run continues as if nothing happened. The step knows its own domain
  and decides _when_ to check; the engine owns the case list and decides _whether_
  the check succeeded. The matching condition is therefore written exactly once —
  in the case — instead of being duplicated as a step-level branch.
- **Known cases** — an `id`, a description, a declarative condition, an action, a
  **unique** priority, and operator-facing prose. Uniqueness is load-bearing: with
  ties, which case matched would depend on array order, so the same evidence could
  produce different conclusions across a refactor.
- **Condition algebra** — serialisable value objects, not predicate functions:
  `compare`, `matches`, `contains`, `exists`, composed with `and` / `or` / `not`,
  over a reference syntax addressing step outputs, extracted values and
  parameters. Serialisability is the point: it is what makes conditions traceable,
  statically checkable, and **explainable** — the evaluator returns the resolved
  values alongside the boolean, so a run can report _why_ a case matched.
- **Mandatory fallback** — a procedure cannot terminate without a defined outcome.
  "No case matched" is a first-class structured result recording what was
  investigated, never a silent gap.
- **Outcome** — a discriminated union (case matched / unrecognised / failed /
  aborted) carrying the primary case, every other case that also matched, the
  trace, and run telemetry.

### Definition medium — a code graph with data-driven parameters

Steps, conditions, cases and handlers are **TypeScript**, so a missing handler, an
unknown jump target or a malformed condition is a build error and the definition
rides every existing gate (lint, format, tests, coverage, cycle detection, the
review spokes). Log groups, time windows, thresholds and expected patterns are
**configuration**, resolved through the seven existing providers and
`data/config/presets/`. Retuning an analysis is therefore a preset change; a new
_shape_ of analysis is a code change.

Data-file definitions were declined on three grounds: the library has no schema
validator and adding one collides with the minimal-dependency rule (`zod` is a
workspace **devDependency** used by `bin/` tooling, not a library dependency);
compile-time exhaustiveness would be lost entirely, converting every guarantee the
mapped handler type provides into a runtime check that must itself be written and
tested; and because handlers must remain code regardless, the definition would
split into a graph bound to behaviour by string id — precisely the class of
unresolvable-reference defect the build-time validation below exists to catch.

### Decision surface — declarative conditions plus interactive prompts

Branching is declarative and deterministic by default. The `decide` step kind may
additionally pause and ask the operator through the existing `M3LPrompt`, for
choices a procedure genuinely cannot make on its own. No natural-language
interpretation is involved: ADR-0039 remains in force and no model participates in
execution.

The `matches` arm operates on strings only, with a bounded pattern applied to
bounded input, satisfying ADR-0039's ReDoS-conscious string-only-parsing rule as
named in `docs/contributing/style-guide.md` § _Parsing untrusted text_.

### Safety properties

- **Build time.** `build()` refuses to produce an invalid procedure and reports
  **every** problem at once, each under its own machine-readable code: duplicate
  step id, invalid jump target, cycle detected, duplicate case id, duplicate case
  priority, empty step list, missing fallback. Cycle detection is a depth-first
  search with node colouring over the graph formed by both implicit sequential
  edges and explicit jumps. Reporting all problems at once is deliberate: a step
  graph typically has several faults, and fixing them one rejection at a time is
  the failure mode this replaces.
- **Run time.** An iteration ceiling; a no-progress guard that fires on an
  unchanging progress witness rather than waiting for the ceiling, so a live loop
  surfaces in seconds instead of after many real remote calls; per-step
  `continueOnFailure`, which records a recovery entry so a degraded run is
  distinguishable from a clean one; and a cancellation signal honoured at every
  step boundary and threaded into step handlers.
- **Trace payloads are allowlisted, never denylisted.** ADR-0035's 2026-07-23
  update is authoritative here: four adversarial passes established that regex
  redaction over unbounded caller text does not converge, while the allowlisted
  breadcrumb summarizers held every round. `describeTrace` therefore returns a
  declared record of `M3LBreadcrumbScalar` values, which is what lets the trace
  inherit the breadcrumb trail's stronger sharing guarantee rather than the run
  report's crash-dump classification.
- **Definition digest.** `canonicalJsonHash` (`core/json`) over the built
  definition identifies the exact definition a run used, and is the value a
  resumable consumer supplies as its checkpoint fingerprint.

### Import constraints

`core/procedure` **must not import `aws/**`** — steps are script-supplied
handlers, so the engine stays AWS-agnostic and the island zone is not inverted. It
**must not import `core/script`** (the composition-root zone). Both are enforced
by the existing ESLint zones and `pnpm check:zones`; neither zone may be widened
to make the engine compile.

### Naming

`procedure`, not `workflow` — which would collide with `.claude/workflows/`
(ADR-0025) — and not `pipeline`, which `core/pipeline` holds.

### Deliberately out of scope

Recorded so the engine does not creep past its evidence:

- **Cross-script orchestration** — sequencing whole consumer scripts is
  [ADR-0047](./0047-cross-script-orchestration-deferred.md), not this engine.
- **Unattended dispatch** — pinning a definition digest into a dispatched command,
  and any static read-only-execution proof gating unattended runs, both presuppose
  an execution model this repo does not have.
- **Replay and reconciliation** — replaying a procedure over historical inputs and
  comparing against expected conclusions has no consumer.
- **Model-interpreted branching** — closed by ADR-0039.

## Consequences

- **Positive:** the named consumer can express its analysis as an inspectable,
  testable definition; conclusions become data with prose attached rather than
  branching buried in a step module; a run reports _why_ it concluded what it did;
  early resolution avoids spending query budget on evidence that is no longer
  needed; and "unrecognised" becomes a structured result that can be improved over
  time instead of a silent gap.
- **Negative / trade-offs:** the library carries a second engine, and the two must
  not drift into one vocabulary for "step" and another for "phase" — the contract
  pages carry the distinction explicitly. Authoring a procedure requires a build
  and a checkout, so a non-developer cannot add a case; that cost is accepted in
  exchange for compile-time exhaustiveness. Core submodule count moves 22 → 23 and
  the total 41 → 42, with the mechanical count-site reconciliation that implies.
- **Semver impact:** **additive minor.** All new symbols surface through the
  `core` namespace barrel; the three-entry `exports` map is untouched, so
  `pnpm check:api` must not move.

## Links

- Related: [ADR-0021 (the broadening intake gate)](./0021-post-1.0-deepen-first-strategy.md),
  [ADR-0037 (carries the gate forward)](./0037-deepen-first-re-read-against-consumer-pull.md),
  [ADR-0043 (the operation-dispatch engine this one coexists with)](./0043-step-pipeline-engine-deferred.md),
  [ADR-0039 (determinism and the string-only-parsing rule)](./0039-llm-integration-out-of-scope.md),
  [ADR-0035 (allowlisted trace payloads)](./0035-failure-reporting-and-diagnostics.md),
  [ADR-0004 (`exports` map contract)](./0004-exports-map-contract.md),
  [ADR-0047 (cross-script orchestration deferral)](./0047-cross-script-orchestration-deferred.md),
  [ADR-0049 (the cancellation signal the context carries)](./0049-cooperative-cancellation-contract.md).
- Capability reference: [`core/pipeline`](../reference/core/pipeline.md),
  [`core/json`](../reference/core/json.md),
  [`core/analysis`](../reference/core/analysis.md).
- Implementation plan: `docs/plans/2026-08-18-codified-procedure-engine.md`.
