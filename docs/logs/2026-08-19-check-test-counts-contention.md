# Work log — check:test-counts contention (F15) (2026-08-19)

This log covers issue #489 / F15 — the intermittent `check:test-counts` failure
in the `pre-push` lane and in `pnpm verify`. It ran through the hub-and-spoke
model (hub writes `bin/**` and `lefthook.yml`, `test-author` writes
`bin/tests/**`), and records what shipped, what matched the plan, what diverged,
and the durable lessons.

## Summary

The gate existed only to confirm that the "N tests" phrases in
`docs/implementation-status.md` match reality. To get those numbers it spawned a
**full Vitest execution** of all 4 825 tests under `packages/m3l-common/tests`
and counted `assertionResults`. Executing the suite was incidental to counting
it — and it was the entire source of the flake.

What shipped:

- `bin/check-test-counts.mjs` now uses Vitest's **collection** pass
  (`vitest list --json=<tmpfile>`). Collection imports each test file and expands
  `describe`/`test.each` exactly as a real run does, so the counts are identical,
  but no test body executes.
- The report is written to a temp file (`mkdtempSync`, removed in a `finally`)
  instead of piped through a 10 MB `maxBuffer` that a 1.7 MB-and-growing payload
  was on course to exceed.
- `lefthook.yml` chains the check onto the `test` lane
  (`pnpm test:coverage && pnpm check:test-counts`) rather than running it as a
  concurrent sibling lane.
- Failure diagnostics now report exit code, `signal`, `error`, and tails of
  **both** stderr and stdout — replacing "fix failing tests before checking
  counts", which named the one cause this step can no longer have.
- The script was split into pure helpers behind a `process.argv[1]` main guard
  and gained its first tests: 45 in `bin/tests/check-test-counts.test.ts`,
  taking the file from 0 % coverage to 100 % of functions and 80 % of branches.

## What went as planned

- **`vitest list` is count-identical to `vitest run`.** Measured before writing
  any code: 54 files, 4 825 tests, and all 41 recorded rows matched with zero
  mismatches.
- **`check:cadence` stayed green with no `CLAUDE.md` edit.** `parseLefthookStages`
  unions `extractRunTokens` over _every_ `run:` in a stage into one `Set`, so
  folding two commands into one lane leaves the `pre-push` token set unchanged.
  Reading the gate's source before designing around it made this a non-event.
- **The lane restructure cost no wall-clock.** The collection pass is ~5 s against
  `lint`'s ~26 s, so the `test` lane stays well off the critical path.

## What didn't go as planned, and why

### 1. The filed issue's root-cause claim was half wrong

F15 stated that `pnpm verify` runs `check-test-counts` concurrently with the test
step. It does not: `bin/verify-all.mjs` runs `VERIFY_STEPS` **sequentially** via
`spawnSync` with `stdio: "inherit"`. The source work log was actually precise —
it said three "**back-to-back**" full suite runs — and the F15 row upgraded
"back-to-back" to "concurrently" when it was filed.

**Why it matters:** a fix scoped to the stated cause (serialize the lefthook
lane) would have left the `verify` failure mode completely untouched, and would
have looked like a fix. The real common factor across both failure sites was
_running the suite at all just to count it_.

**Fix for future:** already covered by the standing rule to re-derive an
authored claim before acting on it. The new wrinkle: when a tracker row and its
source work log disagree, the **log** is the primary source — the row is a
summary written later, and summarising is where the drift entered.

### 2. `--staticParse` looked like the obvious win and was wrong

`vitest list --staticParse` collects without importing anything: 2.6 s wall and
3.4 s CPU, versus 5.5 s / 22 s for real collection. It was the first thing tried.

It counts a `test.each` **template as one test**, so it undercounted 30 of the 41
recorded rows — `clients` 278 → 117, `logging` 237 → 171. Adopting it would have
meant rewriting every recorded count to mean "test declarations" instead of "test
cases", silently changing what the gate asserts.

**Fix for future:** when swapping the oracle a gate measures with, diff the new
oracle against the old across **every** row before adopting it, not a sample. The
sample here (`M3LConfigAccessor`, 56 = 56) would have passed.

### 3. `--json` silently ate the path filter

`vitest list --json packages/m3l-common/tests` fails with
`EISDIR: illegal operation on a directory, open '.../packages/m3l-common/tests'`.
`--json` takes an _optional_ value, so cac consumed the following positional as
the output path and Vitest tried to write the report onto the filter directory.
The bare-flag form also, on the second attempt, wrote a 1.2 MB file literally
named `true` into the repo root.

**Fix for future:** an optional-value CLI flag immediately before a positional is
a trap. Pass the explicit `--flag=value` form. Here it was a free win anyway —
writing the report to a real temp file is what retires the `maxBuffer` ceiling.

### 4. One repro attempt did not reproduce it

