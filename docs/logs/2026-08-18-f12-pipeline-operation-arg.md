# Work log — F12: pipeline `operation` arg (2026-08-18)

This log covers issue #458 — the semver-minor addition of `operation: TOp` as a
4th argument to `Core.M3LOperationPipeline`'s `persist` and `finalize` callbacks,
plus the cleanup of the four consumer scripts that had been working around its
absence with script-specific structural predicates. It records what shipped, what
matched the plan, the one divergence (`check:test-counts` after T15), and the
durable lesson from that divergence.

Plan of record: `~/.claude/plans/on-issue-458-sparkling-tarjan.md`
(session-local; not archived — routine F-series feature, covered by this log).

## Summary

**Library seam** (`feat:` commit `402dcf3`, semver-minor 3.1.0 → 3.2.0):

- `packages/m3l-common/src/core/pipeline/types.ts` — `persist` and `finalize` in
  `M3LOperationPipelineCoreOptions` gained `operation: TOp` as the 4th parameter
  (appended last for source-compatibility; documented in TSDoc `@param`).
- `packages/m3l-common/src/core/pipeline/M3LOperationPipeline.ts` — two
  invocation sites now forward the in-scope `operation`.
- `packages/m3l-common/tests/pipeline.test.ts` — B35a call-shape assertion
  extended to include `"read"` as the 4th arg; new T15 type-level test asserting
  `Parameters<…persist…>[3]` and `Parameters<…finalize…>[3]` equal the
  `"list" | "get"` operation union.
- `docs/reference/core/pipeline.md` + `pipeline.provenance.json` updated.
- `packages/m3l-common/package.json` version bumped 3.1.0 → 3.2.0.

**Consumer adoption** (four `refactor:` commits):

| Commit  | Script                  | Deleted predicate(s)                        | Notes                                                               |
| ------- | ----------------------- | ------------------------------------------- | ------------------------------------------------------------------- |
| 069fcb5 | `ecs-ops`               | `isWaiterResult` (`"state" in result`)      |                                                                     |
| a5f9c4f | `lambda-ops`            | `isInvokeResult` (`"statusCode" in result`) | Predicate reused in post-run log → `outcome.operation === "invoke"` |
| 0e9edea | `cloudformation-stacks` | `isWaiterResult`                            |                                                                     |
| ecdb3c1 | `eks-ops`               | `isWaiterResult` + `isUpdateResult`         | `ReadonlySet<EksOperation>` to avoid cyclomatic cap                 |

**Chore** (`bc18572`): `docs/implementation-status.md` pipeline test count 72 → 73
(see divergence §1 below).

Pipeline test count: **73 tests (58 behavioral + 15 type-level)**. Full suite:
**7,670 tests (214 files)** — pre-push hook green. All CI gates passed locally:
`pnpm lint`, `pnpm typecheck`, `pnpm test:coverage`, `pnpm build`,
`pnpm check:exports`, `pnpm verify`.

Phase 8 review fan-out (code-reviewer, spec-conformance-reviewer,
type-design-analyzer, silent-failure-hunter): **0 must-fix items across all
four spokes**. PR: #463.

Skills used: starting-work, implementing-submodules (TDD loop), syncing-docs,
creating-prs, writing-work-logs.

Spoke incidents: 0 truncations / 0 stalls / 0 resumes.

## What went as planned

- **RED failed for the right reason** — four `TS2493` ("tuple type of length '3'
  has no element at index '3'") + one `TS2344` diagnostic, exactly the expected
  signals that the engine wasn't forwarding the argument yet.
- **GREEN delivered clean code on first pass** — the code-implementer emitted
  lint/typecheck-clean output without a re-dispatch; the two one-line changes to
  `types.ts` and `M3LOperationPipeline.ts` were the only edits needed.
- **Append-last source-compatibility held** — existing 3-arg `persist`/`finalize`
  implementations in the four consumers compiled and ran correctly while the
  engine was updated; no intermediate breakage.
- **All four Phase 8 review spokes returned no must-fix items** — the
  type-design-analyzer confirmed the contravariance argument; the
  silent-failure-hunter found no new swallowed paths.
- **eks-ops cyclomatic complexity resolved without a second round** — the plan
  anticipated the 4-arm OR chain would exceed the cap of 10 (reaching 13), and
  `ReadonlySet<EksOperation>` constants collapsed both `persist` and `finalize`
  arms to `.has()` calls. The implementer applied this in the first pass.
- **lambda-ops predicate reuse caught during planning** — `isInvokeResult` was
  used in both `finalize` and the post-run completion log. The plan noted the
  second site explicitly; the refactor commit switched the log to
  `outcome.operation === "invoke"` (the pipeline outcome already carries it),
  deleting the predicate fully.
- **`pnpm verify` passed (37 checks, 3 skipped)** after the test-count fix commit
  (see §1 below) — no gate required a second pass.

## What didn't go as planned, and why

### 1. `check:test-counts` failed after T15 was added

`pnpm verify` failed at `check:test-counts` with:
`pipeline: recorded 72 tests, actual 73`. T15 — the new type-level test
asserting the 4th parameter type of `persist` and `finalize` — brought the
pipeline count from 72 to 73, but `docs/implementation-status.md`'s Notes column
still read "72 tests (58 behavioral + 14 type-level)". A standalone `chore:`
commit (`bc18572`) updated the row to "73 tests (58 behavioral + 15 type-level)"
before the push.

**Why it happened:** The Notes column in `docs/implementation-status.md` is
hand-managed and must be updated whenever a test is added to an already-✅
module. The feat commit added T15 but did not include the Notes update in the
same commit — the test-count update was a separate afterthought discovered only
at `pnpm verify`.

**Fix for future:** When adding a type-level or behavioral test to an existing
✅ submodule, update the `docs/implementation-status.md` Notes count in the
_same_ commit as the test. The `check:test-counts` gate runs on every push and
will catch any mismatch — but catching it at the commit boundary is cleaner than
catching it at `pnpm verify` time.

## Lessons learned

- **Update `implementation-status.md` Notes in the same commit as a new test.**
  `check:test-counts` enforces that the "N tests" value in the Notes column of
  any ✅ row matches the live Vitest count. A test added in one commit and the
  count updated in a separate `chore:` commit is allowed but adds noise to the
  history. The cleanest pattern: include the Notes update in the same feat/refactor
  commit that adds the test. _(promoted → .claude/rules/tests.md)_

- **Append-last is the correct semver-minor signature extension pattern.**
  Appending a new arg last to an existing callback type preserves source
  compatibility under `strictFunctionTypes` — existing implementations with fewer
  params stay assignable. Reordering to match other callbacks (operation-first)
  would be source-breaking. The asymmetry this creates (operation-last in
  `persist`/`finalize`, operation-first in other callbacks) must be documented in
  TSDoc `@param` to prevent a future "fix."

- **Call-site multiplicity audit before deleting a predicate.** Each structural
  predicate (`isWaiterResult`, `isInvokeResult`) had a primary use in `finalize`
  and — for `lambda-ops` — a secondary use in the post-run completion log.
  Before marking a predicate for deletion, grep the file for every occurrence:
  `grep -n "isFooResult"` found both call sites in under a second and let the
  refactor plan account for the second site upfront rather than discovering it
  mid-implementation.
