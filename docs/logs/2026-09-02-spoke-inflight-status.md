# Work log — spoke-inflight-status (2026-09-02)

This log covers PR #896, the final slice of the status-reporting plan
started with #890/#893 — the statusline's in-flight-spoke segment. It
records what shipped, a mid-session architecture verification against a
concurrent PR's actual shipped shape (rather than the WIP version inspected
during planning), a real design gap a review pass caught and the fix's own
deliberate placement decision, and the durable lessons.

Plan of record: [`docs/plans/archive/2026-09-02-status-reporting-for-long-running-tasks.md`](../plans/archive/2026-09-02-status-reporting-for-long-running-tasks.md)

## Summary

- **Shipped**: `.claude/hooks/track-inflight-spokes.mjs` (new,
  `SubagentStart`/`SubagentStop`) appending lifecycle records to
  `tmp/spoke-lifecycle.jsonl`; `rotate-session-incidents.mjs` extended to
  rotate it too (matcher unchanged — `startup|clear` only); `statusline-context-pressure.mjs`
  gained `resolveInflightSpokes`/`formatInflightSpokesSegment`/`formatElapsed`
  wired into `buildLine3`, color-escalating GREEN → YELLOW (15 min) → RED+⚠
  (30 min elapsed), plus a `MAX_INFLIGHT_AGE_SEC` (2h) eviction ceiling added
  in a second commit.
- **Rebased on #892**, not the WIP originally inspected during planning —
  re-read the actual shipped `statusline-context-pressure.mjs` first and
  confirmed `buildLine1..buildLine4`, `joinSegments`, the `env` injection
  pattern, and `formatAgentSegment`'s naming all matched plan assumptions
  exactly before writing a line of new code.
- **Gates**: `pnpm check:hooks` (28 wired hooks, 28 doc rows), `pnpm verify`
  run three times across two commits (post-implementation, post-rebase,
  post-eviction-fix), all `REAL_EXIT=0` confirmed against a written sentinel
  rather than the backgrounded task-notification's own reported exit code.
  165 tests across the two touched test files; full suite 2938 tests
  passing.
- **Skills used:** starting-work, syncing-docs, creating-prs, finishing-work,
  writing-work-logs.
- **Spoke incidents:** `tmp/session-incidents.jsonl` is absent entirely in
  this checkout for this PR's dispatch window (every dispatch ran inside the
  `feat/spoke-inflight-status` worktree, which has its own separate `tmp/`,
  and that worktree has since been removed) — falling back to recollection
  per the skill's documented rule for an absent file: 0 truncations /
  0 stalls (>15 min without converging) / 0 `SendMessage` resumes across all
  four spoke dispatches this PR involved (one `test-author` for the initial
  160 tests, two review spokes in parallel, one follow-up `test-author` for
  the 5 eviction tests) — every report was complete and independently
  re-verified against the actual files on disk before being trusted.
- **Compaction events:** none.

## What went as planned

- The architecture-verification step (re-reading #892's actual shipped file
  before writing anything) paid off exactly as intended — zero rework was
  needed when the plan's assumed function names/signatures turned out to
  match the real thing precisely.
- Live-probing every new function (`track-inflight-spokes.mjs`'s start/stop
  append, an unrelated-event no-op check, `resolveInflightSpokes`/
  `formatInflightSpokesSegment` against a realistic mixed start/stop/restart
  fixture with explicit zone-escalation assertions) against real Node
  invocations _before_ dispatching `test-author`, per
  `harness-artifacts.md`'s "run against known-good input before wiring it"
  rule, meant the dispatch prompt could hand the spoke exact, already-verified
  expected behavior rather than a specification to derive from scratch — the
  spoke's own report came back clean on the first pass with no back-and-forth.
- Both review spokes (dispatched in parallel — `docs-consistency-reviewer`
  and `code-reviewer`, going beyond `creating-prs`'s literal "docs-only
  branch, dispatch consistency-reviewer alone" rule since this diff carried
  substantive new hook logic, not just docs/config) returned genuinely
  useful, independently-verifiable findings rather than generic commentary —
  `docs-consistency-reviewer` re-derived all 7 of its checked claims from
  `git log`/`pnpm check:hooks` output rather than trusting the PR
  description, and `code-reviewer` traced a real design gap to its exact
  root cause rather than a surface-level nit.
