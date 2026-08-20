# 0050. GitHub platform-feature stance

- **Status:** Accepted; the board identity it records (§104-105) partially
  superseded by [ADR-0052](0052-hub-board-identity-and-field-taxonomy.md),
  which also extends the adopted-platform-feature set this ADR was silent on
  (project custom fields, saved views, org Issue Types) — everything else
  here remains in force
- **Date:** 2026-08-19
- **Deciders:** Enrico Lionello (maintainer); Claude (research)

## Context and problem statement

GitHub exposes several optional platform features per repository — Wiki,
Discussions, Projects, and the built-in Insights views — on top of Issues and
Pull Requests, which this repo already uses deliberately. Live inspection of
`monte3l/m3l-automation` found every optional feature simply left at its
GitHub-default **on** state, with no decision behind any of them:

- **Wiki:** enabled, empty (`git ls-remote` on the wiki repo 404s; the web page
  redirects to the empty-wiki prompt). No ADR mentions it — the only
  repo-wide grep hit for "wiki" is Contributor Covenant boilerplate in
  `.github/CODE_OF_CONDUCT.md`.
- **Discussions:** enabled, zero discussions, six stock categories
  (Announcements, General, Ideas, Polls, Q&A, Show and tell), none configured.
  ADR-0032 evaluated Discussions as a candidate for the visibility hub itself
  (option 6) and correctly rejected that framing, but its own text conceded
  Discussions "could be a reasonable home for open-ended design discussion
  that doesn't warrant a full ADR" — a question it then left unanswered.
