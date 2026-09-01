# Orchestration engine — design plan (2026-09-01)

- **Status:** active
- **Owner:** Enrico Lionello (maintainer)
- **Decisions:** [ADR-0056](../adr/0056-cross-script-orchestration-engine.md)
  (placement, command name, contract surfaces, acceptance flow),
  [ADR-0068](../adr/0068-workbench-sessions.md) (the inter-step reference
  convention this plan consumes), [ADR-0063](../adr/0063-cli-structured-run-results.md)
  (run-report read discipline), [ADR-0046](../adr/0046-codified-procedure-engine.md)
  (the condition evaluator reused for branch predicates),
  [ADR-0035](../adr/0035-failure-reporting-and-diagnostics.md) (exit-code
  registry — **not** amended, see §_Exit codes_).
- **Trackers:** [`IMPLEMENTATION.md`](./IMPLEMENTATION.md) row
  **U10 — orchestration engine + named flow**; GitHub issue #534.
- **Predecessor:** [`2026-08-20-cli-evolution.md`](./2026-08-20-cli-evolution.md)
  §_U10_ — that plan decomposes the U-series; this one carries the U10 detail
  it deferred.

## Why this plan exists

ADR-0056 fixed four things about `m3l flow` — its placement
(`packages/m3l-cli`), its command name, its contract surfaces (exit codes +
`run-report.json`), and its acceptance flow — and deliberately deferred three
to "a dated `docs/plans/` design doc when that phase starts":

> **Definition format, resume semantics, and branching algebra** are
> implementation-phase design (U10), recorded in a dated `docs/plans/` design
> doc when that phase starts — this ADR fixes the placement, the command name,
> the contract surfaces (exit codes + run-report), and the acceptance flow, not
> the file format.

This is that doc. It also records two findings the ADR anticipated but could
not settle in advance: that **no ADR-0035 Update is needed**, and that
consuming ADR-0068's convention requires **promoting it out of the console**
first — which turns U10's recorded "2 PRs" into four.

## Slice sequence

ADR-0072 orders these docs-first, then the seam, then the surface. Each slice
branches fresh from `origin/main` after its predecessor merges, so every PR
diffs cleanly against its base.

| #   | Branch                              | Contents                                                                                                                                                        | Semver                   |
| --- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| 1   | `docs/u10-orchestration-design`     | This document. Docs-only.                                                                                                                                       | none                     |
| 2   | `feat/u10-step-reference-promotion` | Promote the ADR-0068 reference/binding convention into a new `core/orchestration` Core submodule; repoint `m3l-console-server` at it; dated Update on ADR-0068. | **minor** (`m3l-common`) |
| 3   | `feat/u10-flow-engine`              | `packages/m3l-cli/src/flow/` + `m3l flow`; the `flow` reserved name in lockstep.                                                                                | none (CLI-internal)      |
| 4   | `feat/u10-acceptance-flow`          | The named sqs-etl → json-etl → dynamodb-crud → sqs-etl definition, `cli.md`'s `## Flows` section, the work log, the tracker flip, `sync:hub --apply`.           | none                     |

Every PR body says **`Refs #534`**, never `Closes #534`: GitHub closes an issue
the moment a `Closes` PR merges, after which `sync:hub` never recomputes a
closed item and it would sit at `status:todo` forever. Only the slice-4 tracker
flip to `Done` may close it.

## The promotion trigger (why this is four PRs, not two)

ADR-0068 records the convention's type home as console-local, gated:

> **Console-local type home confirmed** — the binding/artifact convention …
> `m3l-common` promotion remains gated on U10 starting.

U10 has started, so the gate opens. It is not optional: `packages/m3l-cli`
depends on `m3l-common` plus the 16 consumer scripts and **cannot** import
`m3l-console-server`, so the engine can only consume the convention after it
moves. ADR-0056 anticipated exactly this shape of event —

> The engine itself is CLI-internal (no `m3l-common` export change); any
> library seam it turns out to need gets its own recorded decision.

