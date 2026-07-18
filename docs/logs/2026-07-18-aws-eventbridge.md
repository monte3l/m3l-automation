# Work log — `aws/eventbridge` submodule (2026-07-18)

This log covers implementing the `aws/eventbridge` submodule (Unit 1 of the
`eventbridge-schedules` two-unit plan) end-to-end through the
`scaffolding-submodules` → `implementing-submodules` pipeline: contract
extraction, RED, GREEN, a 5-spoke review fan-out, should-fix remediation, and
full doc reconciliation. It records what shipped, what matched the plan, and
one real divergence (a stalled review dispatch).

Plan of record: [`docs-roadmap-md-docs-plans-implementati-binary-panda.md`](C:\Users\enri3.claude\plans\docs-roadmap-md-docs-plans-implementati-binary-panda.md)

## Summary

The task began as "scaffold + implement `eventbridge-schedules` over the
existing `eventBridge` getter." Pre-implementation research (two parallel
Explore agents) falsified that premise: scripts are hard-forbidden from
importing `@aws-sdk/*` (ADR-0029), so they can only reach AWS through a
high-level `aws/*` operations wrapper — and no `aws/eventbridge` wrapper
existed. The raw `eventBridge` client getter is the credential/client
seam, not a consumable operation surface. `docs/ROADMAP.md`'s W3 note
("existing getters ✓") for `eventbridge-schedules` was inaccurate; the real
shape is two sequential PRs — this library wrapper first, then the script.
The user confirmed that corrected two-unit scope before any code was written.

**Shipped:** `M3LEventBridgeOperations` (9 methods: list/describe/put/
delete/enable/disableRule, list/put/removeTargets) + `M3LEventBridgeOperationError`

- 17 plain types, scoped to EventBridge rules and basic target wiring
  (Scheduler service and per-service target parameter blocks explicitly
  deferred). `AWSClientProvider.eventBridgeOperations` getter wired, mirroring
  `sqsOperations`. 59 tests in `tests/eventbridge.test.ts` + 4 new provider-getter
  tests in `tests/clients.test.ts` (173 total in that file); `client.ts` 100%
  stmts/100% functions/93.33% branches, `provider.ts` getter fully covered.
  Full workspace suite: 2483/2483 tests, typecheck/lint/build all green.
  27/27 submodules now implemented+reviewed. Committed as `0935a9b feat(aws):
implement aws/eventbridge M3LEventBridgeOperations`.

