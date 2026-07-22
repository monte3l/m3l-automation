# Commit-stats endpoint-badge migration — PR 1 (ADR-0032 addendum)

**Status: PR 1 shipped** — `feat/commit-stats-endpoint-badges` (endpoint
generator + `pages-commit-stats.yml` Pages deploy); **PR 2 (README URL swap +
old-write-path removal) pending** a later session.

## Context

The AI co-authorship badges in `README.md` are static shields URLs regenerated
by `bin/gen-commit-stats.mjs` and refreshed post-merge (main-only, ADR-0024) by
`bin/post-integrate-regen.mjs`. The regen deliberately never auto-commits, so
every merge that moves the counts leaves `README.md` dirty and forces a human
`docs: reconcile commit-stats badges` commit — recurring pure-noise history
churn (the session that produced this plan started with exactly that dirty
README sitting on `main`; it landed as PR #184 before this branch was cut,
because branch protection allows no direct pushes).

ADR-0032's 2026-07-19 addendum mandates the fix: shields.io **endpoint badges**
backed by JSON computed in CI on every push to `main` and published via GitHub
Pages as an artifact deploy — no git commit, no new secrets, `GITHUB_TOKEN`
only. The addendum's rollout order is binding: PR 1 lands the generator +
workflow with README untouched, PR 2 swaps the README URLs and removes the old
write path, so `main` never references a not-yet-existing JSON URL.

## Approach / Decisions

- **`bin/gen-commit-stats-endpoint.mjs`** imports `countCommitsByModel()` /
  `countTotalCommits()` from `bin/gen-commit-stats.mjs` (byte-identical in
  PR 1) and emits one shields endpoint-schema JSON per badge to
  `dist/commit-stats/`: `aggregate.json` plus one per canonical model. Pure
  builders (`modelSlug`, `endpointPayload`, `buildEndpointPayloads`) are
  unit-tested (14 tests, TDD red→green via test-author / code-implementer
  spokes).
- **Emit ALL canonical models, including zero-count ones** — divergence from
  `buildBadgeBlock` (which skips them) so PR 2's static README URLs resolve
  before a model's first commit. Whether zero-count badges render is PR 2's
  call.
- **`.github/workflows/pages-commit-stats.yml`**: build job (full-history
  checkout, setup-node 24, **no pnpm install** — the generator is
  node-builtins-only) → `configure-pages`/`upload-pages-artifact` v6/v5 →
  deploy job (`pages: write`, `id-token: write`) → `deploy-pages` v5, all
  SHA-pinned. Upload path is `dist/` so the JSON is namespaced under
  `/commit-stats/`, reserving the Pages site root for the future full
  visibility-hub `pages.yml` (one Pages site per repo — that workflow must
  reuse/supersede this one).
- CLAUDE.md CI/CD table updated atomically with the workflow (Five → Six;
  `check:workflows-doc` validates bidirectionally).
- GitHub Pages was enabled during the session via
  `gh api -X POST repos/monte3l/m3l-automation/pages -f build_type=workflow`
  (the addendum's "one-time manual step", done programmatically).
- **Trackers deliberately untouched in PR 1**: the ADR-0032 rows in
  `ROADMAP.md` / `IMPLEMENTATION.md` flip once, in PR 2, when the migration
  unit actually lands (row-locality, ADR-0024).

## Outcome

PR 1 shipped on `feat/commit-stats-endpoint-badges`. Deferred to PR 2:
README badge-URL swap + marker removal + disclosure-wording update (including
README's prose pointer at `bin/gen-commit-stats.mjs`), removal of
`buildBadgeBlock`/`replaceBadgeBlock` and the `onMain` regen branch
(`isOnMainBranch()` if orphaned) with their tests, a dated ADR-0024 Update
note superseding its "gen:commit-stats moves to main-only" clause, the
`.claude/skills/resolving-merge-conflicts/SKILL.md` main-only mention, and the
tracker-row flips. Related: ADR-0032 (mandate), ADR-0024 (the churn's origin).
