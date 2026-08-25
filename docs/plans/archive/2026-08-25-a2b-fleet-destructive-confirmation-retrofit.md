# Plan: A2b — fleet retrofit for the target-graded destructive confirmation gate

**Status: shipped** — landed on `feat/fleet-destructive-target`, closing
issue #483. Work log:
[`docs/logs/2026-08-25-a2b-fleet-destructive-confirmation-retrofit.md`](../../logs/2026-08-25-a2b-fleet-destructive-confirmation-retrofit.md).
Decision: [ADR-0048](../../adr/0048-target-graded-destructive-confirmation.md).

## Context

The second half of the A2/A2b two-PR chain. A2 (PR #482) gave
`Core.confirmDestructive` and `M3LOperationPipeline`'s `destructive` gate
option an optional target dimension — `target`/`isSensitiveTarget`/
`yesSensitive` — so a destructive action could be graded on _what it's
pointed at_, not only on _what it is_, library-only by design (ADR-0048:
"additive only... a change that forces all [11 scripts] to move at once is
not acceptable"). Until this PR, no script actually passed a target, so a
scratch delete and a production delete prompted identically, and a single
`--yes` bypassed both — the gap this retrofit closes.

## Approach / Decisions

Verified scope against ADR-0048's own census before writing any code: 11
scripts, initially counted as 15 call sites, corrected during implementation
to 16 (`api-gateway-client` has two — `single-request.ts` and
`batch-request.ts`, not the one the original count captured). Two research
forks surveyed the pipeline-style and direct-call scripts in parallel before
any test or implementation code was written, surfacing that correction plus
a second one: `sqs-etl`'s `aws.profile` was `required: true` without
`Core.M3LConfigValidators.nonEmpty`, unlike every sibling required-profile
script — closed in the same PR since the hard-guard pattern's
`awsTarget`-always-defined assumption depended on it.

Decisions settled before implementation, matching the plan the maintainer
approved:

- **Sensitivity predicate is a per-script inline one-liner**,
  `(target) => target.profile.toLowerCase().includes("prod")` — not the
  library's `sensitiveTargets()` factory (substring, not exact-list
  matching) — duplicated per script per ADR-0029 rather than shared.
- **Two threading patterns**, chosen per script by whether `aws.profile` is
  declared `required`: a hard `main.ts` guard resolving a non-optional
  `awsTarget` for the 10 required-profile scripts (mirroring the existing
  `aws === undefined` guard already in every composition root), versus a
  conditional spread (`...(awsTarget !== undefined ? { target: awsTarget }
: {})`) for `api-gateway-client`, whose `aws.profile` is genuinely optional
  (`auth: none`/`api-key` are valid, credential-free runs).
- **`dynamodb-crud` stays non-bypassable.** It hardcodes `yes: false` with
  no `yes` config parameter at all; this retrofit added only `target`/
  `isSensitiveTarget` to its `Core.confirmDestructive` call, upgrading a
  sensitive target's confirm from plain yes/no to the escalated typed-echo
  prompt, with no `yesSensitive` config to pair against a `yes` that doesn't
  exist.
- **Single PR for all 11 scripts** — the issue's own framing as the
  "second PR of the A2 two-PR chain," and because a uniform fleet-wide gate
  split across several PRs would leave some scripts protected and others
  not for the span between them, working against the retrofit's own point.

TDD throughout: an 11-way `test-author` fan-out (RED) confirmed every new
test failed for the missing-wiring reason, not a typo, before an 11-way
`code-implementer` fan-out (GREEN) closed each one out; `sqs-etl` (4 call
sites) and one pipeline-scripts `configValidators` fix needed a second
dispatch pass after a truncated first attempt left partial work (verified
directly via `git diff`, not trusted from the agent's own report). Four
parallel review spokes (`code-reviewer` × 2, `silent-failure-hunter` × 2,
split pipeline-vs-direct-call) ran over the full diff before commit.

Two review findings changed the shipped code from what was originally
implemented: `M3LConfigSchemaValidators.requires("yesSensitive", "yes")` —
added to 10 scripts to reject the unsafe config combo at parse time — proved
to be a systemic no-op once both operands carry a declared `defaultValue`
(the config loader resolves defaults into the store before any validator
runs, so "unset" is unreachable), fixed with a scripts-only value-based
inline predicate in all 10 scripts rather than touching the shared library
factory; and `rds-data-sql`'s `main.ts` had declared `configValidators` but
never passed it to `M3LScript`'s constructor, so none of its 4
cross-parameter validators — the new one included — ever ran. Neither
defect affected the destructive gate's own authorization boundary: its
strict `yes===true && yesSensitive===true` bypass check, in unchanged
library code, held throughout.

A parallel fleet retrofit, PR #654 ("thread `AbortSignal` through 7 fleet
call sites," ADR-0049's own A1b), landed on `main` mid-session and
conflicted with this PR in the same 10 `main.ts`/`run-*.ts` files across 5
scripts — both additions land at the same insertion point with no semantic
overlap. Resolved via a briefed `code-implementer` dispatch after confirming
the approach with the maintainer once, given the safety-sensitivity of both
changes; the rebase completed cleanly with both `signal` and `awsTarget`
present everywhere and the full suite green.

## Outcome

11 scripts wired: 6 pipeline-style (`s3-objects`, `cloudformation-stacks`,
`eks-ops`, `ecs-ops`, `lambda-ops`, `codepipeline-ops`) threading a
non-optional `awsTarget` through `Deps` and the pipeline's `destructive`
options; 5 direct-call (`dynamodb-crud`, `api-gateway-client`,
`rds-data-sql`, `sqs-etl`, `eventbridge-schedules`) calling
`Core.confirmDestructive` directly. No `packages/m3l-common` changes — purely
a consumption-side retrofit of capability ADR-0048 already shipped.
`pnpm typecheck` (19/19 packages), `lint`, `format:check`, `build` (18/18),
`test` (225 files / 8543 tests), `test:coverage`, and `knip` all pass.
`check:review-size` reports 260,516 chars — over the 75,000-char ADR-0072
soft target, under the 300,000 ceiling — recorded here rather than split,
since splitting a uniform fleet-wide gate mid-rollout would leave some
scripts protected and others not.

Two durable lessons promoted into `.claude/rules/scripts.md` in the same
change set: `M3LConfigSchemaValidators.requires()`'s silent-no-op failure
mode against two defaulted `BOOL` parameters, and that a `configValidators`
array's mere existence proves nothing about whether `main.ts` actually wires
it into `M3LScript`.
