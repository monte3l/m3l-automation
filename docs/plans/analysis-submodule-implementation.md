# Plan: Implement the `analysis` Core submodule

## Context

The audit confirmed `analysis` is **spec'd but unimplemented**:
`docs/reference/core/analysis.md` is a complete, authoritative contract, the
submodule is listed in the `src/core/index.ts` barrel comment but **not**
exported, has no `src/core/analysis/` directory, no test file, and no provenance
sidecar. `docs/implementation-status.md` correctly marks it `❌ ❌ ❌` (Phase 2,
dependency-free). The user chose to implement `analysis` now (it has no
dependency on the Phase-1 `json` module) and to keep scope to this submodule
only — the secondary doc-drift findings (stale RED-phase test headers,
status-doc test counts) are explicitly out of scope.

This is an `implement-submodule` task, **not** `new-subpath` scaffolding — the
spec page already exists. The work runs the repo's hub-and-spoke TDD pipeline.

## Contract (from `docs/reference/core/analysis.md`)

Four public exports, surfaced via the `./core` namespace (no new `exports`
subpath):

- `M3LThresholdEvaluator` — class with `evaluate(rules, rows)` → `M3LThresholdEvaluation`.
- `M3LThresholdRule` — `{ name, field?, operator, value, aggregation, severity }`.
  - `operator`: `>` `>=` `<` `<=` `==` `!=`
  - `aggregation`: `any-row` `count` `sum` `avg` `min` `max`
  - `severity`: `info` `warning` `critical`
- `M3LThresholdRuleResult` — per-rule outcome.
- `M3LThresholdEvaluation` — `{ breached, summary, results }`.

Key behaviors the tests must pin:

- `any-row` tests each row individually (breached if any row matches); the
  reducing aggregations (`count`/`sum`/`avg`/`min`/`max`) collapse the column to
  one number first, then apply the operator.
- Every rule is evaluated independently — no short-circuit; `results` always
  covers every rule.
- `severity` classifies but does not gate `breached` — any breached rule sets
  the overall flag.
- **Locale-aware numeric parsing**: comma-decimal inputs (e.g. `"1,5"` → `1.5`)
  parse correctly. Check `src/core/utils/` (formatting/guards) for an existing
  numeric-parse helper to reuse before building a new one.

## Implementation (run via the `implement-submodule` skill / pipeline)

The `implement-submodule` skill encodes this loop end-to-end; invoke it for
`analysis`. The phases it drives:

1. **Contract seed** — `spec-conformance-reviewer` (producer mode) reads
   `docs/reference/core/analysis.md` and enumerates the exact symbols + behavioral
   contracts. This becomes the test brief.
2. **RED (tests-first)** — `test-author` writes `packages/m3l-common/tests/analysis.test.ts`:
   happy + failure path per export, `expectTypeOf` for the rule/result shapes,
   table-driven cases across operators × aggregations, and explicit locale-parse
   cases. Tests must fail for the right reason (module unresolved) before GREEN.
3. **GREEN (implement)** — `submodule-implementer` writes `src/core/analysis/`:
   - `index.ts` (barrel — named exports only, `.js` extensions)
   - implementation file(s), e.g. `M3LThresholdEvaluator.ts` plus the rule/result
     types co-located with the values they describe
   - throw `M3LError` subclasses for invalid rules (unknown operator/aggregation);
     never bare strings; chain `cause` where relevant.
4. **Wire the barrel** — add `export * from "./analysis/index.js";` to
   `src/core/index.ts`, placed to match the existing ordering.
5. **Review** — `code-reviewer`, `type-design-analyzer`, and
   `spec-conformance-reviewer` (conformance mode) on the diff. No `any`, no `!`,
   TSDoc + `@example` on every export.

## Doc / metadata reconciliation (after GREEN)

- Update `docs/implementation-status.md`: flip the `analysis` row to `✅ ✅ ✅`
  (or current phase), record test count + coverage, mirroring the existing rows.
- Run `/sync-docs` to create/stamp `docs/reference/core/analysis.provenance.json`
  against the shipping commit and reconcile doc counts. The doc-page count stays
  22 (analysis.md already existed), so `check:doc-counts` needs no prose edits.
- Commit as `feat:` (new public surface → minor bump). The new exports are a
  semver event surfaced through the existing `./core` entry — the three-entry
  `exports` map is unchanged.

## Verification

- `pnpm vitest run tests/analysis.test.ts` — new suite green.
- `pnpm typecheck` — strict, no errors.
- `pnpm lint` — clean (ESLint + import `.js` rules).
- `pnpm test:coverage` — ≥ 80% across lines/functions/branches/statements
  (read `coverage-final.json`, not the v8 text table, to confirm `analysis` is
  covered).
- `pnpm build` — tsc emits `dist/` `.js` + `.d.ts` for `analysis`.
- `pnpm check:scaffold` — `src/core/analysis/index.ts` exists and is re-exported.
- `pnpm check:doc-counts` and `pnpm check:provenance` (and `check:doc-sync`) —
  pass with the new provenance sidecar.
- `pnpm check:api` — exports snapshot updated to include the four new symbols.
