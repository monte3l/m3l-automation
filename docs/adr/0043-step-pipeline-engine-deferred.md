# 0043. Defer a step-pipeline engine; close out the remaining reference capabilities

- **Status:** Accepted
- **Date:** 2026-08-13
- **Deciders:** Enrico Lionello (maintainer); Claude (audit synthesis)

## Context and problem statement

The post-comparison hardening-wave plan (`docs/plans/archive/2026-08-13-post-comparison-hardening-wave.md`,
§9) evaluated whether `m3l-common` should grow a generic step-pipeline engine
— a shared abstraction for the operation-dispatch shape every consumer
script's `steps/run-*.ts` module hand-writes today.

**Evidence.** All 13 `scripts/*/src/steps/run-*.ts` dispatchers are
hand-written imperative code totalling **4,867 lines**, and they repeat the
same four shapes:

- a `type XOperation = (typeof X_OPERATIONS)[number]` union,
- a `RawSettings`/`RunSettings` struct,
- a `DESTRUCTIVE_OPERATIONS` set feeding `Core.confirmDestructive`,
- a `Record<Operation, …>` required-field table.

(compare `run-s3-objects.ts` with `run-ecs-ops.ts` — the shapes line up
almost field-for-field despite dispatching to entirely different AWS
services).

This ADR also closes out three other capabilities the same external
comparison surfaced, so a future audit does not re-derive answers this repo
already has.

## Decision drivers

- **Gated broadening** (ADR-0021, carried forward by ADR-0037): a new
  cross-cutting abstraction is built against a named consumer call-site, not
  extracted speculatively from repetition alone — duplication is a
  precondition for extraction, not sufficient justification on its own.
- **The duplication, while real, is not yet costly.** 4,867 lines across 13
  files is ~375 lines/file of largely mechanical, type-checked dispatch code;
  nothing in the current repo state (no bug traced to divergence between the
  13 dispatchers, no script blocked on the absence of a shared engine)
  indicates the duplication is actively causing harm.
- **An engine abstraction is a design commitment, not a mechanical
  extraction.** Collapsing four repeated shapes into one generic engine means
  choosing a single operation-dispatch contract that all 13 (and every future)
  scripts must fit — a design that is easy to get wrong speculatively and
  expensive to unwind once scripts depend on it.
- **Precedent**: ADR-0039 declined a Bedrock-invocation submodule on the same
  reasoning — gate on a named consumer, not on a generalizable pattern
  observed in the abstract.

## Considered options

1. **Build a step-pipeline engine now**, extracting the four repeated shapes
   into a shared `Core` submodule and migrating all 13 scripts onto it.
   Rejected: no named consumer call-site is blocked on its absence; this is
   the same speculative-broadening pattern ADR-0021/ADR-0037/ADR-0039 already
   declined elsewhere, and retrofitting 13 already-shipped scripts onto a new
   abstraction is a large, high-blast-radius migration for a benefit that is
   currently aesthetic (less repetition) rather than functional.
2. **Record an explicit deferral now, gated on a named consumer**, the same
   way ADR-0039 gated Bedrock. Costs nothing today, and gives the recurring
   "should we extract a pipeline engine" question an immediate, correct
   default instead of an unrecorded silence next time someone notices the
   repetition.
3. **Say nothing and let it resurface identically at the next audit.**
   Rejected: the exact status quo the comparison flagged; the next audit
   would re-derive the same 4,867-line count from scratch.

## Decision

We chose **option 2**.

`@m3l-automation/m3l-common` will **not** grow a step-pipeline engine
speculatively. The trigger to revisit is a **named consumer call-site**: a
14th (or later) script whose dispatcher would either (a) be near-identical
boilerplate to an existing one, making the duplication cost concrete rather
than abstract, or (b) a maintainer explicitly proposing to migrate two or
more existing scripts onto a shared engine as part of unrelated work already
touching those files. Building ahead of either trigger repeats the mistake
ADR-0021/ADR-0037/ADR-0039 already named and declined.

### The remaining reference capabilities — closed, not deferred

Three other capabilities from the same external comparison are closed
outright (no revisit trigger — they are settled, not pending):

- **LLM/Bedrock invocation** — already declined in
  [ADR-0039](./0039-llm-integration-out-of-scope.md); no change here.
