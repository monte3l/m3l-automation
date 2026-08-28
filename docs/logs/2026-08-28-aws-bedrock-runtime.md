# Work log — `aws/bedrock-runtime` submodule, slice 1 (2026-08-28)

This log covers issue #541 (V4, ADR-0059) — implementing slice 1 of the
`aws/bedrock-runtime` typed wrapper through the hub-and-spoke
`implementing-submodules` pipeline, followed by `syncing-docs` and
`creating-prs`. It records what shipped, what matched the plan, what
diverged, and durable lessons for the next AWS submodule (particularly
slice 2 of this same module, streaming).

Plan of record: [`docs/plans/archive/2026-08-28-v4-bedrock-runtime-wrapper.md`](../plans/archive/2026-08-28-v4-bedrock-runtime-wrapper.md)

## Summary

Shipped `M3LBedrockRuntimeOperations.invoke()` — a typed wrapper over the
Bedrock `Converse` API — plus the model-id fallback registry, token usage
capture, `AbortSignal` cancellation, and three error classes
(`M3LBedrockRuntimeOperationError`/`ModelError`/`NoModelError`). New
`AWSClientProvider.bedrockRuntime` getter; deliberately no
`AWSServiceProvider` convenience getter (the model list is caller-specific
config with no library-owned default). New exact-pinned runtime dependency
`@aws-sdk/client-bedrock-runtime@3.1115.0`. 40 tests in
`tests/bedrock-runtime.test.ts` (100% statement/branch/function/line
coverage) plus a barrel-reachability row in `tests/index.test.ts`. AWS
submodule count 19 → 20 across every count site. Full-workspace
`pnpm verify` (48/48 applicable steps), `build`/`test`/`typecheck`/`lint`,
and `knip` all green. PR #725 opened against `main`, mergeable, CI running.

Review verdicts (5-spoke fan-out + a bounded confirmation pass):
code-reviewer (1 Must-fix, closed — 2 uncovered `AbortSignal` branches),
spec-conformance-reviewer (conformant, 4 non-blocking nits deferred to
slice 2), security-reviewer (0 Must-fix, 2 Should-fix closed — misleading
error message, doc-note scope), silent-failure-hunter (1 HIGH, closed —
`NoModelError` losing all diagnostic `cause`), type-design-analyzer (0
Must-fix, 2 Should-fix closed — non-empty tuple type, `stopReason`
validation). Confirmation pass caught one further genuine miss (abort-race
check), closed in a follow-up fix round.

Skills used: starting-work, implementing-submodules, syncing-docs,
creating-prs, writing-work-logs.

Spoke incidents: 3 truncations / 0 stalls / 3 resumes (initial
`test-author` RED dispatch, initial `code-implementer` GREEN dispatch, and
the first Bedrock SDK dist-types exploration agent all hit the 40-turn
limit mid-task; all three were resumed via `SendMessage` with a scoped
punch-list rather than re-dispatched fresh, and all three completed
cleanly on resume).

## What went as planned

- **The contract-settling pass caught a real design bug before RED.**
  Verifying the installed `@aws-sdk/client-bedrock-runtime` `dist-types`
  directly (rather than trusting ADR-0059's prose) surfaced that
  stream-lifecycle exceptions arrive **in-band** as yielded
  `ConverseStreamOutput` union members, not thrown from iteration — this
  reshapes slice 2's design and is now recorded on the reference page for
  that slice to re-verify at its own kickoff.
- **RED failed for the right reason.** After two rounds of test-file
  defects (index-signature bracket-access, a malformed `expectTypeOf`
  chain), `pnpm typecheck` showed exactly the 15 expected "has no exported
  member" diagnostics and nothing else; every non-type-only vitest case
  failed with "is not a constructor", never an assertion failure inside a
  passing import.
- **GREEN passed all 90 tests on the first implementer pass** (before the
  review-driven fix rounds), including the deliberately tricky
  fault-handling state machine (retry-then-fallback vs. immediate-fallback
  vs. immediate-throw across 3 tiers).
- **The 5-spoke review fan-out found zero spec-conformance drift and zero
  security Must-fix** — every field, error mapping, and behavioral rule in
  the settled contract was implemented exactly as documented.
- **`pnpm verify`'s 48/48 applicable steps passed on the first full run**
  after the fix rounds — no gate needed a second attempt once the code was
  actually correct.

## What didn't go as planned, and why

### 1. A truncated grep preview corrupted an adjacent tracker row

The very first `docs/implementation-status.md` edit inserted the new
`bedrock-runtime` row after the existing `rds-data` row, using an
`old_string` that matched only the short table-prefix I'd seen in a
column-truncated `grep` preview — not the row's full physical line (a
single Markdown table row's Notes cell is one very long line with no
internal breaks). The `Edit` tool's exact-match replacement spliced the
file mid-line: `rds-data`'s Notes column ended up empty, and its actual
~2,000-word content was reattached to the newly-inserted `bedrock-runtime`
row instead. This was caught only when I later re-read the row I'd just
written and noticed the Notes text described RDS Data API internals, not
Bedrock — not by any gate (the file stayed valid Markdown throughout, so
`lint:md`/`prettier` never flagged it). Fixed in a dedicated
`fix(docs):` commit that restored `rds-data`'s content to its own row.

**Why it happened:** I read the row via a `grep -n` call whose terminal
output truncates long lines, then used that truncated text as the basis
for an `Edit` `old_string` — the match succeeded against the truncated
prefix, but `Edit` performs exact string replacement against the _actual_
file content, so everything after my match point (the real row's Notes
text) landed wherever my `new_string` ended, not where the original row
ended.

