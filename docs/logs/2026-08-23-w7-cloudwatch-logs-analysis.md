# W7 — `cloudwatch-logs-analysis` (issue #466)

**Date:** 2026-08-23
**Item:** W7 of the consumer fleet (P1) — the named consumer opening ADR-0046's intake gate
**Decision of record:** [ADR-0076](../adr/0076-codified-runbook-analysis-presets.md); engine from [ADR-0046](../adr/0046-codified-procedure-engine.md)
**Contract:** `docs/reference/scripts/cloudwatch-logs-analysis.md`

## What shipped

A fifteenth consumer script. Given an alarm name and the time it fired, it
walks the runbook's evidence chain and reaches an operator verdict.

The design question was **where code stops and data starts**. The corpora this
was designed against are not many procedures — they are _one analysis spine_
with optional stages, instantiated per alarm. So the spine is codified
(`AnalysisShape["stepId"]` is a closed ten-member union; jump targets and
build-time cycle detection stay compile-checked) and the known-cases table is
preset data (`caseId` is `string`, so rows are declared in a loop).

Four operations. `analyze` reaches AWS through `M3LLogsInsightsClient` — no new
wrapper. `validate`, `explain` and `convert` are offline and need no
credentials, which is what makes `validate` a CI gate.

12 `src/` modules, 3 example presets, 174 tests across 13 files. Library
untouched; `check:api` did not move.

## What went as planned

- **"No new AWS wrapper needed" held.** The whole spine is Logs Insights
  queries. Everything that would have needed another wrapper — metric graphs,
  table lookups, ticket creation — is downstream of the verdict and ships as
  report follow-ups, which is exactly the boundary that kept the claim true.
- **1-PR scope held.** `check:review-size` measured 234,783 chars against a
  300,000 ceiling, so the ADR-0072 fallback split was not taken. It is 3× the
  75,000 soft target, though — see Follow-ups.
- **The engine's features were exercised genuinely, not decoratively.** The
  ladder needed `goTo` + `loop`/`maxRevisits`; the trace chain needed a
  self-jump capped by depth; a missing correlation key needed `stop`; case
  specificity needed unique `priority`; "why not the other cases" needed
  `investigated`; the operator choice needed `decide` + `M3LPrompt`. None of
  these was reached for to tick a box.

## What diverged

- **The plan's step ordering had a control-flow bug.** It put `jumpsTo`/`loop`
  on `widen-severity` and placed that step _after_ `gather-entry`. But
  `check-entry-evidence` returning `"continue"` runs the next step in
  declaration order — which would have been `widen-severity`, widening the
  severity on the **success** path. Fixed by moving `widen-severity` ahead of
  `gather-entry` and putting the loop on `check-entry-evidence`: identical
  semantics, correct linear fall-through, and the back edge still originates
  from a step carrying `loop` so it stays excluded from cycle detection.
  Recorded in ADR-0076 rather than silently corrected.
- **`.case()` cannot be chained when `caseId` is `string`.** `Exclude<string,
"x">` is still `string`, which is what makes the loop work — but `.case()`
  narrows by `Exclude<TPending, TId>`, and with `TId` inferred as `string` the
  _first_ chained call collapses the pending union to `never`. Every row has to
  be declared one assignment at a time through an annotated binding. The loop
  was the design; the chain being impossible was not anticipated.
- **`no-param-reassign` forced a better evidence collector.** The gather steps
  originally assigned `context.deps.evidence.entryRows = rows`. The lint rule
  is right: a step receives its context frozen and should not assign through
  it. `AnalysisEvidence` became a closure-backed recorder with read-only
  accessors and three named methods, which reads better and makes "record what
  this stage gathered" an operation the collector owns.
- **Knip's script scope is `src/**` traced from `src/main.ts` — tests do not
  count.** Nine symbols exported for readability were dead surface by that
  measure. Eight were un-exported; `ANALYSIS_VERDICTS`, once un-exported, was a
  value used purely as a type and became a plain union. `AnalysisDeps` stayed
  exported and gained a real use (naming the bag `analyze-alarm` builds instead
  of an inline literal at the `run()` call site).
- **`M3LJSONFileExporter` does not create its parent directory.** Harmless for
  the fleet, where `data/output` already exists — but this script's documented
  workflow points `M3L_OUTPUT_DIR` at an operator's own store, where a first
  run would have failed with a bare write error. Added `write-artifact.ts`,
  used by both write sites.
- **The console renders a `logger.info` message but not its data bag.** The
  `explain` digest and the report's evidence counts were invisible until they
  were moved to `logger.text` with inline rendering. Worth knowing before
  putting anything operator-facing in a data bag.

## Confidentiality

The design derives from operator runbooks held in an untracked working
directory. Nothing from that material is in the repository. Two mechanical
sweeps ran before the push, both scripted rather than eyeballed:

1. **Vocabulary diff** — every token in the corpora, minus every token already
   present at `origin/main`, intersected with everything this branch adds
   (diff + commit messages + branch name). Nine survivors, all generic domain
   vocabulary (`authorizer`, `runbook`, `ticket`, `traceId`, standard error
   class names). One earlier hit — a ticket-tracker product name in a column
   matcher — was removed; `ticket|issue|reference` matches the same columns.
2. **Structured identifiers** — account ids, ARNs, UUIDs, IPs, URL hosts,
   emails, log-group paths and ticket ids. The corpora hold 12 / 20 / 157 / 4 /
   52 / 1 / 729 / 134 of each; **zero** appear in the branch. Every identifier
   in the diff is an `example-*` placeholder.

The directory was also absent from `.gitignore`, `.prettierignore` and the
`lint:md` exclude, so `git add -A` would have staged it and both
`pnpm format:check` and `pnpm lint:md` already failed against its 168 files.
All three exclusions landed first, as their own commit.

## Re-derived claims

The issue body was stale, and two of its claims drove the plan's shape:

- **"Depends on B2" read as blocking.** B2 is Done —
  `docs/plans/IMPLEMENTATION.md:285`, shipped across six PRs
  (#580, #582, #583, #585, #586, #587). W7 was never blocked.
- **`docs/ROADMAP.md`'s B2 row said `To Do`.** Verified against the live hub:
  B2's synced row is the `IMPLEMENTATION.md` one (`impl:procedure:b2`,
  issue #474, closed), and no `roadmap:B2` key exists — so that row drives no
  issue, which is why it drifted unnoticed. It is what made #466 read as
  blocked. Fixed here.

Both were settled by reading current repo state and querying the hub, not by
trusting the authored text — the failure mode `docs/logs/2026-08-19-hub-sync-key-namespace.md` records.

## Follow-ups

- **Flipping W7 to Done resolves the last unresolved Priority-1 roadmap row**,
  so `epic:roadmap:p1` (#605) has no unresolved children left and drops out of
  the hub projection. `pnpm sync:hub -- --apply` will close both #605 and #466
  after merge; until it runs, main's push-only `check:hub-drift` reports the
  two.
- **234,783 reviewable chars is 3× the ADR-0072 soft target.** Under the
  ceiling, so the gate passes, but a future consumer of this size should
  consider the docs-vs-code split axis up front rather than measuring at the
  end.
- **A live `analyze` has not been run.** It needs a real profile and real
  presets, so it is out-of-repo maintainer verification. Offline coverage is
  `validate` + `explain` + the `convert`→`validate` round trip + 174 tests
  against a fake gatherer.
