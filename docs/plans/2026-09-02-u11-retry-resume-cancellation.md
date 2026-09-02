# U11 — retry/resume/cancellation surfacing — design plan (2026-09-02)

- **Status:** active
- **Owner:** Enrico Lionello (maintainer)
- **Decisions:** [ADR-0086](../adr/0086-retry-attempt-metadata-seam.md) (the
  per-attempt retry seam and its transport — this wave's own decision),
  [ADR-0049](../adr/0049-cooperative-cancellation-contract.md) (the abort
  contract the cancellation slice wires up),
  [ADR-0045](../adr/0045-streaming-safe-resume-contract.md) (the
  refuse-on-fingerprint-mismatch precedent the resume slice mirrors),
  [ADR-0063](../adr/0063-cli-structured-run-results.md) (the
  allowlisted-scalar run-report read discipline),
  [ADR-0054](../adr/0054-command-module-contract-and-hybrid-execution.md) (the in-process command-module
  seam that carries `context.signal`),
  [ADR-0072](../adr/0072-reviewable-slice-discipline.md) (slice sizing)
- **Trackers:** [`IMPLEMENTATION.md`](./IMPLEMENTATION.md) row
  **U11 — retry/resume/cancellation surfacing**; GitHub issue #535; epic #608
- **Predecessor:** [`2026-08-20-cli-evolution.md`](./2026-08-20-cli-evolution.md)
  §_U11_ — that plan decomposes the U-series;
  [`2026-09-01-orchestration-engine.md`](./2026-09-01-orchestration-engine.md)
  built the flow engine whose resume ports this plan finally wires.

## Why this plan exists

U11 is the last item of ADR-0053's "deepened launcher" pillar (U13 is the only
other open row; U14 is Deferred). The tracker row asks for three surfaces plus
a decision:

> `--resume` passthrough (ADR-0045 fingerprint-aware), Ctrl-C → cooperative
> cancellation on the in-process path (ADR-0049), retry/outcome visibility in
> `history`/run-report rendering; a missing library seam gets its own decision
> (possible minor).

The row held up on re-derivation, but **three of its claims are wrong about
where the work lives**, and correcting them changes the slice count from the
row's implied three to seven. That is what this document records. The seam
decision itself is ADR-0086's, not this plan's.

## Re-derived state

Per CLAUDE.md's "re-derive any authored claim" rule, every clause of the row
was checked against live code rather than trusted.

| Row's claim                               | Live state                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| in-process parts depend on U7             | **Satisfied.** U7 is Done and `run/in-process.ts:161-167` explicitly defers Ctrl-C → `AbortSignal` to U11, hardwiring `context.signal` to `undefined`. The port exists; only the owner is missing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `--resume` passthrough on the script path | **Wrong surface.** `--resume` is a `m3l flow` flag: `commands/flow.ts:57,173-175` **rejects** it at exit 2 and names U11 as its owner, `flow/run.ts:45-53` already exposes `resumeFromStepId` + `stepExecutionCount`, and `docs/reference/cli.md:525-528` documents the rejection as U10's deliberate scope limit. **No script-dispatch path declares a resume parameter at all**, so a script-level `--resume` would need a per-script parameter contract first — out of scope here.                                                                                                                                                                                                                                                                                                  |
| ADR-0045 fingerprint-aware                | **Already built, in the flow layer.** `flow/record.ts:65` persists a `definitionHash`, and `hashFlowDefinition` (`record.ts:170`) canonicalizes mapping order while preserving array order precisely so "a reformatted file must hash identically — otherwise a resume would be refused after an innocuous re-indent" (`record.ts:104-112`). The ADR-0045 discipline is present; what is missing is a resume that _consults_ it. The `M3LCheckpointStore` envelope needs **no change**.                                                                                                                                                                                                                                                                                                |
| Ctrl-C → cooperative cancellation         | **Half built, and the missing half is not the half the row names.** `M3LScript` already registers `SIGTERM`/`SIGINT`/`SIGQUIT` itself outside AWS-managed environments and aborts its controller before cleanup (`M3LScript.ts:541-548`), so a **spawned child already unwinds cooperatively today**. But `spawn.ts` spawns non-`detached` with inherited stdio, so a terminal Ctrl-C hits the CLI parent too — and the parent registers **no handler anywhere**, so Node's default disposition terminates it before `resolveExitCode` (`spawn.ts:185`) and before `locateRunReport` (`run/execute.ts:20`). The operator loses the envelope, the history entry, and the resolved exit code while the child is still writing cleanup output. The in-process path is separately unwired. |
| "a missing library seam"                  | **Identified and decided.** `core/polling/events.ts` computes every field a renderer needs but `poll<T>()`/`run<T>()` return `Promise<T>` and discard it (`M3LPoller.ts:180`, `M3LRetryRunner.ts:351`). ADR-0086 records the options, disproves the cheap "route it through `core/procedure`" answer, and picks a sibling detailed method — **semver minor**.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| retry/outcome visibility                  | **Two deliverables, not one.** `outcome` and `recoveryTotal` already exist on the envelope (`run/envelope.ts:165,171`) and are simply absent from `m3l history`, whose entry has four fields — `timestamp`, `script`, `parameterNames`, `exitCode` (`history/store.ts:45-54`) — rendered as `TIME / SCRIPT / PARAMETERS / EXIT` (`commands/history.ts:14`). _Attempt_ visibility is the part that needs the seam and a report field.                                                                                                                                                                                                                                                                                                                                                   |

