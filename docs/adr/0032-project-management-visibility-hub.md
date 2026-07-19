# 0032. Centralized project-state and roadmap visibility hub

- **Status:** Accepted (2026-07-18) — resolves the earlier undecided stance
  in favour of a comprehensive GitHub-native hub (a GitHub Pages site as the
  primary derived view over the entire documentation corpus, plus GitHub
  Projects and Issues/Milestones as one-way-synced read-only secondary
  surfaces)
- **Date:** 2026-07-17
- **Deciders:** Enrico Lionello (maintainer); Claude (research)

## Context and problem statement

`m3l-automation` tracks project state across a markdown-driven, git-native
system with no single unified view:

- [`docs/ROADMAP.md`](../ROADMAP.md) — coarse, prioritized living status
  (Priority 0/1/2)
- [`docs/plans/IMPLEMENTATION.md`](../plans/IMPLEMENTATION.md) — detailed
  per-item backlog (F/W/D/T series)
- [`docs/implementation-status.md`](../implementation-status.md) —
  count-enforced "done" ledger (26/26 submodules)
- [`docs/logs/`](../logs/README.md) — 36 immutable per-unit work logs
  (narrative history)
- [`docs/plans/archive/`](../plans/archive/) — 31 completed dated plans
- [`docs/adr/`](./README.md) — 32 ADRs (architecture decisions)

This is deliberate: row-locality (ADR-0024) keeps concurrent edits
conflict-free, and immutable work logs preserve an honest history instead of
a rewritten one. But it means there is **no single entry point**. Answering
"what's the current state, what's next, what's in flight right now" requires
reading four or more files and cross-referencing status cells by hand — a
real cost for onboarding, for the maintainer doing a quick status check, and
for an agent session picking up work cold.

This ADR evaluates options for a **centralized visibility hub** — a single
place to see current state, roadmap, future plans, and in-progress work —
without disturbing the existing sources of truth. Two example approaches
(GitHub Projects via the `gh` CLI, and a generated GitHub Pages static site)
were explicitly requested for verification; additional alternatives were
researched to round out the comparison.

## Decision drivers

- **Minimal runtime/tooling footprint.** CLAUDE.md's non-negotiable
  constraint is minimal dependencies; a hub should not require standing up
  and operating new infrastructure (a database, a hosted service) for a
  single-maintainer repo.
- **Single maintainer.** Ongoing operational burden (accounts, upgrades,
  another system to keep patched) weighs heavily against any option that
  isn't "set up once, then generate."
- **One source of truth.** ADR-0024 already solved multi-editor conflict
  safety for the markdown trackers via row-locality. A hub that becomes a
  **second, divergent** source of truth (anything requiring bidirectional
  sync) reintroduces the exact drift problem ADR-0024 was written to avoid.
- **Reuse existing generator conventions.** `bin/gen-*.mjs` +
  `bin/sync-docs.mjs` already generate marker-delimited content
  (`gen:index`, `gen:counts`, `gen:commit-stats`) with `--json`/`--affected`
  support (ADR-0030 Phase 4). A hub should be a natural sibling to these,
  not a parallel mechanism.
- **No new secrets.** CI's only credential is the auto-provided
  `GITHUB_TOKEN` (CLAUDE.md → Security). Any option requiring a new PAT,
  API key, or hosted-service credential is a materially higher-friction
  choice.
- **Machine-readable, not just human-visual.** Several existing generators
  already emit `--json` for scripting; a hub that only a human can read
  (a GUI board with no export) is a step backward for agent-driven work.

## Considered options

### 1. GitHub Projects v2 (via `gh project` CLI)

