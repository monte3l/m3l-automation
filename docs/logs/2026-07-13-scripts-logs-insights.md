# Work log — `scripts/logs-insights` (2026-07-13)

This log covers implementing the `logs-insights` W2 fleet script's business
logic — the second half of the "logs-insights" feature arc. The `aws/logs-insights`
library submodule it consumes merged separately as PR #120; this session
resumed in a fresh worktree/branch off the updated `main` to build the
consuming script through the `implementing-scripts` TDD + hub-and-spoke
pipeline. It records what shipped, what matched the plan, what diverged, and
the durable lessons for the next resumable, checkpointed script.

## Summary

Shipped: 10 config parameters (`aws.profile`, `logGroups`, `query`, `start`,
`end`, `windowMinutes`, `limit`, `format`, `output`, `resume`), 5 step modules
(`resolve-settings`, `time-range`, `checkpoint`, `export-results`,
`run-logs-insights`), and the `docs/reference/scripts/logs-insights.md`
contract page (recreated from scratch — see divergence 1). 66 tests across 7
test files (`config`, `hooks`, and one per step). All gates green:
`typecheck`, `lint`, `format:check`, `pnpm vitest run scripts/logs-insights`
(66/66), whole-workspace `build`, `check:script-scaffold` (2 conformant
packages), `knip` (clean after one fix), and a wiring-only smoke run
(`M3LConfigMissingError` on the required `aws.profile` param with no `.env` —
the expected, correct failure with no live AWS call).

Review verdicts after two fix rounds: `code-reviewer` clean (no Must-fix; 6
Should-fix items, all applied), `security-reviewer` clean (1 Should-fix,
applied; 1 nit, documented as an accepted tradeoff, no code change),
`silent-failure-hunter` clean (1 Must-fix, applied; 1 Should-fix, applied).

## What went as planned

- **The contract-extraction spoke caught both doc/code drifts and the
  resume/exporter design conflict before any test was written.** Running
  `spec-conformance-reviewer` in contract-producer mode against the freshly
  drafted contract page — before dispatching `test-author` — surfaced two
  concrete doc-vs-code mismatches (see divergence 2) and one real design gap
  (divergence 3) while they were still cheap to fix: a doc edit, not a
  test/impl rewrite.
- **RED failed for the right reasons throughout.** Every test file's initial
  failures were `Cannot find module` (missing step files) or a stale-schema
  assertion mismatch (`config.ts` still had the scaffold's placeholder
  params) — never a test-logic bug baked into the RED state itself.
- **GREEN, once dispatched with the finalized contract + all 6 test files,
  produced a correct implementation on the first pass** — 54 of the
  eventual 57 base tests passed immediately; the only 3 failures traced to a
  test-file bug (see divergence 4), not an implementation defect.
- **The three-reviewer fan-out (code + security + silent-failure) ran fully
  in parallel** and each independently reasoned from the same source files
  to the same conclusion on the checkpoint `JSON.parse` issue (divergence 6) — no reviewer needed the others' findings to reach it, a good sign the
  finding was real rather than an artifact of prompt framing.
- **Config schema needed zero changes across the whole review-fix cycle.**
  The 10-parameter schema drafted from the contract page in Phase 1 matched
  what shipped exactly — all churn was in step-module internals.

## What didn't go as planned, and why

### 1. The script's contract page had to be recreated from scratch

`docs/reference/scripts/logs-insights.md` existed once already, written during
the PR #120 session as part of a broader doc-reconciliation commit — but that
PR was scoped to the `aws/logs-insights` library submodule only, and
`scripts/logs-insights/` itself was never committed to it. Claude PR Review
correctly flagged the contract page as an orphan doc (referencing a package
that didn't exist in that PR's diff or the target repo) and it was dropped
before merge. This session had to re-draft the page from zero, re-deciding
several design points via 4 clarifying questions (resume design, time-input
format, output format, window-failure handling) that had been informally
settled in the earlier session but never durably recorded.