— so slice 2 carries a **dated Update on ADR-0068** recording that the type
home moved and why. No new ADR is opened; ADR-0068 owns the convention and is
the right place for the record.

## Slice 2 — the promoted surface

### Submodule home: `core/orchestration` (new, 26th)

Three existing submodules were assessed against the promoted surface and
rejected on evidence:

- **`core/procedure`** — the plan's original guess, but its own
  `types.ts` states as an invariant that _nothing is parsed at run time_: it
  models references as typed value objects (`M3LProcedureReference`,
  `M3LProcedurePath`), never as strings. A string grammar contradicts that.
  The predecessor plan also records the U-series as explicitly non-coupled
  with the codified-procedure wave.
- **`core/json`** — a genuine near-fit (it already owns `parseFieldPath` /
  `navigateFieldPath` / `extractAll`), but its documented scope is
  "dot-notation field-path navigation and JSON/JSONL format detection". The
  `step-<ordinal>.output` prefix is orchestration vocabulary, not JSON
  vocabulary.
- **`core/cli-contract`** — scoped by its own barrel doc to "the typed seam a
  script exports so a host … can invoke it in-process". A reference to a
  _prior step's_ result is host-side sequencing, not that seam.

`core/orchestration` is therefore new. The Core namespace barrel is a flat
`export * from "./<name>/index.js";` list, so the barrel edit is one
alphabetically-placed line — and, per the hard rule, the surface reaches
consumers **through the namespace barrel only, never a new `exports`
subpath**. `check:api` moves only on an `exports`-map subpath change, so it
stays green.

The 26th submodule costs a documented-count ripple: `pnpm gen:counts`
regenerates every `N of NN` site and the implemented-list block, CLAUDE.md's
"25 documented submodules" becomes 26, and the submodule needs a
`docs/reference/core/orchestration.md` page plus its
`orchestration.provenance.json` sidecar. `docs/implementation-status.md` gains
a row, including the per-submodule test count that `check:test-counts`
verifies against a real `vitest list` pass.

### What moves

| From                                                    | Symbols                                                                                                            |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `packages/m3l-console-server/src/sessions/reference.ts` | `M3LStepReference`, `M3LStepReferenceSegment`, `parseStepReference`, `formatStepReference`, `resolveStepReference` |
| `packages/m3l-console-server/src/sessions/binding.ts`   | `M3LBindingExpectedType`, `M3LSessionBinding` → renamed `M3LStepBinding`, `validateBindingValue`                   |

The grammar moves verbatim:
`step-<ordinal>.output(.<ident> | [<index>] | ["<quoted>"])*`, with a 1-based
ordinal, 0-based bracket indices, no leading zeros, a 15-digit run cap, and
`\"`/`\\` the only legal escapes inside a quoted segment. Trailing garbage is
rejected outright — there is no partial parse.

`M3LSessionBinding` is renamed to `M3LStepBinding` on the way in: "session" is
a console concept with no meaning in a library that also serves flows. The
console keeps its old name as a local type alias, so its API is unchanged.

### The one place this is not a pure move

`parseStepReference` and `resolveStepReference` currently throw
`M3LConsoleError` with code `ERR_CONSOLE_SESSION_REFERENCE_INVALID`. A
console-specific error class cannot move into `m3l-common`. Resolution:

1. The promoted functions throw a library-owned `M3LError` subclass with a
   library-owned code. That code is registered in `core/errors`' code tuple
   **and** its classification catalog — the catalog is typed
   `Record<M3LErrorCode, …>`, so omitting the entry is a compile error, not a
   silent gap.
2. `m3l-console-server` keeps `sessions/reference.ts` and
   `sessions/binding.ts` as thin adapters that re-export the promoted types
   and catch-and-rewrap the promoted errors as `M3LConsoleError` with the
   **existing** code.

Adapters rather than deletion, because the console's HTTP envelope classifies
`ERR_CONSOLE_SESSION_REFERENCE_INVALID` as a 400/caller/non-retryable fault.
Letting a raw library error escape would silently reclassify those responses
to 500. The adapters preserve that mapping, keep `sessions/launch-parameters.ts`
byte-unchanged, and leave both console test files untouched — which also means
those tests keep covering the adapters' own throw paths, satisfying the
per-file coverage gate.

