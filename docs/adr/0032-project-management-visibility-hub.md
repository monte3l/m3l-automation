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
  count-enforced "done" ledger (26/26 submodules at the time of this
  decision; see the file itself for the current count)
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

## Update (2026-07-22): implementation resolutions and a gh-project token correction

The addendum's endpoint-badge migration shipped (PRs #185/#186), and the hub
implementation itself is now underway. Three resolutions, recorded here so the
implementation doesn't silently diverge from the decision record:

- **Correction — `gh project` and `GITHUB_TOKEN`.** Option 1's claim that the
  `gh project` commands "run from a GitHub Actions job using the repo's
  `GITHUB_TOKEN`" is wrong: the Actions-provided `GITHUB_TOKEN` carries no
  Projects (v2) scope and can neither read nor write Projects items —
  `gh project` needs a token with the `project` scope (classic PAT or GitHub
  App permission). Under this ADR's own no-new-secrets driver, the two one-way
  sync scripts therefore run **locally, maintainer-invoked** (`pnpm sync:hub`)
  against the maintainer's own `gh` CLI auth (one-time
  `gh auth refresh -s project`), not in CI. The read-only-projection model is
  unaffected: any staleness is corrected by the next run.
- **Open question resolved — dashboard shape.** The generator renders the
  **lightweight index + status-aggregation dashboard**, not a full
  docs-portal: the structured trackers (`ROADMAP.md`,
  `plans/IMPLEMENTATION.md`, `implementation-status.md`,
  `reference/catalog.json`) are lifted into live HTML tables, and every other
  corpus file (ADRs with parsed status lines, work logs, archived plans,
  reference pages, READMEs) is indexed with metadata and linked to its GitHub
  blob URL. Zero new dependencies: a plain Node ESM generator
  (`bin/gen-project-hub.mjs` + pure builders in `bin/lib/project-hub.mjs`)
  emitting one self-contained static HTML page.
- **Open question resolved — custom domain.** Deferred entirely; the site
  stays at `https://monte3l.github.io/m3l-automation/`. Wiring a domain later
  is its own small unit (CNAME + DNS + updating the README's badge JSON URLs,
  which encode the host).

As the addendum predicted, `pages.yml` now supersedes
`pages-commit-stats.yml`: one build job runs both generators (hub at the site
root, badges under `/commit-stats/`) and deploys a single `dist/` artifact.

## Update (2026-07-28): the tracker's 6-value status vocabulary maps onto the Project board's 3-value Status field

`ROADMAP.md`'s Maintenance section and `IMPLEMENTATION.md`'s status legend
document the hub's six-value badge vocabulary — Done · To Do · In Progress ·
Deferred · Blocked · Rejected — matching `classifyStatus()`
(`bin/lib/project-hub.mjs`) and the HTML dashboard's six `.badge-*` CSS
classes. The GitHub Projects (v2) board's single-select "Status" field,
however, carries only three options: **Pending**, **In review**, and
**Done**. This was an intentional implementation choice made while building
`bin/sync-hub-projects.mjs` — not documented here at the time, which read as
an accidental drift during a later audit. The mapping
(`PROJECT_STATUS_OPTIONS` in `bin/lib/hub-sync.mjs`) is:

| Tracker status (6-value) | Board Status option (3-value) |
| ------------------------ | ----------------------------- |
| To Do                    | Pending                       |
| Deferred                 | Pending                       |
| Blocked                  | Pending                       |
| In Progress              | In review                     |
| Done                     | Done                          |
| Rejected                 | Done                          |

Rationale: the board is a coarse "what's moving" view for GitHub's native
Projects UI, not a full-fidelity mirror of the tracker vocabulary — a fourth
distinct GitHub-issue-close outcome for "rejected" vs. "done" adds no
board-navigable value (both resolve to "off the active board" once
`planIssueSync` closes the underlying issue), and Deferred/Blocked/To Do are
all equally "not yet actionable" from the board's perspective. Extending the
board to a full six-option field remains possible later (a board schema
change plus a `PROJECT_STATUS_OPTIONS` update) but is not needed today; this
Update exists so the collapse is a stated decision instead of one
discoverable only by reading `hub-sync.mjs`'s source.