**Why it happened:** A library submodule and its consuming script were
developed in the same working session but landed in two separate PRs by
design (the submodule's PR needed to be independently mergeable). The
script's contract page was collateral damage of keeping PR #120's diff
honest — it referenced work that, correctly, wasn't in that PR.

**Fix for future:** When a library submodule and its consumer script are
being built together but will land as separate PRs, write the _library's_
contract page in the submodule PR and explicitly defer the _script's_
contract page to the script's own PR from the start — don't draft it early
and then have to delete it. If early design decisions are made for the
script (as they were here) before its own implementation session, capture
them in a short design note in the plan file or an issue, not only in the
now-deleted doc page, so they survive the page's removal.

### 2. Two contract-page drifts from the actual library API would have produced broken code if uncaught

The first draft of the contract page (before the contract-extraction spoke
reviewed it) said `script.aws.cloudWatchLogs` and referenced an `onShutdown`
lifecycle hook. Neither exists: `AWSProvider` only exposes a `.clients`
getter (the real path is `script.aws.clients.cloudWatchLogs`), and
`M3LScript`'s hooks are `onBeforeInit, onAfterInit, onBeforeConfigLoad,
onAfterConfigLoad, onBeforeRun, onAfterRun, onError, onCleanup` — no
`onShutdown`. Both were fixed in the contract page before `test-author` was
dispatched, so no test or implementation code was ever written against the
wrong API.

**Why it happened:** The contract page was drafted from prior-session
memory of the library's shape rather than a fresh read of the shipped
source (`AWSProvider`/`AWSClientProvider` and `M3LScriptLifecycleHooks`).
The aws/logs-insights submodule's own design changed slightly between when
it was informally sketched and when it actually merged.

**Fix for future:** Even when a design was "already worked out" in an
earlier session, treat a freshly-drafted contract page as a hypothesis and
run the contract-extraction spoke (or an equivalent fresh read of the real
library source) before RED, every time — this session did that correctly
and it caught both drifts for free.

### 3. The exporters' lack of an append mode broke the original resume promise, requiring a mid-design pivot

The contract's first draft promised resume "picks up exactly at the failed
window without re-querying anything already exported" via incremental
per-window writes. But `M3LJSONListExporter`/`M3LCSVListExporter` only
support a whole-array `export(items)` write (or a streaming API that opens
in truncate mode) — there is no append primitive. A resume run re-opening
the same output file would have silently truncated previously-exported
rows. This was caught by the contract-extraction spoke, not by a test or
implementation surprise, and resolved by redesigning the checkpoint file to
carry the accumulated _rows_ themselves (not just a completed-window count),
with the final output written exactly once at the very end of the run from
the full accumulated set (row volume is bounded by `windowCount * 10,000`,
the same cap `GetQueryResults` already imposes per window).

**Why it happened:** The original design was drafted against the _intended_
resume semantics without first checking whether the chosen output primitive
(`M3LJSONListExporter`/`M3LCSVListExporter`) could actually support it.

**Fix for future:** When a script's design promises incremental durability
(resume, partial-progress persistence) via file output, verify the specific
exporter/writer API supports append _before_ writing it into the contract —
not after tests are written against the promise. This is now the reference
pattern for any future resumable script built on these exporters: accumulate
in the checkpoint, write once at the end.

### 4. A test-file bug (not a source bug) caused 3 of 57 GREEN-phase failures

`export-results.test.ts`'s `buildPaths(resolved)` helper returns a composite
`{ paths, resolveOutputSpy }`, but three call sites assigned the return
value directly to a variable named `paths` without destructuring, then
passed that composite object to `exportResults({ ..., paths })` and
asserted on the nonexistent `paths.resolveOutput`. The actual implementation
was correct (it matched the pattern the other two test files used
correctly). Caught immediately by the code-implementer's own gate-driving
run rather than discovered later, then fixed by `test-author` in a
dedicated small pass.

**Why it happened:** The test-author wrote the helper's destructuring
correctly in two of three files but slipped on the third — a
copy-paste-adjacent inconsistency within a single spoke's own output, not a
contract misunderstanding.

**Fix for future:** No process change needed — this is exactly the case the
hub-and-spoke split exists to catch cheaply: `code-implementer` verified
against the real test run (not just "tests exist"), correctly identified
the failure as a test bug rather than trying to work around it in `src/`,
and reported it precisely enough to fix in one targeted pass.

### 5. A related TypeScript typing bug (explicit generic instantiation of an overloaded `vi.spyOn`) needed a second targeted fix

After the `buildPaths` destructuring bug was fixed, `pnpm typecheck` still
failed on both `checkpoint.test.ts` and `export-results.test.ts` with `Type
'"resolveOutput"' does not satisfy the constraint 'never'`. Root cause:
`vi.spyOn` (`@vitest/spy` 4.1.10) is an overloaded generic function, and
TypeScript always resolves an _explicit_ type-argument instantiation
(`typeof vi.spyOn<T, S>`) against the _first_ overload in the declaration
list — the get-accessor overload, whose second parameter is constrained to
non-method property names — regardless of which overload the actual call
site matches. The runtime call (`vi.spyOn(paths, "resolveOutput")`, no
accessor argument) was completely correct; only the explicit type reference
was broken. Fixed by dropping the explicit return-type annotation on the
`buildPaths` helper in both files and letting TypeScript infer it.

**Why it happened:** A known TypeScript limitation with overloaded generic
functions, not a usage mistake — naming an overloaded generic function's
return type via `typeof fn<T, S>` binds to the first overload's constraints
even when a later overload is the one that will actually be selected for a
given call shape.

**Fix for future:** Don't explicitly parameterize `vi.spyOn`'s return type
via `ReturnType<typeof vi.spyOn<T, S>>` in a test helper — let TypeScript
infer the helper's return type from its `return` statement instead. If a
named type is genuinely needed, capture it via `ReturnType<typeof
someLocalWrapperFunction>` after calling `vi.spyOn` inside that wrapper,
never by parameterizing the overloaded library function directly.

### 6. Two independent reviewers converged on the same Must-fix: an unguarded `JSON.parse` on the resume checkpoint

`checkpoint.ts`'s `readCheckpoint` wrapped the file _read_ in error handling
and the shape-validation _failure_ in a typed `M3LError`, but the
`JSON.parse` call between them was unguarded. `silent-failure-hunter` flagged
it as a Must-fix on M3LError-hierarchy grounds (a corrupted checkpoint would
throw a raw `SyntaxError`, and `writeCheckpoint`'s non-atomic `fsp.writeFile`
means a killed process mid-write — exactly the interruption scenario this
script's resume feature is designed around — can leave partial JSON on
disk). `security-reviewer` independently flagged the identical line as a
Should-fix on a different, additional ground: Node's `SyntaxError` message
for malformed JSON embeds a snippet of the surrounding file content, which
in this case is accumulated CloudWatch Logs row data — so an unhandled
rejection could print a fragment of the caller's own log data (potentially
containing secrets/PII) to stderr. Fixed by wrapping the parse and throwing
the same typed `M3LError` code the adjacent shape-validation branch already
used, deliberately _not_ chaining the raw `SyntaxError` as `cause` (since
its message is exactly what carries the sensitive snippet).

**Why it happened:** The GREEN-phase implementation correctly guarded the
`readFile` call and the shape-validation branch but missed the `JSON.parse`
call sitting between them — an easy adjacent-line gap in an otherwise
careful error-handling pass.

**Fix for future:** When wrapping a read-then-parse-then-validate sequence
in typed error handling, treat all three steps (I/O, parse, shape
validation) as needing the same guard — a parse step sitting between two
already-guarded steps is easy to skip. This is doubly true for any file that
can contain caller data (the checkpoint here): a raw parser error message
is itself a potential data-leak vector, not just an error-hierarchy
violation.

### 7. `code-reviewer`, a read-only spoke, accidentally wrote to a file during review

While verifying a formatting-related finding, the `code-reviewer` spoke ran
`prettier --write` on `export-results.ts` to confirm a fix was mechanical,
then attempted `git checkout` to revert it — which the repo's read-only-bash
guard hook correctly blocked, leaving the file in a formatted-but-uncommitted
state. The hub found this out via the spoke's own self-report, verified the
file now failed `prettier --check`, and fixed it directly by running
`prettier --write` across the whole script package (a purely mechanical,
non-judgment operation, not a code-quality decision) rather than asking the
reviewer to self-correct.

**Why it happened:** The reviewer's tool grants are read-only by
convention, but nothing prevented it from _attempting_ a write — the
guard-readonly-bash hook is what actually stopped it, after the fact, not a
capability restriction.

**Fix for future:** No skill/process change made here — the existing
defense-in-depth (read-only convention + the hook backstop) worked as
designed: the write was caught, blocked from silently reverting cleanly, and
self-reported. The hub's response (fix the mechanical drift directly,
don't route a formatting-only issue back through a spoke) was the right
call and matches how the hub already owns bookkeeping-level fixes elsewhere
in this pipeline (e.g. docs reconciliation).

### 8. Two spoke resumptions were needed for truncated turns, plus one resumption mistake

The RED-phase `test-author` and the GREEN-phase `code-implementer` each had
one turn end mid-thought (a fragment like "Now the time-range test..." or
"Now let's run typecheck...") rather than a completion report. Both times
the hub verified actual state directly (which files existed, what a real
test/typecheck run showed) before deciding whether to resume, per this
project's own established playbook — and both times resumption via
`SendMessage` correctly continued the spoke with its accumulated context
intact. One resumption attempt went wrong first: the hub called `Agent`
again with `isolation: worktree` instead of `SendMessage`, which would have
spawned an unrelated fresh agent with no memory of the original 60-tool-call
exploration, in a brand-new worktree unrelated to the one the actual files
lived in. This was caught immediately (before the wrong agent did any real
work) via `TaskStop`, and the correct `SendMessage` resumption followed.

**Why it happened:** `Agent` and `SendMessage` are easy to conflate when
under the impression a spoke "needs a nudge to continue" — `Agent` always
starts fresh regardless of any name/description similarity to a prior
dispatch; only `SendMessage` resumes an existing agent's transcript.

**Fix for future:** When a spoke's turn looks truncated and resumption is
warranted, the default action is `SendMessage` to the spoke's `agentId`,
never a fresh `Agent` call — even one that "sounds like" a continuation in
its prompt. If a fresh `Agent` call is later found to have been dispatched
by mistake before it produces real output, `TaskStop` it immediately rather
than letting it proceed.

### 9. Final `knip` pass caught one more real issue after the review-fix round already looked complete

After all review-fix rounds landed and all local gates were green, a final
`knip` run flagged `LogsInsightsSettingsError` (the script's own local
`M3LError` subclass) as an unused export — it's thrown internally
throughout `resolve-settings.ts` but never imported anywhere else, since the
test file correctly narrows thrown errors by the base `Core.M3LError` class
and `.code` rather than the concrete subclass (this repo's own established
"narrow by code, not `instanceof`" convention). Fixed by dropping the
`export` keyword, making the class module-private.

**Why it happened:** The class was exported by default/habit when it was
created, without checking whether any external caller (including its own
tests) actually needed the concrete type — which, correctly per this
repo's conventions, none did.

**Fix for future:** When a script or submodule defines its own local
`M3LError` subclass purely to satisfy the "typed errors, never bare
strings" rule, default to _not_ exporting it unless a caller genuinely
needs `instanceof` narrowing (rare, and usually a smell per this repo's own
conventions) — `knip`'s anti-hollow gate is the correct backstop, but
checking this at write time avoids the extra round-trip.

## Lessons learned

- **Verify a resumable design against its exact output primitive before
  writing the contract.** A promise like "resume without re-writing
  completed work" is only as good as the chosen writer API's actual append
  support — check `exportStream()`/`export()`'s real semantics before
  committing to incremental-write language in a contract page.
- **A contract page drafted from memory of an already-shipped library API
  needs a fresh-source verification pass, every time — even when the design
  was "already worked out" in an earlier session.** Both real drifts this
  session found (`script.aws.clients.cloudWatchLogs`, no `onShutdown` hook)
  came from exactly this gap, and the contract-extraction spoke step caught
  both for the cost of one read-only pass before any test was written.
- **`ReturnType<typeof vi.spyOn<T, S>>` is unreliable for the plain-method
  overload — let the type infer instead.** Explicit generic instantiation of
  an overloaded function always binds to the first overload in TypeScript,
  not the one that matches the actual call site's shape. _(promoted →
  .claude/rules/tests.md)_
- **Resume a spoke via `SendMessage` to its `agentId`, never a fresh `Agent`
  call, even when the new prompt reads like "continue X."** Only
  `SendMessage` preserves the spoke's accumulated exploration context; a
  fresh `Agent` call is indistinguishable from an unrelated new task no
  matter how the prompt is worded.
- **A read-then-parse-then-validate sequence needs the same error-handling
  guard on all three steps, not just the first and last.** The parse step
  in the middle is the easiest one to leave unguarded, and for any file that
  can contain caller data, an unguarded parser's own error message is a
  potential leak vector in its own right — flag this explicitly to
  implementer spokes on any script that reads back its own previously
  written state (checkpoints, caches, resume files). _(promoted →
  .claude/rules/library-src.md)_
- **When two independent review spokes converge on the same line from
  different angles (error-hierarchy vs. security), treat it as strong
  signal, not redundant noise** — it means the finding survives multiple
  independent framings rather than being an artifact of one reviewer's
  prompt.
