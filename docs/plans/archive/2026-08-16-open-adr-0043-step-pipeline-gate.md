# Open the ADR-0043 gate — `core/pipeline` step-pipeline engine + first two migrations

**Status: shipped** — PRs #434 (engine + gate docs), #435 (`s3-objects`
migration), #436 (`ecs-ops` migration + close-out), all merged to `main`
2026-08-16; issue #334 flipped to Done and the six follow-up migration
issues minted by `pnpm sync:hub -- --apply`.

## Context

ADR-0043 (2026-08-13) deferred a step-pipeline engine — the shared
abstraction for the operation-dispatch skeleton every
`scripts/*/src/steps/run-*.ts` hand-writes — gated on a named consumer,
following the ADR-0021/0037/0039 gated-broadening pattern. On 2026-08-16
the maintainer invoked trigger (b): explicitly proposing to migrate the
ADR's own near-identical pair (`s3-objects`, `ecs-ops`) onto a shared
engine. Exploration corrected the ADR's census: 18 `run-*.ts` files
(~6,992 lines), of which 8 multi-operation dispatchers are the real
duplication target.

## Approach / Decisions

- **Gate recording:** an `## Update (2026-08-16)` section appended to
  ADR-0043 (the 0031/0042 precedent) — no new ADR; the engine's design
  contract lives in the reviewed `docs/reference/core/pipeline.md` spec.
- **Engine:** new Core submodule `core/pipeline`, surfaced through the
  `./core` barrel (no new `exports` subpath). `M3LOperationPipeline` + 7
  option/contract/outcome types: a fixed 10-phase `run()` (accessor →
  `oneOf("operation")` → settings → array-order `requiredFields` guards
  with byte-identical `requiredFor` messages → `prepare` → destructive
  gate via `confirmDestructive` → exhaustive mapped handler dispatch →
  `persist` → `finalize` → status-carrying outcome). The two existing
  decline behaviors were reified as a discriminated
  `onDecline: {kind: "throw" | "soft-land"}` policy union instead of
  picking a winner. No public error class; internal-only
  `ERR_PIPELINE_INVALID_OPTION`.
- **Type soundness (review-driven):** `prepare` conditionally required
  whenever `TContext` ≠ `undefined`; `operations` a non-empty readonly
  tuple (so `TOp` cannot widen to `string` and dissolve handler
  exhaustiveness); `TSettings extends object` — each pinned by
  `@ts-expect-error` tests. Five-generic inference from a single options
  literal was PROVEN by compile probes at contract time; the
  curried-builder fallback was declined.
- **Migrations as characterization refactors:** each script's existing
  suite frozen as the parity proof — `s3-objects` ran byte-unmodified
  (103 tests); `ecs-ops` kept all 134 assertions with only the gate
  tests' mock seam translated (barrel mock of `confirmDestructive` →
  `prompt.confirm` spy, the seam both architectures share), + 2 pins.
- **Scope discipline:** checkpoint/resume, multi-file routing, thin
  passthroughs, custom gates, and log text stayed out of the engine;
  the remaining 6 multi-op dispatchers were queued as P2 tracker rows
  gated on the recorded parity evidence, not migrated speculatively.

## Outcome

Shipped across three stacked PRs with a hub-and-spoke TDD pipeline
(scaffold → spec → contract-producer pass → RED 62 tests → GREEN →
4-spoke review + focused confirmation → docs sync). Engine: 8 exports,
72 tests, 100 % per-file coverage, dep-free; m3l-common count 40 → 41
submodules. Parity evidence for the queued migrations: net −11 lines
across both (s3-objects −52, ecs-ops +41) — the value is engine-owned
ordering guarantees and deleted dispatch machinery, not size. Narratives:
`docs/logs/2026-08-16-core-pipeline.md` and
`docs/logs/2026-08-16-pipeline-migrations.md`; decision record:
[ADR-0043](../../adr/0043-step-pipeline-engine-deferred.md) (Update
2026-08-16).
