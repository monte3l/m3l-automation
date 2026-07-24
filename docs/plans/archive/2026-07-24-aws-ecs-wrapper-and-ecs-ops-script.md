# `aws/ecs` wrapper + `ecs-ops` script (2026-07-24)

**Status: shipped** — PR 1 (`aws/ecs` wrapper) on `feat/aws-ecs`, merged as #224;
PR 2 (`scripts/ecs-ops`) on `feat/ecs-ops`, #225

## Context

`/starting-work` was invoked against `docs/ROADMAP.md` + `docs/plans/IMPLEMENTATION.md`,
targeting the W3 `ecs-ops` script. The AWS getter-reality table already flagged
`ecs` as raw with no wrapper; this was re-verified directly against live code
(`provider.ts:192` returns a bare `ECSClient`, no `aws/ecs` src directory, `ecs`
absent from `src/aws/index.ts`) before scoping, per the fleet's now-standard
"verify wrapper-vs-getter status before starting" rule — `s3-objects`/
`lambda-ops`/`eventbridge-schedules` each needed this same correction
previously. Confirmed with the user this is a 2-PR chain: PR 1 is the
`aws/ecs` wrapper only; PR 2 (the `ecs-ops` script itself) is deliberately
deferred to a later session.

## Approach / Decisions

- **Services-centric v1 scope** confirmed with the user up front:
  list/describe/create/update/delete on ECS services plus a
  `waitUntilServicesStable` stabilization wait, and read-only cluster context
  (list/describe). Cluster mutation, task-definition registration, and task
  run/stop explicitly deferred — recorded in `docs/reference/aws/ecs.md`'s
  "Out of scope (v1)" section.
- **Full `scaffolding-submodules` → `implementing-submodules` pipeline** in the
  shared checkout on `feat/aws-ecs`. A `spec-conformance-reviewer`
  contract-extraction pass (Phase 1) surfaced a real ambiguity in the
  `waitUntilServicesStable` contract before RED/GREEN ran: the doc's
  first draft said the method both "wraps the waiter" and "resolves a timeout
  as data," but the SDK's current, non-deprecated waiter actually _throws_ on
  any non-`SUCCESS` terminal state, and its `FAILURE` state is
  indistinguishable by error identity from a genuine call failure. Resolved by
  picking a concrete catch-by-error-name strategy (`TimeoutError`/`AbortError`
  resolve, everything else re-throws; `maxWaitTime` defaults to 600s) and
  writing it into the doc before dispatching `test-author`/`code-implementer`.
- **4-spoke review** (`code-reviewer`, `security-reviewer`,
  `silent-failure-hunter`, `type-design-analyzer`) found 0 must-fix. Of 3
  should-fix findings: 1 applied as a real fix (`createService`/
  `updateService`/`deleteService` now throw, rather than silently default,
  when the SDK response omits `service` — a genuine anomaly per AWS's own
  contract), 1 resolved via a doc-only clarification (`describeService`/
  `describeCluster` intentionally discard the SDK's `failures` array), 1
  deferred with documented rationale (`M3LECSLoadBalancer` as a discriminated
  union — the reviewer itself called this defensible, not mandatory, given
  the type is shared input/output).
- 49 tests, 100% stmts/branches/functions/lines on `client.ts`; full workspace
  suite (4605 tests), typecheck, lint, build all green. No new runtime
  dependency — `@aws-sdk/client-ecs` and the `ecs` `AWSClientProvider` getter
  already existed.
- Two durable lessons promoted into skill files this session: the
  `Promise.reject`-not-`throw` scaffold-placeholder pattern
  (`.claude/skills/scaffolding-submodules/SKILL.md`) and reading a wrapped
  SDK operation's actual dist-types before drafting its resolve/throw contract
  (`.claude/skills/implementing-submodules/SKILL.md`).

## Outcome

`aws/ecs` (`M3LECSOperations` + `M3LECSOperationError` + 9 plain types)
shipped on `feat/aws-ecs` (#224), unblocking `ecs-ops`. `scripts/ecs-ops`
(8 operations, 112 tests, 0 must-fix/should-fix across the 3-reviewer fan-out)
shipped on `feat/ecs-ops` (#225), completing the chain. See
`docs/logs/2026-07-24-aws-ecs.md` and `docs/logs/2026-07-24-scripts-ecs-ops.md`
for the full narrative.
