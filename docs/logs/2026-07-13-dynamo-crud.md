# Work log — `dynamo-crud` consumer script (2026-07-13)

This log covers implementing `dynamo-crud`, the first W2 scale-hardened
consumer script, in a linked worktree on `feat/dynamo-crud`. The script had
been scaffolded earlier in the session, then paused mid-flow while the
`aws/dynamodb` library submodule was built as a prerequisite (an explicit
architectural decision that scripts must never depend on the AWS SDK
directly) and merged to `main` via PR #118. This log picks up from that
merge: resyncing the paused worktree, running the full RED → GREEN → review
→ fix → confirm pipeline, and closing out with the doc-reconciliation pass.

## Summary

- **Rebase + resume**: the worktree was 14 commits behind `main` with an
  uncommitted scaffold. Rebased cleanly (no conflicts, signature intact),
  committed the scaffold, then found and fixed two contract-page staleness
  issues before dispatching any spoke — the page still described driving the
  raw `dynamoDBDocument` client (pre-dating the `aws/dynamodb` decision), and
  the `key`/`item` config-parameter reuse semantics (`key` also serves as
  `query`'s equality condition, `item` also serves as `update`'s merge patch)
  were never spelled out in the schema table.
- **RED**: 5 parallel `test-author` dispatches (one per step module),
  preceded by hub-authored exact function signatures for all 5 steps —
  76 tests (`single-item-ops` 14, `destructive-gate` 6, `scan-table` 14,
  `batch-write-table` 9, `run-dynamo-crud` orchestrator 33), all failing for
  the right reason (missing modules / unimplemented contract).
- **GREEN**: one `code-implementer` dispatch (with two resumes) delivered 5
  step modules + a 13-parameter `config.ts` + `main.ts`/`hooks.ts` wiring —
  78 tests green, typecheck/lint/build/format clean. Commit `d7ff70a`.
- **Review**: `code-reviewer` + `security-reviewer` + `silent-failure-hunter`
  fan-out. Security clean. `code-reviewer`: 2 must-fix + 3 should-fix.
  `silent-failure-hunter`: 1 **critical** must-fix + 1 should-fix.
- **Fix round**: all 7 findings fixed, plus a new `runName` config parameter
  (a genuine design addition, not just a bug fix) and 4 regression tests
  proving the 3 must-fix items end-to-end. Commit `878ff96` (82 tests).
- **Confirmation pass**: `code-reviewer` + `silent-failure-hunter` re-verify
  (all 7 findings RESOLVED, no regressions) + an adversarial
  `security-reviewer` refute pass targeting the new `runName` path-traversal
  surface, the confirm-gate, and classifier spoofing — refutation failed on
  all four attempted vectors (confirmed safe). Surfaced 2 minor new
  should-fix nits.
- **Polish**: both nits fixed (`Core.combineClassifiers` reuse; one new
  logging branch tested). Commit `e0f8e29` (83 tests).
- **Final gates**: `typecheck`/`lint`/`build`/`format:check`/`knip`/
  `check:script-scaffold` all clean; smoke run fails fast on missing required
  config as expected; full repo suite (61 files, 2783 tests) green.
- **Docs**: `/syncing-docs` full pass — zero drift (script commits don't
  touch library provenance-tracked files). `docs/ROADMAP.md`'s W2 row and
  `docs/plans/IMPLEMENTATION.md`'s W2 section updated to reflect
  `dynamo-crud` done (1 of 3 W2 scripts).
- Never imports `@aws-sdk/*` directly at any point — confirmed via `grep`
  at multiple checkpoints across the session.

PR not yet opened as of this log — that's the next step.

## What went as planned

- **The rebase onto merged `main` was clean** — no conflicts across 14
  commits, signature verified intact, config smoke test passed immediately.
- **Designing exact per-step contracts before RED paid off.** For a script
  this complex (parallel-segment scan with checkpoint/resume, a
  sentinel-based batch retry mechanism, a shared destructive gate), the
  existing contract page wasn't detailed enough at the function-signature
  level to hand to 5 independent `test-author` spokes and expect mutually
  consistent tests. Deriving exact signatures myself first — grounded in
  directly reading `aws/dynamodb`'s actual source rather than guessing —
  meant all 5 independently-written test files agreed on shapes with zero
  cross-file drift.
- **The "scripts never import `@aws-sdk/*`" constraint was solvable cleanly.**
  Deriving client parameter types structurally
  (`Parameters<typeof AWS.getItem>[0]`) instead of importing the SDK types
  worked exactly as intended and was adopted consistently across all 5
  step modules without friction.
