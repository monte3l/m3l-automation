# Work log — `core/analysis` submodule (2026-07-01)

This log covers implementing the `analysis` Core submodule of
`@m3l-automation/m3l-common` end-to-end through the `implement-submodule`
hub-and-spoke TDD pipeline, starting from an `/audit` pass that re-validated a
stored plan before any code was written. It records what shipped, what matched
the plan, the divergences (a stored-plan premise rot, two spoke turn-limit
stalls, a converged review finding, and a prettier-vs-count-gate clash), and the
durable lessons.

Plan of record: [`docs/plans/analysis-submodule-implementation.md`](../plans/analysis-submodule-implementation.md)
(audit-corrected before execution — see divergence 1).

## Summary

Shipped the `analysis` submodule plus one shared utils helper, all surfaced
through the `./core` namespace barrel; the three-entry `exports` map is
unchanged (a `feat:` minor, not a breaking change).

- **Public exports (8, analysis):** `M3LThresholdEvaluator` (class; synchronous
  `evaluate(rules, rows)`), `M3LThresholdRule`, `M3LThresholdRuleResult`,
  `M3LThresholdEvaluation`, the `M3LThresholdOperator` / `M3LThresholdAggregation`
  / `M3LThresholdSeverity` union types, and `M3LThresholdRuleValidationError`
  (an `M3LError` subclass, literal `code = "ERR_ANALYSIS_INVALID_RULE"`).
- **New shared utils export (1):** `parseLocaleNumber` in
  `src/core/utils/numbers.ts` — comma/dot-decimal only (`"1,5"` → `1.5`,
  `"1,000"` → `1`, `NaN` on unparseable input, never throws). Documented on the
  `utils` reference page.
- **Tests:** 66 in `tests/analysis.test.ts` (54 at GREEN, +12 during review);
  full suite 719 pass. Coverage: `M3LThresholdEvaluator.ts` ~91% statements /
  89.5% branches, `M3LThresholdRuleValidationError.ts` 100% — both clear the 80%
  gate.
- **Gates:** `build`, `test`, `typecheck`, `lint`, `format:check`, `lint:md`,
  `check:scaffold`, `check:api`, `check:doc-exports`, `check:doc-counts`,
  `check:impl-counts`, `check:index` all green; `check:provenance` passes with
  expected staleness warnings for the not-yet-committed new files.
- **Review verdicts:** `spec-conformance-reviewer` CONFORMANT; `code-reviewer`
  PASS (0 Must-fix, 2 coverage Should-fix); `type-design-analyzer` no Must-fix
  (1 Should-fix); `silent-failure-hunter` FAIL → 1 CRITICAL Must-fix. The
  Must-fix and both Should-fix coverage gaps were fixed and re-verified.
- **State file:** `analysis` row flipped `❌ ❌ ❌` → `✅ ✅ ✅`; implemented
  count 6 → 7 of 22.

## What went as planned

- **Audit-first paid off.** The `/audit` pass fanned out five Explore agents and
  re-validated every factual claim in the stored plan against the live repo
  before a line of code was written — surfacing the premise rot in divergence 1
  as an up-front plan correction rather than a mid-implementation surprise.
- **RED failed for the right reason.** `test-author` produced 52 tests that
  failed with `Cannot find module '../src/core/analysis/index.js'`, not a logic
  error in the tests.
- **Spec conformance was clean on the first review pass.** The freshly-updated
  reference docs and the implementation agreed on every symbol and behavioral
  contract — CONFORMANT with no drift.
- **The implementation logic itself needed no structural rework.** Both
  turn-limit stalls (divergence 2) turned out to hide correct code; the only real
  logic fix came from the converged review finding (divergence 4), and it was a
  small additive guard.
- **Decision points were resolved before RED.** Because the spec was silent on
  several behaviors, the hub locked them with the user via `AskUserQuestion`
  before dispatching the test-author, so tests and implementation never disagreed
  on result shape, empty-input semantics, or the validation surface.

## What didn't go as planned, and why

