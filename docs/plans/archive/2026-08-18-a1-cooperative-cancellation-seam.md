# Plan: A1 — the cooperative cancellation seam

**Status: shipped** — landed on `feat/cooperative-cancellation-seam` (PR #478),
closing issue #468. Work log:
[`docs/logs/2026-08-18-a1-cooperative-cancellation-seam.md`](../../logs/2026-08-18-a1-cooperative-cancellation-seam.md).
Decision: [ADR-0049](../../adr/0049-cooperative-cancellation-contract.md).

## Context

Item **A1** of the codified-procedure-engine wave, and a prerequisite for **B2**
(whose execution context carries this signal). The gap: a shutdown signal could
not stop work already in flight. `M3LScript` registered
`SIGTERM`/`SIGINT`/`SIGQUIT` and ran cleanup, but nothing cleanup could reach was
able to tell the running work to stop, and `AbortSignal` appeared in exactly one
place in the library (`core/network/M3LHttpClient`) — nowhere under `src/aws/**`,
`core/polling/**` or `core/script/**`.

The practical failure was a multi-minute AWS waiter still polling after the
operator pressed Ctrl-C, while the run report was written describing a run that
had not stopped — undercutting ADR-0035's premise that the report is the record
of what happened. `M3LRunOutcome` already declared an `interrupted` arm that was
effectively unreachable because nothing observed a cancellation.

## Approach / Decisions

Spec-first, then a strict RED→GREEN TDD loop through `test-author` /
`code-implementer` spokes, then review spokes, then `/syncing-docs`. Nine
reference pages landed as the first commit and served as the contract every RED
spoke wrote its tests from.

Decisions settled with the maintainer before implementation:

- **Library-only scope.** Wiring `M3LScript.signal` into consumer-script call
  sites became a follow-up fleet-retrofit PR, making A1 a two-PR chain matching
  the A2/A4/A5 precedent. ADR-0049's end-to-end verification is met by a
  library-level integration test rather than a retrofitted script.
- **A caller-signal abort rejects** with `M3LOperationAbortedError` rather than
  resolving `{ state: "ABORTED" }`. This was the pivotal call: resolving would
  mean `runScript` never observes the abort, leaving the `interrupted` outcome
  unreachable and defeating the ADR's own outcome mapping. The `"ABORTED"` union
  member was retained (reachable only when an `AbortError` arrives with no
  _aborted_ caller signal),
  because narrowing an exported union is breaking.
- **The abort error accepts no `cause`.** `@smithy/core` builds its `AbortError`
  message by serializing the whole waiter result, which can embed the last
  observed response body. Omitting `cause` from the constructor makes that leak
  unrepresentable rather than merely discouraged — all 11 call sites pass zero
  arguments, so the error's entire observable surface is a static string plus a
  code.
- **Recognition in `runScript`, not `mapErrorToExitCode`.** `M3LErrorExitCode` is
  `Exclude<M3LExitCode, SUCCESS | INTERRUPTED>`, so that function provably cannot
  return 5; widening it would be an exported-type semver event. Routing the abort
  through it would have classified a cancellation as a config fault (exit 2),
  since the abort's origin is `"caller"`.

Two findings changed the plan mid-flight. Auditing the call sites showed the
`"ABORTED"` arm was **unreachable** across all 8 waiters (nothing passed an
`abortSignal`), which is what surfaced the reject-vs-resolve conflict; and ECS
and CloudFormation were still building their waiter `reason` from the raw SDK
message, a latent leak that threading a signal would have made reachable.
`aws/eks` had already been hardened against exactly this; both others were fixed
in the same change set and regression-locked with tests that plant a secret in
the mocked SDK message.

Two review findings were **declined** with reasons recorded: the broken cause
chain (that is the security property), and factoring the nine near-identical
`isAborted` helpers — `core/errors` is `export *` so hoisting would mint public
API as a side effect of a cleanup, and `internal/` would create the repo's first
`aws/** → internal/` edge where every prior aws-island widening was ADR-recorded.

## Outcome

Two new exported symbols (`M3LOperationAbortedError`, `M3LECSWaiterOptions`), one
class accessor, and optional `signal?: AbortSignal` on five existing options
interfaces. Additive minor; the three-entry `exports` map untouched; **no ESLint
zone widened**, which ADR-0049 made a hard constraint. 7811 tests pass;
`internal/polling/delay.ts` finished at 100% statements and branches;
`pnpm verify` passes all 38 steps.

An ADR-0049 `Update (2026-08-18)` block records the two claims implementation
disproved: there is no `aws/codepipeline` waiter to thread a signal through (the
"execution watch" the Decision named is a consumer-script `M3LPoller`
composition, so the surface is 8 waiters + 2 query polls), and the
reject-vs-resolve conflict above.

Five lessons were promoted out of the work log in the same change set — three
source rules into `.claude/rules/library-src.md` (unsound TS narrowing on a
mutable external property across an `await`; audit a newly-reachable branch as
new code; prefer a constructor that cannot carry an unsafe payload), a
deterministic truncation detector into
`docs/contributing/subagent-context-management.md`, and the two-pass
coverage-JSON trap into `.claude/skills/vitest-coverage-types-mocks/SKILL.md`.
