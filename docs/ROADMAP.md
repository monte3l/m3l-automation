# Roadmap — m3l-automation

The **living, prioritized view of pending program work**. It is the coarse
companion to two other trackers:

- [`docs/implementation-status.md`](./implementation-status.md) — the _done_
  library ledger (30/31 submodules, count-enforced).
- [`docs/plans/IMPLEMENTATION.md`](./plans/IMPLEMENTATION.md) — the _detailed_
  per-item backlog this file summarizes.

This file is **fixed and living** (no date in its name); it is updated as work
lands — mark an item done, archive its plan, pull the next one up. See
_Maintenance_ at the bottom. Completed dated plans live under
[`docs/plans/archive/`](./plans/archive/).

## Status snapshot

Per-item status lives in the tables below (Priority 0/1/2) and in
[`docs/implementation-status.md`](./implementation-status.md) — the
count-enforced library ledger (30/31 submodules, shipped at v1.1.0 + the
ad-hoc `aws/dynamodb`, `aws/sqs`, and `aws/cloudwatch-logs-insights` additions,
ADR-0026/ADR-0027).

## Priority 0 — Library hardening (do before more scripts)

Fleet-blocking friction surfaced by W1 (the first consumer). These compound
across every later script, so they come **before** W2. Detail + source
call-sites in [`IMPLEMENTATION.md`](./plans/IMPLEMENTATION.md#library-friction-f-series).

| Item   | What                                                                                            | Status      | Why now / Notes                                                                                                                                                                                                                 |
| ------ | ----------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **F8** | `M3LScript` preset seam — presets can't drive a run's config (config loader wires only CLI+env) | done (#106) | `M3LScriptOptions.preset` wired at precedence level 6 in `M3LScript`/`M3LScriptConfigLoader`. `json-etl` re-adoption landed as **F8-adopt**.                                                                                    |
| **F6** | Importer surfaces its skip count                                                                | done (#103) | `importStream()` now returns `{ processed, skipped, durationMs }`. `json-etl` evaluated re-adoption (**F6-adopt**) and kept its event-based counter (the summary can't serve a truncating consumer); seam gap filed as **F6b**. |
| **F4** | `M3LScript.paths` getter (paths seam)                                                           | done        | `json-etl` now consumes it; its hand-built `new M3LPaths()` is gone.                                                                                                                                                            |
| **F5** | `M3LPaths.resolveInput/resolveOutput(name)` (join + traversal-contain, paths seam)              | done        | `json-etl`'s local `resolveContainedPath` is gone.                                                                                                                                                                              |
| **F1** | `required: true` on `M3LConfigParameter` (throws `M3LConfigMissingError`)                       | done        | `json-etl` declares `required` instead of hand-rolled presence guards. Cross-parameter half deferred as **F1b** (Priority 2).                                                                                                   |
| **F2** | `nonEmpty`/`minLength` on `M3LConfigValidators`                                                 | done        | `json-etl` declares `nonEmpty` instead of hand-rolled guards.                                                                                                                                                                   |

## Priority 1 — Consumer fleet

Before scoping or starting any AWS-consumer-script item below, check its
getter's status in the [AWS getter reality
table](./plans/IMPLEMENTATION.md#aws-getter-reality) — never assume an
existing `AWSClientProvider` getter is a script-consumable operation surface
from its name alone (ADR-0027/ADR-0029).

| Wave   | Scripts                                                                       | Status          | Depends on                                                                                                                                                                                                                                     |
| ------ | ----------------------------------------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **W1** | `json-etl`                                                                    | **done** (#99)  | W0 ✓                                                                                                                                                                                                                                           |
| **W2** | `dynamodb-crud`                                                               | **done**        | W0 ✓ (scale: checkpoint/resume, batch retry, `failed.jsonl`); consumes `aws/dynamodb` — wrapped (see [AWS getter reality table](./plans/IMPLEMENTATION.md#aws-getter-reality)); ADR-0026/ADR-0027                                              |
| **W2** | `cloudwatch-logs-insights`                                                    | **done**        | W0 ✓; consumes `aws/cloudwatch-logs-insights` — wrapped (see AWS getter reality table); `M3LLogsInsightsClient`, ADR-0027                                                                                                                      |
| **W2** | `sqs-etl`                                                                     | **done**        | W0 ✓; consumes `aws/sqs` — wrapped (see AWS getter reality table); `M3LSQSOperations`, ADR-0026                                                                                                                                                |
| **W3** | `s3-objects`                                                                  | **done**        | W0 ✓; consumes `aws/s3` — wrapped (see AWS getter reality table); typed operations wrapper, ADR-0033                                                                                                                                           |
| **W3** | `lambda-ops`                                                                  | **done**        | W0 ✓; consumes `aws/lambda` — wrapped (see AWS getter reality table); `M3LLambdaOperations`; 7 operations, 78 tests                                                                                                                            |
| **W3** | `eventbridge-schedules`                                                       | **done**        | W0 ✓; consumes `aws/eventbridge` — wrapped (see AWS getter reality table); `M3LEventBridgeOperations`, ADR-0027; 7 operations (list/describe/create/update/delete/enable/disable), scoped to EventBridge rules only (not Scheduler); 117 tests |
| **W3** | `ecs-ops`                                                                     | pending         | getter reality: `ecs` is raw — no wrapper yet (see [AWS getter reality table](./plans/IMPLEMENTATION.md#aws-getter-reality)); do not scope as 1-PR until re-verified — resolve wrapper-vs-getter status first; name per ADR-0028               |
| **W3** | `cloudformation-stacks`                                                       | pending         | getter reality: `cloudFormation` is raw — no wrapper yet (see AWS getter reality table); do not scope as 1-PR until re-verified — resolve wrapper-vs-getter status first; name per ADR-0028                                                    |
| **W3** | `codepipeline-ops`                                                            | pending         | getter reality: `codePipeline` is raw — no wrapper yet (see AWS getter reality table); do not scope as 1-PR until re-verified — resolve wrapper-vs-getter status first; name per ADR-0028                                                      |
| **W4** | `api-gateway-client`                                                          | **done** (#157) | W0 ✓; consumes `aws/signing` — wrapped (see AWS getter reality table); SigV4, ADR-0029                                                                                                                                                         |
| **W4** | `athena-query` (Athena-only, `pg`/`mongodb` dropped per ADR-0031)             | **done**        | W0 ✓; consumes `aws/athena` — wrapped (see AWS getter reality table); `M3LAthenaClient`, ADR-0029                                                                                                                                              |
| **W4** | `eks-ops` (EKS control-plane only)                                            | pending         | getter reality: `eks` is raw — no wrapper yet (see AWS getter reality table); do not assume the existing `eks` getter is sufficient — verify wrapper-vs-getter status before starting; ADR-0029                                                |
| **W5** | Promotion pass — steps duplicated across ≥2 scripts graduate into the library | pending         | ≥2 scripts existing to observe duplication                                                                                                                                                                                                     |

Sequencing: W2 proves the scale architecture; W3 and W4 both turned out to
require a new `aws/<service>` operations wrapper before a script could start
(s3, lambda, eventbridge for W3; athena, signing for W4) — the original
premise that W3 was "mechanical over existing clients" was wrong for 3 of its
4 shipped items and must not be assumed for its 3 pending items or W4's
`eks-ops` either (check the [AWS getter reality
table](./plans/IMPLEMENTATION.md#aws-getter-reality) before scoping/starting
any of them); W5 is the standing F4 loop.

## Priority 2 — Gated / deferred

Deliberately unscheduled until their gate opens (ADR-0021 D4/D5 intake).

| Item                                                                                 | Unblock condition                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D4** SSM config provider                                                           | a 2nd script hand-rolling SSM config fetch (no new deps)                                                                                                                                                                                                 |
| **D4** SES messaging transport                                                       | a script needing notifications (new optional `@aws-sdk/client-sesv2` peer)                                                                                                                                                                               |
| **D4** Lambda-invoke wrapper                                                         | a script invoking Lambdas (no new deps)                                                                                                                                                                                                                  |
| **D4** Slack/webhook transport                                                       | first schedule the `M3LHttpClient` POST enhancement                                                                                                                                                                                                      |
| **D4** `aws/rds-data` Aurora PostgreSQL query wrapper (ADR-0031)                     | a script needing Aurora PostgreSQL query access (new hard `@aws-sdk/client-rds-data` dep, Data-API-enabled clusters only)                                                                                                                                |
| **D4** DocumentDB query wrapper (ADR-0031)                                           | a script needing DocumentDB query access (new optional `mongodb` peer, ADR-0017) _and_ acceptance of its VPC-reachability/non-AWS-driver trade-offs                                                                                                      |
| **D5** platform extraction                                                           | a second repo adopting the workflow                                                                                                                                                                                                                      |
| **F1b** cross-parameter validation seam                                              | a 2nd script hand-rolling a cross-field guard (`json-etl`'s `sort⇒limit` / `sort ∈ fields` is the 1st); needs an `M3LConfig`/`M3LConfigSchema`-level API                                                                                                 |
| **F3** `run(mainFn)` receives a `ctx`                                                | 2.0 evidence only (breaking — collect, don't act)                                                                                                                                                                                                        |
| **F7 / `onUnknownFormat`** tolerant per-record array import                          | a consumer needing per-record tolerance on irregular non-JSONL input                                                                                                                                                                                     |
| `@aws-sdk/client-scheduler` getter                                                   | `eventbridge-schedules` needing flexible (one-off/timezone) schedules                                                                                                                                                                                    |
| **TypeScript 6→7 toolchain upgrade** (deliberate hold)                               | TS7 verified across the toolchain (typescript-eslint, vitest, `tsc -b`) + a toolchain-upgrade decision (`check:deps` notice, PR #95)                                                                                                                     |
| **External code-index MCP** (ADR-0012, re-affirmed by ADR-0023)                      | W2–W4 fleet landed + observed spoke grep friction the catalog/symbol-map can't answer                                                                                                                                                                    |
| **ADR-0025** dynamic-workflows pilot (`auditing` fan-out + adversarial verification) | **done** — prerequisites landed via `check:workflows` (#144); pilot landed on `feat/auditing-workflow-pilot` (`.claude/workflows/audit-fanout.js` + `auditing` skill delegation; live acceptance run: 15 agents, 9 confirmed / 4 refuted / 0 unverified) |

## Governance follow-ups (ADR-0028 / ADR-0029)

Filed by the 2026-07-15 fleet-governance audit
([plan](./plans/archive/2026-07-15-fleet-governance-reconciliation.md)). Each
is its own PR; the renames T1–T3 clear the ADR-0028 noncompliance ledger.

| Item   | What                                                                  | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------ | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **T1** | Rename script `dynamo-crud` → `dynamodb-crud`                         | **done** — landed on `refactor/rename-dynamo-crud`: directory, package name, root `tsconfig.json` ref, reference-page filename, W2 row here, ADR-0027 fleet-example mention untouched (historical); `docs/logs/` + `docs/plans/archive/` filenames stay (immutable history); full gates + `/syncing-docs` after                                                                                                                                                                                                                                                                                                                                             |
| **T2** | Rename script `logs-insights` → `cloudwatch-logs-insights`            | **done** — landed on `refactor/rename-logs-insights-script`: directory, package name, root `tsconfig.json` ref, reference-page filename, W2 row here, `docs/logs/` + `docs/plans/archive/` filenames stay (immutable history); full gates + `/syncing-docs` after                                                                                                                                                                                                                                                                                                                                                                                           |
| **T3** | Rename submodule `aws/logs-insights` → `aws/cloudwatch-logs-insights` | **done** — landed on `refactor/rename-aws-logs-insights`: src dir + barrel line in `src/aws/index.ts`, reference page + provenance sidecar filenames, test filename, `gen:index` regen; no public subpath change; symbols kept `M3LLogsInsights*` names (renaming them would be semver-major)                                                                                                                                                                                                                                                                                                                                                               |
| **T4** | Track today-untracked count literals in `bin/lib/count-sites.mjs`     | **done** — landed on `feat/enforce-count-sites`: added the CLAUDE.md AWS-barrel-comment site (`TOTAL_COUNT_SITES`) and two sibling numerator/denominator site pairs for this file's `25/25` intro pointer + Status-snapshot literals; `gen:counts`/`check:doc-counts`/`check:impl-counts` verified idempotent against the current tree                                                                                                                                                                                                                                                                                                                      |
| **T5** | Scaffold naming check (ADR-0028)                                      | **done** — landed on `feat/enforce-aws-service-names`: `bin/lib/script-scaffold.mjs` gained `serviceNameErrors()` (a denylist of known-bad abbreviations/bare-capability names per ADR-0028's ban-list — no canonical AWS service vocabulary exists yet, so this catches known offenders rather than affirmatively verifying compliance), wired into both `scaffold-script.mjs` (blocks creation) and `check-script-scaffold.mjs` (flags existing packages)                                                                                                                                                                                                 |
| **T6** | Script dependency check (ADR-0029)                                    | **done** — landed on `feat/enforce-script-deps`: new `check:script-deps` (`bin/check-script-deps.mjs`) asserts every `scripts/*/package.json` declares dependencies == exactly `{"@m3l-automation/m3l-common": "workspace:*"}` and no devDependencies; ESLint hardening added a blanket bare-import ban under `scripts/*/src` (allowing only the library + `node:` builtins) beside the existing `@aws-sdk/*` ban; wired into `package.json` + `ci.yml` (CI-only, no cadence change), `.claude/rules/scripts.md` updated                                                                                                                                    |
| **T7** | Synthetic test for `bin/lib/count-sites.mjs` `deriveCounts()`         | **done** — landed on `feat/enforce-count-sites`: `bin/tests/gen-doc-counts.test.ts` gained a before/after synthetic-bump `describe` covering every `TOTAL_COUNT_SITES`/`IMPLEMENTED_COUNT_SITES` entry plus `buildImplementedListBlock`, guarding against the hardcoded-`22` failure mode from `docs/logs/2026-07-13-aws-sqs.md`                                                                                                                                                                                                                                                                                                                            |
| **T8** | Getter-reality pre-flight check (future, not built now)               | Backlog only. Proposal: a `check:aws-getter-reality`-style script (mirroring `bin/lib/script-scaffold.mjs`'s `serviceNameErrors()` / `check:script-deps`'s dependency assertion) that, at scaffold time or in CI, cross-references a new/edited AWS script's declared `AWSClientProvider` getter against the [AWS getter reality table](./plans/IMPLEMENTATION.md#aws-getter-reality) and fails if the getter is still raw with no corresponding `aws/<service>` wrapper submodule merged or staged as a prerequisite PR. Requires the table's rows to stay current (this rewrite's job) before a machine check can trust it. Not implemented in this pass. |

## Maintenance

When a unit lands (a PR merges): flip its status here and in
[`IMPLEMENTATION.md`](./plans/IMPLEMENTATION.md), `git mv` any dated plan it
completes into [`archive/`](./plans/archive/), and promote the next-priority
item. New friction from a work log is filed into `IMPLEMENTATION.md` (not left
in the log). This is wired into the `implementing-scripts` /
`implementing-submodules` close-out and `writing-work-logs` — see `CLAUDE.md` →
_Agent Operating Model_.

New AWS-consumer-script rows must state getter reality up front: look up the
getter in the [AWS getter reality
table](./plans/IMPLEMENTATION.md#aws-getter-reality) (or add a row there if
the getter is new) before writing the "Depends on" cell. A row may only claim
1-PR scope if the table shows the getter as **wrapped**; if it shows **raw**,
the row must say so and must not assert "existing getter(s) ✓" from the
script's name alone — that exact phrasing is the disproven premise this table
exists to prevent.

**Row-locality rule** (ADR-0024): one item = one table row; a status change
touches only that row; no prose sentence may aggregate more than one item's
status. This is why the Priority 0/1 tables carry a `Status` column instead of
narrative "Landed …" blockquotes — a branch flipping one item's status edits
exactly one line, so two branches landing different items never conflict on
this file.
