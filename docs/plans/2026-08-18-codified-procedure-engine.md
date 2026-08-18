# Codified-procedure engine — implementation plan (2026-08-18)

- **Status:** active
- **Owner:** Enrico Lionello (maintainer)
- **Decisions:** [ADR-0046](../adr/0046-codified-procedure-engine.md),
  [ADR-0047](../adr/0047-cross-script-orchestration-deferred.md),
  [ADR-0048](../adr/0048-target-graded-destructive-confirmation.md),
  [ADR-0049](../adr/0049-cooperative-cancellation-contract.md), plus 2026-08-18
  Update blocks on ADR-0018, ADR-0035, ADR-0042, ADR-0043 and ADR-0045.
- **Trackers:** [`../ROADMAP.md`](../ROADMAP.md) §_Codified-procedure engine wave_
  and [`IMPLEMENTATION.md`](./IMPLEMENTATION.md) §_Codified-procedure engine wave_
  carry the live status; this file carries the detail behind those rows.

## Why this plan exists

A capability audit of the library, the consumer-script layer and the gate
machinery found that most candidate improvements were already implemented. Six
genuine gaps survived, every one of them with consumers **already shipped in the
fleet**, and a maintainer decision named a consumer for a capability the library
does not have at all: an engine for multi-step procedures whose control flow and
conclusions are data rather than hand-written branching.

The six gaps are not incidental to that engine — three of them (cancellation,
partial outcomes, no-progress detection) are exactly what its execution context and
runtime guards need. So Wave A is sequenced first on its own merits **and** as the
foundation Wave B stands on.

## Scope and sequencing

| Wave  | Contents                                                       | Shape                                                      |
| ----- | -------------------------------------------------------------- | ---------------------------------------------------------- |
| **A** | A1–A6, the library primitives                                  | Independently shippable; useful even if Wave B never lands |
| **B** | B1 decisions (this PR), B2 the engine, B3 the named consumer   | Depends on A1, A3, A5                                      |
| **C** | C1 cross-script orchestrator, C2 the dormant event-source seam | Recorded only; nothing built                               |

One PR per item, in order. A2, A3, A4 and A5 each split into a **library PR then a
fleet-retrofit PR**, following the two-PR chain precedent recorded across the W3/W4
work logs. Do not batch items onto one branch: `pre-push` runs the full gate set,
so one failing lane would block unrelated work.

Every item below writes into `packages/*/src/**`, `scripts/*/src/**` or
`**/tests/**`, so each begins with `/starting-work` and dispatches
`code-implementer` / `test-author`. The hub never writes those paths
(`guard-hub-src-writes.mjs`).

---

## Wave A — library primitives

### A1. Cooperative cancellation seam

**Decision:** ADR-0049.

**Gap evidence.** `AbortSignal` appears only in `core/network/M3LHttpClient`; zero
references under `packages/m3l-common/src/aws/**`, `core/polling/**` or
`core/script/**`. `M3LScript.ts:415` registers `SIGTERM`/`SIGINT`/`SIGQUIT` and
runs cleanup, but nothing can tell in-flight work to stop. Ten `aws/*` submodules
build on `M3LPoller`/`M3LRetryRunner`; eight `waitUntil*` waiters plus a
CodePipeline execution watch and two query polls are minute-scale by design.

**Contract.**

- `core/script` — `M3LScript` owns an `AbortController`, aborts it on the first
  shutdown signal alongside `runCleanup("signal-shutdown")`, and exposes the signal
  through a getter shaped like the existing paths accessor.
- `core/polling` — optional `signal` on `M3LPollerOptions` (`M3LPoller.ts:37`) and
  `M3LRetryRunnerOptions` (`M3LRetryRunner.ts:65`); checked between attempts and
  abandoning any pending backoff delay immediately.
- `aws/**` — optional `signal` on the waiter/poller option bags, forwarded to the
  SDK's per-command `abortSignal`: `M3LECSOperations.waitUntilServicesStable`, the
  three `M3LCloudFormationOperations` stack waiters, the four `M3LEKSOperations`
  cluster/nodegroup waiters, `M3LCodePipelineOperations`' execution watch,
  `M3LAthenaClient` query polling, `M3LLogsInsightsClient` polling.
- The abort error carries a dedicated code, `origin: "caller"`, `retryable: false`,
  and **no classifier may reclassify it**.
- `core/diagnostics` — a cancelled run resolves to the existing `interrupted`
  `M3LRunOutcome`, not `failure`.

**Do not** widen an ESLint zone to make this compile — the `aws/**` island already
admits `core/polling` (`bin/check-eslint-zones.mjs:96`). A perceived need to widen
means the design is wrong.

**Verify.** Per-module: a signal aborted mid-wait rejects promptly with the abort
code and does not retry; a never-aborted signal changes nothing. End-to-end:
`SIGINT` during a waiter yields `interrupted` in `run-report.json`.

**Semver:** additive minor.

### A2. Target-graded confirmation gate

**Decision:** ADR-0048.