**Verified:** `gh project` is now a first-party, generally-available `gh`
CLI subcommand (previously a separate extension) — `create`, `view`,
`list`, `copy`; field subcommands `field-create`/`field-list`/
`field-delete`; item subcommands `item-add`/`item-edit`/`item-archive`/
`item-list`. All support `--format json` for scripting, and the same
commands run from a GitHub Actions job using the repo's `GITHUB_TOKEN`.
Projects (boards, tables, roadmap views) are included on GitHub's Free plan
for both public and private repositories — no separate purchase needed.

**Pros:** native, zero-install (ships with `gh`, already used elsewhere in
this repo's workflow), free, strong visual UX (board/table/roadmap views,
filtering, grouping) that markdown tables can't match, GraphQL API behind
it for deeper automation if ever needed.

**Cons:** items and fields live in GitHub's hosted database, not in git — no
diff, no PR review, no immutable history the way `docs/logs/` has. Keeping
it current means either (a) manually maintaining a second tracker in
parallel with `ROADMAP.md`/`IMPLEMENTATION.md`, which will drift, or
(b) building and maintaining a one-way sync script (markdown → Projects)
that must be re-run on every roadmap edit and can silently go stale. Either
way it's the "second source of truth" driver's central risk.

### 2. GitHub Pages generated static dashboard

**Verified:** no GitHub Pages configuration exists in this repo today (no
`actions/deploy-pages` step in `.github/workflows/`, no `gh-pages` branch).
The standard pattern for a git-native generated dashboard (used by projects
like Upptime and various `statuspage` generators) is: a script reads
git-native data, emits a static site, and a GitHub Actions job deploys it
via `actions/deploy-pages` on push to `main`. This maps directly onto this
repo's **existing** generator architecture — a `gen:project-hub`-style
script would be a natural sibling to `gen:index`/`gen:counts`/
`gen:commit-stats`. Its input scope is not a short fixed list but the
**entire project documentation corpus**: the root README, every
package/script README (`packages/*/README.md`, `scripts/*/README.md`), all
of `docs/adr/**`, all of `docs/plans/**` (including `IMPLEMENTATION.md` and
the dated `archive/`), all of `docs/logs/**`, `ROADMAP.md`,
`implementation-status.md`, `docs/reference/**`, and any other sparse
`docs/**/*.md` — no new source of truth, purely a rendering/aggregation
layer over everything already authored.

**Host sub-decision — GitHub Pages vs Cloudflare Pages:** the maintainer
owns a custom domain and asked whether Cloudflare Pages should host the
generated site instead. Verified: this repository (`monte3l/m3l-automation`)
is **public**, which is decisive — GitHub Pages requires a paid plan (Pro/
Team/Enterprise) only to serve from a **private** repo; a public repo gets
Pages free, with `actions/deploy-pages` using the already-available
`GITHUB_TOKEN` (`permissions: pages: write, id-token: write`), no new
secret. A custom domain attaches identically on either host — external DNS
CNAME (or apex A/ALIAS) + "Enforce HTTPS" on GitHub Pages, external DNS
CNAME to `<project>.pages.dev` on Cloudflare Pages for a subdomain (an apex
domain on Cloudflare Pages instead requires moving the zone's nameservers to
Cloudflare) — both provision free, automatic TLS. Cloudflare Pages, by
contrast, would cost this ADR's "no new secrets" driver: CI deployment needs
`cloudflare/wrangler-action` (the older `cloudflare/pages-action` is
deprecated/archived) with two new secrets, `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID`; the alternative Git-integration path avoids new CI
secrets but requires granting Cloudflare a GitHub OAuth/app authorization
that is a one-way door (Cloudflare then owns the build, out of this repo's
own CI quality gates) and cannot be reverted to Direct Upload later. With no
private-repo constraint to escape and no other benefit (Cloudflare's edge
CDN/analytics are immaterial for a low-traffic status page), **GitHub Pages
is the selected host** — it is the only option that adds zero new
credentials.

Site-engine choice (if adopted) is a secondary decision:

