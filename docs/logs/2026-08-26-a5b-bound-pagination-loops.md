# Work log — A5b bound pagination loops (2026-08-26)

Covers issue #506 (**A5b**), the second PR of the A5 two-PR chain (A1b/A2b/A3b/A4b
precedent): A5 shipped an opt-in no-progress witness on `M3LPoller`/
`M3LRetryRunner` (PR #501) but no real call site passed it, so no run was
actually guarded. A5b closes the gap — landed as two PRs after re-deriving the
issue's own claims against the current tree found one of its two named
sub-tasks was a documented no-op rather than real work. Ran through the full
hub-and-spoke TDD pipeline twice (once per PR): `test-author` RED,
`code-implementer` GREEN, a multi-spoke review round, a fix round, a second
pre-push review pass, then merge.

Plan of record: [`docs/plans/archive/2026-08-26-a5b-bound-pagination-loops.md`](../plans/archive/2026-08-26-a5b-bound-pagination-loops.md)

## Summary

**Re-derivation before implementation** (per CLAUDE.md's "re-derive any
authored claim you're about to act on") found the issue row's part (a) —
"thread `progress` into `athena`/`cloudwatch-logs-insights`'s poller
construction" — was mechanically true (both accept `pollerOptions`) but
functionally hollow: both poll a binary terminal status with no visibility
into intermediate responses, so a witness there could only be a constant,
degrading `maxStalledAttempts` into a strictly worse `maxAttempts`. The row
also missed two script call sites that build their own poller/runner
(`codepipeline-ops`'s `watch-execution.ts`, `dynamodb-crud`'s
`batch-write-table.ts`), both similarly unwitnessable (a status wait; a
throttling-sensitive retry). Part (a) was scoped as a documented no-op; the
real, previously-unaddressed hole was part (b) — four genuinely unbounded
`do … while (cursor !== undefined)` pagination loops with no ceiling at all.

**PR #664 (library)** — `packages/m3l-common` `4.3.0 → 4.3.1` (patch, hand-
managed per ADR-0020). New `internal/aws/pagination.ts`
(`createPageCursorGuard()`), an always-on (not opt-in) repeated-cursor guard
throwing the existing `M3LNoProgressError` (`ERR_NO_PROGRESS`) on a consecutive
cursor repeat, wired into `aws/dynamodb`'s `queryItems`/`scanSegment` and
`aws/s3`'s `listObjects`. Zero new exported symbols; `check:api` unchanged. 23
new tests (14 direct guard unit tests, 6 `dynamodb.test.ts` regression tests, 3
`s3.test.ts` regression tests), 100% coverage on all 3 touched/new source
files. 5-spoke review round (code-reviewer, spec-conformance-reviewer,
type-design-analyzer, silent-failure-hunter, security-reviewer) found 2
must-fix (stale `docs/implementation-status.md` test counts; `M3LNoProgressError`'s
own TSDoc making claims — "per `Object.is`", "the configured threshold" — that
became false once a second, differently-mechanised thrower existed) and 2
should-fix (missing `@throws` documentation; a cursor value type wider than the
serializer can safely honor, deferred as it would require widening the public
`DynamoDBKey` type). A second pre-push review pass on the fix-round diff (4
spokes) found one more real inaccuracy in the hub's own doc edits — a claimed
"one extra page request" cost that didn't hold — fixed before push. The
automated `claude-pr-review` bot's PASS-verdict Should-fix (module header TSDoc
read as bounding "any misbehaving endpoint" rather than only the
consecutive-repeat case) was also addressed pre-merge. Squash-merged as
`b373cb4`.

