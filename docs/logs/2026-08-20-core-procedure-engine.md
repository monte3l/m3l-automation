# 2026-08-20 — `core/procedure`, the codified-procedure engine (B2, issue #474)

ADR-0046's engine: a multi-step procedure whose control flow and conclusions are
declared data rather than hand-written branching. Tracker item **B2**, the last
open `Now` item of the codified-procedure wave. Additive minor, `4.3.0 → 4.4.0`.

## What shipped

|                |                                                                                                                       |
| -------------- | --------------------------------------------------------------------------------------------------------------------- |
| Public surface | 44 exports through the Core namespace barrel; `check:api` did not move                                                |
| Implementation | ~5 200 lines across `core/procedure/` (5 files) and `internal/procedure/` (10)                                        |
| Tests          | 330 across four files — 58 engine / 94 build-time validation / 99 condition algebra / 79 guards, tracing, adversarial |
| Counts         | Core 22 → 23, total 41 → 42, implemented 41 → 42                                                                      |
| Error codes    | 16 new `ERR_PROCEDURE_*`, all `{ origin: "caller", retryable: false }`                                                |
| Full suite     | 7 629 passing, 185 files; coverage gate exits 0                                                                       |

Also closed an ADR-0046 claim that was simply false: it asserted the `aws/**`
import ban was "enforced by the existing ESLint zones and `pnpm check:zones`".
It was not — the only zone `from:` paths were `src/internal`, `src/core` (the
aws island, `aws → core`) and `src/core/script`. The missing `core → aws` zone
now exists, with a `requireZone` assertion so deleting it fails CI rather than
silently passing lint.

## What went as planned

Writing the contract page before any code, then deriving RED from it. That is
the A6 precedent and it paid for itself three times over (below). The
hub-and-spoke split held: the hub never wrote `src/` or tests, and the
writer≠reviewer separation caught things no self-review would have.

## What diverged

### 1. Writer dispatches truncated 12 times; two produced nothing at all

Every writer spoke on this module truncated at least once. Two — a GREEN pass
and its first retry — burned 327k and 136k tokens and wrote **zero lines**.

The cause was **input** size, not output size. After the RED truncations I split
work by concern and bounded what each spoke had to _produce_, but every brief
still said "read `docs/reference/core/procedure.md` in full". That page grew from
~1 200 to ~1 450 lines across six revisions **that I made during the task**, so
each fix I committed made the next dispatch more likely to fail. Adding
`M3LProcedure.ts` (1 441 lines) and the guards test file (1 919) put several
briefs over budget before the spoke could write anything.

What worked, on the third attempt at the same task: **read the target myself and
hand over a diff-shaped instruction** — one named file, requirements extracted
inline, insertion point named, and an explicit "do not open these two files".
Same model, same task, and it landed.

**Durable lesson:** a spoke brief should carry _extracted requirements_, not a
pointer to a living document. Bounding output is not enough; bound input too,
and treat a doc you are actively revising as the most expensive thing in the
prompt. This extends `.claude/rules/subagent-dispatch.md`, which currently
covers output decomposition only.

### 2. Writing tests first found three holes in the contract that reading the ADR never would

- **`parameters()` did not exist.** Four documented behaviours needed the
  declared parameter names _at run time_ — the digest projection,
  `ERR_PROCEDURE_UNKNOWN_REFERENCE` for a parameter, `run()`'s undeclared-key
  rejection, and the empty/duplicate-name check. `TShape["parameters"]` is a
  type, and types are erased. A RED spoke could not write the test and traced
  the cause.
- **`ERR_PROCEDURE_UNKNOWN_REFERENCE` could not cover a `value` reference.** A
  step's `values` patch is produced inside its `execute` body at run time, so
  there is no declared key set to check — and unlike `parameters`, a builder
  declaration would not help, because the question is not "which keys were
  declared" but "which keys will any step produce". Narrowed to step and
  parameter references.
- **A malformed `matches` pattern was indistinguishable from a no-match.**

### 3. Six-spoke review found 13 must-fixes, several being documented guarantees that were never delivered

The sharpest ones, all in code that was green and passing 330 tests:

- `outcome.trace` — documented, typed, exported, and hardcoded `[]` in all three
  outcome builders; `M3LProcedureTraceEntry` was constructed nowhere in `src/`.
  The only test was `expect(Array.isArray(outcome.trace)).toBe(true)`, which is
  vacuously true for `[]` — the "test that can no longer fail" pattern
  `tests.md` warns about.
- `ERR_PROCEDURE_UNDECLARED_JUMP` — documented in three places, absent from
  `src/`, while `#interpretFlow` did `index: target ?? index + 1` and silently
  advanced.
- `TJump` was inferred from `execute`'s return type as well as `jumpsTo`, so
  **both** `goTo` compile guarantees were void. Combined with the missing
  runtime guard, an undeclared jump was caught by neither the compiler nor the
  engine — and it is also a back edge the cycle DFS never sees.
- The built definition was forgeable with **no cast**: all five fields are
  public exports, so `new M3LProcedure({…})` bypassed every `build()` invariant.
