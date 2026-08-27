# 0079. Demote the live-GitHub-state drift gates to a non-blocking alarm

- **Status:** Accepted
- **Date:** 2026-08-27
- **Deciders:** repo maintainer

## Context and problem statement

`check:hub-drift` accounted for 23 of the 24 CI failures on `main` over five
days (2026-08-22 to 2026-08-27), turning `main` red for hours at a stretch
with no code change involved. Backtracking every run to its exact drift shape
found one mechanism behind all of them:

`bin/sync-hub-issues.mjs --check` compares `docs/ROADMAP.md` and
`docs/plans/IMPLEMENTATION.md` against **live** GitHub Issues, Milestones, and
sub-issue links. Merging a PR auto-closes its linked issue the instant GitHub
processes the merge — but the tracker row that says the work is done can only
change in a _commit_. Unless that row is flipped inside the very PR that
closes the issue, the very next push to `main` finds a tracker/GitHub mismatch
and fails. Confirmed against merge timestamps: PR #674 merged at
`2026-08-26T12:17:20Z`; its push CI run started three seconds later and failed
on exactly the issue that PR had just closed.

Three properties compound into an unrecoverable failure mode:

1. **Non-hermetic.** The gate compares a commit against mutable remote state
   with no retry, no staleness tolerance, and no scoping to what the push
   actually touched (`ci.yml`'s own comment already concedes this: "not
   path-gated — a drift alarm for GitHub state, unrelated to what files this
   push happened to touch").
2. **Push-only.** `if: github.event_name == 'push'` means the PR that
   introduces the drift can never see it — the check only runs after the
   merge that causes it.
3. **The remedy is maintainer-local-only.** `bin/sync-hub.mjs`'s own header:
   "Maintainer-run, locally, only — never wired into CI… the Actions
   GITHUB_TOKEN cannot write GitHub Projects v2." No push can ever clear a
   red `main` caused by this gate.

Despite all three, the step is a hard-failing, unconditional member of the
`gates` job, which `verify`'s `needs:` list treats as a required-check input.
`ci.yml`'s own comment already calls it "a drift ALARM for main, not a
merge-blocking gate for unrelated work" — the code just never matched that
description. `check:github-features` and `check:label-drift` share the
identical push-only / live-state / hard-failing shape and are latent
instances of the same defect; `check:hub-views` already escaped it by
graceful-skipping instead of failing, with a comment stating the reasoning
this ADR now generalizes: "a gate that fails for a reason no contributor can
fix trains people to ignore it" (`ci.yml`, `Check hub board views` step).

## Decision drivers

- A required check must be something a contributor can act on. None of these
  four steps are: the fix is either "wait for the merge to finish propagating"
  or "ask the maintainer to run a local, `gh`-authenticated command."
- The underlying signal (tracker/GitHub drift) is still worth surfacing — the
  fix is to stop it gating `main`, not to delete it.
- Minimize workflow-file churn: keep every step name identical so
  `bin/check-verify-parity.mjs` and `bin/lib/verify-steps.mjs` need no
  changes beyond what a straight job move requires.

## Considered options

1. **Demote to a non-blocking alarm job.** Move the four push-only live-state
   steps into a new `hub-alarm` job with `continue-on-error: true`, excluded
   from `verify`'s `needs:`.
2. **Auto-reconcile the issues half in CI.** `GITHUB_TOKEN` can close/update
   issues even though it can't write Projects v2 — wire a push-triggered
   reconcile so drift self-heals instead of blocking.
3. **Move to a scheduled job.** Run nightly instead of per-push, decoupling
   the check from every merge.
4. **Keep blocking; require the tracker flip in the same PR that closes the
   issue.** Add PR-side detection so the drift is caught before merge.

## Decision

We chose **option 1**. It is the smallest change that fixes the actual defect
(a non-hermetic condition gating a required check) without touching the
harder, separable problem of _how_ the reconcile should work. Options 2–4
each still leave a `hub-alarm`-shaped job doing the reporting — they compose
with this decision rather than replace it, and are left for future ADRs if
the maintainer wants automated self-healing (option 2) or pre-merge detection
(option 4). Option 3 was set aside because push-triggered visibility (drift
shows up on the next `main` push, same as today) is more useful than a
once-nightly report for a signal this repo already treats as advisory.

Concretely:

- **`hub-alarm`**, a new job in `ci.yml`, `needs: changes`, `if:
github.event_name == 'push'`, **`continue-on-error: true` at the job
  level**. Carries the four steps moved verbatim out of `gates`: `Check hub
drift (push-only)`, `Check GitHub platform-feature stance (push-only)`,
  `Check label drift (push-only)`, `Check hub board views (push-only)`.
- **Not in `verify`'s `needs:` list.** `verify` still aggregates `[changes,
secrets, deps, lint, format, build, test, gates]` — unchanged. A drifting
  push now leaves the required `verify` check green while `hub-alarm` reports
  its failure as a visible-but-non-blocking job.
- **`gates` loses its `issues: read` permission widening** — nothing left in
  that job needs it; `Check for literal control characters` (the one step
  that must run on PRs too, and needs no auth) stays in `gates` unchanged.
- **Step names are untouched.** `bin/check-verify-parity.mjs` joins on
  `ciStepName` across every lane job (not job identity), so no changes are
  needed there or in `bin/lib/verify-steps.mjs` for this move to keep
  passing. A follow-up (ADR-0079 does not do this) can add an explicit
  hermeticity field to `verify-steps.mjs` so `check-verify-parity.mjs` can
  reject a _future_ live-state step from being wired into a required lane by
  construction, rather than by author discipline alone.

## Consequences

- **Positive:** `main`'s required `verify` check stops going red for a
  condition no contributor can fix. The drift signal stays visible (a warned
  job, `$GITHUB_STEP_SUMMARY`-style reporting already built into the check
  scripts themselves) instead of disappearing. Matches the reasoning the repo
  already applied to `check:hub-views`.
- **Negative / trade-offs:** Tracker/GitHub drift can now persist unnoticed
  for longer if nobody looks at the `hub-alarm` job — there is still no
  active alerting (that gap is tracked separately: a `workflow_run`-triggered
  main-health notifier, a later slice of the same effort this ADR belongs
  to). The reconcile is still 100% maintainer-local; this ADR does not change
  that.
- **Semver impact:** none — repo tooling only; no `packages/` source or
  `exports`-map change.

## Links

- Amends: ADR-0032 (visibility hub) — the underlying `check:hub-drift`
  mechanism and its "maintainer-local write-back" property are unchanged;
  this ADR only changes how its failure is gated in CI. Also touches the
  push-only rationale ADR-0050 and ADR-0051 already state for
  `check:github-features` and `check:label-drift`.
- Related: ADR-0075 (`check:hub-views`'s graceful-skip precedent, whose
  reasoning this ADR generalizes to the other three checks).
