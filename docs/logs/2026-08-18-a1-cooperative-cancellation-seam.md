# Work log — A1 cooperative cancellation seam (2026-08-18)

This log covers item **A1** of the codified-procedure-engine wave (issue #468):
threading an `AbortSignal` from the script lifecycle through `core/polling` and
into every long-blocking `aws/**` operation, so a shutdown signal can stop work
that is already in flight. It ran through the hub-and-spoke TDD pipeline
(`starting-work` → spec-first docs → RED `test-author` spokes → GREEN
`code-implementer` spokes → review spokes → `syncing-docs`). It records what
shipped, what matched the plan, what diverged, and the durable lessons — most of
which are about spoke context management, which dominated this run.

Plan of record: [`docs/plans/2026-08-18-codified-procedure-engine.md`](../plans/2026-08-18-codified-procedure-engine.md)
(item A1). Decision: [ADR-0049](../adr/0049-cooperative-cancellation-contract.md).

## Summary

Six commits on `feat/cooperative-cancellation-seam`:

| Commit    | Contents                                                         |
| --------- | ---------------------------------------------------------------- |
| `70db471` | Spec-first: 9 reference pages                                    |
| `5dc3653` | `core/errors` + `core/polling` + `internal/polling/delay`        |
| `75d723d` | `core/script` + `runScript` outcome mapping                      |
| `08187d6` | 8 AWS waiters + 2 query polls + `reason` sanitization            |
| `a28b886` | Review round: throttle-retry gap, guard reuse, coverage backfill |
| `b4781a3` | Provenance/tracker/ADR reconciliation                            |

**Public surface:** 2 new exported symbols — `M3LOperationAbortedError`
(`core/errors`, code `ERR_OPERATION_ABORTED`, `origin: "caller"`,
`retryable: false`) and `M3LECSWaiterOptions` (`aws/ecs`, extracted from an
inline object literal). Plus one class accessor (`M3LScript.signal`) and optional
`signal?: AbortSignal` on 5 existing options interfaces. Both new symbols surface
through the namespace barrels; the three-entry `exports` map is untouched.
**Additive minor.** Symbol count 611 → 621.

**Tests:** full suite **7811 passing** across 216 files (was 7731). Per-module:
errors 128, polling 153, script 277, script-cancellation 2 (new file),
diagnostics 136, ecs 55, cloudformation 94, eks 127, athena 45,
cloudwatch-logs-insights 26.

**Coverage:** clears every per-file threshold (lines 90 / functions 83 /
branches 80 / statements 89). `internal/polling/delay.ts` finished at **100%
statements, 100% branches** after a targeted backfill.

**Gates:** `typecheck`, `lint`, `build`, `check:zones` (23 zones + no-cycle, none
widened), `check:test-counts` (41 submodules), `check:doc-counts` (22 Core + 19
AWS = 41), `check:doc-exports` (39 modules), `check:impl-counts` (41 of 41),
`check:script-scaffold` (14 scripts), `check:index` (621 symbols),
`check:provenance` (41 sidecars), `lint:md` (241 files), `jscpd` — all green. All
13 `sync:docs` steps pass.

**Review verdicts:**

- `silent-failure-hunter` — **PASS**. 0 must-fix, 1 medium (declined, see below),
  2 nits. Confirmed the no-reclassification ordering and the
  exit-code-before-report guarantee.
- `code-reviewer` — 0 must-fix, 3 should-fix (2 fixed, 1 declined), 4 nits
  (3 fixed).
- `security-reviewer` — **did not run**: 3 consecutive API 529 Overloaded
  failures. The hub verified all five of its assigned claims directly instead.

**Skills used:** starting-work, writing-commits, syncing-docs, writing-work-logs,
creating-prs.

**Spoke incidents:** 11 truncations / 1 stall / 5 resumes / 3 API failures.

## What went as planned

- **Spec-first paid off immediately.** All nine reference pages landed as the
  first commit, and every RED spoke wrote its tests from those pages without
  needing a clarifying round. The pinned `reason` string formats in the docs are
  what made the AWS tests assert exact wording rather than a proxy.
- **RED failed for the right reasons, verified rather than trusted.** 28 core
  failures grouped cleanly into missing-symbol and unimplemented-behavior
  buckets (`M3LOperationAbortedError is not a constructor` ×9,
  `expected undefined to be an instance of AbortSignal` ×4,
  `expected 'failure' to be 'interrupted'`, exit `1`/`2` vs `5`), and the AWS
  wave at exactly 50 failed / 294 passed. The hub re-ran and grouped the
  failures itself rather than accepting the spokes' self-reports.
- **No zone was widened.** ADR-0049 made this a hard constraint and it held with
  no pressure at all: `aws/**` already admitted `core/errors` and
  `core/polling`, which was everything the design needed.
- **The `exports` map never moved.** Both new symbols went through the namespace
  barrels, `check:api` and `check:exports` stayed green.
- **The tests pinned a stronger contract than the plan specified.** The plan
  called for the abort error to omit a chained `cause`; the RED tests went
  further and pinned `new M3LOperationAbortedError()` with an _optional_ message
  and _no `cause` parameter at all_, making the leak structurally
  unrepresentable rather than merely discouraged.
- **Splitting the AWS GREEN work three ways worked.** After one over-scoped
  implementer exhausted its context on the types alone, three narrowly-scoped
  spokes on disjoint files completed 2-of-3 without truncating.

## What didn't go as planned, and why

### 1. Eleven spoke truncations across nine dispatches

Nearly every spoke in this run stopped mid-turn at its final verification step —
usually with a narration fragment like "Now let me run typecheck and lint:" or
"Now I'll add `testSignalContract` calls…" — leaving work either unverified or
genuinely unfinished. Concretely: the AWS `Explore` agent, both core
`test-author`s, the AWS `test-author` (twice), the core `code-implementer`, the
script `code-implementer` (twice), and the Athena/Logs-Insights implementer. Five
were recovered with a targeted `SendMessage` resume naming the exact remaining
work; the rest had in fact completed their edits and only lost the report.

**Why it happened:** two distinct causes that look identical from the outside.
Most were ordinary mid-turn truncation on a long turn. One — the first AWS
implementer — was true context exhaustion: it burned ~98k tokens and 67 tool
calls adding `signal` to five options interfaces and never reached a single
`client.ts`, so the tests were still at the exact RED baseline afterwards.

**Fix for future:** never infer progress from a spoke's final message, and never
from a completion notification. Re-run the gates from the hub after every spoke
— a truncated spoke and a finished spoke are indistinguishable from their
transcript tail. And size an AWS-wave dispatch by _client file_, not by wave: one
spoke per 1–2 client files, which is what eventually worked.

### 2. The first AWS implementer silently made no functional progress

The 50 failing AWS tests were still failing identically after the spoke reported
work and truncated. Only a `git diff --stat` revealed it had touched types and
barrels but no client logic.

**Why it happened:** the dispatch covered 8 waiters, 2 query polls, an interface
extraction and a security fix across 7 files — far more than one context could
hold. The instruction to "STOP and report if low on context" was present but the
spoke truncated before it could act on it.

**Fix for future:** for any dispatch spanning more than ~3 source files, split it
up front rather than relying on the spoke to self-limit. The `git diff --stat`
check against the expected file list is the cheapest possible truncation
detector — run it before reading any spoke report.

### 3. The `Plan` agent stalled and was abandoned

The Phase-2 design agent ran 8+ minutes without converging while the hub had
already independently derived the design and, in the meantime, found the two most
consequential facts of the whole task (the unreachable `ABORTED` arm and the
latent `reason` leak). It was stopped as redundant.

**Why it happened:** the design was already tightly constrained by an accepted
ADR plus a docs-first spec, so there was little genuine design space for a
separate agent to explore — and the hub's own targeted reads were faster.

**Fix for future:** when the binding decision is already an accepted ADR with a
per-module contract, skip the Plan agent and spend the time on targeted
verification reads instead. Plan agents earn their keep on open design space, not
on execution of a settled contract.

### 4. `security-reviewer` failed three times on API 529s; the hub verified instead

Three consecutive dispatches died with `API Error: 529 Overloaded`. Rather than
keep retrying or ship unverified, the hub verified all five assigned claims
directly: read `@smithy/core`'s `checkExceptions` to confirm the leak premise,
grepped all 11 `new M3LOperationAbortedError` call sites (every one passes zero
arguments), confirmed no `reason: error.\w+` survives anywhere under `src/aws`,
and checked listener balance in `delay.ts`.

**Why it happened:** transient upstream capacity, nothing to do with the task.

**Fix for future:** a review spoke that fails on infrastructure twice is a signal
to verify in-hub, not to retry a third time. For a security claim that reduces to
"does content X reach channel Y", grep-and-read from the hub is often _more_
conclusive than a spoke's narrative — and it is reproducible in the log.

### 5. `runScript` breached the cognitive-complexity gate, blocking a commit

Two added ternaries pushed `runScript` to complexity 11 against a max of 10.
`pnpm lint` rejected the commit at the pre-commit hook.

**Why it happened:** the function was already at the threshold; any conditional
addition would have tripped it.

**Fix for future:** this was a _useful_ gate failure — extracting
`handleRunFailure` left `runScript` a thin lifecycle skeleton. But the extraction
had to be instructed with an explicit constraint to preserve the
`exitCode`-before-report ordering, because moving that assignment would have been
a silent regression that all 693 tests would still have passed.

### 6. Coverage-JSON inspection after `pnpm test:coverage` is misleading

The coverage-backfill spoke concluded `delay.ts` was at 100% because it was
_absent_ from `coverage/coverage-final.json`. The hub flagged this as
contradicting the repo's documented understanding (the JSON is authoritative
precisely because the _text table_ hides fully-covered files) — and the real
explanation was different again.

