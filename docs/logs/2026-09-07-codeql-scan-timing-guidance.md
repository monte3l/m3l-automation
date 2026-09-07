# Work log — codeql-scan-timing-guidance (2026-09-07)

This log covers resolving GitHub issue #997 (ROADMAP row H4): documenting
CodeQL scan timing and adding polling guidance to `triaging-scan-alerts` and
`creating-prs`. It records the premise re-derivation, the live measurement
that grounded the fix, the design decisions, a real rebase-time merge
conflict against a concurrently-merged PR, and the tracker/`sync:hub`
close-out.

Plan of record: [`docs/plans/archive/2026-09-07-codeql-scan-timing-guidance.md`](../plans/archive/2026-09-07-codeql-scan-timing-guidance.md)

## Summary

Two PRs. **PR #1083** (the fix): new `## CodeQL scan timing and alert
readiness` section in `docs/contributing/branch-protection.md` (measured
scan durations, the `CodeQL`-green-is-not-alerts-ready trap, a
`gh api .../check-runs` poll command); a new `### 1a — Confirm the scan for
this head has finished` step in `triaging-scan-alerts/SKILL.md` plus a
written reactive-by-design rationale paragraph; corrected wording in
`creating-prs/SKILL.md` (Step 8's forward-reference, Step 15's auto-merge
tradeoff) and `triaging-scan-alerts/SKILL.md` (opening context block,
"Report the gate" step) fixing a separate, previously-unfiled drift — both
skills claimed the per-language `Analyze (...)` check-runs are the required
merge context, when `branch-protection.md` already documented the required
context as the single consolidated `CodeQL` check. **PR #1084**
(`docs/h4-tracker-flip`, this session): flips `docs/ROADMAP.md`'s H4 row to
`Done`, and the `pnpm sync:hub -- --apply` close-out that closed issue #997
and archived its board item.

Docs/`.claude`-only across both PRs — zero semver impact, no `src/`, test,
or `exports`-map change. `pnpm verify` passed twice on PR #1083 (66 steps,
10 skipped, both before and after a rebase — see divergence #1), `pnpm
sync:docs` passed 15/15 both times, and a `docs-consistency-reviewer`
dispatch found no findings.

Skills used: starting-work, creating-prs, syncing-docs, docs-consistency-reviewer (dispatched), finishing-work, writing-work-logs.

Spoke incidents: none. `tmp/session-incidents.jsonl` absent (no truncations
recorded); no stalls or resumes observed — both dispatched agents (the
Explore-style fact-gathering agent and the Plan-mode design agent) returned
complete, well-formed reports on their first pass.

Compaction events: none.

## What went as planned

- **Premise re-derivation caught a real inversion before any edit.** The
  issue text claimed both `creating-prs` and `triaging-scan-alerts`
  documented the "post-push scan" phrase; grepping first found it in exactly
  one file. Acting on the filed text without re-deriving would have produced
  a fix aimed at a gap that didn't exist in `triaging-scan-alerts`.
- **Live measurement produced a 12-of-12 finding, not a guess.** `gh api
.../commits/<sha>/check-runs` across 12 merged-PR head SHAs and 5 direct
  `main` pushes showed the required `CodeQL` check completing 25–58 s before
  `Analyze (javascript-typescript)` in every sampled PR head — corroborated
  independently against `code-scanning/analyses` upload timestamps for one
  PR (#1080), not just check-run inference.
- **A background design agent, dispatched in parallel with a plan-mode
  Explore agent, independently re-verified the same measurement** (its own
  4-PR-head sample) and surfaced two refinements adopted into the final
  plan: a proper `##` top-level section (matching the file's own existing
  `§`-citation idiom) instead of a bullet continuation, and a real `### 1a`
  polling step in `triaging-scan-alerts` — the part of H4's ask ("no
  duration/polling guidance") a pure documentation fix would have left only
  half-satisfied.
- **The eval-fixture risk was caught and designed around before writing the
  step**, not discovered by a failing eval afterward: all four
  `triaging-scan-alerts` eval cases supply alerts as a saved export, so
  `### 1a`'s skip clause ("Skip this step if the alerts were handed to
  you...") was written to cover exactly that shape from the start.
- **The live re-derivation of the "0 open alerts" claim held** —
  `skills-catalog.md` L112's 2026-08-31 stat was still accurate on
  2026-09-07, so no refresh was needed.
- **PR #1083's own gates verified its own claim.** After the second push,
  the PR's live check-runs were re-measured and confirmed `CodeQL` passing
  before `Analyze (javascript-typescript)` — the exact ordering the PR's own
  new documentation asserts, on the PR that introduces it.

## What didn't go as planned, and why

### 1. `gh pr merge` hit a real merge conflict from a concurrently-merged PR

