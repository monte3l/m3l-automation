# GitHub platform-feature stance and idea-capture inbox

**Status: shipped** — PR `feat/github-surface-stance` (commit `9a673a5`).

## Context

The user asked to assess moving the `monte3l` org's GitHub Project into the
`m3l-automation` repository to centralize it with the already-configured
issues and milestones, plus assess using the repo's Wiki, Discussions, and
Insights features, and separately wanted a quickly accessible surface for
jotting down notes/ideas before they go through the usual issue-filing
procedure.

An `/auditing` fan-out over the repo's existing hub-sync tooling, GitHub
feature-stance surface, and idea-capture pipeline was combined with live
`gh`/GraphQL inspection of the actual repository and organization state. That
combination mattered: `bin/lib/hub-sync.mjs`'s `OWNER`/`REPO` constants and
`HUB_PROJECT_TITLE`-based lookup told only half the story — reading them alone
would have missed that the org project was never actually linked to the repo
(`repository.projectsV2.totalCount` was `0`), and reading only the ADRs would
have missed that GraphQL's `ProjectV2Owner` union has no `Repository` member at
all, making the literal ask ("move the project into the repo") impossible
regardless of implementation.

## Approach / Decisions

**The premise needed correcting before planning could start.** A Project can
only be owned by a `User`, `Organization`, `Issue`, or `PullRequest` — never a
repository — and classic repo-owned projects are retired platform-wide. The
audit surfaced this from GraphQL schema introspection, not from any doc in the
repo, and it reframed the ask from "move" to "link": `linkProjectV2ToRepository`
surfaces an org-owned board in the repo's Projects tab without changing
ownership. This was presented to the user as a corrected premise before any
plan was drafted, per this repo's stance on re-deriving authored claims before
acting on them.

**Feature-by-feature stance, mirroring the ADR-0030 precedent.** Wiki,
Discussions, and Projects were all enabled-by-default with zero use and no
recorded reason — the same "ambient default" failure ADR-0030 fixed for
gh-CLI-vs-MCP tool access. ADR-0050 applies the same discipline per platform
feature: Wiki disabled (the ~321-file `docs/` corpus is already
CI-gated in ways a wiki never would be), Discussions adopted narrowly (`Ideas`

- `Q&A` only, pruning four unused stock categories), Projects linked and kept
  private, Insights left automatic with its Pages-dashboard overlap acknowledged
  rather than resolved.

**Two-lane idea capture, verified safe by reading code rather than assuming
it.** The user's "quick jotting" ask was answered by giving private board
draft items and public Discussions posts distinct roles (unfinished thought vs.
worth discussing), both promoting into the existing tracker-row pipeline. The
safety claim — that a draft item can never be touched by `sync-hub-projects.mjs`
— was verified against `loadProjectItems`'s `issueNumber` filter and
`planProjectSync`'s tracked-issues-only iteration before being asserted in
`docs/contributing/filing-work.md` and ADR-0032's addendum, rather than assumed
from the sync's general shape.

**A new gate had to mirror an existing one's scope limit exactly.**
`check:github-features` (ADR-0050's drift gate) is deliberately scoped to what
a plain `GITHUB_TOKEN` can read — repo metadata, not the Projects board's
link/visibility/views, which need the `project` OAuth scope Actions tokens
never carry. This is the same boundary `check:hub-drift` already respects
(ADR-0032's 2026-07-22 correction); the new gate's header comment states it
explicitly so a future edit doesn't try to widen it.

## Outcome

- `docs/adr/0050-github-platform-feature-stance.md` — new; records the
  per-feature decision and the `ProjectV2Owner` schema finding
- `docs/adr/0032-project-management-visibility-hub.md` — 2026-08-19 addendum:
  the board's owner scope, the link, and the draft-item idea-capture lane
- `docs/contributing/filing-work.md` — new; the two-lane procedure, pointed to
  from `.github/CONTRIBUTING.md`, `docs/contributing/contributing.md`, and both
  trackers' Maintenance sections
- `.github/SUPPORT.md` — new; `.github/ISSUE_TEMPLATE/config.yml` gained
  Discussions `Ideas`/`Q&A` contact links alongside the existing security-advisory
  one
- `bin/lib/github-features.mjs` + `bin/check-github-features.mjs` — new
  `check:github-features` gate, wired into the standard four sites
  (`package.json`, `bin/lib/command-catalog.mjs`, `bin/lib/verify-steps.mjs`,
  `.github/workflows/ci.yml`, push-only); `bin/tests/check-github-features.test.ts`
  — 18 tests (dispatched to `test-author`, the only guarded-path write)
- `bin/sync-hub-issues.mjs` — bootstrapped the `triage` label
  `.github/ISSUE_TEMPLATE/failure_report.yml` had been declaring but GitHub
  never created (verified 404 live); `bin/tests/hub-sync-runners.test.ts`'s
  label-bootstrap-count assertion updated 7 → 8 (also `test-author`)
- `docs/ROADMAP.md`/`docs/plans/IMPLEMENTATION.md` — T9–T11/F18 rows for
  collateral findings (two ADRs' stale claims, a gate-naming collision, the
  Pages dashboard's corpus gap) left for a follow-up change, not fixed here
- Live GitHub settings applied (maintainer-local, `gh` CLI, `project` scope
  present): board linked (`repository.projectsV2.totalCount`: 0 → 1), wiki
  disabled, description/homepage/topics set, `triage` label live-verified
  present; `sync:hub -- --apply` run twice to converge the four new tracker
  rows, `check:hub-drift` and `check:github-features` both pass live. Project
  default-repository, curated board views, and Discussion category pruning
  remain manual — no `gh` command or GraphQL mutation covers them
- `pnpm verify`: 40/40 applicable steps pass (`check:hub-drift` and
  `check:github-features` both push-only, skipped locally by design but run
  and passed by hand against live state); full suite 181 test files, 7,250
  tests, all green
