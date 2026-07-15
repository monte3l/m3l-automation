# Fleet governance reconciliation — audit resolution plan (2026-07-15)

**Status: executed** — this plan lands in the same PR that executes it;
its open follow-ups live as tracked rows in
[`docs/ROADMAP.md`](../../ROADMAP.md) (Governance follow-ups T1–T7), not
here.

## Context

A 14-agent, two-wave read-only audit (via `/auditing`) reviewed the work
shipped since 2026-07-13 — the `aws/dynamodb`, `aws/sqs`, and
`aws/logs-insights` submodules (PRs #118–#120) and the `dynamo-crud`,
`sqs-etl`, and `logs-insights` consumer scripts (PRs #127–#129), plus the
follow-on chores #130–#133 — reconciling plans, implementations, work logs,
and trackers against project policy.

**Headline:** all 11 of the repo's `check:*` drift detectors PASS. Every
real finding lives in the surface those detectors do not cover.

## Findings (verified)

1. **Naming policy existed only de facto.** "AWS-scoped scripts/submodules
   are named after an AWS service" was documented nowhere and enforced
   nowhere (only the kebab-case regex in `bin/lib/script-scaffold.mjs`).
   Drifted units: `dynamo-crud` (service is DynamoDB), `logs-insights`
   script + `aws/logs-insights` submodule (capability is CloudWatch Logs
   Insights), and the planned names `cfn-stacks`, `apigw-client`,
   `data-query`.
2. **Dependency policy contradicted at ADR level.** All four shipped
   scripts depend only on `@m3l-automation/m3l-common` and the `@aws-sdk/*`
   import ban is ESLint-enforced — but ADR-0027's context ratified future
   script-local external deps (`eks-ops` → `@kubernetes/client-node`,
   `apigw-client` → `@smithy/signature-v4`, `data-query` → `pg`/`mongodb`),
   echoed by the ROADMAP W4 row.
3. **Untracked count literals rotted.** CLAUDE.md's AWS-barrel comment said
   4 submodules (actual: 6); `docs/ROADMAP.md`'s header said 24/24 (actual:
   25/25). Cause: `bin/lib/count-sites.mjs` tracks the Core-barrel literal
   but not these.
4. **Work-log closure gaps.** Logs are written in-session, pre-merge, and
   are immutable — so the merge outcomes of #127–#129 (including the
   review-driven fix rounds) were recorded nowhere, and the
   `aws/logs-insights` submodule (PR #120) never got a dedicated log. The
   `docs/logs/README.md` index was also stale (ended at 2026-07-11).
5. **Archived-plan rot (expected, unrecorded).** The archived 2026-07-09
   implementation plan sited DynamoDB support at `core/dynamodb` (shipped
   as `aws/dynamodb`) and named logs-insights steps that shipped under
   different decomposition. Archives stay immutable; divergences are
   recorded in the reconciliation log.

Resolved-by-design (not drift): the dirty `README.md` badge regen is the
ADR-0024 operator-commit contract working as documented.

## Ratified decisions (2026-07-15)

| #   | Decision                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | Supersede ADR-0027's external-deps exception — scripts depend only on m3l-common, no exceptions (ADR-0029)                                       |
| D2  | Strict full official service names for AWS-scoped scripts AND submodules (ADR-0028); roadmap names fixed now, shipped units scheduled for rename |
| D3  | `dynamo-crud → dynamodb-crud` rename scheduled as tracked follow-up (T1), not grandfathered                                                      |
| D4  | One reconciliation work log records the merge outcomes; existing logs stay immutable                                                             |
| D5  | Two single-topic ADRs (0028 naming, 0029 dependency boundary), extracted into `.claude/rules/scripts.md`                                         |
| D6  | Strictly documentation-only: tooling fixes become tracked follow-ups with specs (T4–T7), not code in this pass                                   |

## Deliverables (this PR)

- `docs/adr/0028-aws-service-naming-convention.md` — naming rule, scope
  definition, noncompliance ledger, semver note for the submodule rename.
- `docs/adr/0029-script-dependency-boundary.md` — hard dependency boundary;
  supersedes-in-part annotation added to ADR-0027; W4 consequences.
- `docs/adr/README.md` — index rows for 0028/0029; 0027 status cell.
- `docs/ROADMAP.md` — header counts 24/24 → 25/25; W3/W4 renames + ADR-0029
  redesign; new Governance follow-ups section (T1–T7).
- `docs/plans/IMPLEMENTATION.md` — W4 section reconciled with
  ADR-0028/0029; `sqs-etl` W2 row gains its missing test count (102).
- `.claude/rules/scripts.md` — naming + dependency-boundary extracts.
- `CLAUDE.md` — AWS-barrel count 4 → 6; governance bullet under
  Architecture & Decisions.
- `docs/logs/2026-07-15-fleet-reconciliation.md` — merge outcomes for
  #120/#127–#129, stand-in record for the missing `aws/logs-insights` log,
  archived-plan divergence notes; `docs/logs/README.md` index refreshed.
- `README.md` — pending commit-stats badge regen committed (ADR-0024
  operator commit).

## Follow-ups (tracked in ROADMAP — Governance follow-ups)

T1 `dynamodb-crud` rename · T2 `cloudwatch-logs-insights` script rename ·
T3 `aws/cloudwatch-logs-insights` submodule rename · T4 count-site coverage
for the rotted literals · T5 scaffold naming check · T6 script-deps check ·
T7 `deriveCounts()` synthetic test.

## Verification

`pnpm lint:md`, `pnpm format:check`, all 11 `check:*` drift scripts,
`pnpm check:cadence`, `docs-consistency-reviewer` spoke pre-PR, signed
commits, `claude-pr-review` PASS gate.
