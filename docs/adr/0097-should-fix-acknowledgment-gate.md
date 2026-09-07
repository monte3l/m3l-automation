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

## Links

- Related: `docs/adr/0016-signed-commits-and-decision-gate.md` (the other half of `main`'s
  merge-gate story), `docs/contributing/branch-protection.md` (the required-check surface this
  ADR's job will eventually join), `REVIEW.md` (the severity-tier vocabulary this ADR amends the
  Should-fix entry of)