### 1. The stored plan asserted a reusable helper and a fitting error type that did not exist

The plan said to "check `src/core/utils/` for an existing numeric-parse helper
to reuse before building a new one" and to "throw `M3LError` subclasses for
invalid rules" — implying both already existed. Re-validation during the audit
found neither did: `formatting.ts` only used `parseFloat` for byte-size output,
`guards.ts` only had the `isNumber` predicate, and the existing error subclasses
(`M3LEnvironmentDetectionError`, `M3LPathResolutionError`,
`M3LJSONFormatDetectionError`) were all domain-specific. Both had to be built.
The plan also cited a `check:doc-sync` script that does not exist.

**Why it happened:** A stored `docs/plans/*.md` is a hypothesis written at one
point in time; its "what already exists" premises rot as the repo evolves, and
its tooling references can be aspirational.

**Fix for future:** Treat every factual claim in a stored plan as possibly
rotted and re-validate against the live repo before acting — exactly what the
audit skill's step 3 and the implement-submodule step 2 already prescribe.
Confirm helper/error reuse by reading the actual files, and verify every cited
`pnpm` script exists in `package.json` before putting it in a verification list.

### 2. The GREEN implementer spoke hit its turn limit twice, mid-thought

`submodule-implementer` returned a truncated mid-sentence twice — first while
debugging an `expectTypeOf` failure, later mid-report. Rather than trust the
summaries, the hub verified on-disk state directly each time (listed files,
grepped the barrel, ran `typecheck`/`lint`/`vitest`). Both times the
implementation was actually correct and complete; the real blocker was a
**test-side** type mismatch — `toEqualTypeOf<{ ... }>()` treats a type with
`readonly` properties as unequal to one with mutable properties, and the impl
(correctly, per house style) declared `M3LThresholdEvaluation` with `readonly`
members. That fix belonged to the test-author, not the implementer.

**Why it happened:** Token-heavy rework (type-error spelunking) can exhaust a
spoke's turn before it emits a completion summary; and the writer spoke, being
forbidden from editing tests, could not resolve a test-side defect it correctly
diagnosed.

**Fix for future:** After any long writer-spoke run, verify concrete state
(files, barrel line, CLI gates) before trusting the final message — the playbook
already warns this. When a type test fails, check whether the divergence is a
`readonly`-property-modifier mismatch in the assertion before suspecting the
implementation; route it to the test-author.

### 3. The implementer left a stray scratch debug file

The GREEN spoke created `packages/m3l-common/scratch.repro.test.ts` to reproduce
the type error and did not delete it; it then tripped `pnpm lint` (parser error:
file not in the tsconfig project) and would have been an errant committed
artifact. The hub removed it.

**Why it happened:** A debug reproduction file created mid-run is easy to forget
when the run ends abruptly (see divergence 2).

**Fix for future:** After a writer spoke finishes, `git status` for stray
untracked files under `packages/**` (especially `*.test.ts` / `scratch*`) and
delete debug artifacts before the review fan-out.

### 4. Three of four review spokes independently converged on one real silent-failure

`validateRule()` checked `operator`, `aggregation`, and the field requirement,
but never checked that a rule using an **ordering** operator (`>`/`>=`/`<`/`<=`)
had a numeric `value`. A rule like `{ operator: ">", value: "abc" }` passed
validation, coerced the threshold to `NaN`, and then silently never breached (or,
for `!=`, always "breached" with a meaningless `actual`). `silent-failure-hunter`
flagged it CRITICAL, `type-design-analyzer` flagged the same coupling as a
Should-fix, and `code-reviewer` flagged the adjacent untested path. The fix was a
`validateOrderingValue` guard that throws `M3LThresholdRuleValidationError`; the
non-numeric-`value` case for `==`/`!=` stays valid (string-equality path).

**Why it happened:** The spec documents NaN-skipping for tabular **cell** data,
so the implementer applied the same tolerance to the rule's own `value` — but a
bad `value` is rule-authorship error, which the library validates elsewhere, not
data noise.

