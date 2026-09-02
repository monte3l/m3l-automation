# Fixing the recurring CI failures on `main`

**Status: shipped** — six-slice rollout across PRs #692, #694, #698, #702,
#705, plus the final slice of this series (this change).

## Context

`main` had been red or partially red for most of five days
(2026-08-22–2026-08-27). Across the 279 push-triggered workflow runs in that
window, CI failed 24 of 68 runs (~35%) and Pages failed 6 of 69; Pages had not
deployed since `9c1eb668` and was still failing on `main` HEAD at audit time.
Backtracking every failing run to its step and log reduced the 30 failures to
**four** root causes, three of which shared one structural property: each was
detectable only on the post-merge push run, so the PR that introduced it could
never catch it, and nothing alerted when `main` went red — seven consecutive
red pushes over 2.5 hours went unremarked by any automation.

## Approach / Decisions

Six reviewable slices (ADR-0072), each its own PR:

1. **Unblock Pages** (#692) — `bin/lib/script-scaffold.mjs`'s top-level
   `await import` of the CLI manifest (introduced by `0ef24b33`, ADR-0053 U9)
   was made lazy, matching the deferral pattern already used at
   `bin/scaffold-script.mjs`; `pages.yml` gained the missing CLI build step.
2. **Stop the gitleaks recurrence** (#694) — all four `.gitleaksignore`
   entries were confirmed dead (squash-merge rewrites the commit SHAs
   fingerprints key on) and deleted; the one live-firing test literal was
   migrated to the repo's runtime-string-assembly sentinel convention, now
   documented in `.claude/rules/tests.md`.
3. **Demote the live-state drift gates** (#698, ADR-0079) — `check:hub-drift`
   and its two siblings moved out of the required `gates` lane into a new
   `hub-alarm` job (`continue-on-error: true`): a gate that fails for a reason
   no contributor can fix (a merge auto-closing an issue the tracker row can
   only update in a later commit) trains people to ignore it. ADR-0079 amends
   ADR-0032's visibility-hub stance.
4. **Prevention gates** (#702) — `check:workflow-build-order` derives the
   `bin/**` → `packages/m3l-cli/dist` import cone from static imports and
   fails a workflow step that invokes it without a preceding build step in the
   same job (the gate that would have caught slice 1 at authoring time); a new
   `needsLiveState` field on `bin/lib/verify-steps.mjs` entries plus a
   `check:verify-parity` extension makes slice 3's demotion structural rather
   than a one-time fix.
5. **Alert when `main` goes red** (#705) — `main-health.yml`, a
   `workflow_run`-triggered notifier on `[CI, Pages]`, opens/updates/closes a
   single exact-title-matched tracking issue. Its own bot review caught two
   design gaps beyond the original plan: closing on either workflow's
   recovery was wrong if the other was still red (fixed with
   `otherWatchedWorkflow`/`otherWorkflowLatestConclusion`/
   `decideSuccessAction`, querying the other workflow's own live state rather
   than persisting cross-workflow state on the issue), and two overlapping
   notify jobs on the same push could race a duplicate issue into existence
   (fixed with a `concurrency` group serializing the workflow).
6. **Harden the fragile assertion** (this PR) — a `describeSetCardinality`
   test's closing assertion scanned the entire serialized report for an
   injected fragment, a collision class that had already needed two unrelated
   patches (issue #655: freeze time so a timestamp can't coincidentally match;
   issue #671: pin `nodeVersion`/`packageVersion` for the same reason).
   Retargeted onto the one field actually under test
   (`environment.s`, anchored regex plus a not-equal check) so a future
   `collectDiagnostics()` field can't re-trigger the same false failure.

## Outcome

`main` stayed green across the slice 4/5 merge and every push since. The
tracking issue this plan's final slice added has never had to open — no
red push has landed after slice 5 merged. All four original root causes are
closed: Pages deploys again, gitleaks has zero dead fingerprints, the
drift gates are informational rather than blocking, and a build-order /
hermeticity regression now fails CI instead of shipping invisibly. The
detection gap — nothing alerting when `main` goes red — is closed structurally
(a single exact-title-matched issue, live-state-checked before closing) rather
than by a one-off fix.