### The prototype-pollution guard

`reference.ts` screens every property segment against `Core.isDangerousKey`
(`__proto__`, `constructor`, `prototype`) at **two** levels — once at parse
time, once again at walk time before any property access. That guard is
already library code (`core/security`), so promotion does not invent a new
security primitive; but it does move the _fail-closed screening_ into the
library's public surface, so slice 2 dispatches `security-reviewer` and
**mutation-tests the guard**: delete a forbidden name from the check and
confirm a test goes red. A guard no test can kill is not a guard.

## Slice 3 — the flow engine

### Definition format

YAML at `data/config/flows/<name>.yaml`, matching the tracked-YAML precedent
already set by `data/config/presets/*.yaml`.

```yaml
# The ordered steps of a named flow. Keys mirror each script's declared
# config parameters; an unknown key is rejected at load time.
name: dlq-reconcile
description: Drain a DLQ, reshape the payloads, land them, republish.
maxStepExecutions: 12
steps:
  - id: dump
    script: sqs-etl
    parameters:
      command: dump
      queueUrl: https://sqs.eu-west-1.amazonaws.com/000000000000/example-dlq
      output: data/output/u10-dump.jsonl
    execution: auto
    onSuccess: continue
    onFailure: stop
```

Rules the loader enforces at the boundary, narrowing from `unknown` with
explicit guards (no `any` anywhere on the path):

- `name` is required, matches `/^[a-z0-9-]+$/`, and **must equal the filename
  stem** — otherwise a renamed file silently shadows another flow.
- `steps` is required and non-empty; every `id` is unique and matches
  `/^[a-z0-9-]+$/`; every `goto` target resolves to a declared `id`.
- `script` must resolve through the CLI's existing script discovery.
- `parameters` keys must be parameters the target script actually declares.
  Operations are ordinary declared parameters under ADR-0055 — `sqs-etl`
  selects with `command`, `dynamodb-crud` with `operation`, and `json-etl`
  has no selector at all — so there is no separate `operation:` key.
- `execution` is `auto` (default) | `in-process` | `spawn`.
- **Unknown keys are rejected** at both flow and step level, following the
  preset loader's precedent. This is what makes every later addition to the
  format forward-safe.
- Nested keys are screened with `isDangerousKey`: the YAML config provider
  screens only _top-level_ keys for prototype pollution, so step-level keys
  are the validator's own responsibility.

**YAML is read through `Core.M3LYAMLConfigProvider`, not the `yaml` package
directly.** `packages/m3l-cli` declares no `yaml` dependency and ESLint bans
every non-`node:`, non-`m3l-common` import from `packages/m3l-cli/src/**`. One
caveat to code around: that provider treats a missing file as an empty map, so
the loader must check existence first and raise a proper unknown-flow error
with name suggestions rather than reporting an empty flow.

### Branching algebra

Ordered steps. Each step declares `onSuccess`, `onFailure`, and optionally
`onPartial`; each is `continue` | `stop` | `{ goto: <stepId> }`.

Classification is a single exported pure function over the step's observed
result, so it is directly unit-testable:

| Observed                                                             | Branch                   |
| -------------------------------------------------------------------- | ------------------------ |
| `exitCode === 0` (outcome `success`, `dry-run`, or unavailable)      | `onSuccess`              |
| `exitCode === M3L_EXIT_CODES.PARTIAL` (6) or `outcome === "partial"` | `onPartial ?? onFailure` |
| anything else — 1–5, or `128 + signal` from the spawn path           | `onFailure`              |

`onPartial` exists because the exit-code registry carries `PARTIAL = 6` as a
distinct code and ADR-0056's drivers name "partial failures → operator
decision". It is optional and defaults to `onFailure`, so a flow that omits it
behaves exactly as the two-arm algebra.

