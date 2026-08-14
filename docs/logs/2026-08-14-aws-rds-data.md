# Work log — `aws/rds-data` submodule (2026-08-14)

This log covers PR 1 of the issue #204 two-PR chain (`aws/rds-data` wrapper +
the `rds-data-sql` consumer script): the ADR-0031-gated Aurora PostgreSQL RDS
Data API wrapper, from initial audit through the full
`scaffolding-submodules` → `implementing-submodules` pipeline. It records
what shipped, a five-round Phase 4 review saga that is the log's main
content, and the durable lessons that came out of it.

Plan of record: `/home/enri3l/.claude/plans/issue-204-this-is-tidy-taco.md`
(outside the repo — a Claude Code plan-mode artifact, not a `docs/plans/`
file, so it is not linked here)

## Summary

Shipped `packages/m3l-common/src/aws/rds-data/{client.ts,error.ts,types.ts,index.ts}`
(`M3LRDSDataOperations` — `executeStatement`/`batchExecuteStatement`/
`beginTransaction`/`commitTransaction`/`rollbackTransaction`/`withTransaction`;
`M3LRDSDataOperationError`/`M3LRDSDataResultTooLargeError`; 11 plain types
including a discriminated `M3LRDSDataValue` union preserving the RDS Data
API's typed `Field` shape rather than coercing to strings, unlike
`aws/athena`'s `AthenaRow`), plus the `AWSClientProvider.rdsData` raw getter
and `AWSServiceProvider.services.rdsDataOperations` memoized wrapper getter.
New exact-pinned dependency `@aws-sdk/client-rds-data@3.1105.0`. Two new
error codes registered in `M3L_ERROR_CODES`/`M3L_ERROR_CATALOG`.

Final state: 52 tests in `tests/rds-data.test.ts` + getter coverage in
`tests/clients.test.ts`/`tests/index.test.ts` (`AWS_WIRED_SUBMODULE_COUNT`
16→17); full workspace suite 7269 tests, typecheck, lint, build all green;
`pnpm verify` 36/36 applicable steps passed (3 correctly skipped: gitleaks,
frozen-lockfile install, push-only hub-drift). 40 of 40 submodules now
documented (Core 21 + AWS 19). Review verdict: `code-reviewer` PASS,
`spec-conformance-reviewer` non-conformant→conformant after fixes,
`security-reviewer` FAIL→FAIL→PASS across three passes, `silent-failure-hunter`
PASS (one should-fix, resolved as a side effect of a later rewrite),
`type-design-analyzer` PASS with no must-fix.

**Known limitation, not yet closed:** no live Data-API-enabled Aurora
cluster was reachable from this session, so the module was never smoke-run
end-to-end against real infrastructure — only against mocked
`@aws-sdk/client-rds-data` responses. This verification is still owed before
merge, ideally alongside PR 2's script-level testing.

Skills used: auditing, starting-work, scaffolding-submodules,
implementing-submodules, syncing-docs, writing-work-logs.

Spoke incidents: none (no truncations, no stalls, no `SendMessage` resumes —
every dispatch returned a complete report within its turn).

## What went as planned

- **The audit and build-vs-reject decision converged cleanly.** Three parallel
  Explore agents plus direct hub verification found the per-consumer-need
  gate was genuinely open (a reachable Data-API-enabled Aurora cluster) and
  that ADR-0031 had already pre-cleared every hard design question — the
  audit → clarifying-questions → plan-mode loop needed no rework.
- **RED failed for the right reason on the first pass.** `test-author`
  correctly caught its own subtle bug before reporting done: one test called
  the SUT twice against a single queued mock rejection, and the pattern was
  found and consolidated to the file's own single-call idiom before handoff.
- **GREEN's core module logic was clean on the first implementer dispatch.**
  46/46 tests passed, typecheck/lint clean, no re-dispatch needed for the
  `Field`↔`M3LRDSDataValue` mapping, the `ColumnMetadata.nullable` JDBC
  encoding, or the retry-classifier composition.
- **Provider wiring correctly refused to cross the writer-boundary.** The
  `code-implementer` spoke assigned the getter-wiring sub-task explicitly
  declined to touch `tests/clients.test.ts`/`tests/index.test.ts` even
  though the dispatch prompt listed them in scope, citing the strict
  writer-role invariant — exactly the behavior the hub-and-spoke model
  depends on, holding even under an imprecise instruction.
- **The contract-extraction pass against real SDK dist-types earned its
  keep.** `spec-conformance-reviewer`'s Phase 1 pass, run before any test
  was written, found eight real discrepancies between the hand-drafted doc
  and the installed `@aws-sdk/client-rds-data`'s actual types (the
  `includeResultMetadata` omission that would have silently broken
  `columns` on every call is the standout) — all fixed in the doc before
  `test-author`/`code-implementer` ever touched code, so none of them
  surfaced as a later review finding.

## What didn't go as planned, and why

### 1. `withTransaction`'s rollback-failure fix took five rounds to converge

