# X8 self-telemetry + retention — re-planned slices 2–6

**Status:** active. Supersedes the six-slice shape sketched when X8 opened.
Slice 1 has shipped and been measured, and the measurement does not fit the
original slicing.

All sizes in this file were measured at commit `efd99295`. They move: the
console server's `src/main.ts` grew 320 bytes between this plan being
sketched and being written. Re-measure before acting on any row.

## Predecessors

Referenced, not superseded:

- `docs/plans/2026-08-20-m3l-console.md` § X8 — the programme row and its
  decision pointer. Still the authority on _what_ X8 delivers.
- `docs/adr/0070-console-audit-and-observability.md` — the decision this
  plan sequences. No decision in it is changed here.
- `docs/logs/2026-09-03-x8-telemetry-store.md` and
  `docs/logs/2026-09-03-x8-telemetry-guard-followups.md` — slice 1's record,
  including the seven defects found after every mechanical gate passed.
- `docs/plans/IMPLEMENTATION.md`, row `X8 — self-telemetry + retention`
  (currently `To Do`). This plan does not flip it; see § Tracker.

This file re-plans **sequencing and PR grain only**.

## Why re-plan

Slice 1 was deliberately the smallest slice X8 had: store foundation only,
no instrumentation, no endpoints, no retention, and no file near the
`check:file-budget` ceiling. It still came out at roughly twice the
authoring target.

Measured from its landing commit `c5bce197`:

| Metric                               | Slice 1 actual                                                     |
| ------------------------------------ | ------------------------------------------------------------------ |
| Files changed                        | 14 (6 src, 8 test)                                                 |
| Added lines                          | 4,325                                                              |
| Added characters                     | 166,647                                                            |
| Reviewable characters                | ~2.3x the 75,000-char soft target (`bin/check-review-size.mjs:58`) |
| Test share of added lines            | 3,021 of 4,325 — **70%**                                           |
| Commits                              | 3 (one unplanned validation-fix round, one untested-fix round)     |
| Defects found after all gates passed | 7, by pre-push review spokes                                       |
| Spoke truncations                    | 4, all at the 40-turn ceiling                                      |

Slice 1 landed as three merged pull requests — the rollup store itself (v9),
a guard-rename tail, and the work log: PRs numbered 917, 931 and 933.

### The budget this implies

At slice 1's density — 166,647 characters over 4,325 added lines, about 38.5
characters per line — the 75,000-character soft target works out to roughly
**2,000 added lines per PR, tests included**. Since any slice adding a metric
class pays slice 1's 70% test ratio, that is about 600 lines of production
code per PR.

Slices 2–5 as originally written each bundle well past that. Hence: **one
metric class or one capability per PR**.

## The re-sliced sequence

Eleven PRs, each independently reviewable and revertable. A file with under
roughly 1,000 bytes of headroom against `SRC_CEILING_BYTES = 25_000`
(`bin/check-file-budget.mjs:50`) cannot absorb a new capability, so the
paying extraction is named in the row rather than discovered at push time.

| PR  | Scope                                                                     | Principal file, headroom at `efd99295`                                      |
| --- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 2a  | Telemetry recorder port + seam, no wiring                                 | new files only                                                              |
| 2b  | HTTP latency + error-rate instrumentation                                 | `src/http/handler.ts` 24,725 — **275 bytes**; carries the paying extraction |
| 3a  | Script-run duration                                                       | `src/runs/executor.ts` 19,270 — 5,730                                       |
| 3b  | SSE stream counts                                                         | `src/http/stream-writer.ts` 20,867 — 4,133                                  |
| 3c  | Policy posture + store health                                             | `src/runs/policy.ts` 4,125 — ample                                          |
| 4a  | Telemetry query read path                                                 | reverses `docs/reference/console.md:60`                                     |
| 4b  | The 13th `M3LHumanActionKind`                                             | needs its own migration — see below                                         |
| 5a  | Retention policy declarations + telemetry rollup/prune                    | —                                                                           |
| 5b  | Session-artifact + run-output sweep                                       | `src/sessions/artifacts.ts` 24,525 — **475 bytes**                          |
| 5c  | Operator cleanup subcommand                                               | `src/main.ts` 23,266 — 1,734; carries the paying extraction                 |
| 6   | Close-out: ADR-0070 dated Update, tracker flip, `/syncing-docs`, work log | the flip lands here and nowhere else                                        |

### Two files not in the original census