**Branch predicates reuse `Core.evaluateProcedureCondition`** (ADR-0046)
rather than growing a second condition evaluator. Note the scope is
structurally fixed — `{ results, values, parameters }`, generic only in its
shape parameter — so the engine supplies `{ exitCode, outcome }` as the
scope's `values` map and leaves `results` and `parameters` empty. A `null`
`outcome` is legal there because `M3LProcedureScalar` admits `null`.

Reusing the _evaluator_ does not couple the U-series to the
codified-procedure wave: it is a generic typed tree evaluator over a
caller-supplied scope, and the flow engine still sequences whole scripts over
the exit-code + run-report contract, exactly as the predecessor plan
requires.

**Loop guard.** `goto` is required — the acceptance flow revisits `sqs-etl` —
so the engine counts total step executions and halts at `maxStepExecutions`
(default 50). A tripped guard is a definition-authoring fault and exits with
`CONFIG_USAGE` (2).

### Reading a step's outcome

- **Spawn steps** — `locateRunReport` with the step's own observed
  `startedAt`/`finishedAt` window. Per ADR-0063 that read is tolerant,
  allowlist-summarized, and never re-emitted: `outcome` may legitimately be
  `null` and the engine must not crash on it. **The engine never writes or
  rewrites a script's run-report.**
- **In-process steps** — `outcome` comes straight off the returned
  `M3LCommandOutcome`, which is authoritative; the report lookup still runs,
  but only to recover `reportPath`.

The flow invokes `sqs-etl` twice, so two steps share a `scriptName`.
`locateRunReport` disambiguates them correctly because each step passes its
own observed time window — **no per-step correlation id is needed.**

### Inter-step data — consuming, not re-designing, ADR-0068

`step-<N>.output` resolves against **that step's `M3LCliRunEnvelope`** — the
V2 structured result the CLI already builds per run. So
`step-1.output.exitCode`, `step-1.output.outcome`, `step-1.output.reportPath`
and `step-1.output.recoveryTotal` are addressable, using the promoted grammar
unchanged and the promoted resolver unchanged.

This deliberately reuses an existing, already-allowlisted shape rather than
opening a second serialization surface. Walking the raw `run-report.json`
would be richer — it is what would make ADR-0056's named "empty dump → stop"
condition directly expressible — but ADR-0063 closed that surface on purpose,
and `locateRunReport` returns a four-scalar summary rather than the parsed
document. Re-opening it is a decision for a future slice with its own
ADR-0063 Update, not something U10 does by implication.

**Artifact paths stay literal.** Each step declares its own `output` path and
the next step declares the same path as its `input`; the chaining is a
convention the definition makes visible, not a computed reference. This is the
honest reading of ADR-0056's carried-forward trade-off: a process-driving
orchestrator cannot see inside a spawned script, and rich inter-step data
needs an on-disk artifact convention. The file paths _are_ that convention.

### Resume semantics — designed here, shipped by U11

U10 persists a per-run record; it ships **no `--resume` flag**. U11 owns that
surface.

The record captures, per run: a run id, the flow name, a canonical hash of the
definition, start/finish timestamps, a status
(`completed` | `stopped` | `failed` | `loop-guard-exceeded`), the flow exit
code, the **cumulative step-execution count**, the halting step id, the step
id a resume would start at, and one record per step execution
(`stepId`, `script`, attempt, `exitCode`, `outcome`, `reportPath`, branch
taken).

The designed semantics U11 will implement: load the record, recompute the
definition hash, **refuse on mismatch** — the ADR-0045 fingerprint-aware
discipline U11's tracker row already names — then re-enter the engine at the
recorded resume step with the step-execution count seeded from the record, so
the loop guard is not silently reset by resuming. To make that a flag and a
lookup rather than an engine rewrite, the engine's entry point takes an
optional resume-from argument **now**, in slice 3.

### Module layout

`packages/m3l-cli/src/flow/` is split to stay inside the 25 KB per-src-file
budget and under `check:dup`'s 4% threshold: types/constants, boundary
validation (pure, no I/O), loading (I/O only), single-step execution, the step
loop, the run record, the `--json` envelope, and human rendering — plus
`packages/m3l-cli/src/commands/flow.ts` as the thin command handler.