- **The adversarial security refute pass earned its keep.** It didn't just
  restate the first-pass clean verdict — it empirically tried a dozen-plus
  concrete path-traversal payloads against the new `runName` parameter
  across both POSIX and Windows path semantics before concluding the guard
  holds, which is a meaningfully stronger confirmation than "looks fine."
- **All three confirmation-pass reviewers verified against the actual diff**,
  not the fix-round commit message — each traced the real code path (e.g.
  the silent-failure-hunter reproduced `M3LRetryRunner`'s exhaustion logic
  line-by-line before declaring the critical retry bug resolved).

## What didn't go as planned, and why

### 1. The GREEN-phase `code-implementer` hit its turn limit twice and returned truncated mid-thought reports both times

Both times, the agent's final message was a fragment ("Now let's check
Vitest's actual mock-reset semantics via Context7...", "Now update
`run-dynamo-crud.ts`. First the type-only import issue.") rather than a
completion summary. In both cases the underlying work was actually further
along than the fragment suggested — reading the agent's own journal file and
independently running the test suite revealed real progress (3 of 5 files
correctly implemented; later, all 5 files + config + wiring done) that the
truncated message didn't convey.

**Why it happened:** A single `code-implementer` dispatch covering 5 step
modules + a 13-parameter config schema + composition-root wiring is a large
enough task that debugging one subtle issue (see divergence 2) consumed the
remaining turn budget before a final report could be composed.

**Fix for future:** This is exactly what `implementing-scripts`/
`implementing-submodules` already prescribe (read the journal, verify state
directly, resume via `SendMessage` rather than trusting the summary) — this
session is a strong confirmation that the guidance is necessary, not
theoretical. For a script this scale-hardened, consider splitting GREEN into
2 dispatches up front (e.g. read-side steps vs. write-side steps +
orchestrator) rather than waiting to discover the single dispatch runs long.

### 2. An identical test-infrastructure bug (`vi.restoreAllMocks()` not clearing `vi.mock()`-factory `vi.fn()`s) recurred independently in 3 test files

`scan-table.test.ts`'s `afterEach` used only `vi.restoreAllMocks()`, which
undoes `vi.spyOn` spies but does **not** clear a plain `vi.fn()` created
inside a top-level `vi.mock(...)` factory (the pattern used to mock
`AWS.scanSegment`/`queryItems`). This let mock call-history and
`mockImplementation` leak across tests, producing confusing intermittent
failures (a test asserting "0 calls" instead saw calls from an earlier test)
that passed when run in isolation but failed in the full suite. I diagnosed
and fixed this directly rather than letting `code-implementer` debug it
(it's a test file bug, out of the implementer's fix scope). The identical
bug then surfaced independently in `run-dynamo-crud.test.ts` and
`batch-write-table.test.ts` — three different `test-author` agents,
writing three different files in the same RED-phase batch, made the exact
same mistake.

**Why it happened:** `vi.restoreAllMocks()` "sounds like" a complete mock
reset, but Vitest scopes it specifically to spies. None of the 5 parallel
`test-author` dispatches were told this distinction explicitly, so each
independently reached for the more familiar-sounding API.

**Fix for future:** Promoted into `.claude/agents/test-author.md` (see
below) — a test file that mocks a named export via `vi.mock()` must also
call `vi.mocked(theExport).mockReset()` per mocked export in `afterEach`,
not rely on `restoreAllMocks()` alone.

### 3. The checkpoint/resume feature was fundamentally broken and passed 78/78 tests anyway

`run-dynamo-crud.ts` derived the checkpoint filename from `correlationId` —
but `correlationId` defaults to a fresh `crypto.randomUUID()` on every CLI
invocation when the script doesn't pass an explicit
`M3LScriptOptions.correlationId` (which `dynamo-crud`'s `main.ts` doesn't).
This meant a `--resume` run could never find its own killed run's checkpoint
file — the entire scale-hardening headline feature was non-functional,
despite full test coverage, because no existing test exercised `resume: true`
at the orchestrator level or asserted anything about checkpoint-path
derivation. `code-reviewer` caught this in the review fan-out.

**Why it happened:** The original contract page said "load
`<output-dir>/<run-name>.checkpoint.json`" but `<run-name>` was never
actually turned into a real config parameter during scaffolding or RED — it
was a placeholder phrase nobody circled back to define, and GREEN silently
substituted the nearest available per-run identifier (`correlationId`)
without questioning whether it was stable across invocations.

**Fix for future:** Added a real `runName` config parameter (optional,
falling back to `${operation}-${tableName}` when unset) and two regression
tests proving checkpoint-path stability. When a contract page uses a
placeholder-sounding phrase like `<run-name>` that isn't in the declared
config schema table, resolve what it actually maps to before RED, not after
a reviewer catches the gap.