**Why it happened:** `pnpm test:coverage` runs two passes
(`vitest run --coverage && vitest run --coverage --config vitest.bin.config.ts`)
and the second overwrites `coverage/` with bin-only data. Inspecting the JSON
after the composite script tells you nothing about library files. Separately,
coverage is not written at all when tests fail.

**Fix for future:** to inspect library per-file coverage, run
`pnpm exec vitest run --coverage` (the library config alone) and read the JSON
immediately. Treat the threshold ERROR lines from the run itself as the
authoritative gate signal — absence from the JSON is never evidence of full
coverage.

### 7. Two new exports passed `check:doc-exports` but broke `sync:docs`

`sync:docs` stopped at its barrel↔sidecar step: both new symbols were missing
from the provenance sidecars' `sections[].sources[]`, even though
`check:doc-exports` was green.

**Why it happened:** exactly the trap the `syncing-docs` skill documents.
`check:doc-exports` walks the _barrel_; `gen:index` derives from the _sidecars_.
A `--update` restamp refreshes existing entries but never adds a new symbol, so
`gen:index` would have silently no-opped and `check:index` would have passed
vacuously.

**Fix for future:** when a change adds a public export, hand-add it to every
relevant sidecar `sections[].sources[]` in the same change set, mirroring how a
sibling symbol is registered (both new symbols needed entries in _two_ sections
each). The composite `sync:docs` now catches this mechanically — trust it over
`check:doc-exports` alone.