Two anti-duplication rules, because both are live risks against existing code:

- The flow envelope **composes** the existing per-run envelope builder for
  each step's nested result and copies the deciding step's exit-code name. It
  never re-derives a reverse exit-code map or re-implements the JSON read
  guards.
- The flow run record and the existing history store are near-identical
  read-validate-write shapes. Either extract a shared JSON-array store helper
  and refactor history onto it in the same PR, or give the record a genuinely
  different shape — decided by measuring with `check:dup` early, not late.

**`flow` is a new top-level `src/` layer, which is a gated topology
decision.** `check:cli-scaffold` holds a closed allowlist of sanctioned
layers, and its failure message requires the new layer to be recorded in
`docs/contributing/cli-structure.md` in the same change. Both edits land in
slice 3.

### The reserved name, in lockstep

ADR-0056 grows the reserved static-command set from nine to eleven — `flow`
here, `completion` at U12, each "in the same change that ships each command".
So U10 adds `flow` and **not** `completion`.

Five code sites and two tests move together or the build breaks:

- the scaffold manifest's `RESERVED_CLI_NAMES` (9 → 10), plus the prose in the
  same file that counts "the same 9 names";
- `commands/doctor.ts`'s `RESERVED_COMMAND_NAMES` mirror;
- `main.ts`'s `STATIC_COMMAND_NAMES` and its lazy handler table;
- **`commands/dynamic.ts`'s own `STATIC_COMMAND_NAMES`** — a fourth,
  independently-declared copy feeding the unknown-script suggestion pool. Its
  own TSDoc requires it to stay set-equal to the other two;
- the scaffold-manifest test's exact-array assertion (position matters — the
  set is insertion-ordered), and doctor's set-equality drift guard, which
  regex-parses the manifest's source text and passes automatically once both
  literals agree.

**`bin/` needs no change.** `bin/lib/script-scaffold.mjs` deliberately does
_not_ re-export `RESERVED_CLI_NAMES` — its comment records that knip would
correctly flag it as unused, because `check:script-scaffold` reaches the
reserved set indirectly through the manifest's own validator. The predecessor
plan's "must land in `bin/lib/script-scaffold.mjs`'s reserved-name list" is
stale prose describing a pre-U9 layout.

The mutation test for this work: `m3l new flow` must be **rejected** as a
reserved name, and `m3l doctor` must list `flow` in its collision audit.
Deleting the entry must turn a test red.

### Exit codes — no ADR-0035 Update

Recorded finding: **the registry is sufficient unchanged.** A flow exits with
the failing step's own exit code; a tripped loop guard is a definition fault
and reuses `CONFIG_USAGE` (2). No flow-level outcome was found that the
existing seven codes cannot express.

`docs/reference/cli.md`'s `## Exit codes` registry gains the flow mapping in
slice 4, but no ADR is amended. If implementation proves this wrong — most
plausibly if the loop guard turns out to need a distinct code — that becomes a
dated ADR-0035 Update inside slice 3, exactly as ADR-0056 anticipates.

## Slice 4 — the acceptance flow

ADR-0056 names it: **sqs-etl → json-etl → dynamodb-crud → sqs-etl**. The
return to `sqs-etl` is why `goto` is in the algebra.

All four steps chain through real on-disk artifacts, which is what makes the
flow an acceptance test rather than a demo. The formats were verified against
each script's contract:

| #   | Script          | Operation                   | Reads                                   | Writes                                                                                |
| --- | --------------- | --------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------- |
| 1   | `sqs-etl`       | `dump` (`command`)          | the queue                               | JSONL, one `M3LSQSReceivedMessage` per line (`messageId`, `receiptHandle`, `body`, …) |
| 2   | `json-etl`      | — (no selector)             | that JSONL, format auto-detected        | JSONL, with `format: jsonl` set explicitly                                            |
| 3   | `dynamodb-crud` | `batch-write` (`operation`) | that JSONL via the shared list importer | the table                                                                             |
| 4   | `sqs-etl`       | `send` (`command`)          | that same JSONL                         | the queue                                                                             |

