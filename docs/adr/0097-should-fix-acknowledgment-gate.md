# 0097. A Should-fix acknowledgment gate for claude-pr-review

- **Status:** Accepted
- **Date:** 2026-09-07
- **Deciders:** Enrico Lionello (maintainer); Claude (audit + design)

## Context and problem statement

An audit of the review-severity pipeline found that REVIEW.md's three-tier severity vocabulary — Must-fix blocks merge,
Should-fix does not, Nit never does — was never itself recorded as a decision anywhere in the
96-ADR corpus that predated this one; only ADR-0010 mentions REVIEW.md at all, and only as a
markdown-lint subject. The Should-fix tier's non-blocking status is therefore accepted context
here, not a new decision, alongside the actual gap the audit found: **no gate anywhere in the
repo read the Should-fix tier at all.**

Concretely, before this ADR:

- `bin/lib/pr-review-gate.mjs` had `parseMustFixSection` and no Should-fix counterpart — no
  regex, no parser, no CLI mode.
- `check:review-policy` asserted the literal string `### Should-fix` appears in
  `claude-pr-review.yml`'s prompt, via the same code path that checks the `_None._`
  empty-tier placeholder — string parity, not resolution enforcement.
- No `pre-push` lefthook stage, and no required CI status check, could fail on an outstanding
  Should-fix. The four required contexts on `main` (`verify`, `review`, `CodeQL`,
  `Dependency Review`) are structurally incapable of it: `review` fails only on a Must-fix
  (`docs/contributing/branch-protection.md`), and `docs/contributing/branch-protection.md`
  itself states plainly that PASS is the verdict "even if unaddressed nits remain."