Two further findings that shape the sequence:

- **The in-process path writes no run report.** `run/in-process.ts` never
  touches `report-lookup` or a report file — it invokes the command module and
  maps the outcome to an exit code. Report-borne retry visibility is therefore
  a **spawn-path capability**, and this plan does not claim otherwise.
- **`report-lookup` admits only allowlisted scalars** (`report-lookup.ts:1-5,197`)
  and the envelope only _counts_ timeline entries (`envelope.ts:166-169`). The
  transport for attempt data must be a scalar, per ADR-0086.

## Slice sequence

Seven slices, docs-first per ADR-0072. **Open one at a time** — a
squash-merged parent turns a stacked child into duplicate history. Each slice
branches fresh from `origin/main` after its predecessor merges. Projected
reviewable sizes are estimates against `check:review-size`'s 75,000-byte soft
target; U10's row projected two PRs and shipped ten, so these are planning
figures, not promises.

| #   | Branch                               | Contents                                                                                                                            | Projected | Semver                   |
| --- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------ |
| 1   | `feat/u11-retry-resume-cancellation` | This document + ADR-0086 + its index row + the tracker's Source/notes cell. Docs-only.                                              | ~0        | none                     |
| 2   | `feat/u11-resume-passthrough`        | `m3l flow <name> --resume`: newest-record lookup, `definitionHash` comparison, refuse-on-mismatch, pass both resume ports.          | ~35 KB    | none (CLI unpublished)   |
| 3   | `feat/u11-cooperative-cancellation`  | In-process `AbortController` + signal ownership → `context.signal`; parent survive-and-report on the spawn path.                    | ~30 KB    | none                     |
| 4   | `feat/u11-run-report-extraction`     | Behaviour-preserving extraction out of `core/diagnostics/run-report.ts` to create headroom. No behaviour change, no new field.      | ~45 KB    | none                     |
| 5   | `feat/u11-retry-outcome-seam`        | `pollDetailed`/`runDetailed` + result types, barrel surfacing, `docs/reference/core/polling.md`.                                    | ~50 KB    | **minor** (`m3l-common`) |
| 6   | `feat/u11-retry-report-field`        | The scalar attempt field on `M3LRunReportInput`/`M3LRunReport`, `run-script` population, `report-lookup` allowlist, envelope.       | ~45 KB    | **minor** (`m3l-common`) |
| 7   | `feat/u11-retry-outcome-rendering`   | `m3l history` gains outcome + attempts; `history/store.ts` entry fields; `docs/reference/cli.md`; tracker flip to Done; `sync:hub`. | ~35 KB    | none                     |

**Why the extraction (slice 4) is its own PR and lands before the seam.**
`run-report.ts` measures 65,630 bytes and its `file-budget-baseline.json`
entry records exactly 65,630 — zero headroom. Slice 6 cannot add a field
until something leaves that file. Folding the extraction into slice 6 would
put a behaviour-preserving refactor of a 65 KB file in the same diff as a new
public field, which is both over the review-size target and the shape of
change this repo has learned to separate. Landing it early also keeps it out
of conflict with slices 2, 3, and 5, none of which touch `run-report.ts`.

**Ordering dependencies.** Slices 2 and 3 are independent of everything else
and may land in either order. Slice 5 depends on nothing but is useless
without 6. Slice 6 depends on 4 (headroom) and 5 (a typed source for the
count). Slice 7 depends on 6.

