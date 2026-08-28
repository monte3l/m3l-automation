# V4 — `aws/bedrock-runtime` typed wrapper (#541, ADR-0059)

**Status: slice 1 of 2 shipped** (branch `feat/v4-bedrock-runtime`; slice 2 —
streaming — not yet started, tracked separately)

## Context

Issue #541 is the V4 row of the agent-operator wave (ADR-0058), gated open by
ADR-0039's activation condition: a named consumer (`scripts/agent-operator`,
V8/#545) that genuinely needs LLM inference. ADR-0059 is the intake-gate
decision for the wrapper itself, scoped at implementation time within V4
(single-shot + streaming invocation) and V5 (tool-use loop primitives, a
separate future change).

Two of ADR-0059's premises needed re-verification before implementation could
start: it named the wrapper's target as "the Bedrock Messages API" without
picking between `Converse` and `InvokeModel`, and it claimed the module would
be "the library's first `AsyncIterable` contract" — refuted against live repo
state (`aws/s3.listObjects`, `aws/dynamodb.queryItems`/`scanSegment`,
`core/importers.importStream`, `core/messaging.read` already ship
`AsyncGenerator`/`AsyncIterable`). Both were resolved before RED: `Converse`/
`ConverseStream` (the typed, model-agnostic surface — no per-model JSON body
hand-rolling) over `InvokeModel`, and ADR-0059 corrected with a dated Update
block rather than left standing on a false "first" claim.

## Approach / Decisions

- Isolation: linked worktree (`pnpm worktree:new v4-bedrock-runtime`), single
  branch so far — ADR-0072 slicing plans 2 PRs (core wrapper, then streaming),
  this session shipped slice 1 only.
- Dependency gate: `@aws-sdk/client-bedrock-runtime@3.1115.0` approved,
  exact-pinned to match all 17 sibling `@aws-sdk/client-*` packages.
- Contract-settling pass (before RED, per the `aws/*` practice): read the
  installed SDK `dist-types` directly rather than trusting the ADR's intent —
  found stream-lifecycle exceptions (`ThrottlingException`,
  `ModelStreamErrorException`, etc.) arrive **in-band** as yielded
  `ConverseStreamOutput` union members, not thrown from iteration — a fact
  that shapes slice 2's design and is recorded on the reference page for that
  slice to re-verify at its own kickoff.
- Slice 1 scope: `M3LBedrockRuntimeOperations.invoke()` (model-id fallback
  registry, token usage capture, `AbortSignal` cancellation), the three error
  classes (`M3LBedrockRuntimeOperationError`/`ModelError`/`NoModelError`), and
  a new `AWSClientProvider.bedrockRuntime` getter — deliberately **no**
  `AWSServiceProvider` convenience getter, since the model fallback list is
  caller-specific configuration with no library-owned default (unlike every
  other `*Operations` wrapper).
- Fault handling classifies by SDK exception `name` before any retry runner,
  never by `$metadata.httpStatusCode` — a name-scoped `M3LRetryRunner`
  classifier retries `ThrottlingException`/`InternalServerException` same-model
  only, deliberately narrower than reusing `M3LPollingPolicies.awsThrottling()`
  wholesale, which would incorrectly retry a `ServiceUnavailableException` (a 503) on the same model.

## Review and fix rounds

5-spoke review (code-reviewer, spec-conformance-reviewer, security-reviewer,
silent-failure-hunter, type-design-analyzer) found zero spec drift and zero
security Must-fix, but converged on real gaps:

- **silent-failure-hunter (HIGH):** `M3LBedrockRuntimeNoModelError` never
  chained a `cause`, so fallback exhaustion was undiagnosable — indistinguishable
  between a throttling storm and a misconfigured model list. Fixed by
  threading the last per-attempt fault through `ModelAttemptOutcome`.
- **code-reviewer (Must-fix):** two `AbortSignal` branches uncovered, contradicting
  the commit's own "100% coverage" claim. Closed with two targeted tests.
- **type-design-analyzer + security-reviewer (independently convergent
  Should-fix):** `models: readonly string[]` left its non-empty invariant to a
  runtime throw only — strengthened to a type-level non-empty tuple, runtime
  guard kept as defense-in-depth for a config-sourced downcast. `stopReason`
  admitted unchecked into a closed 9-member type callers switch on
  exhaustively — now validated against a `Record`-keyed membership set.

A bounded confirmation re-review (the reviewers whose findings drove the
fixes, scoped to the changed files) then caught a genuine miss: the abort-race
catch-block check reclassified **any** rejection as aborted merely because the
signal was concurrently aborted, silently discarding a real `ValidationException`
or similar — diverging from the exact `aws/athena/client.ts` precedent it cited
without actually matching (`isAborted(signal) && isAbortError(error)`, not
`isAborted(signal)` alone). Fixed, plus two low-severity security-reviewer
polish items (a misleading "missing" message on a present-but-invalid
`stopReason`; the prompt-leak doc note widened to cover `NoModelError`'s new
`cause`).

## Outcome

40 tests in `tests/bedrock-runtime.test.ts` (100% statement/branch/function/line
coverage) + a barrel-reachability row in `tests/index.test.ts`. Full-workspace
`pnpm verify` (48/48 applicable steps), `pnpm build`/`test`/`typecheck`/`lint`,
and `pnpm knip` all green. `/syncing-docs` reconciled AWS 19 → 20 across every
count site plus a new provenance sidecar for `docs/reference/aws/bedrock-runtime.md`.

An unrelated pre-existing bug surfaced and was fixed along the way: the
initial scaffolding edit to `docs/implementation-status.md` matched a
truncated grep-preview of the `rds-data` row instead of its full line,
splicing the file mid-line and leaving `rds-data`'s Notes column empty with
its content reattached to the new `bedrock-runtime` row — caught by re-reading
the table before the doc-reconciliation pass, not by any gate.

Issue #541 stays open — ADR-0059's V4 row and the tracker text both describe
"single-shot + streaming" as one deliverable, and only single-shot has
shipped. Slice 2 (`invokeStream`, `M3LBedrockStreamEvent`, in-band exception
discrimination over `ConverseStreamOutput`) is the remaining work before the
row flips to Done and `pnpm sync:hub` can archive the issue.