- **Projects:** the org-owned board `m3l-automation hub` (`monte3l` org,
  project #2) that ADR-0032 designates a read-only projection of the trackers
  was never linked to the repository — `repository.projectsV2.totalCount`
  returns `0` over the GraphQL API. The repo's own Projects tab is empty.
  Separately, no ADR ever recorded which owner scope (user vs. organization)
  the board should live under; `bin/sync-hub-projects.mjs`'s `OWNER = "monte3l"`
  constant is an implementation choice with no decision behind it.
- **Insights:** not a togglable feature — it is automatically derived from
  repository activity and the community-profile checklist. No prior ADR
  discusses it, despite ADR-0032's Pages dashboard deliberately overlapping
  what Insights already shows (commit activity, contributor stats).

An unrecorded "on because nobody turned it off" stance is the same ambient-
default problem ADR-0030 was written to eliminate for GitHub _integration_
tooling (gh CLI vs. MCP). This ADR does the equivalent for GitHub _platform
features_.

A related, narrower question — whether a Project can be moved to live
directly inside a repository, as originally asked — has a definitive answer
from the GitHub GraphQL schema: introspecting `ProjectV2Owner` returns
`Issue | Organization | PullRequest | User`. There is no `Repository` member.
Classic, repository-owned projects were retired platform-wide. A Project can
only be **linked** to a repository (`linkProjectV2ToRepository`), which
surfaces an org- or user-owned board in that repository's Projects tab without
changing who owns it. "Move the project into the repo" is therefore not an
available operation; "link the existing org-owned board to the repo" is.

## Decision drivers

- Every enabled platform feature should have a recorded reason, mirroring the
  ADR-0030 precedent for tool-access stance.
- Minimize surfaces that exist outside this repo's CI-enforced doc gates
  (`check:index`, `check:doc-counts`, `check:provenance`, `check:tracker-*`,
  `check:hub-keys`, `lint:md`) — a wiki is a separate git repository with none
  of those gates attached.
- Single-maintainer project (per `CLAUDE.md`'s Owner line) — features aimed at
  large community coordination (Polls, Show and tell, most of the default
  Discussions categories) add surface area with no current audience.
- Don't relitigate ADR-0032's hub decision; extend it only where it left a
  question open (the Discussions adjunct question, the board's owner scope).

## Considered options

1. **Leave every feature at its current, unexamined default.** Zero effort,
   but perpetuates the ambient-stance problem this ADR exists to close.
2. **Disable everything not already in active use** (Wiki, Discussions,
   unlinked Projects tab). Simplest posture, but throws away a workable home
   for the idea-capture need identified alongside this decision (see
   `docs/contributing/filing-work.md`).
3. **Adopt a feature-by-feature stance**, keeping only what has a concrete,
   recorded use, and disabling the rest. Wiki disabled (no use — the doc gates
   already own that job); Discussions adopted narrowly, as the public half of
   a two-lane idea-capture surface; Projects linked (not moved — moving is not
   possible) and kept private since it mirrors internal roadmap detail;
   Insights left as-is with its overlap with the Pages dashboard acknowledged
   rather than resolved by removing either.

## Decision

We chose **option 3, a feature-by-feature stance**, per platform feature:

- **Wiki — disabled.** `docs/` already holds ~321 markdown files that are
  drift-checked, generated, or generator inputs (`check:index`,
  `check:doc-counts`, `check:impl-counts`, `check:provenance`,
  `check:tracker-coverage`, `check:tracker-status`, `check:hub-keys`,
  `gen:project-hub`, `lint:md`). A wiki is a separate git repository outside
  every one of those gates — content that mattered enough to keep accurate
  would either duplicate a gated doc or silently rot ungated. There is no use
  case here a wiki serves that `docs/` doesn't already serve better.
- **Discussions — adopted, narrowly.** Two categories only: `Ideas` (the
  public half of the two-lane idea-capture surface — see
  `docs/contributing/filing-work.md`) and `Q&A` (the support channel this repo
  previously had no documented path to, closing the community-profile gap left
  by having no `SUPPORT.md`). `Announcements`, `General`, `Polls`, and `Show
and tell` are pruned — they assume a community-coordination use this
  single-maintainer project doesn't have. This resolves the adjunct question
  ADR-0032 raised and left open.
- **Projects — linked, not moved, and kept private.** `gh project link 2
--owner monte3l -R monte3l/m3l-automation` surfaces the existing org-owned
  board (`m3l-automation hub`, `PVT_kwDOC6PG9c4BeLpp`) in the repo's Projects
  tab. Ownership stays with the `monte3l` organization — moving it into the
  repository is not an operation GitHub's schema supports (see Context). The
  board stays **private**: it mirrors internal roadmap/priority detail at
  finer grain than the public Pages dashboard, and ADR-0032 already treats it
  as a secondary, maintainer-facing projection rather than the public entry
  point (that role belongs to the Pages site). This is the owner-scope record
  ADR-0032 never wrote.
- **Insights — left automatic, overlap acknowledged.** No configuration
  exists to make here; it derives from activity and the community-profile
  checklist. The ADR-0032 Pages dashboard deliberately duplicates part of what
  Insights shows (status aggregation, commit stats) by design — that overlap
  is intentional, not an oversight, and is not worth resolving by removing
  either surface. Repository metadata (`description`, `homepage`, `topics`)
  is set as part of this change specifically because it feeds both the
  community-profile checklist and Insights' repo-summary rendering.
- **Pages — unchanged.** Governed entirely by ADR-0032; no new decision here.

## Consequences

- **Positive:** every optional platform feature now has a recorded reason for
  its state, closing the same class of gap ADR-0030 closed for tool access.
  The repo's Projects tab becomes non-empty. Discussions gets a bounded,
  intentional use instead of six unused stock categories.
- **Negative / trade-offs:** disabling the Wiki is one-way in practice (GitHub
  does not delete wiki history on disable, but re-enabling starts from
  whatever was last there, which is nothing). Discussions being public means
  every `Ideas` post is world-readable on a public repo — deliberately, per
  the private/public split in `docs/contributing/filing-work.md`, but it is a
  real trade-off against the fully private board-draft lane.
- **Semver impact:** none — this changes repository configuration and
  documentation, not the published package or its `exports` map.

## Links

- Related: ADR-0032 (visibility hub — the board and Pages site this ADR
  extends), ADR-0030 (GitHub integration stance — the tool-access precedent
  this ADR mirrors for platform features)
- See also: `docs/contributing/filing-work.md` (the two-lane idea-capture
  procedure that motivates the Discussions and Projects decisions above)