### 8. The planned separate `fix:` commit for the security change was not achievable

The plan specified the ECS/CloudFormation `reason` sanitization as its own
`fix:` commit. The implementer built single catch-classification helpers
(`handleEcsWaiterCatch`, `handleStackWaiterCatch`) in which the abort-rejection
and the sanitization occupy the same new function.

**Why it happened:** the two concerns are genuinely co-located — both live in the
`catch` arm classification — and `git add -p` is unavailable in this environment
to split intertwined hunks.

**Fix for future:** decide commit granularity _before_ dispatching, and if two
concerns must land separately, instruct the implementer to keep them in separate
functions. Retrofitting a commit split onto already-written intertwined code is
rework, not hygiene.

## Lessons learned

- **A spoke's last message is not its progress report.** Nine of this run's
  dispatches truncated; five needed resuming. Verify every spoke by re-running
  the gates and by `git diff --stat` against the expected file list, before
  reading a word of its report. _(promoted → `docs/contributing/subagent-context-management.md`)_

- **Size a dispatch by source file, not by wave.** One spoke covering 8 waiters
  across 7 files exhausted its context on the type declarations alone and made
  zero functional progress. Three spokes on 1–2 client files each completed
  cleanly. _(promoted → `docs/contributing/subagent-context-management.md`)_