The Phase 4 review fan-out (5 spokes) converged independently on a real bug:
when `fn` throws inside `withTransaction` and the subsequent rollback also
fails, the original implementation discarded `fn`'s error entirely and
surfaced only the rollback failure — the exact inverse of the documented
contract ("both errors stay reachable"). Four reviewers found this
independently in one pass, which was reassuring; fixing it durably was not
one round:

1. **Round 1 fix** attached the rollback failure onto `fn`'s error's `.cause`
   only when that `.cause` was `undefined` — passed the existing tests, but
   a hub read of the diff caught, before dispatching review, that a `fn`
   error which already carried its own `cause` would silently drop the
   rollback failure again, in a narrower form.
2. **Round 2 fix** generalized to walking `fn`'s error's own `.cause` chain
   to find the first open slot — closed the narrower gap, confirmed by a
   new adversarial test.
3. **Round 3** — an adversarial `security-reviewer` pass (dispatched
   specifically because the fix mutates an object across a security-relevant
   error-handling boundary) executed the fix against a frozen/sealed/
   accessor-`cause` error and found the unguarded `.cause` assignment threw
   a raw `TypeError` that escaped the helper, destroying _both_ errors —
   strictly worse than the original bug. The same pass separately flagged
   `mapValueToField`'s unmapped-kind fallback as an unbounded,
   unsanitized log-injection vector.
4. **Round 4 fix** wrapped the assignment in `try`/`catch` and sanitized the
   kind-description message — but the _reads_ of `.cause` (the open-slot
   check and the chain-walk step) were still unguarded, and success was
   inferred from "the assignment didn't throw" with no read-back check.
5. **Round 5**, a final confirmation pass, executed a throwing-getter/Proxy
   probe (broke the unguarded reads) and a no-op-setter probe (broke the
   missing read-back check) — both closed by unifying each link's full
   read-then-write into a single `try`/`catch` per iteration, with a
   read-back verification (`link.cause === rollbackError`) before reporting
   success.

**Why it happened:** each fix round closed the exact failure mode the
_previous_ round's reviewer demonstrated, but the fix was designed reactively
around that one probe rather than against the general principle ("any
mutation of an object this code does not own can fail in more ways than
`undefined`-check-then-assign accounts for — both the read and the write can
throw, and a non-throwing write does not guarantee a stored value"). Each
round's fix was locally correct and test-covered; the _class_ of gap it
belonged to was never named until the adversarial security passes started
constructing genuinely hostile inputs (frozen objects, Proxies, no-op
setters) instead of just "a plain error with an existing cause."

**Fix for future:** when a fix touches a property on an object the module
does not construct/own (especially mutating a caught error's `.cause`),
design for the adversarial input class up front — guard every read AND
write of that property in one `try`/`catch`, and verify a write actually
took effect by reading it back rather than trusting the absence of a throw.
Don't wait for round 3's security pass to introduce this framing; ask "what
if this property is an accessor, or frozen, or a Proxy trap?" during the
first implementation, not after three narrower probes have already landed.

## Lessons learned

- **A first-pass Phase 1 contract-extraction against real SDK dist-types
  prevents entire review rounds.** The eight discrepancies
  `spec-conformance-reviewer` found before any code existed (in particular
  the `includeResultMetadata` omission — the module would have silently
  returned empty `columns` on every real call) never resurfaced as Phase 4
  findings, because they were never implemented wrong in the first place.
  This is strong evidence for keeping the "verify against `dist-types`
  before dispatching test-author" step mandatory for any AWS wrapper beyond
  a plain `.send()` call.
- **Guard reads and writes together, and verify with a read-back — never
  infer success from "the assignment didn't throw."** A property mutation on
  an object the module doesn't own (an accessor, a frozen object, a Proxy
  trap, a silently no-op setter) can fail in ways that a `try`/`catch`
  around only the write, or a bare `=== undefined` check on the read, does
  not cover. This cost three of the five fix rounds on `withTransaction`.
  _(promoted → `.claude/rules/library-src.md`)_
- **An adversarial security pass on a just-landed fix is worth dispatching
  even when the fix already has passing tests.** Rounds 3 and 5's
  `security-reviewer` passes each found a real, demonstrable regression in
  code that was fully green against its own test suite — the tests
  described the _intended_ behavior, not the space of hostile inputs that
  could defeat the _mechanism_. For any fix touching error-object mutation
  or a security-relevant boundary, treat "tests pass" as necessary, not
  sufficient, before closing the review loop.
- **The hub reading the diff itself, not just the spoke's summary, caught a
  real gap before it reached review.** The round-1→round-2 escalation
  happened because the hub read `attachRollbackFailure`'s actual code after
  the "48/48 passed" report and noticed the `cause === undefined` condition
  was too narrow — this would have shipped to Phase 4 review anyway and
  been caught there, but catching it one step earlier avoided a wasted
  full 5-reviewer fan-out on a fix already known to be incomplete.
- **Writer-role boundaries hold even under an imprecise dispatch.** Telling
  `code-implementer` to touch two test files "in scope" did not make it do
  so — it declined and routed the work back to the hub for a `test-author`
  dispatch instead. Worth trusting this invariant rather than re-verifying
  it defensively on every dispatch.