## File-budget traps

`check:file-budget` (`bin/check-file-budget.mjs`) is a **ratchet**, not a flat
limit: a file in `bin/file-budget-baseline.json` caps at its recorded size, a
non-baselined `src` file at `SRC_CEILING_BYTES` = 25,000, and a non-baselined
test file at `TEST_CEILING_BYTES` = 60,000. It runs no earlier than
`pre-push`, so every one of these is a late failure and a rebase, not a
two-minute move.

| File                                                     | Now    | Cap                | Headroom | Slice         |
| -------------------------------------------------------- | ------ | ------------------ | -------- | ------------- |
| `packages/m3l-common/src/core/diagnostics/run-report.ts` | 65,630 | 65,630 (baselined) | **0**    | 4, 6          |
| `packages/m3l-cli/src/main.ts`                           | 23,683 | 25,000             | 1,317    | 2, 3          |
| `packages/m3l-cli/src/flow/record.ts`                    | 20,719 | 25,000             | 4,281    | 2             |
| `packages/m3l-cli/src/commands/flow.ts`                  | 16,583 | 25,000             | 8,417    | 2             |
| `packages/m3l-cli/src/run/spawn.ts`                      | 11,954 | 25,000             | 13,046   | 3             |
| `packages/m3l-cli/src/run/in-process.ts`                 | 10,473 | 25,000             | 14,527   | 3             |
| `packages/m3l-common/src/core/polling/M3LRetryRunner.ts` | 19,641 | 25,000             | 5,359    | 5             |
| `packages/m3l-common/src/core/polling/M3LPoller.ts`      | 12,240 | 25,000             | 12,760   | 5             |
| `packages/m3l-cli/tests/main.test.ts`                    | 53,421 | 60,000             | 6,579    | 2, 3          |
| `packages/m3l-common/src/core/script/M3LScript.ts`       | 69,147 | 69,512 (baselined) | 365      | 3 (read-only) |

Three of these need conscious care:

- **`run-report.ts` at zero headroom** is the whole reason slice 4 exists. The
  extraction must move real bytes out — a new `src` file under 25,000 — and
  must leave `run-report.ts` strictly smaller. No baseline edit is needed or
  wanted: a file _under_ its baseline passes, and the surviving 65,630 entry
  then acts as the budget slice 6's new field spends from.
- **`main.ts` at 1,317 bytes** is the trap that previously took it
  22,603 → 24,253 and cost a rebase. Slices 2 and 3 must put flag parsing in
  `cli/flags.ts` (10,061 b — already home to `partitionJsonFlag`,
  `partitionInProcessFlag`, `partitionEnvFileFlags`) and keep `main.ts` to a
  delegation call.
- **`main.test.ts` at 6,579 bytes** is the least visible of the three. Slices
  2 and 3 both add CLI-level cases; if the file crosses 60,000 the fix is a
  new test file, decided up front rather than at push time.

`completion-script.ts` (24,466 b, 534 b headroom) is **not** a trap here:
`globalFlags`/`dynamicFlags` arrive as model fields, so registering `--resume`
for completion is a one-line addition to `DYNAMIC_FLAGS`
(`commands/completion.ts:74`, 9,472 b) and `completion-script.ts` is untouched.
`M3LCheckpointStore.ts` (49,710 b, baselined at exactly its size) is likewise
moot — ADR-0045's envelope needs no change.

## Per-slice test obligations

**Slice 2 — `m3l flow --resume`.** The rejection path is currently _tested_,
so its test flips rather than disappears: removing the exit-2 rejection must
update `flow-command.test.ts` (37,205 b) in the same commit. New cases: a
resume that starts at the recorded `resumeStepId`; a resume refused because
`definitionHash` no longer matches the current definition (the ADR-0045
mirror, asserting the dedicated code, not just a non-zero exit); a resume
against a record whose `resumeStepId` is `null`; `stepExecutionCount` seeding
the loop guard so a resumed run cannot re-spend the whole budget. The
mismatch case must be **mutation-tested**: change one byte of the definition
and watch the refusal fire, or it guards nothing.

