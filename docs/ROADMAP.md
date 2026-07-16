# Roadmap — m3l-automation

The **living, prioritized view of pending program work**. It is the coarse
companion to two other trackers:

- [`docs/implementation-status.md`](./implementation-status.md) — the _done_
  library ledger (25/25 submodules, count-enforced).
- [`docs/plans/IMPLEMENTATION.md`](./plans/IMPLEMENTATION.md) — the _detailed_
  per-item backlog this file summarizes.

This file is **fixed and living** (no date in its name); it is updated as work
lands — mark an item done, archive its plan, pull the next one up. See
_Maintenance_ at the bottom. Completed dated plans live under
[`docs/plans/archive/`](./plans/archive/).

## Status snapshot

Per-item status lives in the tables below (Priority 0/1/2) and in
[`docs/implementation-status.md`](./implementation-status.md) — the
count-enforced library ledger (25/25 submodules, shipped at v1.1.0 + the
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

| Wave   | Scripts                                                                                                                                                                    | Status         | Depends on                                                                        |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | --------------------------------------------------------------------------------- |
| **W1** | `json-etl`                                                                                                                                                                 | **done** (#99) | W0 ✓                                                                              |
| **W2** | `dynamodb-crud`                                                                                                                                                            | **done**       | W0 ✓ (scale: checkpoint/resume, batch retry, `failed.jsonl`)                      |
| **W2** | `cloudwatch-logs-insights`                                                                                                                                                 | **done**       | W0 ✓; consumes `aws/cloudwatch-logs-insights` (`M3LLogsInsightsClient`, ADR-0027) |
| **W2** | `sqs-etl`                                                                                                                                                                  | **done**       | W0 ✓; consumes `aws/sqs` (`M3LSQSOperations`, ADR-0026)                           |
| **W3** | `s3-objects`, `lambda-ops`, `ecs-ops`, `cloudformation-stacks`, `codepipeline-ops`, `eventbridge-schedules`                                                                | pending        | existing getters ✓; thin op-dispatch over the W1/W2 skeleton; names per ADR-0028  |
| **W4** | `athena-query` (Athena via existing getter; `pg`/`mongodb` dropped), `eks-ops` (EKS control-plane only), `api-gateway-client` (SigV4 via a future library signing wrapper) | pending        | all consume library wrappers only (ADR-0029); names per ADR-0028                  |
| **W5** | Promotion pass — steps duplicated across ≥2 scripts graduate into the library                                                                                              | pending        | ≥2 scripts existing to observe duplication                                        |

Sequencing: W2 proves the scale architecture; W3 is mechanical over existing
clients; W4 last (each needs a new library wrapper first, ADR-0029); W5 is the
standing F4 loop.

## Priority 2 — Gated / deferred

Deliberately unscheduled until their gate opens (ADR-0021 D4/D5 intake).

| Item                                                                                 | Unblock condition                                                                                                                                        |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D4** SSM config provider                                                           | a 2nd script hand-rolling SSM config fetch (no new deps)                                                                                                 |
| **D4** SES messaging transport                                                       | a script needing notifications (new optional `@aws-sdk/client-sesv2` peer)                                                                               |
| **D4** Lambda-invoke wrapper                                                         | a script invoking Lambdas (no new deps)                                                                                                                  |
| **D4** Slack/webhook transport                                                       | first schedule the `M3LHttpClient` POST enhancement                                                                                                      |
| **D5** platform extraction                                                           | a second repo adopting the workflow                                                                                                                      |
| **F1b** cross-parameter validation seam                                              | a 2nd script hand-rolling a cross-field guard (`json-etl`'s `sort⇒limit` / `sort ∈ fields` is the 1st); needs an `M3LConfig`/`M3LConfigSchema`-level API |
| **F3** `run(mainFn)` receives a `ctx`                                                | 2.0 evidence only (breaking — collect, don't act)                                                                                                        |
| **F7 / `onUnknownFormat`** tolerant per-record array import                          | a consumer needing per-record tolerance on irregular non-JSONL input                                                                                     |
| `@aws-sdk/client-scheduler` getter                                                   | `eventbridge-schedules` needing flexible (one-off/timezone) schedules                                                                                    |
| **TypeScript 6→7 toolchain upgrade** (deliberate hold)                               | TS7 verified across the toolchain (typescript-eslint, vitest, `tsc -b`) + a toolchain-upgrade decision (`check:deps` notice, PR #95)                     |
| **External code-index MCP** (ADR-0012, re-affirmed by ADR-0023)                      | W2–W4 fleet landed + observed spoke grep friction the catalog/symbol-map can't answer                                                                    |
| **ADR-0025** dynamic-workflows pilot (`auditing` fan-out + adversarial verification) | governance prerequisites land — `.claude/workflows/` surface validated against the MODEL-MATRIX and a token/agent-count guardrail defined (see ADR-0025) |

## Governance follow-ups (ADR-0028 / ADR-0029)

Filed by the 2026-07-15 fleet-governance audit
([plan](./plans/archive/2026-07-15-fleet-governance-reconciliation.md)). Each
is its own PR; the renames T1–T3 clear the ADR-0028 noncompliance ledger.

| Item   | What                                                                  | Notes                                                                                                                                                                                                                                                                                                                                  |
| ------ | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **T1** | Rename script `dynamo-crud` → `dynamodb-crud`                         | **done** — landed on `refactor/rename-dynamo-crud`: directory, package name, root `tsconfig.json` ref, reference-page filename, W2 row here, ADR-0027 fleet-example mention untouched (historical); `docs/logs/` + `docs/plans/archive/` filenames stay (immutable history); full gates + `/syncing-docs` after                        |
| **T2** | Rename script `logs-insights` → `cloudwatch-logs-insights`            | **done** — landed on `refactor/rename-logs-insights-script`: directory, package name, root `tsconfig.json` ref, reference-page filename, W2 row here, `docs/logs/` + `docs/plans/archive/` filenames stay (immutable history); full gates + `/syncing-docs` after                                                                      |
| **T3** | Rename submodule `aws/logs-insights` → `aws/cloudwatch-logs-insights` | **done** — landed on `refactor/rename-aws-logs-insights`: src dir + barrel line in `src/aws/index.ts`, reference page + provenance sidecar filenames, test filename, `gen:index` regen; no public subpath change; symbols kept `M3LLogsInsights*` names (renaming them would be semver-major)                                          |
| **T4** | Track today-untracked count literals in `bin/lib/count-sites.mjs`     | **done** — landed on `feat/enforce-count-sites`: added the CLAUDE.md AWS-barrel-comment site (`TOTAL_COUNT_SITES`) and two sibling numerator/denominator site pairs for this file's `25/25` intro pointer + Status-snapshot literals; `gen:counts`/`check:doc-counts`/`check:impl-counts` verified idempotent against the current tree |
| **T5** | Scaffold naming check (ADR-0028)                                      | **done** — landed on `feat/enforce-aws-service-names`: `bin/lib/script-scaffold.mjs` gained `serviceNameErrors()` (a denylist of known-bad abbreviations/bare-capability names per ADR-0028's ban-list — no canonical AWS service vocabulary exists yet, so this catches known offenders rather than affirmatively verifying compliance), wired into both `scaffold-script.mjs` (blocks creation) and `check-script-scaffold.mjs` (flags existing packages) |
| **T6** | Script dependency check (ADR-0029)                                    | assert every `scripts/*/package.json` declares dependencies == exactly `{"@m3l-automation/m3l-common": "workspace:*"}` and no devDependencies (extend `check:deps` or a new `check:*`); optional ESLint hardening: ban all bare imports under `scripts/*/src` except the library and `node:` builtins                                  |
| **T7** | Synthetic test for `bin/lib/count-sites.mjs` `deriveCounts()`         | **done** — landed on `feat/enforce-count-sites`: `bin/tests/gen-doc-counts.test.ts` gained a before/after synthetic-bump `describe` covering every `TOTAL_COUNT_SITES`/`IMPLEMENTED_COUNT_SITES` entry plus `buildImplementedListBlock`, guarding against the hardcoded-`22` failure mode from `docs/logs/2026-07-13-aws-sqs.md`       |

## Maintenance

When a unit lands (a PR merges): flip its status here and in
[`IMPLEMENTATION.md`](./plans/IMPLEMENTATION.md), `git mv` any dated plan it
completes into [`archive/`](./plans/archive/), and promote the next-priority
item. New friction from a work log is filed into `IMPLEMENTATION.md` (not left
in the log). This is wired into the `implementing-scripts` /
`implementing-submodules` close-out and `writing-work-logs` — see `CLAUDE.md` →
_Agent Operating Model_.

**Row-locality rule** (ADR-0024): one item = one table row; a status change
touches only that row; no prose sentence may aggregate more than one item's
status. This is why the Priority 0/1 tables carry a `Status` column instead of
narrative "Landed …" blockquotes — a branch flipping one item's status edits
exactly one line, so two branches landing different items never conflict on
this file.
