# Work log — `aws/cloudformation` submodule (2026-07-26)

This log covers scaffolding and implementing the `aws/cloudformation` library
submodule (`M3LCloudFormationOperations`) end-to-end in a single session, on
branch `feat/aws-cloudformation`. This is **PR #1 of a two-PR chain**
unblocking roadmap item W3 `cloudformation-stacks`; the consumer script itself
is out of scope here (PR #2, not started). The pipeline ran `starting-work`,
`scaffolding-submodules` (inline, hub-owned per that skill's model) followed
by the full `implementing-submodules` hub-and-spoke loop, closely mirroring
the `aws/ecs` submodule's own recent pipeline (`docs/logs/2026-07-24-aws-ecs.md`).
It records what shipped, the contract-extraction pass's findings, one review
fix round, and durable lessons for the next AWS wrapper submodule.

## Summary

Shipped `packages/m3l-common/src/aws/cloudformation/{index,client,error,types}.ts`
— `M3LCloudFormationOperations`, a typed wrapper over the raw AWS SDK v3
`CloudFormationClient`, scoped to the CloudFormation **stack** resource
(list/describe/create/update/delete, stack-event streaming) plus the three
stack-lifecycle waiters (`waitUntilStackCreateComplete`/`UpdateComplete`/
`DeleteComplete`). Change sets, stack sets, drift detection, stack refactor,
template validation/estimation, and stack-policy management are deliberately
out of v1 scope.

- **Exports**: `M3LCloudFormationOperations`, `M3LCloudFormationOperationError`
  (code `ERR_CLOUDFORMATION_OPERATION`), two options interfaces
  (`M3LCloudFormationListStacksOptions`/`…DescribeStackEventsOptions`), and 15
  plain types — 19 total, including a closed `M3LCloudFormationCapability`
  literal union (added during the fix round in place of an open `string[]`).
- **Tests**: 76 in `packages/m3l-common/tests/cloudformation.test.ts`; 100%
  stmts/branches/functions/lines on `client.ts`. Full workspace suite: 4792
  tests, all passing.
- **Gates**: `pnpm build`, `pnpm test`, `pnpm test:coverage`, `pnpm lint`,
  `pnpm typecheck`, `pnpm format:check`, `pnpm check:doc-counts`,
  `pnpm check:impl-counts`, `pnpm check:index`, `pnpm check:doc-exports`,
  `pnpm check:test-counts`, `pnpm check:api`, `pnpm check:exports` (publint +
  attw), `pnpm check:provenance`, `pnpm lint:md`, `pnpm knip`,
  `pnpm check:dup`, `pnpm check:zones`, `pnpm check:deps` — all green.
- **Review verdicts**: `code-reviewer` — PASS, 0 must-fix, 1 should-fix
  (missing `StackEvent` optional-field test coverage). `security-reviewer` —
  PASS, 0 must-fix, 1 should-fix (a doc-only correction — see divergence #2
  below) + 2 nits. `silent-failure-hunter` — PASS, 0 findings. `type-design-analyzer`
  — PASS, 0 must-fix, 2 should-fix (`capabilities` typing, two array-cast
  aliasing sites) + 4 nits. One combined fix round applied all should-fix
  items across two parallel spokes (`code-implementer` for the type-design
  fixes, `test-author` for the coverage gap); both verified independently.
- **Docs**: full spec `docs/reference/aws/cloudformation.md` (drafted before
  any code, then revised twice — once by a contract-extraction pass, once by
  the security-reviewer's data-flow correction) + hand-authored
  `docs/reference/aws/cloudformation.provenance.json`. `docs/implementation-status.md`
  `cloudformation` row flipped scaffolded (🧪/🧪/❌) → done (✅/✅/✅); 34 of 34
  submodules now implemented+reviewed. Tracker rows flipped in
  `docs/ROADMAP.md` (`cloudformation-stacks` Blocked → To Do) and
  `docs/plans/IMPLEMENTATION.md` (AWS getter reality table: `cloudFormation`
  raw → wrapped/Done).
- **No new runtime dependency** — `@aws-sdk/client-cloudformation` was already
  a hard library dependency and the `cloudFormation` `AWSClientProvider`
  getter already existed; only the wrapper submodule was missing.

Plan of record: the plan mode session for this task (no separate
`docs/plans/*.md` file was written — the plan was approved via `ExitPlanMode`
directly into the conversation).

Skills used: `starting-work`, `scaffolding-submodules` (inline),
`implementing-submodules`, `writing-work-logs`.

Spoke incidents: none — no truncations, no stalls, no `SendMessage` resumes.
All eight dispatched agents (1 contract-extraction, 1 test-author RED, 1
code-implementer GREEN, 1 test-author coverage-gap, 4 parallel reviewers, 1
code-implementer fix + 1 test-author fix in the fix round) completed cleanly
in their first dispatch.

## What went as planned

- **The contract-extraction pass earned its keep a second time.** Per the
  `aws/ecs` lesson ("read the SDK before writing a resolve/throw contract"),
  the hub verified the waiter defaults, the two `ValidationError` message
  patterns, and the delete-waiter's acceptor asymmetry against the installed
  SDK/`@smithy/core` source **before** drafting the spec — via `WebFetch`
  against the published botocore `waiters-2.json` and direct reads of
  `dist-types`/`dist-es`. Despite that upfront verification, the dispatched
  `spec-conformance-reviewer` contract-extraction pass still caught a genuine
  blocking contradiction (the doc claimed a waiter's internal
  `DescribeStacksCommand` poll resolves a stack record; the actual result
  type is `{ state, reason? }` only) plus 8 further unspecified-behavior
  gaps — confirming that self-verification and an independent
  contract-extraction pass catch different classes of drift, and both are
  worth running.
- **RED failed for the right reason.** The scaffold-stage placeholder tests
  failed with the placeholder's own `"... not yet implemented"` rejection,
  not an import error or logic bug; after `test-author`'s 61-test expansion,
  the same held across every new test.
- **GREEN was clean on the first pass.** `code-implementer` delivered a
  typecheck-clean, lint-clean implementation covering all 9 methods against
  the settled contract, reaching 61/61 green with no re-dispatch needed.
- **The coverage gap was caught and closed cleanly, twice.** `code-implementer`
  reported `client.ts` at 95.13% branch coverage on the first GREEN pass
  (after mapper-helper additions dropped it from an initial reading);
  `test-author` closed it to 100% in one dispatch. A second, smaller gap
  (`StackEvent`'s optional-field mapping, found independently by
  `code-reviewer` during the review fan-out) was closed the same way in the
  fix round.
- **All four review spokes returned PASS with zero must-fix.** The 4-way
  parallel review fan-out (code/security/silent-failure/type-design)
  surfaced only should-fix and nit-level findings — no correctness defects
  in the implementation logic, matching `aws/ecs`'s review outcome.
- **The error-code registration held on the first try.** `ERR_CLOUDFORMATION_OPERATION`
  was registered in both `M3L_ERROR_CODES` (alphabetically, between
  `ERR_CHECKPOINT_PARSE` and `ERR_CONFIG_COERCION`) and `M3L_ERROR_CATALOG` in
  the same pass that scaffolded the error class, so the source-scan
  completeness test in `errors.test.ts` never failed during this session.
- **Two independent fix-round spokes ran safely in parallel on disjoint
  files.** `code-implementer` (capabilities typing + array-cast copies,
  `client.ts`/`types.ts`) and `test-author` (`StackEvent` coverage,
  `cloudformation.test.ts` only) were dispatched together since their target
  files didn't overlap; both completed and verified independently with no
  conflict.

## What didn't go as planned, and why

### 1. Writing the doc and the scaffold in the same pass introduced drift the contract-extraction pass had to catch

The hub drafted the full spec page and the four scaffold source files in
back-to-back steps without an intermediate review, on the theory that having
just researched the SDK made both artifacts trustworthy. The dispatched
`spec-conformance-reviewer` contract-extraction pass instead found 6 exported
types/interfaces named nowhere in the doc's Overview list (failing
`pnpm check:doc-exports`), an inverted optionality claim for `StackSummary`'s
`stackId` field (documented as always-present when the SDK's `StackId?` is a
genuinely optional key), and a missing `Date`→ISO-8601-string mapping
statement entirely.

**Why it happened:** Drafting doc and scaffold together, from the same mental
model, means both artifacts inherit the same blind spots — an independent
reviewer reading only the doc (not the author's intent) is what surfaces a
self-consistent-but-wrong description.

**Fix for future:** Keep the contract-extraction dispatch as a **mandatory**
gate between drafting the spec+scaffold and starting RED, even when the hub
feels confident in its own research — this session's own verification pass
(via direct SDK reads) still missed defects an independent reviewer caught
on the first read.

### 2. A security-reviewer finding refuted a data-flow claim in the doc that had already passed a full contract-extraction review

The doc stated a waiter's internal `DescribeStacksCommand` poll "is never
surfaced to the caller." The security-reviewer probed the SDK's actual waiter
`checkExceptions` behavior on the `FAILURE` terminal state and found it
throws `new Error(JSON.stringify(result))`, embedding the **entire** last
`DescribeStacks` response (including `Parameters`/`Outputs` values) as the
thrown error's message — which this wrapper then chains as `cause` on the
resulting `M3LCloudFormationOperationError`. The doc's claim was true only on
the _resolve_ path (`SUCCESS`/`TIMEOUT`/`ABORTED`), not the _throw_ path.

**Why it happened:** The claim was written to describe the wrapper's own
return-type contract (correctly: `M3LCloudFormationWaiterResult` never
carries a stack record) without separately verifying whether the _chained
`cause`_ on the throw path carries one — two different channels, only one of
which the sentence actually described.

**Fix for future:** When documenting "X is never surfaced," explicitly check
every channel a caller can observe X through — a resolved value **and** a
thrown error's `cause`/`message` — not just the one the sentence was written
about. This is the same failure shape `.claude/rules/library-src.md` already
warns about ("a TSDoc sentence asserting a security property is a claim to
verify, not prose to write"), just recurring on a data-flow claim instead of
a redaction claim.

## Lessons learned

- **Self-verification and an independent contract-extraction pass catch
  different defect classes — run both, not one instead of the other.** The
  hub verified the waiter defaults and message patterns directly against SDK
  source before drafting the doc (this session's own diligence), yet the
  dispatched `spec-conformance-reviewer` still found a blocking contradiction
  and 8 further gaps on the same draft. Self-research reduces obvious errors;
  an independent read catches the ones invisible to the author's own model.
- **A claim that "X is never surfaced" needs a per-channel audit, not a
  per-return-type one.** `M3LCloudFormationWaiterResult`'s type correctly
  never carries a stack record, but the _thrown error's `cause`_ is a
  separate channel with its own content, and the security-reviewer's probe
  (not the type-design review, not the contract-extraction pass) was the one
  that actually exercised it. When a data-isolation claim spans multiple
  observable channels (resolve value, thrown message, chained cause), verify
  each one independently before writing the claim.
  _(promoted → .claude/rules/library-src.md)_
- **Reusing an established sibling submodule's shape (here, `aws/ecs`) as a
  structural template pays off, but doesn't substitute for re-deriving the
  SDK-specific contract.** The standalone-waiter pattern, the
  `TimeoutError`/`AbortError`/`FAILURE` classification, and the
  mapper-helper-extraction convention all transferred cleanly from `aws/ecs`.
  What did **not** transfer without verification: CloudFormation has zero
  modeled exception classes (unlike ECS having none either, but for a
  different reason — no waiter-adjacent `ValidationError` classification
  precedent existed to copy), the waiter framework provides no default
  `maxWaitTime` at all (verified fresh against `@smithy/core`, not assumed
  from ECS's shape), and the delete waiter's acceptor is asymmetric with
  create/update's (a CloudFormation-specific behavior with no ECS analogue).
- **Two fix-round spokes on genuinely disjoint files can run in parallel
  safely, cutting a fix round's wall-clock roughly in half.** `code-implementer`
  (types/client) and `test-author` (test file only) touched no shared file
  in this fix round, so dispatching both concurrently rather than
  sequentially — as the `aws/ecs` log's "route test breakage to a separate
  test-author dispatch" lesson implicitly assumed would be sequential — was
  safe and faster here, since neither spoke's change could break the other's
  target file.
