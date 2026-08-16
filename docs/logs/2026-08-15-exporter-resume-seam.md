# Work log — exporter-resume-seam (2026-08-15)

Closes issue #427 / F11: the fleet-wide resume-checkpoint pattern buffered a
run's entire accumulated output in the checkpoint file to work around the
list exporters' truncate-on-open behavior, reintroducing the unbounded
memory/disk growth per-page streaming exists to avoid. This log covers the
full pipeline — a new byte-offset resume seam in `packages/m3l-common`'s
list exporters, its adoption across `dynamodb-crud`, `rds-data-sql`, and
`cloudwatch-logs-insights`, and the ADR/tracker/version-bump doc work that
closes the issue.

Plan of record: [`issue-427-valiant-hamming.md`](/home/enri3l/.claude/plans/issue-427-valiant-hamming.md) (local plan-mode file, not checked into the repo)

## Summary

Six commits on `feat/exporter-resume-seam`:

1. `feat(m3l-common)` — `resumeFromByte`/`columns` construction options and a
   `bytesWritten` getter on `M3LListExporterStreamWriter`, across
   `M3LJSONListExporter`/`M3LCSVListExporter`/`internal/{writeStreamLifecycle,baseListExporter}`.
2. `fix(m3l-common)` — a durability guard rejecting a `resumeFromByte` that
   exceeds the target file's actual on-disk size.
3. `fix(dynamodb-crud)` — closed a **live, previously-shipped data-loss bug**
   (found while planning, not in the original issue): `dispatchScan`
   reopened its exporter at the same path on `--resume`, silently destroying
   prior output.