### 4. The production batch-retry mechanism was a complete no-op, invisible to 78 passing tests

`batch-write-table.ts` threw an internal sentinel error to force
`Core.M3LRetryRunner` to retry a chunk's unprocessed items. The _production_
retry runner (constructed in `run-dynamo-crud.ts`) used
`Core.awsThrottlingClassifier` + `unknownDecision: "fatal"`, which doesn't
recognize the sentinel — so it was classified `"unknown"` → `"fatal"` →
immediate failure with zero retries on the very first `unprocessed` response
DynamoDB returns (a completely normal, expected occurrence at scale). Every
existing test used its own permissive test-only classifier
(`() => "retriable"`), so this was invisible until `silent-failure-hunter`
traced the actual production wiring.

**Why it happened:** The sentinel-based retry design is sound, but nobody
verified the _production_ classifier composition actually recognized the
sentinel — RED-phase tests validated the retry _mechanism's shape_ (does it
retry when told to), not whether the real classifier would ever tell it to.

**Fix for future:** When a retry/backoff mechanism relies on an injected
classifier, always add at least one test that constructs the _actual
production_ classifier (not a permissive test stand-in) and proves multiple
attempts genuinely occur — a test that only exercises a trivial
always-retry classifier proves the retry _loop_ works, not that the real
classifier ever engages it.

### 5. A stop-and-restart request landed on an agent that was mid-task, not on a genuinely stuck one

The user asked to stop and restart the code-implementer that was writing the
4 regression tests for the fix round. `TaskStop` reported "no task found" —
the agent was idle between turns (not an active running process at that
instant), so there was nothing to forcibly terminate. Checking the actual
file/test state showed only mocking scaffolding had landed, no test bodies
yet, so a fresh dispatch with full context was the right move regardless.

**Why it happened:** Background agents only "run" during their active tool
calls; between calls they're idle and resumable, not perpetually
executing — so a stop request can arrive when there's genuinely nothing live
to stop, even though the task still shows as in-progress overall.

**Fix for future:** When asked to stop-and-restart a background agent,
first check its actual file/journal state before assuming either "it's
mid-edit, must abort cleanly" or "there's nothing to do" — the safe move is
always to inspect state, then decide whether a fresh dispatch or a resume is
appropriate.

## Lessons learned

- **`vi.restoreAllMocks()` does not clear `vi.mock()`-factory `vi.fn()`s.**
  Only undoes `vi.spyOn` spies. A test file mocking a named export via
  `vi.mock()` needs `vi.mocked(theExport).mockReset()` per mocked export in
  `afterEach` too — this bug recurred identically in 3 independently-written
  test files in one RED-phase batch. _(promoted → `.claude/agents/test-author.md`)_

- **Design exact per-step contracts before dispatching parallel test-authors
  on a complex multi-step script.** When a script's design (parallel
  fan-out, checkpoint/resume, retry sentinels) goes beyond what the
  contract page specifies at the function-signature level, the hub should
  derive and pin those signatures — grounded in the real underlying API,
  not guessed — before fanning out RED-phase dispatches. This is what kept
  5 independently-written test files mutually consistent with zero
  cross-file drift.

- **A retry/backoff mechanism's tests must exercise the real production
  classifier at least once**, not only a permissive test-only stand-in —
  otherwise a classifier that never actually recognizes the retry signal can
  pass 78/78 tests while being a complete no-op in production.

- **A placeholder-sounding phrase in a contract page (`<run-name>`) that
  never became a real declared config parameter is a latent design gap, not
  a documentation nit.** GREEN silently substituted the nearest available
  identifier (`correlationId`) without questioning its stability — resolve
  what a contract's placeholder phrases actually map to before RED.

- **A contract page can go stale relative to earlier same-session
  architectural decisions if nobody re-reads it before resuming paused
  work.** This script's contract still described the pre-`aws/dynamodb`
  design after that submodule was built and merged; the `key`/`item` reuse
  decisions from earlier in the session were also never written back into
  the schema table. Re-validate a paused script's contract page against any
  architectural decisions made since it was last touched before resuming
  implementation, mirroring the existing "re-validate plan claims" guidance
  for `docs/plans/` files.

- **Background agents that return a truncated mid-thought message are
  usually further along than the fragment suggests, not stuck.** Recurred
  at least 5 times across this session's dispatches — reading the agent's
  journal plus independently running the actual gates was the reliable way
  to find the true state each time, exactly as the existing hub-and-spoke
  playbooks prescribe.