**Gap evidence.** `M3LConfirmDestructiveOptions` is
`{ prompt, logger, description, yes, code }` — no target dimension — while
`M3LScript` resolves `aws.profile`/`aws.region` (`M3LScript.ts:969`, `:1034`). The
gate has **15 call sites across 11 scripts** plus the `core/pipeline` gate phase.
Deleting in a scratch account and in production prompt identically, and `--yes`
bypasses both identically.

**Contract.** Optional target identity (profile, region, account id where already
available) plus a sensitivity policy. No target → byte-identical to today.
Non-sensitive → today's path including the `yes` bypass. Sensitive → escalated
prompt naming the target, **not** bypassable by the plain `yes` flag; a separate
named opt-in is required, and using it always logs a warning naming the target.
Adopt parse-time rejection of unsafe flag combinations in the same change.

**Retrofit (PR 2).** The 11 call-site scripts opt in, highest-blast-radius first:
`s3-objects`, `dynamodb-crud`, `cloudformation-stacks`, `eks-ops`, `ecs-ops`, then
the remainder.

**Verify.** No target → unchanged; sensitive + plain `yes` → still prompts;
sensitive + named opt-in → proceeds and warns; non-sensitive → today's path.

**Semver:** additive minor.

### A3. Degraded runs as a first-class outcome

**Decision:** ADR-0035's 2026-08-18 Update.

**Gap evidence.** `M3LOperationPipelineOutcome.status` is `completed | declined`;
`M3LRunOutcome` is `success | failure | dry-run | interrupted`. A run that
processed 997 of 1000 and one that processed 0 both report `failure`.
`s3-objects`' `finalize` throws whenever any key failed; `dynamodb-crud` writes
`failed.jsonl` that nothing above it reads.

**Contract.** Widen the pipeline status with `"partial"`, carrying readonly
recovery entries (item identity, serialised error, timestamp) reported by the
handler through a narrow seam — the engine never infers the classification. Add the
matching `M3LRunOutcome` arm plus its own `M3L_EXIT_CODES` entry (a partial run must
not exit `0`). Adopt the **mandatory-fallback discipline** in the same change:
every terminal path resolves to a _named_ outcome, applied here and to
`core/analysis`'s `M3LThresholdEvaluator`.

**Watch item.** Widening these unions is technically breaking for an exhaustive
`switch`. All consumers are in-repo and `pnpm typecheck` shows the blast radius;
settle the version treatment against ADR-0020 before the library PR merges.
`check:api` must not move — both symbols are barrel-surfaced.

**Retrofit (PR 2).** `s3-objects` (delete-batch), `sqs-etl`, `dynamodb-crud`,
`rds-data-sql`.

### A4. Checkpoint fingerprinting

**Decision:** ADR-0045's 2026-08-18 Update.

**Gap evidence.** `M3LCheckpointStore`'s envelope `checksum` is
`canonicalJsonHash(payload)` — payload integrity only. Nothing binds a checkpoint to
the configuration that wrote it.

**Contract.** Optional `fingerprint` on the envelope, computed with the existing
`canonicalJsonHash` over a caller-supplied definition value. Mismatch on read fails
with a dedicated code rather than resuming. No `fingerprint` → reads as today; no
definition supplied → writes none; the legacy no-envelope path
(`M3LCheckpointStore.ts:258-263`) is untouched.

**Retrofit (PR 2).** `athena-query`, `cloudwatch-logs-insights`, `dynamodb-crud`,
each fingerprinting the settings that give its offsets meaning.

### A5. No-progress detection

**Gap evidence.** Polling and pagination bound only on an attempt/iteration
ceiling. A repeating page token or unchanging offset burns the whole ceiling in
real AWS calls before failing.

**Contract.** An opt-in progress witness on `M3LPoller`/`M3LRetryRunner`: the caller
supplies a cheap comparable value per attempt; the runner fails with a dedicated
code once it observes that value unchanged across a configured number of
consecutive attempts. Deliberately independent of the ceiling. Absent a witness,
behaviour is unchanged.

**Consumers.** `cloudwatch-logs-insights` window planning, `dynamodb-crud` scan
pagination. Reused as B2's runtime loop guard.

### A6. Per-phase trace on `M3LOperationPipeline`

**Gap evidence.** `M3LOperationPipelineOutcome` is `{ operation, status, result }` —
no timing, no phase record — although `M3LBreadcrumbTrail` and the run report's
`timeline` are ready seams.

**Contract.** Optional `trace` on `M3LOperationPipelineOptions`: an
`M3LBreadcrumbSource`-compatible sink plus
`describe?: (operation, settings, context) => Readonly<Record<string, M3LBreadcrumbScalar>>`.
One entry per phase of the documented ten-phase order, each carrying phase name,
operation and duration. `describe` runs **at phase entry, before the phase body**,
so the trace records the _resolved_ value the phase used, not the declaration.

The scalar return type is the allowlist constraint from ADR-0035's 2026-07-23
update, and it is what lets the trace inherit the breadcrumb trail's stronger
sharing guarantee rather than the run report's crash-dump classification. Absent
`trace`, behaviour is identical.

