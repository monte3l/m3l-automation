# Work log — `aws/lambda` submodule (2026-07-18)

This log covers the `aws/lambda` submodule, implemented ad hoc mid-session on
branch `feat/lambda-ops` after starting work on the roadmap's W3 `lambda-ops`
script. It records what shipped, what matched the plan, what diverged, and the
durable lessons the implementation and its review fan-out surfaced.

## Summary

`lambda-ops` (roadmap W3) was scoped as "thin op-dispatch... existing getters
✓" — the same shape as the already-shipped W2 scripts. But unlike DynamoDB/SQS/
CloudWatch-Logs-Insights, Lambda had no typed operations wrapper: `AWSClientProvider.lambda`
(`packages/m3l-common/src/aws/clients/provider.ts:177`) returns the **raw**
`@aws-sdk/client-lambda` `LambdaClient`, and the ESLint zone under
`scripts/*/src/**` bans every `@aws-sdk/*` import (T6, `eslint.config.js:210-233`).
A script built on the raw getter alone could never actually issue an SDK
command. This was found via direct investigation (grepping the `clients`
provider and the `aws` barrel), not from a pre-written plan — the gap surfaced
mid-session, was confirmed with the user, and was resolved by building the
missing wrapper before resuming the script.

**Shipped:** a new `aws/lambda` submodule — `M3LLambdaOperations` (class) +
`M3LLambdaOperationError` + 7 plain types = 9 exports, mirroring `aws/sqs`
(ADR-0026)'s wrapper-class shape. Seven methods: `listFunctions`/`getFunction`/
`invokeFunction`/`createFunction`/`updateFunctionCode`/
`updateFunctionConfiguration`/`deleteFunction`, over the existing raw
`AWSClientProvider.lambda` client. No new runtime dependency —
`@aws-sdk/client-lambda` was already a hard library dependency.

- 26 tests (module), 3384 tests (full workspace suite) — all green.
- `typecheck`/`lint`/`build`/`lint:md`/`format:check`/`knip` — all green.
- `/syncing-docs` full 14-step pass — all green (provenance, doc counts,
  doc-exports, barrel↔sidecar sources, implemented count, test counts, script
  docs, reference index, markdown lint).
- Review verdict (5-spoke, parallel fan-out): `code-reviewer` — no Must-fix, 3
  Should-fix; `spec-conformance-reviewer` — conformant, 2 nits;
  `security-reviewer` — clean; `type-design-analyzer` — no Must-fix, 2
  Should-fix (deferred as tightening, not defects); `silent-failure-hunter` —
  clean except 1 Should-fix (converged with `code-reviewer`'s finding). All
  actionable Should-fix items applied in one fix round; both doc nits fixed by
  the hub directly.
- Provenance sidecar (`docs/reference/aws/lambda.provenance.json`) hand-authored
  — no generator exists for a brand-new sidecar, only a `--update` re-stamper
  for existing ones.
- Nothing committed yet — this and the `scripts/lambda-ops` scaffold (from
  earlier in the same session) are both uncommitted working-tree changes on
  `feat/lambda-ops`, intended to land together in one PR once `lambda-ops`'s
  real implementation is also done.

Skills used: starting-work, scaffolding-scripts, scaffolding-submodules,
implementing-submodules, syncing-docs, writing-work-logs.

## What went as planned

- **Contract extraction caught two real SDK traps before implementation** —
  `spec-conformance-reviewer`'s contract-mode pass (against the actual
  `@aws-sdk/client-lambda` type definitions on disk, not just the doc prose)
  surfaced the invoke functionError-vs-throw distinction and the
  create/updateCode `ZipFile` nesting asymmetry _before_ `code-implementer`
  wrote a line, so both were implemented correctly on the first pass rather
  than being found and fixed during review.
- **RED failed for the right reason** — all 26 tests (9 authored initially +
  16 more added after the contract review identified coverage gaps, plus 1
  consolidation) failed against the throwing scaffold placeholder, not for a
  syntax/type error; verified independently before dispatching GREEN.
- **GREEN passed all tests on the first implementation pass** — 26/26 green,
  clean `tsc`, on the first `code-implementer` dispatch (one ESLint complexity
  violation needed a follow-up resume, not a fresh implementation attempt).
- **No reviewer found a Must-fix** — across all 5 review spokes (code, spec
  conformance, security, type-design, silent-failure), zero Must-fix items.
  The only fix round addressed converging Should-fix findings.
- **`/syncing-docs`'s composite entry point (`pnpm sync:docs`) ran clean in one
  pass** — all 14 steps green with no manual step-by-step troubleshooting
  needed.