Running `test:coverage` + `lint` + `typecheck` + `check:test-counts` concurrently
— the pre-push shape — passed all four lanes. The box has 14 cores but only ~9 GB
free, and three concurrent suites can fan out to ~42 worker processes, so memory
exhaustion remains the leading hypothesis; a non-null `signal` in the new
diagnostics will confirm or refute it the next time it happens.

**Fix for future:** a rare race that will not reproduce on demand is still
actionable — remove the redundant work and make the residual failure legible,
rather than blocking on a reproducer.

### 5. Testing the change exposed a wrong JSDoc type of my own

`countsByFile` was annotated `@param {Array<{ file?: string }>}` while the body
does `collected ?? []`. The spoke's test for the `undefined` case failed to
typecheck against the annotation. This is the _same_ defect class as divergence 4
in `docs/logs/2026-08-19-hub-sync-key-namespace.md`, one day earlier: a JSDoc
type in `bin/**/*.mjs` that no gate checks, wrong until a `.ts` test consumed it.

Worth recording plainly: **`pnpm typecheck` does not cover `bin/tests/`.** It is
turbo-driven per package, and no package includes that tree, so type errors there
are visible to an editor but gated by nothing. `bin/tests/project-hub.test.ts`
carries pre-existing diagnostics for this reason. Not fixed here — out of scope
for F15 — but it is the reason a spoke can honestly report "typecheck clean".

That gap then bit a **second time in this same session**, after being written
down. The spoke's `collectTests` tests landed with six `TS2339`s: `collectTests`
returns the discriminated union `{ ok: true, collected } | { ok: false, message }`,
and the tests read `.message` without narrowing on `.ok` first. Tests passed,
`lint` passed, `prettier` passed — the three gates that exist — and the type
errors were invisible to all of them. Caught only by running `tsc` against the
file by hand.

**Fix for future:** when a spoke writes into a tree no gate typechecks, run `tsc`
over that file explicitly before accepting the work. "Tests pass and lint is
clean" is not the same claim as "this compiles", and in `bin/tests/` nothing
makes the second claim for you. The durable fix is to bring `bin/tests/` under a
typecheck project — worth filing, but not in this change's scope.

### 6. The review round found the fix reproducing its own defect class

`code-reviewer` and `silent-failure-hunter` ran in parallel over the finished
change. Neither found a correctness bug in the counting, but the hunter found
four ways the rewrite could still report the **wrong cause** — the exact thing
F15 was filed about:

- `mkdtempSync` sat outside the `try`, so a full temp partition produced a raw
  Node stack trace instead of a diagnostic.
- `rmSync` in the `finally` could throw and **replace** the already-computed
  return value, discarding the vitest diagnostic in favour of a cleanup error.
- A spawn failure (`status: null`, `error` set) led with `(exit null)` and buried
  the real ENOENT on the next line.
- The bare `catch {}` around `docs/implementation-status.md` dropped the OS error,
  so ENOENT and EACCES read identically.

All four are fixed. A fifth — `countsByFile` throwing a bare "not iterable"
TypeError if the report ever parsed to a non-array — was found independently by
me and by the hunter, and is now an explicit format-changed error.

The two reviewers **disagreed** on the temp-file lifecycle: `code-reviewer` said
"cleanup is guaranteed on every path" and stopped there, which is true and not the
question. The hunter asked whether cleanup could _mask_, which is where the two
real findings were.

**Fix for future:** "is the cleanup guaranteed to run" and "can the cleanup
destroy the error being reported" are different questions, and `finally` is where
they diverge. Running both reviewers in parallel is what surfaced it; either one
alone would have missed half.

## Lessons learned

- **When a tracker row and its source log disagree, believe the log.** The row is
  a later summary, and summarising is where "back-to-back" became "concurrently".
  Half a root cause produces a fix that looks complete and isn't.

- **A gate should measure the cheapest thing that answers its question.** This one
  executed 4 825 tests to learn how many tests there were. The flake was a
  symptom; the redundant work was the defect, and removing it fixed both failure
  sites at once — including the sequential one that concurrency could not explain.

- **Diff a replacement oracle across every row, not a sample.** `--staticParse`
  agreed with the old numbers on the first file checked and disagreed on 30 of 41.

- **An error message that names a cause is a claim.** "Fix failing tests" was
  wrong every time it printed, and it cost two investigations. If the code cannot
  know the cause, it should report what it observed — exit code, signal, the
  child's own output — and let the reader conclude.

- **"Tests pass, lint is clean" is not "this compiles."** In a tree no typecheck
  project covers, those are three separate claims and only two of them have a
  gate. The same blind spot produced a wrong JSDoc type and six unnarrowed-union
  errors in one session — and it will keep producing them until `bin/tests/` is
  typechecked by something.

- **A `finally` that can throw is an error-reporting bug, not a cleanup bug.** It
  silently replaces the result the `try` already computed. When the thing being
  reported _is_ a diagnostic, that turns a good error message into a wrong one —
  which is how this fix nearly shipped a second instance of the defect it closed.
