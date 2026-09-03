# Work log — X8 telemetry guard follow-ups (2026-09-03)

This log covers the review follow-ups to X8 slice 1's telemetry rollup store —
two input-validation defects the slice-1 review deferred, a third defect of the
same class that the pre-push reviewers found inside the first fix, and the
naming/documentation tail. It ran through the hub-and-spoke TDD pipeline across
two PRs and records what shipped, what matched the plan, what diverged, and the
durable lessons.

Predecessor: [`docs/logs/2026-09-03-x8-telemetry-store.md`](./2026-09-03-x8-telemetry-store.md)

## Summary

Two PRs, both merged:

| PR                                                         | Squash     | Contents                                                                        |
| ---------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------- |
| [#927](https://github.com/monte3l/m3l-automation/pull/927) | `76ca2a8c` | `requireValidAtMs` guard; trim for required **and** optional rollup dimensions  |
| [#931](https://github.com/monte3l/m3l-automation/pull/931) | `4d3d9b38` | rename to `requireValidTelemetryAtMs`; no-backfill boundary; stale-docblock fix |

What shipped:

- **`requireNonEmptyDimension` now returns `value.trim()`.** It had validated
  `value.trim()` but returned `value`, so `" /api/v1/runs"` and
  `"/api/v1/runs"` both passed the guard and landed as two distinct
  `console_telemetry_rollup` PRIMARY KEY rows — silently splitting one rollup
  bucket, with no error anywhere.
- **`normalizeOptionalDimension`** (new) trims the optional dimensions
  `operation`, and `outcome` on `sse.stream` / `policy.decision`. These are
  also PK members but reached the upsert through a bare `measurement.x ?? ""`.
  `undefined` and whitespace-only both collapse to the `''` not-applicable
  sentinel; nothing throws.
- **`requireValidTelemetryAtMs`** (new) rejects non-finite, negative, and
  above-`MAX_SAFE_INTEGER` `atMs`. Bounding the input suffices because
  flooring is monotone-decreasing, so no check on the resulting bucket is
  needed. Fractional timestamps stay legal — only the bucket must be an
  integer.
- Guard ordering (`granularity` before `atMs`) is pinned by a test, so the
  granularity error wins when both arguments are bad.
- The measurement-union TSDoc no longer implies normalization is scoped to the
  four required dimensions, and records that there is deliberately **no
  backfill**: rows already persisted untrimmed keep their original PK forever.

Verification:

- `pnpm verify` — **58 steps passed, 10 skipped**. Run 5 times; 1 genuine
  failure (`check:control-chars`), the rest clean.
- **128 tests** across `store-telemetry-validation.test.ts` and the new
  `store-telemetry-optional-dimensions.test.ts`; 117 in the sibling
  `store-telemetry-repository` / `store-migrations-telemetry` suites confirmed
  no regression. Full suite: 417 + 86 + 18 + 7 test files across the four
  vitest configs.
- **Nine mutations, zero survivors at the end.** Reverting the required trim
  fails 4 tests; removing the `atMs` call 3; dropping the safe-integer bound 1;
  swapping guard order 1; over-collapsing internal whitespace 2; dropping the
  optional trim 11; reverting either single optional call site 2 each.
- Review verdicts: **#927 PASS** (no Must-fix; 2 Should-fix, 2 nits),
  **#931 PASS**. Pre-push spokes: `code-reviewer` and `silent-failure-hunter`
  both independently returned the same Must-fix.
- `check:review-size` 12,800 → 35,659 → 7,770 chars across the slices, all
  under the 75,000 soft target. `check:file-budget` clean (753 files).

Skills used: starting-work, writing-commits, creating-prs, finishing-work,
writing-work-logs.

Spoke incidents: 0 truncations / 0 stalls / 1 resume. (No
`tmp/session-incidents.jsonl` existed, so the truncation count is from
recollection rather than the mechanical log; all ten spoke dispatches returned
complete reports. The single resume was a hub-caused recovery, not a
truncation — see divergence 1.)

Compaction events: 1 compaction / 1 recovered via summary. Nothing material was
lost; the slice-1 gate decisions and the deferred-follow-up list both survived.

## What went as planned

- **RED failed for the right reason every time** — `requireValidAtMs is not a
function` and `normalizeOptionalDimension` unresolved, plus assertions
  failing on real current behaviour, never on a typo in the test's own logic.
- **The bucket-merge assertion did its job.** Driving the optional-dimension
  tests through a fake `M3LStoreQueryExecutor` and asserting the two captured
  parameter tuples are _deeply equal_ reproduced the defect exactly: the tuples
  differed at index 5/6 (`" export "` vs `"export"`). That is the assertion
  whose absence let the original bug ship.
- **Both writer spokes pushed back correctly.** The implementer flagged that my
  alphabetical-ordering hint was wrong rather than silently following it, and
  the earlier test-author refused to weaken negative type assertions.
- **The fake-executor choice avoided a budget cliff cleanly.**
  `store-telemetry-repository.test.ts` sits at 59,193 of the 60,000-char test
  ceiling — 807 chars free. Testing through the port needed no migrated
  database and no fixture duplication, so no extraction was required and
  `check:dup` stayed quiet.
- **The read side needed no counterpart.** `M3LTelemetryQuery` and
  `M3LTelemetryPruneRequest` carry no dimension filters, so trimming on write
  created no read/write asymmetry — checked before designing the fix rather
  than assumed afterwards.

## What didn't go as planned, and why

### 1. Mutation-testing with `git checkout --` destroyed the implementer's work

To mutation-test the fix I applied a `perl` edit and then ran
`git checkout -- <file>` to undo it. The changes were **unstaged**, so
`git checkout --` restored from the index — which equalled `HEAD` — and
discarded the entire fix rather than just the mutation. Two src files went back
to their pre-fix state. Only the first mutation's result was valid; the
remaining three ran against a tree that had already lost the fix and reported
an identical failure count that was really just the RED baseline. Recovery was
a `SendMessage` resume handing the implementer the verbatim diff to re-apply.

**Why it happened:** I assumed `git checkout -- <file>` reverts to the current
working-tree state. It reverts to the index. For uncommitted work the index is
`HEAD`, so the command is indistinguishable from "discard my changes."

**Fix for future:** `git add -A` **before** mutation-testing, so
`git checkout --` restores the fix rather than `HEAD`. Add an
assert-fix-is-intact check between every mutation and the next, and abort loudly
if it fails — a mutation harness that cannot detect its own restore failing will
report the RED baseline as a passing guard.

### 2. A test claimed to pin internal whitespace but could not fail

The internal-whitespace test asserted
`requireNonEmptyDimension("/api/v1/ runs")` returns `"/api/v1/ runs"`, with a
comment saying it guarded against accidental tightening. It did not: the
fixture has exactly **one** internal space, which is invariant under
`.replace(/\s+/g, " ")` — the most likely tightening. Mutating the
implementation to collapse internal runs left the whole file green at 103
passed.

**Why it happened:** the fixture was chosen to read naturally, not to
discriminate between the correct implementation and the plausible wrong one.

**Fix for future:** a whitespace-preservation fixture needs a **run** of at
least two whitespace characters, plus a tab, or it cannot detect a collapse.
More generally: pick the fixture that fails under the mutation you fear, then
check that it does.

### 3. The first fix closed only half the bug class

The trim fix covered the _required_ dimensions and stopped there. `operation`,
and `outcome` on `sse.stream` / `policy.decision`, are equally PK members but
reach the upsert via `measurement.x ?? ""`. `code-reviewer` and
`silent-failure-hunter` independently reported the same Must-fix, and the
committed TSDoc had already claimed the bug was fixed.

**Why it happened:** the finding I was handed named `requireNonEmptyDimension`,
so I fixed that function instead of asking which _other_ paths reach the same
primary key. The guard's name made "required" feel like the whole surface.

**Fix for future:** when a fix targets a named function, enumerate every path
to the same invariant — here, every column in the PK — before declaring the
class closed. A defect described as one function's bug is a hypothesis about
scope, not a boundary.

### 4. A literal NUL byte passed every gate until the file became tracked

An intended `"\x00"` escape landed on disk as a real `0x00` byte.
`pnpm verify` failed at `check:control-chars` — but only on the run _after_ the
file was committed, because that gate scans **tracked** files only. The first
verify pass, when the file was still untracked, was clean.

**Why it happened:** an escape sequence written through a file-writing tool can
be materialised as the byte it denotes; and the gate that catches it is blind
to untracked files, so a new file is unprotected precisely while it is new.

**Fix for future:** after writing any file containing an escape, verify with
`cat -A` / `od -c` that the literal characters are present. Do not read a green
`check:control-chars` on a run where the file was untracked as evidence of
anything.

### 5. #927 merged mid-follow-up and the tail was nearly orphaned

While the rename commit was being applied to #927's branch, #927 merged. I was
monitoring `gh pr checks` and `mergeable`, and reported "CI settled, 15 pass" —
but those checks belonged to the pre-merge head, and **zero** workflow runs had
been created for the new commit. I never queried `state` / `mergedAt`. The push
also resurrected a remote branch that `delete_branch_on_merge` had already
deleted. The loss surfaced only when a rebase onto `main` conflicted against my
own squashed changes; the rename was salvaged by cherry-picking onto a fresh
branch off `main`, which applied cleanly.

**Why it happened:** I treated "checks are green" as "the PR is open and this
commit was tested." Those are different claims, and `gh pr checks` answers the
PR's state, not the current head's.

**Fix for future:** before trusting any CI verdict, assert three things
together — `state`/`mergedAt` on the PR, that `headRefOid` equals your local
`HEAD`, and that workflow runs actually exist for that SHA
(`gh run list --commit <sha>` returning zero is the alarm). An open PR whose
head has no runs is not pending; it is untested. And once a PR may auto-merge,
treat its branch as frozen: land the tail as a new PR rather than pushing to a
branch that can close underneath you.

### 6. `starting-work` recommended a command that did not exist

The gate's session-name step, amended by ADR-0088, told me to recommend
`pnpm session:launch`. That script, `bin/claude-launch.mjs`, and
`bin/lib/session-name.mjs` did not exist — ADR-0088 had shipped docs-only in
PR #918 while reading `Accepted`. I fell back to ADR-0087's `claude -n`. The
launcher landed upstream in PR #920 later the same day.

**Why it happened:** an accepted ADR and a shipped mechanism are separate
facts, and a skill amended in the same PR as the ADR can reference a mechanism
that has not been built yet.

**Fix for future:** when a skill instructs you to recommend a concrete command,
confirm the command exists before handing it to the user — an ADR's `Accepted`
status says a decision was made, not that it was implemented.

### 7. Harness friction: killed waiters and stale diagnostics

Three separate backgrounded `until`-loop waiters were killed before their
condition fired; the underlying `setsid nohup` work was unaffected, but progress
had to be tracked by an explicit `Monitor` instead. Independently, the IDE
emitted large bursts of `Cannot find module` and
`Property 'hasOwn' does not exist` diagnostics — all false, confirmed three
times against a real `pnpm typecheck` reporting 0 errors across 38 tasks. They
clustered around files whose worktree had just been deleted.

**Why it happened:** the waiters were harness-tracked background jobs, not
detached processes. The diagnostics come from an LSP resolving without project
context, so it cannot see `tsconfig.base.json`'s `"lib": ["es2025"]`.

**Fix for future:** run long gates with `setsid nohup … & disown` and a durable
log with `REAL_EXIT=$?` written into it — a backgrounded command's reported
status has lied before. Treat a diagnostic naming a sibling file that plainly
exists, or an ES2022 built-in as missing, as LSP noise until a real `typecheck`
disagrees.

## Lessons learned

- **Stage before you mutate.** `git checkout -- <file>` restores from the
  index, so on unstaged work it discards the change instead of the mutation.
  Stage the fix first and assert it is still intact between mutations.

- **A mutation that kills nothing is the finding.** The surviving
  internal-whitespace mutation exposed a test that could not fail for the
  reason it existed. Mutation-testing earned its keep twice here: once for a
  vacuous test, once for a half-fixed bug class.

- **Pick fixtures that discriminate.** A single internal space cannot detect a
  `\s+` collapse. Choose the input that fails under the mutation you fear.

- **A named function is a hypothesis about scope, not a boundary.** The trim
  finding named one guard; the same invariant was reachable through three other
  call sites. Enumerate every path to the invariant — every PK column — before
  claiming the class is closed.

- **Green checks are not a tested commit.** Assert `state`/`mergedAt`,
  `headRefOid == HEAD`, and that runs exist for that SHA. Zero runs on an open
  PR's head means untested, not pending.

- **A PR that can auto-merge is a frozen branch.** Land review tails as a new
  PR; pushing to a branch that may close underneath you orphans the work and
  resurrects a deleted remote ref.

- **`Accepted` is not `implemented`.** Confirm a command exists before
  recommending it, even when a skill names it explicitly.

- **A gate blind to untracked files protects nothing while a file is new.**
  `check:control-chars` scans tracked files only, so the clean run was the
  meaningless one. Verify escapes with `od -c` at write time.

- **Verify the claim, not the report.** Every spoke finding here was
  re-derived before acting — which confirmed a Must-fix twice over, and also
  showed the no-backfill concern had zero current impact, since nothing calls
  `telemetry.record*` and the rollup table holds 0 rows.

- **Two reviewers converging is worth the second dispatch.** `code-reviewer`
  and `silent-failure-hunter` independently produced the same Must-fix from
  different briefs, and the PR bot then independently reproduced the naming
  collision. Corroboration from separate framings beat any single deeper pass.