**Fix for future:** When editing a line whose content might be very long
(a tracker table row, a generated block), use the `Read` tool with a
narrow `offset`/`limit` to see the **full** line before constructing an
`Edit`, never a `grep`/`bash` preview that a terminal or pipe might
truncate. If a match's `old_string` was derived from truncated output,
re-verify the edit landed correctly by re-reading the target row
immediately after, not just trusting the tool's success response.

### 2. The pre-commit hook cannot pass on RED-phase tests

Attempting to commit the RED test suite as its own commit (matching the
`implementing-submodules` skill's implied phase boundary) failed at the
`pre-commit` lefthook: type-aware ESLint's `no-unsafe-*` rules hard-fail on
a test file importing symbols that don't exist yet, and there is no
narrower exemption than "don't commit RED alone." RED and GREEN ended up
landing in one combined commit instead.

**Why it happened:** `pre-commit` runs `pnpm exec eslint --fix
{staged_files}` — full type-aware linting, not a lighter subset — and
`@typescript-eslint/no-unsafe-*` treats every property access on an
unresolved-import's value as unsafe. This is inherent to type-aware
linting against a not-yet-existing module, not a configuration gap.

**Fix for future:** Don't plan a standalone RED-phase commit for this
repo. `implementing-submodules`' Step 6/7 boundary is a good phase
boundary for _dispatch_ purposes but not for _commit_ purposes here — RED
and GREEN should be committed together (or GREEN immediately after RED
with no commit in between), since the pre-commit hook structurally cannot
pass on RED alone.

### 3. Two review rounds found gaps the contract doc hadn't anticipated

The first 5-spoke review round found four real, non-trivial gaps
(diagnostic-losing `cause` on fallback exhaustion, two uncovered
`AbortSignal` branches, an under-typed `models` field, an unvalidated
`stopReason`). A second, bounded confirmation re-review — scoped only to
the changed files, run by the same reviewers whose findings drove the
fixes — then found a further genuine miss: the abort-race catch-block
check reclassified _any_ rejection as aborted merely because the signal
was concurrently aborted, silently discarding a real cause. This
diverged from the exact `aws/athena/client.ts` precedent the contract doc
_cited by name_ without actually matching its behavior.

**Why it happened:** The contract doc was hub-authored from SDK
`dist-types` and house-pattern citations, not from reading the cited
precedent file's actual logic line-by-line at doc-authoring time — "check
before `send()`, before advancing fallback, and in the catch block" was
true, but the _compound condition_ in athena's catch-block check
(`isAborted(signal) && isAbortError(cause)`, not `isAborted(signal)`
alone) wasn't carried over.

**Fix for future:** When a contract doc says "matches `<file>`'s
precedent," verify that claim by reading the cited file's exact logic
(not just its existence/shape) before treating the doc as settled — the
same "verify SDK dist-types directly" discipline that already applies to
external APIs should extend to internal precedent citations. A bounded
confirmation re-review after every fix round is what caught this here;
it would not have been caught by re-running tests alone, since the
original tests were written against the (wrong) unconditional-check
contract and passed cleanly.

## Lessons learned

- **Don't build an `Edit` `old_string` from truncated terminal output.**
  Read the exact target line via `Read` with a narrow offset before
  editing anything whose content might exceed a terminal's line-display
  width — a tracker table row, a generated block, a long TSDoc line. A
  successful `Edit` result is not proof the edit landed where intended;
  re-read the row afterward.
- **RED and GREEN commit together when the hub skipped
  `scaffolding-submodules`'s placeholder step.** Type-aware `pre-commit`
  linting cannot pass on a test file importing not-yet-existing symbols;
  `scaffolding-submodules` normally avoids this by pre-creating a throwing
  placeholder per export, but a hub-authored-contract-then-implement flow
  (as here) forfeits that and hits the same wall `implementing-scripts`
  already documents for under-scaffolded scripts. Plan the commit boundary
  around this constraint, not around the RED/GREEN dispatch boundary.
  _(promoted → `.claude/skills/implementing-submodules/SKILL.md`)_
- **A contract doc's "matches `<precedent>`" claim is a claim to verify,
  not a citation to trust.** Read the cited file's actual logic (not just
  confirm it exists and does something similar) before treating a
  "follows X's pattern" sentence in a settled contract as fact — this is
  the same discipline `style-guide.md`'s "TSDoc claim to verify" rule
  already applies to security/behavioral guarantees, extended to internal
  precedent citations.
- **A bounded confirmation re-review earns its cost even after a clean
  fix round.** All four first-round fixes were individually correct, but
  the confirmation pass (scoped to just the changed files, run by the
  reviewers whose findings drove the fixes) found a fifth defect none of
  the four fixes had touched — it existed in the original code and had
  simply never been flagged until a second, more targeted look.
- **In-band exception delivery is a real SDK pattern worth checking for
  explicitly.** Bedrock's `ConverseStreamCommand` yields
  `ThrottlingException`/`ModelStreamErrorException`/etc. as regular
  `AsyncIterable` values, not as rejected promises — a wrapper designed
  from the non-streaming command's throw-based contract alone would have
  missed this entirely. Worth checking for on any future streaming SDK
  wrapper: read the streaming command's response-shape `dist-types` for a
  tagged union with exception-shaped members before assuming
  "exceptions throw" carries over from the non-streaming sibling.
