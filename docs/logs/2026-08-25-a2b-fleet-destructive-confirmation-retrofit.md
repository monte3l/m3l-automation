# Work log — `a2b-fleet-destructive-confirmation-retrofit` (2026-08-25)

Covers issue #483 (A2b) — the fleet-wide retrofit that wires ADR-0048's
target-graded destructive-confirmation gate (`target`/`isSensitiveTarget`/
`yesSensitive` on `Core.confirmDestructive` and `M3LOperationPipeline`'s
`destructive` option, shipped library-only by PR #482/A2) into all 15
confirmDestructive/pipeline-destructive call sites across 11 consumer
scripts. Records what shipped, a confirmed defect a review pass found and
fixed, an unplanned merge conflict with a parallel fleet retrofit (#654), and
the durable lessons from both.

Plan of record:
[`docs/plans/archive/2026-08-25-a2b-fleet-destructive-confirmation-retrofit.md`](../plans/archive/2026-08-25-a2b-fleet-destructive-confirmation-retrofit.md)

## Summary

Wired `target`/`isSensitiveTarget`/`yesSensitive` into 11 scripts:
`s3-objects`, `cloudformation-stacks`, `eks-ops`, `ecs-ops`, `lambda-ops`,
`codepipeline-ops` (pipeline-style, non-optional `awsTarget` threaded through
`Deps` + a hard `main.ts` guard), `dynamodb-crud`, `api-gateway-client`,
`rds-data-sql`, `sqs-etl` (4 call sites), `eventbridge-schedules`
(direct-call). `dynamodb-crud` stays non-bypassable by design (only
`target`/`isSensitiveTarget`, no `yesSensitive`); `api-gateway-client`'s
`aws.profile` is genuinely optional, so `target` is a conditional spread
instead of a hard guard. Two scope corrections were found during
implementation and folded in: `api-gateway-client` actually has two call
sites (`single-request.ts` + `batch-request.ts`, not one), and `sqs-etl`'s
`aws.profile` was missing the `nonEmpty` validator every sibling
required-profile script already had.

Final state: `pnpm typecheck` (19/19 packages), `pnpm lint`, `pnpm
format:check`, `pnpm build` (18/18), `pnpm test` (225 files / 8543 tests),
`pnpm test:coverage` (exit 0, bin/ and packages/scripts suites both green),
and `pnpm knip` all pass. `pnpm check:review-size` reports 260,516 chars —
over the 75,000-char ADR-0072 soft target but under the 300,000 ceiling
(warn, not fail); recorded in the PR body per the tool's own instruction
rather than split, since splitting a uniform fleet-wide gate would leave
some scripts protected and others not for the span of the split, defeating
the retrofit's point.

Skills used: starting-work, writing-commits, creating-prs,
resolving-merge-conflicts, syncing-docs, writing-work-logs.

Spoke incidents: 3 truncations / 0 stalls / 2 resumes. Three
`code-implementer`/test-author dispatches ended their final message
mid-sentence before delivering a summary (the sqs-etl first-pass
implementer, a second sqs-etl completion pass, and one pipeline-scripts
`yesSensitive`-validator fix) — in every case the actual file edits had
already landed correctly and only the closing report was cut off, confirmed
by directly inspecting `git diff`/re-running the package's gates rather than
trusting the agent's own words. Two `code-reviewer` agents (one direct-call,
one pipeline-scripts) returned a `status: completed` notification whose
`result` field was empty or cut off exactly where findings should start;
`SendMessage` to the same agent id recovered the full report both times
with no re-work needed.

## What went as planned

- **The 11-way test-author fan-out (TDD RED) worked as designed.** All 11
  dispatches correctly produced type-check/runtime failures whose cause was
  the missing `awsTarget`/`target`/`isSensitiveTarget`/`yesSensitive` wiring
  — never a typo or wrong import — confirming each spoke understood "fail
  for the right reason" rather than just "fail."
- **The pipeline-vs-direct-call pattern split held exactly as designed.**
  All 6 pipeline scripts landed byte-identical `target`/`isSensitiveTarget`/
  `yesSensitive` callback shapes; all 5 direct-call scripts correctly chose
  between the hard-guard and conditional-spread pattern per their own
  `aws.profile` requiredness, with zero cross-contamination.
- **Two research forks up front (pipeline-scripts survey, direct-call
  survey) correctly surfaced both scope corrections** (api-gateway-client's
  second call site, sqs-etl's missing `nonEmpty`) before any implementation
  code was written, instead of discovering them mid-implementation.
- **Every review-flagged defect had a clean, scripts-only fix available** —
  no finding required touching `packages/m3l-common`, matching the plan's
  explicit "no library change" constraint even under real pressure to patch
  the shared `requires()` factory.

## What didn't go as planned, and why

### 1. A silent-failure-hunter pass found the new `yesSensitive`-requires-`yes` config validator was a systemic no-op

`Core.M3LConfigSchemaValidators.requires("yesSensitive", "yes")` — added to
10 scripts' `configValidators` to reject the config combo "`yesSensitive`
set without `yes`" at parse time — never actually rejected anything in the
real pipeline. `requires()` treats a parameter as "unset" only via
`config.get(name) === undefined`, but both `yesSensitive` and `yes` are
declared with `defaultValue: false`, and `M3LScript`'s config loader
(`M3LScriptConfigLoader.load()`) eagerly resolves and stores every declared
parameter's default into the config store _before_
`M3LConfigSchema.validate()` runs — confirmed by reading
`M3LScript.loadConfig()` (`this.config = await this.configLoader.load(...);
this.schema?.validate(this.config);`) and by reproducing the scenario
against the built library. `config.get("yes")` is therefore never
`undefined` once config is loaded — it is always at least `false` — so the
validator's OR condition was always `true`. Two independent
silent-failure-hunter passes (pipeline scripts, direct-call scripts)
reproduced this identically. The library's own JSDoc example for
`requires()` literally uses this exact pairing, which is presumably why 10
scripts followed it faithfully. Notably, the reference implementation
(`sqs-dead-letter-triage`) that this retrofit's per-script pattern was
modeled on never actually wired this validator in either — in hindsight,
a signal the pattern hadn't been end-to-end verified before being
generalized.

The fix (scripts-only, no library change) replaced the presence-based
factory call in all 10 scripts with an inline value-based predicate
comparing resolved booleans directly (`config.get("yesSensitive") !== true
|| config.get("yes") === true`), keeping the identical failure-reason
string so no consuming code needed to change. One pre-existing s3-objects
test had explicitly locked in the old, buggy "presence, not truthiness"
behavior as documented/expected — it needed rewriting to assert the
corrected semantics instead of continuing to encode the bug.

**Why it happened:** The library's own `requires()` factory's worked
example pairs two boolean flags that, in every real caller, both carry
declared defaults — a shape the factory's presence-based semantics cannot
distinguish from "both actually set." Nobody had exercised this exact
combinator through the full `M3LScript` config-load pipeline before this
retrofit generalized it to 10 call sites at once.

**Fix for future:** When a `configValidators` entry pairs two `BOOL`
parameters that both declare a `defaultValue`, `M3LConfigSchemaValidators
.requires()`'s presence check cannot fire — reach for a value-based inline
predicate instead, or verify the presence-based factory against a
config resolved through the _real_ `M3LScriptConfigLoader`/`M3LScript`
pipeline (not a directly-constructed `M3LConfig` + `.set()`) before trusting
it end-to-end. Mitigating factor worth remembering: `confirmDestructive`'s
own strict `yes===true && yesSensitive===true` bypass check is a separate,
unaffected code path, so this class of bug degrades "reject bad config
early" to "reject bad config never" — it does not by itself open an
authorization bypass.

### 2. `rds-data-sql`'s `main.ts` never actually wired `configValidators` into `M3LScript`

A direct-call-scripts code review found `scripts/rds-data-sql/src/main.ts`
imported only `configParameters` and never passed `validate: configValidators`
into the `M3LScript` constructor — so none of that script's 4
cross-parameter validators (including the new `yesSensitive` one) ever ran
against real config, a defect independent of and additional to item 1
above. Fixed with a 2-line change (import `configValidators`, pass
`validate: configValidators`); no test needed weakening — the existing
203-test suite stayed 203/203 with the previously-dead validators now
actually enforcing.

**Why it happened:** The original code-implementer dispatch for
`rds-data-sql` added the `yesSensitive` parameter and validator entry to
`config.ts` correctly, but the retrofit's `main.ts` change for this script
(the `awsTarget` guard) didn't touch the `M3LScript` constructor's `config:`
option, so the pre-existing gap (never wiring `validate:` at all) went
unnoticed.

**Fix for future:** When a script's `configValidators` array export exists,
explicitly verify `main.ts` actually passes it as `config.validate` — the
presence of the array is not proof it's wired in; `pnpm check:review-size`
and the normal test suite both stay green even when a validator array is
fully inert, since nothing but a live-pipeline integration check exercises
the wiring itself.

### 3. Two spoke dispatches (`code-reviewer`) returned truncated/empty findings; two `code-implementer` dispatches were cut off before their final summary

Multiple background-agent notifications arrived with either an empty/absent
findings body (both direct-call and pipeline-scripts `code-reviewer` passes
initially) or a mid-sentence cutoff (`sqs-etl`'s first implementation
attempt, `sqs-etl`'s completion pass, the pipeline-scripts `yesSensitive`
fix). In every truncation case, `git diff --stat`/direct `tsc`/`vitest`
inspection showed the actual file edits had landed correctly — only the
agent's own closing report was lost, not the work. `SendMessage` to the
same agent id/name successfully resumed both truncated `code-reviewer`
agents and recovered their full findings without re-running the review.

**Why it happened:** Consistent with this repo's documented recurring
failure mode (`docs/contributing/subagent-context-management.md`) — a
long-running spoke can exhaust its turn/output budget after completing real
work but before emitting a final summary.

**Fix for future:** Never trust a cut-off or suspiciously terse final
message as "nothing happened" or "task failed" — always independently
verify via `git diff`/`git status`/re-running the package's own gates
before concluding a dispatch needs a retry. `SendMessage` to the same
agent id is often cheaper and more reliable than a fresh redispatch, since
it recovers a report the agent already composed rather than repeating the
underlying work.

### 4. A parallel fleet retrofit (#654, cooperative-cancellation `AbortSignal` threading) landed on `main` mid-session, conflicting with this PR in the same 10 files

`origin/main` gained PR #654 ("thread AbortSignal through 7 fleet call
sites", ADR-0049) while this retrofit was still in flight, touching the
exact same `main.ts`/`run-*.ts` files in 5 of the same 11 scripts
(`cloudformation-stacks`, `codepipeline-ops`, `dynamodb-crud`, `ecs-ops`,
`eks-ops`) at the exact same insertion points (the `Deps` interface tail,
the composition-root call-site object literal). Every one of the 10
resulting conflict hunks was the same shape: one side added `signal`, the
other added `awsTarget`, both purely additive with no semantic overlap.
Per `resolving-merge-conflicts`' own rule, a real `src/**` logic conflict is
handed back rather than auto-resolved — but since the hub cannot itself
edit `src/**` (guard-hub-src-writes.mjs) and the conflict shape was fully
understood, the maintainer was asked once whether to resolve via a
code-implementer dispatch (with full context of both changes) or pause for
manual/cross-session coordination; the maintainer chose dispatch resolution.
A single code-implementer, briefed with the exact "keep both sides" shape
for all 10 files, resolved everything correctly on the first pass — the
rebase completed and 8543 tests passed with both `signal` and `awsTarget`
present in every affected file, though the resolving agent's own final
report was truncated (see item 3) and required direct `git log`/`git diff`
verification to confirm before proceeding.

**Why it happened:** Two independently-planned fleet-wide retrofits
(A1's cooperative-cancellation seam and A2's target-graded destructive
gate) both reached their consumer-script rollout phase in roughly the same
window, and both necessarily touch the same composition-root files across
the same script fleet.

**Fix for future:** When two fleet-wide retrofits are known to be in
flight concurrently (visible via `ListAgents`/peer session names), rebase
onto `origin/main` earlier and more frequently rather than only right
before opening the PR — an earlier, smaller conflict surface is cheaper to
resolve and verify than one 10-file conflict discovered at push time. A
same-insertion-point, both-additive conflict shape (as here) is
"real" per `resolving-merge-conflicts`'s classification, but is
low-risk enough that briefing a code-implementer with the exact
merge shape (rather than pure "resolve it") is safe and fast — reserve
actual escalation for a conflict where the two sides' _semantics_, not
just their insertion point, might interact.

## Lessons learned

- **A validator pairing two defaulted `BOOL` parameters needs a
  value-based check, not `M3LConfigSchemaValidators.requires()`.** The
  presence-based `requires()` factory is a silent no-op once both operands
  carry a declared `defaultValue` — the config loader resolves defaults
  into the store before any validator runs, so "unset" never occurs from
  the validator's point of view. Verify any `requires()` usage against a
  fully-loaded `M3LScript` config, not a directly-constructed `M3LConfig`.
  _(promoted → .claude/rules/scripts.md)_
- **A `configValidators` export existing is not proof it's wired in** — a
  script's `main.ts` must explicitly pass `validate: configValidators` to
  `M3LScript`'s constructor, or every entry in that array is dead code that
  the normal test suite won't catch. _(promoted → .claude/rules/scripts.md)_
- **Treat a cut-off spoke final message as "unknown," never "failed."**
  Independently verify via `git diff`/gate re-runs before redispatching;
  `SendMessage` to the same agent id/name often recovers a lost report
  cheaper than a fresh dispatch redoes the work.
- **A same-insertion-point, both-additive merge conflict between two
  parallel fleet retrofits is resolvable by a briefed code-implementer**,
  not an automatic hand-back — the `resolving-merge-conflicts` "hand back
  real logic conflicts" rule is about not mechanically picking a side, not
  about forbidding a deliberate, fully-understood union merge. Confirm the
  scope decision with the maintainer once when both changes are
  safety-sensitive, then proceed.
- **Rebase fleet-wide retrofits onto `main` early and often when a sibling
  retrofit is known to be in flight** — the same composition-root files are
  the predictable collision point for any two "wire X into all 11 scripts"
  efforts landing in the same window.