**Also.** `validatePipelineOptions`
(`packages/m3l-common/src/internal/pipeline/validate.ts`) reports every problem at
once, each under its own code, instead of throwing on the first.

---

## Wave B — the engine

### B1. Decisions — shipped in this change set

ADR-0046/0047/0048/0049, the five Update blocks, the ADR index rows, this plan, and
the tracker sections. No code.

### B2. `core/procedure`

**Decision and full design contract:** ADR-0046. Summary of what to build:

- **Types** — `Step` (`id`, `label`, `kind`, `execute`, optional `describeTrace`),
  step kinds `gather | transform | check | decide | control`, the step result
  envelope, and the flow directive `continue | stop | resolve | { goTo }`.
- **Context** — immutable, copy-on-write; step results keyed by id, extracted
  values, injected deps, recovered errors (A3), cancellation signal (A1).
- **Conditions** — serialisable `compare | matches | contains | exists` composed
  with `and`/`or`/`not`, over a reference syntax addressing step outputs, extracted
  values and parameters. The evaluator returns the **resolved values** alongside the
  boolean so a match is explainable. The `matches` arm is string-only over bounded
  input, per ADR-0039.
- **Cases** — id, description, condition, action, **unique** priority, operator
  prose; plus a **mandatory fallback**.
- **Builder validation** — reports every problem at once under its own code:
  duplicate step id, invalid jump target, cycle detected (DFS with node colouring
  over implicit and explicit edges), duplicate case id, duplicate case priority,
  empty step list, missing fallback.
- **Engine** — three phases: execute steps honouring flow directives, evaluating all
  cases immediately on `resolve` and terminating early on a match; otherwise
  evaluate cases in descending priority; then run the matched case's action or the
  fallback.
- **Runtime guards** — iteration ceiling, the A5 no-progress guard, per-step
  `continueOnFailure` recording a recovery entry, signal honoured at every step
  boundary.
- **Digest** — `canonicalJsonHash` over the built definition, surfaced on the
  outcome and usable as an A4 fingerprint.

**Import constraints.** Must not import `aws/**` or `core/script`; `pnpm check:zones`
is the gate and no zone may be widened.

**Submodule wiring** (mechanical, each gated): `src/core/procedure/index.ts` plus
the `core/index.ts` barrel line (`check:scaffold`);
`packages/m3l-common/tests/procedure.test.ts` (`check:scaffold-seam`); a row in
`docs/implementation-status.md`; `docs/reference/core/procedure.md` and its
provenance sidecar; Core count 22 → 23 and total 41 → 42 at **every** count site via
`pnpm gen:counts` — never hand-edited.

### B3. `cloudwatch-logs-analysis` — the named consumer

Scaffold with `pnpm scaffold:script` (ADR-0028 naming; `serviceNameErrors()` gates
it). It declares a log-analysis procedure: gather steps issuing Logs Insights
queries through the existing `M3LLogsInsightsClient`, transform steps extracting
fields, check steps asserting conditions, a `decide` step where an operator choice
is genuinely required, and a prioritised case list whose prose is what the operator
reads. Log groups, time windows, thresholds and expected patterns are config
parameters and presets, not code.

Deliberately a **new** script, so no shipped script is destabilised while the step
vocabulary settles.

---

## Wave C — recorded, not built

- **C1** — cross-script orchestration, placed in `packages/m3l-cli` and deferred by
  ADR-0047; revisit trigger is a named multi-script flow.
- **C2** — the event-source seam (`createLambdaHandler`,
  `M3LLambdaEventConfigProvider`) recorded as deliberately dormant by ADR-0018's
  2026-08-18 Update; zero references under `scripts/*/src/`; activation trigger is a
  script that must run from an event source or a schedule.

---

## Documentation reconciliation

Per shipped item: update the affected contract pages
(`docs/reference/core/{procedure,pipeline,polling,script,checkpoint,diagnostics,prompt,analysis}.md`,
the touched `docs/reference/aws/*.md`, the new and retrofitted
`docs/reference/scripts/*.md`), flip the matching tracker rows, then run
`/syncing-docs` — it owns provenance re-stamping, count regeneration,
`check:doc-exports`, the reference index and markdown lint. Never hand-edit a count
literal.

## Definition of done

- `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` pass.
- `pnpm test:coverage` clears the per-file thresholds (lines 90 / functions 83 /
  branches 80 / statements 89) for every new and touched file.
- `pnpm check:zones` passes with no zone widened.
- `pnpm check:api` and `pnpm check:exports` pass — the three-entry `exports` map is
  unchanged.
- `pnpm check:scaffold`, `check:scaffold-seam`, `check:script-scaffold`,
  `check:script-deps` pass for the new submodule and the new script.
- `pnpm verify` reproduces the CI `verify` job clean.
- Trackers flipped, `pnpm sync:hub` dry-run reviewed and applied.
- A work log per shipped wave under `docs/logs/`.
