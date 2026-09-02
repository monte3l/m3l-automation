# claude-pr-review.yml + resolving-pr-comments — mechanics revision

**Status: shipped** — PR 1 #855 (`d8ae677e`), PR 2 #860 (`d9d97002`), PR 3
#871 (`530e5655`), PR 4 #877. Follows the review-gate tuning recorded in
`2026-07-13-pr-review-hardening.md` and `2026-08-20-pr-review-turn-budget.md`.

## Context

A 25-agent audit (20-agent fanout with adversarial verification + a 4-agent
`researching-anthropic-guidance` pass) reconstructed how `claude-pr-review.yml`
and `resolving-pr-comments` had actually performed against live GitHub data
(PRs #785–#851, 22 reviewed PRs, about 32 review runs). Only 18% of PRs ever
raised a Must-fix, but PR #839 needed 4 rounds and #822/#787 each burned 4
full Opus-5 reviews (roughly $2.50 and 20 minutes apiece) on PASS-only churn.
Two PRs (#785,
#806) — both editing the workflow file itself — had merged with a **failing
required check**, because the gate structurally cannot review changes to
itself and no test harness existed to validate such changes any other way;
three consecutive historical fixes to the gate (#503, #504, #566) had shipped
on inference, two of them breaking production first.

The explicit framing for the whole effort, stated at the outset and held to
throughout: fix **mechanics** — verdict safety, contract duplication, loop
economics, skill accuracy — not the review policy's content (severity tiers,
what gets excluded, what blocks merge). Four independently-landable PRs, in
order, since PR 1 was what made the gate itself trustworthy for reviewing
PRs 2–4.

## Approach / Decisions

1. **PR 1 — verdict safety + a test harness.** Extracted the guard/Enforce
   decision logic into `bin/lib/pr-review-gate.mjs` (mirroring the
   `bin/lib/pr-diff-filter.mjs` precedent), unit-tested in
   `bin/tests/pr-review-gate.test.ts` — closing the "three historical fixes,
   two of which broke production, zero test coverage" gap directly. Fixed a
   verdict-parsing false positive (a bare word-search over the lines after
   `### Verdict` would read a FAIL whose reason text contained the word
   "pass" as a PASS; replaced with an anchored bullet-form match). SHA-pinned
   the primary verdict file (`PASS <sha>` / `FAIL <sha>`) so a stale verdict
   left over from an earlier commit can never be mistaken for a fresh one.
   Widened the self-review auto-pass from "workflow is the PR's sole
   reviewable change" to "workflow is among the reviewable changes" (still
   gated on proof the action never attempted a review), closing the
   #785/#806 merge-with-failing-check pattern.
2. **PR 2 — contract de-duplication.** REVIEW.md's own "Where this is
   enforced" table claimed the workflow prompt stayed in sync with it, but
   `check:review-policy` only ever compared one number (the finding cap)
   across six files — severity tiers, exclusions, and output format could
   all drift silently. Added the missing Severity tiers and Output format
   sections to REVIEW.md itself (they existed only in the prompt) and
   extended `check-review-policy.mjs` with `diffSeverityTiers`,
   `diffExclusions`, and `diffOutputFormatLiterals`, verified by
   deliberately corrupting REVIEW.md and confirming the gate caught it.
   De-duplicated `bin/check-review-size.mjs`'s hand-rolled ignore predicate
   against `bin/lib/pr-diff-filter.mjs`'s — the two had drifted, so a PR
   could measure under the local soft target and still trip
   `MAX_REVIEWABLE_BYTES` in CI.
3. **PR 3 — skill de-rot + evals.** `resolving-pr-comments` still described
   the "all four gates" cadence pre-`pnpm verify`, a rebase rationale the
   bot could no longer trigger (it runs with `contents: read`), and a
   hardcoded "N of 22" doc count. Also found and fixed a live behavioral
   gap while re-examining the skill's Should-fix/Nit handling: a PASS
   verdict skipped the Should-fix/Nits preview entirely, contradicting the
   skill's own stated "showing Should-fix / Nits for context" promise —
   since most reviewed PRs never raise a Must-fix, this broke the promise
   for the majority of invocations, not an edge case. Replaced the
   Must-fix-only fix policy with a tiered one (Must-fix mandatory,
   Should-fix best-effort/skippable, Nits folded in only when they overlap
   an already-edited region), locked in by a new adversarial eval case.
4. **PR 4 — loop economics.** Delta re-review: the guard step's "reviewable
   file changed since a prior PASS" branch now feeds the precompute step a
   `gh api compare/<reviewed-sha>...<head-sha>` patch instead of the full
   diff, plus the prior round's Must-fix list — `bin/lib/pr-review-gate.mjs`'s
   `buildDeltaPatch()` reconstructs a synthetic patch in the exact shape
   `bin/lib/pr-diff-filter.mjs` already expects, so filtering and size
   measurement apply unmodified. Round bound: after `MAX_REVIEW_ROUNDS` (3)
   review comments, the guard step stops triggering further reviews and
   escalates to a human with a FAIL verdict instead. Override procedure
   documented in `branch-protection.md`, formalizing PR #723's ad hoc path.
   Re-probing `--allowedTools` surfaced a scoping error in the plan's own
   framing: `.claude-code-version` does not govern `claude-pr-review.yml` at
   all (it gates `skill-evals.yml`/`maintain-scan.yml` only) — the action
   pins `@anthropic-ai/claude-agent-sdk@^0.3.251`, a different package on a
   different version scheme, so a precise local re-probe of "the pinned CLI
   version" was never actually possible; documented as a methodology
   correction rather than papered over.

**A pre-push 3-spoke review of PR 4 (`code-reviewer`, `silent-failure-hunter`,
`security-reviewer`) found four real issues, fixed before merge**: a
committed `.claude-prior-mustfix.md` or `.claude-review-verdict` (neither
gitignored) could feed the reviewer forged trust signals — a prompt-injection
/ review-bypass vector, closed with a checkout-time artifact-cleanup step;
`buildDeltaPatch()` conflated "binary file" with "diff too large for GitHub's
compare API to return," silently hiding real reviewable content with no
size-gate trip — now returns `null` to force the existing full-diff fallback,
and also handles GitHub's 300-file compare-API cap; the round counter counted
every `claude[bot]`-authored comment, including unrelated
`claude-assistant.yml` replies (that workflow has no actor allowlist) — now
scoped via `countReviewComments()` to comments that parse an actual verdict;
and the round-limit check only guarded 2 of 6 guard-step re-review branches,
fixed with a `review_or_escalate()` helper applied uniformly. A separate
concern — that `use_sticky_comment: true` might collapse every round into one
edited comment, making the round counter permanently stuck at 1 — was
investigated and refuted with direct evidence: `gh api` on PR #839 showed 4
distinct `claude[bot]` comment IDs, each `created_at == updated_at`.

## Outcome

All four PRs landed independently, in the planned order, each gated on its
own `pnpm verify` pass and its own pre-push review. `bin/tests/pr-review-gate.test.ts`
grew from nonexistent (PR 1's own starting point) to 50 tests across
verdict/SHA parsing, workflow-gate-change detection, Must-fix-section
parsing, delta-patch reconstruction (including the two PR-4 security fixes
and the 300-file cap boundary), and review-comment counting.

The loop-economics changes (delta patch, round bound) are not yet
observable in production — they activate only on a PR that reaches PASS and
then changes again, or that runs past 3 review rounds, neither of which had
occurred by the time PR 4 shipped. The metrics step now reports review mode
(full vs. delta) in its job summary; that, plus `permission_denials`
telemetry already in place, is the intended way to validate the loop
economics and the `--allowedTools` re-probe finding going forward — not
another round of local CLI probing, per PR 4's own methodology correction.
