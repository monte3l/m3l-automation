# A6 — Per-phase pipeline trace + aggregate option validation (issue #473)

**Date:** 2026-08-20
**Item:** A6 of the codified-procedure-engine wave (P0) — the last open Wave A item
**Decision of record:** [ADR-0035's 2026-07-23 allowlist update](../adr/0035-failure-reporting-and-diagnostics.md); [ADR-0046](../adr/0046-codified-procedure-engine.md)
**Contract:** `docs/plans/2026-08-18-codified-procedure-engine.md:174-195`

## What shipped

`M3LOperationPipeline` ran eleven phases while recording nothing — no timing, no
phase record — even though `M3LBreadcrumbTrail` and the run report's `timeline`
were already built and wired. And `validatePipelineOptions` threw on the first of
its three checks, so three malformed options cost three fix-and-rerun cycles.

Two modules, library-only:

- **`core/pipeline`** — an opt-in `trace` option: a `record()`-shaped sink
  (`M3LPipelineTraceSink`) plus a `describe(phase, snapshot)` callback invoked at
  each phase's entry, with the entry recorded at exit once `durationMs` is known.
  9 exports → **13**.
- **`internal/pipeline`** — new `trace.ts`; `validate.ts` rewritten to aggregate
  every problem into one throw under `context.problems`, each with its own code,
  while the thrown `code` stays `ERR_PIPELINE_INVALID_OPTION` so existing narrows
  keep working.
- **`core/diagnostics`** — a 20th breadcrumb summarizer for `pipeline:phase`.
- **`core/errors`** — three per-problem codes in `M3L_ERROR_CODES` **and**
  `M3L_ERROR_CATALOG`.

Version 4.2.0 → **4.3.0** (MINOR; all additive). `check:api` did not move — every
new type is barrel-surfaced, not an `exports`-map subpath. Pipeline suite 110 →
**155**; workspace 7288 → **7301**. Reference index 635 → **636** symbols.

## What went as planned

- **Docs-contract-first worked again.** Writing the reference contract before any
  code gave the RED spokes one pinned spec; neither had to ask what a clause meant.
- **`check:api` stayed put**, as predicted.
- **The two registry edits were caught by planning, not by a failing gate.**
  `errors.test.ts` holds a _symmetric_ drift check whose regex sees a
  `code: "ERR_…"` literal anywhere in `src/**`, plus a second test requiring every
  registered code to classify. Reading the guard before designing the change meant
  `catalog.ts` was in the brief from the start — the plan had named only
  `M3LError.ts`.

## What diverged

### 1. The authored contract had rotted in two places

The issue body and wave plan both described `M3LOperationPipelineOutcome` as
`{operation, status, result}` and the run as a "ten-phase order". A3 (PR #484) had
already made the outcome a three-arm discriminated union and added phase 10
(`recovery`), making it eleven. Neither error changed the work, but both were
stated as current fact in a P0 issue one day old.

**Lesson:** the re-derive rule earns its place on a _one-day-old_ issue, not just
an aged one. A derived tracker row freezes the moment it is authored; the code
moves the next day.

### 2. The authored `describe` signature was uncallable

The plan specified `describe: (operation, settings, context) => …` invoked "at
phase entry". Those two clauses are incompatible: at the entry of `accessor`,
`operation` and `settings` do not exist yet, and the `operation` phase is itself
what resolves `operation`. Shipped as `(phase, snapshot)` with a partial snapshot,
which keeps "one entry per phase" literally true.

The same plan called `trace` "an `M3LBreadcrumbSource`-compatible **sink**" —
self-contradictory, since `M3LBreadcrumbSource` is the `on`/`off` _subscribe_
interface. Resolved as a `record()`-shaped sink.

**Lesson:** a contract clause can be individually plausible and jointly
impossible. Check the conjunction against the code's actual state ordering before
treating a signature as settled.

### 3. Three reviewers read the guard and called it sound; two that executed broke it _(promoted → .claude/rules/subagent-dispatch.md)_

The critical defect: `safeDescribe` guarded the _call_ to `describe`, but the
returned object's property reads happened later during payload assembly, outside
any `try`. A `describe` returning `{ get bucket() { throw } }` — type-legal, no
cast needed — therefore threw unguarded, and could

- reject a run whose handler had **succeeded**, with a bare `TypeError`; and
- **replace a real handler failure**, because the catch path recorded a second
  time with the same hostile payload and that throw pre-empted the rethrow.

One probe deleted 997 objects, then rejected with `persist`/`finalize` never
running — precisely the outcome the partial-run contract exists to prevent.

`code-reviewer`, `type-design-analyzer` and `spec-conformance-reviewer` all
examined these lines and reported the guard correct. `silent-failure-hunter` and
`security-reviewer` both found it, independently, by running probes against built
`dist/`. That is **five for five** for execution-based passes against this repo's
diagnostics surface.

**Lesson:** for a guard, "I read it and the `try` covers the call" is not a
finding about behavior. The question is _when the property is read_, and only
execution answers it. `core/diagnostics/breadcrumbs.ts` already had the right
shape — wrapping its whole summarize/redact sequence, not just the emit — and the
new code did not follow the precedent sitting next to it.

### 4. My own withhold-the-message design was half a fix

I specified the tracing-failure warning to log the error's `name`/`code` but never
its `message`, because a message can embed caller data. `name` and `code` are
_equally_ caller-controlled. A probe planted a secret in `error.name` and
recovered it verbatim from `run.log`; nothing downstream redacts. Now: no
`message`, no `stack`, no `name`, and `code` only when it is a member of
`M3L_ERROR_CODES` — an allowlist, so a caller-invented code renders
`unclassified`.

**Lesson:** "withhold the obviously dangerous field" is a denylist. Enumerating
three fields and reasoning about one of them is the same mistake at smaller scale.

### 5. Two documentation over-claims, one written while fixing the other

- I corrected the snapshot/payload asymmetry for `operation`, and in the same
  edit wrote that it is omitted "**only**" for `accessor`. False: a _failing_
  `operation` phase never resolved one either. `spec-conformance-reviewer` caught
  it.
- "Pinned to `M3LBreadcrumbScalar` per ADR-0035's allowlist evidence" implied
  runtime enforcement that did not exist — a bare sink received nested objects
  **by reference**, so a later caller mutation changed what a deferred sink
  serialized. Rather than soften the sentence, the pin is now enforced at run
  time, which is what ADR-0035's own allowlist-not-denylist lesson demands.
- `M3LBreadcrumbTrail`'s class TSDoc promised a secret "can never reach the
  trail". True for library-emitted events with named-field summarizers; false for
  the caller-authored keys `pipeline:phase` now carries. Rewritten as best effort
  for that case.

**Lesson:** an absolute ("only", "never", "can never") is the highest-risk word in
a contract page. Adding one while fixing an adjacent error is easy, because
attention is on the clause being corrected, not the qualifier being introduced.

### 6. Count claims in `implementation-status.md` rot silently

The pipeline row said "8 exports" and "110 tests, 100% cov on all 3
implementation files". All three were stale or became false: A3 had added a 9th
export without updating the row, and A6's new code left `M3LOperationPipeline.ts`
at 100/101 statements. Only the test count is machine-checked
(`check:test-counts`); the export count and the coverage claim are prose.

Separately, `breadcrumbs.ts` carried "19 built-in summarizers" in one TSDoc site
and "17-event registry" in another — A5 updated one and missed the other.

**Lesson:** a hand-maintained count with no gate behind it is a claim with a
short half-life. Measure before repeating one; `coverage-final.json`, not the v8
text reporter, is the source of truth for per-file coverage.

### 7. `pnpm lint` alone gives a false green before committing

The first commit attempt was rejected: the `pre-commit` hook runs **Prettier
before ESLint**, and Prettier's reformatting pushed `run()` from 60 to 64 lines,
re-tripping `max-lines-per-function`. `pnpm lint` had passed moments earlier
because it measured unformatted source.

**Lesson:** verify in the hook's order — `prettier --write`, _then_ `eslint`.
Every spoke brief in this task carried that instruction after the first failure,
and none hit it again.

### 8. Subagent truncation, seven times

Seven spokes truncated mid-turn — the repo's most-recurring divergence, matching
A3's five. Every one was recovered by resuming with "you stopped at X, continue"
rather than restarting. Three had already finished their real work and truncated
during _self-verification_; for those, running the gates from the hub was faster
than resuming, and gave a result I had verified myself rather than been told.

**Lesson:** when a spoke truncates, check whether what remains is work or
verification. Verification is cheaper to do than to delegate again.

### 9. A near-vacuous security test, avoided by one observation _(promoted → .claude/rules/tests.md)_

The dangerous-key test would have passed for the wrong reason: a literal
`__proto__:` key in an object literal sets the created object's prototype instead
of producing an enumerable own property, so `Object.keys` never sees it and the
guard's branch stays unexercised. The spoke used computed keys instead.

The non-vacuity of the whole regression set was then proven by **reverting the
fix**: 10 tests fail without it, 155 pass with it.

**Lesson:** for a guard test, prove the test fails without the guard. This repo
has shipped three security tests that passed vacuously; a revert-and-run is cheap
and settles it.

## Follow-ups filed

Filed as F-rows in [`docs/plans/IMPLEMENTATION.md`](../plans/IMPLEMENTATION.md)
§"Library friction (F-series)". Each was re-derived against `main` before
filing, and two of them did not survive that re-derivation unchanged.

- **F19 — `run()`'s state threading.** The extraction that cleared the 60-line
  cap uses `setOperation`/`setSettings`/`setContext` writeback callbacks into
  `run()`'s frame. `operation`/`settings` already flow as real return values, so
  those two setters are redundant; `context` is returned in `prepared.context`
  then discarded and smuggled via `setContext`. Threading `context` as an
  explicit parameter would delete the whole mechanism. Deliberately deferred: a
  structural refactor of the path just hardened against a critical defect does
  not belong in the same change set. The 155 proven tests make it safe to do
  next.
- **F20 — the declared-secrets redaction port is dead in production.** Filed
  **wider than this log first recorded it.** The claim here was that
  `M3LBreadcrumbTrail` alone cannot honor a declared-secrets specifier. Checking
  every call site shows `redactSensitiveLogValue` is called with no options by
  _all four_ production sinks — `breadcrumbs.ts:764`,
  `internal/script/diagnostics.ts:62`, `run-report.ts` and `format-error.ts` —
  so `M3LRedactOptions.secrets` has no production consumer at all and is
  exercised only by `tests/logging.test.ts`. Raised to the `Next` tier on that basis.
- **F21 — one dead branch and one untested branch, not "two unreachable
  defensive branches".** This log's original framing was half wrong, and
  `coverage-final.json` is what settled it. `validate.ts:61`'s `?? 0` is
  genuinely unreachable — the map is built from the same array the loop
  re-iterates — and should be deleted. But `M3LOperationPipeline.ts:572-574`'s
  `: {}` arm is perfectly **reachable**: `target`, `isSensitiveTarget` and
  `yesSensitive` are independently optional, so a config declaring `target` and
  omitting both predicates is type-legal, and no test covers it. That one needs
  a test, not a deletion — the opposite fix. Both sit above the `branches: 80`
  floor (95.00% and 97.73%), so no gate would ever have raised them.
- **F22 — `toMatchTypeOf` is deprecated in Vitest 4** and used throughout the
  suite: 190 occurrences across 32 test files on `vitest@4.1.10`. Repo-wide, not
  A6's to fix.

**Lesson, added on filing.** Writing "Follow-ups filed" is not filing them.
These four sat in this section alone until #473 was closed out, unreachable by
`sync:hub` and invisible on the board — while A1b–A5b, filed as rows, each got
an issue automatically. A follow-up that lives only in a work log is a follow-up
that does not exist. And re-deriving them at filing time changed two of the
four: one was materially wider than recorded, and one had the wrong fix
attached. _(promoted → .claude/skills/writing-work-logs/SKILL.md)_
