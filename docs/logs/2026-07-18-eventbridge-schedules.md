# Work log — `eventbridge-schedules` script (2026-07-18)

This log covers Unit 2 of the `eventbridge-schedules` plan — the consumer
script itself, run through the `implementing-scripts` pipeline. Unit 1 (the
`aws/eventbridge` library wrapper, `M3LEventBridgeOperations`) merged first as
PR #163 in an earlier session on the same date; this session picked up Unit 2
once that wrapper landed on `main`. It records what shipped, what matched the
plan, two real bugs the RED/GREEN spokes surfaced and fixed, and the durable
lessons.

Plan of record: session-local plan mode file (not committed to the repo),
`docs-roadmap-md-docs-plans-implementati-binary-panda.md` — covered both Unit 1
(`aws/eventbridge`, PR #163) and this Unit 2.

## Summary

Shipped `scripts/eventbridge-schedules/` — a control-plane consumer script
managing EventBridge **rules** (not the separate Scheduler service) via the
injected `AWS.M3LEventBridgeOperations` wrapper. Seven operations: `list`,
`describe`, `create`, `update`, `delete`, `enable`, `disable`. `create`/`update`
both drive the same underlying `PutRule` upsert through a shared internal
`putRuleStep` helper, and may optionally attach targets in the same call via a
`targets` JSON config field (`putTargets` afterward, logging but never throwing
on per-entry failures — matches the wrapper's own contract). Mutating
operations are confirm-gated (bypassable via `yes`, bypass always logged);
`list`/`describe` are never gated.

- 14 `src/` files: `main.ts`, `config.ts`, `hooks.ts`, and 11 files under
  `src/steps/` (`run-eventbridge-schedules`, `destructive-gate`,
  `config-helpers`, `list-rules`, `describe-rule`, `put-rule`, `create-rule`,
  `update-rule`, `delete-rule`, `enable-rule`, `disable-rule`).
- 117 tests across 12 files under `scripts/eventbridge-schedules/tests/`.
- Full workspace suite: 3596/3596 tests. `typecheck`, `lint`, `build`,
  `check:script-scaffold`, `knip` all clean.
- Smoke run (`pnpm --filter @m3l-automation/eventbridge-schedules start`, no
  config) confirmed correct end-to-end wiring: boots, loads config, fails
  loud with a typed `M3LConfigMissingError` for the missing required
  `aws.profile` — the expected no-config behavior.
- Review fan-out (code-reviewer, security-reviewer, silent-failure-hunter):
  zero must-fix across all three; security verdict SAFE. 4 should-fix applied
  (duplicated config-read helpers consolidated, inconsistent error-context
  richness standardized, misleading "EventBridge Scheduler" doc wording
  fixed, `targets` shape-validation error enriched with diagnostic context).
- `/syncing-docs` full 14-step pass clean (one broken ADR link caught and
  fixed along the way).
- `docs/ROADMAP.md`/`docs/plans/IMPLEMENTATION.md`'s shared W3 row split:
  `eventbridge-schedules` now has its own **done** row; the other five W3
  scripts remain pending on their own row, mirroring the W2 per-script-row
  convention.

Skills used: starting-work, implementing-scripts, syncing-docs,
writing-work-logs.

## What went as planned

- **The pre-RED contract-extraction pass paid for itself immediately.** A
  `spec-conformance-reviewer` spoke was dispatched in contract-extraction
  mode against the hub-authored draft contract page _before_ any RED test was
  written. It returned a fully self-contained, pinned specification — exact
  config parameter list, exact file list, exact per-step guard
  messages/error codes, exact dispatch switch — that was handed verbatim to
  every RED and GREEN spoke. None of them needed to read the doc page
  themselves, and the contract itself caught 3 real errors in the hub's
  draft before a single line of test/implementation code existed (see
  Lessons learned).
- **RED failed for the right reason across all 12 files.** Three parallel
  `test-author` spokes (config/hooks/dispatcher/gate;
  list/describe/put-rule; create/update/delete/enable/disable) all confirmed
  their tests failed on module-not-found or missing real behavior — never a
  typo or a logic error in the test itself.
- **The dependency-ordered two-wave GREEN split worked cleanly.**
  `create-rule.ts`/`update-rule.ts`/the dispatcher/`main.ts` all depend on
  `put-rule.ts` and the seven op-step files existing (TypeScript needs the
  dynamic-import targets to resolve for type-checking). Splitting GREEN into
  wave 1 (three independent parallel spokes) then wave 2 (one spoke, after
  wave 1 landed) avoided any spoke transiently typechecking against
  not-yet-written sibling files.
- **Security review came back clean with zero must-fix or should-fix.** The
  destructive-gate coverage (`MUTATING_OPERATIONS` matching the dispatch
  switch 1:1, unconditional bypass logging), no secret/credential handling
  beyond the standard `aws.profile` seam, and no injection surface all
  verified clean on the first pass.
- **`pnpm knip` caught something the review spokes didn't.** After the
  should-fix remediation pass, `knip` flagged two config.ts exports
  (`EVENTBRIDGE_SCHEDULES_OPERATIONS`/`EVENTBRIDGE_SCHEDULES_STATES`) that
  nothing outside the file ever imported — the dispatcher had hardcoded its
  own literal mutating-ops set instead of importing the exported constant.
  A quick, cheap gate finding a real (if minor) drift that three review
  spokes missed, because it's a different kind of check (static reachability,
  not judgment).

## What didn't go as planned, and why

### 1. Two test-fixture bugs slipped through RED and were only caught during GREEN verification _(promoted → .claude/agents/test-author.md, .claude/rules/tests.md)_

Two separate, unrelated bugs in test files (not implementation code) surfaced
while `code-implementer` spokes verified their own scope during GREEN:

- Three test files (`list-rules.test.ts`, `describe-rule.test.ts`,
  `put-rule.test.ts`) built their fake `AWS.M3LEventBridgeOperations` object
  via `{...} satisfies Partial<X> as unknown as X`. The intermediate
  `satisfies Partial<X>` step itself failed `TS2322`, because an untyped
  `vi.fn()` (inferred as `Mock<Procedure | Constructable>`) doesn't
  structurally satisfy a specific method signature like
  `(name: string, options?: ...) => Promise<M3LEventBridgeRuleDetail>`. This
  wasn't caught during RED because Vitest transforms without full
  type-checking — the tests ran and failed for the _intended_ reason, but a
  real `tsc --noEmit` error was hiding underneath.
- `create-rule.test.ts`/`update-rule.test.ts`'s "targets attached" tests set
  a raw JS array as the `targets` config value instead of
  `JSON.stringify`-ing it first. Since `M3LConfig` never coerces stored
  values and the real implementation reads `targets` as a string, the raw
  array was silently treated as absent — `putTargets` was never actually
  called, so the test's assertion never exercised the behavior it claimed to
  cover. `put-rule.test.ts`, written by a different spoke in the same RED
  wave, had the correct `JSON.stringify` pattern from the start.

Both were fixed via small, tightly scoped `test-author` dispatches, verified
against the already-established correct patterns elsewhere in the repo
(`httpFakes.ts` for the cast; `put-rule.test.ts` for the stringify).

**Why it happened:** Three independent test-author spokes wrote 12 test
files in parallel from the same contract, and two small conventions (how to
cast a fake class instance safely; that a JSON-string config parameter needs
`JSON.stringify` at the call site) weren't spelled out explicitly enough in
the contract or the per-spoke prompts, so two of three spokes solved them
correctly by pattern-matching existing code and one didn't in each case.
Neither bug was visible from RED alone — Vitest's lack of full type-checking
masked the cast bug, and a silently-treated-as-absent config read masked the
stringify bug (the test still "passed," just without exercising the
behavior).

**Fix for future:** When multiple test-author spokes write fixture helpers in
parallel against the same class-typed dependency, name the exact established
cast pattern (`as unknown as X`, no intermediate `satisfies` step, citing the
existing precedent file) directly in the dispatch prompt rather than relying
on each spoke to independently discover it. For a JSON-string config
parameter, state explicitly in the contract that the test must
`JSON.stringify` the value before `config.set(...)`, not just that the field
"accepts a JSON array" — the string-vs-value distinction is exactly the kind
of thing that reads as obvious once written down but is easy to miss when
inferring from a type description alone.

### 2. A should-fix remediation spoke's final report was truncated mid-sentence

The `code-implementer` spoke applying the four should-fix findings (helper
consolidation, wording fixes, error-context enrichment) returned a
one-line report — `"117/117 still passing. Now the builds."` — that read as
a mid-thought fragment rather than a completion summary.

Per this repo's truncation-recovery convention, the fragment was not trusted
at face value: I read the spoke's own journal file first (which recorded all
four fixes as applied, in order, before the verification section began), then
ran `tsc`/`vitest`/`eslint`/`prettier`/`build` myself directly rather than
re-dispatching or asking the spoke to re-confirm. Everything was in fact
already clean — the truncation cut off only the reporting, not the work.

