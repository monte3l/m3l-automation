# Work log — U11 retry/resume/cancellation surfacing (2026-09-03)

This log covers **U11**, tracker item of the ADR-0053 CLI-evolution wave
(epic #608, issue #535) — the last of that wave's "deepened launcher" pillar.
It ran through the hub-and-spoke pipeline (`starting-work` → per-slice TDD
dispatch → three-reviewer pass → `creating-prs` → `finishing-work`) across
seven slices and eleven PRs. It records what shipped, what matched the plan,
the ten divergences that cost real rework, and the durable lessons — two of
which are promoted into `.claude/rules/` in this same change set.

Plan of record: [`docs/plans/2026-09-02-u11-retry-resume-cancellation.md`](../plans/2026-09-02-u11-retry-resume-cancellation.md)

## Summary

An operator can now resume a checkpointed flow, interrupt an in-process run
with Ctrl-C and have it unwind through cleanup rather than die mid-write, and
read retry/outcome information out of `m3l history`.

| Slice | PR(s)      | What shipped                                                                                                         |
| ----- | ---------- | -------------------------------------------------------------------------------------------------------------------- |
| 1     | #899       | ADR-0086 (attempt-metadata seam) + the dated design plan; docs only                                                  |
| 2     | #905       | `m3l flow --resume` activated behind an ADR-0045 fingerprint guard                                                   |
| 3     | #913       | Ctrl-C unwinds cooperatively instead of killing mid-report                                                           |
| 4     | #925, #928 | `run-report` sanitization pipeline extracted; #928 repointed the TSDoc self-references the move falsified            |
| 5     | #938, #940 | `pollDetailed`/`runDetailed` attempt-metadata seam (**semver minor**); #940 covered the server-driven delay override |
| 6     | #951, #955 | `retryAttempts` scalar derived onto the run report; #955 recovered the #951 review fixes lost to an auto-merge race  |
| 7a    | #959       | Run-outcome data plumbed toward the history store                                                                    |
| 7b    | #972       | `OUTCOME`/`ATTEMPTS` columns rendered in `m3l history`; `docs/reference/cli.md` amended; U11 flipped to Done         |

**ADR-0086's decision:** option 2 — sibling `pollDetailed`/`runDetailed`
methods returning an envelope, leaving `poll`/`run` untouched. Option 4
(reuse `M3LProcedureTelemetry`) was checked against live code first, as the
plan required, and rejected: `M3LRunRecoveryEntry`
(`core/diagnostics/run-report.ts:109`) carries only `item`, `error` and
`recordedAt` — no attempt data at all — so it could not carry the seam. The
tracker's "possible minor" therefore resolved to **an actual minor**.

A correction worth recording, since it is this log's own subject matter: the
plan-mode plan justified weighing option 4 by asserting that
"`core/procedure/run-types.ts:266` already exposes an `attempt` field on
`M3LRunRecoveryEntry`". That line does hold `readonly attempt: number`, but it
belongs to **`M3LProcedureTraceEntry`**, a different type on the trace path.
The conclusion survived; the cited evidence did not. This log carried the
misattribution forward verbatim until a reviewer checked the type — exactly the
"re-derive any authored claim" failure that divergences 5 and 7 are also about.

Final verification on the closing slice: `pnpm verify` green
(`VERIFY_REAL_EXIT=0`, 58 passed / 10 skipped); `bin/tests` under
`vitest.bin.config.ts` 89 files / 3,286 tests; the full `m3l-cli` suite 43
files / **1,635 passed**; `commands/run.ts` branch coverage 100% (4/4);
`check:file-budget` clean across 761 files. Reviewable diff 75,574 chars
(574 over the soft target, under the 300,000 ceiling).

Review verdicts on the closing slice: `code-reviewer` approve / 0 Must-fix;
`security-reviewer` 0 Must-fix with every finding confirmed by _executing_
probes; `silent-failure-hunter` 1 Must-fix (fixed). Six fixes applied, three
findings deferred to the follow-up list.

`#535` closed via `pnpm sync:hub -- --apply` as `CLOSED/COMPLETED` — a
merged PR alone cannot close a hub-sync issue, which is why the
`IMPLEMENTATION.md` row flip shipped inside #972. Epic #608 correctly stays
open: U13 (private-registry publishing) and U14 (Deferred) remain.

Skills used: starting-work, syncing-docs, resolving-pr-comments,
creating-prs, writing-commits, finishing-work, writing-work-logs.

Spoke incidents: `tmp/session-incidents.jsonl` was **not available** at
write time — it is session-rotated and the closing session's copy lived in
the worktree that `finishing-work` had already removed, so the mechanical
count is unrecoverable. From recollection, the closing slice alone hit **3
writer-spoke truncations** at the 40-turn limit (summary-threading RED,
diagnostic+TSDoc GREEN, the assertion fix, the coverage fix), 0 stalls, and
1 `SendMessage` resume — earlier slices' counts are not reconstructible from
here. See divergence 10.

Compaction events: 2 in the closing session (one automatic, one manual
`/compact`); both recovered via the ADR-0078 handoff with no state class
identified as lost.

## What went as planned

- **The re-derivation step earned its keep immediately.** Per CLAUDE.md's
  "re-derive any authored claim" rule, all three of the tracker row's asks
  were checked against live code before planning. Two moved: `--resume` was
  library-complete (passthrough only, not a build), and Ctrl-C's
  `AbortSignal` ports already existed on `M3LPoller`/`M3LRetryRunner` — only
  the CLI's `SIGINT` handler was missing. Planning against the row as
  written would have scoped a library build that was already done.
- **The file-budget traps were measured up front and never fired.** The plan
  recorded `main.ts` at 23,683 b (1,317 b headroom) and
  `M3LCheckpointStore.ts` baselined at _exactly_ its 49,710 b. Routing
  `--resume` parsing into `cli/flags.ts` and keeping `main.ts` to a
  delegation call meant `check:file-budget` stayed green across all seven
  slices, with zero `--update` ratchets requested.
- **Docs-first slicing held.** Slice 1 measured ~0 reviewable chars and
  settled ADR-0086's decision before any code existed, so slices 2–3 (which
  are independent of the seam) landed while the seam question was still open
  rather than blocking on it.