**Slice 3 — cancellation.** Unit tests cover the in-process path by aborting
the injected controller and asserting the command module observes
`context.signal.aborted` and that the outcome maps to `interrupted`, not
`128 + SIGINT`. The parent survive-and-report behaviour needs a spawn-path
test with an injected `spawnImpl` that resolves after a simulated signal.
**No unit test proves the real thing**: this slice is not done until an actual
Ctrl-C against `m3l <script> --in-process` is observed unwinding through
cleanup, and a Ctrl-C against a spawned run is observed still producing an
envelope and a history entry. `dynamic.test.ts` is 48,572 b and
`main.test.ts` 53,421 b — watch the 60,000 ceiling.

**Slice 4 — extraction.** Behaviour-preserving, so the obligation is that
`diagnostics-run-report.test.ts` (191,086 b, baselined) passes **unchanged**.
Any test edit in this slice is evidence the extraction changed behaviour. Its
own file-budget check is the real gate.

**Slice 5 — the seam.** `polling.test.ts` (85,008 b, baselined) gains
`pollDetailed`/`runDetailed` cases: the value matches what `poll`/`run` would
have returned; the attempt count matches the emitted `retry:attempt` sequence
(cross-checked against a subscribed listener, so the two sides come from
genuinely different sources); and — the ADR-0086 constraint — an aborted wait
still rejects with `ERR_OPERATION_ABORTED` at `origin: caller`,
`retryable: false`, with no reclassification. `expectTypeOf` assertions on the
result envelope, since the type is the contract.

**Slice 6 — the report field.** Round-trip through `persist()`/parse;
`report-lookup` admits the new scalar and rejects a non-scalar in that
position; the envelope projects it and reports `null` when absent. Because
this crosses packages, remember the consumer resolves `dist/` — **rebuild
`m3l-common` before running `m3l-cli` tests**, or the guard reads as hollow.

**Slice 7 — rendering.** `history.test.ts` is only 4,168 b, so it has room:
the new columns render, an entry written before the field existed still
renders (back-compat on the persisted history file), and `--json` carries the
new fields. `check:cli-docs` verifies the page's structure and its **command**
coverage only — the truth is regex-extracted from `main.ts`'s
`STATIC_COMMAND_NAMES` (`bin/check-cli-docs.mjs:19-22`). It does **not** gate
flags or rendered columns, so the `cli.md` edits in this slice and in slice 2
(removing `cli.md:525-528`'s "U10 ships no `--resume`" note) are conscious
obligations with no gate behind them.

## Verification

Per slice, from the worktree root: `pnpm check:host-resources` first (three
Claude sessions have been live throughout this wave), then `pnpm verify`, then
a **backgrounded** `pre-push`. Known traps, all previously paid for in this
repo:

- `pnpm verify` is **not** `pre-push` — `bin/tests` runs only under
  `vitest.bin.config.ts`, so a green `verify` can still fail the push. Never
  `--no-verify`.
- Provenance ordering is load-bearing: **format → stamp → `gen:index`**.
  Prettier at `pre-commit` invalidates a SHA stamped before it, and both gates
  are CI-only. Slices 5 and 7 edit `docs/reference/` pages
  (`core/polling.md`, `cli.md`) and need `/syncing-docs`; slices 1–4 and 6 do
  not, since `check:provenance` scans `docs/reference/` only.
- A no-op `gen:index` is an **alarm**, not a pass — `check:index` diffs two
  sidecar-derived artifacts and goes green when a sidecar entry is missing.
- `ERR_WORKER_OUT_OF_MEMORY` from `pnpm lint` means
  `NODE_OPTIONS=--max-old-space-size=6144`, not a lint failure.
- A `check:review-size` failure naming files the slice never touched means CI
  diffed against the `main` tip rather than the merge-base — rebase, never
  split the PR.
- A `script-aws-provisioning-failure.test.ts` timeout under `pre-push` is
  contention starvation, not flake. Retry; never raise the timeout.
- Run `code-reviewer`, `security-reviewer` and `silent-failure-hunter` over
  each diff **before** pushing: auto-merge closes the review window, so
  anything found afterwards becomes a follow-up PR.

Every PR body says **`Refs #535`** — never `Closes`/`Fixes`/`Resolves`, and no
prose containing a closing verb near the number. GitHub links from the PR
_description_, and a linked close pre-empts `sync:hub` **silently** (it still
prints "in sync"). Assert it before merging:

```bash
gh pr view <n> --json closingIssuesReferences   # must be []
```

The U11 row stays at **To Do** until slice 7, which flips it to Done in the
same PR that ships the rendering — a merged PR cannot close a hub-sync issue
on its own.