**Why it happened:** The should-fix dispatch's verification section asked
for five separate commands in sequence (`tsc`, `vitest`, `eslint`,
`prettier`, two `build` invocations); the spoke's turn appears to have ended
partway through composing its final summary after those commands completed,
not partway through the work itself.

**Fix for future:** This is exactly the scenario `subagent-dispatch.md`
already covers — verify on-disk state / re-run the checks yourself rather
than trusting a short or oddly-terminated report, whether or not it looks
"complete enough." No new rule needed; this is one more data point that the
existing checklist item continues to hold and is cheap to apply (running five
verification commands myself took under two minutes).

## Lessons learned

- **Contract-extraction as its own phase, before any RED test, is worth the
  dispatch.** Handing a `spec-conformance-reviewer` spoke a draft contract
  page and every relevant source file, and asking it to return a pinned,
  self-contained specification, caught three real errors (wrong exporter
  format value, wrong exporter class for a single-document write, an
  incorrect assumption about error-subclass shape) before a single test or
  implementation line existed — each of which would otherwise have
  propagated into 2-3 RED test files and needed a rework round. For a script
  or submodule with a non-trivial external API surface (here, a library
  wrapper with format/shape nuances the doc page's author had to guess at),
  budget this as an explicit up-front spoke dispatch, not something folded
  into the first `test-author` call.
- **Multiple test-author spokes writing fixture helpers in parallel need the
  exact cast/serialization pattern spelled out, not just the target type.**
  Two of three RED-wave spokes independently reached for the correct
  `as unknown as X` cast and `JSON.stringify` patterns by finding existing
  precedent; the third didn't. When dispatching parallel writer spokes
  against a shared class-typed dependency or a JSON-string config field,
  name the established pattern explicitly (with a file:line precedent to
  copy) in the prompt rather than trusting independent pattern-matching to
  converge.
- **`pnpm knip`'s anti-hollow-export gate is a distinct, useful check from
  code review.** A hub-visible export existing with zero real importers is a
  reachability fact, not a judgment call — three review spokes correctly
  focused on logic/security/error-handling and simply weren't looking for
  it. Always run the full script-specific gate set (`check:script-scaffold`,
  `knip`) as its own step after should-fix remediation, not folded silently
  into "the reviewers already covered code quality."
  _(promoted → .claude/skills/implementing-scripts/SKILL.md, .claude/rules/scripts.md)_
- **A short, oddly-phrased final report from a spoke is worth a two-minute
  direct verification, not a re-dispatch.** The should-fix spoke's journal
  plus a direct re-run of the five gate commands confirmed everything was
  actually done in under two minutes — cheaper than resuming the spoke and
  much cheaper than assuming failure and redoing the work. Confirms the
  existing `subagent-dispatch.md` guidance rather than adding anything new.
