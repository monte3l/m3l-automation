# 0032. Centralized project-state and roadmap visibility hub

- **Status:** Proposed
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
  count-enforced "done" ledger (25/25 submodules)
- [`docs/logs/`](../logs/README.md) — 36 immutable per-unit work logs
  (narrative history)
- [`docs/plans/archive/`](../plans/archive/) — 31 completed dated plans
- [`docs/adr/`](./README.md) — 31 ADRs (architecture decisions)

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
`gen:commit-stats`, reading `ROADMAP.md`, `IMPLEMENTATION.md`,
`implementation-status.md`, `docs/logs/README.md`, and `docs/adr/README.md`
as its only inputs — no new source of truth, purely a rendering layer.

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

### Comparison matrix

| Option                         | Source-of-truth model          | New infra/deps                | Sync-drift risk                    | Maintenance burden                   | Visual/UX quality          | Setup effort |
| ------------------------------ | ------------------------------ | ----------------------------- | ---------------------------------- | ------------------------------------ | -------------------------- | ------------ |
| 1. GitHub Projects (`gh` CLI)  | Second (hosted DB)             | None (uses `gh`)              | High (manual or scripted sync)     | Medium (sync script upkeep)          | High (native boards/views) | Low–Medium   |
| 2. GitHub Pages generated site | Derived (reads existing files) | None–Low (site engine choice) | None (regenerated, never authored) | Low (sibling to existing generators) | Medium (author-built)      | Low–Medium   |
| 3. Self-hosted PM tool         | Second (own DB)                | High (service + DB)           | High                               | High (hosting, upgrades)             | High                       | High         |
| 4. Backstage.io                | Second (catalog)               | High (backend + plugins)      | Medium                             | High                                 | Medium–High                | High         |
| 5. GitHub Issues + Milestones  | Second (hosted)                | None                          | High                               | Medium                               | Low–Medium                 | Low          |
| 6. GitHub Discussions          | N/A (not a status view)        | None                          | N/A                                | Low                                  | Low (unstructured)         | Low          |

## Decision

This ADR intentionally does **not** commit to one option. The comparison
above shows a clear structural split rather than a single dominant choice:

- **Options 3 and 4** (self-hosted PM tool, Backstage.io) are disqualified
  by the infra/maintainer drivers regardless of their feature richness —
  disproportionate for a single-maintainer repo.
- **Option 6** (Discussions) is not a hub by itself and is out of scope as a
  standalone answer.
- **Option 5** (Issues + Milestones) inherits the same sync-drift problem as
  option 1 without its stronger views, so it's dominated by option 1.
- The live trade-off is between **option 1 (GitHub Projects)** and
  **option 2 (GitHub Pages generated site)**: option 1 wins on out-of-the-box
  visual/interactive UX and zero build effort; option 2 wins on the
  single-source-of-truth and reuse-existing-conventions drivers, at the cost
  of being only as polished as its generator is built to be.

These two are **not mutually exclusive**. A hybrid — the Pages site as the
primary, always-current generated view, with an optionally one-way-synced
read-only Projects board as a secondary Kanban surface for people who want
that UX — is worth naming as a candidate follow-up, but is not decided here.

Status stays `Proposed`. The maintainer's eventual choice (option 1, option
2, the hybrid, or a different split) should be recorded either by updating
this ADR to `Accepted` with a `## Decision` rewrite, or by a follow-up ADR
that supersedes this one.

## Consequences

This ADR itself makes no code or tooling changes — it is a research and
comparison document only.

- **Positive:** the trade-offs and disqualifications are now recorded once,
  so a future implementation decision doesn't have to re-litigate why
  self-hosted tools and Backstage were ruled out, or re-derive the
  GitHub-native command surface from scratch.
- **Negative / trade-offs:** the "no single entry point" problem this ADR
  describes remains unsolved until a follow-up ADR or an update to this one
  picks an option and it's implemented.
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