- `packages/m3l-cli/src/main.ts` is at 24,445 — **555 bytes**. Tighter than
  every row above except `handler.ts`. Any PR touching the CLI surface pays
  an extraction, and PR 5c's operator subcommand is the likely one.
- `packages/m3l-console-server/tests/main.test.ts` is at 59,458 against
  `TEST_CEILING_BYTES = 60_000` (`bin/check-file-budget.mjs:52`) — **542
  bytes**. Any PR adding a case to it must extract first. Note the three
  sibling `main-*.test.ts` files carry explicit comments saying their shared
  helpers are duplicated rather than imported, so an extraction has to
  reckon with that stated intent instead of silently reversing it.

### PR 4b is larger than a vocabulary change

The original slicing treated the 13th `M3LHumanActionKind` (ADR-0070 audits
_views_) as a type widening. It is not, and the difference is a migration:

- `M3LHumanActionKind` has **12** members today
  (`packages/m3l-console-server/src/audit/record.ts:74-86`).
- `console_human_actions.action` carries `CHECK (action IN (...))`
  enumerating them (`src/store/migrations/human-actions.ts:54`), and SQLite
  cannot `ALTER` a `CHECK` (`human-actions.ts:10-15`). A 13th kind therefore
  needs a new `CHECK`-widening migration on the v7/v8 model.
- Grepping an existing member, `view.run.report`, finds **8** sites: four
  under `src/`, four under `tests/`. Grep the member; do not trust a census.

That recreate is safe as a bare `DROP` and recreate, but for a reason that
must be re-verified rather than assumed. `human-actions.ts:108-122` records
that v7/v8 are non-lossy _because_ `rebuildHumanActionIndexOnBoot` fires on
exactly the empty-index-beside-a-populated-trail state a recreate leaves
behind, and it instructs the next author to "Re-check that the trigger
exists before copying this one's shape." At `efd99295` the trigger exists
and `tests/boot-audit-rebuild.test.ts` covers it.

### Doc statements each PR retires

Several shipped reference statements describe X8's absence as deliberate.
Each is a forward reference its PR must retire, not a doc bug:

- `docs/reference/console.md:60` — telemetry summaries "remain deliberately
  absent" (PR 4a).
- `docs/reference/console.md:462` and `:927` — the data directory "is
  cleared by hand"; the age-based sweep and cleanup command are "X8's"
  (PRs 5a–5c).
- `docs/reference/console.md:985` — stream retention's owner named as "X8's
  retention regime" (PR 5a).

## Open decisions

Neither blocks PR 2a.

1. **Where audit-segment pruning lives** — `m3l-common`'s `core/storage` as
   an additive minor, which is a semver event and needs plan mode per this
   repo's task workflow, versus a console-server-local sweep with no library
   change. Owner: PR 5a.
2. **Whether the `outcome` vocabulary gains a `CHECK`** — independent of the
   counter-measure `CHECK` shipped as v10, which is settled.

## Tracker

The `X8 — self-telemetry + retention` row in `docs/plans/IMPLEMENTATION.md`
stays `To Do` until PR 6, which flips it in the same PR that lands the
close-out docs. Every PR in this sequence references issue 556 with `Refs`
and never a closing verb: a closing verb anywhere in a PR _body_ links the
issue and pre-empts `pnpm sync:hub`, which then reports "in sync" while the
row still reads `To Do`.

## Verification, per PR

Not once at the end:

- `pnpm verify`, **plus** the `bin/tests` suite under
  `vitest.bin.config.ts` — `verify` is not `pre-push`, and a green `verify`
  has coexisted with a failing push.
- `pnpm test:coverage`, never `pnpm test` — the per-file thresholds run only
  in the coverage task.
- `pnpm check:file-budget` **before** designing any edit that grows
  `handler.ts`, either `main.ts`, `artifacts.ts`, or `main.test.ts`.
- `pnpm check:host-resources` before each push. A timing-out five-second
  test is contention: retry it. Never `--no-verify`, never raise the
  timeout.
- Pre-push review spokes on every `src/**` diff. Slice 1's seven defects all
  survived the mechanical gates, and arming auto-merge closes the review
  window the moment checks pass.
- Assert `closingIssuesReferences` is empty on every PR before merge.
- Do not push into a PR that is already merging. A push racing a merge
  re-creates the deleted branch and reports success while the commit lands
  nowhere; PR 1 of this wave lost its review-findings commit that way.