- The follow-up `test-author` dispatch for the eviction fix correctly worked
  out the boundary-condition test's expected result (inclusive vs. exclusive
  at exactly `MAX_INFLIGHT_AGE_SEC`) from the code's own `t < cutoffMs`
  comparison rather than assuming — exactly the outcome the dispatch prompt
  asked for by explicitly forbidding a guess.

## What didn't go as planned, and why

### 1. `guard-hub-src-writes.mjs` blocked a direct test-file write, as designed

Attempting to `Write` `bin/tests/track-inflight-spokes.test.ts` directly
from the hub failed immediately with a `PreToolUse` hook error:
`bin/tests/**` matches the guarded `**/tests/**` glob in
`bin/lib/protected-paths.mjs`, which `guard-hub-src-writes.mjs` enforces on
**any** branch, not just `main`. The write was re-dispatched to a
`test-author` spoke instead, with the exact expected file content and
behavior already fully specified from the live probes above.

**Why it happened:** this repo's hub-and-spoke operating model requires
test/src writes to go through a spoke, and the guard enforces it
mechanically rather than relying on the hub remembering the rule.

**Fix for future:** none needed — this worked exactly as designed. Recorded
here as confirmation that the guard fires in practice, not just in
documentation, and as a reminder that a bounded, fact-dense dispatch prompt
(built from the hub's own prior verification) is cheap once the hub has
already done the discovery work itself.

### 2. A review pass found a real design gap the implementation had missed

`code-reviewer`'s Should-fix #1 identified that a spoke whose
`SubagentStop` event never fires — the harness kills the process, the
dispatch is cancelled, or `track-inflight-spokes.mjs`'s own advisory write
silently fails — would leave an orphaned `start` record with no
counterpart, pinning the statusline segment red for the rest of the
session. The function's own doc comment claimed to guard against exactly
this class of failure ("risking a false 'still running' entry that never
clears") but the guard only covered the _missing-`agentId`_ case, not the
_lost-`stop`-event_ case — a gap between the stated intent and the actual
coverage that no test caught, because no test exercised a start-with-no-stop
that was also supposed to be considered stale.

**Why it happened:** the original implementation reasoned correctly about
one failure mode (an uncorrelatable record) but didn't separately reason
about a second, distinct failure mode (a correlatable record whose
counterpart is simply never written) that produces a similar-looking but
functionally different bug.

**Fix for future:** when a function's doc comment makes a general claim
("never a stuck/stale entry"), check that claim against _every_ plausible
cause of that failure class, not just the one the implementation happened
to guard against first — a code review is exactly the right place to ask
"what else could produce this same symptom?" rather than only checking the
one guard already written.

## Lessons learned

- **Re-verify a plan's architecture assumptions against the actually-shipped
  code, not the WIP version inspected while planning.** A concurrent PR can
  land between planning and implementation; a quick re-read of the real
  file before writing anything is cheap insurance against building on a
  moving target, and it paid off here with zero rework needed.
- **A doc comment's general claim needs to be checked against every cause of
  that failure class, not just the one guard already implemented.** "Never a
  false still-running entry" covered the missing-`agentId` case but silently
  missed the lost-`stop`-event case — the same symptom, a different root
  cause, only caught by a review pass asking "what else could produce this?"
- **Where to place a time-dependent fix matters as much as the fix itself.**
  Adding the `MAX_INFLIGHT_AGE_SEC` eviction to `resolveInflightSpokes`
  would have been the more "obvious" location (it's the function reading the
  file), but that function's existing test suite used fixed 2026-timestamp
  fixtures with no injectable `now` — an eviction there would have made
  those tests date-fragile on any later real-world test run. Placing it in
  `formatInflightSpokesSegment`, which already threads an injectable
  `env.now` through for exactly this kind of determinism, kept the fix
  correct without touching a single already-passing, already-reviewed test
  _(promoted → .claude/rules/tests.md)_.
- **`guard-hub-src-writes.mjs` enforces the hub/spoke split on every
  branch, not just `main`.** Confirmed live this session (a direct `Write`
  attempt to `bin/tests/**` was rejected) — the guard is a genuine backstop,
  not just documented convention, and generalizes beyond `guard-branch-isolation.mjs`'s
  main-only scope.
- **A bounded, fact-dense dispatch prompt built from the hub's own prior
  live-probing produces a clean-on-first-pass spoke report.** Every writer
  dispatch this PR made (2 rounds of `test-author`) came back correct
  without a resume or a fix round, because the dispatch prompt handed exact
  expected behavior already verified by hand rather than a specification to
  independently derive.