- **Reviewers ran before every push, not after.** Auto-merge closes the
  review window, so all three reviewers saw each diff pre-push. This is what
  caught the two highest-severity defects in the wave (divergences 2 and 3),
  both of which three prior review passes had cleared by reading.
- **The linkage assertion passed on every slice.** `gh pr view <n> --json
closingIssuesReferences` returned `[]` before each merge, preserving
  `sync:hub`'s ownership of closing #535.

## What didn't go as planned, and why

### 1. An auto-merge race orphaned #951's reviewed commit — the second occurrence in the same wave

PR #951 merged at head `a35d145e` while the review-fix commit `15d5195d` was
still in flight. GitHub squash-merged, deleted the remote branch, and the
in-flight push **re-created** it — reporting success. `main` shipped without
the TSDoc trim, the `Number.isFinite` guard, and a seven-phrase stale-prose
sweep. Recovered as PR #955, with `git patch-id --stable` confirming the
cherry-pick byte-identical to the reviewed commit. The same class had
already hit #925 earlier in this wave (recovered as #928).

**Why it happened:** `git ls-remote` was used as the post-push check. It
showed the correct SHA — because the _re-created_ branch really did point at
it. The branch ref was accurate and meaningless: the PR sat `MERGED` at an
older head, pointing at a ref that no longer fed anything.

**Fix for future:** `gh pr view <n> --json state,headRefOid` is the only
authoritative post-push check — `state` must be `OPEN` _and_ `headRefOid`
must equal your SHA. Better, and adopted for the rest of the wave: leave
auto-merge **unarmed** on any PR expecting a review round, which removes the
race instead of timing around it. The tell is a push to an _existing_ branch
printing `* [new branch]`.

### 2. The same read-twice validation defect shipped twice, on the same field, leaking a secret both times