- **A canonical-JSON contracts package.** The capability already exists:
  `core/json`'s `canonicalJsonStringify`/`canonicalJsonHash`
  (`docs/reference/core/json.md`) sort object keys by true Unicode code
  point at every nesting level, preserve array order, emit compact output,
  honor `toJSON` at every nesting level (matching `JSON.stringify`'s own
  precedence), and throw `M3LError` (`ERR_INVALID_ARGUMENT`) on
  non-finite numbers, `BigInt`, or circular references rather than silently
  producing an ambiguous hash. A separate contracts package would duplicate
  this, not add to it.
- **A typed client for an internal alerting service.** No such service
  exists in this repo or its consumer scripts — there is nothing to build a
  typed client against. If one is introduced in the future, its transferable
  patterns are exactly this wave's §2–§3 work (redact secrets before they
  reach a logging/event sink; classify retriable vs. terminal failures via
  identity, not message text) rather than a new AWS-style typed wrapper; an
  OpenAPI-codegen approach would also conflict with the minimal-dependency
  rule.

## Consequences

- **Positive:** closes the decision-record gap for all four capabilities the
  comparison surfaced; a future "should we extract a pipeline engine" question
  has an immediate, correct default (no, unless a named consumer needs it)
  instead of requiring a fresh line-count audit; the canonical-JSON and
  alerting-client questions are closed permanently, not just deferred.
- **Negative / trade-offs:** the 4,867 lines of duplicated dispatch shape
  across 13 scripts remain unreduced; if a real need for a 14th script
  reveals the duplication is now costly, that script (and any migration of
  existing ones) pays the cost of building the engine at that point rather
  than amortizing it now.
- **Semver impact:** none. This ADR records a non-decision to build (for the
  engine) and two closures with no code change (canonical JSON, alerting
  client); no code, export, or `exports`-map entry changes.

## Update (2026-08-16) — trigger (b) fired; engine building, s3-objects + ecs-ops migrating

The revisit trigger this ADR defined has fired: the maintainer explicitly
proposed migrating two existing scripts onto a shared engine (trigger (b),
issue #334). The engine is being built as a new Core submodule,
**`core/pipeline`** (`M3LOperationPipeline`), on `feat/step-pipeline-engine`,
with **`s3-objects`** and **`ecs-ops`** — the near-identical pair this ADR
itself named — as the first two consumers.

Scope boundary, recorded so the engine does not creep past its evidence:

- The engine absorbs only the multi-operation dispatcher skeleton (operation
  union → settings resolution → per-operation required-field guards →
  destructive-operation gate via `Core.confirmDestructive` with a
  script-chosen decline policy → handler dispatch → optional persist →
  optional post-dispatch assertions).
- Deliberately out of scope: checkpoint/resume (`dynamodb-crud`), multi-file
  routing (`rds-data-sql`), thin passthrough and single-operation scripts,
  custom gate variants, and completion-log text (script-owned).
- The dispatcher population has grown since this ADR was written: 18
  `run-*.ts` files (~6,992 lines), of which 8 are multi-operation dispatchers
  — the actual duplication target. Migration of the remaining 6 is tracked as
  new backlog rows, gated on parity evidence from the first two migrations.

The three capabilities this ADR closed outright (LLM/Bedrock, canonical-JSON
contracts, internal-alerting-service client) remain closed — this update
opens only the engine gate.

## Links

- Related: [ADR-0021 (post-1.0 deepen-first strategy — the broadening intake
  gate this decision applies)](./0021-post-1.0-deepen-first-strategy.md),
  [ADR-0037 (deepen-first re-read — carries the intake gate
  forward)](./0037-deepen-first-re-read-against-consumer-pull.md),
  [ADR-0039 (LLM/Bedrock deferral — the precedent this ADR follows for both
  the engine deferral and the closed LLM item)](./0039-llm-integration-out-of-scope.md),
  [ADR-0042 (script CLI package deferral — same wave, same gated-broadening
  pattern)](./0042-script-cli-package-deferred.md).
- Source evaluation: `docs/plans/archive/2026-08-13-post-comparison-hardening-wave.md`
  §9.
- Capability reference: [`core/json`](../reference/core/json.md).