- **TypeScript narrowing on `signal.aborted` is unsound across an `await`, and
  the obvious fix destroys the contract.** TS narrows the property to `false`
  after a check and keeps that narrowing past an `await`, flagging a later
  re-check as an impossible comparison (TS2367). The tempting resolution —
  deleting the re-check — is exactly what would let a classifier retry a
  cancelled operation. Route every re-check through a
  `function isAborted(signal): boolean` helper. _(promoted → `.claude/rules/library-src.md`)_

- **Threading a signal can make a latent leak reachable.** The ECS and
  CloudFormation `ABORTED` arms had embedded the raw SDK message for as long as
  they existed, harmlessly, because nothing passed an `abortSignal`. Adding one
  turned dead code into a live channel. When enabling a previously unreachable
  branch, audit that branch as new code, not as existing code. _(promoted → `.claude/rules/library-src.md`)_

- **Prefer a constructor that cannot carry the payload over a call site that
  declines to.** Omitting `cause` from `M3LOperationAbortedError`'s constructor
  entirely makes the smithy response-body leak unrepresentable; all 11 call sites
  pass zero arguments, so its whole observable surface is a static string plus a
  code. That is verifiable by grep, unlike a convention.

- **A contract clause that contradicts shipped behavior can hide behind dead
  code.** ADR-0049 said an aborted wait "rejects"; all three waiter families
  resolved `{ state: "ABORTED" }` instead. Nobody had noticed because no caller
  could reach that arm. Reconcile a new contract against what the code _does_,
  not only against what its docs claim.

- **Decline a cleanup that would mint public API or widen a boundary.** Nine
  near-identical `isAborted` helpers is real debt, but `core/errors` is
  `export *` (hoisting would add public API as a side effect of a refactor) and
  `internal/` would create the repo's first `aws/** → internal/` edge, where
  every prior aws-island widening was ADR-recorded. Documented debt beats an
  unplanned architectural precedent.

- **Read the coverage JSON from the library pass only.** `pnpm test:coverage`
  runs two passes and the second overwrites `coverage/`; and nothing is written
  when tests fail. Use `pnpm exec vitest run --coverage` and treat the run's own
  threshold ERROR lines as the gate. _(promoted → `.claude/skills/vitest-coverage-types-mocks/SKILL.md`)_

- **An uncovered branch is worth understanding before it is worth covering.**
  `delay`'s already-aborted fast path looked defensive; it is load-bearing,
  because `addEventListener("abort")` never fires on an already-aborted signal,
  so without it an aborted delay would sleep its full duration and then
  _resolve_. The coverage gate surfaced a real behavioral cliff.

- **A new public export needs a sidecar entry, not just a barrel entry.**
  `check:doc-exports` walks the barrel and goes green; `gen:index` derives from
  the sidecars and silently no-ops. Add the symbol to every relevant
  `sections[].sources[]` in the same change set.

- **Skip the Plan agent when an accepted ADR already pins the contract.** It
  stalled 8+ minutes on settled design space while targeted hub reads found the
  two most consequential facts of the task.

- **Two infrastructure failures on a review spoke means verify in-hub.** Three
  529s cost more than the verification did; for "does content X reach channel Y",
  hub-side grep-and-read is both conclusive and reproducible in the log.
