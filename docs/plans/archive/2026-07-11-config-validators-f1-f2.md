# `core/config` — `required` flag + `nonEmpty`/`minLength` validators (F1, F2)

**Status: shipped** (PR #105, branch `feat/config-validators-f1-f2`)

## Context

W1 (`json-etl`, the first consumer script, #99) surfaced two P0 friction items
in `core/config`. `M3LConfigValidators` shipped only `range`/`regex`/`oneOf`,
so every script had to hand-write `nonEmpty`/`minLength` checks — `json-etl`'s
own `nonEmptyString`/`nonEmptyStringArray` helpers (F2). And
`M3LConfigParameter` had no notion of required-ness, so presence was enforced
by imperative run-start guards like `requireString`/`requireStringArray`
(F1). Both gaps were additive, semver-minor changes, confirmed against the
live `docs/reference/core/config.md` spec before any code was written.

## Approach / Decisions

- Isolation: linked worktree `../m3l-automation-config-validators-f1-f2`,
  branch `feat/config-validators-f1-f2`, PR-required.
- F1 scope: `required: true` flag only. Deferred the cross-field seam
  (`sort⇒limit`, `sort ∈ fields`) as a new **F1b** item — it needs a
  schema-level API on `M3LConfig`/`M3LConfigSchema` and its own spec cycle.
- F1 error: a dedicated new `M3LConfigMissingError` (`ERR_CONFIG_MISSING`),
  thrown only at the true resolution fall-through (no provider value, no
  default, no async fallback) — a required param with a `defaultValue` is
  unaffected.
- F2 shape: `nonEmpty` is a bare validator value
  (`M3LConfigValidators.nonEmpty`), while `minLength(n)` stays a factory.
  Both typed to a structural `{ readonly length: number }` so they apply to
  `STRING`/`*_ARRAY` params but are a compile error on `INT`/`BOOL`.
- Failure reasons name the constraint only, never the value — preserving the
  existing redaction invariant.
- Proved the friction was actually gone by re-wiring `json-etl` in the same
  PR: `config.ts` now declares `required: true` + `nonEmpty` instead of its
  inline guards, and `run-json-etl.ts`'s hand-rolled
  `requireString`/`requireStringArray` were deleted.

## Outcome

Landed through the standard spec-conformance → RED → GREEN → review
(code-reviewer, type-design-analyzer, silent-failure-hunter) hub-and-spoke
loop. **F1b** was filed as a deferred P2 row in
`docs/plans/IMPLEMENTATION.md` for the cross-parameter validation seam. The
friction this closes was originally logged in
`docs/logs/2026-07-11-scripts-json-etl.md` ("Library friction — the F4
backlog").
