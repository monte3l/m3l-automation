# A3 — Degraded runs as a first-class outcome (issue #470)

**Date:** 2026-08-19
**Item:** A3 of the codified-procedure-engine wave (P0)
**Decision of record:** [ADR-0035's 2026-08-18 Update](../adr/0035-failure-reporting-and-diagnostics.md#update-2026-08-18--a-partial-run-outcome-and-cancellation-that-reaches-interrupted); mandatory-fallback discipline from [ADR-0046](../adr/0046-codified-procedure-engine.md)
**Contract:** `docs/plans/2026-08-18-codified-procedure-engine.md:116-140`

## What shipped

A run that processed 997 of 1000 records and one that processed 0 both
reported `failure`. The difference survived only inside each script's private
result shape — `dynamodb-crud` wrote a `failed.jsonl` nothing above it read,
`s3-objects`' `finalize` threw whenever any key failed.

Four modules, library-only (the fleet retrofit is **A3b**):

- **`core/diagnostics`** — `M3LRunOutcome` gains `"partial"`; `M3LRunReport`
  gains a third arm carrying a non-empty `recovery` tuple plus `recoveryTotal`;
  `M3LRunRecoveryEntry` and `M3L_RECOVERY_LIMIT` (100); `PARTIAL` (6).
- **`core/pipeline`** — a phase-10 `recovery` callback; `"partial"` status; the
  outcome became a discriminated union over `M3LOperationPipelineOutcomeBase`.
- **`core/script`** — `reportRecovery()` plus `recovery`/`recoveryTotal`, and
  `runScript` resolving `partial` with exit 6 on the non-throwing path.
- **`core/analysis`** — `M3LThresholdVerdict`, applying the mandatory-fallback
  discipline so an empty rule set reports `no-rules` instead of a clean
  `breached: false`.

Version 3.2.0 → **4.0.0**. `check:api` did not move — both widened symbols are
barrel-surfaced, not `exports`-map subpaths. Reference index 626 → 630 symbols.
Workspace suite 7925 → **8045** across 217 files.

## What went as planned

- **Docs-contract-first worked.** Writing the four reference pages before any
  code gave four parallel RED spokes one pinned spec, and none of them had to
  ask what the contract meant.
- **The compile-time blast radius was exactly as scoped.** Every widening site
  was caught by a `never` exhaustiveness guard or an exact type pin. No
  `scripts/**` site switches on these unions, which is what made the
  library-only scope hold.
- **`check:api` stayed put**, as the plan predicted.

## What diverged

### 1. The plan shipped an inert capability

`runScript` hard-codes the non-throwing outcome (`run-script.ts:189`), so
nothing in a real run could produce `partial`. The approved plan had no
`core/script` seam — the arm would have shipped exactly as `interrupted` did
under A1, reachable only from a library test. Caught before implementation
started, and closed with `M3LScript.reportRecovery()`.

**Lesson:** when an item adds an outcome, ask _what produces it_ before asking
what represents it. A1b exists because that question went unasked once already.

### 2. Five review spokes found two defects that reading the code had missed

Both were confirmed by **executing probes against built `dist/`**, and one
reviewer noted that a reader had already pronounced the same lines sound.

- **A secret leak.** `recovery[].error` was embedded by reference — the only
  caller-supplied field in the run report reaching disk untreated. A probe
  planted six secrets and recovered all six verbatim, while the same secret
  through `failure.chain` was redacted.
- **Cross-run data bleed.** The recovery buffer was never reset per run, so a
  reused `M3LScript` reported a second, clean run as `partial`, exited 6, and
  carried the first run's caller data into its report. Worst on
  `createLambdaHandler`, where one instance serves a warm container's every
  invocation.

**Lesson:** the repo rule that a security claim must be _executed_, not read,
paid for itself again. Neither defect was visible by inspection.

### 3. Two documented guarantees were false when written

The contract asserted "partial with nothing recorded is unrepresentable" while
the type was `readonly M3LRunRecoveryEntry[]` — which admits `[]`. And the
non-partial arms never closed `recovery`/`recoveryTotal`, so
`{ outcome: "success", recovery: [entry] }` was representable via a variable
(fresh-literal excess-property checking hid it).

Both were **hub-written prose**. This is the same failure mode A2 logged: four
over-claims in one run, three written by the hub. The fix made the claims true
(non-empty tuple, closed arms) rather than softening them.

**Lesson:** an "if and only if" in a contract page is a type-level obligation.
If the type cannot express it, either change the type or do not claim it.

### 4. A fail-open derived type, invisible to the compiler

`M3LErrorExitCode` was `Exclude<M3LExitCode, SUCCESS | INTERRUPTED>`. Adding
`PARTIAL` to the registry silently widened it to `1|2|3|4|6` with **no compile
error anywhere** — `exitCodeForOrigin`'s narrower return stayed assignable. An
existing exact pin caught it; without that pin it would have shipped.

It is now derived additively (`as const satisfies`), so the _next_ registry
entry is inert until opted into. The subtraction form would have re-bitten A4,
A5 and B2, all of which touch this area.

**Lesson:** a public type derived by subtraction from a growing registry is
fail-open by construction. Prefer the additive list.

### 5. The fix round introduced a regression, as this repo's history predicts

`implementation-status.md` records that for `core/diagnostics`, four adversarial
refute passes all succeeded and **three of four fix rounds introduced
regressions**. This round was no exception: a truncated spoke's final edit
reverted `reportRecovery` to storing the caller's object, reopening the
mutation-after-call defect. The regression test caught it within one run.

Lint caught a third defect independently — the sanitizer's fallback would have
stringified a non-string as `"[object Object]"`, corrupting the very field it
exists to sanitize.

### 5b. The adversarial refute pass broke the fix — and was right to

The first fix round was reviewed by five confirmatory spokes and passed. A
**mandatory adversarial refute pass** then broke it, making four for four
against `core/diagnostics`.

What it found that five confirmatory reviews and the hub had all missed:

- **The allowlist covered four of seven fields.** `code`, `origin` and
  `retryable` were copied raw. `M3LSerializedError.code` is declared
  `readonly code?: string` — unbounded caller text reachable from a plain,
  type-checking call — and a planted secret in it reached disk verbatim,
  along with an arbitrary object, a `__proto__` data key, and an unscrubbed
  presigned-URL signature in `origin`.
- **The parity argument the fix rested on was false.** `failure.chain` never
  carries a caller-controlled `code`: `serializeErrorChain` drops it even when
  set on a real `Error`. So "recovery now matches failure" was not the safety
  argument it looked like.
- **The fix had introduced a fresh regression** — the degrade path began
  discarding an explicit `input.exitCode`, contradicting its documented
  "always wins".
- It independently caught the `pnpm build` failure below.

It also **confirmed the cross-run reset genuinely closed**, holding against
eight vectors including both `createLambdaHandler` invocations, a throwing
run, an aborted run, a dry run, and recording from `onCleanup`.

**Lesson:** a confirmatory review answers "does this look right?"; a refute
pass answers "can I break it?" Only the second one found either defect. On a
security-sensitive surface, the refute pass is not optional polish — it is the
step that works.

### 5c. `pnpm typecheck` cannot catch what `pnpm build` catches

The additive `as const satisfies` formulation for `M3LErrorExitCode` passed
`pnpm typecheck` and failed `pnpm build` with TS9010. `isolatedDeclarations` is
deliberately set only in `tsconfig.build.json`
(`tsconfig.base.json:20-23` documents why), so the two commands check
structurally different things. Verifying with typecheck alone pushed a broken
build to the pre-push gate.

The additive form could not satisfy both constraints — the const is pulled into
the emitted `.d.ts` by `typeof …[number]`, and any annotation broad enough to
write discards the literal inference. Resolved with the pinned-`Exclude` form
plus a compile-time pin, **verified to fire** by temporarily adding a dummy
registry code.

**Lesson:** for any change touching exported types, `pnpm build` is a distinct
gate from `pnpm typecheck`, not a slower version of it.

### 6. Three test defects, all passing vacuously

- Assertions built on `Extract<>` over an intersection-with-union resolved to
  `never`, so the subjects passed vacuously. **The control assertions caught
  it** — they were requested precisely for this, and they earned their keep.
  The cause is worth remembering: the third report arm's `outcome` is a
  three-literal union, so `Extract<…, { outcome: "success" }>` matches nothing.
- Three assertions on `origin` and `retryable` passed trivially: those fields
  are **omitted** when invalid rather than placeholder-substituted, so "the
  planted secret is absent" held regardless of whether validation worked at
  all. Positive gate tests now assert a valid `origin` and a real boolean
  `retryable` survive, so the tests can tell correct validation from blanket
  omission.
- The leak tests planted a **bare, context-free token**. This repo's redactor is
  pattern- and key-based (`key=value`, known key names, URL signatures), so
  neither `recovery[].error` _nor_ `failure.chain` catches that — verified by
  probe. The tests now plant secrets in covered forms and assert **parity with
  `failure.chain`**, which is the guarantee that actually matters. The residual
  free-text gap remains ADR-0035's item A7.

**Lesson:** a security test must assert the guarantee the library actually
makes. An over-claiming test that fails looks identical to a real leak, and
costs a full diagnostic round to tell apart.

### 7. Subagent truncation, five times

Five spokes truncated mid-turn — the repo's most-recurring build divergence.
Every one was recovered by resuming with a "you stopped at X, continue" message
rather than restarting, which preserved their context. One truncated spoke
misdiagnosed its own state ("Prettier seems to have changed test logic");
Prettier had done nothing — the implementation had changed underneath it.

## Follow-ups filed

- **A3b** — the fleet retrofit: `s3-objects` (delete-batch), `sqs-etl`,
  `dynamodb-crud`, `rds-data-sql`.
- `M3LThresholdRuleResult.breached` has the same conflation one level down: an
  empty `avg`/`min`/`max` column yields `actual: null` forced to
  `breached: false`, indistinguishable from a genuine pass. Out of A3's scope.
- Recovery entries are capped by **count**, not size; one entry can still be
  large. The refute pass wrote a **95 MB** `run-report.json` from 100 entries
  carrying 1 MB messages each.
- `M3LScript.recovery`'s snapshot protects the returned array and each entry's
  `error` array, but the `M3LSerializedError` elements are shared, so
  `recovery[0].error[0].message = …` still reaches stored state. The TSDoc is
  scoped accurately and does not over-claim, so this is a known limit rather
  than a false guarantee — but it is worth closing.
- `build()` applies no runtime narrowing to `outcome`, `correlationId` or
  `stage`, so a hostile `build({ outcome: "…" })` writes that string verbatim
  into the persisted `outcome`. Pre-existing, wider than A3.
