# Work log — `x11c-json-tree-viewer` (2026-09-03)

This log covers X11 slice 3 (issue #559): the console web app's JSON tree
viewer and step-output binding-creation flow, built in the
`feat/x11c-json-tree-viewer` worktree/branch and shipped as PR #973. It
records what shipped, two review rounds that caught four real defects, an
API-side outage that repeatedly blocked one review dimension, and an
unrelated harness incident discovered while closing the branch out. Plan of
record: the external X11 plan at `~/.claude/plans/on-issue-559-floating-liskov.md`
(not a `docs/plans/` file, so not linked as one here); its slice 3 section
scoped this task.

## Summary

Shipped: `packages/m3l-console-web/src/internal/step-reference.ts` (new —
`buildStepReference` thin-wraps `Core.formatStepReference`),
`src/components/JsonTreeViewer.tsx` (new — hand-rolled `<details>`/`<summary>`
disclosure over an arbitrary JSON value, no external tree dependency per
ADR-0067), `src/api/sessions.ts` (extended — `fetchSessionStepArtifact`,
`createSessionBinding`, `M3LSessionBindingRecord`/`M3LSessionBindingInput`/
`M3LSessionBindingExpectedType`), `src/components/SessionDetail.tsx` (extended
— per-step "View output" action, binding-creation form on tree selection,
request-identity guards against stale async responses, `id`-change reset,
disabled submit while a request is in flight). 23 test files / 399 tests in
`packages/m3l-console-web`, all passing. Full `pnpm verify` green across four
separate runs (one per fix round): 58/58 applicable steps, 10 appropriately
skipped (e2e, push-only).

Built through the standard hub-and-spoke TDD loop: four parallel
`test-author` spokes for RED (one per file — `step-reference.ts`,
`JsonTreeViewer.tsx`, the `sessions.ts` additions, the `SessionDetail.tsx`
wiring — all against a contract frozen up front by the hub so the four could
run concurrently without cross-reading each other), then three parallel
`code-implementer` spokes for the independent pieces followed by a fourth for
`SessionDetail.tsx` wiring (which depends on all three).

Review fan-out after GREEN: `code-reviewer` (1 must-fix — stale
cross-session artifact/binding state), `silent-failure-hunter` (3 must-fix —
an unguarded throw and two stale-async-response races), `type-design-analyzer`
(1 should-fix — an unexported type leaking through two public interfaces).
All four fixed in one combined `code-implementer` round, which also
discovered and fixed a coverage gap the fixes themselves introduced. A second,
final review round (`code-reviewer` + `spec-conformance-reviewer` against
`docs/reference/console.md`) found one more should-fix — a double-click race
on the binding-submit button that could create duplicate binding rows
server-side — fixed in a follow-up commit before push.

Skills used: `starting-work` (session already positioned correctly — the
worktree/branch matched the plan's pre-confirmed decision table, so
location/branch weren't re-asked), `writing-commits`, `creating-prs`,
`syncing-docs` (no-op — no `packages/m3l-common` docs affected),
`finishing-work` (this log; also surfaced the harness incident below).

Spoke incidents: none (no truncations or `SendMessage` resumes on the four
RED-phase `test-author` spokes or the independent-piece `code-implementer`
spokes). One planned resume: the `SessionDetail.tsx` fix-pass
`code-implementer` hit its 40-turn limit mid-edit and was resumed via a
`fork`-dispatched `SendMessage` to finish and re-verify — the documented
correct recovery, not a mistake.

Compaction events: none observed.

## What went as planned

- **Freezing the cross-file contract up front (exact prop names, `data-testid`
  patterns, function signatures) before dispatching any spoke let all four
  RED-phase `test-author` spokes run in true parallel**, each with zero
  visibility into the others' work, and all four tests correctly agreed with
  the GREEN-phase implementations written against the same frozen contract —
  no signature mismatches, no re-work.
- **The dependency-ordered two-wave `code-implementer` dispatch (three
  independent files in parallel, `SessionDetail.tsx` wiring after) matched the
  real dependency graph exactly** — `SessionDetail.tsx` imports all three of
  the others, so it could only be implemented once they existed; nothing was
  attempted out of order.
- **The `console_session_bindings` prerequisites from slices 1 and 2
  (`parameterName` persistence, `src/api/sessions.ts`'s session/step/decision
  fetchers) were verified live in the repo, not assumed from the plan
  document**, before starting — confirmed via a direct grep for the
  `parameterName` field on `M3LSessionBindingRecord` and a directory listing
  of `src/api/`/`src/components/`, per the CLAUDE.md "re-derive any authored
  claim" rule. Both held.
- **The review fan-out caught four genuinely independent, real defects with
  no false positives** — every Must-fix from the first round and every
  should-fix from the second round was real and fixed; nothing was disputed
  or reverted this time (contrast the x11b log's disproven finding).

## What didn't go as planned, and why

### 1. The first review round's fixes introduced a coverage regression that only surfaced at `pnpm verify`, not at the fix spoke's own scoped test run

The combined fix pass for the four review findings (throw-guard,
two race-guards, `id`-change reset) added enough new branches to
`SessionDetail.tsx` that the file's per-file coverage dropped to 88.88%
lines/statements and 78.37% branches against a 90/89/80 threshold — but the
fix-pass spoke's own verification only ran the single test file it had
touched, which reported the file's _relative_ coverage correctly but wasn't
compared against the hard gate the way `pnpm verify`'s full run does. The gap
was only caught when the hub ran the full `pnpm verify` before push.

**Why it happened:** `vitest`'s coverage output for a single-test-file run
still reports accurate per-file percentages, but nothing in that scoped run
enforces the gate — enforcement only fires as part of the full coverage
config's `thresholds.perFile` check, which only runs meaningfully across the
whole suite (or at least the whole package) in `pnpm verify`'s `test:coverage`
step.

**Fix for future:** After a fix pass that adds new branches to an
already-near-threshold file, run `pnpm verify` (or at minimum the package's
full coverage-gated suite) before considering the fix complete — a
single-test-file scoped run reporting "high coverage" is not proof the file
clears its own gate once the whole suite's baseline is accounted for. This
task recovered cheaply (one more fix-pass dispatch, traced via
`coverage/coverage-final.json`'s uncovered-line list rather than guessing),
but the pattern is worth flagging before it costs more on a larger file.

### 2. `type-design-analyzer` failed three consecutive times with HTTP 529 (server overload) before succeeding on a fourth attempt

The Opus-backed `type-design-analyzer` spoke returned `API Error: 529
Overloaded` on its first three dispatches across roughly 20 minutes of
wall-clock spacing (interleaved with other work, not tight-looped retries).
The fourth attempt, dispatched after the SessionDetail fix round had already
landed, succeeded and returned a real, actionable finding (an unexported type
leaking through two public interfaces).

**Why it happened:** Server-side capacity issue, not a prompt or scope
problem — the same prompt (progressively updated to reflect the diff's
current state across retries) succeeded once the outage cleared. Not fully
diagnosable from inside the session; flagged as informational.

**Fix for future:** When a review spoke fails with a 5xx/overload error, retry
with reasonable spacing rather than abandoning that review dimension
entirely — three failures in a row is a legitimate signal to consider
proceeding without it (and say so plainly), but a fourth attempt after
unrelated work had passed recovered it here and surfaced a real finding that
would otherwise have shipped unaddressed.

### 3. `finishing-work`'s own `pnpm worktree:remove` step deleted this session's working directory mid-task, silently breaking the `Skill` tool for the rest of the session

Immediately after closing out this PR (worktree removed, branch deleted, refs
pruned), the next `Skill` invocation (`writing-work-logs`, to produce this
very log) failed `Unknown skill: writing-work-logs` — and every subsequent
`Skill` call, for any skill, failed the same way, including ones confirmed to
exist on disk from the fallback directory. The `Bash` tool recovered
gracefully (its cwd silently falls back to the repo's main checkout each
call, logged as "Shell cwd was reset to ..."), but `Skill` did not recover by
the same fallback.

**Why it happened:** Not confirmed from inside the session — the working
theory, based on the asymmetry between `Bash` (recovers) and `Skill` (does
not), is that `Skill` resolution is anchored to the session's _original_
working-directory path rather than re-resolving against wherever the harness
falls back to once that path is gone. Filed as product feedback
(`SendFeedback`, type `bug`) rather than guessed at further here.

**Fix for future:** This is exactly the hazard the `starting-work` skill's
own notes already warn about for _other_ concurrent sessions ("a worktree is
not a stable fact... its own `finishing-work` close-out can delete the
directory... out from under an in-flight task") — but it had not previously
been observed happening to a session's _own_ worktree, from its _own_
`finishing-work` invocation, in the same turn. Until the harness fixes this,
a session running `finishing-work` on its own worktree should expect `Skill`
to stop working immediately afterward and either (a) do any remaining
skill-driven work _before_ the worktree-removal step, reordering
`finishing-work`'s steps locally if needed, or (b) fall back to doing the
remaining steps by hand (as this log itself was — written directly via
`Write`, modeled on a prior log's structure, rather than through the
`writing-work-logs` skill).

### 4. A stray worktree from slice 1 was still checked out, undetected until this close-out

`git worktree list`, run as part of this close-out, showed
`m3l-automation-x11a-binding-parameter-name` (branch
`feat/x11a-binding-parameter-name`) still present as a linked worktree, even
though that slice's code is already merged into `main` (confirmed via a
direct grep for the `parameterName` field this same session had already run
as a prerequisite check for slice 3). No corresponding
`m3l-automation-x11b-*` worktree exists, so slice 2's close-out was done
correctly; only slice 1's was skipped or interrupted.

**Why it happened:** Not established from inside this session — slice 1
predates it. Left untouched rather than removed unilaterally, since deleting
another task's worktree without confirming it holds no unpushed/uncommitted
work is exactly the kind of action CLAUDE.md's "investigate before deleting"
rule exists for.

**Fix for future:** `finishing-work`'s own Step 3 only tears down the branch
named in the just-merged PR — it has no step that sweeps for _other_ stale
worktrees left over from earlier, unrelated close-outs. Worth considering
whether `finishing-work` (or a periodic `worktree:prune` habit) should
surface this class of drift proactively rather than relying on it being
noticed incidentally, as it was here, while running `git worktree list` for
an unrelated reason.

## Lessons learned

- **Freeze the exact contract (signatures, testids, error shapes) before
  fanning out parallel RED-phase spokes, not after.** This is what let four
  `test-author` dispatches run with zero coordination overhead and land
  perfectly consistent with the four GREEN-phase implementations. _(This
  matches, and reinforces, `implementing-submodules`' existing contract-first
  guidance — no new rule needed, but worth reinforcing as observed working
  well at this scale.)_
- **A fix pass touching an already-large, coverage-sensitive file must be
  re-verified against the FULL suite's coverage gate, not just its own
  changed test file's scoped run.** _(See Divergence 1 — worth a line in
  `.claude/rules/tests.md` if this recurs; one instance is not yet a pattern.)_
- **A review spoke's repeated 5xx failure is worth one more retry after
  unrelated work has landed, not just abandonment after three tries in a
  row** — the fourth attempt here surfaced a real, fixable finding.
- **`finishing-work`'s `pnpm worktree:remove` step can break the calling
  session's own `Skill` tool for the remainder of the session, when that
  session is running inside the worktree being removed.** Filed as a product
  bug via `SendFeedback`; not yet promoted into a rule since the root cause
  (harness-side) isn't confirmed from inside a session, but any future
  session hitting the same `Unknown skill` symptom immediately after a
  worktree self-removal should recognize this pattern rather than assume the
  skill was deleted or renamed.
- **`git worktree list` is worth a routine glance during any `finishing-work`
  close-out, not just when actively hunting for drift.** It's how the stray
  `x11a` worktree (Divergence 4) was found here — incidentally, not by design.
  `finishing-work` only tears down the one worktree tied to the PR just
  merged; it has no step that surfaces siblings left behind by an earlier,
  unrelated close-out.