Slice 6's `core/diagnostics/run-report.ts` read `input.retryAttempts` twice
inside `build()`; a getter returning `3` then `"sk-live-…"` **persisted the
secret into `run-report.json`**, bypassing redaction. Slice 7a's
`m3l-cli/src/history/store.ts` then read `entry.retryAttempts` _three_ times
in `projectHistoryEntry`, putting a secret into `m3l history --json` output.
Its own immediate sibling — `run/report-lookup.ts:237-241` — already did it
correctly.

**Why it happened:** the shape looks like a correct guard.
`typeof x.f === "number" && Number.isFinite(x.f) ? x.f : null` reads the
property three times, and an accessor may return a different value on each
read, so the value returned is not the value validated. My own first fix
instruction (wrap in `try/catch`) would not have closed it — the reads, not
the throwing, were the bug — so I had to amend it.

**Fix for future:** validate a **local copy**, never the property
expression. Count the property reads in any narrow of external data; more
than one mention of the same property in a validate-then-return expression
_is_ the defect, whether or not a getter currently exists. A "nil exposure
today" argument is not grounds to skip it — both sites were unreachable when
found, the read-once form is the same length, and divergence from a correct
sibling one file away is what makes the next person copy the wrong one.
_(promoted → `.claude/rules/library-src.md`)_

### 3. Two prototype-pollution tests were incapable of failing

Two slice-7b tests set `Object.prototype.outcome = "success"` and asserted
`expect(result).not.toHaveProperty("outcome")`. Both failed against a
_correct_ implementation. The GREEN spoke reported 77/79, refused to edit
them, and diagnosed against chai's source that when the key is not an own
property `not.toHaveProperty` falls back to `"key" in Object(obj)` — which
walks the entire prototype chain. Under live pollution every object reports
the key, so the assertion could neither pass nor fail on the implementation.
A third test in the same block passed, because it used `toStrictEqual({})`.

**Why it happened:** `toHaveProperty` reads like an own-key assertion and is
harmless _outside_ a polluted block, so the trap is invisible until the test
is specifically about pollution.

**Fix for future:** in any test that mutates a prototype to prove a guard
ignores inherited data, assert absence with `Object.hasOwn` or
`toStrictEqual` — never `not.toHaveProperty`, never `in`. The tell is a
pollution test that fails no matter what the implementation does, or one
that passes before the guard is written.
_(promoted → `.claude/rules/tests.md`)_

### 4. An incomplete `vi.mock` factory presented as a wiring bug

Introducing the shared `historyOutcomeFields` helper broke a previously
passing test in both `run.test.ts` and `dynamic.test.ts`, whose
`history/store.js` factories listed only `recordHistoryEntry`. The missing
export threw — but the call sits inside a best-effort `try/catch`, so the
throw was **swallowed and `recordHistoryEntry` was never called**. The
symptom was "no history recorded", indistinguishable from a plumbing defect.

**Why it happened:** a plain object-literal `vi.mock` factory silently omits
every export the factory does not list, and a swallowing call site converts
that omission into a plausible-looking behavioural failure rather than a
loud `undefined is not a function`.

**Fix for future:** default a `vi.mock` of a first-party module to the
`importOriginal`-preserving async factory (already the rule for SDK packages
in `.claude/rules/tests.md`) and mock only the members that need replacing.
When a best-effort `try/catch` wraps the call, treat "the effect didn't
happen" as a candidate _mock_ failure, not only a wiring failure.

### 5. A required field's construction sites were invisible to grep

Adding `retryAttempts: number | null` to `M3LCliRunReportSummary` was scoped
as "two files" from the three interface declarations in
`m3l-cli/src/run/envelope.ts`. A third file, `m3l-cli/src/flow/envelope.ts`,
assembles the summary as a plain object literal in `reconstructLookup` and
stopped compiling. `grep -rl M3LCliRunReportSummary` returns **two** files
both before and after the fix.

**Why it happened:** TypeScript's structural typing means a literal
construction site never has to name the type, so a name-based census cannot
find it. Vitest compounded this by transpiling without typechecking —
`execute.test.ts` ran 34/34 while carrying a `TS2741`.