- **Hand-rolled static HTML/CSS**, generated by a plain Node script — zero
  new dependencies, consistent with this repo's ESM/no-bundler philosophy
  and its existing `bin/gen-*.mjs` style.
- **Docusaurus** — React-based, built-in search, first-class versioning;
  heavier (a full devDependency tree, a bundler) than this repo's docs
  tooling otherwise needs.
- **MkDocs Material** — simplest setup of the three, but entered
  maintenance mode in November 2025 (its Insiders repository was retired
  May 2026); its announced successor, Zensical, is still emerging. Live
  caveat if this engine is picked.

**Pros:** stays entirely git-native (the dashboard is _derived_, never
_authored_, so there's nothing to keep in sync by hand); zero new secrets
(Pages deploy uses the existing `GITHUB_TOKEN`); reuses this repo's proven
generator + marker-block conventions; free hosting; can emit both an HTML
view and a `--json` payload from the same generator, satisfying the
machine-readable driver too.

**Cons:** presentation is whatever the generator author builds — no
built-in Kanban/board interactivity the way Projects has; a new workflow
(`pages.yml`) and a new generator script are still work to build and
maintain, just smaller and lower-risk work than the alternatives below.

### 3. Self-hosted PM tool (Plane, Huly, Taiga, Vikunja)

**Verified:** all four are mature, actively maintained, self-hostable
Linear/Notion alternatives (Plane ~46k GitHub stars, YC-backed; Huly bundles
PM + chat + docs; Taiga is the most mature Scrum-ceremony option; Vikunja is
the lightest of the four).

**Pros:** richest feature set of any option (sprints, custom workflows, full
Kanban, integrations); would give the most "traditional PM tool" experience.

**Cons:** every one of them requires standing up and operating a separate
service — a database, a container/deployment, ongoing version upgrades and
security patching. This is disproportionate infrastructure for a
single-maintainer repo whose CLAUDE.md explicitly commits to minimal
dependencies, and it becomes yet another second source of truth requiring
sync with the git-native trackers. Ruled out on the maintainer/infra
drivers alone.

### 4. Backstage.io developer portal

**Verified:** Backstage is an open framework for building internal developer
portals (software catalog, TechDocs, software templates), built by Spotify
for large multi-team orgs. Research confirms it carries significant setup
and integration cost — standing up its backend, its catalog, and any custom
plugins is a multi-day-plus effort even before content is added, with no
commercial support tier absent a paid arrangement.

**Pros:** if this repo ever became a multi-repo, multi-team platform (the
ADR-0021 "platform extraction," gated on a second adopting repo), Backstage
would be a legitimate fit for a software catalog.

**Cons:** the setup/integration cost is not justified for a single repo with
a single maintainer today. Ruled out as disproportionate, same category as
option 3.

### 5. GitHub Issues + Milestones (native)

**Verified:** native, free, zero setup — Issues/Milestones already exist as
a GitHub feature, and this repo already has issue templates
(`.github/ISSUE_TEMPLATE/`).

**Pros:** no new tooling at all; familiar to any GitHub user; milestones
give a lightweight due-date/grouping view for free.

**Cons:** this repo deliberately does **not** use Issues as its source of
truth today — ADRs and work logs are authoritative, and Issues/PRs are not
the primary tracker (confirmed: no GitHub Projects, no issue-driven
workflow anywhere in the current tooling). Adopting Issues as "the hub" now
would be a third parallel tracker requiring the same kind of sync discipline
as option 1, without option 1's richer views.

### 6. GitHub Discussions (adjunct only)

**Verified:** native, free, good for Q&A/announcements/RFC-style threads.

**Pros:** zero setup; could be a reasonable home for open-ended design
discussion that doesn't warrant a full ADR.

**Cons:** not a structured status/roadmap view by design — Discussions
doesn't model "current state" or "in progress" at all. At best a complement
to whichever hub is chosen, never a hub by itself. Not a candidate on its
own.

### 7. Comprehensive GitHub-native hub (options 1 + 2 + 5 combined) — **selected**

**Verified:** nothing new to verify beyond options 1, 2, and 5 individually —
this option composes them. A GitHub Pages site (option 2, host: GitHub
Pages) becomes the **primary, always-current derived view**, generated over
the entire documentation corpus described above. A GitHub Projects v2 board
(option 1) and GitHub Issues + Milestones (option 5) become **secondary
surfaces**, populated **one-way** from the actionable subset of that corpus
— specifically the roadmap/backlog items in `ROADMAP.md` and
`IMPLEMENTATION.md`, which are the only trackers with a natural
issue/milestone shape (a full ADR or work log has no meaningful "item" to
sync). Both secondary surfaces are treated as **read-only projections**:
never hand-edited, regenerated/re-synced on every relevant change, so any
drift is corrected by the next sync run rather than accumulating.

**Pros:** answers "what's the current state" from a single pane (the Pages
site) while still giving people who want native GitHub UX a Kanban board and
familiar Issues/Milestones view — the richest coverage of any option
considered. Because the secondary surfaces are one-way and read-only, the
sync-drift risk that disqualifies options 1 and 5 _on their own_ does not
apply here: there is exactly one authoring direction (markdown → generated
surface), never the reverse.

**Cons:** the most implementation work of any viable option — one generator
walking the full doc tree (not a fixed input list), a new `pages.yml`
deploy workflow, and two sync scripts (markdown → Projects, markdown →
Issues/Milestones) instead of one. The doc corpus is heterogeneous
(structured tables in the trackers, free-form prose in ADRs and work logs),
so the generator needs either per-file-type extraction or a robust
index-plus-excerpt rendering strategy — this is flagged as the primary open
question for the follow-up implementation, not resolved by this ADR.

### Comparison matrix

| Option                                            | Source-of-truth model                         | New infra/deps                                               | Sync-drift risk                                           | Maintenance burden                        | Visual/UX quality           | Setup effort |
| ------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------- | ----------------------------------------- | --------------------------- | ------------ |
| 1. GitHub Projects (`gh` CLI)                     | Second (hosted DB)                            | None (uses `gh`)                                             | High (manual or scripted sync)                            | Medium (sync script upkeep)               | High (native boards/views)  | Low–Medium   |
| 2. GitHub Pages generated site                    | Derived (reads existing files)                | None–Low (site engine choice)                                | None (regenerated, never authored)                        | Low (sibling to existing generators)      | Medium (author-built)       | Low–Medium   |
| 2b. — hosted on Cloudflare Pages                  | Derived (reads existing files)                | Yes — CF API token + account id, or a GitHub OAuth/app grant | None (regenerated, never authored)                        | Low, plus token/grant upkeep              | Medium (author-built)       | Low–Medium   |
| 3. Self-hosted PM tool                            | Second (own DB)                               | High (service + DB)                                          | High                                                      | High (hosting, upgrades)                  | High                        | High         |
| 4. Backstage.io                                   | Second (catalog)                              | High (backend + plugins)                                     | Medium                                                    | High                                      | Medium–High                 | High         |
| 5. GitHub Issues + Milestones                     | Second (hosted)                               | None                                                         | High                                                      | Medium                                    | Low–Medium                  | Low          |
| 6. GitHub Discussions                             | N/A (not a status view)                       | None                                                         | N/A                                                       | Low                                       | Low (unstructured)          | Low          |
| 7. Comprehensive GitHub-native hub — **selected** | Derived primary + one-way read-only secondary | None (all GitHub-native)                                     | Low, bounded (secondary surfaces one-way, never authored) | Medium (one generator + two sync scripts) | High (site + native boards) | Medium       |

## Decision

This ADR adopts **option 7: a comprehensive GitHub-native hub**, composing
options 1, 2, and 5. The comparison above still disqualifies the same
options, but the addition of option 7 breaks the earlier stalemate between
options 1 and 2:

- **Options 3 and 4** (self-hosted PM tool, Backstage.io) remain disqualified
  by the infra/maintainer drivers regardless of their feature richness —
  disproportionate for a single-maintainer repo.
- **Option 6** (Discussions) is not a hub by itself and is out of scope as a
  standalone answer.
- **Options 1 and 5** (Projects, Issues + Milestones), taken **on their
  own**, both carry the "second source of truth" sync-drift risk this ADR's
  drivers warn against — that risk is exactly why this ADR previously
  refused to pick either standalone.
- Composing them with option 2 removes that risk: **option 7 makes options 1
  and 5 one-way, read-only projections** of the generated site's data,
  rather than independently hand-maintained trackers. The sync direction is
  fixed (markdown corpus → generated Pages site → generated Projects/Issues
  update), so there is exactly one place drift can be corrected — the next
  generator run — never a manual reconciliation between two authored
  sources.

**Host:** the Pages site is hosted on **GitHub Pages**, not Cloudflare
Pages. This repository is public, so GitHub Pages' free tier applies
without the private-repo paywall that would otherwise be the main case for
Cloudflare; GitHub Pages needs no new secret (`GITHUB_TOKEN` only), while
Cloudflare Pages would need either two new CI secrets or a one-way OAuth
grant, for no offsetting benefit at this repo's traffic scale. The owned
custom domain attaches to GitHub Pages the same way it would to Cloudflare
Pages (external DNS CNAME + Enforce HTTPS).

**Scope:** the generator's input is the **entire documentation corpus** —
every README, all ADRs, all plans and the dated archive, all work logs, the
roadmap and implementation-status trackers, and `docs/reference/**` — not
just the five files originally named in option 2's sketch. This is what
makes the hub genuinely "single entry point": a partial-corpus hub would
still require falling back to individual files for anything outside its
scan list.

This decision **mandates follow-up implementation** (tracked as new
roadmap/backlog items, not performed by this ADR edit): a
`gen:project-hub`-style generator, a `pages.yml` deploy workflow, custom
domain wiring, and the two one-way sync scripts (markdown → Projects,
markdown → Issues/Milestones) for the actionable roadmap/backlog subset.
The follow-up work must also resolve one open question this ADR does not
settle: whether the generator renders a **lightweight index +
status-aggregation dashboard** (link every doc, lift the structured
status/roadmap tables into a live view) or a **full docs-portal render** of
every markdown file — the corpus mixes structured tables (trackers) with
free-form prose (ADRs, work logs), so this choice drives the generator's
design.

## Consequences

This ADR _edit_ makes no code or tooling changes itself — the follow-up
generator, workflow, and sync scripts are separate implementation work this
decision now mandates.

- **Positive:** the "no single entry point" problem is resolved in principle
  — one derived hub now covers the complete documentation corpus, not a
  hand-picked subset, while every markdown file stays the authored source of
  truth (row-locality, ADR-0024, is unaffected). The GitHub Pages vs
  Cloudflare Pages host trade-off and the standalone-vs-composed Projects/
  Issues trade-off are both recorded once, so future implementation work
  doesn't re-litigate them.
- **Negative / trade-offs:** the mandated generator now spans the entire,
  continually growing documentation corpus rather than a handful of files,
  which is a larger and longer-lived piece of tooling to build and maintain
  than option 2 alone would have been; two additional hosted surfaces
  (Projects, Issues/Milestones) must be kept one-way-synced going forward.
  Both are accepted deliberately in exchange for a genuinely complete single
  pane of visibility.
- **Semver impact:** none — docs only, no `exports`-map or runtime change.

## Links

- Related: [ADR-0021](./0021-post-1.0-deepen-first-strategy.md) (roadmap
  direction this hub would surface), [ADR-0024](./0024-deterministic-derived-artifact-merges.md)
  (row-locality — the sync-drift risk this ADR weighs every hosted option
  against), [ADR-0025](./0025-dynamic-workflows-assessment.md) (dynamic
  workflows — a possible execution engine for a hub generator),
  [ADR-0030](./0030-targeted-workflow-tooling-and-mcp.md) (workflow tooling
  & MCP adoption, incl. the `--json` structured-output convention this ADR
  proposes a hub generator follow)
- Trackers referenced: [`docs/ROADMAP.md`](../ROADMAP.md),
  [`docs/plans/IMPLEMENTATION.md`](../plans/IMPLEMENTATION.md),
  [`docs/logs/README.md`](../logs/README.md)
- External sources (accessed 2026-07-17): [GitHub CLI project command is now
  generally available](https://github.blog/developer-skills/github/github-cli-project-command-is-now-generally-available/);
  [GitHub CLI manual — `gh project`](https://cli.github.com/manual/gh_project);
  [Upptime](https://github.com/upptime/upptime) (git-native generated
  status-site architecture); [Backstage](https://github.com/backstage/backstage)
  and its [alternatives comparison](https://atmosly.com/blog/the-best-alternatives-to-backstageio-for-internal-developer-portals)
  (setup-cost assessment); [Linear alternatives roundup, 2026](https://use-apify.com/blog/linear-alternatives-2026)
  (Plane/Huly/Taiga/Vikunja); [Material for MkDocs maintenance-mode
  announcement](https://docsio.co/blog/mkdocs-material)
- External sources for the GitHub Pages vs Cloudflare Pages host
  sub-decision (accessed 2026-07-18): [cloudflare/pages-action](https://github.com/cloudflare/pages-action)
  (deprecated, "please use wrangler-action"); [cloudflare/wrangler-action](https://github.com/cloudflare/wrangler-action);
  [Use Direct Upload with continuous integration — Cloudflare Pages docs](https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/)
  (the two required secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`);
  [Git integration — Cloudflare Pages docs](https://developers.cloudflare.com/pages/get-started/git-integration/)
  (the OAuth-grant, one-way-door alternative); [Custom domains — Cloudflare
  Pages docs](https://developers.cloudflare.com/pages/configuration/custom-domains/);
  [Limits — Cloudflare Pages docs](https://developers.cloudflare.com/pages/platform/limits/);
  [GitHub's products and plans](https://docs.github.com/get-started/learning-about-github/githubs-products)
  and [GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)
  (the private-repo paywall that does not apply to this public repo)

## Addendum (2026-07-19): commit-stats badge live-endpoint migration (planned, not yet implemented)

Like the rest of this ADR's follow-up work, this addendum is a tracked
backlog item, not a change performed here — no code, workflow, or test files
have been created yet.

**Problem.** The AI co-authorship commit-stats badges
(`README.md` — the `<!-- BEGIN/END COMMIT-STATS-BADGES -->` block) are
generated by `bin/gen-commit-stats.mjs` and refreshed post-merge by
`bin/post-integrate-regen.mjs`, gated to `main` only (ADR-0024). That
regeneration step deliberately never auto-commits — it leaves `README.md`
dirty and asks a human to commit the result — so every merge to `main` that
changes co-authorship counts produces a follow-up commit whose only payload
is updated badge numbers (e.g. `1c197db`,
`docs: reconcile commit-stats badges after post-merge regen`,
`README.md | 4 ++--`). This is recurring, pure-noise git history churn.

**Recommended fix.** Move badge _rendering_ off static, committed image URLs
onto shields.io's [endpoint badge type](https://shields.io/badges/endpoint-badge),
which fetches a small JSON file (`{schemaVersion, label, message, color}`)
live on every render. A GitHub Actions workflow computes that JSON on every
push to `main` and publishes it via `actions/upload-pages-artifact` +
`actions/deploy-pages` — an artifact deploy, not a branch commit. Once
README's badge URLs point at the hosted JSON they never need to change
again; only the JSON does, entirely inside CI, never touching git history.
This reuses the exact Pages-deploy mechanism this ADR already mandates
(GitHub Pages, `GITHUB_TOKEN` only, no new secret), scoped to one small
artifact rather than the full documentation-corpus hub above — it is a
narrow down payment on the `pages.yml` workflow this ADR's Decision section
already calls for, not a substitute for it. When the full hub's own
`pages.yml` is eventually built, it should reuse or supersede this
workflow rather than stand up a second, competing Pages deploy — GitHub
Pages serves one site per repo by default.

**Alternatives considered and rejected:**

- **A bot auto-commits the regenerated README instead of a human.**
  Automates the churn rather than removing it — git history still grows a
  commit per merge whose only diff is two numbers, and it needs a
  signed-commit story (this repo requires signed commits) that a bot
  identity complicates.
- **Debounce to a weekly regen instead of every merge.** Same defect, just
  less frequent, and trades away freshness in between; still needs a human
  or bot to make the commit.
- **A Gist updated by `schneegans/dynamic-badges-action`.** Avoids enabling
  GitHub Pages, but `GITHUB_TOKEN` cannot write to Gists — it would need a
  new PAT with `gist` scope, violating this ADR's "no new secrets" driver,
  and adds a third-party Action for something `actions/deploy-pages`
  already does natively.

**Implementation sketch for whoever picks this up:**

1. Keep `countCommitsByModel()`/`countTotalCommits()` in
   `bin/gen-commit-stats.mjs` unchanged — reuse the existing trailer-parsing/
   alias-folding logic in `bin/lib/claude-models.mjs` rather than
   reimplementing it. Add `bin/gen-commit-stats-endpoint.mjs`, which imports
   those functions and emits one shields.io endpoint-schema JSON per badge
   (`aggregate.json` + one per canonical model) to `dist/commit-stats/`.
2. Add `.github/workflows/pages-commit-stats.yml`: triggers on
   `push: branches: [main]`; a `build` job (`contents: read`,
   `fetch-depth: 0`) runs the endpoint script and
   `actions/configure-pages`/`actions/upload-pages-artifact`; a `deploy` job
   (`pages: write`, `id-token: write`) calls `actions/deploy-pages`. Zero new
   secrets. One-time manual step: enable GitHub Pages in repo
   Settings → Pages → Source: GitHub Actions.
3. In `README.md` (a one-time migration commit, not a recurring one): swap
   each static badge URL for `img.shields.io/endpoint?url=<hosted-json>`,
   remove the now-pointless marker comments, and update the "Co-developed
   with Claude" disclosure sentence to describe the live-endpoint mechanism.
4. In `bin/post-integrate-regen.mjs`: drop the `onMain` branch and its
   `gen-commit-stats.mjs` call from `regenerationCommands()`; remove
   `isOnMainBranch()` too if this was its only consumer.
5. Add a dated Update note to ADR-0024 superseding its
   "`gen:commit-stats` moves to main-only" clause, since the artifact no
   longer touches `README.md` via git at all.
6. Tests: delete the `buildBadgeBlock`/`replaceBadgeBlock` coverage in
   `bin/tests/gen-commit-stats.test.ts` once those functions are removed;
   add `bin/tests/gen-commit-stats-endpoint.test.ts` for the new pure
   payload builders; remove the `onMain`-parameterized cases in
   `bin/tests/post-integrate-regen.test.ts`. `bin/lint-commit.mjs` and its
   tests are unaffected (write-time trailer validation doesn't change).
7. Rollout order: land the endpoint script + workflow first (a no-op for
   README — verify the Pages deploy and JSON are live), then swap the README
   URLs and remove the old write path in a second change, so `main` never
   points at a not-yet-existing JSON URL and nothing lands half-wired.
   Rolling back is just reverting the second change.
