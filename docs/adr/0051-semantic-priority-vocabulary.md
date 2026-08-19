# 0051. Semantic priority vocabulary for labels, milestones, and tracker cells

- **Status:** Accepted
- **Date:** 2026-08-20
- **Deciders:** Enrico Lionello (maintainer); Claude (audit + implementation)

## Context and problem statement

ADR-0032 encoded work priority as GitHub labels `priority:p0`/`priority:p1`/
`priority:p2`/`priority:governance`, mirrored by milestones `Priority 0`/
`Priority 1`/`Priority 2`/`Governance`, and by `P0`/`P1`/`P2` cells in
`docs/plans/IMPLEMENTATION.md`'s Priority column. Its 2026-08-19 Update
declared that vocabulary complete, rejecting a stray `P3` cell as a typo.

The letter-and-number scheme carries no meaning at the point of use: a reader
on GitHub sees `priority:p1` and cannot tell what tier it names without
looking it up. The only prose defining the tiers was a one-line gloss in
`docs/plans/IMPLEMENTATION.md`'s header ("`P0` unblock-first · `P1` fleet ·
`P2` gated/deferred"); `docs/contributing/filing-work.md`, the doc that tells
a maintainer how to file a tracker row, never explained what a tier means or
how to pick one.

A repo audit (see the `/auditing` fan-out that produced this ADR) also found
the scheme had drifted into **six independent naming registers for one
concept**: the GitHub label (`priority:p0`), the milestone title
(`Priority 0`), the tracker cell (`P0`), the ROADMAP `##`-level heading
(`## Priority 0`), the internal `Item.priority` union key (`"p0"`), and the
`extractRoadmap` result-shape key (`priority0`) — with `governance` alone
spelled three different ways (`priority:governance` / `Governance` /
`Governance follow-ups`). Worse, `governance` was filed under the `priority:`
label prefix as if it were a fourth tier, but `classifyPriorityCell`
(`bin/lib/project-hub.mjs`) never had a governance branch — a governance
row's Priority cell is always the untiered dash placeholder, not a tier of
its own. The label taxonomy and the tracker-cell taxonomy disagreed about
what `governance` even was.

Separately, the audit found `ROADMAP_ANCHORS` (`bin/lib/hub-sync.mjs`) had
been wrong since it was written: `p0`/`p1` emitted `#priority-0`/
`#priority-1`, but GitHub's real anchor for
`## Priority 0 — Library hardening (do before more scripts)` is
`#priority-0--library-hardening-do-before-more-scripts` — every synced
deep-link for those two sections landed at the top of the file instead of
the section itself.

## Decision drivers

- A reader should be able to tell what a priority label/milestone means
  without a lookup.
- GitHub sorts labels alphabetically in its UI; the new vocabulary should
  still read in tier order in that sidebar.
- `governance` is a category (ADR/process follow-up work), not a priority
  tier, and should stop pretending to be one.
- The 148 issues and 5 milestones already carrying the old vocabulary must
  migrate without losing history — a rename in place, not a
  delete-and-recreate.
- Minimize blast radius: only the layers that are actually confusing
  (GitHub-facing label/milestone, and the tracker cell that maps directly to
  them) need to change. The ROADMAP's own `## Priority N` headings are
  internal document structure, not a GitHub-facing name, and don't need to
  move for this problem to be solved.

## Considered options

1. **Numbered-semantic hybrid** (`priority:0-now`, `priority:1-next`,
   `priority:2-later`) — a leading digit preserves GitHub's alphabetical
   label-sidebar sort in tier order, the suffix carries meaning.
2. **Pure semantic** (`priority:now`, `priority:next`, `priority:later`) —
   cleaner, but sorts alphabetically as `later`/`next`/`now`, losing tier
   order in the label sidebar.
3. **Severity register** (`priority:critical`/`high`/`low`) — familiar, but
   these tiers encode roadmap _sequencing_ ("do before more scripts"), not
   defect severity; no item here is a live incident, and the framing would
   mislead.
4. **Repo-domain terms verbatim** (`priority:unblock-first`/`fleet`/`gated`)
   — maximum fidelity to the existing informal gloss, but encodes _scope_
   more than priority, and `gated` specifically misdescribes the many
   `Later`-tier rows that are simply deferred, not blocked on a real gate.

## Decision

We chose **option 1, the numbered-semantic hybrid**, plus moving
`governance` out of the priority-tier namespace entirely.

| Layer                                     | Old                   | New                      |
| ----------------------------------------- | --------------------- | ------------------------ |
| Label (`p0`)                              | `priority:p0`         | `priority:0-now`         |
| Label (`p1`)                              | `priority:p1`         | `priority:1-next`        |
| Label (`p2`)                              | `priority:p2`         | `priority:2-later`       |
| Label (governance)                        | `priority:governance` | `type:governance`        |
| Milestone (`p0`)                          | `Priority 0`          | `Now — unblock first`    |
| Milestone (`p1`)                          | `Priority 1`          | `Next — consumer fleet`  |
| Milestone (`p2`)                          | `Priority 2`          | `Later — gated/deferred` |
| Milestone (governance)                    | `Governance`          | unchanged                |
| Milestone (major bump)                    | `2.0 / breaking`      | unchanged                |
| Tracker cell (`p0`)                       | `P0`                  | `Now`                    |
| Tracker cell (`p1`)                       | `P1`                  | `Next`                   |
| Tracker cell (`p2`)                       | `P2`                  | `Later`                  |
| `IMPLEMENTATION.md` gated section heading | `(P2)`                | `(Later)`                |