After all four required checks passed and the user confirmed the merge
(`gh pr merge 1083 --squash`), GitHub returned `GraphQL: Pull Request has
merge conflicts`. Between the branch's last rebase and the merge attempt,
`main` had advanced by three commits, one of which (`feat: enforce
Should-fix acknowledgment as a new PR review job`, #1082) touched two of the
same three hand-authored files this PR changed:
`.claude/skills/creating-prs/SKILL.md` and
`docs/contributing/branch-protection.md`.

`git rebase origin/main` surfaced two conflicts, both non-substantive: a
derived-artifact conflict in `docs/adr/provenance.json` (both sides
re-stamped the same ADR-citation blob SHAs from different content — not
covered by the `merge=m3l-generated` driver, since only
`docs/reference/catalog.json`/`symbol-map.json`/`pnpm-lock.yaml` carry that
attribute, per `.gitattributes`' own comment that ADR provenance is
deliberately excluded), and a table-append conflict in `docs/plans/README.md`
(both PRs added an archive-table row at the same insertion point). Neither
`creating-prs/SKILL.md` nor `branch-protection.md` actually conflicted —
git's three-way merge resolved both files' non-overlapping hunks
automatically. Resolved `provenance.json` with `--ours` to unblock the
rebase, then fully regenerated it via `pnpm gen:adr-provenance` afterward
(the `--ours` pick was stale the moment the rebase pulled in more of
`main`'s history, confirmed by `check:adr-provenance` immediately flagging 6
ADRs as needing re-derivation); kept both rows in `docs/plans/README.md` by
hand. Re-ran `pnpm verify` (green, 66/10) and `pnpm sync:docs` (15/15) after
the rebase before force-with-lease pushing and re-confirming all four
required checks passed a second time.

**Why it happened:** The gap between "rebased and pushed" (Step 2 of
`creating-prs`) and the actual `gh pr merge` call spanned the full CI run —
required checks plus a manual user-confirmation round-trip — long enough for
an unrelated PR to land on `main` first. `creating-prs` Step 14 only checks
`mergeable`/`mergeStateStatus` right after opening the PR; nothing re-checks
it immediately before the actual merge call.

**Fix for future:** Treat a `gh pr merge` conflict error as an expected,
recoverable outcome on any branch that waited through a full CI cycle before
merging, not a surprise — `creating-prs` Step 2's rebase-and-resolve
procedure applies identically at merge time, not just at push time. A
derived-artifact JSON conflict (any file re-stamped by `sync:docs`/`gen:*`
but not covered by a `merge=m3l-generated` `.gitattributes` entry) resolves
fastest by picking either side to unblock the rebase, then fully
regenerating via its own `gen:*` command afterward and re-verifying with the
matching `check:*` — never by hand-merging the JSON.

## Lessons learned

- **A merge-time conflict is a normal consequence of a long CI-wait window,
  not an anomaly.** Between rebasing/pushing and the actual `gh pr merge`
  call, required-check wall-clock plus a user-confirmation round-trip is
  enough time for another PR to land first. Re-run `creating-prs` Step 2's
  rebase procedure at merge time exactly as at push time, rather than
  treating `GraphQL: Pull Request has merge conflicts` as unexpected.
  _(promoted → `.claude/skills/creating-prs/SKILL.md`)_
- **A derived JSON file not covered by `merge=m3l-generated` still resolves
  mechanically — regenerate, don't hand-merge.** `docs/adr/provenance.json`
  conflicts the same way `docs/reference/catalog.json` does (both are
  blob-SHA-keyed re-stamps), but `.gitattributes` deliberately excludes it
  from the auto-resolving driver. Pick either side to unblock the rebase,
  then run its `gen:*` command and matching `check:*` gate immediately after
  — a stale `--ours`/`--theirs` pick is caught within one command, not
  silently shipped. Also true of a growing table's row-append conflict
  (`docs/plans/README.md`'s Archive table): keep both sides' new rows rather
  than treating the marker as a real disagreement.
  _(promoted → `.claude/skills/resolving-merge-conflicts/SKILL.md`)_
- **Design a new polling/wait step around existing eval fixtures before
  writing it, not after a red eval.** Every fixture in
  `triaging-scan-alerts/evals/evals.json` supplies alerts as a pre-saved
  export; the new `### 1a` step's skip clause was scoped to that shape from
  the first draft specifically because the fixtures were read first.
- **A background verification agent run in parallel with plan-mode
  exploration is worth the dispatch even when the hub already has an
  answer.** The design agent's independent re-measurement and two concrete
  refinements (a proper `##` section, a real polling step rather than just
  documentation) materially improved the shipped fix over the hub's own
  first-pass plan, at no serial time cost since both agents ran
  concurrently.
- **Corroborate a check-run-timing finding against the platform's own
  authoritative timestamp, not just other check-runs.** Cross-checking one
  sample's `CodeQL` completion time against `code-scanning/analyses`'
  upload timestamp (not just against `Analyze (...)`'s own check-run
  completion) confirmed the finding wasn't an artifact of how GitHub's
  Checks API orders concurrently-completing runs.