**Review verdict (5 dimensions, fanned out in parallel):** `code-reviewer`
(two scoped splits after a stall — see divergence below), `spec-conformance-reviewer`,
`security-reviewer`, `type-design-analyzer`, `silent-failure-hunter` — **zero
must-fix** across all five. Three should-fix items: (1) `M3LEventBridgePutRuleInput`
converted from a flat interface to a discriminated union enforcing exactly
one of `eventPattern`/`scheduleExpression` at compile time — fixed; (2) a
`""`-sentinel pattern on required `name`/`arn`/`ruleArn` fields — left as-is,
matches established `aws/sqs` precedent, changing it here would diverge from
the shipped sibling; (3) a stale "SCAFFOLD STATUS: RED by design" test-file
header comment — fixed here, and the same pre-existing issue (found by the
same reviewer) was fixed in the already-shipped `aws/sqs`'s `sqs.test.ts` as
a separate standalone PR (#161).

Also corrected the `docs/ROADMAP.md`/`docs/plans/IMPLEMENTATION.md` W3 tracker
row for `eventbridge-schedules` to reflect the real dependency on this new
wrapper, and flagged an unrelated pre-existing doc gap (4 AWS submodule pages
missing from `docs/README.md`'s TOC, surfaced by a `docs-consistency-reviewer`
pass on the separate #161 PR) as its own follow-up task rather than folding it
into this PR.

Skills used: `starting-work`, `scaffolding-submodules`, `implementing-submodules`,
`syncing-docs` (×2 — once per branch), `creating-prs`, `writing-commits` (×2),
`writing-work-logs`.

## What went as planned

- **The corrected two-unit plan held up exactly as scoped.** Once the
  premise was fixed (wrapper-first, script-second), the rest of the session
  executed the standard `scaffolding-submodules` → `implementing-submodules`
  pipeline with no further scope surprises.
- **Contract extraction (Phase 1) was clean on the first pass.** The
  `spec-conformance-reviewer` in contract mode found zero discrepancies
  between the hand-authored spec page and the hand-scaffolded `types.ts`/
  `client.ts` signatures — a useful confirmation that writing the doc page and
  the scaffold skeleton together (both done by the hub in the same session,
  informed by directly reading the SDK's `.d.ts` command/model types) kept
  them in lockstep from the start.
- **RED failed for the right reason.** All 4 non-type-level tests in the
  original 5-test scaffold seed, and later all newly-authored tests in the
  231-test expansion, failed with the placeholder's `"... not yet
implemented"` `M3LEventBridgeOperationError` — never a type error or import
  failure.
- **GREEN was clean on verification, with one legitimate coverage gap
  self-reported.** `code-implementer` reported 8 uncovered branches (response-side
  optional-field defaults never exercised by a passing test) rather than
  padding coverage by deleting code or asserting nothing — flagged accurately
  as a test-author follow-up rather than silently left ambiguous. (These 8
  branches were subsequently covered by the full 231-test RED/GREEN pass that
  followed; final `client.ts` branch coverage landed at 93.33%, well past the
  80% gate.)
- **The discriminated-union should-fix required zero `client.ts` changes.**
  `code-implementer` correctly predicted (and confirmed via typecheck) that
  `input.eventPattern`/`input.scheduleExpression` property access against the
  new union type still resolves to `string | undefined` on both branches, so
  the existing conditional-spread mapping code needed no edits — only
  `types.ts` and the doc page changed.
- **Doc reconciliation (`/syncing-docs`) surfaced no real drift.** The one
  friction point was mechanical (see divergence 2 below), not a content
  problem — the hand-authored provenance sidecar validated cleanly on the
  first `check-doc-provenance.mjs` run.

## What didn't go as planned, and why

### 1. The initial full-diff `code-reviewer` dispatch stalled for over an hour

The Phase 4 review fan-out dispatched `code-reviewer` against the entire
diff at once (5 files, 1,560 lines changed, plus an instruction to
cross-reference the `aws/sqs` sibling module). The other four review spokes
in the same fan-out (`spec-conformance-reviewer`, `security-reviewer`,
`type-design-analyzer`, `silent-failure-hunter`) all completed in 8–78
minutes with clean, thorough reports. `code-reviewer` alone ran past an
hour with no completion or error signal. The user asked twice to check on
it; both `TaskOutput` polls showed `status: running` with no way to inspect
partial progress (no journal file had been given to this read-only review
spoke, unlike the RED/GREEN spokes). On the user's direction, it was
stopped via `TaskStop`, its output confirmed via `git status` to be
side-effect-free (it's read-only, so no risk in killing it), and
re-dispatched as two narrower scoped splits — one over just the 4 new
`aws/eventbridge/*.ts` files, one over `provider.ts`/barrel/tests. Both
completed cleanly in ~8 minutes each with zero must-fix findings.

**Why it happened:** The `implementing-submodules` skill's "Size the
dispatch now, before RED/GREEN" guidance (Phase 1, contract sizing) was
never extended to Phase 4 review dispatches. A single-turn review spanning
5 files and 1,560 lines, with an explicit instruction to cross-reference a
6th file, is the same class of oversized-turn risk the RED/GREEN sizing
guidance was written to prevent — it just wasn't applied there.

**Fix for future:** Apply the same dispatch-sizing discipline to Phase 4
review fan-outs as Phase 1–3: if a diff exceeds roughly 3–4 files or a few
hundred lines, split the review into scoped sub-dispatches (by concern —
core module vs. integration/tests — or by file group) from the start,
rather than waiting for a stall to force a retroactive split.

### 2. `pnpm sync:docs` (the composite doc-reconciliation entry point) failed on pre-existing staleness warnings it should have deferred to step 2

Running the preferred composite entry point (`pnpm sync:docs`) on the
`fix/stale-sqs-test-header` branch and again on `feat/aws-eventbridge`
both times exited non-zero at "Provenance pre-flight" (step 1) on
ordinary `⚠ stale — re-verify` warnings — exactly the condition the
`/syncing-docs` skill's own Step 1 documentation says is fine
("Staleness warnings are fine here; they will be cleared in step 2").
Fell back to the documented manual sequence (`check-doc-provenance.mjs` →
`--update` → `gen:counts` → …), which worked exactly as described.

**Why it happened:** `bin/sync-docs.mjs`'s step-1 gate appears stricter
than the skill's own prose describes — it treats non-fatal staleness
warnings as a hard stop rather than deferring them to the `--update` step,
diverging from the documented (and correct) manual-sequence behavior.

**Fix for future:** Either fix `bin/sync-docs.mjs`'s step-1 exit-code
logic to match the documented behavior (warn-only, don't stop), or update
the skill's Step 0 prose to say the composite entry point currently
requires a clean pre-flight (no staleness) and route straight to the
manual sequence whenever any sidecar is known to be stale going in —
flagged as a standalone follow-up task rather than fixed inline, since
it's a change to shared tooling outside this submodule's scope.

## Lessons learned

- **A large review diff can stall a spoke for an hour with no error signal.**
  The repo's subagent-dispatch rule already tells the hub to split large
  RED/GREEN work into bounded sub-dispatches up front; this session showed
  the same risk on the review side — a 5-file, 1,560-line diff (plus an
  instruction to cross-reference a sibling module) stalled `code-reviewer`
  for over an hour, while four sibling spokes on related but smaller scopes
  completed cleanly in 8–78 minutes. Splitting the stalled review into two
  narrower scoped dispatches after the fact resolved it (~8 minutes each,
  zero must-fix). Not folded into a durable rule this time — documenting the
  incident here so a future recurrence has precedent to reason from.
- **A stalled read-only spoke is safe to kill and inspect.** Before killing,
  confirming the spoke's tool grants are read-only (via its agent
  definition) and checking `git status`/`git diff --stat` afterward gives a
  cheap, reliable signal that nothing was lost — the working tree state is
  the ground truth, not the spoke's own (possibly truncated) final report.
- **Verify a plan's premise before executing it, even when the user has
  already answered clarifying questions.** The user's first answer ("EventBridge
  rules via existing getter, no library prerequisite") was reasonable given
  what was visible at the time, but two Explore agents dispatched for the
  _design_ phase (not just requirements-gathering) independently falsified it
  by actually tracing the ESLint-enforced no-SDK-import boundary. Treat an
  early scoping answer as provisional until the design-phase research
  confirms the mechanism it assumes actually exists.
- **A hand-scaffolded contract stays consistent with its scaffold when both
  are written by the same hand in the same pass.** Reading the AWS SDK's
  `.d.ts` files directly (command inputs/outputs, not just prose docs) before
  writing both the spec page and the placeholder `client.ts` signatures
  avoided any doc/scaffold drift — confirmed by the Phase 1 contract-mode
  review finding zero discrepancies.
