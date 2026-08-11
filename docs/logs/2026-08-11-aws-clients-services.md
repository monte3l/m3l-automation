# Work log — `aws/clients` `AWSServiceProvider` addition (2026-08-11)

This log covers PR9, the last PR in the 9-PR capability-deepening wave for
`@m3l-automation/m3l-common`'s Core and AWS surface: adding `AWSServiceProvider`
(exposed as `AWSProvider.services`) per ADR-0038. It ran through
`starting-work` → `implementing-submodules` (extending the existing
`aws/clients` submodule rather than scaffolding a new one) → `syncing-docs` →
a PR push. It records what shipped, a genuine two-round TDD loop driven by a
real design-review Must-fix, two more writer-spoke truncations (both
harmless), and the lessons for closing out a capability-deepening wave.

## Summary

Added `AWSServiceProvider`, a new class exposing 15 lazily-cached getters —
one per AWS wrapper submodule this library ships a class for — as
`AWSProvider.services`, alongside the pre-existing `AWSProvider.clients`. 13
getters build a fresh wrapper instance from a raw `AWSClientProvider` getter;
`dynamoDBDocument` is a passthrough (no separate wrapper class exists for
it); `requestSigner`/`credentials` build from `AWSClientProvider`'s own
`profile`/`region`. `.services` and `.clients` always share the same
underlying `AWSClientProvider` instance, so using both never double-resolves
credentials or double-constructs an SDK client.

`AWSClientProvider` gained two new public readonly getters, `profile` and
`region` — added mid-review as the fix for a design-review Must-fix (see
divergence 2). The four `AWSClientProvider` convenience getters
`AWSServiceProvider` supersedes (`sqsOperations`, `eventBridgeOperations`,
`requestSigner`, `dynamoDBDocument`) are marked `@deprecated` in place, kept
fully functional. `aws/s3` and `aws/dynamodb` deliberately have no
`.services` entry (function-based, ADR-0033) — documented explicitly rather
than left as a silent gap.