**Fix for future:** Distinguish "external data noise" (skip/tolerate) from
"caller/config error" (fail loud) when deciding whether a `NaN`/empty path should
be swallowed. Validate rule-authored inputs at the API boundary even when a
lookalike data path is intentionally lenient. Fanning multiple review lenses at
one diff is what caught this — keep the type-design + silent-failure pair on any
module with comparison/coercion logic.

### 5. Adding the 7th implemented module overflowed prettier's line width and broke the count gate

`check:impl-counts` requires the `docs/index.html` "done" names span to list the
implemented modules with exact single-space separation. Adding `analysis` (the
7th name) pushed that line to 81 characters — one over prettier's `printWidth: 80`
— so prettier wrapped it, inserting a newline+indent that broke the checker's
`trim()`-only exact-match regex. Resolved with a `<!-- prettier-ignore -->` on
the span (the first use of prettier-ignore in that file) so it stays on one line
and satisfies both prettier `--check` and the count gate. The 6 → 7 update also
touched five other sites: root and npm README badges + prose, `docs/README.md`,
and the index.html count span + module-tree marker.

**Why it happened:** The count gate compares raw inner text (no internal-
whitespace normalization), which is incompatible with a prettier line-wrap once
the content exceeds `printWidth`. The gate was only ever exercised with a
one-line list before.

**Fix for future:** When bumping the implemented count in `docs/index.html`, if
the "done" names span crosses ~80 columns, wrap it in `<!-- prettier-ignore -->`
to keep it single-line. Longer term, `check-impl-counts.mjs` could normalize
internal whitespace in the span capture so the two tools stop fighting.

### 6. Generated `catalog.json` and prettier fight over ordering

`pnpm gen:index` rewrites `docs/reference/catalog.json` in a non-prettier style,
so running `pnpm format` and then `gen:index` leaves `format:check` failing;
running `gen:index` first and `format` second is clean.

**Why it happened:** The index generator does not emit prettier-formatted JSON,
so whichever of the two runs last wins.

**Fix for future:** Always run `pnpm gen:index` **before** `pnpm format` in the
doc-reconciliation step (or fold both into `/sync-docs` in that order).

## Lessons learned

- **Re-validate a stored plan against the live repo before executing.** Its
  "already exists" premises and cited scripts rot; confirm helper/error reuse by
  reading the files and verify every `pnpm` script name exists before trusting a
  verification checklist. See [[2026-07-01-core-json]] divergence 1 for the same
  class of rot.
- **Verify a writer spoke's on-disk state; never trust a truncated summary.**
  Long type-error rework can exhaust a spoke mid-thought while the code is
  actually correct — list files, grep the barrel, and run the CLI gates yourself.
- **`toEqualTypeOf` is strict about `readonly` property modifiers.** A type with
  `readonly` members is not equal to one with mutable members; a type test that
  fails against a correctly-`readonly` implementation is a test-side defect for
  the test-author, not an implementation bug.
- **Sweep for stray debug files after a writer spoke.** `scratch*` / stray
  `*.test.ts` under `packages/**` will trip `lint` and pollute the commit; delete
  them before review.
- **Fail loud on caller/config errors, stay lenient only on external data.** A
  `NaN`/empty path that is correct for imported cell data is a silent-failure bug
  when applied to a caller-authored value — validate rule inputs at the boundary.
- **Multi-lens review fan-out catches convergent defects.** Running
  type-design + silent-failure + code-review + conformance in parallel surfaced
  one real Must-fix that three lenses independently confirmed; keep that quartet
  on any module with coercion/comparison logic.
- **`gen:index` before `format`; wrap over-width count spans in
  `prettier-ignore`.** The reference-index generator emits non-prettier JSON, and
  the impl-count gate can't tolerate a prettier line-wrap in the `docs/index.html`
  names span once it crosses 80 columns.
- **`check:api` guards the `exports` map, not the symbol list.** New symbols
  surfaced through a namespace barrel need no exports-snapshot update — only
  adding/removing/retyping one of the three subpaths does.