## Update (2026-08-13): status labels, a two-milestone-schema change, a milestone-lookup bug fix, a CI drift gate, and a one-time historical backfill

A 2026-08 tracker-reconciliation audit found the sync had not run since
2026-07-30 — two full waves of tracker updates (ADR-0037/0038/0039,
ADR-0040/0041/0042/0043) landed with zero GitHub representation, structurally
invisible to `extractImplementation`'s heading map — and, separately, that the
issue side of the hub could not express Deferred/Blocked at all: same open
state, same priority label as a plain To Do issue, and the Status column is
excluded from the derived issue body by design (`buildDetail`'s
`excludeIndices`), so a reader had no way to tell a blocked item from an
actionable one on GitHub. Five fixes landed together (the first three below
fix the label/milestone gap; the last two prevent and repair the staleness gap):

- **Two new labels**, `status:deferred`/`status:blocked` (`STATUS_LABELS`,
  `bin/lib/hub-sync.mjs`), applied by `buildIssuePayload` only for those two
  statuses — `done`/`rejected` issues are closed instead of labeled, and
  `todo`/`in-progress` carry no status label since they already are the two
  "actionable now" states. Bootstrapped alongside the existing five labels in
  `LABEL_DEFS` (`bin/sync-hub-issues.mjs`).
- **A `managedLabelsDiffer` dirty-check widening.** `planIssueSync`'s dirty
  check previously compared only title/body, so a status-only change (same
  title/body, e.g. To Do → Blocked) would never reach `editIssue` and the new
  label would silently never apply — found live on issue #207 (open,
  Blocked, unchanged title/body since it was filed). `isDirty` now also
  fires on managed-label drift (`HUB_LABEL`/`priority:*`/`status:*`); a
  human-added label outside those three families is never inspected. The
  runner's label-removal helper (`stalePriorityLabels`, now
  `staleManagedLabels`) was widened the same way so a stale `status:*` label
  is pruned on the next status change, not just a stale `priority:*` one.