Final state: 261 tests in `clients.test.ts` (80 new), 100% statement
coverage on `service-provider.ts` and `aws-provider.ts`, `pnpm typecheck` /
`pnpm lint` / `pnpm build` all clean, `pnpm check:zones` clean (no Zone A
widening — every new import is intra-`aws/**`), `pnpm check:exports` clean
(three-entry `exports` map unchanged), `pnpm knip` clean. 5-spoke review
(code-reviewer, spec-conformance-reviewer, security-reviewer,
type-design-analyzer, silent-failure-hunter) found one Must-fix
(type-design-analyzer's constructor-divergence finding) and two Should-fix
findings it subsumed; a focused confirmation re-review (type-design-analyzer

- code-reviewer) on the fix round returned clean. `pnpm sync:docs` passed
  14/14. Shipped as commits `85fb609` (docs contract) + `9fe1611` (feat
  implementation) on `feat/aws-services-tier`, PR #323.

Skills used: starting-work, implementing-submodules, syncing-docs,
writing-commits (inline, not the standalone skill — commits were authored
directly per the pipeline's own commit step), writing-work-logs.

Spoke incidents: 2 truncations / 0 stalls / 0 resumes.

## What went as planned

- **The 15-getter contract was fully resolved before any spoke was
  dispatched.** Direct source inspection of every wrapper class's
  constructor signature (all 12 raw-client-taking wrappers, plus
  `requestSigner`/`credentials`' options-based constructors) caught the
  S3/DynamoDB function-vs-class mismatch (divergence 1) before RED, so
  `test-author` and `code-implementer` both worked from one settled,
  unambiguous contract instead of guessing independently.
- **RED failed for the right reason, twice.** The initial RED round failed
  with exactly the expected missing-symbol diagnostics (`AWSServiceProvider`
  not exported, `AWSProvider.services` not a property) — 60 new tests, 196
  pre-existing tests still green. The fix-round RED (divergence 2) also
  failed for exactly the right reason (`profile`/`region` private,
  `@ts-expect-error` unused pre-fix).
- **GREEN was clean on both passes.** Neither the initial implementation nor
  the fix-round implementation needed a second `code-implementer` dispatch —
  each hit green tests/typecheck/lint/build on the first attempt.
- **Security, spec-conformance, and silent-failure-hunter all returned
  clean** on the first review pass, with zero findings — a genuinely
  low-risk, get/cache-only surface reviewed as such.
- **The doc-provenance sidecar gap was caught and fixed the same way every
  time**: a new symbol (`AWSServiceProvider`) needs a hand-added `sources[]`
  entry, not just a re-stamp — the known `syncing-docs` gap, handled
  proactively rather than discovered via a failing gate.

## What didn't go as planned, and why

### 1. ADR-0038's wrapper enumeration didn't account for `aws/s3`/`aws/dynamodb` being function-based

ADR-0038 (immutable, already merged via PR #322) lists S3 among the "eleven
caller-constructed wrappers" that a `.services` tier should bring under one
access path. Direct inspection of `aws/s3/operations.ts` and
`aws/dynamodb/operations.ts` showed both are deliberately function-based
(ADR-0033's design: every export is a free function taking an
already-provisioned client as its first parameter, not a class) — there is
no wrapper object to construct or cache for either. This is a real design
gap in the ADR's planning-level prose, not something the ADR meant to
authorize inventing new surface for.

**Why it happened:** ADR-0038 was written at a planning level, cataloging
"caller-constructed wrappers" without checking each one's actual
implementation shape — the same class of imprecision the `aws/ecs` waiter
contract hit earlier in this wave (`docs/logs/2026-07-24-aws-ecs.md`).

**Fix for future:** Since ADRs are immutable once `Accepted`, resolve this
class of gap in the implementation-facing contract doc
(`docs/reference/**`), not by reopening the ADR. State the exclusion
explicitly with its rationale (here: "function-based per ADR-0033, no class
to wrap") so a future reader sees a deliberate scope decision, not an
oversight.

### 2. A design-review Must-fix required a genuine two-round TDD loop

After the first Phase 4 review, `type-design-analyzer` found a real
Must-fix: `AWSServiceProvider`'s original constructor,
`(clientProvider, options?)`, let a caller supply a `clientProvider` for one
AWS profile and a separate `options` bag naming a different profile,
producing one instance whose 13 raw-client-backed getters silently
authenticate as profile A while `requestSigner`/`credentials` authenticate
as profile B. Unlike a typical post-review fix (a same-spoke touch-up),
this needed a real mini RED→GREEN cycle: `test-author` first updated the
test file for the corrected single-argument constructor shape (added tests
for two new `AWSClientProvider.profile`/`.region` public getters, collapsed
every `new AWSServiceProvider(clientProvider, options)` call site to a
single argument, added a `@ts-expect-error` line proving the old two-arg
form is now a compile error), confirmed RED via `pnpm typecheck` — notably
**not** `pnpm exec vitest`, which stayed green throughout, since
TypeScript's `private` has zero runtime enforcement and Vitest transforms
without type-checking. Then `code-implementer` implemented the actual fix:
exposing `profile`/`region` as public readonly getters on
`AWSClientProvider` (renaming its private backing fields to free the
names), and collapsing `AWSServiceProvider` to `constructor(clientProvider)`
alone. A focused confirmation re-review (`type-design-analyzer` +
`code-reviewer`, the two whose findings drove the fix) confirmed the
Must-fix was structurally resolved — verified via the `@ts-expect-error`
line actually suppressing correctly post-fix, not just "looks fixed."

**Why it happened:** The initial contract (authored by the hub directly into
`docs/reference/aws/clients.md`, per divergence 1's process) modeled
`requestSigner`/`credentials` as needing a _second_ identity source because
`AWSClientProvider` had no public way to read back its own resolved
`profile`/`region` — the hub design missed that this asymmetry was itself
the defect, not a constraint to work around.

**Fix for future:** When a new wrapper class needs to derive behavior from
another object's already-resolved private state, check whether that object
should simply expose the state as a public readonly accessor before
inventing a second, independently-suppliable parameter for the same
information — a single source of truth is usually available for free if the
holding class is under your control in the same PR.

### 3. Two more writer-spoke truncations, both verified harmless

Both `test-author` dispatches (initial RED, fix-round RED) and one
`code-implementer` dispatch (initial GREEN) returned truncated, mid-thought
final messages rather than completion summaries — the third and fourth such
truncations in this wave (after two in PR8). Each time, verified directly
per the skill's guidance: `git status`/`git diff --stat`, the spoke's own
journal file, then independently re-running `pnpm typecheck` /
`pnpm exec vitest run` / `pnpm lint` / `pnpm build` myself rather than
trusting the cut-off text. Unlike PR8's truncations (which did hide two
small legitimate gaps), all four this time turned out to have completed
their full scope of work — the truncation was purely in the final summary
sentence, not the underlying edit.

**Why it happened:** Same recurring cause as before — a long, token-heavy
spoke turn (exploration-heavy test authoring against a 1000+-line existing
test file; a multi-file GREEN implementation) occasionally exhausts its
turn budget mid-summary.

**Fix for future:** No change needed to the verification discipline itself
— it caught both outcomes correctly (real gaps in PR8, no gaps here). Worth
recording as a data point rather than a lesson: a truncated report is not
itself evidence of missing work, only evidence that direct verification is
required before trusting it either way.

### 4. A confirmation re-review's non-blocking findings were judged already-resolved by existing design, not fixed again

`type-design-analyzer`'s confirmation re-review (scoped to divergence 2's
fix) surfaced two items beyond confirming the Must-fix resolved: a
Should-fix noting `AWSServiceProvider`'s cache doesn't invalidate when
`AWSClientProvider.close()` runs (a stale wrapper can outlive its
underlying destroyed SDK client), and a Nit that `dynamoDBDocument`
delegates to an `AWSClientProvider` getter that is itself `@deprecated`
(circular deprecation advice). Both were judged already-covered by a
deliberate design decision documented in `clients.md`'s "Notes and
behavior" section _before_ the reviewer ran — the doc explicitly states
`.services.close()` does not cascade from `.clients.close()` and calls out
this exact risk as mirroring the pre-existing risk of holding a stale
`.clients.*` wrapper reference across a `close()`. No further fix round was
dispatched.

**Why it happened:** Not a process failure — a confirmation re-review is
scoped to the changed files, not to "does this diff have any remaining
findings at all," so it will legitimately surface adjacent design
observations beyond the one it was sent to confirm.

**Fix for future:** When a confirmation re-review surfaces a finding outside
its scoped Must-fix, check whether the tradeoff it names was already made
and documented deliberately (not merely "not yet noticed") before routing
it as a new fix request — a reviewer flagging a documented tradeoff is
useful signal that the documentation is doing its job, not automatically
grounds for another round.

## Lessons learned

- **Resolve ADR imprecision in the implementation doc, never by reopening
  the ADR.** ADRs are immutable once `Accepted`; a planning-level
  enumeration (like ADR-0038's wrapper list) can still be wrong about an
  implementation detail (S3's function-based shape) without needing a new
  ADR — the fix belongs in the `docs/reference/**` contract page that
  spokes actually build against.
- **A single source of truth beats a second parameter for the same
  identity.** Before adding a constructor parameter that duplicates
  information another object under your control already resolved
  internally, check whether exposing that state as a public readonly
  accessor removes the parameter — and the divergence risk — entirely.
- **`pnpm typecheck` is sometimes the _only_ valid RED gate.** When a fix
  narrows a type-level contract (private→removed field, narrower
  constructor arity) without changing runtime behavior, Vitest can stay
  fully green through both RED and GREEN — `.claude/rules/tests.md`'s
  "runtime-green ≠ typecheck-green" gotcha already covers this in general,
  but it's worth restating for RED specifically: don't read a green
  `vitest run` as "not RED yet" when the defect being tested is purely a
  type-level one.
- **A confirmation re-review's non-Must-fix findings deserve a judgment
  call, not an automatic fix round.** If a surfaced tradeoff is already
  documented as a deliberate decision, that's the review working as
  intended, not a gap.
- **Truncated spoke reports remain uninformative about outcome — verify
  every time regardless of the odds.** Four truncations across two PRs in
  this wave split evenly between "hid a real gap" (PR8) and "hid nothing"
  (this PR) — the base rate doesn't justify skipping verification either
  way.