**Fix for future:** use `pnpm build` as the census before scoping any change
that makes a field required, and treat the compiler's error list as
authoritative over any grep. Cheaper mitigation: grep a _sibling field name_
(`recoveryTotal`) rather than the type name, since literals do mention their
keys. Expect fallout in test files too.

### 6. Widening a return type propagated into mocks, not just callers

Slice 7a widened `executeScript` from `Promise<number>` to
`{ exitCode, summary? }`. Enumerating "which tests fail" found 12 call
sites; `grep -n executeScript` found **14**. The two missing ones were
`const exitCode = await executeScript(...); expect(exitCode).toBe(2)` —
passing _today_ because the old implementation returned a bare `2`. The full
blast radius included 41 `executeScriptMock.mockResolvedValue` sites across
three further test files, 17 of them in `flow-step.test.ts`, whose
production behaviour does not change at all.

**Why it happened:** a census built from current failures is blind to a site
whose old assertion is coincidentally satisfied by a primitive, and a
`src`-only survey cannot see the files that merely _mock_ the symbol.

**Fix for future:** enumerate from **call sites**, never from the failure
list, and scope a signature change as "1 signature = N callers + M mock
sites" from the start.

### 7. A behaviour-preserving move falsified its own comments — a whole PR's worth

Slice 4's extraction moved prose that was true where written and false at
its destination: "the pre-pass **this module** used previously", "before
**this module's** normalize-before-redact reordering", "(**this module's**
own pre-fix baseline)", and `"Extracted from {@link run}'s catch block"`
after that catch had moved to `#runLoop`. PR #928 exists solely to repoint
them. Slice 6 added a fifth and sixth instance from TDD's RED phase — a
test still asserting "throws a TypeError that escapes `buildSuccessInput`"
after the guard shipped, and a title _actively inverted_ ("Infinity poisons
the maximum the same way NaN does" when the shipped code rejects both).

**Why it happened:** no gate catches it — `tsc`, ESLint, prettier and the
full suite all pass. A spoke told to move a block "verbatim" correctly
refuses to touch the prose; a reviewer checking "TSDoc integrity" checks
whether `{@link}` targets _resolve_, not whether the English is still true.
RED-phase comments manufacture this by design: they describe a defect
deliberately eliminated minutes later.

**Fix for future:** after any extraction, move, or rename — and as an
explicit GREEN-phase step — grep the touched files for `this module`,
`this file`, `previously`, `extracted from`, `RED phase`, `does not exist
yet`, `currently`, `escapes`, `poisons`, and re-read each hit _at its new
location_. Rewrite in the present tense for the guard that now exists,
keeping the defect in the past conditional as the reason the test exists.

### 8. The coverage gate caught an untested false arm of a new diagnostic

`pnpm verify` failed with `Coverage for branches (75%) does not meet global
threshold (80%) for packages/m3l-cli/src/commands/run.ts`. The new
diagnostic's `cause instanceof Error ? \`: ${cause.message}\` : ""` false arm
had no test.

**Why it happened:** the diagnostic was added by a spoke fixing a
`silent-failure-hunter` finding, whose brief was the finding, not coverage.
A defensive ternary adds a branch that no happy-path or standard
failure-path test reaches.

**Fix for future:** when adding a defensive ternary to a catch block, add
the non-`Error` throw test in the same edit (`throw "disk gone"`, asserting
the _bare_ message with no appended detail). Note that per-file thresholds
run **only** under `test:coverage` — `pnpm test` will not surface this.

### 9. I misdiagnosed a `check:review-size` figure as stale-base inflation

`git diff --stat origin/main HEAD` showed 26 files including a
`m3l-console-web/docker/default.conf` deletion I never touched (the branch
was 4 commits behind), and I inferred this had inflated
`check:review-size`'s 75,574-char figure. After rebasing, the figure was
**unchanged at 75,574** — the gate had always measured the merge-base
correctly. Only my manual diffstat was inflated.

**Why it happened:** I generalised from a real, documented failure mode (CI
diffing against the `main` tip rather than the merge-base) to a gate that
does not share it, on the strength of a diffstat that _did_ show the
symptom.

**Fix for future:** a stale-base symptom in a hand-run `git diff` is not
evidence about what a gate measured. Re-read the gate's own output after a
rebase before attributing a number to base drift — and read the `bin/*.mjs`
source, since what a `check:*` gate enforces is defined there, not by
nearby prose.

### 10. Test-file byte budgets became the binding constraint, and the incident log was lost to cleanup

`dynamic.test.ts` finished at 59,170 of the 60,000-byte `TEST_CEILING_BYTES`
— **830 bytes** of headroom. Managing this drove a real design change: after
a spoke spent 3,335 bytes on a single test, I introduced the shared
`historyOutcomeFields` helper so the mapping matrix is tested **once** in
`history-store.test.ts`, leaving each command suite one pass-through
integration test. Separately, `tmp/session-incidents.jsonl` was gone by the
time this log was written, because `finishing-work` removes the worktree that
held it.

**Why it happened:** `check:file-budget` runs no earlier than `pre-push`, so
growth is discovered late; and the incidents file is session-rotated and
worktree-local, while the work log is written after close-out by design.

**Fix for future:** measure a test file before dispatching an edit that
grows it and give the spoke an explicit byte budget — spoke B then _shrank_
`dynamic.test.ts` from 57,749 to 56,580 rather than ratcheting the baseline.
For the incident count: read `tmp/session-incidents.jsonl` and record the
per-`kind` counts **before** `finishing-work` removes the worktree, not
after.

## Lessons learned

- **`gh pr view --json state,headRefOid`, never `ls-remote`** — a re-created
  branch reports your SHA correctly while the PR sits `MERGED` at an older
  head. Leave auto-merge unarmed on any PR expecting a review round; that
  removes the race rather than timing around it. Cost this wave: two
  orphaned reviewed commits, two recovery PRs.
- **Validate the local, not the property** — every mention of `x.f` in a
  validate-then-use chain is a separate read, and an accessor may answer
  differently each time. This shipped twice in one wave on the same field
  name, leaking a secret both times. `Object.hasOwn` guards _presence_;
  read-once guards _stability_ — you need both.
  _(promoted → `.claude/rules/library-src.md`)_
- **`not.toHaveProperty` cannot prove own-key absence** — it falls back to
  `in` and walks the prototype chain, so a pollution test using it can never
  fail. Assert with `Object.hasOwn` or `toStrictEqual`.
  _(promoted → `.claude/rules/tests.md`)_
- **Executing beats reading for validation defects** — the two most severe
  findings in this wave were both cleared by three reviewers reading the
  diff, and both caught by a reviewer that wrote probes and ran hostile
  inputs through the real function. Code reading does not surface this class:
  the code looks like a correct guard.
- **A spoke that refuses to edit a test is working correctly** — twice a
  writer spoke reported a failure it could not fix within its brief (the
  incomplete mock factory, the two unfailable assertions) instead of
  weakening a test to reach green. Both reports were the diagnosis. Preserve
  the writer≠reviewer boundary that makes this the cheap outcome.
- **`pnpm build` is the census for a required field** — grep cannot see a
  structural construction site, and Vitest transpiles without typechecking,
  so a green suite is not evidence of a green `typecheck`. Enumerate a
  signature change from call sites, never from the failure list, and count
  mock sites as part of the blast radius.
- **Grep the deictic phrases after every move** — "this module", "extracted
  from", "RED phase" are all true where written and false at the
  destination, and no gate catches it. Make it an explicit GREEN-phase step,
  distinct from "check the TSDoc".
- **Measure a test file before growing it** — `check:file-budget` fires no
  earlier than `pre-push`, so a file near the ceiling turns any growth into
  a late failure. An explicit byte budget in the spoke brief made a spoke
  shrink the file instead of ratcheting the baseline; the ceiling pressure
  also produced the better design (test the matrix once in the owning
  suite).
- **Read the incident log before close-out removes it** —
  `tmp/session-incidents.jsonl` is session-rotated and worktree-local, so
  `finishing-work` deletes the only mechanical record of spoke truncations
  before `writing-work-logs` runs. Capture the counts at the end of the
  implementation session, not at log-writing time.
- **Don't generalise a documented failure mode onto a gate that lacks it** —
  a stale-base symptom in a hand-run diffstat said nothing about what
  `check:review-size` measured. Re-read the gate's own output, and the
  `bin/*.mjs` source, before attributing a number to base drift.

## Deferred follow-ups

Fourteen items were recorded across the wave and deliberately not fixed in it.
They are listed here because the scratchpad that held them is session-local and
will not survive — **but a follow-up that lives only in a work log does not
exist.** Anything below that warrants action needs a `docs/plans/IMPLEMENTATION.md`
row before `sync:hub` can project it; re-derive each one at filing time rather
than trusting this framing.

| #   | Item                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Origin                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 1   | `internal/logging/guardSecrets.ts` can echo a secret **to stderr** — a caller-supplied `isSecret` that throws with a secret in its own message has that message and stack written verbatim (reached via `run-report.ts:979`). Fail-closed held: the persisted report came back fully `[REDACTED]`, so this is stderr-only and self-inflicted by the caller's throwing predicate. Still worth a fix — `run-report.json` is a classified sensitive crash-dump artifact (ADR-0035, 2026-07-23 update) and stderr is not. **Highest-priority item on this list.** | slice 4 security review (executed probe) |
| 2   | In-process flow steps are not cancellable — `m3l-cli/src/flow/step.ts` passes no signal                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | slice 3                                  |
| 3   | `commands/run.ts` has the same unprotected history-recording window as the flow path                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | slice 3                                  |
| 4   | `stepExecutionCount` is unbounded in `isNonNegativeInteger`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | slice 3                                  |
| 5   | `isDangerousKey` is not applied to `asRecord` in the flow-record read path                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | slice 3                                  |
| 6   | `polling-no-progress.test.ts` has **26 bytes** of headroom (59,974 / 60,000)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | slice 5                                  |
| 7   | Retry's failure path carries no attempt count — `M3LPoller` exposes it, `M3LRetryRunner` does not                                                                                                                                                                                                                                                                                                                                                                                                                                                             | slice 5                                  |
| 8   | ADR-0086's own budget rationale cites byte counts that have since moved — fix via a dated **Update** heading, never a body edit                                                                                                                                                                                                                                                                                                                                                                                                                               | slice 6                                  |
| 9   | `retryAttempts` is a per-cycle **maximum**, not a cumulative total — documented, but a surprising semantic worth revisiting                                                                                                                                                                                                                                                                                                                                                                                                                                   | slice 6                                  |
| 10  | `flow/step.ts` does its own `locateRunReport` and could now reuse the shared lookup                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | slice 7                                  |
| 11  | In-process runs record history with **no** outcome/attempts — they have no child, so never write a report (documented in `cli.md` as one of the three `-` causes)                                                                                                                                                                                                                                                                                                                                                                                             | slice 7                                  |
| 12  | The cause-formatting ternary is now **triplicated** across `execute.ts`, `run.ts` and `dynamic.ts` — extract a `describeCause` helper                                                                                                                                                                                                                                                                                                                                                                                                                         | slice 7b review                          |
| 13  | `retryAttempts` is not constrained to a non-negative integer — `-1e21` renders as `ATTEMPTS -1e+21`                                                                                                                                                                                                                                                                                                                                                                                                                                                           | slice 7b review                          |
| 14  | `packages/m3l-cli/tests/dynamic.test.ts` has **830 bytes** of headroom; the split seam is the `--in-process` dispatch cases                                                                                                                                                                                                                                                                                                                                                                                                                                   | slice 7b                                 |

Three further items recorded during the wave are already resolved and are not
listed above: the wave work log (this file), `recordHistoryEntry`'s
validate-on-read/trust-on-write asymmetry (fixed in #972 on the maintainer's
"project on write too" decision), and the `#560`/X12 tracker drift (closed by
another session — `IMPLEMENTATION.md:263` now reads `Done`, so `sync:hub` no
longer proposes reopening it).
