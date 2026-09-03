# Work log — x11a2-session-steps-decisions (2026-09-03)

This log covers the server-only groundwork PR ([#946](https://github.com/monte3l/m3l-automation/pull/946))
inserted ahead of X11 (issue #559) slice 2, after re-deriving that plan's
server-endpoint assumptions against the actual routes turned up a real gap.
It records what shipped, what matched the plan, what diverged, and durable
lessons — the plan itself lives at `~/.claude/plans/on-issue-559-floating-liskov.md`
(not a repo-committed file, so no relative link here).

## Summary

Before starting X11 slice 2 (`feat/x11b-console-session-views`, web
foundation), re-derived the plan's claim that "steps come back on
`GET /api/v1/sessions/:id`" against the actual route table — it doesn't:
`GET /api/v1/sessions/:id` returns only the bare session row, and no route
existed to list a session's steps or its raised decisions at all. The user
chose to fix this as its own small server PR first (mirroring how the plan's
slice 1 fixed a different pre-existing gap), which shipped as PR #946:

- New `GET /api/v1/sessions/:id/steps` (`src/http/routes/session-steps.ts`,
  new file) and `GET /api/v1/sessions/:id/decisions`
  (`src/http/routes/sessions.ts`)
- New `M3LSessionStepSummary` type and `M3LSessionService.listStepsForSession`
  (`src/sessions/service-reads.ts`) — each step served with `resultRef`
  redacted to a `hasResult: boolean`, `resultRef?: never` making the
  redaction compile-time enforced
- `listDecisionsForSession` (pre-existing) gained a session-existence guard
  it was missing, now that it's reachable over HTTP for the first time
- `docs/reference/console.md` documents both routes and retracts a stale
  known-limit bullet
- 21 new/changed tests across 5 test files; full suite 2691/2691 green;
  `pnpm verify` 58/58 (10 skipped as expected); `pnpm typecheck`/`lint`/
  `format:check` clean

**Skills used:** starting-work, writing-commits, creating-prs, syncing-docs,
finishing-work, writing-work-logs.

**Spoke incidents:** 2 truncations (test-author and code-implementer each
hit their 40-turn limit once on first dispatch) / 0 stalls / 5 resumes.

**Compaction events:** none.

## What went as planned

- **Re-deriving the plan's server assumption before writing UI code paid
  off immediately.** Checking `GET /api/v1/sessions/:id`'s actual handler
  and every registered `/api/v1/sessions*` route (not just re-reading the
  plan prose) surfaced the gap directly from the route table, not from a
  test failure three slices later.
- **RED failed for the right reason on both rounds** — `Cannot find
module`/`does not exist` diagnostics only, confirmed via `pnpm typecheck`
  and `pnpm exec vitest run` before any implementation was dispatched.
- **GREEN was correct in scope on both dispatches** — everything the
  code-implementer wrote (the new route module, the service method, the
  redaction, the wiring) was accepted by review without changes; every
  finding it surfaced was a genuine gap in the test fixtures or in
  pre-existing code it wasn't asked to change.
- **The four-lens review fan-out (code-reviewer, silent-failure-hunter,
  type-design-analyzer, spec-conformance-reviewer) each found a distinct,
  real, non-overlapping defect** — see divergence 3 below.
- **Rebase onto `origin/main` (7 commits behind) was conflict-free**, and
  the pre-push hook's full verify lane passed in one shot.

## What didn't go as planned, and why

### 1. A stray `Agent(subagent_type: "fork")` call, meant as a spoke resume, forked the hub instead

When the test-author agent stopped at its 40-turn limit, the intent was to
let it continue. The dispatch used `Agent({ subagent_type: "fork" })` instead
of `SendMessage` to the agent's id — which forks the CALLING hub session's
own context, not the target background agent. The mistake was caught within
seconds (the fork happened to report back fast) and killed via `TaskStop`
before it touched any file; the correct `SendMessage` resume was issued
immediately after.

**Why it happened:** "fork to continue" reads as a plausible action verb for
"let that agent keep going," but `fork` only ever forks the caller — there is
no tool call that resumes an arbitrary _other_ agent except `SendMessage` to
its id/name.

**Fix for future:** promoted into `.claude/rules/subagent-dispatch.md`
(see Lessons learned) — always `SendMessage({ to: "<id or name>" })` to
resume a specific spoke; never `Agent(subagent_type: "fork")` for that
purpose.

### 2. Both writer spokes needed a resume before finishing verification

The test-author's first dispatch (writing RED tests across 4 files) and the
code-implementer's first dispatch (GREEN across 4 files plus full-package
verification) each stopped at their 40-turn limit mid-verification, with the
actual work already done but the confirmation pass unfinished. Both resumed
cleanly via `SendMessage` and completed in one further round each.

**Why it happened:** the briefs were large — four files' worth of RED tests,
or four files' worth of GREEN plus a `pnpm exec vitest run` + `pnpm
typecheck` + `pnpm exec eslint` + `pnpm exec prettier --check` verification
battery — enough tool calls to exhaust a 40-turn budget on the confirmation
tail even when the substantive work finished well before the limit.

**Fix for future:** none required — this is the documented, working resume
pattern (`.claude/rules/subagent-dispatch.md`'s existing "verification can
conclude no resume needed" guidance already anticipates this shape); noted
here as a data point that a 4-file contract this size routinely needs one
resume, not a process defect to fix.

### 3. Four independent review lenses each found a distinct real defect

`code-reviewer` and `silent-failure-hunter`, dispatched in parallel with no
shared context, both independently converged on the same finding
(`listDecisionsForSession`'s missing existence guard). `type-design-analyzer`
found a second, unrelated gap in the same diff (`M3LSessionStepSummary`'s
redaction wasn't type-enforced). Then, after those fixes landed, the
pre-push `spec-conformance-reviewer` pass found three more issues — this
time in the doc prose the hub itself had authored, not in any spoke's code:
a doc-side `undefined`-vs-`null` serialization mismatch, a missing `options`
field in an example, and a cross-reference pointing at the wrong endpoint.

**Why it happened:** each review dimension is a genuinely different question
(does the logic work? are errors handled? is the type sound? does the doc
match the runtime behavior?) — a single reviewer optimizing for one of those
questions has no particular reason to also catch the other three.

**Fix for future:** none — this is the review pipeline (four independent
lenses, not one generalist pass) working exactly as designed on a small,
well-scoped diff. Recorded as reinforcing evidence for keeping the full
fan-out rather than trimming it for a "small" change.

### 4. A shared, multi-consumer port's new method surfaced its ripple one step later than RED, by necessity

Adding `listStepsForSession` to `SessionRouteReaderPort` during GREEN broke
`pnpm typecheck` in `tests/routes-built-in.test.ts`'s `fakeSessionService`
fixture and in every `buildReader()`-derived fixture across
`tests/routes-sessions.test.ts` (35 sites) — files the code-implementer
wasn't asked to touch and isn't permitted to edit. The code-implementer
correctly diagnosed both as test-fixture gaps (confirmed by temporarily
removing the field and watching the error move) and routed them back to the
test-author rather than attempting a workaround.

**Why it happened:** the port only gains the new method during GREEN, so no
RED-phase typecheck run could have seen the ripple before that point — it is
structurally impossible to catch earlier, not a gap in the RED-confirmation
process. Full-package `pnpm typecheck` (not a scoped run) is exactly what
surfaced it.

**Fix for future:** none — the writer-cannot-write-tests boundary (spokes
per `docs/contributing/agent-operating-model.md`) correctly sent this back
to test-author instead of the code-implementer improvising a fix; expect
one extra hand-off round whenever a change adds a method to a port shared
across multiple route modules.

## Lessons learned

- **`Agent(subagent_type: "fork")` never resumes another agent — it always
  forks the caller.** The only way to let a specific background spoke keep
  going is `SendMessage` to its id/name; "fork to continue" is a plausible-
  sounding but wrong shortcut. _(promoted → .claude/rules/subagent-dispatch.md)_
- **Re-derive a multi-slice plan's server-endpoint claims against the actual
  route table before writing the first line of UI code against them.**
  A plan's prose claim ("steps come back on `GET /api/v1/sessions/:id`") can
  be wrong from the moment it was written, not just stale — checking the
  registered routes directly caught this before any web code was built on
  the false assumption.
- **A shared port's ripple across sibling test files is a one-round-later,
  not-a-defect fact of the writer/test-author split**, not something a
  RED-confirmation pass could realistically pre-empt. Expect it whenever a
  change adds a method to a port more than one route module consumes, and
  let the code-implementer route it back to test-author rather than trying
  to work around the tests-are-off-limits boundary itself.
- **Four independent review lenses on one small diff each earned their
  keep.** code-reviewer and silent-failure-hunter converging on the same
  finding from different angles, type-design-analyzer catching an unrelated
  gap, and spec-conformance-reviewer catching doc-side drift the hub itself
  introduced — none of the four would have caught all of what the others
  found.
- **A hand-written JSON doc example needs to be checked against the real
  runtime serialization, not just the type shape.** `undefined` fields
  serialize as `null` (never omitted) through this codebase's
  `safeJsonStringify`, and a cross-reference written from memory pointed at
  the wrong endpoint — both survived a first read-through and only surfaced
  once spec-conformance review actually executed the real code path.

## Rebase check needed for the next X11 slice

Slice 2 (`feat/x11b-console-session-views`) still needs a rebase onto
`origin/main` before continuing — its `SessionDetail` step/decision
rendering depends on the two routes this PR just merged.
