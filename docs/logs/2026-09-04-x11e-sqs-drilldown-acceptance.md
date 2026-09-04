# Work log — `x11e-sqs-drilldown-acceptance` (2026-09-04)

X11 slice 5, the last of the five-slice drill-down UI plan (issue #559).
Scoped by the original plan as "write a Playwright acceptance spec"; turned
out to require real feature work first, because the UI pieces slices 3/4
shipped were never wired into anything drivable. This log covers that
discovery, the implementation, two review-driven fix rounds, and the X11
close-out (tracker flip, ADR-0068 Update) that followed the same session.

Plan of record: a session-local plan file (`~/.claude/plans/x11e-sqs-drilldown-acceptance.md`, outside the repo, not archived — routine feature slice, below `docs/plans/README.md`'s archival bar).

## Summary

- **Gap found before writing any code**: `ParameterForm`'s binding pre-fill
  and `DecisionPrompt` (both slice 4, PR #980) were unit-tested in isolation
  but rendered nowhere in `SessionDetail.tsx`; no client function existed for
  `POST /api/v1/sessions/:id/steps` at all. The plan never assigned this
  wiring to a slice. Surfaced to the user via `AskUserQuestion`; confirmed to
  fold into one PR on this branch rather than split into a separate wiring
  PR.
- **Shipped** (PR #987, `feat/x11e-sqs-drilldown-acceptance`): `api/sessions.ts`
  gained `addSessionStep`, a discriminated `M3LSessionAddStepRequest`
  (mirroring `M3LRunLaunchRequest`'s illegal-state-preventing union), and
  `M3LSessionStepRecord`/`isM3LSessionStepRecord` (the route's real response
  shape). New `components/SessionStepLauncher.tsx`. Extracted the
  pre-existing binding-form apparatus out of `SessionDetail.tsx` into
  `internal/session-binding-form.ts`/`components/SessionBindingForm.tsx`
  (behavior-preserving) to clear file-budget headroom. Wired one
  `DecisionPrompt` per decision and the launcher into `SessionDetail.tsx`,
  plus a `reload()`. New `tests/e2e/sqs-drilldown.spec.ts`.
- **Two TDD rounds**: initial RED/GREEN, then a fix-round RED/GREEN after
  review. Four review spokes (`code-reviewer`, `type-design-analyzer`,
  `silent-failure-hunter`, `spec-conformance-reviewer`) ran in parallel and
  found two real Must-fix bugs neither typecheck nor the initial test suite
  caught: an illegal-state regression (`M3LSessionAddStepRequest`'s
  `dryRun`/`confirmed` as two independent booleans, re-admitting the state
  `M3LRunLaunchRequest` had deliberately made unrepresentable) and a
  response-shape mismatch (the client validated `POST .../steps`'s `step`
  field against `M3LSessionStepSummary` — the `GET`-list shape — when the
  server actually returns the raw `M3LSessionStepRecord` shape; every real
  launch would have failed as `malformed-body`).
- **`pnpm verify`**: 58/58 non-skipped steps green, including the per-file
  coverage gate (a third round was needed after the fix round dropped
  `SessionStepLauncher.tsx` to 84%/72.5% lines/branches — closed to
  90.62%/85% with five targeted tests, no `src/` change needed).
- **Two environment limitations, not code defects**: headless Chromium
  cannot launch in this sandbox (`libnspr4.so` missing, no root — same
  finding independently reproduced by the `code-implementer` spoke and by
  the hub), so the e2e spec's actual green run is CI's job, exactly as the
  original plan's own Verification section anticipated. `pnpm audit`'s
  registry call timed out twice before succeeding on a third attempt —
  transient, not persistent (a later `pnpm verify` run completed it clean).
- **X11 close-out**: `docs/plans/IMPLEMENTATION.md`'s X11 row flipped to
  Done. Re-deriving the actual shipped-PR list (rather than trusting the
  plan's stated "five PRs") found a sixth, unplanned PR — X11a2 (#946,
  session steps/decisions list routes) — landed between X11a and X11b for
  the same reason X11e itself needed extra scope: a mid-plan server-contract
  gap. Six sub-rows (X11a/X11a2/X11b/X11c/X11d/X11e) added, mirroring X10's
  existing sub-row pattern. ADR-0068 gained an Update retracting the
  `parameterName`-not-persisted limit and recording the
  no-free-form-parameters design decision X11e made.

Skills used: starting-work, creating-prs, syncing-docs, writing-commits,
writing-work-logs.

Spoke incidents: 5 truncations / 0 stalls / 5 resumes. Every major TDD
dispatch (initial RED, initial GREEN, fix-round RED, fix-round GREEN, the
coverage-gap RED) hit its 40-turn limit once and was resumed once via
`SendMessage` to the same agent id — never re-dispatched fresh. The two
small single-file fixes (the mock-typing fix, the `knip` unused-export fix)
completed in one shot each with no truncation.

Compaction events: 1 compaction / 1 recovered via handoff. The user ran
`/compact` right after X11d's PR (#980) merged; the reinjected summary
correctly carried branch/PR state, the pending-question context, and enough
detail to resume directly into "proceed to slice 5" with no repeated work.

## What went as planned

- **The plan-mode gate caught real scope before any code was written.**
  Exploring `SessionDetail.tsx`/`ScriptDetail.tsx`/the server route
  validators before touching a file surfaced the missing-wiring gap and the
  no-free-form-parameters server constraint; both shaped the plan from the
  start rather than being discovered mid-implementation.
- **The RED-phase test-author correctly anticipated the file-budget
  extraction** (`internal/session-binding-form.ts`/`SessionBindingForm.tsx`)
  and confirmed, before any implementation existed, that the pre-existing
  `SessionDetail.test.tsx` cases would survive it unmodified — they did,
  47/47 unchanged.
- **`git rebase origin/main` was clean twice** (once before starting
  slice 5's implementation, once before pushing), including through
  `post-rewrite`'s generated-artifact regeneration — "nothing to reconcile"
  both times.
- **`pnpm sync:docs`'s 13 steps passed with zero working-tree changes** —
  expected, since this PR touches only `m3l-console-web`, which has no
  provenance sidecar.
- **The review fan-out found real bugs efficiently.** Four spokes in
  parallel, ~30–70K tokens each, surfaced two genuine Must-fix defects (one
  of which would have silently broken the feature against a real server)
  that neither `tsc` nor the first test round caught, because both bugs were
  about a TYPE being too permissive/wrong rather than internally
  inconsistent.

## What didn't go as planned, and why

### 1. Session process restarts repeatedly dropped background task tracking mid-verification

Three separate times during the push/verify sequence, a background shell
command (`pnpm verify`, `git push`) that had been dispatched via the
harness's own `run_in_background` lost its tracking — a `task-notification`
arrived reporting `status: stopped` with "no completion record," even though
the underlying process may have still been running or had already finished
on the host. The scratchpad directory's session-id path component also
rotated between restarts, meaning a `nohup ... & disown`-detached log file
from one attempt became unreadable after the process restart (the directory
it lived in no longer existed under the session's current path). One
`git push` attempt appeared to succeed by a spot `git ls-remote` check, but
the branch did not actually exist on the remote — the check itself was
apparently run against stale/racy state, and the real push only completed on
a third, fully-synchronous (non-backgrounded, non-detached) attempt with a
raised tool timeout.

**Why it happened:** matches the CLAUDE.md gotcha directly: "A session-level
process restart drops harness-tracked background jobs and can wipe the
scratchpad their logs were written into." This session hit that gotcha
concretely, more than once, during a long-running task with a multi-minute
`pre-push` hook.

**Fix for future:** for a command expected to run several minutes (a full
`pnpm verify`, a `git push` with the `pre-push` hook), prefer a single
synchronous foreground call with a generous explicit timeout over
`run_in_background` or `nohup ... & disown` — the detached/backgrounded
paths are exactly what a process restart severs. When a background/detached
attempt's completion is ambiguous, verify actual state directly (`git
ls-remote`, `gh api .../branches/:name`) rather than trusting a
possibly-stale intermediate check, and be willing to just retry the
operation synchronously rather than continuing to debug the async plumbing.

### 2. `AskUserQuestion` rejected a single-option question outright

Two separate calls in this session included a question with only one
option (once trying to offer just "New linked worktree" for a location
decision that had no real alternative in context, once similarly for a
close-out location confirmation). Both were rejected with a schema error
before the user ever saw them, and a retry was explicitly disallowed by the
tool's own error message.

**Why it happened:** `starting-work`'s own contract says to ask about
location even when the answer seems obvious, but a location decision with
a self-evidently single reasonable path has no real second option to offer
— trying to force one produces a malformed call instead of a real choice.

**Fix for future:** when a `starting-work`-style decision has only one
sensible answer in context, state the chosen path directly in prose (as the
tool's own rejection message instructs) rather than manufacturing a filler
second option to satisfy the 2-option minimum; reserve `AskUserQuestion` for
decisions with genuine alternatives (as the location question correctly did
have on its first real use this session — worktree vs. stay-in-worktree).

### 3. The post-fix coverage gate failed on the newly-added code, requiring a third TDD round

After the two review-driven Must-fix bugs were corrected, `pnpm verify`'s
coverage gate failed specifically on `SessionStepLauncher.tsx` (84.37%
lines/statements, 72.5% branches — the file's fix-round additions,
`buildAddStepRequest`'s branches and the new request-identity guard, had no
direct test exercising them). A third, smaller test-author dispatch closed
the gap to 90.62%/85%, entirely through new test cases — no `src/` change
was needed, though one code path (`handleLaunch`'s defensive
type-narrowing guard) was confirmed genuinely unreachable through the
public UI and would have needed exporting an internal hook to cover
directly; it was left uncovered rather than forcing that export, since the
coverage floor was already cleared without it.

**Why it happened:** the fix round's dispatch prompt asked for the two
Must-fix corrections and three cheap should-fixes, but didn't explicitly
require covering every new branch those corrections introduced — the
per-file coverage floor is stricter than "the tests you wrote pass," and a
fix round is exactly the kind of change most likely to add an untested
branch (a new illegal-state rejection path, a new guard) without anyone
explicitly asking for its test.

**Fix for future:** after any fix round that adds new conditional logic
(not just changes existing logic), run the per-file coverage check before
declaring the round done — `pnpm verify`'s full coverage gate is the only
place this actually surfaced, one full multi-minute run later than
necessary.

## Lessons learned

- **Re-derive a plan's slice scope against the current tree before starting
  it, every time — not just at the first slice.** X11e's entire extra scope
  (the launcher, the wiring, the response-shape fix) existed because the
  plan's slice-5 file list was written before slices 3/4 shipped and never
  revisited; X11a2's existence (discovered during close-out) shows the same
  gap-discovery pattern recurred earlier in the same plan, independently.
  This is the CLAUDE.md "re-derive any authored claim" rule proving out
  twice in one plan.
- **A discriminated union that prevents an illegal state in one request type
  is a pattern to copy verbatim in the next request type that needs it, not
  just a reference to consult.** `M3LSessionAddStepRequest` was written with
  two independent booleans despite `M3LRunLaunchRequest` (480 lines away, in
  the same file) already solving the identical `dryRun`/`confirmed`
  combinatorics problem — the type-design reviewer caught it, but a
  same-file precedent this exact should have been matched on the first
  pass.
- **A response type must be verified against the actual server return value,
  not assumed from a sibling route's shape.** `M3LSessionStepSummary` (the
  `GET`-list shape) and `M3LSessionStepRecord` (the `POST`-launch shape)
  differ in exactly one field each way (`hasResult` vs. `resultRef`) — close
  enough to type-check as a plausible match, wrong enough to reject every
  real response. `spec-conformance-reviewer`'s conformance-mode diff against
  the server's actual return type (not just the docs page) is what caught
  it; the docs page itself was ambiguous on this point ("the inserted step
  record" — record or summary, unstated).
- **Detach only the commands that genuinely need session-restart resilience,
  not every long-running one.** _(see divergence 1)_ A synchronous
  foreground call with a raised timeout is simpler to reason about and
  avoided every one of this session's background-tracking failures; reserve
  detaching for cases where the session itself is expected to end or
  compact before the command finishes. Even a detached log can go
  unreadable across a restart (the scratchpad's session-id path can rotate)
  — verify actual remote/build state directly rather than trusting an
  intermediate check read right after a restart.
  _(promoted → .claude/skills/creating-prs/SKILL.md)_