**PR #665 (fleet + tracker close-out)** — the one remaining unbounded loop,
`scripts/eventbridge-schedules/src/steps/list-rules.ts`'s `drainRules`,
mirrors the library pattern with a local (scripts can't import `internal/`)
repeated-token check, throwing `Core.M3LError` with the library's own
`ERR_NO_PROGRESS` string code for cross-fleet narrowing consistency. 3 new
tests (stuck-token rejection, 3-page advancing happy path, single-page
no-false-trip), all 9 tests in the file passing. 2-spoke review
(code-reviewer, silent-failure-hunter) — clean, no findings. Tracker rows
flipped: `docs/plans/IMPLEMENTATION.md`'s **A5b** row `To Do → Done`;
`docs/ROADMAP.md`'s **A5** row `To Do → Done` (pre-existing drift — A5 had
already shipped as PR #501 but the ROADMAP row was never flipped).

**Skills used:** `starting-work`, `syncing-docs` (x2), `writing-commits` (x3),
`creating-prs` (x2), `writing-work-logs`.

**Spoke incidents:** 1 truncation (the first `code-implementer` GREEN pass hit
its 40-turn limit right after reporting 100% coverage, before confirming the
final verification pass — resumed via `SendMessage` to the same agent id,
which completed cleanly), 0 stalls, 1 resume.

## What went as planned

- **RED failed for the right reason, both times.** The library RED phase
  failed on `TS2307`/module-not-found for the not-yet-existing
  `internal/aws/pagination.ts`; the fleet RED phase failed with a clean,
  fast (~10ms) assertion mismatch, not a hang — the test-author deliberately
  avoided the naive `expect(...).rejects...` pattern around an unbounded loop
  after discovering (during the library RED phase) that it can OOM-crash the
  Vitest worker when every promise resolves synchronously, starving Node's
  timer phase before the per-test timeout fires.
- **GREEN was clean on the placement decision, both times.** Both
  implementers independently placed the guard call outside the
  local error-rewrapping `try`/`catch`, exactly as specified, and both were
  verified — by the implementer and again by three independent
  review passes — to propagate `ERR_NO_PROGRESS` unwrapped rather than
  silently re-labeled as the wrong operation-error code.
- **The security review executed rather than reasoned.** Both security passes
  ran actual probes against rebuilt `dist/` (planted-secret cursors,
  prototype-pollution attempts via `__proto__`-bearing JSON, ReDoS checks)
  rather than inferring safety from reading the source, catching nothing but
  confirming the guard's `context` genuinely carries only two integers, never
  the cursor value.
- **The type-design review's one real finding was already anticipated as a
  deferred trade-off** — narrowing the cursor value type below `Record<string,
unknown>` would require widening the public `DynamoDBKey` type, correctly
  assessed as out of scope for a patch-level bug fix.

## What didn't go as planned, and why

### 1. A `SendMessage`-launched fork with a placeholder prompt was accidentally dispatched instead of resuming the truncated agent

When the first `code-implementer` GREEN pass stopped at its turn limit, the
intended recovery was `SendMessage` to that agent's id. Instead, `Agent` was
called with `subagent_type: "fork"` and a literal placeholder prompt
("This is a placeholder — not used."), spawning a real (harmless but wasted)
fork that correctly did nothing and exited immediately.

**Why it happened:** Reaching for the `Agent` tool is the more habitual motion
than `SendMessage` when "continue this agent" is the goal, and the two tools
were momentarily conflated.

**Fix for future:** To resume a specific truncated/paused agent by id, always
use `SendMessage({ to: <agentId>, message: ... })` — never `Agent` with any
`subagent_type` (including `"fork"`, which creates a **new** agent, not a
continuation of an existing one).

### 2. A spurious mid-session task reference to an already-merged PR

Partway through, an instruction arrived to "continue landing issue #497 /
PR #661" — but PR #661 was already merged over an hour earlier and sat at the
tip of `main` at the very start of this session's git log, and no plan for
issue #497 existed in this conversation. Verified against `gh pr view`/
`gh issue view` before acting, surfaced the discrepancy, and confirmed via
`AskUserQuestion` that there was nothing to do before resuming the actual A5b
work in progress.

**Why it happened:** Cross-session or cross-task instruction bleed — the
reference belonged to a different (already-completed) unit of work.

**Fix for future:** Any instruction referencing a specific issue/PR number
that doesn't match the current session's tracked state is worth a 10-second
`gh` verification before acting on it, especially for state-changing actions
like merging — cheap insurance against acting on stale or misdirected
instructions.

### 3. A backgrounded `git push` was killed before completing

The first attempt to push the fix-round doc-clarity commit was reported
`killed` rather than `completed` by its background-task notification, with no
error output — `git log origin/<branch>` confirmed the remote hadn't advanced.
A bare retry of the same `git push` succeeded immediately.

**Why it happened:** Unclear — no diagnostic output survived the kill.
Plausibly an environment-level interruption unrelated to the push itself
(the retry's clean success rules out a real Git-side failure).

**Fix for future:** Treat a `killed` (vs `completed`) background-task status
on a push as a transient-and-retry case, not a failure to diagnose — but
always re-verify the remote ref actually advanced (`git log origin/<branch>
--oneline -1`) before assuming either the kill or the retry's success.

## Lessons learned

- **Re-deriving an issue's own claims against the tree is not optional
  process theater — it changes the shipped scope.** Two of A5b's three
  factual claims (part (a)'s reachability, the two named consumers' actual
  poller usage) were wrong, and both changes were substantive: part (a)
  became a documented no-op instead of real work, and two previously-unnamed
  call sites were identified and correctly excluded for their own reasons.
  This is the second time in this A-wave (`A5` itself corrected two claims
  from its own filing) that re-deriving-before-acting caught a materially
  wrong scope — the practice is earning its keep, not just satisfying a rule.

- **An "always-on, no opt-in" design for a fleet-wide safety guard is the
  right default when the failure mode is unconditionally pathological.**
  A repeated pagination cursor can never represent legitimate progress
  (unlike a slow-but-real poll), so making the guard opt-in — as A5's own
  witness is — would have repeated A5's exact failure: shipping a capability
  no real call site uses. The precedent (A1b/A2b/A3b/A4b all being **fleet
  retrofits** of an opt-in library capability) is itself evidence that
  opt-in safety features don't get adopted without a forcing function; this
  one avoided needing a fleet retrofit of its own by not being opt-in.

- **A guard's placement relative to an existing error-rewrapping
  `try`/`catch` is exactly the kind of thing worth over-specifying in a
  spoke prompt, twice.** Both the library and the fleet implementer got this
  right on the first pass specifically because the prompt spelled out the
  hazard (a tripped guard silently re-labeled as the wrong error code) and
  named a concrete safe placement — this is a case where telling the
  implementer _why_ a constraint exists, not just _what_ to do, paid off in
  zero rework.

- **A pre-push review pass on the FINAL diff (post-fix-round) is not
  redundant with the pre-fix review round, even when the fix round only
  touched TSDoc/naming.** The second pass on PR #664 found a real, new
  inaccuracy — introduced by the hub's own doc edits made in response to the
  first round's findings, not by the original implementation. Doc prose
  written to fix one reviewer's finding can itself introduce a new one;
  treat every prose edit as needing the same scrutiny as code, not a free
  pass because "it's just docs."

- **An automated PR-review bot's Should-fix on a PASS verdict is worth a
  cheap, targeted fix even though nothing blocks merge.** The bot's
  complaint (module header TSDoc implying broader coverage than the guard
  actually provides) was arguably a defensible reading either way, but the
  one-clause fix cost nothing and closed a real ambiguity for a future
  reader — bar for "worth fixing before merge" should be "cheap and
  correct," not "blocking."

- **`SendMessage` to a specific `agentId`, never `Agent` with any
  `subagent_type`, is the only way to resume a truncated or paused
  subagent.** Reaching for `Agent` instead spawns a brand-new, context-free
  agent (or, worse, a context-inheriting fork that silently no-ops on a
  placeholder prompt) rather than continuing the one that stopped mid-task.