**The one real format constraint**, verified rather than assumed: step 4's
`send` does _not_ use the shared JSON list importer — it uses its own line
reader that expects each record to carry a `body` key. So step 2's `fields`
must project a `body` column. That is a one-line `fields` entry
(`body=body`), and it is the reason step 4 consumes step 2's output rather
than step 3's: `dynamodb-crud`'s writing operations produce no file, and its
`scan`/`export` output is DynamoDB items with no `body` key.

**Dry-run in CI, no live AWS.** All three scripts are ADR-0054 pilots and all
three accept `--dry-run`, which validates environment, configuration and AWS
credential resolution and then stops before execution. `m3l flow run <name>
--dry-run` sets every step's dry-run; a step's own `dryRun: true` in the
definition is a floor and is never overridden downward.

### Close-out, in this same PR

- `docs/reference/cli.md`: the `## Flows` section — reserved as
  optional-until-U10 by `check:cli-docs`, and once present it must carry at
  least one `###` subsection, which the named flow supplies. Plus the `flow`
  command's own `## Commands` entries (the gate regex-extracts
  `STATIC_COMMAND_NAMES` from `main.ts` and cross-checks), and the
  `## Exit codes` mapping.
- `docs/logs/2026-09-01-u10-orchestration-engine.md` — X4 and X6 both shipped
  work logs; U10 follows.
- **The tracker flip**, in this PR and not a follow-up: `Status` `To Do` →
  `Done`, `Type` `—` → `CLI capability` (matching U7), and the `Change` cell
  rewritten to past tense naming the four shipped PRs — including that the
  row's recorded "2 PRs" became four once the promotion trigger fired.
- Then `pnpm sync:hub` (dry-run, inspect the plan) and `pnpm sync:hub --apply`,
  which closes #534 as **completed**.

> **Do not touch the U10 `Item` cell.** Hub-sync keys are derived as
> `impl:<namespace>:${slug(itemCell)}`, so
> `**U10 — orchestration engine + named flow**` must stay byte-identical or
> the key stops matching `impl:cli-evolution:u10-orchestration-engine-named-flow`
> and `sync:hub` files a _new_ issue instead of closing #534. Priority, Status,
> Type, Change and Source are all safe to rewrite.

`sync:hub` closes an issue only when the tracker Status reads `Done`; for any
other value it reopens and re-labels an issue something else closed. That is
why the flip cannot be deferred to a follow-up PR.

## Verification

Per slice, before opening the PR: `pnpm verify` (reproduces every CI check)
and `pnpm check:review-size` (ADR-0072).

Slice 2 additionally needs `pnpm gen:index` and `pnpm gen:counts` — new
exported symbols move `docs/reference/symbol-map.json` and `catalog.json`, and
the 26th submodule moves every count site. Two gates are **invisible to
`pre-push` and CI-only** — `check:provenance` and `check:index` — so both run
explicitly after any doc or symbol move. A rebase can silently drop generated
index entries while `build`, `tsc` and the tests all still pass, so
`check:index` re-runs after every rebase, not just after every edit.

`pnpm test` skips the per-file coverage thresholds; the gate is
`test:coverage`. `pre-push` takes minutes — background it, and never
`--no-verify`.

End-to-end proof of the feature itself, after slice 3:

```bash
pnpm build
node packages/m3l-cli/dist/main.js flow --help
node packages/m3l-cli/dist/main.js flow run <acceptance-flow> --dry-run
node packages/m3l-cli/dist/main.js doctor   # `flow` appears in the collision audit
node packages/m3l-cli/dist/main.js new flow # must be REJECTED as reserved
```

## Definition of done

`pnpm verify` passes on every slice; the promotion carries a minor-semver
Conventional Commit and a dated ADR-0068 Update; every new export has TSDoc
and tests; the prototype-pollution guard is mutation-tested; `flow` is
reserved in all five sites with both drift tests green; the acceptance flow
runs dry-run without live AWS; #534 closes as **completed** carrying
`status:done`.
