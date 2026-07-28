# ROADMAP/IMPLEMENTATION drift reconciliation against the GitHub hub

**Status: shipped** — commits `39ea1b9` (docs) and `3209327` (feat) on
`fix/roadmap-gh-drift`.

## Context

An audit (`/auditing`, direct GitHub API inspection plus a 3-facet
`audit-fanout` workflow run with adversarial verification — 8/8 findings
confirmed, 0 refuted, 0 unverified) compared `docs/ROADMAP.md`,
`docs/plans/IMPLEMENTATION.md`, and `docs/implementation-status.md` against
the live GitHub state (issues, milestones, and the `monte3l` org's
"m3l-automation hub" Project v2, #2) for drift. Four themes surfaced.

## Approach / Decisions

Per the user's choices during planning:

1. **Stale citation fix.** `codepipeline-ops`'s row in `ROADMAP.md` and the
   AWS-getter-reality table in `IMPLEMENTATION.md` cited the script as
   "script on `feat/codepipeline-ops`" (reads as unmerged) though it shipped
   as PR #252 — corrected to name both PR numbers, matching the `ecs-ops`
   row's convention.
2. **Hub-sync extractor gap — extend, don't just document.** The "ADR-0035
   rollout" section (rows A1-A9) in `IMPLEMENTATION.md` was invisible to
   `bin/lib/project-hub.mjs`'s `extractImplementation()` — its heading list
   was frozen the day before that section was added, and never reconciled.
   Added a fourth `adr0035Rollout` heading entry, wired a new
   `actionableItems()` block in `bin/lib/hub-sync.mjs`, and rendered the
   section in the HTML hub page. Deliberately left `ROADMAP.md`'s own nested
   `### ADR-0035 rollout` subsection (a coarse A1-A5 duplicate) unextracted —
   the same precedent already applied to ROADMAP's Priority 2 section, whose
   IMPLEMENTATION.md counterpart is the single item source to avoid duplicate
   issues.
3. **Status-vocabulary collapse — document, don't extend the board schema.**
   The tracker's 6-value status badge collapses to the GitHub Project's
   3-value Status field via `PROJECT_STATUS_OPTIONS` in `bin/lib/hub-sync.mjs`
   — previously only a code comment. Added a dated Update to ADR-0032
   documenting the mapping and its rationale, rather than a board-schema
   change.
4. **Stale submodule counts — content fix only.** `implementation-status.md`'s
   "10 AWS submodules" (actual: 15), `README.md`'s and `docs/README.md`'s
   hand-written 24/25-name enumeration lists (actual: 36) were corrected.
   Extending `bin/lib/count-sites.mjs` to track these specific prose
   locations was explicitly deferred as a separate future item.

Explicitly out of scope (per the user): backfilling GitHub issues for
historically-Done Priority 0/1 items (a known consequence of the sync's
go-forward-only design, not new drift), and running `pnpm sync:hub` itself —
prepared but left for the maintainer to trigger, since it mutates shared
GitHub state.

## Outcome

Two commits: a `docs:` commit for the four doc-content fixes plus the
ADR-0032 Update, and a `feat:` commit for the hub-sync extractor/rendering/
`actionableItems()` wiring with new test coverage in
`bin/tests/project-hub.test.ts`, `bin/tests/hub-sync.test.ts`, and
`bin/tests/hub-sync-runners.test.ts`. All quality gates
(`lint`/`typecheck`/`test:coverage`/`build`/`check:doc-counts`/
`check:impl-counts`/`lint:md`) pass. No `src/`, test, or `exports`-map changes
to the published `@m3l-automation/m3l-common` package; zero semver impact.
