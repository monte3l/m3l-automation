# ADR-0032: accept the comprehensive GitHub-native visibility hub (2026-07-18)

**Status: shipped** (commit 39209cf)

## Context

ADR-0032 had sat at `Proposed` since 2026-07-17, laying out six candidates
for a "single place to see project state/roadmap/in-flight work" without
committing to one — the live trade-off named was GitHub Projects vs a
generated GitHub Pages site. The maintainer asked for two follow-ups: (a) an
assessment of Cloudflare Pages as an alternative host, now that a custom
domain is owned, and (b) a "comprehensive" setup combining GitHub Projects,
Issues & Milestones, and a Pages site.

## Approach / Decisions

Research (via parallel `Explore` agents) surfaced two decisive facts:
`monte3l/m3l-automation` is a **public** repository, which removes GitHub
Pages' only real limitation (the private-repo paywall); and Cloudflare Pages
would cost this ADR's own "no new secrets" driver — either two new CI
secrets via `cloudflare/wrangler-action` (the older `cloudflare/pages-action`
is deprecated) or a one-way OAuth grant handing the build to Cloudflare. With
no private-repo constraint to escape, GitHub Pages was selected as host.

The user then chose the full comprehensive stack over a Pages-only or
neutral framing: a GitHub Pages site as the **primary derived view**,
generated over the **entire documentation corpus** (every README, all ADRs,
all plans + archive, all work logs, ROADMAP, IMPLEMENTATION,
implementation-status, `docs/reference/**`) rather than the five files
originally sketched — plus GitHub Projects and Issues/Milestones as
**one-way-synced, read-only secondary surfaces** carrying the actionable
roadmap/backlog subset. Composing the three surfaces this way removes the
"second source of truth" sync-drift risk that had disqualified Projects/
Issues on their own.

ADR-0032 was updated in place (still editable — it had never left
`Proposed`): front-matter flipped to `Accepted (2026-07-18)`, a new "option
7" documenting the composed hub, a GitHub-Pages-vs-Cloudflare-Pages host
sub-decision under option 2, two new comparison-matrix rows, and a rewritten
Decision/Consequences recording the follow-up implementation this now
mandates (a `gen:project-hub`-style generator walking the whole doc tree, a
`pages.yml` deploy workflow, and two markdown → Projects/Issues sync
scripts). `docs/adr/README.md`'s index row was updated to match. Two stale
hand-maintained figures inside the ADR's own context section were corrected
in passing (25/25 → 26/26 submodules; 31 → 32 ADRs).

## Outcome

`docs/adr/0032-project-management-visibility-hub.md` is `Accepted`, with the
comprehensive GitHub-native hub (GitHub Pages primary + Projects + Issues/
Milestones secondary) as the recorded decision. This ADR edit is docs-only
(no `exports`-map or runtime change); the generator, `pages.yml` workflow, and
sync scripts it mandates are separate follow-up implementation work, not yet
scheduled as roadmap/backlog items.