**Deliberately unchanged:** `docs/ROADMAP.md`'s `## Priority 0` /
`## Priority 1` / `## Priority 2` / `## Governance follow-ups (…)` section
headings, and the internal `Item.priority` union keys (`"p0"|"p1"|"p2"|
"governance"`) and `roadmap:p0:<slug>` / `impl:gated:<slug>` issue-marker
keys derived from them. Renaming either would require migrating 148 issues'
persisted `<!-- m3l-hub-sync:<key> -->` markers via `Item.legacyKeys` (the
mechanism ADR-0032's 2026-08-19 hub-sync key-namespace work introduced for
exactly this kind of rename) for no reader-facing benefit — the confusion
this ADR fixes lives entirely on the GitHub-facing surface and the tracker
cell that maps directly to it, not in internal identifiers or document
structure a reader never sees as a "label."

**`governance` moves to `type:governance`.** It was filed under the
`priority:` prefix as if it were a fourth tier, but `classifyPriorityCell`
never recognized it as one — a governance row's Priority cell is always the
untiered dash placeholder. Splitting it into its own `type:` namespace makes
`priority:*` mean exactly three ordered tiers, with `type:governance`
correctly describing what it always was: a category for ADR/process
follow-up work, not a point on the priority scale. It keeps its own
`Governance` milestone unchanged.

**`ROADMAP_ANCHORS` values are corrected** in the same change (not a
separate ADR — this is a bug fix riding alongside the rename, not a new
decision): `p0`/`p1`/`governance` now emit the real GitHub anchor slugs
(`#priority-0--library-hardening-do-before-more-scripts`,
`#priority-1--consumer-fleet`, `#governance-follow-ups-adr-0028--adr-0029`)
instead of the truncated ones that never matched a real heading.

**Migration:** every existing label/milestone is renamed in place
(`gh label edit --name`, milestone `PATCH`), which preserves all 148 issue
label assignments atomically and leaves no orphan label object — never a
delete-and-recreate. `bin/lib/hub-sync.mjs`'s `isManagedLabel`/
`staleManagedLabels` (`bin/sync-hub-issues.mjs`) now also track the `type:`
prefix, so a leftover `priority:governance` (if the in-place rename were
ever skipped for one issue) still self-heals on the next `sync:hub --apply`.

**New guardrails, closing gaps the audit found alongside the rename:**

- A priority legend in `docs/contributing/filing-work.md` — the tier
  meanings and how to choose one were previously undocumented anywhere a
  maintainer would look before filing a row.
- `bin/check-hub-keys.mjs` gained `findPriorityVocabularyMismatches`,
  asserting `PRIORITY_LABELS`, `MILESTONE_TITLES`, and `ROADMAP_ANCHORS`
  stay mutually consistent — previously a partial rename across these three
  tables failed only at runtime, as a silently `undefined` milestone lookup
  in `buildIssuePayload`.
- `bin/check-label-drift.mjs` (new `check:label-drift`, wired push-only into
  `ci.yml` beside `check:hub-drift` and `check:github-features`) — compares
  the live repository's labels against `bin/lib/label-defs.mjs`, the single
  source of truth `bin/sync-hub-issues.mjs`'s bootstrap step derives from.
  `check:hub-drift` only ever inspected an issue's own labels against its
  tracker row; nothing previously detected a hand-renamed or hand-deleted
  managed label on the repo itself.

## Consequences

- **Positive:** the label/milestone vocabulary is now self-explanatory on
  GitHub without a lookup; `governance` no longer masquerades as a priority
  tier; two previously-undetectable drift classes (vocabulary-table
  inconsistency, live-label drift) are now CI-gated; the broken ROADMAP
  anchors are fixed as a side effect.
- **Negative / trade-offs:** the vocabulary now has one register on GitHub
  (`Now`/`Next`/`Later`) and a different one in `docs/ROADMAP.md`'s section
  headings (`Priority 0`/`Priority 1`/`Priority 2`) — deliberately accepted
  (see Decision) to keep the blast radius bounded, but it means the mapping
  between the two must be learned from the legend in
  `docs/contributing/filing-work.md` rather than being self-evident from the
  heading text alone. A future ADR could align the ROADMAP headings too, if
  that seam ever becomes a real point of confusion in practice.
- **Semver impact:** none — this is internal tooling (`bin/**`) and process
  documentation; it does not touch `packages/m3l-common`'s `exports` map.

## Links

- Supersedes / superseded by: partially supersedes the priority-taxonomy
  portion of [ADR-0032](0032-project-management-visibility-hub.md) (its
  visibility-hub architecture, GitHub-projection design, and key-namespacing
  decisions are unaffected and remain in force)
- Related: [ADR-0050](0050-github-platform-feature-stance.md) (the GitHub
  platform-feature stance this label surface is part of);
  `docs/contributing/filing-work.md` (the priority legend this decision
  added); `docs/logs/2026-08-19-hub-sync-key-namespace.md` (the
  `legacyKeys` migration mechanism this decision deliberately did not need)
