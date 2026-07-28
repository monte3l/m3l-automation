# W5 — config-accessor / input-file-reader fleet retrofit (2026-07-28)

**Status: shipped** — PR 1 (`feat/core-config-read-helpers`, #260) and PR 2
(`refactor/config-accessor-fleet-retrofit`, this PR)

## Context

`/starting-work` was invoked against `docs/ROADMAP.md` +
`docs/plans/IMPLEMENTATION.md`. Both trackers were stale: PR 1 had already
shipped `Core.M3LConfigAccessor` (`core/config`) and
`Core.M3LInputFileReader` (`core/files`) — promoted from the defensive
config-read/input-file-read helper family hand-duplicated across the consumer
fleet — but no consumer had adopted either class, and neither the W5 row nor
a new tracker row recorded the promotion. Auditing the actual duplication
surface found `pnpm check:dup` at 3.95%/124 clones (up from a 3.93%
pre-PR-1 baseline, since PR 1 only added code) across three distinct
clusters, of which this helper family was one; the fleet-wide **F10**
finding (a `JSON.parse` `SyntaxError` chained as `cause`, leaking malformed
file content into a persisted `run-report.json`) was also still open and
directly closeable by adoption.

## Approach / Decisions

- **Scope split by fit, not by file count.** Of 13 duplicate sites, only 6
  were a clean 1:1 fit for the new classes (verified by exact call-site and
  message comparison before dispatch): `eks-ops`, `ecs-ops`,
  `cloudformation-stacks`, `codepipeline-ops`, `lambda-ops`, and a partial
  `s3-objects` (3 of 5 local helpers — its two required-variant readers have
  no library equivalent). The remaining 7 sites (a `write-*.ts` record-field
  reader cluster, 3 required-variant scripts, 3 differently-shaped `as*`
  narrowers, and `eventbridge-schedules`'s non-adopted silent-fold behavior)
  were surveyed and filed as new `Deferred` rows rather than forced or
  silently dropped.
- **2-PR chain**, mirroring the `M3LCheckpointStore` promotion's shape: PR 1
  shipped the library classes alone; PR 2 retrofitted the 6 fitting scripts
  onto them, deleting `eks-ops`'s `steps/config-helpers.ts` outright (the
  file the classes were promoted from).
- **Per-script `DispatchDeps` threading, not a shared module-level
  instance.** Each script already threaded `paths`/`logger` through its own
  dependency interface into every dispatch function; `accessor`/`reader`
  were added to that same interface and constructed once per run, matching
  the existing pattern rather than introducing a new one.
- **`codepipeline-ops`'s pre-existing two-code split was preserved, not
  collapsed.** Every other script uses one `ERR_<NAME>_CONFIG` code
  throughout; `codepipeline-ops` alone documents a separate
  `ERR_CODEPIPELINE_OPS_INPUT` for input-file failures. A first dispatch pass
  (following the 5-script single-code template) collapsed this into one
  code; the hub caught it via a post-dispatch check against the documented
  contract (not the gates, which all passed clean on the wrong code) and
  fixed it via a `SendMessage` resume of the same spoke.
- **Two intentional behavior deltas, stated up front rather than discovered
  in review**: `readJSON`'s parse-failure throw never chains the raw
  `SyntaxError` (the F10 fix), and `asRecord` newly screens every top-level
  decoded-JSON key with the existing `isDangerousKey` guard. Both are the
  library's own documented contract, not a per-script judgment call.

## Outcome

`pnpm check:dup` went 3.95%/124 clones (pre-PR-2) → 3.32%/99 clones
(post-PR-2). F10 closed at all 4 confirmed sites, each with a new
regression-lock test. 10 new tests (2 per adopting script with a reader);
full suite 5695/5695 passing. All gates clean: `typecheck`, `lint`, `build`,
`test:coverage` (97.9%/94.83%/99.57%/98.53%, unaffected), `check:script-deps`,
`check:script-scaffold`, `knip`, and the full `/syncing-docs` 14-step
composite. 4 new `Deferred` rows filed in `docs/plans/IMPLEMENTATION.md` §
Gated library modules for the out-of-scope clusters, so a future promotion
pass starts from evidence. One durable lesson — a templated dispatch prompt
needs a per-target _assumption_ check, not just a per-target file-list
check — promoted into `.claude/rules/subagent-dispatch.md`. Full narrative,
the codepipeline-ops incident, and lessons: `docs/logs/2026-07-28-w5-config-accessor-fleet-retrofit.md`.
