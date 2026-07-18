# Work log — `scripts/lambda-ops` (2026-07-18)

This log covers implementing the `lambda-ops` consumer script end to end on
branch `feat/lambda-ops`, via the `implementing-scripts` hub-and-spoke
pipeline. It is the second half of the roadmap's W3 item — the `aws/lambda`
submodule this script depends on was built and merged in a prior session
(PR #165); this session picked up the paused work to implement the actual
script logic, review it, and close out the item. It records what shipped,
what matched the plan, two divergences (one a false alarm, one a real
two-layer test bug), and the durable lessons.

## Summary

Shipped a 7-operation control-plane CRUD + invoke dispatcher
(`list`/`describe`/`invoke`/`create`/`update-code`/`update-configuration`/
`delete`) over the `AWS.M3LLambdaOperations` wrapper, replacing the scaffold's
placeholder step and `batchSize` config parameter entirely.

Pipeline: contract settlement (two rounds — `spec-conformance-reviewer` flagged
10 ambiguities in the hub's first draft, all resolved before RED) → RED
(`test-author`, 67 tests across 6 files) → GREEN (`code-implementer`) → parallel
review fan-out (`code-reviewer` + `security-reviewer` + `silent-failure-hunter`,
all backgrounded concurrently) → fix round (2 Must-fix + 2 Should-fix from
`code-reviewer`, 1 Should-fix from `security-reviewer`, `silent-failure-hunter`
returned a clean PASS) → 78 tests final.

Files: `src/config.ts` (full schema replacing the placeholder), `src/hooks.ts`
(correlationId capture), `src/main.ts` (rewired composition root),
`src/steps/run-lambda-ops.ts` (rewritten dispatcher), 4 new step modules
(`destructive-gate`, `read-functions`, `write-function`, `invoke-function`),
and matching test files (7 total, including a new `hooks.test.ts` and a new
`support/lambdaFakes.ts`).

Gates: 78 tests (7 files, all green), full-workspace `typecheck` (8/8
packages) and `build` (7/7 packages) clean, `lint` clean (0 errors after
fixing 3 `max-lines-per-function`/unused-var errors and 2 duplicate-import
warnings during the GREEN pass), `check:script-scaffold` conformant, `knip`
clean, smoke run confirmed a clean boot to the config-validation boundary
(fails on missing required `aws.profile`, by design — no crash).
`/syncing-docs` ran all 14 steps clean with **zero diff** — the catalog/index/
counts were already correct from the earlier scaffold-landing PR.

Skills used: `implementing-scripts` (primary pipeline), `syncing-docs`,
`writing-work-logs`.

## What went as planned

- **Contract-first caught real ambiguities before a single test was
  written.** The `spec-conformance-reviewer` contract pass on the hub's first
  draft of `docs/reference/scripts/lambda-ops.md` returned 10 flagged
  ambiguities — guard-check location (dispatcher vs. per-step), an unnamed
  output-persistence facility, a documented error code
  (`ERR_LAMBDA_OPS_NO_CORRELATION_ID`) with no corresponding capture
  mechanism, an unbacked "non-dry-run targets" phrase, and — most
  consequentially — `list`'s actual return shape
  (`M3LLambdaListFunctionsResult`, a page of summaries) mislabeled as
  "function configuration." Every one was resolved in the contract page
  before RED, so `test-author` never had to guess or over-constrain a type.
- **RED failed for the right reason.** All 30 initial failures across the 6
  test files were module-not-found or stale-schema mismatches (the scaffold's
  old `batchSize`-based `config.ts`), never a bug in test logic itself.
- **GREEN was substantially clean on the first pass.** 58/67 tests passed
  immediately; the 9 failures that remained all traced to one isolated
  test-authoring bug (see divergence 2), not an implementation gap.
- **The review fan-out ran genuinely in parallel** (all three reviewers
  dispatched in one message, backgrounded) and each surfaced distinct,
  non-overlapping findings — no redundant re-review needed.
- **`silent-failure-hunter` returned a clean PASS** on the first pass,
  specifically confirming the three highest-risk behavioral nuances (the
  persist-before-throw ordering for `invoke`'s `functionError`, narrow
  try/catch scoping, and guard-before-gate ordering) were all correctly
  implemented — the durable lesson promoted from the `aws/lambda` submodule
  session held under a second, independent implementation.

## What didn't go as planned, and why

### 1. Two agent turns ended mid-thought, but the underlying work was already complete

Both the `test-author` RED dispatch and the `code-implementer` GREEN dispatch
returned a final message that looked like a truncated mid-thought fragment
("Good, prettier auto-formatted those files. Now let's re-run the full test
suite...") rather than a completion report. In both cases, verifying state
directly — `git status` to confirm every planned file existed, then actually
running the test suite — showed the work was substantively finished: RED was
clean (30 failures, all for the right reason), GREEN was 58/67 passing with a
single, well-isolated root cause behind every remaining failure. Neither
needed a resume or re-dispatch.

**Why it happened:** The subagent's own summarization step got cut off after
the substantive work (writing files, running verification commands) had
already completed — a cosmetic reporting truncation, not an incomplete-turn
truncation.

**Fix for future:** Keep applying the truncation-recovery protocol exactly as
written (verify actual on-disk state and run the real command before deciding
whether to resume) — but don't assume a mid-thought-looking final message
means incomplete work. The two outcomes (report cut off vs. work cut off)
look identical from the final message alone; only checking ground truth
distinguishes them, and in both cases here it turned out to be the former.

### 2. A two-layer vitest mock-spy bug in `run-lambda-ops.test.ts`

After GREEN, 9/67 tests failed with `TypeError: [AsyncFunction readFile] is
not a spy or a call to a spy!`. Root cause: the test file's top-level
`vi.mock("node:fs/promises", ...)` factory spread the real `readFile` in
unwrapped; only a local `stubReadFileByPath()` helper (called per-test, via
`vi.spyOn`) turned it into a spy. Every test that asserted
`expect(fsp.readFile).not.toHaveBeenCalled()` without first calling that
helper hit the real, un-spied function. Fixed by making the mock factory
eagerly wrap `readFile` as `vi.fn(actual.readFile)`. That fix alone got to
66/67, not 67/67 — a **second** bug then surfaced: with `readFile` already a
`vi.fn()`, `vi.spyOn(fsp, "readFile")` in the stub helper reused the same
instance instead of layering a fresh spy on top, so `vi.restoreAllMocks()` in
`afterEach` no longer cleared its call history between tests. An earlier
test's call count leaked into a later assertion ("`invoke` omits the payload
when `input` is unset") that expected zero calls. Fixed with an explicit
`vi.mocked(fsp.readFile).mockReset()` alongside the other step mocks' resets
in `afterEach`.

**Why it happened:** Vitest's mock/spy layering behaves differently depending
on whether the mocked module's export starts life as a plain function or an
already-existing `vi.fn()` — `vi.spyOn` on a real function creates a
genuinely restorable wrapper, but `vi.spyOn` on an existing mock just returns
that same mock, so `restoreAllMocks()` has nothing distinct to restore to and
silently no-ops on call-history clearing.

**Fix for future:** When a test file needs `node:fs/promises` (or any
module) to be assertable as "not called" in some tests and stubbed with a
custom implementation in others, wrap the relevant export as `vi.fn(actual.x)`
in the mock factory from the start, and reset it explicitly in `afterEach`
(`vi.mocked(x).mockReset()`) rather than relying on `vi.restoreAllMocks()`
alone — that call only fully resets spies created via `vi.spyOn` against a
real (non-mock) starting point.

## Lessons learned

- **Contract-first review scales with contract complexity, not just module
  novelty.** This was the second contract-mode `spec-conformance-reviewer`
  pass this "lambda-ops roadmap item" (the first was for `aws/lambda` itself),
  and it again caught a mislabeled return-shape ambiguity before RED — this
  time on the _consumer_ side. The pattern generalizes: any time a contract
  page describes cross-cutting behavior (which library class writes an
  output, which layer owns a guard-check, what a documented error code's
  actual trigger is), a dedicated contract-mode read before RED is worth the
  round-trip even when the underlying library API is already fully
  implemented and "obvious."
- **A truncated-looking final agent message is not proof of incomplete
  work — verify, don't assume.** Twice this session a subagent's report cut
  off mid-thought, and twice the actual on-disk state (confirmed via
  `git status` + running the real test/build commands) showed the substantive
  work was done. The existing truncation-recovery protocol (verify state
  directly before resuming) already covers this correctly; the added
  nuance worth naming is that verification can conclude "no action needed,"
  not just "resume with a specific gap."
- **`vi.spyOn` on an already-`vi.fn()`-wrapped export doesn't compose the way
  `vi.spyOn` on a real function does.** `vi.restoreAllMocks()` only fully
  resets spies created against a genuine (non-mock) starting implementation;
  layering a `vi.spyOn` on top of an existing `vi.fn()` reuses that same
  instance, so call-history leaks across tests unless explicitly
  `mockReset()`. Any test file that needs a Node builtin both
  assertable-as-uncalled AND stubbable-per-test should wrap it as
  `vi.fn(actual.x)` in the `vi.mock` factory from the start, with an explicit
  reset in `afterEach`.
- **Reviewers converging on the same doc line from different angles finds
  bugs a single reviewer wouldn't.** `code-reviewer` and `security-reviewer`
  both flagged issues rooted in the same contract sentence ("omitting
  `output` logs the result instead of persisting it") but from opposite
  directions — one that the documented behavior (`statusCode` in the summary)
  wasn't actually implemented, the other that the _different_ documented
  behavior (full-result logging) would be a security regression if a future
  maintainer "fixed" the code to match the words. Neither finding alone
  reveals the full picture; running both reviewers unconditionally on every
  AWS-touching script (per this repo's standing `security-reviewer`-always
  rule) is what surfaced this.
- **A green test suite doesn't prove full coverage of an exported symbol.**
  `code-reviewer`'s Must-fix on the missing `hooks.test.ts` is the concrete
  reminder: `getCorrelationId()` and its one throw path had zero test
  coverage, invisible to any "does the suite pass" check because nothing
  exercised that code path at all. Worth an explicit habit for future script
  implementations: check that every exported function in every new/changed
  file — not just the ones a step directly calls — has at least one test.
