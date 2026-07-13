# Roadmap — m3l-automation

The **living, prioritized view of pending program work**. It is the coarse
companion to two other trackers:

- [`docs/implementation-status.md`](./implementation-status.md) — the _done_
  library ledger (24/24 submodules, count-enforced).
- [`docs/plans/IMPLEMENTATION.md`](./plans/IMPLEMENTATION.md) — the _detailed_
  per-item backlog this file summarizes.

This file is **fixed and living** (no date in its name); it is updated as work
lands — mark an item done, archive its plan, pull the next one up. See
_Maintenance_ at the bottom. Completed dated plans live under
[`docs/plans/archive/`](./plans/archive/).

## Status snapshot

Per-item status lives in the tables below (Priority 0/1/2) and in
[`docs/implementation-status.md`](./implementation-status.md) — the
count-enforced library ledger (24/24 submodules, shipped at v1.1.0 + the
ad-hoc `aws/dynamodb` and `aws/sqs` additions, ADR-0026).

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

| Wave   | Scripts                                                                                             | Status         | Depends on                                                             |
| ------ | --------------------------------------------------------------------------------------------------- | -------------- | ---------------------------------------------------------------------- |
| **W1** | `json-etl`                                                                                          | **done** (#99) | W0 ✓                                                                   |
| **W2** | `dynamo-crud`                                                                                       | **done**       | W0 ✓ (scale: checkpoint/resume, batch retry, `failed.jsonl`)           |
| **W2** | `logs-insights`                                                                                     | **done**       | W0 ✓; consumes `aws/logs-insights` (`M3LLogsInsightsClient`, ADR-0027) |
| **W2** | `sqs-etl`                                                                                           | **done**       | W0 ✓; consumes `aws/sqs` (`M3LSQSOperations`, ADR-0026)                |
| **W3** | `s3-objects`, `lambda-ops`, `ecs-ops`, `cfn-stacks`, `codepipeline-ops`, `eventbridge-schedules`    | pending        | existing getters ✓; thin op-dispatch over the W1/W2 skeleton           |
| **W4** | `data-query` (Athena+`pg`+`mongodb`), `eks-ops` (`@kubernetes/client-node`), `apigw-client` (SigV4) | pending        | each carries a script-local dependency decision (own PR review)        |
| **W5** | Promotion pass — steps duplicated across ≥2 scripts graduate into the library                       | pending        | ≥2 scripts existing to observe duplication                             |

Sequencing: W2 proves the scale architecture; W3 is mechanical over existing
clients; W4 last (each has a dependency decision); W5 is the standing F4 loop.

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