- **Two new milestones**, replacing two prior gaps: **Governance** (every
  governance-priority item previously resolved `milestoneTitle: null` via
  `--remove-milestone`, leaving issue #194 the only milestone-less issue) and
  **2.0 / breaking** (major-bump-gated work — F3, the `@deprecated`
  `AWSClientProvider` getter-removal row — previously shared the "Priority 2"
  milestone with everything else gated, indistinguishable from a merely
  deferred item). Routing is `MAJOR_BUMP_ITEM_KEYS` (`bin/lib/hub-sync.mjs`)
  — a small set of exact `Item` keys, computed via the real `slug()`
  transform rather than hand-typed, so it can't independently drift from
  `actionableItems`' own key generation — checked before the normal
  priority → milestone lookup in `buildIssuePayload`. Every `Item` now
  resolves to a real milestone; `MILESTONE_TITLES` no longer has a
  priority with no milestone.
- **`loadExistingMilestoneTitles` now queries `state=all`.** It previously
  omitted `state`, which defaults to `open` — closing the "Priority 0"
  milestone (empty since every P0 row is Done) would have made the next
  `--apply` re-`POST` it and 422-fail the entire sync. Found while adding
  the two milestones above, not by an observed failure.
- **A CI drift gate**, `pnpm check:hub-drift`
  (`node bin/sync-hub-issues.mjs --check`, `.github/workflows/ci.yml`'s
  push-to-main-only "Check hub drift" step). `check` is a third mode
  alongside dry-run/`--apply`: it computes the same plan but returns
  `{ ok: false }` when it's non-empty, instead of dry-run's always-succeed
  contract. Scoped `push`-only (not `pull_request`) so it alarms on `main`
  without becoming a merge-blocking gate for unrelated PRs whenever the hub
  happens to be behind. Needs `issues: read`, added at job level to
  `verify` (workflow default stays `contents: read`) — a genuinely
  read-only scope; `--apply` still never runs in CI, since `GITHUB_TOKEN`
  cannot write GitHub Projects v2 regardless.
- **A one-time `--backfill` mode** (`planBackfill`, `bin/lib/hub-sync.mjs`;
  composes with `--apply`, e.g. `pnpm sync:hub-issues -- --apply --backfill`).
  `planIssueSync` is deliberately go-forward-only: a resolved (Done/Rejected)
  row with no marker is silently skipped, never created — the accepted
  consequence noted in the 2026-07-28 drift reconciliation for every
  historically-Done row that predates issue #189. `--backfill` closes that
  gap once: it plans a **create-then-immediately-close** for every
  marker-less resolved row, so the historical record exists on GitHub
  without ever reading as open work. Collision guard: since a pre-existing
  row never carried a marker, a naive backfill could refile something a
  maintainer already created by hand under a slightly different title —
  every candidate title is fuzzy-matched (`titleSimilarity`, plain
  Levenshtein, no dependency) against **every** existing issue title (not
  just hub-sync-labeled ones — `loadAllIssues`, unfiltered), and a match at
  or above 85% similarity routes to `needsReview` instead of auto-creating,
  for the maintainer to resolve by hand.

None of this changes `PROJECT_STATUS_OPTIONS` (the board Status field is
untouched) or the board's own field set — only issue labels and milestones.

**Known gap, not fixed here:** `planIssueSync` marks a closed-and-resolved
issue `untouched` unconditionally — it never recomputes or reapplies
`payload` for one, dirty or not (that branch predates this Update; changing
it risks the planner's idempotency law for a cosmetic milestone correction).
So F3 (issue #196, already closed as Rejected, filed under "Priority 2"
before `MAJOR_BUMP_ITEM_KEYS` existed) will not automatically move to
"2.0 / breaking" — a one-time manual milestone move via the GitHub UI closes
it. A newly created or reopened issue is unaffected; this only touches an
issue that was already closed before this Update landed.

## Update (2026-08-15): the tracker/board vocabulary split is now enforced, not just documented

The 2026-07-28 Update above states the split — tracker Status cells use the
six-value badge vocabulary, the Projects board's Status field uses its own
three-value one (Pending/In review/Done) — but nothing checked a tracker cell
actually stayed on the tracker side of that split. A board-side token,
`In review`, leaked into the D4 `aws/rds-data` row in
`docs/plans/IMPLEMENTATION.md`. `classifyStatus` (`bin/lib/project-hub.mjs`)
had no branch for it and silently classified it `"todo"`, so issue #204 sat
open — board status "Pending" — for weeks after the work it tracked had
already shipped (found and worked around while retiring that gate, #428;
filed as its own gap rather than fixed in the same change).

Resolved as: **a board-side token in a tracker cell is an authoring mistake,
not a synonym to alias.** Aliasing the one observed token (`In review` →
`In Progress`) would have fixed this single leak while leaving the vocabulary
boundary just as porous to the next one (`Pending`, a typo, a backticked
`` `In review` ``) — silently, the same way this one was. Enforcing the
boundary instead of widening it:

- `classifyStatus` split into `classifyStatusCell(cell) -> { kind, recognized }`
  (mirroring the existing `mapFrictionPriority`) plus a thin `classifyStatus`
  wrapper for callers that only need the badge kind (the dashboard renderer
  still needs to render _something_ for a bad cell, so `kind` still defaults
  to `"todo"` — only `recognized` is new). The cell-stripping regex was also
  widened from `**bold**` -only to `**bold**`/`` `code` ``/`_italic_`,
  closing a second silent hole where a backticked `` `In review` `` cell
  would have fallen through the vocabulary check for an unrelated reason.
- `bin/lib/hub-sync.mjs`'s `actionableItems` gained `resolveStatus`, mirroring
  the existing `resolvePriority`: every tracker row's Status cell now warns
  into the same `warnings` array a bad Priority cell already did.
- A new hard CI gate, `pnpm check:tracker-status`
  (`bin/check-tracker-status.mjs`, sibling to `check:tracker-coverage`,
  wired into `verify-steps.mjs`/`ci.yml` the same way): fails the build the
  moment an off-vocabulary Status cell exists anywhere in `docs/ROADMAP.md`
  or `docs/plans/IMPLEMENTATION.md` (`## `- and `### `-level tables alike,
  reporting the exact `path:line` and cell text), so the leak this Update
  describes cannot reach `main` a second time. A warning in a dry-run log was
  the channel that let the first one sit unnoticed for weeks; this is the
  backstop that doesn't depend on someone reading that log.
- `PROJECT_STATUS_OPTIONS`'s lookup (`projectStatusOption`,
  `bin/lib/hub-sync.mjs`) now throws instead of silently defaulting to
  Pending on a miss — with `resolveStatus`/`check:tracker-status` both in
  place, `status` reaching that function is provably always one of the six
  kinds, so a miss there would be a programming error, not tracker data.

No live tracker row was off-vocabulary at the time this landed — the `In
review` cell was already flipped to `Done` by #428 — so `check:tracker-status`
starts green; this Update and the gate exist to keep it that way.

## Update (2026-08-19): `impl:` item keys are namespaced by section, and the Priority vocabulary is complete

An item key is the join key for the whole hub — it is written into its issue
body as `<!-- m3l-hub-sync:<key> -->` and is the only thing `planIssueSync`
matches an issue on. `docs/ROADMAP.md`'s keys were already namespaced by
section (`roadmap:p0:` / `roadmap:<wave>:` / `roadmap:gov:`), but
`docs/plans/IMPLEMENTATION.md`'s were flat: all seven of its tables emitted
`impl:<label>`, while an item label is only unique _within_ its own table. The
ADR-0035 rollout table and the codified-procedure wave table both restart at
A1, so A1/A2/A3/A5/A6 each denoted two entirely different items (filed as F13,
issue #480).

**The collision was latent, not live — and F13's own description of it was
wrong on one character.** F13 recorded issues #469 and #377 as both carrying
`<!-- m3l-hub-sync:impl:a2 -->`. Running `actionableItems` against the real
trackers shows zero exact duplicate keys: #377 carries `impl:A2` and #469
carries `impl:a2`. The five pairs were separated purely by accident, because
the rollout table was the one table not passing its label through `slug()`, so
its keys stayed upper-case and the case-sensitive marker match kept them
apart. Nothing was merged or orphaned. But making key derivation consistent —
an obvious cleanup any contributor might make — would have merged all five
pairs at once, and `addItem` merges a duplicate silently, so the loser of each
pair would have stopped being planned while `planIssueSync` closed its issue
with a "removed from source trackers" comment.

Resolved as: **fix the namespace structurally rather than rely on the
accident.** A gate alone was considered and rejected — it would force item
labels to be globally unique across every table, which fights the repo's own
established practice of restarting labels per wave (exactly what produced this
collision). Namespacing keeps that practice safe:

- **`IMPLEMENTATION_NAMESPACES` (`bin/lib/hub-sync.mjs`)**, keyed identically
  to the existing `IMPLEMENTATION_ANCHORS` so a new section cannot gain an
  anchor without also gaining a namespace. Every one of the seven key sites
  now emits `impl:<namespace>:<slug(label)>`, and the friction and rollout
  tables were brought onto `slug()` with the other five, so a case-variant
  key is no longer expressible within a namespace. `MAJOR_BUMP_ITEM_KEYS` is
  re-derived through the same map and `slug()` rather than hand-typed, as it
  already was.
- **A self-healing migration, not a migration script.** Each `Item` carries
  the flat key it used to be filed under in a new `legacyKeys` field, and all
  three marker consumers (`planIssueSync`, `planBackfill`, and
  `bin/sync-hub-projects.mjs`) resolve markers through one shared
  `indexItemsByKey`. An issue whose marker is stale therefore matches its item
  instead of reading as vanished, and because the rewritten body opens with
  the new marker it is already dirty, so the next `--apply` migrates it. No
  separate script to forget to run, and no window in which a real issue could
  be closed as "removed".
- **One narrow exception to the closed-and-resolved rule.** That branch
  pushes `untouched` unconditionally — the deliberate gap the 2026-07-28
  Update above records. 97 of the 108 `impl:` issues are closed, so without an
  exception the aliases could never retire. A stale marker now triggers an
  `update`; everything else about the branch is untouched. It is idempotent by
  construction: once rewritten the marker is current, so the next run falls
  through to "in sync".
- **`pnpm check:hub-keys`** (`bin/check-hub-keys.mjs`), a new hard gate
  wired alongside `check:tracker-status` in `package.json`,
  `bin/lib/command-catalog.mjs`, `bin/lib/verify-steps.mjs`, and `ci.yml`. It
  fails on any exact duplicate key, any two keys differing only by case, and
  any legacy alias shadowing another item's current key. It checks
  case-insensitively precisely because that accident is what masked the
  original collision. `addItem` also warns now, and `actionableItems` returns
  the collisions structurally as `duplicateKeys` so the gate need not parse
  warning prose — but per this ADR's own 2026-08-15 finding, the warning is
  the diagnostic and the gate is the enforcement.

**The Priority vocabulary, found while fixing the above.** Every `sync:hub`
run emitted six `unrecognized Priority cell … defaulted to p2` warnings, all
on Done rows, from two different causes. Five were the `—` placeholder used by
the capability-deepening and post-comparison wave tables on rows whose change
is not priority-tiered — a convention `mapFrictionPriority`'s own comment
already documented as deliberate, but which the vocabulary never accepted. The
sixth was `P3` on the F12 row: the only `P3` in either tracker, with no
`PRIORITY_LABELS` entry, no `MILESTONE_TITLES` entry, and no GitHub milestone
behind it.

Resolved as: **complete the vocabulary, and correct the genuine typo at
source.** This is deliberately _not_ the `In review` case from the 2026-08-15
Update — that was a foreign vocabulary (the board's) leaking into a tracker
cell, so aliasing it would have been wrong. The dash placeholder is this
table's own documented convention, so recognizing it completes the vocabulary
rather than widening it to absorb a mistake. `P3` is the actual mistake and
stays loud.

- `mapFrictionPriority` moved out of `bin/lib/hub-sync.mjs` and became
  `classifyPriorityCell` in `bin/lib/project-hub.mjs`, mirroring
  `classifyStatusCell`. It lives there because `check:tracker-status` needs
  the same vocabulary and `project-hub.mjs` imports nothing local while
  `hub-sync.mjs` imports _from_ it — the reverse direction would be a cycle.
  A dash cell is now `recognized: true`; an _empty_ cell is not, since a
  missing Priority is an omission rather than someone stating "no tier".
- `docs/plans/IMPLEMENTATION.md`'s F12 row moved from `P3` to `P2`.
- **`check:tracker-status` now gates Priority cells too**, rather than a
  fourth wiring site: `findOffVocabularyPriorityCells` was added beside
  `findOffVocabularyStatusCells`, both expressed over one extracted
  `findOffVocabularyCells` walker so the two cannot drift and `check:dup`
  stays quiet. Scoping is free — no table in `docs/ROADMAP.md` carries a
  Priority column, so that file yields nothing without being special-cased.

Both Priority fixes already resolved to `p2`, so that half produces zero
GitHub drift. The namespacing half does not: the next `sync:hub --apply`
rewrites 108 issue bodies' marker lines. That run is mechanical and must
follow the merge promptly, since `check:hub-drift` fails on a non-empty plan
and `--apply` cannot run in CI.