4. `fix(rds-data-sql)` — `query` (JSON, JSONL, and CSV — bootstrapped from
   the SQL result's own column metadata on the first page) and `load`'s
   `failed.jsonl` both switched to byte-offset resume.
5. `fix(cloudwatch-logs-insights)` — JSON/JSONL only; CSV output keeps full
   buffering as a documented scope boundary (log rows have no upfront schema
   to derive a column set from without an unbounded bootstrap buffer).
6. `docs` — ADR-0045, the F11 tracker row flip to Done (and a correction to
   its Source cell, which cited a work log that never actually mentioned
   this tradeoff), and a `3.0.0` → `3.1.0` minor bump.

Final state: `pnpm verify` — 37/37 applicable steps pass (3 skipped:
gitleaks, frozen-lockfile install, hub-drift — all environment/push-only
skips, not failures). Full workspace test suite green throughout (m3l-common
alone: 4369 → 4377 tests across the seam commits; `dynamodb-crud` 107,
`rds-data-sql` 189, `cloudwatch-logs-insights` 109 — all passing at each
commit boundary, independently re-verified by the hub rather than trusted
from spoke reports).

Skills used: none of the named skills directly (the session ran under an
already-approved plan-mode plan rather than `/implementing-submodules` or
`/implementing-scripts`, since it spanned one library submodule and three
existing scripts rather than a single new module) — `/writing-work-logs` for
this log.

Spoke incidents: 0 truncations / 0 stalls / roughly a dozen `SendMessage`-style
resumes in the loose sense that several fix-round dispatches were direct
continuations of a prior spoke's flagged follow-up (e.g. "route this to
test-author" call-outs) rather than literal `SendMessage` continuations of
the _same_ agent. Several spoke completion reports were visibly truncated
mid-sentence (e.g. "All green. Now re-check coverage-final.json..." with no
further detail) — every one was independently re-verified against the real
`git diff`/`vitest`/`typecheck` output before being trusted, and in each case
the underlying work was in fact complete and correct despite the truncated
report text.

## What went as planned

- **RED failed for the right reason at every one of the four adoption
  sites.** Every dispatch's RED phase produced type errors on not-yet-existing
  symbols (`resumeFromByte`, `outputBytes`, `createWriter`, etc.), never a
  test-logic defect — confirmed via independent `pnpm typecheck` before
  dispatching GREEN each time.
- **Full-workspace typecheck stayed green across every commit boundary**,
  including the three script adoptions that consume `m3l-common` via
  `workspace:*` — no drift between the library's evolving public surface and
  its consumers required a later catch-up fix.
- **The review-then-fix loop caught real bugs before commit, every time.**
  Three-spoke parallel review (code-reviewer, silent-failure-hunter, and
  security-reviewer or type-design-analyzer depending on the diff) on each
  of the four adoptions surfaced at least one genuine correctness or
  data-safety bug apiece — none of the four commits landed on the first
  implementation pass.
- **`code-implementer` correctly refused to touch test files at every
  boundary**, even when a dispatch prompt explicitly (and incorrectly) asked
  it to "add tests proving each fix" — it flagged the ask back to the hub
  instead of crossing its role boundary, three separate times.
- **Independent verification caught two under-reported/truncated spoke
  results** (the rds-data-sql GREEN's "156/158" being accurately reported vs.
  a later "All green" that was actually 2/108 failing) before they reached a
  commit — the hub's policy of never trusting a spoke's self-report without
  re-running the actual gate command paid for itself concretely, not just as
  a defensive habit.

## What didn't go as planned, and why

### 1. The RED-phase test-author for the library durability fix wrote tests without knowing the fix would break 5 existing mocked tests

Dispatching the `M3LWriteStreamLifecycle` size-guard fix directly to
`code-implementer` (skipping a separate RED phase, since the fix was small
and well-specified) meant the new `fs.statSync` call broke 5 pre-existing
tests that only mocked `fs.truncateSync` — `code-implementer` correctly
declined to fix them (out of its `src/`-only scope) and reported exactly
which five and why, but this cost a whole extra `test-author` round-trip
that a RED-phase-first ordering would have avoided.

**Why it happened:** Treating a "small, well-specified fix" as exempt from
the test-first ordering assumed the fix couldn't have side effects on
unrelated tests. It did — a new synchronous call inserted before an existing
mocked one, breaking every test whose mock only covered the original call.

**Fix for future:** Even a "surgical" fix to a well-tested module should get
a real RED-phase pass (or at minimum, `pnpm exec vitest run` against the
_existing_ suite before dispatching GREEN, to catch this class of breakage
before it's discovered mid-flight) rather than assuming its blast radius is
obvious from the fix description alone.

### 2. A GREEN-phase implementer's fix for one bug surfaced a second, more severe bug in the same function, caught only by the proving-test author _(promoted → .claude/agents/test-author.md)_

Fixing `run-query.ts`'s close()-failure attribution (making a close() failure
after primary success propagate as a real error) required a `test.fails()`
regression test from `test-author`, who discovered while writing it that the
underlying `writer` variable was invisible to the `finally` block on a
different failure path entirely (a resumed run whose query itself failed
after the writer was already constructed) — a genuine resource leak, not
just a missed error-attribution case. `test-author` used `test.fails()` to
document the bug precisely rather than either silently weakening the test
or guessing at a fix outside its role.

**Why it happened:** The hub's fix-round dispatch specified the exact shape
of the `primaryFailed` tracking fix without independently re-deriving every
throw path through the two-function (`runResumedQuery`/`runFreshQuery`)
split — the leak was in a code path the fix touched but the dispatch prompt
didn't explicitly walk through.

**Fix for future:** When a fix-round dispatch names specific functions to
change, explicitly ask the implementer/test-author to trace _every_ throw
path through those functions, not just the one the finding's reproduction
steps exercise — a `test.fails()`-first discipline (write the regression
test, let it fail for a possibly-different reason than expected) surfaces
this class of adjacent bug before it ships, as it did here.

### 3. Two pre-existing tests in `cloudwatch-logs-insights` used the same default fixture (`format: "json"`) the streaming rewrite changed the meaning of, and the RED-phase dispatch didn't anticipate them

The RED-phase test-author added new tests for the JSON streaming contract
and two CSV-regression tests, but didn't scan for _existing_ tests whose
fixtures (`BASE_VALUES` defaulting to `format: "json"`) would now assert
stale behavior once GREEN landed. Both broke immediately after GREEN, purely
because they asserted the old batch-`exportResults` call that JSON format no
longer makes.

**Why it happened:** The RED-phase dispatch prompt asked for new tests
proving the new contract, but didn't explicitly instruct a sweep of the
existing suite for tests whose _default_ fixtures would silently start
exercising the changed code path.

**Fix for future:** When a change alters the default/common-case behavior of
an existing function (not just adds an opt-in), explicitly instruct the
RED-phase test-author to grep the existing suite for that function's name
and audit every call site's fixture against the new default, not just add
coverage for the new option.

### 4. A code-reviewer's judgment question surfaced a real bug the hub hadn't asked about

Asking code-reviewer to specifically judge whether `outputBytes`/`rowsExported`
needed the same co-occurrence enforcement as `rds-data-sql`'s established
pattern got the direct answer requested ("no, justified — it's reporting-only")
_and_ an unprompted, more serious finding: a checkpoint with populated `rows`
and no `outputBytes` (the exact shape the pre-fix code would have written)
silently drops those rows on resume — a real regression the RED/GREEN round
had test-locked-in as "intended" behavior without questioning the fixture's
realism.

**Why it happened:** The hub's own comparison-question framing anchored on
the field pair it already suspected (`outputBytes`/`rowsExported`) rather
than asking the reviewer to independently scan for _any_ unenforced
co-occurrence hazard in the diff — the actual hazard was a different field
pair (`rows`/`outputBytes`) the framing didn't mention.

**Fix for future:** A targeted "is this specific asymmetry justified"
question is good for getting a fast, confident answer, but should be paired
with (or followed by) an open "scan this diff for any other unenforced
invariant in the same family" ask — the specific framing can anchor a
reviewer away from an adjacent, unprompted finding.

## Lessons learned

- **A byte-offset/checkpoint-field pair needs co-occurrence validation, not
  independent-optional validation, whenever a legacy or format-mismatched
  checkpoint could plausibly carry one without the other.** This recurred
  identically across `rds-data-sql` (`offset`⟺`outputBytes`) and
  `cloudwatch-logs-insights` (`rows`⟺`outputBytes`) — in both cases a
  checkpoint written by the pre-fix code, or by a different code path, could
  satisfy an independently-optional validator while silently resuming from
  the wrong point. _(promoted → .claude/rules/scripts.md)_
- **`fs.WriteStream`'s write callback firing is not proof of durability** —
  it fires once the OS accepts a write, not once it's flushed to disk. Any
  design that persists a byte offset as a resume point (not just this one)
  needs a size-reconciliation guard before trusting that offset against the
  real file, or an unclean shutdown can silently corrupt the resumed file's
  tail with NUL padding rather than failing loud.
- **A "small, well-specified" fix to a well-tested module still needs its
  blast radius checked against the existing suite before GREEN, not just a
  RED-phase pass for genuinely new behavior.** A synchronous call inserted
  ahead of an existing one broke five unrelated tests whose mocks didn't
  anticipate the new call order.
- **`test.fails()` is the right tool for "the test-author found a bug outside
  their role to fix."** Using it (rather than silently weakening the
  assertion or guessing at an out-of-scope fix) kept the suite green while
  making the gap impossible to miss — it showed up as an XPASS the moment
  the real fix landed, which is exactly the signal needed to know the fix
  round was complete. _(promoted → .claude/agents/test-author.md)_
- **Independently re-run the actual gate command before trusting any spoke's
  self-reported "all green."** This session's spoke reports were visibly
  truncated multiple times, and in one case a truncated "All green" was
  actually 2/108 failing — the fix was already correct in every case, but
  only independent verification caught the discrepancy before it reached a
  commit. Not promoted here — already thoroughly captured, with prior
  examples, at `docs/contributing/subagent-context-management.md`
  ("treat any truncated spoke return as 'state unknown'").
- **A targeted review question ("is X justified?") should be paired with an
  open scan of the same diff for the same _class_ of issue**, not just the
  specific instance named in the question — the most severe finding in this
  session's cloudwatch-logs-insights review round was an unprompted
  discovery adjacent to, but distinct from, the specific question asked.
