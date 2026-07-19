# `aws/eventbridge` wrapper + `eventbridge-schedules` script

**Status: shipped** — Unit 1 (`aws/eventbridge`) merged as PR #163; Unit 2
(`scripts/eventbridge-schedules`) shipped in this PR.

## Context

`eventbridge-schedules` is the last **W3** consumer script (control-plane CRUD)
in `docs/ROADMAP.md`. The task began as "scaffold + implement the script over
the existing `eventBridge` getter." Investigation falsified that premise:
scripts are hard-forbidden from importing `@aws-sdk/*` (ADR-0029), and the
provider's raw `eventBridge` getter (`AWSClientProvider.eventBridge`) returns
an unwrapped SDK `EventBridgeClient` — a client-construction seam, not a
consumable operation surface. No `aws/eventbridge` wrapper existed yet, unlike
`aws/sqs`/`aws/cloudwatch-logs-insights`, which every prior consumer script's
wrapper dependency had already closed for their own W2 scripts. ADR-0027
explicitly named `eventbridge-schedules` among the fleet whose commands were
not yet wrapped.

## Approach / Decisions

Delivered as two sequential PRs via the established fleet pattern:

- **Unit 1 — `aws/eventbridge`** (PR #163): a typed `M3LEventBridgeOperations`
  wrapper over EventBridge **rules** only (list/describe/put/delete/enable/
  disable rules + list/put/remove targets) — the separate EventBridge
  Scheduler service was explicitly out of scope. 19 exports, 59 tests in
  `eventbridge.test.ts` + 4 provider-getter tests, 5-spoke review fan-out
  clean (1 should-fix: `M3LEventBridgePutRuleInput` converted to a
  discriminated union enforcing exactly one of `eventPattern`/
  `scheduleExpression` at compile time).
- **Unit 2 — `scripts/eventbridge-schedules`** (this PR): a control-plane
  script exposing 7 operations (list/describe/create/update/delete/enable/
  disable) over the wrapper. `create`/`update` share a `putRuleStep` internal
  helper (both drive the same `PutRule` upsert) and may attach targets in the
  same call via a `targets` JSON config field. A `spec-conformance-reviewer`
  spoke ran a dedicated contract-extraction pass before any RED test was
  written, catching 3 real errors in the hub-authored draft contract before
  any code existed (wrong exporter format value, wrong exporter class for a
  single-document write, an incorrect assumption about error-subclass shape).
  117 tests across 12 files; review fan-out (code-reviewer, security-reviewer,
  silent-failure-hunter) found zero must-fix, 4 should-fix (all applied).

## Outcome

Both units shipped. `docs/ROADMAP.md`'s shared W3 row was split so
`eventbridge-schedules` carries its own **done** status, distinct from the
five still-pending W3 scripts (`s3-objects`/`lambda-ops`/`ecs-ops`/
`cloudformation-stacks`/`codepipeline-ops`). See
[`docs/logs/2026-07-18-aws-eventbridge.md`](../../logs/2026-07-18-aws-eventbridge.md)
(Unit 1) and
[`docs/logs/2026-07-18-eventbridge-schedules.md`](../../logs/2026-07-18-eventbridge-schedules.md)
(Unit 2) for the full session narratives, including two test-fixture bugs
caught during GREEN and a truncated-spoke-report recovery.
