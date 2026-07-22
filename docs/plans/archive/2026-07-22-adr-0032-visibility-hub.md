# ADR-0032 visibility hub — dashboard, Pages deploy, and sync scripts

**Status: shipped** — PR #187 (`feat/project-hub`: `bin/gen-project-hub.mjs`
dashboard generator + `pages.yml` superseding `pages-commit-stats.yml`) and
PR #188 (`feat/project-hub-sync`: `bin/lib/hub-sync.mjs` planners +
`bin/sync-hub-issues.mjs`/`bin/sync-hub-projects.mjs` maintainer-run runners).

## Context

ADR-0032 (Accepted 2026-07-18) mandates a comprehensive GitHub-native
visibility hub: a GitHub Pages site as the primary derived view over the whole
doc corpus, plus GitHub Projects v2 and Issues/Milestones as one-way,
read-only secondary projections whose drift is corrected by the next sync run.
The addendum's endpoint-badge slice shipped first (PRs #185/#186); the hub
itself was the last unscheduled ADR-0032 item (ROADMAP gated-P2 row,
IMPLEMENTATION gated row). This plan implemented it.

## Approach / Decisions

- **Hub shape** (open question resolved): a lightweight hand-rolled
  dashboard — tracker tables (`ROADMAP.md`, `IMPLEMENTATION.md`,
  `implementation-status.md`) lifted into live HTML, everything else (ADRs,
  work logs, archived plans, reference pages, READMEs) indexed and linked to
  GitHub blob URLs. Zero new dependencies; a pure-builder lib
  (`bin/lib/project-hub.mjs`) plus a thin I/O runner, per the repo's
  generator anatomy (ADR-0030 `--json` reporter contract).
- **One Pages site per repo**: each deploy replaces the whole site, so
  `pages.yml` builds the commit-stats endpoint JSON **and** the hub in one
  job uploading one `dist/` artifact — the hub at `/`, badges at
  `/commit-stats/` — and deletes `pages-commit-stats.yml` in the same PR to
  stop two `concurrency: pages` workflows alternate-clobbering each other.
- **Loud-failure parsing**: tracker extractors return structured `errors` on
  a missing section/table and the runner exits 1 — a renamed heading fails
  the Pages run visibly instead of shipping a silently thin dashboard.
  Cells split on unescaped pipes and header-name column lookup keep the
  parsing prettier- and reflow-resilient.
- **Sync venue correction** (dated ADR Update): the Actions `GITHUB_TOKEN`
  has no Projects v2 scope, so under the ADR's no-new-secrets driver the
  sync scripts are local and maintainer-run (`pnpm sync:hub`, one-time
  `gh auth refresh -s project`), never wired into CI.
- **Safety by construction**: `planIssueSync` matches issues only by the
  `<!-- m3l-hub-sync:<key> -->` body marker — markerless human issues land
  in `untouched` and can never be edited or closed. Planners are pure and
  dry-run is the default; `--apply` executes, `planMilestones` is
  create-only, and the board never archives a card whose issue it does not
  track.
- **Custom domain**: deferred; the site stays at
  `monte3l.github.io/m3l-automation`.

## Outcome

PR #187 shipped the dashboard generator (65 tests) and the superseding
`pages.yml`; post-merge verification confirmed the hub renders at the site
root and `/commit-stats/aggregate.json` survived the whole-site replacement.
PR #188 shipped the planners (53 tests), the two runners, and the
`sync:hub-issues`/`sync:hub-projects`/`sync:hub` scripts. Related records:
the ADR's 2026-07-22 Update note (token correction, resolved dashboard
shape, deferred domain) in
[`docs/adr/0032-project-management-visibility-hub.md`](../../adr/0032-project-management-visibility-hub.md),
and the endpoint-badge slice's plan in
[`2026-07-22-commit-stats-endpoint-badges.md`](./2026-07-22-commit-stats-endpoint-badges.md).