The audit also corrected two hypothesised root causes for merged-unresolved Should-fix findings.
Auto-merge is already mitigated: `creating-prs` defaults to a plain `gh pr merge --squash`, not
`--auto`, specifically because auto-merge previously let a review verdict land on an
already-merged PR (the U10 wave; the orphaned #951 commit). Manual override has no bypass either:
`bypass_actors: []` and `enforce_admins: true` on both protection layers, and the one override
path (`docs/contributing/branch-protection.md`'s "Overriding a disputed finding", formalising the
ad hoc path used on PR #723) is evidence-first and scoped to Must-fix. The actual mechanism is a
third one: nothing
requires _reading_ a posted review before merging — only that the `review` check reported — and
`resolving-pr-comments` stopped on a PASS verdict by design, which is the majority case (most
reviewed PRs never raise a Must-fix). Should-fix was therefore structurally invisible on most
PRs, not occasionally missed on a few.

## Decision drivers

- Should-fix must keep its non-blocking character — REVIEW.md's own tier definitions
  ("a real quality issue that does not block merge on its own") are sound design, not the
  defect. The fix is visibility and a recorded decision, not turning Should-fix into a
  second Must-fix.
- Any new enforcement must be a deterministic gate, not a norm relying on memory or
  diligence next time — the whole audit was prompted by exactly that failure mode.
- The gate must survive `claude-pr-review.yml`'s own "Re-review convergence" rule, which
  suppresses new Should-fix bullets to a summary count on any round after the first. A
  design that only reads the most recently posted review would silently stop enforcing
  the moment a PR reaches a second round.
- Minimal new surface area: reuse the existing severity-tier parser library
  (`bin/lib/pr-review-gate.mjs`) and the existing `check-exports-semver.mjs`-style
  commit-footer pattern rather than inventing a new mechanism.

## Considered options

1. **Do nothing — rely on reviewer/maintainer diligence.** Rejected: this is the status quo
   the audit was commissioned to fix; it has already produced merged-unresolved findings with
   no local record of the outcome.
2. **Promote Should-fix to a second Must-fix tier (block merge outright).** Rejected: contradicts
   REVIEW.md's own severity philosophy and this project's stated bias against padding the
   Must-fix list; would also block merge on findings the maintainer may legitimately judge as
   out of scope or wrong.
3. **A required CI status check that fails on any unacknowledged Should-fix, cleared by an
   explicit commit-footer trailer.** Chosen.
4. **A local-only (`pre-push`) gate.** Rejected as structurally impossible: `claude-pr-review.yml`
   runs after push, on GitHub's side, so a local pre-push hook can only ever see a _prior_
   round's findings, never the one just posted.

## Decision

We chose **option 3**: a new `should-fix-ack` job in `claude-pr-review.yml` (`needs: review`)
that fails when the PR's posted review carries a Should-fix finding with no
`Acknowledged-Should-Fix: <reason>` commit-footer trailer anywhere in the PR's commit range.
Should-fix stays non-blocking on correctness — the footer's reason can say "fixed," "deferred,"
or "disputed as wrong" with equal validity; the gate only checks that a decision was made and
recorded, never which one.

**Selection, not just presence.** The gate does not read only the most recently posted review
comment. `selectShouldFixComment` (`bin/lib/pr-review-gate.mjs`) picks whichever posted comment
carries the _maximum_ Should-fix finding count across the PR's whole history — round 1's real
bullets survive round 2+'s suppressed count-only summary, since no later round ever posts more
than the first did. This closes the enforcement gap the naive "latest comment" design would have
reopened, at a known cost: once round 1 posts a finding, the acknowledgment footer becomes the
only path this gate recognizes, even for one later genuinely fixed, because a suppressed
re-review can never prove a fix on its own to this parser. `bin/check-should-fix-ack.mjs`'s
failure message and REVIEW.md's own tier text both say this plainly.

**Staged rollout, not immediate enforcement.** The job runs and reports on every non-draft,
non-Dependabot PR today but is deliberately **not yet** registered as a required status check
on either branch-protection layer (`docs/contributing/branch-protection.md`) — a new gate earns
an observation period against real reviews before it can fail a merge. Registration is a
separate, explicit follow-up once that period confirms correct behaviour.

**Process surfaces updated to match:** `resolving-pr-comments` now continues past a PASS verdict
when the Should-fix section is non-empty (previously it stopped unconditionally on PASS), attempts
best-effort fixes, and adds the acknowledgment footer either way — using `git commit --allow-empty`
when every finding is left unaddressed and there is otherwise nothing to commit. `creating-prs`
Step 15 names `should-fix-ack` as a merge precondition regardless of its required-check status,
so no PR merged during the dogfood period needs a retrofit once it is promoted.

## Consequences

- **Positive:** every Should-fix finding a review ever posts is now either resolved or leaves a
  `git log`-durable, human-readable record of why not — closing the exact blind spot the audit
  found (an estimated 97%+ of merged, reviewed PRs had no local way to determine Should-fix
  disposition at all). The record survives a squash-merge, unlike the PR comment thread it used
  to live in only.
- **Negative / trade-offs:** the acknowledgment footer is the only path this gate can currently
  recognize once a finding is posted — a later genuine fix does not clear it without also adding
  the footer, because `claude-pr-review.yml`'s re-review convergence rule suppresses fresh
  Should-fix bullets on every round after the first. A future amendment to that convergence rule
  (restating current Should-fix status on every round rather than a count) would let this gate
  recognize a fix without a footer; that is out of scope here. Every reviewed PR with a
  Should-fix finding now needs one extra commit-footer step before it can clear the (eventually
  required) check — a small, deliberate friction cost in exchange for the finding never merging
  silently.
- **Semver impact:** none — internal repo tooling and CI/skill-process changes, not a change to
  `@m3l-automation/m3l-common`'s public API.

## Update (2026-09-11) — the "Selection, not just presence" premise was disproven; the gate now binds acknowledgment per round

The "Selection, not just presence" section above and the first Consequences trade-off bullet
both rest on a premise that turned out to be false: _"no later round ever posts more than round
1 did (it only ever posts the same or fewer, per that suppression rule)."_ That text stays as
written above — it is the historical record of what this ADR's design assumed. This update
records that the assumption did not hold, and what changed as a result.

**What was observed.** PR #1190 went through three review rounds. Round 1 (reviewed commit
`7ed70bbf`) posted 2 Should-fix findings; round 2 (reviewed commit `a2ac062b`) posted 2
**different** findings — a win32 `detached`-flag cost and an untested `catch`, unrelated to
round 1's group-send fallback bug and a disputed Notes-count claim; round 3 correctly suppressed
to a count-only summary, per REVIEW.md's convergence rule. `claude-pr-review.yml`'s prompt block
for that rule (`## Re-review convergence`) is unconditional, yet round 2 did not follow it and
round 3 did — reviewer compliance with the suppression instruction is not deterministic, so a
design that depends on it always holding is not safe to rely on.

**The consequence for `check-should-fix-ack.mjs`.** `selectShouldFixComment` reads a PR's whole
comment history and keeps only the single comment with the _maximum_ Should-fix count, then
`hasShouldFixAcknowledgment` checked for _any_ `Acknowledged-Should-Fix:` footer anywhere in the
PR's `base..head` range. At round 2's head (`a2ac062b`), round 1's two findings already had
footers from a prior push (`214fb3d6`) — so the gate reported "acknowledged" while round 2's two
real, current findings sat entirely unaddressed. This is the **opposite direction** from the
trade-off this ADR originally documented: that one is over-reporting (a finding fixed after
being posted still needs a footer to clear); this one is under-reporting (a live, current
finding can pass unacknowledged because an unrelated earlier finding was once acknowledged).
Filed as issue #1193; found while landing PR #1190 itself.

**The fix.** `bin/lib/pr-review-gate.mjs` gained `collectShouldFixRounds` (every review round
that posted a Should-fix finding, not just the loudest one, each carrying its own reviewed
commit sha via the existing `parseReviewedSha`), `planShouldFixAckRanges` (resolves each round's
required range as `<that round's reviewed sha>..<head>`, falling back to the full `<base>..<head>`
— today's original, more permissive range — whenever the reviewed sha cannot be trusted as an
ancestor of `head`, e.g. after a rebase), and `describeShouldFixAckOutcome` (the pass/fail
decision and messages). `bin/check-should-fix-ack.mjs` now checks every round's own range
independently instead of one presence test over the whole PR. `selectShouldFixComment` itself is
byte-identical and still backs `bin/lib/should-fix-backfill.mjs`'s historical measurement, which
must keep agreeing with what it originally measured — only its JSDoc was corrected to stop
asserting the disproven premise and to point enforcement callers at `collectShouldFixRounds`
instead.

**A forced, deliberate consequence.** The round that just posted a finding has its own reviewed
commit as `head`, so its required range is empty (`<sha>..<sha>`) — no commit yet exists that
could carry the footer, and that round's gate run always fails once, immediately. This is
correct, not a defect: an acknowledgment cannot predate the finding it acknowledges. It passes
once a commit carrying the footer is pushed and the gate re-runs against the new head. This was
confirmed with the maintainer before implementation (an alternative — skipping enforcement for
the round that just posted, only checking it once a further commit exists — was rejected because
it reopens a narrow version of the original gap: a PR merged immediately after that run, with no
further push, would still ship the finding unacknowledged).

**What stays true from the original design.** The gate remains **not yet a required check**
(`docs/contributing/branch-protection.md`) — a behavior change of this scope restarts the
dogfood observation period the original design called for, rather than carrying over evidence
gathered under the old logic. Should-fix stays non-blocking on correctness; the footer's reason
can still say "fixed," "deferred," or "disputed" with equal validity. And the _other_ direction's
trade-off — a later genuine fix still needs a footer, because a suppressed re-review can never
prove a fix on its own to this parser — is unchanged and still open; the only fix named for it
(REVIEW.md's convergence rule restating current Should-fix status every round, instead of a
count) remains out of scope here, exactly as the original Consequences section said.

## Links

- Related: `docs/adr/0016-signed-commits-and-decision-gate.md` (the other half of `main`'s
  merge-gate story), `docs/contributing/branch-protection.md` (the required-check surface this
  ADR's job will eventually join), `REVIEW.md` (the severity-tier vocabulary this ADR amends the
  Should-fix entry of)
- Issue #1193 (the under-reporting direction this Update fixes); PR #1190 (where it was found)
