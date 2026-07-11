# Roadmap — m3l-automation

The **living, prioritized view of pending program work**. It is the coarse
companion to two other trackers:

- [`docs/implementation-status.md`](./implementation-status.md) — the _done_
  library ledger (22/22 submodules, count-enforced).
- [`docs/plans/IMPLEMENTATION.md`](./plans/IMPLEMENTATION.md) — the _detailed_
  per-item backlog this file summarizes.

This file is **fixed and living** (no date in its name); it is updated as work
lands — mark an item done, archive its plan, pull the next one up. See
_Maintenance_ at the bottom. Completed dated plans live under
[`docs/plans/archive/`](./plans/archive/).

## Status snapshot

- **Library** (`@m3l-automation/m3l-common`) — **22/22 submodules done**, shipped
  at **v1.1.0** (deepen-first WS-A…WS-G). Complete.
- **Consumer fleet** (ADR-0022 / ADR-0021 Phase 5) — **W0 done** (core/json
  `extractAll` #96; aws/clients `cloudWatchLogs`/`dynamoDBDocument`/`athena`
  getters #97; template chore #98). **W1 `json-etl` done** (#99).
  **W2–W5 pending.**

## Priority 0 — Library hardening (do before more scripts)

Fleet-blocking friction surfaced by W1 (the first consumer). These compound
across every later script, so they come **before** W2. Detail + source
call-sites in [`IMPLEMENTATION.md`](./plans/IMPLEMENTATION.md#library-friction-f-series).

| Item   | What                                                                                            | Why now                                                                                                            |
| ------ | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **F8** | `M3LScript` preset seam — presets can't drive a run's config (config loader wires only CLI+env) | HIGH — breaks the §1.4 "presets + CLI overrides" design every fleet script assumes. Filed as task `task_ccda9320`. |
| **F4** | Expose `script.paths` (M3LScript hides its `M3LPaths`)                                          | Every script hand-builds `new M3LPaths()`.                                                                         |
| **F5** | `M3LPaths.resolveInput/Output(name)` (join + contain)                                           | Every script re-implements path join + a traversal guard.                                                          |
| **F1** | Cross-parameter / `required` config validation                                                  | `sort⇒limit` and required-presence are hand-rolled run-start guards.                                               |
| **F2** | `nonEmpty`/`minLength` config validators                                                        | Hand-written inline validators today.                                                                              |
| **F6** | Importer surfaces its skip count                                                                | Only reachable via the `import:error` event.                                                                       |

## Priority 1 — Consumer fleet

| Wave   | Scripts                                                                                             | Status         | Depends on                                                      |
| ------ | --------------------------------------------------------------------------------------------------- | -------------- | --------------------------------------------------------------- |
| **W1** | `json-etl`                                                                                          | **done** (#99) | W0 ✓                                                            |
| **W2** | `dynamo-crud`, `logs-insights`, `sqs-etl`                                                           | pending        | W0 ✓ (scale: checkpoint/resume, batch retry, `failed.jsonl`)    |
| **W3** | `s3-objects`, `lambda-ops`, `ecs-ops`, `cfn-stacks`, `codepipeline-ops`, `eventbridge-schedules`    | pending        | existing getters ✓; thin op-dispatch over the W1/W2 skeleton    |
| **W4** | `data-query` (Athena+`pg`+`mongodb`), `eks-ops` (`@kubernetes/client-node`), `apigw-client` (SigV4) | pending        | each carries a script-local dependency decision (own PR review) |
| **W5** | Promotion pass — steps duplicated across ≥2 scripts graduate into the library                       | pending        | ≥2 scripts existing to observe duplication                      |

Sequencing: W2 proves the scale architecture; W3 is mechanical over existing
clients; W4 last (each has a dependency decision); W5 is the standing F4 loop.

## Priority 2 — Gated / deferred

Deliberately unscheduled until their gate opens (ADR-0021 D4/D5 intake).

| Item                                                        | Unblock condition                                                          |
| ----------------------------------------------------------- | -------------------------------------------------------------------------- |
| **D4** SSM config provider                                  | a 2nd script hand-rolling SSM config fetch (no new deps)                   |
| **D4** SES messaging transport                              | a script needing notifications (new optional `@aws-sdk/client-sesv2` peer) |
| **D4** Lambda-invoke wrapper                                | a script invoking Lambdas (no new deps)                                    |
| **D4** Slack/webhook transport                              | first schedule the `M3LHttpClient` POST enhancement                        |
| **D5** platform extraction                                  | a second repo adopting the workflow                                        |
| **F3** `run(mainFn)` receives a `ctx`                       | 2.0 evidence only (breaking — collect, don't act)                          |
| **F7 / `onUnknownFormat`** tolerant per-record array import | a consumer needing per-record tolerance on irregular non-JSONL input       |
| `@aws-sdk/client-scheduler` getter                          | `eventbridge-schedules` needing flexible (one-off/timezone) schedules      |

## Maintenance

When a unit lands (a PR merges): flip its status here and in
[`IMPLEMENTATION.md`](./plans/IMPLEMENTATION.md), `git mv` any dated plan it
completes into [`archive/`](./plans/archive/), and promote the next-priority
item. New friction from a work log is filed into `IMPLEMENTATION.md` (not left
in the log). This is wired into the `implementing-scripts` /
`implementing-submodules` close-out and `writing-work-logs` — see `CLAUDE.md` →
_Agent Operating Model_.
