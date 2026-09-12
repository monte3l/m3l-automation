# Issue #1193 — bind should-fix-ack acknowledgment to the round that raised it

**Status: shipped** — three PRs: #1198 (`fix/tests-rule-notes-count-scope`),
#1202 (`fix/should-fix-ack-per-round-binding`, closes #1193), and #1205
(`docs/issue-1193-work-log`). Narrative log:
`docs/logs/2026-09-12-issue-1193-should-fix-ack-per-round-binding.md`.

## Context

Issue #1193 reported that `bin/check-should-fix-ack.mjs` asked only "does any
`Acknowledged-Should-Fix:` trailer exist anywhere in `base..head`" — so a
footer written for one review round's findings silently satisfied a later
round's brand-new, unrelated findings, observed live on PR #1190 (round 1
posted 2 findings, answered by a footer; round 2 posted 2 different findings;
the gate passed vacuously at round 2's head). A separate, related claim named
`.claude/rules/tests.md:93-95` as an unscoped rule that produced a false
Should-fix on that same PR (demanding a Notes-count update for scripts tests
`check:test-counts` never tracks).

Both claims were investigated and validated — against the code, a direct
repro, the GitHub API, and this repo's own `docs/logs/2026-09-11-v13-flow-process-group-teardown.md`,
which had already recorded the bug firing live — before any fix was written.

## Approach / Decisions

Confirmed with the maintainer via `AskUserQuestion` before implementation:

- **Gate fix direction:** per-round SHA-scoped range (issue's direction 3,
  sharpened), not the count-based, identity-bound, or convergence-rule-amendment
  alternatives the issue also named.
- **PR split:** two independent PRs (ADR-0072) rather than one combined change.
- **`tests.md` context-budget payment:** offset the added scoping language by
  trimming a redundant clause in the same file, rather than refreshing the
  ratchet baseline.
- **Required-check promotion:** `should-fix-ack` stays non-required; a
  behavior change of this scope restarts ADR-0097's dogfood observation
  period rather than carrying over evidence gathered under the old logic.
- **Forced empty-range consequence:** the round that just posted a finding
  has its own reviewed commit as `head`, so its range is empty and that run
  always fails once, with no commit yet able to carry the footer — confirmed
  as correct-not-a-bug rather than adding a grace period that would reopen a
  narrower version of the original gap (a PR merged immediately after that
  run, with no further push).

PR #1198 scoped the Notes-count rule to `packages/m3l-common/tests`. PR #1202
added `collectShouldFixRounds`/`planShouldFixAckRanges`/`describeShouldFixAckOutcome`
to `bin/lib/pr-review-gate.mjs` and `classifyReviewedSha`/`evaluateShouldFixAck`
to `bin/check-should-fix-ack.mjs`, replacing the single "loudest comment vs.
whole-PR range" check with per-round binding; `selectShouldFixComment` itself
stayed byte-identical (still backing `bin/lib/should-fix-backfill.mjs`'s
historical measurement) with only its JSDoc corrected. `docs/adr/0097` gained
an `## Update` section recording the disproven design premise. PR #1205
recorded the narrative.

## Outcome

Both fixes verified live against real PR #1190 data and mutation-tested (the
range-scoping fix and the same-sha dedup's round-ordinal preservation, the
latter added mid-review after `code-reviewer` flagged it as a Should-fix on
PR #1202 itself). `claude-pr-review` on PR #1202 posted 1 Should-fix + 2 nits
on its own first round — triggering the gate's own just-shipped "empty range,
fails once" behavior live, on the PR that shipped it — acknowledged via a
commit footer (the degraded-round-floor point disputed as an already-documented
trade-off) and cleared on the next push. All three PRs merged clean.
