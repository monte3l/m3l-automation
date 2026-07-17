# `M3LScript.paths` getter + `M3LPaths.resolveInput`/`resolveOutput` (F4, F5)

**Status: shipped** (commits `7d6b8ab`, `22aceff`, `30ad9aa`, branch `feat/paths-seam`)

## Context

W1 (`json-etl`, the first consumer script) surfaced a "paths seam" gap every
fleet script would otherwise re-hit. `M3LScript` held a private `M3LPaths`
instance with no accessor, so each script hand-built its own
`new M3LPaths()` (F4). And there was no library helper to join a
caller-supplied name onto the input/output directory while rejecting path
traversal, so `json-etl` had re-implemented one itself
(`resolveContainedPath`, F5). Both were additive, semver-minor changes, done
spec-first against `docs/reference/core/script.md` and
`docs/reference/core/utils.md`.

## Approach / Decisions

- Isolation: new linked worktree, branch `feat/paths-seam`, PR-required
  (guarded `packages/m3l-common/src/**` + `scripts/*/src/**`).
- Landed as three commits: (1) expose `M3LScript.paths` getter, (2) add
  `M3LPaths.resolveInput`/`resolveOutput` with a traversal guard, (3) adopt
  both in `json-etl`.
- F4: renamed the private `paths` field to avoid a name clash with the new
  getter, and added `get paths(): M3LPaths` modeled on the existing
  `get aws()` getter. No barrel change — `M3LPaths` was already public.
- F5: `resolveInput(name)`/`resolveOutput(name)` reuse the existing
  `isSafeRelativeSegment` guard from `internal/files/guards.ts` (the same one
  `M3LFileCopier` uses) rather than reinventing traversal detection. A
  rejected name throws the module's existing `M3LPathResolutionError` — no
  new error code needed.
- Consumer cleanup landed in the same PR: `json-etl`'s `main.ts` now uses
  `script.paths` instead of `new Core.M3LPaths()`; `run-json-etl.ts`'s local
  `resolveContainedPath` helper and its `ERR_JSON_ETL_PATH` throw were
  deleted in favor of `paths.resolveInput`/`resolveOutput`.

## Outcome

Both items were flipped to done in `docs/ROADMAP.md` and
`docs/plans/IMPLEMENTATION.md`, with `json-etl`'s call-sites noted as
cleared. The friction was originally logged in
`docs/logs/2026-07-11-scripts-json-etl.md`.
