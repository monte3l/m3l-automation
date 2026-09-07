# Document CodeQL scan timing and alert-readiness polling (issue #997, H4)

**Status: shipped** — PR #1083.

## Context

`docs/ROADMAP.md`'s H4 governance row (synced to GitHub issue #997) reported
that `creating-prs` Step 8 and `triaging-scan-alerts` documented that
post-push alerts "only appear after the post-push scan" with no
duration/polling guidance and no stated rationale for the omission.

Re-deriving the premise before acting on it (per `CLAUDE.md`'s Task Workflow
rule) found it half wrong: the "post-push scan" phrase lived in exactly one
place — `creating-prs/SKILL.md` — never in `triaging-scan-alerts`, whose real
gap was an unwritten reactive-by-design rationale, not a timing claim. Both
skills also carried a separate, previously-unfiled drift in the same
sentences: they claimed the per-language `Analyze (...)` check-runs "are
required to merge," when `docs/contributing/branch-protection.md` already
documented the required merge context as the single consolidated `CodeQL`
check. That correction turned out to be load-bearing, not incidental — live
measurement (`gh api .../commits/<sha>/check-runs` across 12 merged-PR head
SHAs + 5 direct `main` pushes, 2026-09-07) showed the required `CodeQL`
check completing **25–58 s before** the `Analyze (javascript-typescript)` run
that actually produces the alerts, in 12 of 12 sampled PR heads. So `CodeQL`
reporting green is not a valid signal that alerts for the newly pushed code
are queryable — the exact gap H4 was filed to close.

## Approach / Decisions

- **One canonical statement, both skills link to it** — matching the H3/#1045
  precedent. A new `## CodeQL scan timing and alert readiness` section in
  `docs/contributing/branch-protection.md` carries the measured durations
  and the `CodeQL`-green-is-not-alerts-ready trap; both skills carry a short
  actionable line plus a `§`-anchor citation rather than restating the
  numbers.
- **A real polling step, not just a forward-reference.** `triaging-scan-alerts`
  gained `### 1a — Confirm the scan for this head has finished`, polling the
  `Analyze (...)` check-runs (never the required `CodeQL` check) before
  triaging — this is what actually satisfies "no duration/polling guidance,"
  beyond documenting the fact. A skip clause (pre-saved alert export, or a
  head pushed more than ~5 min ago) keeps the four existing eval fixtures
  (which all supply alerts as a saved export) unaffected.
- **The reactive-by-design rationale went in the skill's opening context
  block**, not a step, since it's a scope statement a reader needs before
  reading any step: the skill only reads what code scanning has already
  published, because a scan cannot analyze code that hasn't been pushed yet.
- **Folded the `Analyze (...)`-is-required correction into this PR** at all
  three sites (`creating-prs` Step 8, `triaging-scan-alerts`' opening block,
  and its "Report the gate" step) rather than filing it separately — the two
  defects are the same sentences, and the new timing guidance depends on the
  corrected required-context fact to make sense.
- Also added one sentence to `creating-prs` Step 15's auto-merge tradeoff
  bullet: an armed `--auto` merge can land before the `Analyze (...)` run
  that would surface a new alert has finished, strengthening a guardrail
  already in the file rather than opening a new scope.

## Outcome

Three hand-authored files changed (`docs/contributing/branch-protection.md`,
`.claude/skills/creating-prs/SKILL.md`,
`.claude/skills/triaging-scan-alerts/SKILL.md`); `docs/adr/provenance.json`
mechanically re-stamped by `pnpm sync:docs` (blob SHA + date bump for ADRs
citing `branch-protection.md`). Docs/`.claude`-only, zero semver impact — no
`src/`, test, or `exports`-map change. `pnpm verify` passed (66 steps, 10
skipped push-only/e2e), `docs-consistency-reviewer` found no findings, and 0
open error-severity CodeQL alerts touched any changed file at push time.
`docs/ROADMAP.md`'s H4 row flips to `Done` and issue #997 closes on the
post-merge `pnpm sync:hub -- --apply` run (`finishing-work` Step 5).