- The raw caller graph was read twice, so a getter could differ between reads.

### 4. Three spokes caught flaws in instructions I wrote

Worth recording because it is the writer≠reviewer split working in the
direction people forget:

- My `unique symbol` witness for the unforgeable definition was unwritable by
  `build()` too, since a module-private symbol is private to _its module_.
- `declare const kBuilt: unique symbol` has **no runtime value**, so
  `[kBuilt]: true` would have thrown `ReferenceError` — it would have compiled
  and then failed at run time.
- I told the type reviewer the requiredness predicate tested the value type; it
  measured that the shipped code tested `keyof`. My own doc fix had never been
  applied to `types.ts`, and it stayed invisible because every example used
  `Record<never, never>`, which behaves identically under both forms.

### 5. Fixtures encoding wrong premises — four of them

Each looked right and had a wrong _setup_, and in every case the implementation
was correct:

- `alsoMatched reflects only the concluding pass` had the first `resolve` pass
  match, and a matching `resolve` terminates the run by contract.
- `the witness is sampled exactly once per continuing step` asserted 2, with a
  comment calling a `"stop"` step "continuing".
- The undeclared-parameter-key test **passed for the wrong reason**: its fixture
  declared no names, so every key was undeclared and the throw was not
  attributable to the excess key the test names. It would have passed with no
  excess-key check at all.
- The abort-vs-stall race aborted one execution _past_ the trip, so no race
  occurred; it only ever passed because of a `Math.max(n-1, 2)` off-by-one.

**Durable lesson:** when a test fails after a behaviour change, read its
_fixture_ before assuming the assertion is stale — and when a fixture depends on
a numeric relationship, state the coupling in a comment. Three of these four
were silent dependencies on values elsewhere in the same test.

### 6. A correct refactor defeated a correct guard

`errors.test.ts` scans `src/**` as **text** for `code: "ERR_…"` and asserts the
result is exactly `M3L_ERROR_CODES`. A `problem()` combinator extracted during
the review round removed real duplication — but it was _positional_, so call
sites became `problem("ERR_…", …)` and all ten per-problem codes went invisible
to the scanner while still being emitted at run time. Fixed by switching to a
named-object argument so `code: "ERR_…"` is literal at each site.

The guard caught three distinct problems in this module: codes registered ahead
of their emitters, an emitter with no registration, and emitters invisible to the
scan. Worth knowing that a refactor which is right by every other measure can
still break it — and that the fix direction is to make the source match the
guard, never to loosen the scan.

### 7. Splitting the iteration ceiling out of the run loop caused an OOM

I scoped the runtime guards to a later pass than the loop itself, so for one
commit the engine had no `maxIterations` handling while the guards test file
built deliberately unbounded loops. `procedure-guards.test.ts` exhausted the
heap rather than reporting a count. The ceiling belongs _with_ the loop whose
termination it governs, not grouped with the other guards.

## Durable lessons

1. **Bound spoke input, not just output.** Extract requirements into the brief;
   never point a spoke at a document you are still revising.
2. **A contract revised during implementation needs its own verification pass.**
   Six revisions left eight stale claims — a broken flagship example, two
   invented mechanisms, a field that never existed. Only the spec-conformance
   spoke checked prose against code.
3. **Read the fixture before believing the assertion.** Four fixtures encoded
   wrong premises; the implementation was right every time.
4. **Verify every gate yourself after every wave.** Two spokes reported green
   truthfully having run only the procedure suites; the registry drift was
   outside what they checked.
5. **A "no change needed" report backed by evidence is a good outcome.** One
   spoke declined to add a check that already existed and proved it with a
   passing sibling test plus a reverted instrumentation probe.
6. **Delete unreachable branches rather than testing them.** Both coverage
   failures were dead code, not missing tests.

## Follow-ups worth filing

- **Phase 1 seam.** `M3LProcedure.ts` is 1 441 lines and its phase-1 helpers
  touch only `#steps`/`#stepIndexById` — extractable to
  `internal/procedure/run-steps.ts`, matching the existing `context`/`evaluate`/
  `trace` split.
- **`M3LProcedureShape`'s widest inhabitant.** A shape that forgets to narrow
  `stepId`/`caseId` degrades to zero checking with no diagnostic.
- **`M3LProcedureConditionEvaluation` is a flat bag** mirroring a discriminated
  union; the coupling between `references` and `operands` is prose-only.
- **`flow.goTo` is still read twice** — the engine routes on it, the tracer
  re-reads it. The engine should project once and pass the string.
- **`.claude/rules/subagent-dispatch.md`** should gain the input-bounding rule
  from lesson 1.

## Links

- ADR-0046 (the decision), ADR-0039 (determinism, string-only parsing),
  ADR-0035 (allowlisted trace payloads), ADR-0049 (the cancellation signal)
- Plan: `docs/plans/2026-08-18-codified-procedure-engine.md`
- Contract: `docs/reference/core/procedure.md`
- Next: **B3 / W7** — `cloudwatch-logs-analysis`, the named consumer (issue #466)