- The first GREEN implementation pass (`code-implementer`) wrote all 7 methods
  and got 26/26 tests green and `tsc` clean, but its final report cut off
  mid-sentence ("I need to reduce complexity — refactor into a
  `mapFunctionSummary` helper...") instead of a completion summary. Its journal
  showed the diagnosis was already correct (`mapFunctionConfiguration` had
  ESLint `complexity: 13`, max `10`) and the fix plan already decided —
  resuming the same agent via `SendMessage` with the exact gap completed it.

## What didn't go as planned, and why

### 1. Fixing a real Should-fix (dead optional-chaining) exposed a latent, unrelated test bug

Two reviewers (`code-reviewer`, `silent-failure-hunter`) converged on the same
finding from different angles: every method's `try`/`catch` should wrap
_only_ the `.send()` call, not the response-mapping — `invokeFunction` already
did this correctly (called out explicitly in the design doc), but the other
five methods wrapped both. `silent-failure-hunter` also flagged, as a trivial
nit, that `response?.Functions`/`response?.Configuration` optional-chained on
`response` itself even though `LambdaClient.send()`'s return type never
resolves `undefined` — dead defensive code.

Applying both fixes together (correct, and requested together in one
dispatch) made the second GREEN implementer's suite report 26/26 individual
tests passing but the vitest _process_ exiting 1 on two unhandled promise
rejections. The root cause: the test file's final `expectTypeOf` block called
`listFunctions()`/`getFunction()` for real (needed to inspect their return
type) against an unmocked `h.send()` — which resolves `undefined` — without
ever `await`-ing or `.catch()`-ing the resulting promises. Previously, the
dead `response?.` chains silently absorbed the `undefined` response and let
those fire-and-forget calls resolve without incident; removing the dead code
(the correct fix) made `response.Functions` genuinely throw on the mock's
`undefined`, surfacing the pre-existing unawaited-promise bug for the first
time.

The `code-implementer` agent identified this precisely (isolated it by
reverting/reapplying the fix independently to confirm causation), left the
correct fix in place, and reported the exact gap back to the hub rather than
unilaterally reverting its own correct change or silently patching the test
file itself (out of its write scope). A `test-author` dispatch fixed the test
by queuing proper `mockResolvedValueOnce` responses before those two calls,
consistent with the rest of the file's style.

**Why it happened:** a "defensive" optional-chain that guards against a value
the real type system says can never be `undefined` isn't just redundant — it
can silently absorb a genuine runtime error, masking an unrelated bug (here, a
test file's unawaited promise) until something else removes the false safety
net and the masked bug surfaces on its own.

**Fix for future:** when a review fix removes defensive code that "shouldn't
matter" per the type system, re-run the full test suite (not just the
targeted file) before considering the fix round done — a previously-masked
bug can surface anywhere the dead code was silently absorbing a real error.
Also: a spoke correctly declining to paper over a newly-exposed failure by
reverting its own correct fix, and instead routing the precise root cause back
to the hub, is the right call — worth citing as a concrete example when
briefing future writer spokes on this repo's "if a test looks genuinely wrong,
report it, don't edit it" convention.

## Lessons learned

- **A missing operations wrapper can hide behind a "thin op-dispatch, existing
  getters ✓" roadmap assumption.** `lambda-ops` was scoped identically to the
  already-shipped W2 scripts, but the analogy broke silently: DynamoDB/SQS/
  CloudWatch-Logs-Insights all have a typed wrapper submodule; Lambda only had
  a raw SDK client getter. Before scaffolding a script whose roadmap entry
  says "existing getters," verify the getter is actually a _wrapper_
  (`AWS.M3L*Operations`-shaped) and not just a raw SDK client passthrough —
  the ESLint `@aws-sdk/*` ban under `scripts/*/src` makes a raw getter alone
  insufficient the moment the script needs to issue any real command.

- **Narrow every `try`/`catch` to just the fallible call, never the
  post-processing.** Two independent reviewers converged on this same finding
  from different angles (message-precision vs. silent-failure risk) — a
  strong signal it's a durable convention, not a one-off nit. Wrapping
  response-mapping inside the same `try` as `.send()` means a future local
  mapping bug gets mislabeled as an upstream/SDK failure. _(promoted →
  `.claude/rules/library-src.md`)_

- **A dead optional-chain can mask a real bug elsewhere, not just be
  redundant.** `response?.X` where `response` can never be `undefined` per the
  real type isn't harmless clutter — removing it can be the exact action that
  un-masks an unrelated latent bug (here, unawaited promises in a test). Don't
  assume "the type system says this can't happen" chains are pure noise; treat
  their removal as a trigger to re-run the full suite, not just the touched
  file.

- **A writer spoke that isolates and reports a newly-exposed failure instead
  of silently reverting its own correct fix is exactly the right judgment
  call.** `code-implementer` proved causation (revert-then-reapply) before
  reporting, kept its correct fix in place, and routed the test-file gap back
  to the hub rather than exceeding its write scope — this is the pattern to
  reinforce when briefing future writer spokes, not an exception to smooth
  over.

- **Verify a real SDK's shape against its installed `.d.ts`, not just against
  the doc page or test mocks.** The contract-extraction pass explicitly
  cross-checked `@aws-sdk/client-lambda`'s actual type definitions on disk
  before handing off nuances like the `ZipFile` nesting asymmetry — this
  caught a trap that test mocks alone could have encoded incorrectly (a test
  can be self-consistently wrong about a real SDK's shape).

- **Defer type-design tightening that needs a library-wide primitive that
  doesn't exist yet.** A `JsonValue`-constrained payload type and a
  discriminated-union result type were both reasonable "tightening, not
  defect" suggestions, but introducing a shared `JsonValue` type is a
  cross-cutting decision beyond what one module needs — deferring until a
  second consumer creates real pressure matches this project's established
  gate-on-second-need pattern (ADR-0021 D4-style).
