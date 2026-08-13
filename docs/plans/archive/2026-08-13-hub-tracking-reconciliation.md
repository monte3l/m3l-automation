# GitHub hub tracking reconciliation

**Status: shipped** — commits `4205a2d`, `cf61b85`, `fefa210`, `472abfa`,
`04707b0`, `99e000f`, `4ee0571` on `fix/hub-tracking-reconciliation`.

## Context

A tracker-reconciliation audit (`/auditing`, 3-facet Explore fan-out plus
direct GitHub API inspection) compared `docs/ROADMAP.md`,
`docs/plans/IMPLEMENTATION.md`, and all 43 ADRs against live GitHub state.
The library and consumer fleet are genuinely finished (W1–W5 closed, 39/39
submodules Done), but the hub had gone silently stale: no `sync:hub` run
since 2026-07-30, so two full waves of tracker updates (PRs #313–#332) had
zero GitHub representation. Two compounding causes: the sync's extractor
never registered the two newest tracker tables (capability-deepening,
post-comparison hardening), and nothing detected the resulting drift.
Separately, several rows misstated their own source ADRs, doc-count drift
had recurred a second time after a prior audit's fix was deferred, and
GitHub could not distinguish a Deferred/Blocked item from a plain To Do.

## Approach / Decisions

1. **Sync blind spot — extend the extractor, then guard it.** Registered the
   two missing headings in `bin/lib/project-hub.mjs`; added
   `findUncoveredStatusHeadings` and a new `check:tracker-coverage` gate so a
   future tracker table can never silently go unparsed again — the durable
   fix, not just a one-time extend.
2. **Untracked work — file it, don't just note it.** 10 new Gated-table rows
   for ADR-mandated and work-log-promised items that were never filed
   (ADR-0034 debt, ADR-0039's style-guide follow-up, ADR-0042's 8f
   prerequisite, the `@deprecated`-getter removal, the pending
   branch-protection change, and five smaller cadence/precedence gaps).
3. **Two rows inverted their own ADR.** ADR-0031 was still `Status: Proposed`
   despite a definitive Decision; both trackers rejected its `aws/rds-data`/
   DocumentDB rows on the claim "ADR-0031 already dropped `pg`/`mongodb`" —
   backwards, since ADR-0029 dropped those and ADR-0031 re-admits Aurora.
   Flipped the ADR to Accepted and both rows to Deferred on the real gate.
   ADR-0015 got a dated Update reconciling its still-live SBOM/coverage-gate
   language against ADR-0020 and PR #325.
4. **Doc-count drift recurred a second time.** The 2026-07-28 predecessor
   plan deferred extending `count-sites.mjs` to the specific prose sites it
   fixed by hand; this session found the same class of drift a third time
   (`implementation-status.md`'s AWS count, two separate "N/M ledger"
   phrasings) and closed the loop by extending `count-sites.mjs` instead of
   hand-fixing again.
5. **GitHub couldn't express Deferred/Blocked.** Added `status:deferred`/
   `status:blocked` labels, widened `planIssueSync`'s dirty-check
   (`managedLabelsDiffer`) so a status-only change actually reaches
   `editIssue`, and added `Governance`/`2.0 / breaking` milestones (every
   item now resolves to a real milestone).
6. **Prevent recurrence: a CI alarm, scoped carefully.** `check:hub-drift`
   runs the sync in `--check` mode and fails on a non-empty plan — but
   `issues: read` is genuinely needed for it, and putting it in `pull_request`
   scope would block unrelated PRs whenever the hub drifted. Scoped `push`-only
   on `main` instead: an alarm, not a merge gate.
7. **User-requested additions mid-plan:** a one-time `--backfill` mode
   (`planBackfill`, Levenshtein-based collision guard against duplicate
   issues) to retroactively file the ~54 historically-Done rows the sync's
   go-forward-only design had always skipped — explicitly out of scope in
   the 2026-07-28 predecessor, reconsidered here — and confirming the
   `m3l-common` version (2.0.0, unmoved since PR #312) against 19 unbumped
   commits before bumping to 2.1.0.

Two incidents mid-session, both caught and resolved before landing: an
accidental `--apply` while sanity-testing flag combinations created one real
GitHub label (harmless, part of the intended end state); a `test-author`
spoke ran `git stash` mid-task and briefly reverted 23 in-progress files,
fully recovered and independently re-verified against the stash.

## Outcome

Seven commits: tracker/ADR drift fixes, the `count-sites.mjs` extension, the
core `sync:hub` feature (extractor registration, labels/milestones, CI gate,
backfill), the ADR-0032 documentation Update, skill cadence notes, test
coverage (874/874 passing across `bin/tests/`), and the version bump. All
quality gates (`lint`/`typecheck`/`test:coverage`/`build`/every `check:*`
gate/`lint:md`/`knip`) pass; `pnpm verify` reproduces CI's full `verify` job
clean (36 steps passed, 3 legitimately skipped). No `packages/*/src` or
`exports`-map change; zero semver-breaking impact.

The maintainer ran `pnpm sync:hub -- --apply` and
`pnpm sync:hub-issues -- --apply --backfill` after this branch's dry-run
output was reviewed.
